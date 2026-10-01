// Moving between a journal and its books without losing your place.
//
// Journal to book is a visit: the book opens at the passage and nothing about
// it is saved, so the reader's position and finished status are untouched.
// Book to journal is the reader's Passages tab, or "View in journal" on a mark,
// which opens the journal over the page; from either, a passage from another
// book opens as a visit, and backing out returns to the page that was open.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import { baseURL, engines, openBook, settled, turnPage } from "./reader-harness.mjs";
import { BOOKS, hideChrome, libraryBook, putDoc, tapText, wipeJournals } from "./journal-harness.mjs";

async function progressOf(book) {
  const data = await fetch(`${baseURL}/api/progress`).then((r) => r.json());
  return data.books[book.id] || null;
}
async function setProgress(book, cfi, percent) {
  await fetch(`${baseURL}/api/progress/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book_id: book.id }) });
  if (cfi) await fetch(`${baseURL}/api/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book_id: book.id, cfi, percent }) });
}
function seedPassage(journal, book, text, cfi, percent, extra = {}) {
  const now = new Date().toISOString();
  return putDoc("passages", {
    v: 1, id: randomUUID(), created: now, updated: now, device: "seed", deleted: false,
    text, context: { before: "", after: "" }, note: "", tags: [], style: { highlight: "yellow", underline: null }, journals: [journal.id],
    source: { book_key: book.key, book_id: book.id, title: book.title, author: book.author, series: book.series || "", series_index: null, chapter: "", cfi, percent },
    ...extra,
  });
}
// Section and the text at the top of the page: enough to tell where a reader is.
async function whereAmI(page) {
  const state = await settled(page);
  return { section: state.section, page: state.page };
}
async function reading(page) {
  await page.locator("#reader-loading").waitFor({ state: "hidden" });
  await page.waitForFunction(() => {
    try { return document.querySelector("foliate-view")?.renderer?.pages > 0; } catch { return false; }
  });
  return settled(page);
}
async function panelItems(page) {
  return page.locator("#passages-list .passage-item").evaluateAll((items) =>
    items.map((i) => [i.querySelector(".passage-item-quote").textContent, i.querySelector(".bookmark-item-meta").textContent]));
}

async function seed() {
  const first = await libraryBook(BOOKS.first), second = await libraryBook(BOOKS.second);
  const now = new Date().toISOString();
  const journal = {
    v: 1, id: randomUUID(), created: now, updated: now, device: "seed", deleted: false, name: "Wayfarers", cover: null,
    sources: [{ type: "series", name: "Wayfarers", enabled: true }],
  };
  await putDoc("journals", journal);
  // Deliberately seeded out of page order: chapter Three before chapter One.
  await seedPassage(journal, first, "Three paragraph 0.", "epubcfi(/6/8!/4/4[three-p0],/1:0,/1:18)", 0.76, { tags: ["later"] });
  await seedPassage(journal, first, "One paragraph 2.", "epubcfi(/6/2!/4/8[one-p2],/1:0,/1:16)", 0.02);
  await seedPassage(journal, first, "One paragraph 0.", "epubcfi(/6/2!/4/4[one-p0],/1:0,/1:16)", 0.01);
  await seedPassage(journal, second, "Two paragraph 1.", "epubcfi(/6/4!/4/6[two-p1],/1:0,/1:16)", 0.27, { note: "from the second volume" });
  return { first, second, journal };
}

