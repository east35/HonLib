// Shared plumbing for the annotation and journal browser tests: reset the
// journal folder between tests, select text in the book the way a reader's
// drag does, and tap a point on the page with real pointer events.
import { baseURL, settled } from "./reader-harness.mjs";

export const BOOKS = {
  split: "HonLib Split Chapter Test",
  first: "First Volume",
  second: "Second Volume",
};

export async function journalState() {
  const data = await fetch(`${baseURL}/api/journal/sync`).then((r) => r.json());
  return {
    journals: data.journals.filter((d) => !d.deleted),
    passages: data.passages.filter((d) => !d.deleted),
    all: data,
  };
}

export async function putDoc(kind, doc) {
  const res = await fetch(`${baseURL}/api/journal/${kind}/${doc.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`could not store ${kind}/${doc.id}: HTTP ${res.status}`);
  return res.json();
}

// The tests share one server, so each starts by deleting whatever the last one
// left: a marker for every document, dated just after its last change.
export async function wipeJournals() {
  const { all } = await journalState();
  for (const kind of ["journals", "passages"]) {
    for (const doc of all[kind]) {
      if (doc.deleted) continue;
      const updated = new Date(Math.max(Date.now(), Date.parse(doc.updated) || 0) + 1).toISOString();
      await putDoc(kind, { v: 1, id: doc.id, updated, device: "test-reset", deleted: true });
    }
  }
}

export async function libraryBook(title) {
  const library = await fetch(`${baseURL}/api/library`).then((r) => r.json());
  const book = library.books.find((b) => b.title === title);
  if (!book) throw new Error(`fixture "${title}" not in the library`);
  return book;
}

// Wait until the server holds what `predicate` wants, and return it. Captures
// are sent in the background, so the page showing a highlight and the server
// having it are two different moments.
export async function waitForJournal(predicate, what = "journal state") {
  for (let i = 0; i < 100; i++) {
    const state = await journalState();
    const found = predicate(state);
    if (found) return found === true ? state : found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`never saw ${what}`);
}

// Select [start, end) of the first text node of `selector` in the loaded
// section, and wait for the reader to react to it (it debounces selection
// changes, as a drag fires many).
export async function selectText(page, selector, start, end) {
  await page.evaluate(({ selector, start, end }) => {
    const view = document.querySelector("foliate-view");
    const doc = view.renderer.getContents()[0].doc;
    const node = doc.querySelector(selector).firstChild;
    const range = doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, { selector, start, end });
  await page.waitForFunction(() =>
    !document.querySelector("#passage-sheet").classList.contains("hidden")
    || !document.querySelector("#dict-popover").classList.contains("hidden"));
}

// Screen position of a character inside the book, for tapping it.
export async function pointInText(page, selector, offset) {
  return page.evaluate(({ selector, offset }) => {
    const view = document.querySelector("foliate-view");
    const doc = view.renderer.getContents()[0].doc;
    const node = doc.querySelector(selector).firstChild;
    const range = doc.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getClientRects()[0];
    const frame = doc.defaultView.frameElement.getBoundingClientRect();
    return { x: frame.left + rect.left + rect.width / 2, y: frame.top + rect.top + rect.height / 2 };
  }, { selector, offset });
}

export async function tapText(page, selector, offset) {
  const point = await pointInText(page, selector, offset);
  await page.mouse.click(point.x, point.y);
}

export function sheetOpen(page) {
  return page.evaluate(() => !document.querySelector("#passage-sheet").classList.contains("hidden"));
}

// The reading menu is up when a book opens and takes the first tap for itself.
export async function hideChrome(page) {
  await page.evaluate(() => document.querySelector("#reader").classList.add("chrome-hidden"));
}

// Has the reader left `before` (a readState)? A tap turns the page a moment
// after it lands, so "did it turn?" has to wait for the move, or give up.
export async function movedFrom(page, before, timeout = 3000) {
  try {
    await page.waitForFunction((b) => {
      const view = document.querySelector("foliate-view");
      let current;
      try { current = view.renderer.page; } catch { return false; }
      return view.lastLocation?.section?.current !== b.section || current !== b.page;
    }, before, { timeout });
  } catch { return false; }
  await settled(page);
  return true;
}
