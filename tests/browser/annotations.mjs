// Capture in the reader: selecting a phrase offers the annotation bar, and any
// of its tools saves the passage on the spot — on the page, on the server, and
// in a journal — before the reader does anything else. A tap on a mark shows
// that passage with the way to its journal, and editing one tap further; a tap
// anywhere else still turns the page.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { engines, openBook, readState, settled } from "./reader-harness.mjs";
import { BOOKS, hideChrome, inkOf, journalState, libraryBook, movedFrom, pointInText, selectPageEnd, selectText, sheetAndSelection, sheetOpen, tapText, tinted, waitForJournal, wipeJournals } from "./journal-harness.mjs";

async function barButtons(page) {
  return page.locator("#passage-sheet .ps-bar button").allTextContents();
}

async function captureAndStyle(page, name, book) {
  await selectText(page, "#one-p0", 17, 90);
  assert.deepEqual(await barButtons(page), ["Highlight", "Underline", "Add tag", "Add note"], `${name}: annotation bar changed`);
  // Mid-page there is nowhere for the passage to run on to.
  assert.equal(await page.locator("#passage-sheet [data-ps-continue]").count(), 0, `${name}: a passage in mid-page was offered the next page`);

  await page.locator('[data-ps-new="highlight"]').click();
  // Saved the moment it is made: the sheet is already about a stored passage.
  assert.equal(await page.locator("#passage-sheet .ps-status").textContent(), "Saved to My First Journal.", `${name}: first highlight did not announce its journal`);
  const state = await waitForJournal((s) => s.passages.length === 1 && s.journals.length === 1, "the first highlight on the server");
  const [passage] = state.passages, [journal] = state.journals;
  assert.equal(passage.text, "Filler text that exists only to make this section long enough to span sev", `${name}: passage text is not what was selected`);
  assert.deepEqual(passage.style, { highlight: "yellow", underline: null }, `${name}: default style changed`);
  assert.equal(passage.source.book_key, book.key, `${name}: passage is not tied to its book's stable key`);
  assert.equal(passage.source.book_id, book.id);
  assert.equal(passage.source.title, BOOKS.first);
  assert.equal(passage.source.author, "Ann Author");
  assert.equal(passage.source.series, "Wayfarers");
  assert.equal(passage.source.series_index, 1, `${name}: series index should be a number`);
  assert.equal(passage.source.chapter, "One");
  assert.match(passage.source.cfi, /^epubcfi\(.+,.+,.+\)$/, `${name}: passage has no range CFI`);
  assert.ok(passage.context.after.startsWith("eral rendered pages"), `${name}: context after the passage is missing`);
  assert.ok(passage.device && passage.updated && passage.created && passage.v === 1, `${name}: sync fields missing`);
  assert.equal(journal.name, "My First Journal");
  assert.deepEqual(journal.sources, [{ type: "book", book_key: book.key, enabled: true }], `${name}: first journal does not enable the book`);
  assert.deepEqual(passage.journals, [journal.id], `${name}: first highlight was not filed`);

  // Every colour is named, not just shown.
  assert.deepEqual(
    await page.locator("#passage-sheet .ps-panel .ps-option").allTextContents(),
    ["None", "Yellow", "Green", "Blue", "Pink", "Orange"],
    `${name}: highlight colours changed`,
  );
  await page.locator('.ps-option[data-style-value="blue"]').click();
  await page.locator('[data-ps-tool="underline"]').click();
  assert.deepEqual(
    await page.locator("#passage-sheet .ps-panel .ps-option").allTextContents(),
    ["None", "Solid", "Dashed", "Dotted", "Wavy", "Double"],
    `${name}: underline styles changed`,
  );
  await page.locator('.ps-option[data-style-value="dashed"]').click();
  await waitForJournal((s) => s.passages[0]?.style.highlight === "blue" && s.passages[0]?.style.underline === "dashed", "the restyled passage");

  // With an underline set the highlight can go; the last mark standing cannot.
  await page.locator('[data-ps-tool="highlight"]').click();
  await page.locator('.ps-option[data-style-kind="highlight"][data-style-value=""]').click();
  await waitForJournal((s) => s.passages[0]?.style.highlight === null, "highlight removed");
  await page.locator('[data-ps-tool="underline"]').click();
  assert.equal(await page.locator('.ps-option[data-style-kind="underline"][data-style-value=""]').isDisabled(), true, `${name}: a passage could be left with no mark at all`);
  await page.locator('[data-ps-tool="highlight"]').click();
  await page.locator('.ps-option[data-style-value="blue"]').click();
  return passage.id;
}

