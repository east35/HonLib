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

// Select the last `length` characters showing on the page: the text a sheet
// docked at the foot of the screen would cover, and the place a passage that
// runs on to the next page is selected up to.
export async function selectPageEnd(page, length) {
  await page.evaluate((length) => {
    const view = document.querySelector("foliate-view");
    const visible = view.lastLocation.range;
    const doc = visible.endContainer.ownerDocument;
    const range = doc.createRange();
    range.setStart(visible.endContainer, Math.max(0, visible.endOffset - length));
    range.setEnd(visible.endContainer, visible.endOffset);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, length);
  await page.locator("#passage-sheet").waitFor({ state: "visible" });
}

// Where the selection and the open sheet are on the screen, top and bottom.
export async function sheetAndSelection(page, sheet = "#passage-sheet") {
  return page.evaluate((sheet) => {
    const view = document.querySelector("foliate-view");
    const doc = view.renderer.getContents()[0].doc;
    const frame = doc.defaultView.frameElement.getBoundingClientRect();
    const rects = [...doc.getSelection().getRangeAt(0).getClientRects()]
      .filter((r) => frame.left + r.right > 0 && frame.left + r.left < window.innerWidth);
    const el = document.querySelector(sheet).getBoundingClientRect();
    return {
      selection: { top: frame.top + Math.min(...rects.map((r) => r.top)), bottom: frame.top + Math.max(...rects.map((r) => r.bottom)) },
      sheet: { top: el.top, bottom: el.bottom },
    };
  }, sheet);
}

// What a stretch of text looks like on the screen: `ink` is the share of it
// that is dark (its letters), `ground` the colour behind them. The picture is
// read back through a canvas in the page, as node has nothing to decode it.
export async function inkOf(page, selector, start, end) {
  const clip = await page.evaluate(({ selector, start, end }) => {
    const doc = document.querySelector("foliate-view").renderer.getContents()[0].doc;
    const node = doc.querySelector(selector).firstChild;
    const range = doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const rect = range.getClientRects()[0], frame = doc.defaultView.frameElement.getBoundingClientRect();
    return { x: frame.left + rect.left, y: frame.top + rect.top, width: rect.width, height: rect.height };
  }, { selector, start, end });
  const png = await page.screenshot({ clip });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 250) dark += 1;
    // Two pixels in from the corner: inside the mark, clear of any letter.
    const corner = (2 * canvas.width + 2) * 4;
    return { ink: dark / (pixels.length / 4), ground: [...pixels.slice(corner, corner + 3)] };
  }, png.toString("base64"));
}

// The ranges the book's document has been given to tint, by colour.
export function tinted(page) {
  return page.evaluate(() => {
    const doc = document.querySelector("foliate-view").renderer.getContents()[0].doc;
    return Object.fromEntries([...doc.defaultView.CSS.highlights].map(([name, set]) => [name.replace("honlib-", ""), set.size]).filter(([, size]) => size));
  });
}

// A card's overflow menu holds what is done to the passage as a whole: copy
// it, open its page, take it out of the journal, delete it.
export async function cardMenu(card, act) {
  await card.locator('[data-act="menu"]').click();
  await card.locator(`.passage-menu [data-act="${act}"]`).click();
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

// A character at or after `offset` that sits where a tap turns the page
// forward. Where a given character falls depends on the fonts of the machine,
// and one at the start of a line is in the strip down the left that turns
// back, which on a book's first page turns nothing.
export async function forwardPointInText(page, selector, offset) {
  for (let at = offset; at < offset + 120; at++) {
    const point = await pointInText(page, selector, at);
    const width = page.viewportSize().width;
    if (point.x > width * 0.3 && point.x < width * 0.9) return point;
  }
  throw new Error(`no character of ${selector} from ${offset} is clear of the page's edges`);
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
