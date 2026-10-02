// Journals: where a highlight is filed, what the journal shows, and how it
// follows other devices.
//
//   - a book no journal covers asks once where to collect it, by book, series
//     or author; declining leaves the passage in Unfiled and never asks again;
//   - a series source covers the other volumes with no prompt;
//   - the journal view searches and filters, and says why a passage has come
//     adrift (source off, book missing);
//   - enabling a source with passages already made asks whether to bring them in;
//   - an open journal picks up a passage written elsewhere within moments.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import { baseURL, engines, openBook } from "./reader-harness.mjs";
import { BOOKS, cardMenu, hideChrome, journalState, libraryBook, putDoc, selectText, sheetOpen, waitForJournal, wipeJournals } from "./journal-harness.mjs";

async function closeBook(page) {
  // The button lives in the reading menu, which these tests keep out of the way.
  await page.evaluate(() => document.querySelector("#reader-close").click());
  await page.locator("#reader").waitFor({ state: "hidden" });
}
async function highlight(page, selector, start, end) {
  await selectText(page, selector, start, end);
  await page.locator('[data-ps-new="highlight"]').click();
}
async function shelf(page) {
  return page.locator("#journals .journal-card").evaluateAll((cards) =>
    cards.map((c) => [c.querySelector(".journal-cover-name").textContent, c.querySelector(".journal-cover-count").textContent]));
}
async function cards(page) {
  return page.locator("#journal-cards .passage-card").evaluateAll((list) => list.map((c) => ({
    quote: c.querySelector(".passage-quote").textContent,
    meta: c.querySelector(".passage-meta").textContent,
    state: c.querySelector(".passage-state")?.textContent || "",
    visitDisabled: c.querySelector('[data-act="visit"]').disabled,
  })));
}
function card(page, text) {
  return page.locator("#journal-cards .passage-card", { hasText: text });
}