async function tagAndNote(page, name) {
  const before = await readState(page);
  await page.locator('[data-ps-tool="tag"]').click();
  await page.keyboard.type("openings");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two words");
  await page.keyboard.press("Enter");
  await page.locator('[data-ps-tool="note"]').click();
  // Spaces and arrow keys typed into a note are text, not page turns.
  await page.keyboard.type("Where it all starts. ");
  await page.keyboard.press("ArrowLeft");
  await page.locator(".note-tool button").click();
  const state = await waitForJournal((s) => s.passages[0]?.note === "Where it all starts.", "the note");
  assert.deepEqual(state.passages[0].tags, ["openings", "two words"], `${name}: tags not saved`);
  const after = await readState(page);
  assert.deepEqual([after.section, after.page], [before.section, before.page], `${name}: typing a note turned the page`);
  await page.locator("[data-ps-close]").click();
  assert.equal(await sheetOpen(page), false, `${name}: Done left the sheet open`);
}

// A highlight is a tint behind the words, never over them: the letters show on
// it in both reading themes. The book's own document paints it, from the
// passage's range, so nothing is laid on top of the page to go wrong.
async function marksShowTheirText(page, name) {
  const blue = [168, 216, 255];
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
  assert.deepEqual(await tinted(page), { blue: 1 }, `${name}: the passage's tint was not given to the page to paint`);
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") {
      await page.evaluate(() => document.querySelector("#reader-theme").click());
      await page.waitForFunction(() => document.querySelector("#reader").dataset.readerTheme === "dark");
      await settled(page);
    }
    const seen = await inkOf(page, "#one-p0", 17, 60);
    assert.ok(near(seen.ground, blue), `${name}: the highlight is not its colour in the ${theme} theme (${seen.ground})`);
    assert.ok(seen.ink > 0.08, `${name}: the highlighted words can't be read in the ${theme} theme (${Math.round(seen.ink * 100)}% ink)`);
  }
  await page.evaluate(() => document.querySelector("#reader-theme").click());
  await page.waitForFunction(() => document.querySelector("#reader").dataset.readerTheme === "light");
  await settled(page);
}

async function tapsOnAndOffTheMark(page, name, passageId) {
  const start = await readState(page);
  await tapText(page, "#one-p0", 40);
  assert.equal(await sheetOpen(page), true, `${name}: tapping a mark did not open its passage`);
  // A passage made earlier is shown, not opened for editing.
  assert.deepEqual(await barButtons(page), ["View in journal", "Edit annotation"], `${name}: a tapped mark should offer its journal and editing, nothing else`);
  assert.equal(await page.locator("#passage-sheet [data-ps-tool], #passage-sheet [data-ps-delete]").count(), 0, `${name}: tapping a mark exposed the editing controls`);
  assert.equal(await page.locator("#passage-sheet .ps-note").textContent(), "Where it all starts.", `${name}: the passage's note is not shown`);
  assert.equal(
    await page.locator("#passage-sheet .ps-status").textContent(),
    "In My First Journal · Blue highlight, Dashed underline · #openings · #two words",
  );

  // "View in journal" opens the journal over the page, on this passage, and
  // going back uncovers the same page.
  await page.locator("#passage-sheet [data-ps-journal]").click();
  assert.equal(await page.locator("#journal-view").isVisible(), true, `${name}: "View in journal" did not open the journal`);
  assert.equal(await page.locator("#journal-title").textContent(), "My First Journal");
  assert.equal(await page.locator("#journal-view").evaluate((el) => el.classList.contains("over-reader")), true);
  assert.deepEqual(
    await page.locator("#journal-cards .passage-card.focused").evaluateAll((cards) => cards.map((c) => c.dataset.passageId)),
    [passageId],
    `${name}: the journal did not open on the passage that was tapped`,
  );
  await page.locator("#journal-back").click();
  await page.locator("#journal-view").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#reader").isVisible(), true, `${name}: leaving the journal closed the book`);
  assert.equal(await movedFrom(page, start, 500), false, `${name}: a trip to the journal lost the reader's page`);

  // "Edit annotation" is where the tools are.
  await tapText(page, "#one-p0", 40);
  await page.locator("#passage-sheet [data-ps-edit]").click();
  assert.deepEqual(
    await barButtons(page),
    ["Blue", "Dashed", "Tags (2)", "Edit note", "Delete"],
    `${name}: the sheet does not describe the passage that was tapped`,
  );
  assert.equal(await page.locator("#passage-sheet .ps-status").textContent(), "In My First Journal");

  // Tapping plain text puts the sheet away and nothing else; the next tap turns.
  await tapText(page, "#one-p1", 300);
  assert.equal(await sheetOpen(page), false, `${name}: tapping the page did not dismiss the sheet`);
  assert.equal(await movedFrom(page, start, 800), false, `${name}: the dismissing tap also turned the page`);
  await tapText(page, "#one-p1", 300);
  assert.equal(await movedFrom(page, start), true, `${name}: a tap off the mark no longer turns the page`);
  await page.evaluate(() => window.ebookTurnPage("prev"));
  await settled(page);

  // Selecting exactly the same passage again shows it rather than stacking a
  // second passage on top.
  await selectText(page, "#one-p0", 17, 90);
  await page.locator('[data-ps-new="highlight"]').click();
  assert.equal((await journalState()).passages.length, 1, `${name}: re-marking the same text made a duplicate`);
  assert.deepEqual(await barButtons(page), ["View in journal", "Edit annotation"]);
  await page.locator("[data-ps-close]").click();
  return passageId;
}