// From the journal view: open, look, come back. Nothing is recorded.
async function visitFromJournal(page, name, { second }) {
  // The reader has a saved place in the second volume, well away from the passage.
  await setProgress(second, "epubcfi(/6/8!/4/4[three-p0],/1:0,/1:1)", 0.76);
  const before = await progressOf(second);

  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.locator("#journals .journal-card", { hasText: "Wayfarers" }).click();
  await page.locator("#journal-cards .passage-card", { hasText: "Two paragraph 1." }).locator('[data-act="visit"]').click();
  await reading(page);
  assert.equal(await page.locator("#visit-bar").isVisible(), true, `${name}: a visit shows no way back`);
  assert.equal(await page.locator("#visit-label").textContent(), `Visiting ${BOOKS.second}`);
  assert.deepEqual(
    await page.locator("#visit-bar button").allTextContents(),
    ["Back to journal", "Go to my place"],
    `${name}: visit controls changed`,
  );
  let here = await whereAmI(page);
  assert.equal(here.section, 1, `${name}: the visit did not open at the passage's chapter`);

  // Paging around during a visit is not reading.
  await turnPage(page);
  await turnPage(page);
  await page.waitForTimeout(600);
  assert.deepEqual(await progressOf(second), before, `${name}: a visit moved the saved place`);

  await page.locator("#visit-back").click();
  await page.locator("#reader").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#journal-view").isVisible(), true, `${name}: "Back to journal" did not return to the journal`);
  assert.equal(await page.locator("#journal-title").textContent(), "Wayfarers");
  assert.deepEqual(await progressOf(second), before, `${name}: leaving a visit moved the saved place`);

  // "Go to my place" turns the visit into reading, from where reading left off.
  await page.locator("#journal-cards .passage-card", { hasText: "Two paragraph 1." }).locator('[data-act="visit"]').click();
  await reading(page);
  await page.locator("#visit-place").click();
  await page.locator("#visit-bar").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("foliate-view")?.lastLocation?.section?.current === 3);
  here = await whereAmI(page);
  assert.equal(here.section, 3, `${name}: "Go to my place" did not go to the saved place`);
  await turnPage(page);
  await page.waitForFunction(async (args) => {
    const data = await fetch("/api/progress").then((r) => r.json());
    return data.books[args.id]?.last_opened !== args.token;
  }, { id: second.id, token: before.last_opened });
  await page.evaluate(() => document.querySelector("#reader-close").click());
  await page.locator("#reader").waitFor({ state: "hidden" });
  await page.locator("#journal-back").click();
}