// A journal is on the Journals shelf and on the shelf it belongs to in the table
// layout as well as the cover one, and wherever results are grouped by series.
async function setLayout(page, view) {
  await page.evaluate((v) => localStorage.setItem("ebook-library.libview", JSON.stringify({ view: v, sort: "series", dir: "asc" })), view);
  await page.reload({ waitUntil: "networkidle" });
}
async function shelvesInEveryLayout(page, name) {
  await setLayout(page, "table");
  await page.locator("#journals .journal-row").first().waitFor();
  assert.deepEqual(
    await page.locator("#journals .journal-row").evaluateAll((rows) => rows.map((r) => [r.querySelector(".row-title").textContent, r.querySelector(".row-status").textContent])),
    [["My First Journal", "1 passage"]],
    `${name}: Journals shelf is not a table in the table layout`,
  );
  assert.equal(await page.locator("#journals .journal-card").count(), 0, `${name}: table layout still shows journal covers`);
  const onShelf = page.locator('#library .book-group[data-group="Wayfarers"] .journal-row');
  assert.equal(await onShelf.count(), 1, `${name}: journal is missing from its shelf in the table layout`);
  assert.equal(await page.locator('#library .book-group[data-group="Library"] .journal-row').count(), 0, `${name}: journal appeared on a shelf it does not belong to`);
  await onShelf.click();
  assert.equal(await page.locator("#journal-title").textContent(), "My First Journal", `${name}: a journal's table row does not open it`);
  await page.locator("#journal-back").click();

  // A search keeps the series grouping, and the journal stays with its shelf.
  const search = async (text) => page.evaluate((value) => {
    const input = document.querySelector("#lib-search");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await search("volume");
  await page.locator('#flat-results .book-group[data-group="Wayfarers"] .journal-row').waitFor();
  await setLayout(page, "cover");
  await search("volume");
  await page.locator('#flat-results .book-group[data-group="Wayfarers"] .journal-card').waitFor();
  assert.equal(await page.locator("#journals-section").isVisible(), false);
  await search("");
  await page.locator('#library .book-group[data-group="Wayfarers"] .journal-card').waitFor();
}

// The very first highlight makes "My First Journal" for its book. That journal
// does not cover the next volume, so highlighting there asks.
async function filing(page, name) {
  await openBook(page, BOOKS.first);
  await hideChrome(page);
  await highlight(page, "#one-p0", 17, 60);
  await page.locator("[data-ps-close]").click();
  await closeBook(page);
  assert.deepEqual(await shelf(page), [["My First Journal", "1 passage"]], `${name}: first journal is not on the home shelf`);
  // Its only source is a book in the Wayfarers folder, so it sits on that shelf too.
  assert.equal(
    await page.locator('#library .book-group[data-group="Wayfarers"] .journal-card').count(), 1,
    `${name}: journal is not on the shelf its sources belong to`,
  );

  await shelvesInEveryLayout(page, name);

  await openBook(page, BOOKS.second);
  await hideChrome(page);
  await highlight(page, "#one-p0", 17, 60);
  const lead = page.locator("#passage-sheet .filing-lead");
  assert.equal(await lead.textContent(), "Saved. Add this book to a journal?", `${name}: an uncovered book did not offer a journal`);
  // Already saved, and waiting in Unfiled, whatever is answered.
  await waitForJournal((s) => s.passages.length === 2 && s.passages.some((p) => p.journals.length === 0), "the unfiled passage");
  assert.deepEqual(
    await page.locator("#passage-sheet [data-scope]").allTextContents(),
    ["This book", "Series: Wayfarers", "Author: Ann Author"],
    `${name}: filing scopes changed`,
  );
  await page.locator('#passage-sheet [data-scope="series"]').click();
  page.once("dialog", (dialog) => {
    assert.equal(dialog.defaultValue(), "Wayfarers", `${name}: new journal is not named after the series`);
    dialog.accept("Wayfarers notes");
  });
  await page.locator("#passage-sheet [data-file-new]").click();
  // The series source also matches the first volume's passage, made before the
  // journal existed: asked once, for the whole series.
  const ask = page.locator("#passage-sheet .journal-ask");
  assert.equal(await ask.locator("p").textContent(), "Bring in the 1 existing passage, or start fresh?", `${name}: existing passages were not offered`);
  await ask.locator('[data-answer="fresh"]').click();
  const state = await waitForJournal((s) => s.journals.length === 2 && s.passages.every((p) => p.journals.length === 1), "the new journal");
  const series = state.journals.find((j) => j.name === "Wayfarers notes");
  assert.deepEqual(series.sources, [{ type: "series", name: "Wayfarers", enabled: true }], `${name}: journal did not take the series as its source`);
  assert.equal(state.passages.filter((p) => p.journals.includes(series.id)).length, 1, `${name}: "start fresh" brought the old passage in anyway`);
  // The sheet moves on to the tool that was tapped.
  assert.equal(await page.locator('#passage-sheet [data-ps-tool="highlight"]').getAttribute("aria-pressed"), "true");
  await page.locator("[data-ps-close]").click();
  await closeBook(page);

  // Back in the first volume: now covered by both journals, so no prompt, and
  // the highlight lands in each.
  await openBook(page, BOOKS.first);
  await hideChrome(page);
  await highlight(page, "#one-p1", 17, 60);
  assert.equal(await page.locator("#passage-sheet .filing-lead").count(), 0, `${name}: a covered book still asked where to file`);
  assert.equal(await page.locator("#passage-sheet .ps-status").textContent(), "In My First Journal, Wayfarers notes");
  await waitForJournal((s) => s.passages.some((p) => p.journals.length === 2), "the passage in both journals");
  // Both by default, but each passage can be kept out of one of them.
  const journalsTool = page.locator('#passage-sheet [data-ps-tool="journals"]');
  assert.equal(await journalsTool.textContent(), "Journals (2)", `${name}: a passage in two journals does not offer the choice between them`);
  await journalsTool.click();
  const inFirst = page.locator("#passage-sheet .journals-tool [data-journal-toggle]", { hasText: "My First Journal" });
  assert.equal(await inFirst.getAttribute("aria-pressed"), "true");
  await inFirst.click();
  assert.equal(await page.locator("#passage-sheet .ps-status").textContent(), "In Wayfarers notes", `${name}: the passage was not taken out of the one journal`);
  assert.equal(await journalsTool.textContent(), "Journals (1)");
  await waitForJournal((s) => !s.passages.some((p) => p.journals.length === 2), "the passage in one journal only");
  // The book is still a source of both: the next highlight goes into each again.
  await inFirst.click();
  assert.equal(await page.locator("#passage-sheet .ps-status").textContent(), "In Wayfarers notes, My First Journal");
  await waitForJournal((s) => s.passages.some((p) => p.journals.length === 2), "the passage back in both journals");
  await page.locator("[data-ps-close]").click();
  await closeBook(page);
  return series;
}

async function unfiledTray(page, name) {
  await openBook(page, BOOKS.split);
  await hideChrome(page);
  await highlight(page, "#one-p0", 17, 60);
  assert.deepEqual(
    await page.locator("#passage-sheet [data-scope]").allTextContents(),
    ["This book", "Author: HonLib Test Suite"],
    `${name}: a book with no series offered one`,
  );
  await page.locator("#passage-sheet [data-file-skip]").click();
  assert.equal(await page.locator("#passage-sheet .ps-status").textContent(), "Unfiled");
  await page.locator("[data-ps-close]").click();
  // Declined once: this book never asks again.
  await highlight(page, "#one-p1", 17, 60);
  assert.equal(await page.locator("#passage-sheet .filing-lead").count(), 0, `${name}: the filing prompt came back for a declined book`);
  await page.locator("[data-ps-close]").click();
  await closeBook(page);
  await waitForJournal((s) => s.passages.filter((p) => p.journals.length === 0).length === 2, "two unfiled passages");

  assert.deepEqual((await shelf(page)).at(-1), ["Unfiled", "2 passages"], `${name}: unfiled passages have no tray on the shelf`);
  await page.locator("#journals .journal-card.unfiled").click();
  assert.equal(await page.locator("#journal-title").textContent(), "Unfiled");
  assert.equal(await page.locator("#journal-settings-toggle").isVisible(), false, `${name}: the tray has no settings`);
  assert.equal(await page.locator("#journal-cards .passage-card").count(), 2);
  const first = page.locator("#journal-cards .passage-card").first();
  // In the tray the menu files a passage rather than removing it.
  assert.deepEqual(
    await first.locator(".passage-menu [data-act]").allTextContents(),
    ["Add to clipboard", "View in book", "Add to journal", "Delete passage"],
    `${name}: the tray's passage menu changed`,
  );
  await cardMenu(first, "file");
  await first.locator('.passage-tool [data-journal-toggle]', { hasText: "My First Journal" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#journal-cards .passage-card").length === 1);
  await waitForJournal((s) => s.passages.filter((p) => p.journals.length === 0).length === 1, "one passage filed from the tray");
  await page.locator("#journal-back").click();
  assert.deepEqual((await shelf(page)).at(-1), ["Unfiled", "1 passage"]);
}

async function journalView(page, name, series) {
  const second = await libraryBook(BOOKS.second);
  // A passage whose book has left the library, as another device captured it.
  const orphan = randomUUID();
  const now = new Date().toISOString();
  await putDoc("passages", {
    v: 1, id: orphan, created: now, updated: now, device: "another-device", deleted: false,
    text: "A line from a book that was later removed.", context: { before: "", after: "" },
    note: "kept for the turn of phrase", tags: ["Orphans"], style: { highlight: "pink", underline: "double" }, journals: [series.id],
    source: { book_key: "id:gone", book_id: "0000", title: "Removed Book", author: "Ann Author", series: "Wayfarers", series_index: 3, chapter: "Nine", cfi: "epubcfi(/6/2!/4/2,/1:0,/1:5)", percent: 0.5 },
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#journals .journal-card", { hasText: "Wayfarers notes" }).click();
  await page.locator("#journal-cards .passage-card").first().waitFor();
  assert.equal(await page.locator("#journal-title").textContent(), "Wayfarers notes");
  assert.equal(await page.locator("#journal-count").textContent(), "3 Passages");
  let list = await cards(page);
  const missing = list.find((c) => c.quote.startsWith("A line from a book"));
  assert.equal(missing.state, "Book missing", `${name}: a passage whose book is gone is not marked`);
  assert.equal(missing.visitDisabled, true, `${name}: a missing book can still be visited`);
  // The colour is named on the passage, not only shown.
  assert.match(missing.meta, /Pink highlight, Double underline/, `${name}: colour name missing from the card`);
  assert.equal(await card(page, "A line from a book").locator(".passage-note").textContent(), "kept for the turn of phrase");

  // Search and filters work on the local copy.
  await page.locator("#journal-search").fill("turn phrase");
  await page.waitForFunction(() => document.querySelectorAll("#journal-cards .passage-card").length === 1);
  assert.equal(await page.locator("#journal-count").textContent(), "1 of 3 Passages");
  await page.locator("#journal-search").fill("");
  await page.waitForFunction(() => document.querySelectorAll("#journal-cards .passage-card").length === 3);
  await page.locator("#journal-filter-tag").selectOption("Orphans");
  assert.equal(await page.locator("#journal-cards .passage-card").count(), 1);
  await page.locator("#journal-filter-tag").selectOption("");
  await page.locator("#journal-filter-style").selectOption("u:double");
  assert.equal(await page.locator("#journal-cards .passage-card").count(), 1);
  await page.locator("#journal-filter-style").selectOption("");
  await page.locator("#journal-filter-book").selectOption(second.key);
  assert.equal(await page.locator("#journal-cards .passage-card").count(), 1);
  await page.locator("#journal-filter-book").selectOption("");

  await cardLayout(page, name);

  // The passage's own parts are its controls. "Add Tag" sits where a tag would.
  const target = card(page, "Filler text").first();
  assert.deepEqual(await target.locator(".passage-tags button").allTextContents(), ["Add Tag", "Add Note"], `${name}: a bare passage should offer a tag and a note, where they would be`);
  await target.locator('[data-act="tags"]').click();
  await target.locator(".tag-form input").fill("wayfaring");
  await target.locator(".tag-form button").click();
  // A tag already used in this journal is offered before anything is typed.
  assert.deepEqual(await target.locator("[data-tag-add]").allTextContents(), ["Orphans"], `${name}: journal's own tags are not suggested`);
  await target.locator(".tag-form input").fill("mistake");
  await target.locator(".tag-form button").click();
  // A tag comes off where it is shown.
  await target.locator('.passage-tags [data-act="untag"][data-tag="mistake"]').click();
  // "Add Note" until there is a note; then the note itself opens for editing.
  await target.locator('[data-act="note"]').click();
  await target.locator(".note-tool textarea").fill("Written in the journal.");
  await target.locator(".note-tool button").click();
  await target.locator(".passage-note").waitFor();
  assert.equal(await target.locator(".passage-note .passage-edit").getAttribute("aria-label"), "Edit note", `${name}: a note is not offered for editing`);
  assert.deepEqual(await target.locator(".passage-tags button").allTextContents(), ["wayfaring", "Add Tag"], `${name}: "Add Note" is still offered beside a note`);
  await target.locator(".passage-note").click();
  assert.equal(await target.locator(".note-tool textarea").inputValue(), "Written in the journal.", `${name}: tapping the note did not open it`);
  await page.keyboard.press("Escape");
  // Tapping the highlight edits its style.
  await target.locator('[data-act="style"]').click();
  await target.locator('.ps-option[data-style-value="orange"]').click();
  await waitForJournal((s) => s.passages.some((p) => p.note === "Written in the journal." && p.tags.join() === "wayfaring" && p.style.highlight === "orange"), "card edits");
  assert.match(await target.locator(".passage-meta").textContent(), /Orange highlight/);
  await page.keyboard.press("Escape");

  // Settings: turning the source off stops capture but keeps what was collected,
  // and those passages say so.
  // Settings open in the library's drawer: a panel at the side, over a scrim.
  const drawer = page.locator("#journal-drawer");
  const closeDrawer = page.locator("#journal-drawer .drawer-head [data-close-journal-drawer]");
  await page.locator("#journal-settings-toggle").click();
  assert.equal(await drawer.locator(".drawer-panel #journal-settings.drawer-body").isVisible(), true, `${name}: journal settings are not in a drawer`);
  const panel = await drawer.locator(".drawer-panel").boundingBox();
  assert.ok(Math.abs(panel.x + panel.width - 820) < 1 && panel.width <= 360, `${name}: the settings drawer is not at the side of the screen`);
  // The scrim closes it, as it does the library's.
  await drawer.locator(".drawer-scrim").click({ position: { x: 20, y: 400 } });
  assert.equal(await drawer.isVisible(), false, `${name}: the scrim did not close journal settings`);
  await page.locator("#journal-settings-toggle").click();
  const sourceToggle = page.locator("#journal-settings [data-source-toggle]");
  assert.equal(await sourceToggle.textContent(), "On");
  await sourceToggle.click();
  await waitForJournal((s) => s.journals.find((j) => j.id === series.id).sources[0].enabled === false, "source off");
  await closeDrawer.click();
  list = await cards(page);
  assert.equal(list.length, 3, `${name}: turning a source off removed its passages`);
  assert.deepEqual(list.map((c) => c.state).sort(), ["Book missing", "Source off", "Source off"], `${name}: unlinked states are wrong`);
  await page.locator("#journal-filter-state").selectOption("source-off");
  assert.equal(await page.locator("#journal-cards .passage-card").count(), 2);
  await page.locator("#journal-filter-state").selectOption("");

  // Turning it back on finds the first volume's older passage outside the
  // journal and asks about it.
  await page.locator("#journal-settings-toggle").click();
  await sourceToggle.click();
  const ask = page.locator("#journal-settings .journal-ask");
  assert.equal(await ask.locator("p").textContent(), "Bring in the 1 existing passage, or start fresh?");
  await ask.locator('[data-answer="bring"]').click();
  await page.waitForFunction(() => document.querySelector("#journal-count").textContent === "4 Passages");
  await waitForJournal((s) => s.passages.filter((p) => p.journals.includes(series.id)).length === 4, "passages brought in");

  // The drawer is a label and one control to a field: a source is a line with
  // its switch, a tag a line with its menu, and one list adds a source.
  assert.equal(await page.locator("#journal-settings select").count(), 1, `${name}: journal settings grew more than the one list`);
  assert.equal(await page.locator("#journal-settings .journal-list li").evaluateAll((rows) => rows.filter((r) => {
    const style = getComputedStyle(r);
    return parseFloat(style.borderTopWidth) || parseFloat(style.borderBottomWidth);
  }).length), 0, `${name}: the settings lists are ruled again`);
  assert.equal(await page.locator("#journal-settings [data-tag] .passage-menu-item:visible").count(), 0, `${name}: tag actions are on show before their menu is opened`);
  const tagMenu = async (tag, action) => {
    await page.locator(`#journal-settings [data-tag="${tag}"] [data-tag-menu]`).click();
    await page.locator(`#journal-settings [data-tag="${tag}"] ${action}`).click();
  };
  assert.deepEqual(
    await page.locator('#journal-settings [data-tag="Orphans"] .passage-menu-item').allTextContents(),
    ["Rename", "Merge into wayfaring", "Delete"],
    `${name}: a tag's menu changed`,
  );

  // Tags used in this journal can be renamed, merged and deleted.
  page.once("dialog", (dialog) => dialog.accept("Strays"));
  await tagMenu("Orphans", "[data-tag-rename]");
  await waitForJournal((s) => s.passages.some((p) => p.tags.includes("Strays")) && !s.passages.some((p) => p.tags.includes("Orphans")), "tag renamed");
  page.once("dialog", (dialog) => dialog.accept());
  await tagMenu("wayfaring", '[data-tag-merge="Strays"]');
  await waitForJournal((s) => s.passages.filter((p) => p.tags.includes("Strays")).length === 2 && !s.passages.some((p) => p.tags.includes("wayfaring")), "tags merged");
  page.once("dialog", (dialog) => dialog.accept());
  await tagMenu("Strays", "[data-tag-delete]");
  await waitForJournal((s) => !s.passages.some((p) => p.tags.length), "tag deleted");

  // Adding a source: one list of what the library still offers, by kind. The
  // journal already has the only series, so there are just books and authors.
  const addSource = page.locator("#journal-settings [data-source-add]");
  assert.deepEqual(await addSource.locator("optgroup").evaluateAll((groups) => groups.map((g) => g.label)), ["Books", "Authors"], `${name}: the sources on offer changed`);
  const split = await libraryBook(BOOKS.split);
  await addSource.selectOption(`book:${split.key}`);
  // That book's passages were made before it was a source here.
  await page.locator('#journal-settings .journal-ask [data-answer="fresh"]').click();
  const withBook = await waitForJournal((s) => s.journals.find((j) => j.id === series.id).sources.length === 2 && s, "the added source");
  assert.deepEqual(withBook.journals.find((j) => j.id === series.id).sources[1], { type: "book", book_key: split.key, enabled: true }, `${name}: the chosen book was not added as a source`);
  assert.equal(await page.locator("#journal-settings [data-source-toggle]").count(), 2);

  // Rename, then export.
  await page.locator("#journal-name").fill("Wayfarers");
  await page.locator("#journal-name").blur();
  await page.waitForFunction(() => document.querySelector("#journal-title").textContent === "Wayfarers");
  const href = await page.locator("#journal-settings a[download]").getAttribute("href");
  const exported = await fetch(`${baseURL}${href}`);
  assert.equal(exported.status, 200);
  const markdown = await exported.text();
  assert.ok(markdown.startsWith("# Wayfarers\n"), `${name}: export is not titled with the journal`);
  for (const expected of ["## First Volume — Ann Author", "## Second Volume — Ann Author", "## Removed Book — Ann Author", "> A line from a book that was later removed.", "**Note:** Written in the journal.", "Pink highlight, Double underline", "Status: Book missing"]) {
    assert.ok(markdown.includes(expected), `${name}: export is missing "${expected}"`);
  }
  await closeDrawer.click();
  assert.equal(await drawer.isVisible(), false, `${name}: Close left journal settings open`);

  // Remove from journal: the passage stays in its other journal.
  const shared = (await journalState()).passages.find((p) => p.journals.length === 2);
  await cardMenu(page.locator(`#journal-cards [data-passage-id="${shared.id}"]`), "remove");
  await page.waitForFunction(() => document.querySelector("#journal-count").textContent === "3 Passages");
  const after = await waitForJournal((s) => s.passages.find((p) => p.id === shared.id).journals.length === 1, "removal from one journal");
  assert.ok(!after.passages.find((p) => p.id === shared.id).deleted);
}

// How a card is laid out: a heading with the overflow menu, over a panel that
// holds the passage. Centred on the page, and in two columns on a wide screen.
async function cardLayout(page, name) {
  const first = page.locator("#journal-cards .passage-card").first();
  // Nothing done to the passage as a whole is on the card's face.
  assert.equal(await first.locator(".passage-panel [data-act]:is(button):not(.tag-chip):not(.passage-edit)").count(), 0, `${name}: a passage's actions are back on the card`);
  const menu = first.locator(".passage-menu");
  assert.equal(await menu.isVisible(), false, `${name}: the passage menu is open before it is asked for`);
  await first.locator('[data-act="menu"]').click();
  assert.deepEqual(
    await menu.locator("[data-act]").allTextContents(),
    ["Add to clipboard", "View in book", "Choose journals", "Remove from journal", "Delete passage"],
    `${name}: the passage menu changed`,
  );
  assert.equal(await first.locator('[data-act="menu"]').getAttribute("aria-expanded"), "true");
  // One menu at a time, and a tap anywhere else puts it away.
  const second = page.locator("#journal-cards .passage-card").nth(1);
  await second.locator('[data-act="menu"]').click();
  assert.deepEqual([await menu.isVisible(), await second.locator(".passage-menu").isVisible()], [false, true], `${name}: two passage menus open at once`);
  await page.locator("#journal-title").click();
  assert.equal(await second.locator(".passage-menu").isVisible(), false, `${name}: a tap elsewhere left the passage menu open`);
  // Copying says so in the menu, then the menu goes.
  await first.locator('[data-act="menu"]').click();
  await menu.locator('[data-act="copy"]').click();
  await page.waitForFunction(() => /^(Added to clipboard|Couldn't copy)$/.test(document.querySelector('#journal-cards .passage-menu [data-act="copy"]').textContent));
  await menu.waitFor({ state: "hidden" });
  assert.equal(await menu.locator('[data-act="copy"]').textContent(), "Add to clipboard");

  // "Choose journals" puts one passage into another journal, or takes it out,
  // without touching what either journal collects.
  const orphan = card(page, "A line from a book");
  const membership = async () => Object.fromEntries(await orphan.locator(".journals-tool [data-journal-toggle]").evaluateAll((chips) => chips.map((c) => [c.textContent, c.getAttribute("aria-pressed")])));
  const journalsOf = (s) => s.passages.find((p) => p.text.startsWith("A line from a book")).journals.length;
  await cardMenu(orphan, "file");
  assert.deepEqual(await membership(), { "My First Journal": "false", "Wayfarers notes": "true" }, `${name}: the journals a passage is in are not shown`);
  await orphan.locator("[data-journal-toggle]", { hasText: "My First Journal" }).click();
  await waitForJournal((s) => journalsOf(s) === 2, "the passage shared into a second journal");
  assert.deepEqual(await membership(), { "My First Journal": "true", "Wayfarers notes": "true" });
  await orphan.locator("[data-journal-toggle]", { hasText: "My First Journal" }).click();
  await waitForJournal((s) => journalsOf(s) === 1, "the passage taken back out");
  await page.keyboard.press("Escape");

  // Centred, not against the left edge.
  const centred = async () => page.locator("#journal-cards .passage-card").evaluateAll((cards) => {
    const boxes = cards.map((c) => c.getBoundingClientRect());
    const lefts = [...new Set(boxes.map((b) => Math.round(b.left)))].sort((a, b) => a - b);
    // Measured inside the scrolling list, whose scrollbar is not part of the page.
    const list = document.querySelector("#journal-cards"), edge = list.getBoundingClientRect().left + list.clientLeft;
    const right = edge + list.clientWidth - Math.max(...boxes.map((b) => b.right));
    return { columns: lefts.length, left: Math.round(lefts[0] - edge), right: Math.round(right), tops: boxes.map((b) => Math.round(b.top)) };
  });
  const size = page.viewportSize();
  await page.setViewportSize({ width: 1200, height: size.height });
  let layout = await centred();
  assert.equal(layout.columns, 1, `${name}: cards split into columns on an ordinary screen`);
  assert.ok(layout.left > 100 && Math.abs(layout.left - layout.right) <= 2, `${name}: cards are not centred on the page (${layout.left} left, ${layout.right} right)`);
  // A wide screen has room for two columns, still centred as a pair.
  await page.setViewportSize({ width: 1700, height: size.height });
  await page.waitForFunction(() => new Set([...document.querySelectorAll("#journal-cards .passage-card")].map((c) => Math.round(c.getBoundingClientRect().left))).size === 2);
  layout = await centred();
  assert.ok(Math.abs(layout.left - layout.right) <= 2, `${name}: the two columns are not centred (${layout.left} left, ${layout.right} right)`);
  // Reading order survives: the first two cards head the columns.
  assert.equal(layout.tops[0], layout.tops[1], `${name}: the second card does not head the second column`);
  assert.ok(layout.tops[2] > layout.tops[0], `${name}: the third card is not below the first row`);
  await page.setViewportSize(size);
}

// Another device adds a passage while the journal is open here.
async function liveRefresh(page, name, series) {
  const id = randomUUID(), now = new Date().toISOString();
  const first = await libraryBook(BOOKS.first);
  await putDoc("passages", {
    v: 1, id, created: now, updated: now, device: "the-e-reader", deleted: false,
    text: "Captured on the e-reader a moment ago.", context: { before: "", after: "" }, note: "", tags: [],
    style: { highlight: "yellow", underline: null }, journals: [series.id],
    source: { book_key: first.key, book_id: first.id, title: first.title, author: first.author, series: "Wayfarers", series_index: 1, chapter: "Two", cfi: "epubcfi(/6/4!/4/4,/1:0,/1:10)", percent: 0.3 },
  });
  await page.locator("#journal-cards .passage-card", { hasText: "Captured on the e-reader" }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#journal-count").textContent(), "4 Passages", `${name}: the open journal did not follow another device`);
  // And it leaves the same way: deleted elsewhere, gone here.
  await putDoc("passages", { v: 1, id, updated: new Date(Date.now() + 1000).toISOString(), device: "the-e-reader", deleted: true });
  await page.locator("#journal-cards .passage-card", { hasText: "Captured on the e-reader" }).waitFor({ state: "detached", timeout: 10000 });

  // Deleting the journal keeps its passages; those in no other journal wait in Unfiled.
  await page.locator("#journal-settings-toggle").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#journal-settings [data-journal-delete]").click();
  await page.locator("#journal-view").waitFor({ state: "hidden" });
  const state = await waitForJournal((s) => s.journals.length === 1, "journal deleted");
  assert.equal(state.passages.length, 6, `${name}: deleting a journal deleted passages`);
  const names = (await shelf(page)).map(([n]) => n);
  assert.deepEqual(names, ["My First Journal", "Unfiled"], `${name}: shelf wrong after deleting a journal`);
}

async function runEngine(name, engine) {
  await wipeJournals();
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 820, height: 1000 } });
    const page = await context.newPage();
    const series = await filing(page, name);
    await unfiledTray(page, name);
    await journalView(page, name, series);
    await liveRefresh(page, name, series);
    assert.equal(await sheetOpen(page), false);
    await context.close();
    console.log(`${name}: journals file, collect, filter, export, follow other devices and outlive their sources`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