// The annotation bar sits beside the text it is about and never on it: just
// over it, leaving the lines that follow free to be tapped, or under it where
// there is no room above. The reading menu, which lives at the foot of the
// page, gets out of the way.
async function sheetsSitBeside(page, name) {
  const NEAR = 30;
  const over = (seen) => seen.sheet.bottom <= seen.selection.top && seen.selection.top - seen.sheet.bottom < NEAR;
  await page.evaluate(() => document.querySelector("#reader").classList.remove("chrome-hidden"));
  // The last lines of the page.
  await selectPageEnd(page, 200);
  let seen = await sheetAndSelection(page);
  assert.ok(over(seen), `${name}: the annotation bar is not just over a selection at the foot of the page (${JSON.stringify(seen)})`);
  assert.equal(await page.locator("#reader").evaluate((el) => el.classList.contains("chrome-hidden")), true, `${name}: the reading menu stayed up over a selection`);
  // It stays there as the sheet that edits the passage, and when tapped later.
  const marked = seen.selection;
  await page.locator('[data-ps-new="highlight"]').click();
  await page.locator('#passage-sheet [data-ps-tool="highlight"][aria-pressed="true"]').waitFor();
  let box = await page.locator("#passage-sheet").boundingBox();
  assert.ok(box.y + box.height <= marked.top && marked.top - (box.y + box.height) < NEAR, `${name}: the editing sheet left the passage it edits`);
  const made = (await waitForJournal((s) => s.passages.length === 2 && s, "the passage at the foot of the page")).passages.find((p) => p.text !== "Filler text that exists only to make this section long enough to span sev");
  await page.locator("[data-ps-close]").click();
  const foot = await page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const visible = view.lastLocation.range, doc = visible.endContainer.ownerDocument;
    const range = doc.createRange();
    range.setStart(visible.endContainer, visible.endOffset - 20);
    range.setEnd(visible.endContainer, visible.endOffset - 19);
    const rect = range.getClientRects()[0], frame = doc.defaultView.frameElement.getBoundingClientRect();
    return { x: frame.left + rect.left + rect.width / 2, y: frame.top + rect.top + rect.height / 2 };
  });
  await page.mouse.click(foot.x, foot.y);
  await page.locator("#passage-sheet [data-ps-edit]").waitFor();
  box = await page.locator("#passage-sheet").boundingBox();
  assert.ok(box.y + box.height <= marked.top && marked.top - (box.y + box.height) < NEAR, `${name}: a tapped mark's sheet is not beside it`);
  await page.locator("#passage-sheet [data-ps-edit]").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-ps-delete]").click();
  await waitForJournal((s) => !s.passages.some((p) => p.id === made.id), "the foot-of-page passage deleted");

  // In mid-page too it goes over the selection, not onto what follows it.
  await selectText(page, "#one-p1", 100, 160);
  seen = await sheetAndSelection(page);
  assert.ok(over(seen), `${name}: the annotation bar is not just over a selection in mid-page (${JSON.stringify(seen)})`);
  // The definition sheet follows the same rule. (The dictionary is a
  // third-party service; any answer will do.)
  const lookup = (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notFound: true }) });
  await page.route("**/api/dictionary/*", lookup);
  await selectText(page, "#one-p1", 17, 23);
  await page.locator("#dict-popover").waitFor({ state: "visible" });
  seen = await sheetAndSelection(page, "#dict-popover");
  assert.ok(over(seen), `${name}: the definition is not just over its word (${JSON.stringify(seen)})`);
  await page.locator("#dict-popover .dict-close").click();
  await page.locator("#dict-popover").waitFor({ state: "hidden" });
  await page.unroute("**/api/dictionary/*", lookup);

  // On the first line of a page there is no room above. It goes under, a few
  // lines down, so that the words after the selection can still be tapped.
  await page.evaluate(() => window.ebookTurnPage("next"));
  await settled(page);
  await page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const visible = view.lastLocation.range, doc = visible.startContainer.ownerDocument;
    // The page may open on the break between two paragraphs.
    let node = visible.startContainer, from = visible.startOffset;
    if (node.nodeType !== Node.TEXT_NODE || node.length - from < 12) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      walker.currentNode = node;
      do { node = walker.nextNode(); } while (node && !node.data.trim());
      from = 0;
    }
    const range = doc.createRange();
    range.setStart(node, from);
    range.setEnd(node, Math.min(node.length, from + 40));
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator("#passage-sheet").waitFor({ state: "visible" });
  seen = await sheetAndSelection(page);
  const gap = seen.sheet.top - seen.selection.bottom;
  assert.ok(gap >= 60 && gap < 130, `${name}: under a selection at the top of the page, the annotation bar should leave a few lines clear (${JSON.stringify(seen)})`);
  await page.locator("#passage-sheet [data-ps-close]").click();
  assert.equal(await sheetOpen(page), false, `${name}: Cancel left the annotation bar up`);
  await page.evaluate(() => window.ebookTurnPage("prev"));
  await settled(page);
}

