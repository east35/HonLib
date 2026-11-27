import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { engines, openBook, settled } from "./reader-harness.mjs";

const BOOK = "HonLib Split Chapter Test";

async function layout(page) {
  await settled(page);
  return page.evaluate(() => {
    const reader = document.querySelector("#reader");
    const renderer = document.querySelector("foliate-view").renderer;
    const doc = renderer.getContents()[0].doc;
    return {
      state: reader.dataset.spread,
      count: renderer.getAttribute("max-column-count"),
      gap: renderer.getAttribute("gap"),
      margin: renderer.getAttribute("margin"),
      pressed: document.querySelector("#reader-spread").getAttribute("aria-pressed"),
      columnWidth: parseFloat(getComputedStyle(doc.documentElement).columnWidth),
      viewWidth: document.querySelector("#epub-viewer").clientWidth,
    };
  });
}

async function runEngine(name, engine) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 700, height: 1000 } });
    const page = await context.newPage();
    await openBook(page, BOOK);

    const topControls = await page.evaluate(() => ({
      backHeight: getComputedStyle(document.querySelector("#reader-hit-back")).height,
      bookmarkEvents: getComputedStyle(document.querySelector("#bookmark-toggle")).pointerEvents,
    }));
    assert.equal(topControls.backHeight, "12px", `${name}: Back still covers the top line`);
    assert.equal(topControls.bookmarkEvents, "none", `${name}: bookmark marker still intercepts a top-line hold`);

    await page.locator("#reader-spread").click();
    let current = await layout(page);
    assert.equal(current.pressed, "true", `${name}: spread preference was not enabled`);
    assert.equal(current.state, "waiting", `${name}: portrait view did not wait for landscape`);
    assert.equal(current.count, "1", `${name}: portrait view opened a second page`);

    await page.setViewportSize({ width: 1200, height: 700 });
    await page.waitForFunction(() => document.querySelector("#reader").dataset.spread === "active");
    current = await layout(page);
    assert.equal(current.count, "2", `${name}: landscape view did not become a spread`);
    assert.equal(current.gap, "3%", `${name}: constrained spread did not halve its gutters`);
    assert.equal(current.margin, "20px", `${name}: constrained spread did not halve its vertical margin`);
    assert.ok(current.columnWidth < current.viewWidth * .7, `${name}: spread still uses a full-width text page`);

    // Fill-width is applied to each half of the spread, not to the spread as a
    // single enormous column.
    await page.locator("#reader-columns").click();
    current = await layout(page);
    assert.equal(current.count, "2", `${name}: fill-width collapsed the spread`);
    assert.equal(current.margin, "16px", `${name}: fill-width spread did not halve its device padding`);
    assert.ok(current.columnWidth < current.viewWidth * .6, `${name}: fill-width did not size each page independently`);

    await page.setViewportSize({ width: 700, height: 1000 });
    await page.waitForFunction(() => document.querySelector("#reader").dataset.spread === "waiting");
    current = await layout(page);
    assert.equal(current.count, "1", `${name}: rotating upright did not return to one page`);

    await context.close();
    console.log(`${name}: spread follows landscape and preserves per-page width controls`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
