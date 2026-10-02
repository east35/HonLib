// Journals outside the book: the shelf on the home page, the journal view, and
// the passage tools (style, tags, note, filing) that the reader's sheet shares
// with the journal's cards. Everything here reads and writes through
// journal-store.js; nothing talks to the server directly.
import * as store from "./journal-store.js";

const $ = (sel) => document.querySelector(sel);
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

// What the app supplies: the library's books, how to open a book at a passage,
// whether the home page is showing (the Journals shelf belongs only there), and
// which layout the library is in ("cover" or "table").
let host = { books: () => [], visit: () => {}, isHome: () => true, layout: () => "cover" };

const els = {
  section: $("#journals-section"), shelf: $("#journals"), newJournal: $("#journal-new"),
  view: $("#journal-view"), title: $("#journal-title"), back: $("#journal-back"),
  settingsToggle: $("#journal-settings-toggle"), drawer: $("#journal-drawer"), settings: $("#journal-settings"),
  tools: $("#journal-tools"), search: $("#journal-search"),
  filterTag: $("#journal-filter-tag"), filterBook: $("#journal-filter-book"), filterStyle: $("#journal-filter-style"), filterState: $("#journal-filter-state"), sort: $("#journal-sort"),
  count: $("#journal-count"), cards: $("#journal-cards"),
};

// ---- styles --------------------------------------------------------------
// The colour and underline last chosen become the default for the next capture.
const STYLE_KEY = "ebook-library.annotationStyle";
export function lastStyle() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STYLE_KEY) || "{}") || {}; } catch {}
  return {
    highlight: store.highlightById(saved.highlight) ? saved.highlight : store.DEFAULT_HIGHLIGHT,
    underline: store.underlineById(saved.underline) ? saved.underline : store.DEFAULT_UNDERLINE,
  };
}
export function setStyle(passageId, kind, value) {
  const p = store.passage(passageId);
  if (!p) return null;
  const style = { highlight: p.style?.highlight || null, underline: p.style?.underline || null, [kind]: value || null };
  // With neither, the passage would have no mark on the page to tap.
  if (!style.highlight && !style.underline) return p;
  if (value) { try { localStorage.setItem(STYLE_KEY, JSON.stringify({ ...lastStyle(), [kind]: value })); } catch {} }
  return store.updatePassage(passageId, { style });
}
// Every choice carries its name: a swatch alone says nothing on a grayscale
// screen.
export function styleOptionsHtml(p, kind) {
  const current = p.style?.[kind] || null;
  const other = kind === "highlight" ? p.style?.underline : p.style?.highlight;
  const option = (value, inner, on, disabled = false) =>
    `<button type="button" class="ps-option${on ? " active" : ""}" data-style-kind="${kind}" data-style-value="${value}" aria-pressed="${on}"${disabled ? " disabled" : ""}>${inner}</button>`;
  const choices = kind === "highlight"
    ? store.HIGHLIGHTS.map((h) => option(h.id, `<span class="ps-swatch" style="background:${h.color}"></span>${esc(h.label)}`, current === h.id))
    : store.UNDERLINES.map((u) => option(u.id, `<span class="ps-line ul-${u.id}">${esc(u.label)}</span>`, current === u.id));
  const label = kind === "highlight" ? "Highlight colour" : "Underline style";
  return `<div class="ps-options" role="group" aria-label="${label}">${option("", "None", !current, !other)}${choices.join("")}</div>`;
}
// The passage's text as it is marked in the book: the true highlight colour
// behind it and the underline style beneath it.
export function quoteHtml(p, max = 0) {
  const full = String(p.text || "");
  const text = max && full.length > max ? `${full.slice(0, max).trimEnd()}…` : full;
  const h = store.highlightById(p.style?.highlight), u = store.underlineById(p.style?.underline);
  return `<mark class="passage-mark${u ? ` ul-${u.id}` : ""}${h ? "" : " no-highlight"}"${h ? ` style="background:${h.color}"` : ""}>${esc(text)}</mark>`;
}

// ---- tools ---------------------------------------------------------------
// Each tool owns the element it is mounted in and keeps it up to date itself,
// so a redraw elsewhere never takes the keyboard away mid-word. `commit` saves
// anything still being typed; whoever unmounts a tool calls it first.

// `chips: false` leaves out the passage's own tags, for a caller that already
// shows them.
export function mountTagTool(el, passageId, { chips = true } = {}) {
  const root = document.createElement("div");
  root.className = "tag-tool";
  root.innerHTML = `${chips ? `<div class="tag-chips" data-tags></div>` : ""}
    <form class="tag-form"><input type="text" placeholder="Add a tag" autocomplete="off" autocapitalize="none" maxlength="60" aria-label="Add a tag"><button type="submit" class="btn">Add</button></form>
    <div class="tag-chips" data-suggestions></div>`;
  const input = root.querySelector("input");
  const draw = () => {
    const p = store.passage(passageId);
    if (!p) return;
    const tags = p.tags || [];
    if (chips) root.querySelector("[data-tags]").innerHTML = tags.map((t) =>
      `<button type="button" class="tag-chip on" data-tag-remove="${esc(t)}" aria-label="Remove tag ${esc(t)}">${esc(t)}<span class="tag-chip-x" aria-hidden="true">×</span></button>`).join("");
    const suggestions = store.suggestTags(store.journalIdsOf(p), input.value, tags).slice(0, 14);
    root.querySelector("[data-suggestions]").innerHTML = suggestions.map((t) =>
      `<button type="button" class="tag-chip" data-tag-add="${esc(t)}">${esc(t)}</button>`).join("");
  };
  const add = (tag) => { store.addTag(passageId, tag); input.value = ""; draw(); };
  root.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); add(input.value); input.focus(); });
  input.addEventListener("input", draw);
  root.addEventListener("click", (e) => {
    const addBtn = e.target.closest("[data-tag-add]"), removeBtn = e.target.closest("[data-tag-remove]");
    if (addBtn) add(addBtn.dataset.tagAdd);
    else if (removeBtn) { store.removeTag(passageId, removeBtn.dataset.tagRemove); draw(); }
  });
  el.replaceChildren(root);
  draw();
  return { commit() { if (input.value.trim()) add(input.value); }, focus() { input.focus(); } };
}