// With text selected, a tap on a word moves the selection to it: its end, or
// its start for a word before it. That is how a passage is stretched on a
// screen where dragging handles is hard work. A tap on anything else lets the
// selection go, and neither turns the page.
async function tapsMoveTheSelection(page, name) {
  const start = await readState(page);
  const quote = () => page.locator("#passage-sheet .ps-quote").textContent();
  const tap = async (selector, offset) => {
    const point = await pointInText(page, selector, offset);
    await page.mouse.click(point.x, point.y);
  };
  // "One paragraph 1. Filler text that exists only to make this section long…"
  await selectText(page, "#one-p1", 17, 33);
  assert.equal(await quote(), "Filler text that");
  assert.equal(await page.locator("#passage-sheet .ps-status").textContent(), "Tap a word to end the passage there.");
  await tap("#one-p1", 61);
  assert.equal(await quote(), "Filler text that exists only to make this section", `${name}: a tap on a later word did not end the selection there`);
  await tap("#one-p1", 42);
  assert.equal(await quote(), "Filler text that exists only", `${name}: a tap inside the selection did not shorten it`);
  await tap("#one-p1", 6);
  assert.equal(await quote(), "paragraph 1. Filler text that exists only", `${name}: a tap before the selection did not start it there`);
  assert.equal(await movedFrom(page, start, 500), false, `${name}: moving the selection turned the page`);
  // What is saved is what the taps arrived at.
  const before = (await journalState()).passages.length;
  await page.locator('[data-ps-new="underline"]').click();
  const made = (await waitForJournal((s) => s.passages.length === before + 1 && s, "the tapped-out passage")).passages.find((p) => p.text.startsWith("paragraph 1."));
  assert.equal(made?.text, "paragraph 1. Filler text that exists only", `${name}: the passage saved is not the one the taps selected`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-ps-delete]").click();
  await waitForJournal((s) => s.passages.length === before, "the tapped-out passage deleted");

  // From a single word, whose sheet is its definition, the same tap makes a passage.
  const lookup = (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notFound: true }) });
  await page.route("**/api/dictionary/*", lookup);
  await selectText(page, "#one-p1", 17, 23);
  assert.equal(await page.locator("#dict-popover .dict-hint").textContent(), "Tap another word to select through to it.");
  await tap("#one-p1", 31);
  await page.locator('#passage-sheet [data-ps-new="highlight"]').waitFor();
  assert.equal(await quote(), "Filler text that", `${name}: a tap from a looked-up word did not make a passage`);
  assert.equal(await page.locator("#dict-popover").isVisible(), false);
  await page.unroute("**/api/dictionary/*", lookup);

  // Beside the chapter heading there is no word: the tap lets the selection go.
  const blank = await page.evaluate(() => {
    const doc = document.querySelector("foliate-view").renderer.getContents()[0].doc;
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("h1"));
    const rect = range.getClientRects()[0], frame = doc.defaultView.frameElement.getBoundingClientRect();
    return { x: frame.left + rect.right + 160, y: frame.top + rect.top + rect.height / 2 };
  });
  await page.mouse.click(blank.x, blank.y);
  assert.equal(await sheetOpen(page), false, `${name}: a tap off the text did not put the selection away`);
  assert.equal(await page.evaluate(() => document.querySelector("foliate-view").renderer.getContents()[0].doc.getSelection().isCollapsed), true);
  assert.equal(await movedFrom(page, start, 700), false, `${name}: the tap that put the selection away also turned the page`);
}

