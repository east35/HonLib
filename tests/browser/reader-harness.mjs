// Shared plumbing for the reader browser tests: open a book and drive it a page
// at a time, without racing the renderer.
export const baseURL = process.env.HONLIB_BASE_URL ?? "http://127.0.0.1:8877";

export function engines(all) {
  return process.env.HONLIB_BROWSER
    ? [[process.env.HONLIB_BROWSER, all[process.env.HONLIB_BROWSER]]]
    : Object.entries(all);
}

// Where the reader is, and the chapter bar as the UI actually paints it. The
// paginator keeps its section index private, so read the one foliate publishes
// on `lastLocation`.
// `renderer.page`/`pages` read the paginator's internal view, which throws while
// a section is still being laid out — the same hazard app.js guards against.
export function readState(page) {
  return page.evaluate(() => {
    const view = document.querySelector("foliate-view");
    const read = (key) => { try { return view.renderer[key]; } catch { return -1; } };
    return {
      section: view?.lastLocation?.section?.current ?? -1,
      page: read("page"),
      pages: read("pages"),
      bar: parseFloat(document.querySelector("#reader-progress-fill").style.width) || 0,
    };
  });
}

// A navigation can emit several relocations before it comes to rest, and layout
// is still settling right after the book opens. Sample until two consecutive
// reads agree so a test never asserts against a position the reader is still
// moving away from.
export async function settled(page) {
  let last = await readState(page);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100);
    const next = await readState(page);
    if (next.section === last.section && next.page === last.page && next.pages === last.pages) return next;
    last = next;
  }
  throw new Error("reader never settled");
}

export async function openBook(page, title) {
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.locator(`#library .series-card[title="${title}"]`).click();
  await page.locator("#reader-loading").waitFor({ state: "hidden" });
  await page.waitForFunction(() => {
    try { return document.querySelector("foliate-view")?.renderer?.pages > 0; } catch { return false; }
  });
  return settled(page);
}

// A page turn can carry us across a spine section, which resets the page number
// to 1 — so "did anything move?" has to consider both.
export async function turnPage(page, dir = "next") {
  const before = await readState(page);
  await page.evaluate((d) => window.ebookTurnPage(d), dir);
  await page.waitForFunction(
    (b) => {
      const view = document.querySelector("foliate-view");
      let page;
      try { page = view.renderer.page; } catch { return false; }
      return view.lastLocation?.section?.current !== b.section || page !== b.page;
    },
    before,
  );
  return settled(page);
}

export async function goToSectionEnd(page, index) {
  await page.evaluate(async (i) => {
    const view = document.querySelector("foliate-view");
    await view.goTo(i);
    await view.renderer.goTo({ index: i, anchor: 1 });
  }, index);
  return settled(page);
}