export function mountNoteTool(el, passageId, onSaved) {
  const root = document.createElement("div");
  root.className = "note-tool";
  root.innerHTML = `<textarea rows="4" placeholder="Add a note" aria-label="Note"></textarea><div class="row"><button type="button" class="btn primary">Save note</button></div>`;
  const area = root.querySelector("textarea");
  area.value = store.passage(passageId)?.note || "";
  const commit = () => {
    const p = store.passage(passageId), note = area.value.trim();
    if (!p || note === (p.note || "")) return false;
    store.updatePassage(passageId, { note });
    return true;
  };
  area.addEventListener("blur", commit);
  root.querySelector("button").addEventListener("click", () => { commit(); if (onSaved) onSaved(); });
  el.replaceChildren(root);
  return { commit, focus() { area.focus(); } };
}

export function mountStyleTool(el, passageId, kinds = ["highlight", "underline"]) {
  const root = document.createElement("div");
  root.className = "style-tool";
  const draw = () => {
    const p = store.passage(passageId);
    if (p) root.innerHTML = kinds.map((kind) => styleOptionsHtml(p, kind)).join("");
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-style-kind]");
    if (!b || b.disabled) return;
    setStyle(passageId, b.dataset.styleKind, b.dataset.styleValue);
    draw();
  });
  el.replaceChildren(root);
  draw();
  return { commit() {} };
}

// "Bring in the N existing passages, or start fresh?" Resolves true to bring
// them in. Asked in place rather than with confirm(), whose OK / Cancel cannot
// name the two choices.
function askBringIn(el, n) {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "journal-ask";
    box.innerHTML = `<p>Bring in the ${plural(n, "existing passage")}, or start fresh?</p>
      <div class="row"><button type="button" class="btn primary" data-answer="bring">Bring in ${n}</button><button type="button" class="btn" data-answer="fresh">Start fresh</button></div>`;
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-answer]");
      if (!b) return;
      box.remove();
      resolve(b.dataset.answer === "bring");
    });
    el.appendChild(box);
    box.querySelector("button").focus();
  });
}
// Turn a source on in a journal. If passages from it already exist outside the
// journal, ask once (for the whole source, however many books it spans) whether
// to bring them in; starting fresh collects only from now on.
// `askEl` is where the question is shown: an element, or a function returning
// one for callers whose panel is redrawn by the change itself.
export async function enableSource(journalId, source, askEl, { except = null } = {}) {
  store.enableSource(journalId, source);
  const existing = store.passagesOutsideJournal(source, journalId).filter((p) => p.id !== except);
  if (!existing.length) return 0;
  const el = typeof askEl === "function" ? askEl() : askEl;
  if (!(await askBringIn(el, existing.length))) return 0;
  store.batch(() => { for (const p of existing) store.addToJournal(p.id, journalId); });
  return existing.length;
}

// Books the reader has declined to file. The prompt is offered once per book;
// after "Not now" its passages wait in Unfiled without asking again.
const DISMISSED_KEY = "ebook-library.journalPromptDismissed";
function dismissedBooks() {
  try { const list = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]"); return Array.isArray(list) ? list : []; } catch { return []; }
}
export function filingDismissed(bookKey) { return dismissedBooks().includes(bookKey); }
export function dismissFiling(bookKey) {
  const list = dismissedBooks().filter((k) => k !== bookKey);
  list.push(bookKey);
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(list.slice(-500))); } catch {}
}

function scopeLabel(book, scope) {
  if (scope === "series") return `Series: ${store.bookSeries(book)}`;
  if (scope === "author") return `Author: ${book.author}`;
  return "This book";
}
// Offered after a highlight in a book no journal covers. The passage is already
// saved; this only decides where it, and what follows from the same book,
// series or author, is collected. `onDone(filed)` runs once it is settled.
export function mountFilingTool(el, passageId, book, onDone) {
  const root = document.createElement("div");
  root.className = "filing-tool";
  const scopes = ["book", "series", "author"].filter((s) => store.sourceFor(book, s));
  let scope = "book";
  const draw = () => {
    const journals = store.journals();
    root.innerHTML = `<p class="filing-lead">Saved. Add this book to a journal?</p>
      ${scopes.length > 1 ? `<div class="seg seg-wrap" role="group" aria-label="What to add">${scopes.map((s) =>
        `<button type="button" data-scope="${s}" class="${s === scope ? "active" : ""}" aria-pressed="${s === scope}">${esc(scopeLabel(book, s))}</button>`).join("")}</div>` : ""}
      <div class="filing-journals">${journals.map((j) => `<button type="button" class="btn" data-file-into="${esc(j.id)}">${esc(j.name)}</button>`).join("")}
        <button type="button" class="btn" data-file-new>New Journal</button></div>
      <div class="row"><button type="button" class="btn ghost" data-file-skip>Not now</button></div>
      <div data-ask></div>`;
  };
  const fileInto = async (journalId) => {
    const source = store.sourceFor(book, scope);
    store.addToJournal(passageId, journalId);
    root.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    await enableSource(journalId, source, root.querySelector("[data-ask]"), { except: passageId });
    onDone(true);
  };
  root.addEventListener("click", (e) => {
    const scopeBtn = e.target.closest("[data-scope]"), into = e.target.closest("[data-file-into]");
    if (scopeBtn) { scope = scopeBtn.dataset.scope; draw(); return; }
    if (into) { fileInto(into.dataset.fileInto); return; }
    if (e.target.closest("[data-file-new]")) {
      const suggested = scope === "series" ? store.bookSeries(book) : scope === "author" ? book.author : book.title;
      const name = prompt("Name the new journal", suggested || "");
      if (name === null || !name.trim()) return;
      fileInto(store.createJournal(name).id);
      return;
    }
    if (e.target.closest("[data-file-skip]")) { dismissFiling(store.bookKey(book)); onDone(false); }
  });
  el.replaceChildren(root);
  draw();
  return { commit() {} };
}

