// A stationary touchscreen tap at the final page of a chapter must initiate
// exactly one section transition. Foliate's paginator also listens for
// touchend inside the EPUB document; if it handles the same tap as HonLib's
// pointer-based page turn, both transitions replace the iframe concurrently.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { goToSectionEnd, openBook, readState, settled } from "./reader-harness.mjs";

const BOOK = "HonLib Split Chapter Test";

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    serviceWorkers: "block",
    hasTouch: true,
    isMobile: true,
    viewport: { width: 800, height: 1000 },
  });
  const page = await context.newPage();
  await openBook(page, BOOK);

  // Section 2 is the final spine document in chapter Two. Instrument the next
  // section at the publication boundary so duplicate loads are observable.
  await goToSectionEnd(page, 2);
  await page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const section = view.book.sections[3];
    const load = section.load;
    window.__touchBoundaryLoads = 0;
    section.load = function (...args) {
      window.__touchBoundaryLoads += 1;
      return load.apply(this, args);
    };
    document.querySelector("#reader").classList.add("chrome-hidden");
  });

  const target = await page.evaluate(() => {
    const viewer = document.querySelector("#epub-viewer").getBoundingClientRect();
    return { x: viewer.left + viewer.width * 0.6, y: viewer.top + viewer.height * 0.5 };
  });
  await page.touchscreen.tap(target.x, target.y);
  await page.waitForFunction(() => document.querySelector("foliate-view")?.lastLocation?.section?.current === 3);
  const afterBoundary = await settled(page);
  assert.equal(afterBoundary.section, 3, "touch tap did not enter the next chapter");
  assert.equal(
    await page.evaluate(() => window.__touchBoundaryLoads),
    1,
    "one touchscreen tap started more than one section load",
  );

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

  // A moved touch remains Foliate-owned. The fix must not remove swiping.
  const beforeSwipe = await readState(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: target.x + 120, y: target.y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: target.x - 180, y: target.y }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(
    (before) => {
      const view = document.querySelector("foliate-view");
      let currentPage;
      try { currentPage = view.renderer.page; } catch { return false; }
      return view.lastLocation?.section?.current !== before.section || currentPage !== before.page;
    },
    beforeSwipe,
  );

  await context.close();
  console.log("chromium: touchscreen boundary loads once; taps, buttons, and swipe remain responsive");
} finally {
  await browser.close();
}
