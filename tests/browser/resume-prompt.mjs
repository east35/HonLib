// When another device has read further, the reader asks — no page turn needed.
//
// The case this guards: read on the e-reader in the morning, carry on on the
// phone in the afternoon, then pick the e-reader up again. It wakes before its
// connection does, so it is still on the morning's place and anything read
// there is queued by the shell. When the connection comes back the reader
// should say "Latest progress <where> at <when>" and offer to go there or
// stay — and until it is told, neither place may overwrite the other.
//
// The e-reader runs behind a stand-in for the Android shell as released, at
// the network layer: progress writes are forwarded when online and queued when
// not, the answer never carries the server's entry, a refused write is
// reported as queued, a progress read puts a queued write in front of the
// server's place, and any other path goes straight through. The phone is a
// plain browser on the real server.
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

async function resetProgress(id) {
  await fetch(`${baseURL}/api/progress/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_id: id }),
  });
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

// Arriving can take a moment: a jump asked for during a page turn waits for
// the turn to finish.
function arriveAt(page, cfi) {
  return page.waitForFunction(
    (target) => document.querySelector("foliate-view")?.lastLocation?.cfi === target,
    cfi,
  );
}

async function promptText(page) {
  await page.locator("#resume-bar").waitFor({ state: "visible", timeout: 5000 });
  return (await page.locator("#resume-label").textContent()).trim();
}

// EbookRouter and MainActivity as released, for one book.
async function installShell(context, id) {
  const shell = { online: true, row: null, cache: { books: {}, bookmarks: {} }, posts: [] };
  await context.route(
    (url) => url.pathname === "/api/progress" || url.pathname === `/api/progress/${id}`,
    async (route) => {
      const request = route.request();
      if (new URL(request.url()).pathname !== "/api/progress") {
        return shell.online ? route.continue() : route.abort("internetdisconnected");
      }
      if (request.method() === "GET") {
        if (shell.online) shell.cache = await (await route.fetch()).json();
        const data = structuredClone(shell.cache);
        if (shell.row) data.books[id] = shell.row.payload;
        return route.fulfill({ json: data });
      }
      const payload = { ...JSON.parse(request.postData() || "{}"), last_opened: new Date().toISOString() };
      shell.posts.push(payload);
      let clean = false;
      if (shell.online) clean = (await route.fetch()).ok();
      shell.row = { payload, dirty: !clean };
      return route.fulfill({ json: { ok: true, queued: true, synced: clean } });
    },
  );
  // Installed once the page has loaded, as the shell does.
  shell.attach = (page) => page.evaluate(() => {
    if (window.__readerShellSetOffline) return;
    window.__readerShellOffline = false;
    window.__readerShellSetOffline = (off) => { window.__readerShellOffline = !!off; };
  });
  shell.disconnect = async (page) => {
    shell.online = false;
    await page.evaluate(() => window.__readerShellSetOffline(true));
  };
  // Back online the sync worker pushes what is queued, then the Activity
  // reports the connection.
  shell.reconnect = async (page) => {
    shell.online = true;
    if (shell.row?.dirty) {
      const res = await fetch(`${baseURL}/api/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(shell.row.payload),
      });
      if (res.ok) shell.row.dirty = false;
    }
    await page.evaluate(() => window.__readerShellSetOffline(false));
  };
  return shell;
}