// The page does not turn under a selection. A passage that runs past the foot
// of the page is carried over on request, and ends at the word tapped there.
async function passageAcrossPages(page, name) {
  const start = await readState(page);
  const before = (await journalState()).passages.length;
  await selectPageEnd(page, 60);
  // Left to itself, foliate turns the page ~0.7s after a selection reaches past
  // the end of it. Run the selection on a little, as a long press on a word
  // broken across the page does.
  await page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const doc = view.renderer.getContents()[0].doc, selection = doc.getSelection(), range = selection.getRangeAt(0);
    doc.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }));
    selection.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, Math.min(range.endOffset + 12, range.endContainer.length));
  });
  assert.equal(await movedFrom(page, start, 1500), false, `${name}: selecting past the foot of the page turned it`);
  await page.locator("#passage-sheet [data-ps-continue]").waitFor();
  const head = await page.evaluate(() => document.querySelector("foliate-view").renderer.getContents()[0].doc.getSelection().toString());

  await page.locator("#passage-sheet [data-ps-continue]").click();
  assert.equal(await movedFrom(page, start), true, `${name}: "Continue on next page" did not turn the page`);
  assert.equal(await page.locator("#passage-sheet .ps-status").textContent(), "Tap the last word of the passage.");
  assert.equal(await page.locator("#passage-sheet [data-ps-new]").count(), 0, `${name}: a passage with no end yet can be saved`);
  // Tap a word a few lines into the new page.
  const next = await readState(page);
  const word = await page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const visible = view.lastLocation.range, doc = visible.startContainer.ownerDocument;
    let node = visible.startContainer, at = node.data.indexOf("reasonable", visible.startOffset + 150);
    if (at < 0) { node = node.parentElement.nextElementSibling.firstChild; at = node.data.indexOf("reasonable"); }
    const range = doc.createRange();
    range.setStart(node, at + 2);
    range.setEnd(node, at + 3);
    const rect = range.getClientRects()[0], frame = doc.defaultView.frameElement.getBoundingClientRect();
    return { x: frame.left + rect.left + rect.width / 2, y: frame.top + rect.top + rect.height / 2 };
  });
  await page.mouse.click(word.x, word.y);
  await page.locator('#passage-sheet [data-ps-new="highlight"]').waitFor();
  assert.equal(await movedFrom(page, next, 600), false, `${name}: the tap that ends a carried passage turned the page`);
  await page.locator('[data-ps-new="highlight"]').click();
  const state = await waitForJournal((s) => s.passages.length === before + 1, "the passage that crosses a page");
  const crossing = state.passages.find((p) => p.text.startsWith(head.slice(0, 40)));
  assert.ok(crossing, `${name}: the carried passage does not start where it was selected`);
  assert.ok(crossing.text.endsWith("reasonable") && crossing.text.length > head.length + 100, `${name}: the carried passage does not end at the tapped word ("…${crossing.text.slice(-40)}")`);
  assert.match(crossing.source.cfi, /^epubcfi\(.+,.+,.+\)$/);
  // Cancel lets a carried passage go, selection and all.
  await page.locator("#passage-sheet [data-ps-edit], #passage-sheet [data-ps-delete]").first().waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-ps-delete]").click();
  await waitForJournal((s) => s.passages.length === before, "the crossing passage deleted");
  await selectPageEnd(page, 60);
  await page.locator("#passage-sheet [data-ps-continue]").click();
  await page.locator("#passage-sheet .ps-status").waitFor();
  await page.locator("#passage-sheet [data-ps-close]").click();
  assert.equal(await sheetOpen(page), false);
  assert.equal(await page.evaluate(() => document.querySelector("foliate-view").renderer.getContents()[0].doc.getSelection().isCollapsed), true, `${name}: cancelling left the passage selected on the page before`);
  await page.evaluate(async () => { await document.querySelector("foliate-view").goTo(0); });
  await settled(page);
}