// From inside a book: the Passages tab, and a visit that returns to the page.
async function visitFromReader(page, name, { first, second }) {
  await setProgress(first, null);
  await setProgress(second, "epubcfi(/6/8!/4/4[three-p0],/1:0,/1:1)", 0.76);
  const secondBefore = await progressOf(second);
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await openBook(page, BOOKS.first);
  await turnPage(page);
  await turnPage(page);
  const place = await whereAmI(page);

  await page.locator("#toc-toggle").click();
  await page.locator("#toc-passages-tab").click();
  assert.equal(await page.locator("#toc-passages-tab").getAttribute("aria-selected"), "true");
  // This book: its passages in page order, whatever order they were made in.
  assert.deepEqual(
    (await panelItems(page)).map(([quote]) => quote),
    ["One paragraph 0.", "One paragraph 2.", "Three paragraph 0."],
    `${name}: "This book" is not in page order`,
  );
  assert.equal(await page.locator("#passages-search").isVisible(), false);

  // Journal: every passage of the journals this book is in, across books.
  await page.locator("#passages-scope-journal").click();
  let items = await panelItems(page);
  assert.deepEqual(
    items.map(([quote]) => quote),
    ["One paragraph 0.", "One paragraph 2.", "Three paragraph 0.", "Two paragraph 1."],
    `${name}: journal scope does not span the journal's books`,
  );
  assert.match(items[3][1], /^Second Volume · /, `${name}: a passage from another book does not say which`);
  await page.locator("#passages-search").fill("second volume");
  await page.waitForFunction(() => document.querySelectorAll("#passages-list .passage-item").length === 1);
  await page.locator("#passages-search").fill("");
  await page.waitForFunction(() => document.querySelectorAll("#passages-list .passage-item").length === 4);
  await page.locator("#passages-tag").selectOption("later");
  assert.deepEqual((await panelItems(page)).map(([quote]) => quote), ["Three paragraph 0."]);
  await page.locator("#passages-tag").selectOption("");

  // A passage from another book opens as a visit...
  await page.locator("#passages-list .passage-item", { hasText: "Two paragraph 1." }).click();
  await page.locator("#visit-bar").waitFor({ state: "visible" });
  await reading(page);
  assert.equal(await page.locator("#visit-label").textContent(), `Visiting ${BOOKS.second}`);
  assert.equal((await whereAmI(page)).section, 1);
  await turnPage(page);
  await page.waitForTimeout(600);
  assert.deepEqual(await progressOf(second), secondBefore, `${name}: visiting from the reader moved the other book's place`);

  // ...and backing out returns to the page that was open, journal still up.
  await page.locator("#visit-back").click();
  await page.locator("#visit-bar").waitFor({ state: "hidden" });
  await page.locator("#toc-view").waitFor({ state: "visible" });
  await reading(page);
  assert.equal(await page.locator("#toc-passages-tab").getAttribute("aria-selected"), "true", `${name}: did not return to the journal panel`);
  assert.equal(await page.locator("#passages-scope-journal").getAttribute("aria-pressed"), "true");
  await page.locator("#toc-back").click();
  await page.waitForFunction((p) => {
    const view = document.querySelector("foliate-view");
    try { return view.lastLocation?.section?.current === p.section && view.renderer.page === p.page; } catch { return false; }
  }, place);
  assert.deepEqual(await whereAmI(page), place, `${name}: backing out of a visit did not return to the page that was open`);

  // A passage in the book being read is a visit too. Going to look at it must
  // not become the reader's place.
  await page.waitForTimeout(600);
  const firstBefore = await progressOf(first);
  assert.ok(firstBefore?.cfi, "test setup: the open book has no saved place");
  const toPassage = async () => {
    await page.locator("#toc-toggle").click();
    await page.locator("#toc-passages-tab").click();
    await page.locator("#passages-list .passage-item", { hasText: "Three paragraph 0." }).click();
    await page.locator("#toc-view").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("foliate-view")?.lastLocation?.section?.current === 3);
    await settled(page);
  };
  await toPassage();
  assert.equal(await page.locator("#visit-bar").isVisible(), true, `${name}: a passage in the open book was not opened as a visit`);
  assert.equal(await page.locator("#visit-label").textContent(), "Visiting a passage");
  await turnPage(page);
  await page.waitForTimeout(600);
  assert.deepEqual(await progressOf(first), firstBefore, `${name}: looking up a passage in the open book moved the reader's place`);

  // "Go to my place" is the page that was being read.
  await page.locator("#visit-place").click();
  await page.locator("#visit-bar").waitFor({ state: "hidden" });
  await page.waitForFunction((p) => document.querySelector("foliate-view")?.lastLocation?.section?.current === p.section, place);
  assert.deepEqual(await whereAmI(page), place, `${name}: "Go to my place" did not return to the page being read`);

  // "Back to journal" is that page too, with the Passages tab open again.
  await toPassage();
  await page.locator("#visit-back").click();
  await page.locator("#toc-view").waitFor({ state: "visible" });
  assert.equal(await page.locator("#toc-passages-tab").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#visit-bar").isVisible(), false);
  await page.locator("#toc-back").click();
  await page.waitForFunction((p) => document.querySelector("foliate-view")?.lastLocation?.section?.current === p.section, place);
  assert.deepEqual(await whereAmI(page), place, `${name}: backing out of a passage in the open book lost the page`);
  // And closing the book afterwards leaves the place where it was.
  await page.waitForTimeout(600);
  assert.equal((await progressOf(first)).cfi, firstBefore.cfi, `${name}: the reader's place changed after visiting a passage in the same book`);
}