// The server takes a forwarded write a moment before the shell hears back.
async function waitForShellClean(shell, what) {
  for (let i = 0; i < 50 && shell.row?.dirty; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(shell.row?.dirty, false, what);
}

async function phoneReadsAhead(browser, id, turns) {
  const phone = await browser.newContext({ serviceWorkers: "block" });
  const page = await phone.newPage();
  await openBook(page, BOOK);
  for (let i = 0; i < turns; i++) await turnPage(page);
  const state = await readState(page);
  const cfi = await shownCfi(page);
  const entry = await waitForServer(id, (e) => e.cfi === cfi, "saved the phone's place");
  await phone.close();
  return { state, cfi, entry };
}

// Morning on the e-reader, then it loses its connection and is read a little
// more; afternoon on the phone; then the e-reader's connection comes back.
async function wakeAfterThePhone(browser, id, name) {
  await resetProgress(id);
  const ereader = await browser.newContext({ serviceWorkers: "block" });
  const shell = await installShell(ereader, id);
  const page = await ereader.newPage();
  await openBook(page, BOOK);
  await shell.attach(page);
  await turnPage(page);
  const morning = await waitForServer(id, (e) => !!e.cfi, "saved the morning's place");

  await shell.disconnect(page);
  const before = shell.posts.length;
  await turnPage(page);
  await turnPage(page);
  for (let i = 0; i < 50 && shell.posts.length < before + 2; i++) await page.waitForTimeout(100);
  const queued = shell.posts.slice(before);
  assert.ok(queued.length >= 2, `${name}: the e-reader queued ${queued.length} write(s), expected 2`);
  for (const body of queued) {
    assert.equal(body.base, morning.last_opened, `${name}: a queued write lost the baseline it was read from`);
  }

  const phone = await phoneReadsAhead(browser, id, 5);
  await shell.reconnect(page);
  assert.equal((await serverEntry(id)).cfi, phone.cfi, `${name}: the queued morning place overwrote the phone's`);
  return { ereader, page, shell, phone };
}

// Back online, it asks without being touched, and "Go to latest" goes there.
async function shellWakeGoToLatest(browser, id, name) {
  const { ereader, page, shell, phone } = await wakeAfterThePhone(browser, id, name);
  const turnsBefore = shell.posts.length;
  assert.match(await promptText(page), TIME, `${name}: reconnecting didn't ask, or doesn't say where and when`);

  await page.getByRole("button", { name: "Go to latest" }).click();
  await page.locator("#resume-bar").waitFor({ state: "hidden" });
  await arriveAt(page, phone.cfi);
  const there = await settled(page);
  assert.equal(there.section, phone.state.section, `${name}: went to section ${there.section}, not the phone's`);
  assert.equal(there.page, phone.state.page, `${name}: went to page ${there.page}, not the phone's`);
  const kept = await waitForServer(id, (e) => e.last_opened !== phone.entry.last_opened, "heard the choice");
  assert.equal(kept.cfi, phone.cfi, `${name}: choosing the phone's place didn't keep it`);
  await waitForShellClean(shell, `${name}: the shell is still holding the morning's place`);
  assert.ok(shell.posts.length > turnsBefore, `${name}: the choice never reached the shell`);

  // Settled: reading on goes through without asking again.
  await turnPage(page);
  const next = await shownCfi(page);
  await waitForServer(id, (e) => e.cfi === next, "took the next page turn");
  assert.equal(await page.locator("#resume-bar").isVisible(), false, `${name}: asked again after choosing`);
  await ereader.close();
  console.log(`${name}: reconnecting asked, went to the phone's place`);
}

// "Stay here" keeps the e-reader's place and makes it the latest.
async function shellWakeStayHere(browser, id, name) {
  const { ereader, page, shell, phone } = await wakeAfterThePhone(browser, id, name);
  await promptText(page);
  const before = await settled(page);
  const here = await shownCfi(page);

  await page.getByRole("button", { name: "Stay here" }).click();
  await page.locator("#resume-bar").waitFor({ state: "hidden" });
  const kept = await waitForServer(id, (e) => e.last_opened !== phone.entry.last_opened, "heard the choice");
  assert.equal(kept.cfi, here, `${name}: staying didn't save the e-reader's place`);
  await waitForShellClean(shell, `${name}: the shell is still holding a refused write`);
  const after = await readState(page);
  assert.deepEqual([after.section, after.page], [before.section, before.page], `${name}: staying moved the reader`);
  await ereader.close();
  console.log(`${name}: stayed on the e-reader's place`);
}

// Nothing read on the e-reader since it synced; it just comes back to the
// front after the phone read on. It still asks rather than moving by itself.
async function idleWakeAsks(browser, id, name) {
  await resetProgress(id);
  const ereader = await browser.newContext({ serviceWorkers: "block" });
  const page = await ereader.newPage();
  await openBook(page, BOOK);
  await turnPage(page);
  const here = await shownCfi(page);
  await waitForServer(id, (e) => e.cfi === here, "saved the e-reader's place");

  const phone = await phoneReadsAhead(browser, id, 3);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.match(await promptText(page), TIME, `${name}: coming back didn't ask`);
  assert.equal(await shownCfi(page), here, `${name}: moved before being asked`);

  await page.getByRole("button", { name: "Go to latest" }).click();
  await arriveAt(page, phone.cfi);
  await settled(page);
  await ereader.close();
  console.log(`${name}: an idle reader asked before moving`);
}

// Against the server alone, a page turn the server refuses asks too.
async function refusedPageTurnAsks(browser, id, name) {
  await resetProgress(id);
  const ereader = await browser.newContext({ serviceWorkers: "block" });
  const page = await ereader.newPage();
  await openBook(page, BOOK);
  await turnPage(page);
  const first = await shownCfi(page);
  await waitForServer(id, (e) => e.cfi === first, "saved the e-reader's place");

  const phone = await phoneReadsAhead(browser, id, 4);
  await page.evaluate(() => window.ebookTurnPage("next"));
  assert.match(await promptText(page), TIME, `${name}: a refused page turn didn't ask`);
  assert.equal((await serverEntry(id)).cfi, phone.cfi, `${name}: the e-reader overwrote the phone's place`);

  await page.getByRole("button", { name: "Stay here" }).click();
  const here = await shownCfi(page);
  const kept = await waitForServer(id, (e) => e.last_opened !== phone.entry.last_opened, "heard the choice");
  assert.equal(kept.cfi, here, `${name}: staying didn't save the e-reader's place`);
  await ereader.close();
  console.log(`${name}: a refused page turn asked`);
}

const id = await bookId();
for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  const browser = await engine.launch({ headless: true });
  try {
    await shellWakeGoToLatest(browser, id, name);
    await shellWakeStayHere(browser, id, name);
    await idleWakeAsks(browser, id, name);
    await refusedPageTurnAsks(browser, id, name);
  } finally {
    await browser.close();
  }
}