async function saveFromDefinition(page, name) {
  // The dictionary is a third-party service; stand in a definition.
  await page.route("**/api/dictionary/*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ word: "filler", phonetic: "", meanings: [{ partOfSpeech: "noun", definitions: ["One who fills."] }] }),
  }));
  await selectText(page, "#one-p1", 17, 23);
  await page.locator("#dict-popover .dict-defs").waitFor();
  assert.equal(await sheetOpen(page), false, `${name}: a single word should get the definition, not the annotation bar`);
  const save = page.locator("#dict-popover .dict-save");
  assert.equal(await save.textContent(), "Save", `${name}: definition sheet lost its Save action`);
  await save.click();
  assert.equal(await save.textContent(), "Saved");
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.locator("#dict-popover .dict-defs").count() > 0, true, `${name}: saving closed the definition`);
  const state = await waitForJournal((s) => s.passages.length === 2, "the saved word");
  const word = state.passages.find((p) => p.text === "Filler");
  assert.ok(word, `${name}: saved word missing`);
  assert.equal(word.journals.length, 1, `${name}: saved word was not filed in the book's journal`);
  await page.locator("#dict-popover .dict-close").click();
  return word.id;
}

async function survivesReloadAndDelete(page, name, passageId, wordId) {
  // A fresh page draws the marks from the server.
  await openBook(page, BOOKS.first);
  await hideChrome(page);
  await page.evaluate(async () => { await document.querySelector("foliate-view").goTo(0); });
  await settled(page);
  await tapText(page, "#one-p0", 40);
  assert.equal(await sheetOpen(page), true, `${name}: marks were not redrawn after a reload`);
  await page.locator("#passage-sheet [data-ps-edit]").click();
  assert.deepEqual(await tinted(page), { blue: 2 }, `${name}: tints were not repainted after a reload`);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-ps-delete]").click();
  assert.equal(await sheetOpen(page), false);
  const state = await waitForJournal((s) => s.passages.length === 1, "the delete");
  assert.equal(state.passages[0].id, wordId);
  // Deleted is a marker, not a missing document, so other devices hear of it.
  const marker = state.all.passages.find((p) => p.id === passageId);
  assert.equal(marker.deleted, true, `${name}: delete was not recorded as a marker`);
  assert.equal(marker.text, undefined, `${name}: a deleted passage kept its text`);
  // Its tint goes with it. The saved word, in the colour last chosen, keeps its own.
  await page.waitForFunction(() => {
    const doc = document.querySelector("foliate-view").renderer.getContents()[0].doc;
    return doc.defaultView.CSS.highlights.get("honlib-blue")?.size === 1;
  }).catch(() => {});
  assert.deepEqual(await tinted(page), { blue: 1 }, `${name}: deleting a passage left its tint on the page`);

  // With the mark gone the same spot is ordinary page again.
  const before = await readState(page);
  await tapText(page, "#one-p0", 40);
  assert.equal(await sheetOpen(page), false, `${name}: a deleted passage still answers taps`);
  assert.equal(await movedFrom(page, before), true, `${name}: tap on a deleted mark did not turn the page`);
}

async function keepsCapturesWithoutAServer(context, page, name) {
  await page.evaluate(() => window.ebookTurnPage("prev"));
  await settled(page);
  const before = (await journalState()).passages.length;
  // The server goes away mid-read.
  await context.route("**/api/journal/**", (route) => route.abort());
  await selectText(page, "#one-p1", 100, 160);
  await page.locator('[data-ps-new="underline"]').click();
  assert.equal(await sheetOpen(page), true, `${name}: capture was blocked by an unreachable server`);
  await page.locator("[data-ps-close]").click();
  await tapText(page, "#one-p1", 130);
  assert.equal(await sheetOpen(page), true, `${name}: an unsent passage is not on the page`);
  await page.locator("[data-ps-close]").click();
  assert.equal((await journalState()).passages.length, before, "test setup: the write reached the server anyway");

  // It is still there after a reload, and goes out once the server is back.
  await page.reload({ waitUntil: "domcontentloaded" });
  const waiting = await page.evaluate(() => JSON.parse(localStorage.getItem("ebook-library.journalOutbox") || "[]").length);
  assert.equal(waiting, 1, `${name}: the unsent passage did not survive a reload`);
  await context.unroute("**/api/journal/**");
  await page.reload({ waitUntil: "networkidle" });
  const state = await waitForJournal((s) => s.passages.length === before + 1, "the queued passage");
  // Underline alone, in the style last chosen on this device.
  assert.ok(state.passages.some((p) => p.style.underline === "dashed" && p.style.highlight === null), `${name}: queued passage lost its style`);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("ebook-library.journalOutbox") || "[]").length === 0);
}