// ---- shelf ---------------------------------------------------------------
function journalCount(j) { return store.passagesInJournal(j.id).length; }
function journalCard(j) {
  const card = document.createElement("div");
  card.className = "series-card journal-card";
  card.title = j.name;
  card.innerHTML = `<div class="journal-cover"><span class="journal-cover-kicker">Journal</span><span class="journal-cover-name">${esc(j.name)}</span><span class="journal-cover-count">${plural(journalCount(j), "passage")}</span></div>`;
  card.addEventListener("click", () => openJournal(j.id));
  return card;
}
function unfiledCard(n) {
  const card = document.createElement("div");
  card.className = "series-card journal-card unfiled";
  card.title = "Unfiled";
  card.innerHTML = `<div class="journal-cover"><span class="journal-cover-kicker">Tray</span><span class="journal-cover-name">Unfiled</span><span class="journal-cover-count">${plural(n, "passage")}</span></div>`;
  card.addEventListener("click", () => openJournal(UNFILED));
  return card;
}
// The same two objects as rows, for the table layout: a journal takes its place
// among a shelf's books there just as its card does among their covers.
function shelfRow(id, name, kind, count, unfiled = false) {
  const tr = document.createElement("tr");
  tr.className = `book-row journal-row${unfiled ? " unfiled" : ""}`;
  tr.innerHTML = `<td class="c-cover"><div class="row-cover journal-row-cover" aria-hidden="true"></div></td>` +
    `<td class="c-title"><span class="row-title">${esc(name)}</span></td>` +
    `<td class="c-author">${kind}</td>` +
    `<td class="c-status"><span class="row-status">${plural(count, "passage")}</span></td>`;
  tr.addEventListener("click", () => openJournal(id));
  return tr;
}
function journalRow(j) { return shelfRow(j.id, j.name, "Journal", journalCount(j)); }
// The one library shelf (a folder: a series or an author) a journal belongs on:
// the shelf every one of its sources resolves to. A journal drawing on several
// shelves, or on books no longer in the library, has none.
function shelfOf(j, books) {
  const sources = j.sources || [];
  if (!sources.length) return null;
  const groups = new Set();
  for (const source of sources) {
    const matched = books.filter((b) => store.sourceMatches(source, b));
    if (!matched.length) return null;
    for (const b of matched) groups.add(b.group || "Library");
  }
  return groups.size === 1 ? [...groups][0] : null;
}
export function renderShelf() {
  const journals = store.journals(), unfiled = store.unfiledPassages().length;
  const table = host.layout() === "table";
  els.section.classList.toggle("hidden", !host.isHome() || (!journals.length && !unfiled));
  els.shelf.innerHTML = "";
  els.shelf.classList.toggle("library", !table);
  els.shelf.classList.toggle("as-table", table);
  if (table) {
    const body = document.createElement("tbody");
    for (const j of journals) body.appendChild(journalRow(j));
    if (unfiled) body.appendChild(shelfRow(UNFILED, "Unfiled", "Tray", unfiled, true));
    const el = document.createElement("table");
    el.className = "book-table";
    el.appendChild(body);
    els.shelf.appendChild(el);
  } else {
    for (const j of journals) els.shelf.appendChild(journalCard(j));
    if (unfiled) els.shelf.appendChild(unfiledCard(unfiled));
  }
  renderGroupJournals();
}
// Journals also sit on the library shelf they belong to, wherever shelves are
// drawn (the home page, and results grouped by series) and in either layout.
// The app renders the shelves, tagging each with its folder; this adds the
// journals to them: a card among the covers, or a row in the table.
function renderGroupJournals() {
  document.querySelectorAll(".book-group .journal-card, .book-group .journal-row").forEach((el) => el.remove());
  const blocks = [...document.querySelectorAll(".book-group[data-group]")];
  if (!blocks.length) return;
  const books = host.books();
  for (const j of store.journals()) {
    const group = shelfOf(j, books);
    if (!group) continue;
    for (const block of blocks) {
      if (block.dataset.group !== group) continue;
      const rows = block.querySelector(".as-table tbody"), grid = block.querySelector(".library");
      if (rows) rows.appendChild(journalRow(j));
      else if (grid) grid.appendChild(journalCard(j));
    }
  }
}

// ---- journal view --------------------------------------------------------
export const UNFILED = "unfiled";
const STATE_ICONS = {
  // Source off: a book with a bar through it.
  "source-off": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" /><path d="M3 3l18 18" /></svg>',
  // Book missing: an empty, dashed outline where the book was.
  "book-missing": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14v16H5z" stroke-dasharray="3 3" /><path d="M12 9v4M12 16h.01" /></svg>',
};
let view = null;   // { id, query, tag, book, style, state, sort, tool: { passageId, kind, handle }, menu: passageId }
let settingsAsk = null;
// Set while the journal is shown on top of an open book (reached from a mark
// on the page). `keepOpen` says it was already open underneath, so going back
// uncovers the book without closing the journal.
let raised = null;
// What `raised` was when the journal was lowered to let a visit show.
let lowered = null;

