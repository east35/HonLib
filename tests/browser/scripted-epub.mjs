import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";


const baseURL = process.env.HONLIB_BASE_URL ?? "http://127.0.0.1:8877";
const engines = process.env.HONLIB_BROWSER
  ? [[process.env.HONLIB_BROWSER, { chromium, webkit }[process.env.HONLIB_BROWSER]]]
  : [["chromium", chromium], ["webkit", webkit]];

async function openProbe(page) {
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.__honlibCspProbe = false;
    window.addEventListener("message", (event) => {
      if (event.data?.type === "honlib-csp-test") {
        window.__honlibCspProbe = true;
      }
    });
  });
  await page.locator('#library .series-card[title="HonLib Scripted EPUB Security Test"]').click();
  await page.locator("#book-actions-modal").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view");
    const doc = view?.renderer?.getContents?.()[0]?.doc;
    return !!doc?.querySelector("#honlib-csp-probe");
  });
  return page.evaluate(async () => {
    const view = document.querySelector("foliate-view");
    const doc = view.renderer.getContents()[0].doc;
    await doc.fonts.ready;
    await doc.fonts.load('16px "HonLibCspProbe"');
    const assetProbe = doc.querySelector("#honlib-csp-assets");
    const image = doc.querySelector("#honlib-csp-image");
    const styles = doc.defaultView.getComputedStyle(assetProbe);
    return {
      probePresent: !!doc.querySelector("#honlib-csp-probe"),
      status: doc.querySelector("#honlib-csp-status")?.textContent,
      messageReceived: window.__honlibCspProbe,
      cssColor: styles.color,
      fontLoaded: doc.fonts.check('16px "HonLibCspProbe"'),
      imageLoaded: image.complete && image.naturalWidth === 32 && image.naturalHeight === 24,
    };
  });
}

function assertAssets(name, result) {
  assert.equal(result.cssColor, "rgb(12, 34, 56)", `${name}: embedded CSS was blocked`);
  assert.equal(result.fontLoaded, true, `${name}: embedded font was blocked`);
  assert.equal(result.imageLoaded, true, `${name}: embedded image was blocked`);
}

async function runEngine(name, engine) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  const browser = await engine.launch({ headless: true });
  try {
    const protectedContext = await browser.newContext({ serviceWorkers: "block" });
    const protectedPage = await protectedContext.newPage();
    const protectedResult = await openProbe(protectedPage);
    assert.equal(protectedResult.probePresent, true, `${name}: probe was removed before CSP could test it`);
    assert.equal(protectedResult.status, "Script did not run", `${name}: EPUB script changed the document`);
    assert.equal(protectedResult.messageReceived, false, `${name}: EPUB script messaged the parent`);
    assertAssets(name, protectedResult);
    await protectedContext.close();

    // Negative control: strip CSP only inside this isolated browser context.
    // The same EPUB must execute, proving the protected test is meaningful.
    const controlContext = await browser.newContext({ serviceWorkers: "block" });
    await controlContext.route(`${baseURL}/**`, async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers["content-security-policy"];
      await route.fulfill({ response, headers });
    });
    const controlPage = await controlContext.newPage();
    const controlResult = await openProbe(controlPage);
    assert.equal(controlResult.probePresent, true, `${name}: control probe missing`);
    assert.equal(controlResult.status, "SCRIPT EXECUTED", `${name}: negative control did not execute`);
    assert.equal(controlResult.messageReceived, true, `${name}: negative control did not reach parent`);
    assertAssets(`${name} negative control`, controlResult);
    await controlContext.close();
    console.log(`${name}: CSP blocked the scripted EPUB; negative control executed`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines) {
  await runEngine(name, engine);
}