// E-readers are touchscreens. The same tap, as a finger: on a mark it opens the
// passage, off it the page turns. Chromium only, as it stands in for the
// Android WebView.
async function fingerTaps(browser, name) {
  if (name !== "chromium") return;
  const context = await browser.newContext({ serviceWorkers: "block", hasTouch: true, isMobile: true, viewport: { width: 800, height: 1000 } });
  const page = await context.newPage();
  await openBook(page, BOOKS.first);
  await hideChrome(page);
  await page.evaluate(async () => { await document.querySelector("foliate-view").goTo(0); });
  const start = await settled(page);
  // The word saved from the definition sheet.
  const mark = await pointInText(page, "#one-p1", 19);
  await page.touchscreen.tap(mark.x, mark.y);
  await page.locator("#passage-sheet [data-ps-edit]").waitFor();
  assert.deepEqual(await barButtons(page), ["View in journal", "Edit annotation"], `${name}: a finger on a mark did not open its passage`);
  assert.equal(await movedFrom(page, start, 600), false, `${name}: a finger on a mark turned the page`);
  const plain = await pointInText(page, "#one-p0", 300);
  await page.touchscreen.tap(plain.x, plain.y);
  await page.locator("#passage-sheet").waitFor({ state: "hidden" });
  await page.touchscreen.tap(plain.x, plain.y);
  assert.equal(await movedFrom(page, start), true, `${name}: a finger off the mark no longer turns the page`);
  await context.close();
}

