// Progressed books keep maintenance behind an ellipsis menu. Unread covers
// open Read/Remove choices directly, and removal must never feed staging.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { baseURL } from "./reader-harness.mjs";

const browserName = process.env.HONLIB_BROWSER ?? "chromium";
const browserType = { chromium, webkit }[browserName];
if (!browserType) throw new Error(`unsupported browser: ${browserName}`);

const library = await fetch(`${baseURL}/api/library`).then((r) => r.json());
const book = library.books[0];
if (!book) throw new Error("book-actions test needs one fixture book");

await fetch(`${baseURL}/api/progress`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ book_id: book.id, cfi: "epubcfi(/6/2)", percent: 1 }),
});

const browser = await browserType.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: "networkidle" });

  const finishedCard = page.locator("#finished .series-card");
  assert.equal(await finishedCard.count(), 1, "completed book card missing");
  assert.equal(
    await finishedCard.locator("[data-reset], [data-delete]").count(),
    0,
    "legacy inline reset/delete controls are still visible",
  );

  await finishedCard.locator("[data-book-actions]").click();
  const modal = page.locator("#book-actions-modal");
  assert.equal(await modal.isVisible(), true, "ellipsis did not open book options");
  assert.deepEqual(
    await modal.locator(".book-actions-body button").allTextContents(),
    ["Reset progress", "Delete book"],
    "book options changed",
  );

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#book-action-reset").click();
  await modal.waitFor({ state: "hidden" });
  const afterReset = await fetch(`${baseURL}/api/progress`).then((r) => r.json());
  assert.equal(afterReset.books[book.id], undefined, "reset option kept reading progress");

  await page.evaluate(() => localStorage.setItem("ebook-library.libview", JSON.stringify({ view: "table", sort: "series", dir: "asc" })));
  await page.reload({ waitUntil: "networkidle" });
  const libraryRow = page.locator("#library .book-row");
  assert.equal(await libraryRow.count(), 1, "unread book missing from table view");
  assert.equal(await libraryRow.locator("[data-book-actions]").count(), 1, "table overflow button was removed");
  await libraryRow.locator("[data-book-actions]").click();
  assert.deepEqual(
    await modal.locator(".book-actions-body button").allTextContents(),
    ["Reset progress", "Delete book"],
    "table book options changed",
  );
  await modal.locator("[data-close-book-actions]").click();

  await page.evaluate(() => localStorage.setItem("ebook-library.libview", JSON.stringify({ view: "cover", sort: "series", dir: "asc" })));
  await page.reload({ waitUntil: "networkidle" });
  const libraryCard = page.locator("#library .series-card");
  assert.equal(await libraryCard.count(), 1, "reset book did not return to the library");
  assert.equal(
    await libraryCard.locator("[data-book-actions]").count(),
    0,
    "unread cover still has an overflow button",
  );
  await libraryCard.click();
  assert.deepEqual(
    await modal.locator(".book-actions-body button").allTextContents(),
    ["Read", "Remove"],
    "unread cover choices changed",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#book-action-delete").click();
  await page.locator("#library .lib-empty").waitFor({ state: "visible" });

  const afterDelete = await fetch(`${baseURL}/api/library`).then((r) => r.json());
  const staging = await fetch(`${baseURL}/api/staging`).then((r) => r.json());
  assert.equal(afterDelete.books.length, 0, "delete option kept the EPUB in the library");
  assert.deepEqual(staging.items, [], "deleted EPUB was moved into staging");
  await context.close();
} finally {
  await browser.close();
}

console.log(`${browserName}: book actions passed`);