function viewJournal() { return view && view.id !== UNFILED ? store.journal(view.id) : null; }
function viewPassages() { return view.id === UNFILED ? store.unfiledPassages() : store.passagesInJournal(view.id); }
function stateOf(p) { return view.id === UNFILED ? (store.findBook(p, host.books()) ? "linked" : "book-missing") : store.linkState(p, viewJournal(), host.books()); }
function percentOf(p) { return Number(p.source?.percent) || 0; }
function byNewest(a, b) { return String(b.created || "").localeCompare(String(a.created || "")); }
function byBook(a, b) {
  const sa = a.source || {}, sb = b.source || {};
  return store.nameKey(sa.series).localeCompare(store.nameKey(sb.series))
    || (Number(sa.series_index) || 0) - (Number(sb.series_index) || 0)
    || String(sa.title || "").localeCompare(String(sb.title || ""), undefined, { sensitivity: "base" })
    || percentOf(a) - percentOf(b);
}
function filteredPassages(all) {
  const list = all.filter((p) =>
    store.matchesQuery(p, view.query)
    && (!view.tag || store.hasTag(p, view.tag))
    && (!view.book || p.source?.book_key === view.book)
    && (!view.style || p.style?.highlight === view.style || `u:${p.style?.underline}` === view.style)
    && (!view.state || stateOf(p) === view.state));
  if (view.sort === "book") return list.sort(byBook);
  list.sort(byNewest);
  return view.sort === "oldest" ? list.reverse() : list;
}

function fillSelect(sel, allLabel, options, current) {
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
  sel.value = options.some(([value]) => value === current) ? current : "";
  return sel.value;
}
function renderFilters(all) {
  view.tag = fillSelect(els.filterTag, "All tags", store.tagsOf(all).map((t) => [t.tag, `${t.tag} (${t.count})`]), view.tag);
  const books = new Map();
  for (const p of all) if (p.source?.book_key && !books.has(p.source.book_key)) books.set(p.source.book_key, p.source.title || "Untitled");
  view.book = fillSelect(els.filterBook, "All books", [...books].sort((a, b) => a[1].localeCompare(b[1])), view.book);
  view.style = fillSelect(els.filterStyle, "All styles", [
    ...store.HIGHLIGHTS.map((h) => [h.id, `${h.label} highlight`]),
    ...store.UNDERLINES.map((u) => [`u:${u.id}`, `${u.label} underline`]),
  ], view.style);
  view.state = fillSelect(els.filterState, "All statuses", [["linked", "Linked"], ["source-off", "Source off"], ["book-missing", "Book missing"]], view.state);
  els.sort.innerHTML = `<option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="book">By book</option>`;
  els.sort.value = view.sort;
  if (els.search.value !== view.query) els.search.value = view.query;
}