// A finger held on the page is making a selection, however it wobbles, drags
// or lets go, and must never turn the page; a swipe still does. Chromium only,
// as above.
async function fingerHolds(browser, name) {
  if (name !== "chromium") return;
  const context = await browser.newContext({ serviceWorkers: "block", hasTouch: true, isMobile: true, viewport: { width: 800, height: 1000 } });
  const page = await context.newPage();
  // A held finger may select a word, which is looked up; any answer will do.
  await page.route("**/api/dictionary/*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notFound: true }) }));
  await openBook(page, BOOKS.first);
  await hideChrome(page);
  await page.evaluate(async () => { await document.querySelector("foliate-view").goTo(0); });
  const start = await settled(page);
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const at = await pointInText(page, "#one-p1", 300);
  // By its own button: a selection the reader holds is not the page's to drop.
  const putAway = async () => {
    await page.evaluate(() => {
      (document.querySelector("#passage-sheet [data-ps-close]") || document.querySelector("#dict-popover:not(.hidden) .dict-close"))?.click();
      document.querySelector("foliate-view").deselect();
    });
    await page.waitForFunction(() => document.querySelector("#passage-sheet").classList.contains("hidden") && document.querySelector("#dict-popover").classList.contains("hidden"));
  };

  // Held, then dragged and let go with a flick of the finger: to a renderer
  // that scrolls with every touch, that is a swipe to the next page.
  await touch("touchStart", at.x, at.y);
  await page.waitForTimeout(650);
  await touch("touchMove", at.x - 30, at.y + 4);
  await touch("touchMove", at.x - 120, at.y + 6);
  await touch("touchEnd");
  assert.equal(await movedFrom(page, start, 1200), false, `${name}: dragging a held finger turned the page`);
  await putAway();

  // Let go a little early, with nothing selected yet: too long for a tap.
  await touch("touchStart", at.x, at.y);
  await page.waitForTimeout(440);
  await touch("touchEnd");
  assert.equal(await movedFrom(page, start, 1200), false, `${name}: a press held almost to the long press turned the page`);
  await putAway();

  // With text selected, a finger that misses the selection handle and drags
  // the page instead is not a swipe either.
  await selectText(page, "#one-p0", 100, 180);
  await touch("touchStart", at.x + 100, at.y);
  await touch("touchMove", at.x - 200, at.y);
  await touch("touchEnd");
  assert.equal(await movedFrom(page, start, 1200), false, `${name}: a drag across the page with text selected turned it`);
  await putAway();

  // A finger's selection is taken over by the reader: the page lets go of its
  // own, and with it the system's handles and its Copy / Share / Select all
  // bar, which would sit on top of the annotation bar. The passage is shown as
  // a highlight instead, and moved by taps.
  const held = () => page.evaluate(() => {
    const doc = document.querySelector("foliate-view").renderer.getContents()[0].doc;
    const set = doc.defaultView.CSS.highlights.get("honlib-selection");
    return { page: doc.getSelection().toString(), reader: set ? [...set].map((r) => r.toString().replace(/\s+/g, " ").trim()) : [] };
  });
  // Not while the finger is still down, though: a press runs on into a drag
  // across the words, and that is the system's to do.
  const finger = (type) => page.evaluate((type) => {
    const doc = document.querySelector("foliate-view").renderer.getContents()[0].doc;
    const touch = new Touch({ identifier: 7, target: doc.body, clientX: 5, clientY: 5 });
    doc.body.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchstart" ? [touch] : [], changedTouches: [touch] }));
  }, type);
  await finger("touchstart");
  await selectText(page, "#one-p0", 17, 33);
  await page.waitForTimeout(300);
  assert.deepEqual(await held(), { page: "Filler text that", reader: [] }, `${name}: the selection was taken from under a finger still on the page`);
  await finger("touchend");
  assert.deepEqual(await held(), { page: "", reader: ["Filler text that"] }, `${name}: a finger's selection was left to the system after it lifted`);
  // A drag stops wherever the finger was; a word cut off at either end is made whole.
  await page.evaluate(() => document.querySelector("#passage-sheet [data-ps-close]").click());
  await selectText(page, "#one-p0", 19, 31);
  assert.deepEqual(await held(), { page: "", reader: ["Filler text that"] }, `${name}: a selection ending mid-word was not rounded out to whole words`);
  const tapWord = async (offset) => {
    const point = await pointInText(page, "#one-p0", offset);
    await page.touchscreen.tap(point.x, point.y);
    return (await held()).reader[0];
  };
  // A tap on a later word stretches it; a tap on a word inside it cuts it short.
  assert.equal(await tapWord(61), "Filler text that exists only to make this section", `${name}: a finger's tap did not move the selection`);
  assert.equal(await tapWord(42), "Filler text that exists only", `${name}: a finger's tap inside the selection did not shorten it`);
  assert.equal(await movedFrom(page, start, 600), false, `${name}: a finger's tap on a word turned the page with text selected`);
  // A finger put down on the end of it and dragged takes the end with it, on
  // and back again.
  const dragEnd = async (from, to) => {
    const a = await pointInText(page, "#one-p0", from), b = await pointInText(page, "#one-p0", to);
    await touch("touchStart", a.x, a.y);
    await touch("touchMove", (a.x + b.x) / 2, (a.y + b.y) / 2);
    await touch("touchMove", b.x, b.y);
    await touch("touchEnd");
    return (await held()).reader[0];
  };
  assert.equal(await dragEnd(44, 61), "Filler text that exists only to make this section", `${name}: dragging the end of the selection did not stretch it`);
  assert.equal(await dragEnd(64, 30), "Filler text that", `${name}: dragging the end of the selection back did not shorten it`);
  assert.equal(await tapWord(61), "Filler text that exists only to make this section");
  assert.equal(await page.locator("#passage-sheet .ps-quote").textContent(), "Filler text that exists only to make this section");
  assert.equal(await movedFrom(page, start, 600), false, `${name}: dragging the selection turned the page`);
  const count = (await journalState()).passages.length;
  await page.locator('[data-ps-new="highlight"]').tap();
  const kept = (await waitForJournal((s) => s.passages.length === count + 1 && s, "the finger's passage")).passages.find((p) => p.text.endsWith("this section"));
  assert.equal(kept?.text, "Filler text that exists only to make this section", `${name}: the passage a finger tapped out was not what was saved`);
  assert.deepEqual((await held()).reader, [], `${name}: the selection was still shown after the passage was made`);
  await page.locator("[data-ps-close]").tap();

  // None of which has cost the swipe.
  await touch("touchStart", at.x + 100, at.y);
  await touch("touchMove", at.x - 200, at.y);
  await touch("touchEnd");
  assert.equal(await movedFrom(page, start), true, `${name}: a swipe no longer turns the page`);
  await context.close();
}

async function runEngine(name, engine) {
  await wipeJournals();
  const book = await libraryBook(BOOKS.first);
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 820, height: 1000 } });
    const page = await context.newPage();
    await openBook(page, BOOKS.first);
    await hideChrome(page);

    const passageId = await captureAndStyle(page, name, book);
    await tagAndNote(page, name);
    await marksShowTheirText(page, name);
    await tapsOnAndOffTheMark(page, name, passageId);
    await sheetsSitBeside(page, name);
    await tapsMoveTheSelection(page, name);
    await passageAcrossPages(page, name);
    const wordId = await saveFromDefinition(page, name);
    await survivesReloadAndDelete(page, name, passageId, wordId);
    await keepsCapturesWithoutAServer(context, page, name);
    await context.close();
    await fingerTaps(browser, name);
    await fingerHolds(browser, name);

    console.log(`${name}: passages are captured, styled, tagged, noted, tapped, deleted and kept without a server`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
