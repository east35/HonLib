// The handful of things the Android shell reaches into this page by name.
//
// The shell is compiled into the APK and cannot be updated over the air, so a
// web change that renames any of these degrades the app on device with no error
// anywhere: the page still loads and looks correct, but the BOOX hardware
// page-turn buttons stop working, or the settings screen becomes unreachable,
// or the refresh button stays live while offline. Recovering from that needs a
// cable, which is exactly what this project is trying to avoid — so the contract
// is asserted here instead of discovered in the field.
//
// Mirrors lib-sdk/honlib/src/main/java/com/readershell/ebook/MainActivity.kt:
// turnPage(), handleExternalNavigation(), OFFLINE_AWARE_REFRESH_JS and
// SHELL_SETTINGS_BUTTON_JS. Change one side and this should fail.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { baseURL, engines, openBook, readState, turnPage } from "./reader-harness.mjs";


const BOOK = "HonLib Split Chapter Test";

// The two scripts the shell evaluates on every page load. Kept verbatim in
// spirit rather than copied byte for byte: what matters is that the elements
// they look for exist and respond the way the shell expects.
async function assertSettingsButton(page, name) {
  const settings = page.locator("#app-settings");
  assert.equal(await settings.count(), 1, `${name}: #app-settings is gone — shell settings unreachable`);
  assert.equal(
    await settings.getAttribute("href"),
    "shell://settings",
    `${name}: #app-settings no longer points at the shell settings URL`,
  );
  // The shell reveals it by clearing both the attribute and the class, because
  // the web app uses one or the other depending on where it is toggled.
  const revealed = await page.evaluate(() => {
    const el = document.getElementById("app-settings");
    el.removeAttribute("hidden");
    el.classList.remove("hidden");
    return getComputedStyle(el).display !== "none";
  });
  assert.ok(revealed, `${name}: clearing hidden/.hidden no longer reveals #app-settings`);
}

async function assertRefreshButton(page, name) {
  const refresh = page.locator("#refresh-library");
  assert.equal(await refresh.count(), 1, `${name}: #refresh-library is gone — cannot be disabled offline`);
  const disablable = await page.evaluate(() => {
    const el = document.getElementById("refresh-library");
    if (!("disabled" in el)) return false;
    el.disabled = true;
    const ok = el.disabled === true;
    el.disabled = false;
    return ok;
  });
  assert.ok(disablable, `${name}: #refresh-library is no longer a disablable control`);
}

async function assertReaderMarker(page, name) {
  // The shell watches #reader to decide whether the settings button belongs on
  // screen, keying off the `hidden` class the app toggles.
  const state = await page.evaluate(() => {
    const el = document.getElementById("reader");
    return { present: !!el, hiddenClassUsed: !!el && !el.classList.contains("hidden") };
  });
  assert.ok(state.present, `${name}: #reader is gone — shell cannot tell reading from browsing`);
  assert.ok(state.hiddenClassUsed, `${name}: #reader no longer drops .hidden while reading`);
}

async function assertPageTurnHook(page, name) {
  const type = await page.evaluate(() => typeof window.ebookTurnPage);
  assert.equal(type, "function", `${name}: window.ebookTurnPage is gone — hardware page-turn keys dead`);

  // Not just present: it has to actually turn the page in both directions, which
  // is the whole reason the shell forwards the volume keys.
  const start = await readState(page);
  const forward = await turnPage(page, "next");
  assert.ok(
    forward.section !== start.section || forward.page !== start.page,
    `${name}: ebookTurnPage('next') did not move the reader`,
  );

  const back = await turnPage(page, "prev");
  assert.deepEqual(
    { section: back.section, page: back.page },
    { section: start.section, page: start.page },
    `${name}: ebookTurnPage('prev') did not come back`,
  );
}

async function runEngine(name, engine) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();

    // Library view first: this is where the shell shows its settings entry.
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await assertSettingsButton(page, name);
    await assertRefreshButton(page, name);

    // Then the reader, where the hardware buttons matter.
    await openBook(page, BOOK);
    await assertReaderMarker(page, name);
    await assertPageTurnHook(page, name);

    await context.close();
    console.log(`${name}: shell contract intact (page-turn hook, settings link, refresh button, reader marker)`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