const ICONS = {
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" /><path d="M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4z" /></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>',
};
// A card is a heading and a panel. The heading says where the passage is from
// and how it is marked, and holds the overflow menu: everything done to the
// passage as a whole (copy, open its page, take it out of the journal, delete
// it, choose its journals). The panel is the passage itself, and each part of it is its own
// control: the quote opens its style, the note opens for editing, a tag comes
// off, and "Add Tag" / "Add Note" sit where a tag or a note would be.
// Heading and body are redrawn only when what they say changes, and the open
// tool has a slot of its own that a redraw never touches. Cards are matched to
// passages by id and updated in place, so a change from another device never
// closes the note someone is in the middle of writing.
function cardHeadHtml(p, state) {
  const s = p.source || {};
  const place = [s.title, s.chapter].filter(Boolean).join(", ");
  const where = `${place}${place ? " - " : ""}${Math.round(percentOf(p) * 100)}%`;
  const stateInfo = store.LINK_STATES[state];
  const open = view.menu === p.id;
  const item = (name, label, disabled = false) => `<button type="button" role="menuitem" class="passage-menu-item" data-act="${name}"${disabled ? " disabled" : ""}>${label}</button>`;
  return `<div class="passage-where">${esc(where)}</div>
    <div class="passage-meta"><span class="passage-style">${esc(store.styleLabel(p.style))}</span>${stateInfo ? `<span class="passage-state" title="${esc(stateInfo.hint)}">${STATE_ICONS[state]}${esc(stateInfo.label)}</span>` : ""}</div>
    <button type="button" class="passage-menu-btn" data-act="menu" aria-haspopup="menu" aria-expanded="${open}" aria-label="Passage options" title="Passage options">${ICONS.more}</button>
    <div class="passage-menu${open ? "" : " hidden"}" role="menu">${item("copy", COPY_LABEL)}${item("visit", "View in book", state === "book-missing")}${
      view.id === UNFILED ? item("file", "Add to journal")
        // With more than one journal there is a choice of which the passage is in.
        : `${store.journals().length > 1 ? item("file", "Choose journals") : ""}${item("remove", "Remove from journal")}`}${item("delete", "Delete passage")}</div>`;
}
function cardBodyHtml(p) {
  const h = store.highlightById(p.style?.highlight);
  const edit = (label) => `<button type="button" class="passage-edit" aria-label="${label}" title="${label}">${ICONS.edit}</button>`;
  const add = (act, label) => `<button type="button" class="tag-chip passage-add" data-act="${act}">${label}${ICONS.plus}</button>`;
  return `<blockquote class="passage-quote${h ? "" : " no-highlight"}" data-act="style"${h ? ` style="background:${h.color}"` : ""}>${quoteHtml(p)}${edit("Edit style")}</blockquote>
    ${p.note ? `<div class="passage-note" data-act="note"><span class="passage-note-text">${esc(p.note)}</span>${edit("Edit note")}</div>` : ""}
    <div class="tag-chips passage-tags">${(p.tags || []).map((t) =>
      `<button type="button" class="tag-chip on" data-act="untag" data-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${esc(t)}${ICONS.cross}</button>`).join("")}${add("tags", "Add Tag")}${p.note ? "" : add("note", "Add Note")}</div>`;
}
const drawnHtml = new WeakMap();
function setHtml(el, html) { if (drawnHtml.get(el) !== html) { drawnHtml.set(el, html); el.innerHTML = html; } }
// On a wide screen the cards run in two columns, each card placed under the
// shorter one. The stylesheet does the placing; it needs to know how tall each
// card is, in rows of the grid, and a card's height is its own business.
const CARD_ROW_PX = 4, CARD_GAP_PX = 28;
const cardHeights = "ResizeObserver" in window ? new ResizeObserver((entries) => {
  for (const { target } of entries) target.style.setProperty("--rows", Math.ceil((target.offsetHeight + CARD_GAP_PX) / CARD_ROW_PX));
}) : null;
function renderCards(shown) {
  const existing = new Map();
  for (const el of [...els.cards.children]) {
    if (el.dataset.passageId) existing.set(el.dataset.passageId, el);
    else el.remove();
  }
  let at = 0;
  for (const p of shown) {
    let card = existing.get(p.id);
    existing.delete(p.id);
    if (!card) {
      card = document.createElement("article");
      card.className = "passage-card";
      card.dataset.passageId = p.id;
      card.innerHTML = `<header class="passage-head"></header><div class="passage-panel"><div class="passage-body"></div><div class="passage-tool hidden"></div></div>`;
      cardHeights?.observe(card);
    }
    setHtml(card.querySelector(".passage-head"), cardHeadHtml(p, stateOf(p)));
    setHtml(card.querySelector(".passage-body"), cardBodyHtml(p));
    if (els.cards.children[at] !== card) els.cards.insertBefore(card, els.cards.children[at] || null);
    at += 1;
  }
  for (const [id, card] of existing) {
    if (view.tool?.passageId === id) view.tool = null;
    if (view.menu === id) view.menu = null;
    cardHeights?.unobserve(card);
    card.remove();
  }
}
// One card's overflow menu is open at a time; null closes it.
function setMenu(passageId) {
  if (!view || view.menu === passageId) return;
  view.menu = passageId;
  for (const card of els.cards.querySelectorAll(".passage-card")) {
    const open = card.dataset.passageId === passageId;
    card.classList.toggle("menu-open", open);
    card.querySelector(".passage-menu").classList.toggle("hidden", !open);
    card.querySelector('[data-act="menu"]').setAttribute("aria-expanded", String(open));
  }
  if (passageId) toolCard(passageId)?.querySelector(".passage-menu").scrollIntoView({ block: "nearest" });
}

function toolCard(passageId) { return els.cards.querySelector(`[data-passage-id="${CSS.escape(passageId)}"]`); }
function closeCardTool() {
  if (!view?.tool) return;
  const { passageId, kind, handle } = view.tool;
  view.tool = null;
  handle?.commit?.();
  const card = toolCard(passageId);
  if (!card) return;
  card.classList.remove(`tool-${kind}`);
  const slot = card.querySelector(".passage-tool");
  slot.replaceChildren();
  slot.classList.add("hidden");
}
function openCardTool(card, kind) {
  const passageId = card.dataset.passageId;
  const same = view.tool && view.tool.passageId === passageId && view.tool.kind === kind;
  closeCardTool();
  if (same || !card.isConnected) return;
  const slot = card.querySelector(".passage-tool");
  slot.classList.remove("hidden");
  card.classList.add(`tool-${kind}`);
  let handle;
  if (kind === "note") handle = mountNoteTool(slot, passageId, closeCardTool);
  // The card shows the passage's tags itself, each one removable where it is.
  else if (kind === "tags") handle = mountTagTool(slot, passageId, { chips: false });
  else if (kind === "style") handle = mountStyleTool(slot, passageId);
  else handle = mountJournalsTool(slot, passageId);
  view.tool = { passageId, kind, handle };
  handle?.focus?.();
}
// Which journals a passage is in: a switch to each journal. A passage goes into
// every journal that covers its book when it is made; this is where it is kept
// out of one of them, or put into another. In none, it waits in Unfiled. Only
// the passage moves: what a journal collects from is set in its settings.
export function mountJournalsTool(el, passageId) {
  const root = document.createElement("div");
  root.className = "journals-tool";
  // Named, so that on a card the switches are not taken for tags.
  root.innerHTML = `<span class="drawer-label" id="journals-of-${esc(passageId)}">In journals</span><div class="tag-chips" role="group" aria-labelledby="journals-of-${esc(passageId)}"></div>`;
  const draw = () => {
    const p = store.passage(passageId);
    if (!p) return;
    const member = store.journalIdsOf(p);
    root.lastElementChild.innerHTML = store.journals().map((j) => {
      const on = member.includes(j.id);
      return `<button type="button" class="tag-chip${on ? " on" : ""}" data-journal-toggle="${esc(j.id)}" aria-pressed="${on}">${esc(j.name)}</button>`;
    }).join("") + `<button type="button" class="tag-chip passage-add" data-file-new>New Journal${ICONS.plus}</button>`;
  };
  root.addEventListener("click", (e) => {
    const p = store.passage(passageId);
    if (!p) return;
    const toggle = e.target.closest("[data-journal-toggle]");
    if (toggle) {
      const id = toggle.dataset.journalToggle;
      if (store.journalIdsOf(p).includes(id)) store.removeFromJournal(passageId, id);
      else store.addToJournal(passageId, id);
    } else if (e.target.closest("[data-file-new]")) {
      const name = prompt("Name the new journal", "");
      if (name === null || !name.trim()) return;
      store.addToJournal(passageId, store.createJournal(name).id);
    } else return;
    draw();
  });
  el.replaceChildren(root);
  draw();
  return { commit() {} };
}

