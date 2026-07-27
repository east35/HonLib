// A device must be told when it is running stale code.
//
// The Android shell downloads a new web bundle in the background but only swaps
// it in at a cold start, and Android decides when a backgrounded app's process
// actually dies. Without a prompt the wait is invisible and open-ended: a user
// can read known-broken code for days after the fix shipped. The app compares
// the build stamped into the bundle it was served with the one the manifest
// offers, and asks for a restart when they differ.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { baseURL, engines } from "./reader-harness.mjs";


// Stand in for a bundle-served app. The returned object is live: change it to
// move the device between "up to date" and "stale" without dropping the browser
// context, so the per-build dismissal memory stays in play.
async function installBuildIds(context, initial) {
  const state = { ...initial };
  await context.route((url) => url.pathname === "/build-id.json", (route) =>
    state.running === null
      // A plain browser has no bundle to stamp, so this 404s there.
      ? route.fulfill({ status: 404, contentType: "text/plain", body: "" })
      : route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ buildId: state.running }),
      }));
  await context.route((url) => url.pathname === "/api/app-bundle/manifest", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, appId: "honlib", buildId: state.offered }),
    }));
  return state;
}

// Load the library and report whether the restart prompt is up. The check is
// fire-and-forget at startup, so give it a moment to resolve either way.
async function loadAndCheck(context) {
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  return { page, visible: await page.locator("#app-update").isVisible() };
}

async function runEngine(name, engine) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const state = await installBuildIds(context, { running: "build-a", offered: "build-a" });

    // Up to date: nothing to say.
    let seen = await loadAndCheck(context);
    assert.equal(seen.visible, false, `${name}: nagged about an update that isn't there`);
    await seen.page.close();

    // A new bundle is waiting.
    state.offered = "build-b";
    seen = await loadAndCheck(context);
    assert.equal(seen.visible, true, `${name}: never told the reader an update was waiting`);

    // Deferring hides it, and it stays hidden for that build across restarts —
    // a prompt that reappears every launch just gets ignored.
    await seen.page.locator("#app-update-dismiss").click();
    assert.equal(
      await seen.page.locator("#app-update").isVisible(),
      false,
      `${name}: could not defer the notice`,
    );
    await seen.page.close();
    seen = await loadAndCheck(context);
    assert.equal(seen.visible, false, `${name}: re-nagged about a deferred build`);
    await seen.page.close();

    // But deferring one update must never swallow the next.
    state.offered = "build-c";
    seen = await loadAndCheck(context);
    assert.equal(seen.visible, true, `${name}: a deferred update suppressed a later one`);
    await seen.page.close();
    await context.close();

    // A plain browser has no bundle and no restart to perform, so it is never
    // asked to do one — a reload there already gets the latest code.
    const browserCtx = await browser.newContext({ serviceWorkers: "block" });
    await installBuildIds(browserCtx, { running: null, offered: "build-c" });
    seen = await loadAndCheck(browserCtx);
    assert.equal(seen.visible, false, `${name}: showed a restart prompt to a browser`);
    await seen.page.close();
    await browserCtx.close();

    console.log(`${name}: restart prompt appears only for a stale bundle, and only once per build`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
