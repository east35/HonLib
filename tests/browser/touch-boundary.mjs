// One touch, one owner. A touch on the reader is either HonLib's (a tap turns
// the page, a hold selects) or Foliate's (a swipe), and never both. When both
// act on the same touch at the final page of a chapter, each starts its own
// move into the next chapter, both replace the iframe, and the reader stops
// turning pages. The last page of a chapter is where that shows, as a section
// loaded more than once, so every kind of touch is tried there.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { goToSectionEnd, openBook, readState, settled } from "./reader-harness.mjs";

const BOOK = "HonLib Split Chapter Test";

// This regression models Android WebView with Chromium's touch/CDP APIs. The
// CI matrix installs one browser per job, so the WebKit job must not try to
// launch a Chromium executable it deliberately did not install.
if (process.env.HONLIB_BROWSER && process.env.HONLIB_BROWSER !== "chromium") {
  console.log(`${process.env.HONLIB_BROWSER}: touchscreen boundary regression covered by chromium`);
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    serviceWorkers: "block",
    hasTouch: true,
    isMobile: true,
    viewport: { width: 800, height: 1000 },
  });
  const page = await context.newPage();
  // A held word is looked up; the dictionary is a third-party service.
  await page.route("**/api/dictionary/*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notFound: true }) }));
  const cdp = await context.newCDPSession(page);
  const touch = (type, ...points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  await openBook(page, BOOK);

  // Every section load is counted, so a second move into a chapter is seen
  // wherever it comes from.
  await page.evaluate(() => {
    window.__sectionLoads = 0;
    for (const section of document.querySelector("foliate-view").book.sections) {
      const load = section.load;
      section.load = function (...args) {
        window.__sectionLoads += 1;
        return load.apply(this, args);
      };
    }
  });
  const loads = () => page.evaluate(() => window.__sectionLoads);
  // Section 2 is the final spine document in chapter Two.
  const toBoundary = async () => {
    // The renderer ignores navigation for a moment after a page turn.
    await settled(page);
    await page.waitForTimeout(200);
    assert.equal((await goToSectionEnd(page, 2)).section, 2, "test setup: not at the end of chapter Two");
    await page.evaluate(() => {
      document.querySelector("#reader").classList.add("chrome-hidden");
      window.__sectionLoads = 0;
    });
  };
  const entersNextChapter = async (what) => {
    await page.waitForFunction(() => document.querySelector("foliate-view")?.lastLocation?.section?.current === 3);
    assert.equal((await settled(page)).section, 3, `${what} did not enter the next chapter`);
    assert.equal(await loads(), 1, `${what} started more than one section load`);
  };
  // `here` is where the reader was before the touch.
  const staysPut = async (what, here) => {
    await page.waitForTimeout(1200);
    const now = await settled(page);
    assert.deepEqual([now.section, now.page], [here.section, here.page], `${what} turned the page`);
    assert.equal(await loads(), 0, `${what} loaded a section`);
  };
  // A point on the text, and one on a word a little further on.
  const points = () => page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const viewer = document.querySelector("#epub-viewer").getBoundingClientRect();
    const visible = view.lastLocation.range, doc = visible.startContainer.ownerDocument;
    const frame = doc.defaultView.frameElement.getBoundingClientRect();
    // The words on the page: a chapter's last page may hold only a few lines.
    const words = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!visible.intersectsNode(node)) continue;
      for (const match of node.data.matchAll(/[A-Za-z]{4,}/g)) {
        const range = doc.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (range.getClientRects().length !== 1) continue;
        const rect = range.getClientRects()[0];
        const x = frame.left + rect.left + rect.width / 2, y = frame.top + rect.top + rect.height / 2;
        if (x > viewer.left + 40 && x < viewer.right - 40 && y > viewer.top + 80 && y < viewer.bottom - 80) words.push([x, y]);
      }
    }
    const at = (n) => words[Math.min(n, words.length - 1)];
    return {
      text: [viewer.left + viewer.width * 0.6, viewer.top + viewer.height * 0.5],
      // Beside the text: inside the viewer, outside the page and the edge zones.
      margin: [viewer.left + viewer.width * 0.955, viewer.top + viewer.height * 0.5],
      word: at(4),
      later: at(18),
    };
  });

  // A stationary tap on the text: the original fault.
  await toBoundary();
  let at = await points();
  await page.touchscreen.tap(...at.text);
  await entersNextChapter("a touchscreen tap");

  // A normal follow-up request must still move, proving the duplicate iframe
  // replacement did not leave the reader unresponsive.
  const beforeFollowup = await readState(page);
  await page.evaluate(() => window.ebookTurnPage("next"));
  await page.waitForFunction(
    (before) => {
      const view = document.querySelector("foliate-view");
      let currentPage;
      try { currentPage = view.renderer.page; } catch { return false; }
      return view.lastLocation?.section?.current !== before.section || currentPage !== before.page;
    },
    beforeFollowup,
  );

  // A tap in the margin beside the text reaches Foliate through the viewer
  // rather than the book document. It is still one tap.
  await toBoundary();
  at = await points();
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, at.margin), "FOLIATE-VIEW", "test setup: the margin point is not on the viewer's margin");
  await page.touchscreen.tap(...at.margin);
  await entersNextChapter("a tap in the margin");

  // Two fingers are not a tap. They are left to the renderer, which stays on
  // the page; the first finger's lift must not turn it as well.
  await toBoundary();
  at = await points();
  let here = await readState(page);
  await touch("touchStart", at.text, [at.text[0] + 80, at.text[1] + 40]);
  await touch("touchEnd");
  await staysPut("a two-finger tap", here);
  await page.touchscreen.tap(...at.text);
  await entersNextChapter("a tap after a two-finger tap");

  // A finger held on a word selects it and turns nothing; nor does the tap
  // that then moves the selection, nor the lift that ends a drag of it. Tried
  // one page back from the chapter's end, where the page is sure to be full of
  // words to select: a turn from there would show as a change of page.
  await toBoundary();
  await page.evaluate(() => window.ebookTurnPage("prev"));
  here = await settled(page);
  await page.evaluate(() => { window.__sectionLoads = 0; });
  at = await points();
  await touch("touchStart", at.word);
  await page.waitForTimeout(550);
  await touch("touchEnd");
  await page.waitForFunction(() => !document.querySelector("#dict-popover").classList.contains("hidden") || !document.querySelector("#passage-sheet").classList.contains("hidden"));
  await staysPut("a finger held on a word", here);
  await page.touchscreen.tap(...at.later);
  await page.locator("#passage-sheet [data-ps-new]").first().waitFor();
  await staysPut("a tap that moved the selection", here);
  await touch("touchStart", at.later);
  await touch("touchMove", [(at.later[0] + at.word[0]) / 2, (at.later[1] + at.word[1]) / 2]);
  await touch("touchMove", at.word);
  await touch("touchEnd");
  await staysPut("a drag of the selection", here);
  // With the selection put away, the page turns as it did before: one tap to
  // the chapter's last page, and one more into the next chapter, loaded once.
  // (Dragged back to the word it began on, the selection is a single word
  // again, and its sheet the definition.)
  const putAway = () => page.evaluate(() => {
    (document.querySelector("#passage-sheet [data-ps-close]") || document.querySelector("#dict-popover:not(.hidden) .dict-close"))?.click();
  });
  await putAway();
  await page.waitForFunction(() => document.querySelector("#dict-popover").classList.contains("hidden") && document.querySelector("#passage-sheet").classList.contains("hidden"));
  await page.touchscreen.tap(...at.text);
  await page.waitForFunction((before) => document.querySelector("foliate-view").renderer.page === before + 1, here.page);
  assert.deepEqual([(await settled(page)).section, await loads()], [2, 0], "a tap after selecting did not turn one page within the chapter");
  await page.touchscreen.tap(...at.text);
  await entersNextChapter("a second tap after selecting");

  // A hold let go the moment it comes due is a selection or a tap, not both.
  await toBoundary();
  at = await points();
  await touch("touchStart", at.word);
  await page.waitForTimeout(390);
  await touch("touchEnd");
  await page.waitForTimeout(1500);
  const after = await settled(page);
  assert.ok(await loads() <= 1, `a press let go as the hold came due started ${await loads()} section loads`);
  assert.ok(after.section === 2 || (await loads()) === 1, "a press let go as the hold came due moved without loading the chapter once");

  // A moved touch remains Foliate-owned. None of the above may remove swiping.
  await toBoundary();
  at = await points();
  await putAway();
  const beforeSwipe = await readState(page);
  await touch("touchStart", [at.text[0] + 120, at.text[1]]);
  await touch("touchMove", [at.text[0] - 180, at.text[1]]);
  await touch("touchEnd");
  await page.waitForFunction(
    (before) => {
      const view = document.querySelector("foliate-view");
      let currentPage;
      try { currentPage = view.renderer.page; } catch { return false; }
      return view.lastLocation?.section?.current !== before.section || currentPage !== before.page;
    },
    beforeSwipe,
  );
  await settled(page);
  assert.ok(await loads() <= 1, `a swipe started ${await loads()} section loads`);

  await context.close();
  console.log("chromium: every kind of touch at a chapter's last page has one owner; taps, holds, buttons and swipes remain responsive");
} finally {
  await browser.close();
}
