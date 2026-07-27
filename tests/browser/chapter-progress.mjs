// Reading progress must follow the book's chapters, not its spine sections.
//
// The fixture's chapter "Two" is split across two spine documents and only the
// first carries a TOC entry (see tests/fixtures/make_split_chapter_epub.py).
// When the reader equated a spine section with a chapter, crossing that split
// dropped the chapter bar from ~100% straight back to 0% and added a book-bar
// segment with no contents entry behind it — a chapter you could not navigate
// back to.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { engines, goToSectionEnd, openBook, turnPage } from "./reader-harness.mjs";


const BOOK = "HonLib Split Chapter Test";

async function runEngine(name, engine) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await openBook(page, BOOK);

    // The book bar gets one segment per chapter. Three TOC entries, so three
    // segments — not the four the four-document spine would produce.
    const segments = await page.locator(".reader-progress-seg").count();
    const tocEntries = await page.locator("#toc-list .toc-item").count();
    assert.equal(tocEntries, 3, `${name}: fixture TOC changed`);
    assert.equal(segments, tocEntries, `${name}: book bar has a segment with no contents entry`);

    // Walk off the end of chapter Two's first spine document.
    const beforeSplit = await goToSectionEnd(page, 1);
    const afterSplit = await turnPage(page);
    assert.equal(afterSplit.section, 2, `${name}: expected the page turn to cross into the split document`);
    assert.ok(
      afterSplit.bar > beforeSplit.bar,
      `${name}: chapter progress reset across the split (${beforeSplit.bar}% -> ${afterSplit.bar}%)`,
    );
    assert.ok(
      afterSplit.bar < 100,
      `${name}: chapter reported complete at the split (${afterSplit.bar}%)`,
    );

    // The contents view still points at "Two" while we read its second half,
    // so the chapter remains reachable from the chapter list.
    const current = await page.evaluate(() => {
      document.querySelector("#toc-toggle").click();
      return [...document.querySelectorAll("#toc-list .toc-item.current")].map((b) => b.textContent);
    });
    assert.deepEqual(current, ["Two"], `${name}: contents view lost track of the split chapter`);
    await page.evaluate(() => document.querySelector("#toc-back").click());

    // Reaching the end of the second document ends the chapter, and the next
    // page starts chapter Three from near zero.
    const chapterEnd = await goToSectionEnd(page, 2);
    assert.ok(chapterEnd.bar > 95, `${name}: chapter never completed (${chapterEnd.bar}%)`);
    const nextChapter = await turnPage(page);
    assert.equal(nextChapter.section, 3, `${name}: expected to land in chapter Three`);
    assert.ok(nextChapter.bar < 50, `${name}: new chapter did not restart (${nextChapter.bar}%)`);

    await context.close();
    console.log(`${name}: split chapter tracked as one chapter across ${segments} segments`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