const COPY_LABEL = "Add to clipboard";
async function copyPassage(p, button) {
  const s = p.source || {};
  const text = `“${p.text}”${s.title ? `\n— ${s.title}${s.author ? `, ${s.author}` : ""}` : ""}`;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch {
    // Clipboard API needs a secure context; a LAN address over http isn't one.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(area);
    area.select();
    try { ok = document.execCommand("copy"); } catch {}
    area.remove();
  }
  // Said where it was asked, then the menu is put away.
  button.textContent = ok ? "Added to clipboard" : "Couldn't copy";
  setTimeout(() => {
    if (button.isConnected) button.textContent = COPY_LABEL;
    if (view?.menu === p.id) setMenu(null);
  }, 1200);
}

// A field someone is using is left alone: its panel is redrawn when they leave.
function typingIn(container) {
  const active = document.activeElement;
  return !!active && container.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
}
function renderJournal() {
  if (!view) return;
  const j = viewJournal();
  if (view.id !== UNFILED && !j) { closeJournal(); return; }   // deleted, here or on another device
  els.title.textContent = j ? j.name : "Unfiled";
  els.settingsToggle.classList.toggle("hidden", !j);
  if (!j) setSettingsOpen(false);
  else if (settingsOpen() && !typingIn(els.settings) && !settingsAsk) renderSettings();
  const all = viewPassages();
  if (!typingIn(els.tools)) renderFilters(all);
  const shown = filteredPassages(all);
  const noun = all.length === 1 ? "Passage" : "Passages";
  els.count.textContent = shown.length === all.length ? `${all.length} ${noun}` : `${shown.length} of ${all.length} ${noun}`;
  renderCards(shown);
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "lib-empty";
    empty.textContent = all.length ? "No passages match your search and filters."
      : view.id === UNFILED ? "Nothing is waiting to be filed."
      : "No passages yet. Highlight something in one of this journal's books and it will appear here.";
    els.cards.appendChild(empty);
  }
}

