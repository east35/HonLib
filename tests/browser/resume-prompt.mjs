// Reading on two devices must never quietly lose either place.
//
// The case this guards: read on the e-reader in the morning, carry on on the
// phone in the afternoon, then pick the e-reader up again. It wakes before its
// connection does, so it opens at the morning's place and its first page turns
// are queued by the shell rather than sent. When the queue reaches the server
// it used to carry no baseline, so the morning's place overwrote the phone's.
//
// Now a queued write keeps its baseline, the server rejects it as stale, and
// the reader asks: "Latest progress <where> at <when>", go there or stay.
//
// Each device is its own browser context against the real server. The shell's
// offline queue is stood in for at the network layer, in the shape EbookRouter
// answers with: {ok, queued, synced: false} and no entry.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { baseURL, engines, openBook, readState, settled, turnPage } from "./reader-harness.mjs";

const BOOK = "HonLib Split Chapter Test";
const TIME = /^Latest progress .+ at \d{1,2}:\d{2}\s(AM|PM)$/;

async function bookId() {
  const library = await fetch(`${baseURL}/api/library`).then((r) => r.json());
  const book = library.books.find((b) => b.title === BOOK);
  if (!book) throw new Error(`fixture "${BOOK}" not in the library`);
  return book.id;
}

async function serverEntry(id) {
  const data = await fetch(`${baseURL}/api/progress`).then((r) => r.json());
  return data.books[id] || null;
}

async function waitForServer(id, check, what) {
  for (let i = 0; i < 100; i++) {
    const entry = await serverEntry(id);
    if (entry && check(entry)) return entry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server never ${what}`);
}

// The place the reader is showing, as it would save it.
function shownCfi(page) {
  return page.evaluate(() => document.querySelector("foliate-view")?.lastLocation?.cfi || null);
}

// Go offline the way the shell does: every write is accepted into a queue.
async function goOffline(context) {
  const queued = [];
  await context.route(
    (url) => url.pathname === "/api/progress",
    (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.continue();
      queued.push(JSON.parse(request.postData() || "{}"));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, queued: true, synced: false }),
      });
    },
  );
  return queued;
}

// Morning on the e-reader, afternoon on the phone, then the e-reader wakes up
// offline and reads a little at the morning's place.
async function morningThenAfternoon(browser, id) {
  await fetch(`${baseURL}/api/progress/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_id: id }),
  });

  const ereader = await browser.newContext({ serviceWorkers: "block" });
  const ereaderPage = await ereader.newPage();
  await openBook(ereaderPage, BOOK);
  await turnPage(ereaderPage);
  const morning = await waitForServer(id, (e) => !!e.cfi, "saved the morning's place");

  const phone = await browser.newContext({ serviceWorkers: "block" });
  const phonePage = await phone.newPage();
  await openBook(phonePage, BOOK);
  for (let i = 0; i < 5; i++) await turnPage(phonePage);
  const phoneState = await readState(phonePage);
  const phoneCfi = await shownCfi(phonePage);
  const afternoon = await waitForServer(id, (e) => e.cfi === phoneCfi, "saved the phone's place");
  await phone.close();

  const queued = await goOffline(ereader);
  await turnPage(ereaderPage);
  await turnPage(ereaderPage);
  for (let i = 0; i < 50 && queued.length < 2; i++) await ereaderPage.waitForTimeout(100);
  assert.ok(queued.length >= 2, `the e-reader queued ${queued.length} write(s), expected 2`);
  for (const body of queued) {
    assert.equal(body.base, morning.last_opened, "a queued write lost the baseline it was read from");
  }
  return { ereader, ereaderPage, queued, phoneState, phoneCfi, afternoon };
}

// Arriving can take a moment: a jump asked for during a page turn waits for
// the turn to finish.
function arriveAt(page, cfi) {
  return page.waitForFunction(
    (target) => document.querySelector("foliate-view")?.lastLocation?.cfi === target,
    cfi,
  );
}

async function promptText(page) {
  const bar = page.locator("#resume-bar");
  await bar.waitFor({ state: "visible", timeout: 5000 });
  return (await page.locator("#resume-label").textContent()).trim();
}

// Back online, the next page turn reaches the server, which refuses it. The
// reader asks, and "Go to latest" takes it to the phone's place.
async function goToLatest(browser, id, name) {
  const { ereader, ereaderPage, phoneState, phoneCfi, afternoon } = await morningThenAfternoon(browser, id);
  await ereader.unrouteAll();
  await ereaderPage.evaluate(() => window.ebookTurnPage("next"));

  assert.match(await promptText(ereaderPage), TIME, `${name}: prompt doesn't say where and when`);
  assert.equal((await serverEntry(id)).cfi, phoneCfi, `${name}: the e-reader overwrote the phone's place`);

  await ereaderPage.getByRole("button", { name: "Go to latest" }).click();
  await ereaderPage.locator("#resume-bar").waitFor({ state: "hidden" });
  await arriveAt(ereaderPage, phoneCfi);
  const there = await settled(ereaderPage);
  assert.equal(there.section, phoneState.section, `${name}: went to section ${there.section}, not the phone's`);
  assert.equal(there.page, phoneState.page, `${name}: went to page ${there.page}, not the phone's`);
  const settledEntry = await waitForServer(id, (e) => e.last_opened !== afternoon.last_opened, "heard the choice");
  assert.equal(settledEntry.cfi, phoneCfi, `${name}: choosing the phone's place didn't keep it`);

  // The conflict is settled: reading on goes through without asking again.
  await turnPage(ereaderPage);
  const nextCfi = await shownCfi(ereaderPage);
  await waitForServer(id, (e) => e.cfi === nextCfi, "took the next page turn");
  assert.equal(await ereaderPage.locator("#resume-bar").isVisible(), false, `${name}: asked again after choosing`);
  await ereader.close();
  console.log(`${name}: queued morning place caught, went to the phone's place`);
}