// From a mark on the page: "View in journal" opens the journal over the book.
// A visit made from there returns to the same page with the journal back over
// it; a passage in the open book is simply a place to go.
async function visitFromAMark(page, name, { first, second }) {
  await setProgress(first, null);
  const secondBefore = await progressOf(second);
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await openBook(page, BOOKS.first);
  await hideChrome(page);
  await page.evaluate(async () => { await document.querySelector("foliate-view").goTo(0); });
  const place = await whereAmI(page);

  await tapText(page, "#one-p0", 5);
  await page.locator("#passage-sheet [data-ps-journal]").click();
  await page.locator("#journal-view").waitFor({ state: "visible" });
  assert.equal(await page.locator("#journal-title").textContent(), "Wayfarers");
  assert.equal(await page.locator("#journal-cards .passage-card.focused .passage-quote").textContent(), "One paragraph 0.");

  // Another book: a visit, with the open book remembered.
  await page.locator("#journal-cards .passage-card", { hasText: "Two paragraph 1." }).locator('[data-act="visit"]').click();
  await page.locator("#visit-bar").waitFor({ state: "visible" });
  await reading(page);
  assert.equal(await page.locator("#visit-label").textContent(), `Visiting ${BOOKS.second}`);
  assert.equal(await page.locator("#journal-view").evaluate((el) => el.classList.contains("over-reader")), false, `${name}: the journal is covering the visit`);
  await turnPage(page);
  await page.waitForTimeout(600);
  assert.deepEqual(await progressOf(second), secondBefore, `${name}: a visit from a mark's journal moved the other book's place`);

  await page.locator("#visit-back").click();
  await page.locator("#visit-bar").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("#journal-view").classList.contains("over-reader"));
  assert.equal(await page.locator("#journal-title").textContent(), "Wayfarers", `${name}: "Back to journal" did not return to the journal`);
  await reading(page);
  await page.locator("#journal-back").click();
  await page.locator("#journal-view").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#reader").isVisible(), true);
  assert.deepEqual(await whereAmI(page), place, `${name}: did not return to the page that was open`);

  // The same book: still a visit. The journal steps aside, the reader goes to
  // the passage, and "Back to journal" brings back both the journal and the page.
  await hideChrome(page);
  await page.waitForTimeout(600);
  const firstBefore = await progressOf(first);
  await tapText(page, "#one-p0", 5);
  await page.locator("#passage-sheet [data-ps-journal]").click();
  await page.locator("#journal-cards .passage-card", { hasText: "Three paragraph 0." }).locator('[data-act="visit"]').click();
  await page.waitForFunction(() => !document.querySelector("#journal-view").classList.contains("over-reader"));
  await page.waitForFunction(() => document.querySelector("foliate-view")?.lastLocation?.section?.current === 3);
  assert.equal(await page.locator("#visit-bar").isVisible(), true, `${name}: a passage in the open book was not opened as a visit`);
  await turnPage(page);
  await page.waitForTimeout(600);
  assert.deepEqual(await progressOf(first), firstBefore, `${name}: a same-book visit from the journal moved the reader's place`);
  await page.locator("#visit-back").click();
  await page.waitForFunction(() => document.querySelector("#journal-view").classList.contains("over-reader"));
  await page.locator("#journal-back").click();
  await page.locator("#journal-view").waitFor({ state: "hidden" });
  await page.waitForFunction((p) => document.querySelector("foliate-view")?.lastLocation?.section?.current === p.section, place);
  assert.deepEqual(await whereAmI(page), place, `${name}: did not return to the page that was open`);
}

// The server cannot supply the book and it is not on the device: a reminder,
// not an error, and a way back.
async function visitWithoutTheBook(context, page, name, { second }) {
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await context.route(`**/api/book/${second.id}/file`, (route) => route.abort());
  await page.locator("#journals .journal-card", { hasText: "Wayfarers" }).click();
  await page.locator("#journal-cards .passage-card", { hasText: "Two paragraph 1." }).locator('[data-act="visit"]').click();
  const reminder = page.locator("#reader-loading .visit-unavailable");
  await reminder.waitFor();
  assert.match(await reminder.textContent(), /Did you sync the book to this device with Syncthing\?/, `${name}: missing-book reminder changed`);
  await reminder.locator("button").click();
  await page.locator("#reader").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#journal-view").isVisible(), true, `${name}: no way back from an unavailable book`);
  // The passage itself is still fully readable.
  assert.equal(await page.locator("#journal-cards .passage-card", { hasText: "Two paragraph 1." }).locator(".passage-note").textContent(), "from the second volume");
  await context.unroute(`**/api/book/${second.id}/file`);
}

async function runEngine(name, engine) {
  await wipeJournals();
  const fixtures = await seed();
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 820, height: 1000 } });
    const page = await context.newPage();
    await visitFromJournal(page, name, fixtures);
    await visitFromReader(page, name, fixtures);
    await visitFromAMark(page, name, fixtures);
    await visitWithoutTheBook(context, page, name, fixtures);
    await context.close();
    console.log(`${name}: visits leave the reader's place alone and return to where they started`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