function sourceLabel(source) {
  if (source.type === "book") {
    const book = host.books().find((b) => store.bookKey(b) === source.book_key);
    return `Book: ${book ? book.title : store.passages().find((p) => p.source?.book_key === source.book_key)?.source?.title || "A book no longer in the library"}`;
  }
  return `${source.type === "series" ? "Series" : "Author"}: ${source.name}`;
}
// Values a new source can take, from the library as it stands.
function sourceChoices(type) {
  const books = host.books();
  if (type === "book") {
    return books.map((b) => [store.bookKey(b), b.author ? `${b.title} — ${b.author}` : b.title]).sort((a, b) => a[1].localeCompare(b[1]));
  }
  const seen = new Map();
  for (const b of books) {
    const name = type === "series" ? store.bookSeries(b) : String(b.author || "").trim();
    if (name && !seen.has(store.nameKey(name))) seen.set(store.nameKey(name), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((name) => [name, name]);
}
// What the journal could still take as a source: one list, grouped by kind,
// each value "kind:key".
function sourceOptionsHtml(sources) {
  const taken = new Set(sources.map(store.sourceKey));
  const group = (type, label) => {
    const choices = sourceChoices(type).filter(([value]) => !taken.has(type === "book" ? `book:${value}` : `${type}:${store.nameKey(value)}`));
    return choices.length ? `<optgroup label="${label}">${choices.map(([value, text]) => `<option value="${esc(`${type}:${value}`)}">${esc(text)}</option>`).join("")}</optgroup>` : "";
  };
  return group("book", "Books") + group("series", "Series") + group("author", "Authors");
}
// The tag whose menu is open in the settings drawer, if any.
let tagMenu = null;
// The drawer is kept as plain as the library's: a label and one control to a
// field. A source is a line of text with its switch; adding one is a single
// list; and what can be done to a tag is behind its own menu, as it is for a
// passage.
function renderSettings() {
  const j = viewJournal();
  if (!j) return;
  const sources = j.sources || [];
  const tags = store.tagsInJournal(j.id);
  if (!tags.some((t) => t.tag === tagMenu)) tagMenu = null;
  const options = sourceOptionsHtml(sources);
  const item = (attr, label) => `<button type="button" role="menuitem" class="passage-menu-item" ${attr}>${label}</button>`;
  // Redrawn only when what it says has changed. A redraw replaces the
  // controls, and one that lands between a press and its release (focus
  // leaving a control is enough to ask for one) takes the control from under
  // the tap.
  setHtml(els.settings, `
    <div class="drawer-field"><label for="journal-name">Name</label><input id="journal-name" type="text" value="${esc(j.name)}" maxlength="120" autocomplete="off"></div>
    <div class="drawer-field"><span class="drawer-label">Sources</span>
      ${sources.length ? `<ul class="journal-list">${sources.map((s) => `<li><span>${esc(sourceLabel(s))}</span>
        <button type="button" class="btn${s.enabled !== false ? " primary" : ""}" data-source-toggle="${esc(store.sourceKey(s))}" aria-pressed="${s.enabled !== false}">${s.enabled !== false ? "On" : "Off"}</button></li>`).join("")}</ul>`
        : `<p class="hint">No sources yet. Add a book, a series or an author and its highlights are collected here.</p>`}
      ${options ? `<select data-source-add aria-label="Add a source"><option value="">Add a source…</option>${options}</select>` : ""}
      <div data-ask></div>
    </div>
    <div class="drawer-field"><span class="drawer-label">Tags in this journal</span>
      ${tags.length ? `<ul class="journal-list">${tags.map((t) => `<li data-tag="${esc(t.tag)}"><span>${esc(t.tag)} (${t.count})</span>
        <button type="button" class="journal-tag-more" data-tag-menu aria-haspopup="menu" aria-expanded="${t.tag === tagMenu}" aria-label="Options for the tag ${esc(t.tag)}" title="Tag options">${ICONS.more}</button>
        <div class="passage-menu${t.tag === tagMenu ? "" : " hidden"}" role="menu">${item("data-tag-rename", "Rename")}${
          tags.filter((o) => o.tag !== t.tag).map((o) => item(`data-tag-merge="${esc(o.tag)}"`, `Merge into ${esc(o.tag)}`)).join("")}${item("data-tag-delete", "Delete")}</div></li>`).join("")}</ul>` : `<p class="hint">No tags used here yet.</p>`}
    </div>
    <div class="drawer-divider"></div>
    <a class="btn" href="/api/journal/journals/${encodeURIComponent(j.id)}/export.md" download>Export Markdown</a>
    <button type="button" class="btn" data-journal-delete>Delete journal</button>`);
}
function setTagMenu(tag) {
  tagMenu = tag;
  renderSettings();
  if (tag) els.settings.querySelector('[data-tag-menu][aria-expanded="true"] + .passage-menu')?.scrollIntoView({ block: "nearest" });
}
// Journal settings open in the same drawer the library's view options use.
function settingsOpen() { return !els.drawer.classList.contains("hidden"); }
function setSettingsOpen(open) {
  if (open === settingsOpen()) return;
  els.drawer.classList.toggle("hidden", !open);
  els.settingsToggle.setAttribute("aria-expanded", String(open));
  tagMenu = null;
  if (open) renderSettings();
  else settingsAsk = null;
}
async function settingsEnable(source) {
  const j = viewJournal();
  if (!j) return;
  try {
    await enableSource(j.id, source, () => {
      // Hold the panel still while the question is open; a redraw would remove it.
      settingsAsk = true;
      renderSettings();
      return els.settings.querySelector("[data-ask]");
    });
  } finally { settingsAsk = null; }
  if (view) renderSettings();
}
function onSettingsClick(e) {
  const j = viewJournal();
  if (!j) return;
  const toggle = e.target.closest("[data-source-toggle]");
  if (toggle) {
    const source = (j.sources || []).find((s) => store.sourceKey(s) === toggle.dataset.sourceToggle);
    if (!source) return;
    // Turning a source off only stops new capture; what was collected stays.
    if (source.enabled !== false) { store.setSourceEnabled(j.id, store.sourceKey(source), false); renderSettings(); }
    else settingsEnable(source);
    return;
  }
  const tag = e.target.closest("[data-tag]")?.dataset.tag;
  // A tag's menu opens on its button and closes on any other tap in the drawer.
  if (tag && e.target.closest("[data-tag-menu]")) { setTagMenu(tagMenu === tag ? null : tag); return; }
  if (tagMenu) setTagMenu(null);
  const merge = e.target.closest("[data-tag-merge]");
  if (tag && merge) {
    if (confirm(`Merge the tag "${tag}" into "${merge.dataset.tagMerge}"?`)) store.renameTag(j.id, tag, merge.dataset.tagMerge);
    return;
  }
  if (tag && e.target.closest("[data-tag-rename]")) {
    const next = prompt(`Rename the tag "${tag}"`, tag);
    if (next !== null && store.cleanTag(next) && store.cleanTag(next) !== tag) store.renameTag(j.id, tag, next);
    return;
  }
  if (tag && e.target.closest("[data-tag-delete]")) {
    if (confirm(`Remove the tag "${tag}" from every passage in this journal?`)) store.deleteTag(j.id, tag);
    return;
  }
  if (e.target.closest("[data-journal-delete]")) {
    if (!confirm(`Delete the journal "${j.name}"?\n\nIts passages are kept. Any that are in no other journal move to Unfiled.`)) return;
    store.deleteJournal(j.id);
    closeJournal();
  }
}
function onSettingsChange(e) {
  const j = viewJournal();
  if (!j) return;
  if (e.target.id === "journal-name") {
    const name = e.target.value.trim();
    if (name && name !== j.name) store.updateJournal(j.id, { name });
    else e.target.value = j.name;
    return;
  }
  // Choosing from "Add a source" adds it; the value is "kind:key", and a
  // book's key has colons of its own.
  const add = e.target.closest("[data-source-add]");
  if (add && add.value) {
    const type = add.value.slice(0, add.value.indexOf(":")), value = add.value.slice(type.length + 1);
    settingsEnable(type === "book" ? { type, book_key: value, enabled: true } : { type, name: value, enabled: true });
  }
}

function onCardClick(e) {
  const target = e.target.closest("[data-act]");
  if (!target || target.disabled) return;
  const card = target.closest("[data-passage-id]");
  const p = store.passage(card.dataset.passageId);
  if (!p) return;
  const act = target.dataset.act;
  if (act === "menu") { setMenu(view.menu === p.id ? null : p.id); return; }
  if (act === "copy") { copyPassage(p, target); return; }
  setMenu(null);
  if (act === "untag") { store.removeTag(p.id, target.dataset.tag); return; }
  if (["note", "tags", "style", "file"].includes(act)) {
    // The quote and the note are text as well as controls: dragging across
    // them to select some is not a tap.
    if (!e.target.closest("button") && String(window.getSelection() || "")) return;
    openCardTool(card, act);
    return;
  }
  closeCardTool();
  if (act === "visit") host.visit(p);
  else if (act === "remove") store.removeFromJournal(p.id, view.id);
  else if (act === "delete") {
    if (confirm("Delete this passage?\n\nIt is removed from every journal and from the book.")) store.deletePassage(p.id);
  }
}

// `focus` is a passage to bring into view and mark out, for arriving from that
// passage's mark in a book. `overReader` shows the journal on top of the open
// book, which stays exactly where it is underneath.
export function openJournal(id, { settings = false, focus = null, overReader = false } = {}) {
  if (id !== UNFILED && !store.journal(id)) return;
  const opening = !view;
  closeCardTool();
  view = { id, query: "", tag: "", book: "", style: "", state: "", sort: "newest", tool: null, menu: null };
  els.search.value = "";
  els.view.classList.remove("hidden");
  document.body.classList.add("journal-open");
  if (overReader) setRaised({ keepOpen: raised ? raised.keepOpen : !opening });
  setSettingsOpen(false);
  renderJournal();
  setSettingsOpen(settings && id !== UNFILED);
  els.cards.scrollTop = 0;
  for (const card of els.cards.querySelectorAll(".focused")) card.classList.remove("focused");
  const card = focus ? toolCard(focus) : null;
  if (card) { card.classList.add("focused"); card.scrollIntoView({ block: "center" }); }
  // An open journal follows other devices: a passage captured on the e-reader
  // shows up here within moments.
  if (opening) store.startPolling();
}
function setRaised(state) {
  raised = state;
  els.view.classList.toggle("over-reader", !!state);
  els.back.title = state ? "Back to the book" : "Back to library";
  els.back.setAttribute("aria-label", els.back.title);
}
export function journalOverReader() { return !!raised; }
// Uncover the book but leave the journal open beneath it: a visit to another
// book is about to open on top, and "Back to journal" should find it here.
export function lowerJournal() { if (raised) { lowered = raised; setRaised(null); } }
export function raiseJournal() { if (view && !raised) { setRaised(lowered || { keepOpen: false }); lowered = null; } }
// The visit the journal was lowered for has turned into reading. A journal that
// was only opened over the page has no reason to be waiting when the book is
// closed; one that was open before stays.
export function dismissLoweredJournal() {
  const transient = lowered && !lowered.keepOpen && !raised;
  lowered = null;
  if (transient) closeJournal();
}
// Back from the journal. Over a book that means back to the page.
export function leaveJournal() {
  if (raised?.keepOpen) { closeCardTool(); setMenu(null); setSettingsOpen(false); setRaised(null); }
  else closeJournal();
}
export function closeJournal() {
  if (!view) return;
  closeCardTool();
  setSettingsOpen(false);
  view = null;
  lowered = null;
  setRaised(null);
  els.view.classList.add("hidden");
  document.body.classList.remove("journal-open");
  store.stopPolling();
  renderShelf();
}
export function initJournals(h) {
  host = { ...host, ...h };
  els.newJournal.addEventListener("click", () => {
    const name = prompt("Name the new journal", "");
    if (name === null || !name.trim()) return;
    openJournal(store.createJournal(name).id, { settings: true });
  });
  els.back.addEventListener("click", leaveJournal);
  els.settingsToggle.addEventListener("click", () => setSettingsOpen(!settingsOpen()));
  els.drawer.addEventListener("click", (e) => { if (e.target.hasAttribute("data-close-journal-drawer")) setSettingsOpen(false); });
  // A tap anywhere else puts an open overflow menu away.
  document.addEventListener("click", (e) => { if (view?.menu && !e.target.closest?.('.passage-menu, [data-act="menu"]')) setMenu(null); });
  els.settings.addEventListener("click", onSettingsClick);
  els.settings.addEventListener("change", onSettingsChange);
  els.cards.addEventListener("click", onCardClick);
  // Leaving a field is the moment to catch up on anything held back for it.
  for (const panel of [els.tools, els.settings]) panel.addEventListener("focusout", () => setTimeout(() => { if (view) renderJournal(); }, 0));
  let searchTimer = null;
  els.search.addEventListener("input", () => {
    view.query = els.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { closeCardTool(); renderJournal(); }, 120);
  });
  const bind = (sel, key) => sel.addEventListener("change", () => { view[key] = sel.value; closeCardTool(); renderJournal(); });
  bind(els.filterTag, "tag"); bind(els.filterBook, "book"); bind(els.filterStyle, "style"); bind(els.filterState, "state"); bind(els.sort, "sort");
  document.addEventListener("keydown", (e) => {
    // Under an open book, Escape belongs to the reader.
    if (e.key !== "Escape" || !view || (document.body.classList.contains("reader-open") && !raised)) return;
    if (tagMenu) setTagMenu(null);
    else if (settingsOpen()) setSettingsOpen(false);
    else if (view.menu) setMenu(null);
    else if (view.tool) closeCardTool();
    else leaveJournal();
  });
  store.subscribe(() => { renderShelf(); if (view) renderJournal(); });
  return store.initStore();
}