// "Stay here" keeps the e-reader's place and makes it the latest.
async function stayHere(browser, id, name) {
  const { ereader, ereaderPage, afternoon } = await morningThenAfternoon(browser, id);
  await ereader.unrouteAll();
  await ereaderPage.evaluate(() => window.ebookTurnPage("next"));
  await promptText(ereaderPage);
  const before = await settled(ereaderPage);
  const here = await shownCfi(ereaderPage);

  await ereaderPage.getByRole("button", { name: "Stay here" }).click();
  await ereaderPage.locator("#resume-bar").waitFor({ state: "hidden" });
  const entry = await waitForServer(id, (e) => e.last_opened !== afternoon.last_opened, "heard the choice");
  assert.equal(entry.cfi, here, `${name}: staying didn't save the e-reader's place`);
  const after = await readState(ereaderPage);
  assert.equal(after.section, before.section, `${name}: staying moved the reader`);
  assert.equal(after.page, before.page, `${name}: staying moved the reader`);
  await ereader.close();
  console.log(`${name}: stayed on the e-reader's place`);
}

// The shell reconnects before any page turn and reports both places itself, as
// `conflicts` on its progress read. The `online` it fires is enough to ask.
async function shellReportsConflict(browser, id, name) {
  const { ereader, ereaderPage, queued, phoneCfi } = await morningThenAfternoon(browser, id);
  const local = queued[queued.length - 1];
  await ereader.unrouteAll();
  await ereader.route(
    (url) => url.pathname === "/api/progress",
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      const remote = data.books[id];
      // What EbookRouter serves: the queued write stays the book's place, and
      // the server's newer one comes alongside it.
      data.books[id] = { ...local, last_opened: new Date().toISOString() };
      data.conflicts = { [id]: { local: data.books[id], remote } };
      return route.fulfill({ response, json: data });
    },
  );
  await ereaderPage.evaluate(() => window.dispatchEvent(new Event("online")));
  assert.match(await promptText(ereaderPage), TIME, `${name}: the shell's conflict wasn't offered`);
  await ereader.unrouteAll();

  await ereaderPage.getByRole("button", { name: "Go to latest" }).click();
  await ereaderPage.locator("#resume-bar").waitFor({ state: "hidden" });
  await arriveAt(ereaderPage, phoneCfi);
  await settled(ereaderPage);
  assert.equal((await serverEntry(id)).cfi, phoneCfi, `${name}: the phone's place didn't survive the choice`);
  await ereader.close();
  console.log(`${name}: offered the conflict the shell reported`);
}

// Nothing read here since the last sync: there is nothing to lose, so catching
// up to the phone is silent, as before.
async function idleCatchUp(browser, id, name) {
  await fetch(`${baseURL}/api/progress/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_id: id }),
  });
  const ereader = await browser.newContext({ serviceWorkers: "block" });
  const ereaderPage = await ereader.newPage();
  await openBook(ereaderPage, BOOK);
  await turnPage(ereaderPage);
  await waitForServer(id, (e) => !!e.cfi, "saved the e-reader's place");

  const phone = await browser.newContext({ serviceWorkers: "block" });
  const phonePage = await phone.newPage();
  await openBook(phonePage, BOOK);
  for (let i = 0; i < 3; i++) await turnPage(phonePage);
  const phoneState = await readState(phonePage);
  const phoneCfi = await shownCfi(phonePage);
  await waitForServer(id, (e) => e.cfi === phoneCfi, "saved the phone's place");
  await phone.close();

  await ereaderPage.evaluate(() => window.dispatchEvent(new Event("focus")));
  await arriveAt(ereaderPage, phoneCfi);
  const there = await settled(ereaderPage);
  assert.equal(there.section, phoneState.section, `${name}: idle catch-up landed in the wrong section`);
  assert.equal(await ereaderPage.locator("#resume-bar").isVisible(), false, `${name}: asked when nothing was read here`);
  await ereader.close();
  console.log(`${name}: idle reader caught up without asking`);
}

const id = await bookId();
for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  const browser = await engine.launch({ headless: true });
  try {
    await goToLatest(browser, id, name);
    await stayHere(browser, id, name);
    await shellReportsConflict(browser, id, name);
    await idleCatchUp(browser, id, name);
  } finally {
    await browser.close();
  }
}
