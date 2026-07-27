import "./vendor/foliate-js/view.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  openDownload: $("#open-download"), downloadModal: $("#download-modal"),
  refreshLibrary: $("#refresh-library"),
  ircQuery: $("#irc-query"), ircSearch: $("#irc-search"), ircLog: $("#irc-log"), ircResults: $("#irc-results"), stagingResults: $("#staging-results"), addIcon: $("#add-icon"),
  segAdd: $("#seg-add"), segStaging: $("#seg-staging"), paneAdd: $("#pane-add"), paneStaging: $("#pane-staging"),
  library: $("#library"), librarySection: $("#library-section"), inprogress: $("#inprogress"), inprogressSection: $("#inprogress-section"), finished: $("#finished"), finishedSection: $("#finished-section"),
  flatSection: $("#flat-section"), flatResults: $("#flat-results"),
  openMenu: $("#open-menu"), drawer: $("#drawer"), libSearch: $("#lib-search"), viewToggle: $("#view-toggle"), sortToggle: $("#sort-toggle"), sortDir: $("#sort-dir"), filterAuthor: $("#filter-author"), filterGroup: $("#filter-group"), clearFilters: $("#clear-filters"), libFont: $("#lib-font"),
  reader: $("#reader"), viewer: $("#epub-viewer"), readerLoading: $("#reader-loading"), readerClose: $("#reader-close"), tocView: $("#toc-view"), tocList: $("#toc-list"), tocLocation: $("#toc-location"), tocBack: $("#toc-back"), tocToggle: $("#toc-toggle"), tocContentsTab: $("#toc-contents-tab"), tocBookmarksTab: $("#toc-bookmarks-tab"), bookmarksList: $("#bookmarks-list"), bookmarkToggle: $("#bookmark-toggle"), readerTheme: $("#reader-theme"), readerFullscreen: $("#reader-fullscreen"), readerColumns: $("#reader-columns"), readerProgressToggle: $("#reader-progress-toggle"), readerProgress: $("#reader-progress"), readerProgressTrack: $("#reader-progress-track"), readerProgressFill: $("#reader-progress-fill"), readerProgressSegments: $("#reader-progress-segments"), readerProgressLabel: $("#reader-progress-label"), readerProgressCycle: $("#reader-progress-cycle"), sizeToggle: $("#reader-size"), readerFonts: $("#reader-fonts"), readerRefresh: $("#reader-refresh"), readerRefreshPanel: $("#reader-refresh-panel"), readerRefreshSlider: $("#reader-refresh-slider"), readerRefreshValue: $("#reader-refresh-value"), readerFlash: $("#reader-flash"), readerCollapse: $("#reader-collapse"), dictPopover: $("#dict-popover"), hitLeft: $("#reader-hit-left"), hitCenter: $("#reader-hit-center"), hitRight: $("#reader-hit-right"), hitBack: $("#reader-hit-back"), hitMenu: $("#reader-hit-menu"),
};

let currentJob = null;
let pollTimer = null;
let progress = { books: {}, bookmarks: {} };
let allBooks = [];
let allGroups = [];
// Library browsing state. `view` (cover|table), `sort` and `dir` persist; the
// search box and the author/series filters are session-only (reset on reload)
// so reopening the app always shows the whole library.
let libView = JSON.parse(localStorage.getItem("ebook-library.libview") || '{"view":"cover","sort":"series","dir":"asc"}');
// "series" is the default grouped browse; sanitize any stale stored values.
if (!["series", "title", "author", "genre"].includes(libView.sort)) libView.sort = "series";
if (libView.view !== "table") libView.view = "cover";
if (libView.dir !== "desc") libView.dir = "asc";
let libSearch = "";
let libFilter = { author: "", group: "" };
let currentBook = null;
let readerView = null;
// Dictionary popover state: `dictReqId` invalidates stale async lookups,
// `dictDebounce` coalesces the rapid selectionchange events of a drag-select.
let dictReqId = 0;
let dictDebounce = null;
let currentLocation = { fraction: 0, tocHref: null, cfi: null, label: "Bookmark", sectionIndex: 0, timeSection: null, timeTotal: null };
// Cumulative book fraction at each spine section boundary, straight from
// foliate. Chapters are derived from these (see buildChapterModel); the book bar
// segments are built from the chapters. Both are rebuilt once per book.
let sectionFractions = [];
// One entry per chapter: { tocItem, firstSection, lastSection, start, end },
// where start/end are book fractions. See buildChapterModel.
let chapters = [];
// Whole-book reading estimate in minutes, used to derive time left in a chapter.
let bookMinutes = 0;
let progressSegments = [];
let tocTab = "contents";
let bookmarkSaving = false;
// Guards progress saving: stays false during open/restore so the transient
// relocations fired before the book reaches its saved position can't overwrite
// real progress with a near-zero fraction.
let readerReady = false;
let lastRelocateMarker = null;
let pageTurnsSinceRefresh = 0;
let refreshFlashTimer = null;
// The server's `last_opened` token each book is synced to. Keeping this per book
// lets an in-flight save finish safely even if the reader opens another book.
const progressBases = new Map();
// Relocate events can arrive faster than their requests complete. Event
// listeners are not awaited by the browser, so serialize saves to prevent an
// older page request from reaching the server after a newer page request.
let progressSaveChain = Promise.resolve();
let readerSettings = JSON.parse(localStorage.getItem("ebook-library.reader") || '{"theme":"light","fontScale":1,"columns":true,"progress":true,"progressMode":0,"refreshEvery":0}');

// ---- Fonts -------------------------------------------------------------
// Curated reading fonts, served from /vendor/fonts. `stack` is the CSS
// font-family value; `face` is the @font-face CSS injected into both the app
// document (for the UI) and the reader iframe (which can't see style.css).
const SYSTEM_STACK = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const FONTS = [
  { id: "literata", label: "Literata", stack: "Literata,Georgia,serif",
    face: '@font-face{font-family:Literata;src:url("/vendor/fonts/Literata-Variable.ttf");font-weight:200 900}@font-face{font-family:Literata;src:url("/vendor/fonts/Literata-Italic.ttf");font-weight:200 900;font-style:italic}' },
  { id: "vollkorn", label: "Vollkorn", stack: "Vollkorn,Georgia,serif",
    face: '@font-face{font-family:Vollkorn;src:url("/vendor/fonts/Vollkorn-Variable.ttf");font-weight:400 900}@font-face{font-family:Vollkorn;src:url("/vendor/fonts/Vollkorn-Italic.ttf");font-weight:400 900;font-style:italic}' },
  { id: "atkinson", label: "Atkinson Hyperlegible", stack: '"Atkinson Hyperlegible",' + SYSTEM_STACK,
    face: '@font-face{font-family:"Atkinson Hyperlegible";src:url("/vendor/fonts/AtkinsonHyperlegible-Regular.ttf")}@font-face{font-family:"Atkinson Hyperlegible";src:url("/vendor/fonts/AtkinsonHyperlegible-Bold.ttf");font-weight:700}@font-face{font-family:"Atkinson Hyperlegible";src:url("/vendor/fonts/AtkinsonHyperlegible-Italic.ttf");font-style:italic}@font-face{font-family:"Atkinson Hyperlegible";src:url("/vendor/fonts/AtkinsonHyperlegible-BoldItalic.ttf");font-weight:700;font-style:italic}' },
  { id: "nunito", label: "Nunito", stack: "Nunito," + SYSTEM_STACK,
    face: '@font-face{font-family:Nunito;src:url("/vendor/fonts/Nunito-Variable.ttf");font-weight:200 1000}@font-face{font-family:Nunito;src:url("/vendor/fonts/Nunito-Italic.ttf");font-weight:200 1000;font-style:italic}' },
  { id: "system", label: "System default", stack: SYSTEM_STACK, face: "" },
];
const FONT_BY_ID = Object.fromEntries(FONTS.map((f) => [f.id, f]));
function fontById(id, fallback) { return FONT_BY_ID[id] || FONT_BY_ID[fallback]; }
if (!FONT_BY_ID[readerSettings.font]) readerSettings.font = "literata";

// Declare every @font-face in the app document. This does NOT change the app
// chrome (nothing there references these families — the UI keeps the system
// font); it only (1) lets ensureFontAdvance measure the real glyph advance for
// correct sizing, (2) warms the browser cache so the reader iframe paints the
// chosen face immediately instead of a fallback (foliate's paginator doesn't
// reliably repaint when a font finishes loading after the first render), and
// (3) lets the font picker preview each option in its own face.
(function declareFontFaces() {
  const s = document.createElement("style");
  s.textContent = FONTS.map((f) => f.face).join("");
  document.head.appendChild(s);
})();

// The reading font applies only to book content in the reader (not the app
// chrome). The face is injected into the foliate iframe by applyReaderTheme.
function currentReaderFont() { return fontById(readerSettings.font, "literata"); }

// Typography is automatic: a base font size is derived from a target measure
// (characters per line) anchored on the 65-cpl ideal, then the reader's own
// progressive scaling and the user's `fontScale` (the +/- stepper) adjust it.
// The `columns` toggle decides how the column itself is sized: when constrained
// we cap it with a max width (like a print page); when unconstrained the column
// fills the view minus 2rem of device padding, so the font scales up to the
// screen. Either way the font is solved from the *actual* rendered column
// width, so the measure stays sensible at any size the reader dials in.
const READER_BASE_CPL = 65;       // ideal characters/line at fontScale 1.0
const FONT_SCALE_STEP = 1.08;     // each +/- press changes the type ~8%
const FONT_SCALE_MIN = 0.6;       // clamp: smallest the stepper can reach
const FONT_SCALE_MAX = 2.0;       // clamp: largest the stepper can reach
const READER_LINE_HEIGHT = 1.5;   // 150%
const PREV_ZONE_FRAC = 0.15;      // left share of the screen that turns back
const READER_GAP_PCT = 6;         // side padding (% of view) when constrained
const READER_MARGIN_PX = 40;      // top/bottom padding when constrained
const READER_MAX_INLINE = 720;    // max column width (px) when constrained
const READER_PAD_REM = 2;         // device padding (rem) when unconstrained
// Progressive scaling. A fixed cpl makes type scale straight-line with column
// width, so narrow screens get tiny text. Instead we ease the cpl target down
// as the column narrows: the factor is 1 at/above READER_WIDTH_FULL (large
// screens unchanged) and bottoms out at READER_SCALE_MIN at/below
// READER_WIDTH_MIN, interpolating between — so the font grows sub-linearly.
const READER_WIDTH_FULL = 670;    // column px at/above which the cpl is unmodified
const READER_WIDTH_MIN = 520;     // column px at/below which the cpl is eased most
const READER_SCALE_MIN = 0.72;    // floor as a fraction of the cpl target (~+39% type)
// Representative English prose; only its average character advance matters.
const MEASURE_SAMPLE = "In a fluid layout, browser width and typographic measure are linked: the wider the viewport, the more characters appear on each line of text.";
const fontAdvanceCache = {};      // per-font average glyph advance as a fraction of the em
let readerResizeTimer = null;
// Theme toggle shows the CURRENT mode: sun in light mode, moon in dark mode.
const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>';
// Enter/exit fullscreen glyphs for the reader's fullscreen toggle.
const FS_ENTER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>';
const FS_EXIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M21 16h-3a2 2 0 0 0-2 2v3M3 16h3a2 2 0 0 1 2 2v3" /></svg>';
// Column-constraint toggle. "On" (constrained) shows text framed by side
// margins; "off" (full) shows text spanning edge to edge.
const COLUMNS_ON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16M20 4v16" /><path d="M9 8h6M9 12h6M9 16h6" /></svg>';
const COLUMNS_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h18M3 12h18M3 16h18" /></svg>';
// Reading-progress toggle. "On" shows a part-filled bar; "off" an empty one.
const PROGRESS_ON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="10" width="18" height="4" rx="2" /><path d="M6 12h5" stroke-width="3" /></svg>';
const PROGRESS_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="10" width="18" height="4" rx="2" /></svg>';
// The detail cycle a bottom-right tap steps through while progress is on. The
// toolbar button still switches the whole readout on and off; turning it off
// rewinds the cycle so it always resumes at the plain chapter bar.
// `scope`: which bar is drawn. `label`: what (if anything) is written above it.
const PROGRESS_MODES = [
  { scope: "chapter", label: "none", name: "chapter bar" },
  { scope: "chapter", label: "percent", name: "chapter bar + percent" },
  { scope: "chapter", label: "time", name: "chapter bar + time left" },
  { scope: "book", label: "none", name: "book bar" },
  { scope: "book", label: "percent", name: "book bar + percent" },
  { scope: "book", label: "time", name: "book bar + time left" },
];
if (!(readerSettings.fontScale > 0)) readerSettings.fontScale = 1;
readerSettings.fontScale = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, readerSettings.fontScale));
readerSettings.refreshEvery = Math.max(0, Math.min(25, Math.round(Number(readerSettings.refreshEvery) || 0)));

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { window.location.href = "/login"; return new Promise(() => {}); }
  if (!res.ok) {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      throw new Error(data.error || text || `HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(text || `HTTP ${res.status}`);
      throw e;
    }
  }
  return res.json();
}

function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function initials(title) { return String(title || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase(); }
function fmtPercent(v) { return `${Math.round((Number(v) || 0) * 100)}%`; }
function isNewerToken(candidate, base) {
  const candidateTime = Date.parse(candidate), baseTime = Date.parse(base);
  if (Number.isFinite(candidateTime) && Number.isFinite(baseTime)) return candidateTime > baseTime;
  return String(candidate) > String(base);
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const opts = d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

async function loadProgress() {
  try {
    const data = await api("/api/progress");
    progress = data && data.books ? { ...data, bookmarks: data.bookmarks || {} } : { books: {}, bookmarks: {} };
  } catch { progress = { books: {}, bookmarks: {} }; }
}

function bookProgress(book) { return progress.books[book.id] || {}; }
function isFinished(book) { return (book.percent || 0) >= 0.995; }
function isInProgress(book) { return !isFinished(book) && (book.percent || 0) > 0; }

async function saveBookProgress(book, cfi, percent) {
  progress.books[book.id] = { ...(progress.books[book.id] || {}), cfi, percent, last_opened: new Date().toISOString() };
  const save = async () => {
    try {
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book_id: book.id, cfi, percent, base: progressBases.get(book.id) || null }),
      });
      if (res.status === 401) { window.location.href = "/login"; return; }
      const data = await res.json().catch(() => null);
      const entry = data && data.entry;
      if (res.status === 409) {
        // Another device advanced past our baseline. Adopt its position instead
        // of overwriting it, and jump an open reader there.
        if (entry) {
          progress.books[book.id] = entry;
          progressBases.set(book.id, entry.last_opened || null);
          if (currentBook?.id === book.id) await resyncReaderTo(entry);
        }
        return;
      }
      if (res.ok && entry) {
        progress.books[book.id] = entry;
        progressBases.set(book.id, entry.last_opened || null);
      }
    } catch {}
  };
  progressSaveChain = progressSaveChain.then(save, save);
  return progressSaveChain;
}

// Jump the open reader to a server-authoritative position (after a stale-write
// rejection or a focus refresh). No-ops when there's nothing to move to.
async function resyncReaderTo(entry) {
  if (!readerView || !readerReady || !entry || !entry.cfi) return;
  try { await readerView.goTo(entry.cfi); } catch {}
}

// When this tab regains focus, another device may have moved ahead while it sat
// idle showing an old position. Pull the latest and catch up before the user can
// trigger a relocate that would save the stale spot.
async function refreshOpenReaderProgress() {
  if (!currentBook || !readerView || !readerReady) return;
  let entry, data;
  try { data = await api("/api/progress"); entry = data && data.books ? data.books[currentBook.id] : null; }
  catch { return; }
  progress.bookmarks ||= {};
  progress.bookmarks[currentBook.id] = data.bookmarks?.[currentBook.id] || [];
  if (!progress.bookmarks[currentBook.id].length) delete progress.bookmarks[currentBook.id];
  updateBookmarkButton();
  if (tocTab === "bookmarks") renderBookmarks();
  if (!entry || !entry.last_opened) return;
  const base = progressBases.get(currentBook.id);
  if (base && isNewerToken(entry.last_opened, base)) {
    progress.books[currentBook.id] = entry;
    progressBases.set(currentBook.id, entry.last_opened);
    await resyncReaderTo(entry);
  }
}

async function loadLibrary() {
  await loadProgress();
  try {
    const res = await api("/api/library");
    setLibraryData(res);
    renderSections();
  } catch (e) { els.library.innerHTML = `<div class="lib-empty">Couldn't load library: ${escapeHtml(e.message)}</div>`; }
}

function setLibraryData(res) {
  allBooks = (res.books || []).map((b) => ({ ...b, ...(progress.books[b.id] || {}) }));
  allGroups = (res.groups || []).map((g) => ({
    ...g,
    books: (g.books || []).map((b) => ({ ...b, ...(progress.books[b.id] || {}) })),
  }));
  populateFilters();
}

function bookKind(b) { return isFinished(b) ? "complete" : isInProgress(b) ? "inprogress" : "library"; }

// Per-sort ordering key (how books are ranked) and section key (the header a
// book falls under). "series" uses the folder/group for both — that's the
// default grouped browse. Alphabetical sorts header by first letter; genre by
// its name (same "header per group" pattern as series).
const ORDER_KEYS = {
  series: (b) => displaySeriesName(b.group || ""),
  title: (b) => b.title || "",
  author: (b) => b.author || "",
  genre: (b) => b.genre || "",
};
function firstLetter(s) {
  const c = (s || "").trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}
// Library convention: a leading "The" moves to the end for display and
// ordering, so a series/folder named "The Peripheral" lists as "Peripheral, The".
function displaySeriesName(name) {
  const s = (name || "").trim();
  const m = /^the\s+(.+)$/i.exec(s);
  return m ? `${m[1]}, The` : s;
}
// Series names already present in the library, for the staging form's Series
// autocomplete. Books carry an explicit `series` from their EPUB metadata;
// folder names count too, since a series folder is often the only place the
// name is recorded. That mix is why names are deduped on the same leading-"The"
// -insensitive key the library sorts by: a folder "dark tower" and a metadata
// "The Dark Tower" are one series, not two suggestions. Metadata is added first
// so its spelling is the one offered. Values stay as recorded — the "The" flip
// is for display only and would be wrong to write into a book's metadata.
function knownSeriesNames() {
  const seen = new Map();
  const add = (raw) => {
    const name = (raw || "").trim();
    if (!name || name === "Library") return;
    const key = displaySeriesName(name).replace(/,\s*the$/i, "").toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  };
  for (const b of allBooks) add(b.series);
  for (const b of allBooks) add(b.group);
  return [...seen.values()].sort((a, b) =>
    displaySeriesName(a).localeCompare(displaySeriesName(b), undefined, { sensitivity: "base" }));
}
const SECTION_KEYS = {
  series: (b) => b.group || "Library",
  title: (b) => firstLetter(b.title),
  author: (b) => firstLetter(b.author),
  genre: (b) => b.genre || "No genre",
};

// Home = the default series view with nothing else applied; the only state that
// shows the In Progress / Complete rails and the backend folder order. Any
// search, filter, or non-series sort switches to the grouped results view.
function libIsHome() {
  return libView.sort === "series" && !libSearch.trim() && !libFilter.author && !libFilter.group;
}
function bookMatchesFilter(b) {
  if (libFilter.author && (b.author || "") !== libFilter.author) return false;
  if (libFilter.group && (b.group || "") !== libFilter.group) return false;
  const q = libSearch.trim().toLowerCase();
  if (q && !`${b.title || ""} ${b.author || ""} ${b.series || ""}`.toLowerCase().includes(q)) return false;
  return true;
}
function sortBooks(books) {
  const key = ORDER_KEYS[libView.sort] || ORDER_KEYS.title;
  const dir = libView.dir === "desc" ? -1 : 1;
  return [...books].sort((a, b) => {
    const ka = key(a).trim(), kb = key(b).trim();
    if (!ka !== !kb) return ka ? -1 : 1;   // blanks always sort to the end
    return ka.localeCompare(kb, undefined, { sensitivity: "base", numeric: true }) * dir;
  });
}
// Group an already-sorted list into consecutive sections by the sort's section
// key (preserves sorted order; "#"/blank headers land naturally at the end).
function sectionize(books, sort) {
  const keyFn = SECTION_KEYS[sort] || SECTION_KEYS.title;
  const out = [];
  let cur = null;
  for (const b of books) {
    const name = keyFn(b);
    if (!cur || cur.name !== name) { cur = { name, books: [] }; out.push(cur); }
    cur.books.push(b);
  }
  return out;
}

// Render a list of books into a container as either a cover grid or a table.
function fillBooks(el, books, kind) {
  el.innerHTML = "";
  if (libView.view === "table") {
    el.classList.remove("library", "group-grid");
    el.classList.add("as-table");
    el.appendChild(renderTable(books, kind));
  } else {
    el.classList.remove("as-table");
    el.classList.add("library");
    for (const b of books) el.appendChild(renderCard(b, kind || bookKind(b)));
  }
}
function renderTable(books, kind) {
  const table = document.createElement("table");
  table.className = "book-table";
  const tb = document.createElement("tbody");
  for (const b of books) tb.appendChild(renderTableRow(b, kind || bookKind(b)));
  table.appendChild(tb);
  return table;
}
function renderTableRow(b, kind) {
  const tr = document.createElement("tr");
  tr.className = "book-row";
  const cover = b.cover_url ? `<img class="row-cover" src="${b.cover_url}" alt="" loading="lazy" decoding="async">` : `<div class="row-cover row-cover-ph">${escapeHtml(initials(b.title))}</div>`;
  let status = "", reset = "";
  if (kind === "inprogress") status = fmtPercent(b.percent);
  else if (kind === "complete") status = "Finished";
  if (kind !== "library") reset = `<button class="reset-btn" data-reset title="Reset progress" aria-label="Reset progress">${RESET_ICON}</button>`;
  tr.innerHTML = `<td class="c-cover">${cover}</td>` +
    `<td class="c-title"><span class="row-title">${escapeHtml(b.title)}</span></td>` +
    `<td class="c-author">${escapeHtml(b.author || "")}</td>` +
    `<td class="c-status"><span class="row-status">${escapeHtml(status)}</span>${reset}</td>`;
  tr.addEventListener("click", () => openReader(b));
  const rb = tr.querySelector("[data-reset]");
  if (rb) rb.addEventListener("click", (e) => { e.stopPropagation(); resetProgress(b); });
  return tr;
}

// One titled section (plain h2 header + cover grid or table) appended to a
// container. Same h2 as the top-level section titles — no count, no variation.
function appendGroupBlock(container, name, books, kind) {
  const block = document.createElement("section");
  block.className = "book-group";
  block.innerHTML = `<div class="lib-head"><h2>${escapeHtml(name)}</h2></div><div class="group-grid"></div>`;
  fillBooks(block.querySelector(".group-grid"), books, kind);
  container.appendChild(block);
}
function renderSections() {
  const home = libIsHome();
  els.flatSection.classList.toggle("hidden", home);
  els.librarySection.classList.toggle("hidden", !home);
  els.inprogressSection.classList.add("hidden");
  els.finishedSection.classList.add("hidden");
  if (!home) { renderResults(); return; }
  // Home: in-progress rail, folder-grouped library, finished rail.
  const inprog = allBooks.filter(isInProgress);
  const finished = allBooks.filter(isFinished);
  els.inprogressSection.classList.toggle("hidden", !inprog.length);
  if (inprog.length) fillBooks(els.inprogress, inprog, "inprogress");
  els.finishedSection.classList.toggle("hidden", !finished.length);
  if (finished.length) fillBooks(els.finished, finished, "complete");
  els.library.innerHTML = "";
  if (!allBooks.length) { els.library.innerHTML = `<div class="lib-empty">No EPUBs found in the library folder.</div>`; return; }
  const ordered = [...allGroups].sort((a, b) =>
    displaySeriesName(a.name).localeCompare(displaySeriesName(b.name), undefined, { sensitivity: "base" }));
  for (const group of ordered) {
    if (group.books.length) appendGroupBlock(els.library, displaySeriesName(group.name), group.books, "library");
  }
}
function renderResults() {
  const books = sortBooks(allBooks.filter(bookMatchesFilter));
  els.flatResults.className = "";
  els.flatResults.innerHTML = "";
  if (!books.length) { els.flatResults.innerHTML = `<div class="lib-empty">No books match your search and filters.</div>`; return; }
  for (const sec of sectionize(books, libView.sort)) appendGroupBlock(els.flatResults, libView.sort === "series" ? displaySeriesName(sec.name) : sec.name, sec.books, null);
}

// Rebuild the author/series filter dropdowns from the current library, keeping
// the active selection if it still exists.
function fillSelect(sel, values, current, allLabel, labelFn) {
  if (!sel) return;
  const lbl = labelFn || ((v) => v);
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(lbl(v))}</option>`).join("");
  sel.value = values.includes(current) ? current : "";
}
function populateFilters() {
  const uniq = (key) => [...new Set(allBooks.map((b) => b[key]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  if (!allBooks.some((b) => b.author === libFilter.author)) libFilter.author = "";
  if (!allBooks.some((b) => b.group === libFilter.group)) libFilter.group = "";
  const groups = [...new Set(allBooks.map((b) => b.group).filter(Boolean))]
    .sort((a, b) => displaySeriesName(a).localeCompare(displaySeriesName(b), undefined, { sensitivity: "base" }));
  fillSelect(els.filterAuthor, uniq("author"), libFilter.author, "All authors");
  fillSelect(els.filterGroup, groups, libFilter.group, "All series / folders", displaySeriesName);
}
// Reflect libView/libSearch/libFilter in the drawer controls.
function updateLibControls() {
  els.libSearch.value = libSearch;
  els.viewToggle.textContent = libView.view === "table" ? "Table" : "Cover";
  els.sortToggle.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("active", b.dataset.sort === libView.sort));
  els.sortDir.textContent = libView.dir === "desc" ? "Z → A" : "A → Z";
  // "series" groups by folder in a fixed order, so direction doesn't apply.
  els.sortDir.disabled = libView.sort === "series";
  if (els.filterAuthor) els.filterAuthor.value = libFilter.author;
  if (els.filterGroup) els.filterGroup.value = libFilter.group;
  if (els.libFont) els.libFont.value = readerSettings.font;
}
function populateFontSelect() {
  if (!els.libFont) return;
  els.libFont.innerHTML = FONTS.map((f) => `<option value="${f.id}">${escapeHtml(f.label)}</option>`).join("");
  els.libFont.value = readerSettings.font;
}
function saveLibView() { localStorage.setItem("ebook-library.libview", JSON.stringify({ view: libView.view, sort: libView.sort, dir: libView.dir })); }

const RESET_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>';
function resumeStrip(label, iso) {
  const date = fmtDate(iso);
  return `<div class="resume-strip"><span>${escapeHtml(label)}${date ? ` · ${escapeHtml(date)}` : ""}</span>` +
    `<button class="reset-btn" data-reset title="Reset progress" aria-label="Reset progress">${RESET_ICON}</button></div>`;
}
function renderCard(b, kind) {
  const card = document.createElement("div");
  card.className = "series-card";
  const cover = b.cover_url ? `<img class="cover" src="${b.cover_url}" alt="" loading="lazy" decoding="async">` : `<div class="cover-placeholder">${escapeHtml(initials(b.title))}</div>`;
  let strip = "";
  if (kind === "inprogress") strip = resumeStrip(fmtPercent(b.percent), b.last_opened);
  else if (kind === "complete") strip = resumeStrip("Finished", b.last_opened);
  card.innerHTML = `${cover}${strip}`;
  card.title = b.title;
  card.addEventListener("click", () => openReader(b));
  const resetBtn = card.querySelector("[data-reset]");
  if (resetBtn) resetBtn.addEventListener("click", (e) => { e.stopPropagation(); resetProgress(b); });
  return card;
}
async function resetProgress(book) {
  if (!confirm(`Reset reading progress for "${book.title}"?`)) return;
  try {
    await api("/api/progress/reset", { method: "POST", body: JSON.stringify({ book_id: book.id }) });
  } catch (e) { alert("Couldn't reset progress: " + e.message); return; }
  await loadLibrary();
}

function openModal(el, focusEl) { el.classList.remove("hidden"); if (focusEl) focusEl.focus(); }
function closeModal(el) { el.classList.add("hidden"); }

function appendLog(el, line) { el.textContent += (el.textContent ? "\n" : "") + line; el.scrollTop = el.scrollHeight; }
function finishJob() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; currentJob = null; }
async function pollJob(logEl, onDone) {
  if (!currentJob) return;
  try {
    const res = await api(`/api/jobs/${currentJob.id}?since=${currentJob.next}`);
    currentJob.next = res.next;
    for (const line of res.lines) appendLog(logEl, line);
    if (res.done) { if (res.error) appendLog(logEl, `ERROR: ${res.error}`); finishJob(); if (onDone) onDone(res); return; }
  } catch (e) { appendLog(logEl, `Polling error: ${e.message}`); }
  pollTimer = setTimeout(() => pollJob(logEl, onDone), 1000);
}

function setAddTab(tab) {
  const staging = tab === "staging";
  els.paneAdd.classList.toggle("hidden", staging);
  els.paneStaging.classList.toggle("hidden", !staging);
  els.segAdd.classList.toggle("active", !staging);
  els.segAdd.setAttribute("aria-selected", String(!staging));
  els.segStaging.classList.toggle("active", staging);
  els.segStaging.setAttribute("aria-selected", String(staging));
}
function updateStagingTab(count) {
  // When IRC is off the Add tab is gone, so the Staging tab is the only
  // option — never disable it, and never bounce to the missing Add tab.
  els.segStaging.disabled = HAS_IRC && count === 0;
  els.segStaging.textContent = count > 1 ? `${count} staging` : "Staging";
  if (HAS_IRC && count === 0 && els.segStaging.classList.contains("active")) setAddTab("add");
  // Nothing to do in the modal if there's no IRC search AND no staged files.
  els.openDownload.disabled = !HAS_IRC && count === 0;
  els.openDownload.title = els.openDownload.disabled
    ? "No staged books — drop .epub files into the staging folder"
    : els.openDownload.title;
}
async function loadStaging() {
  if (!els.stagingResults) return;
  try {
    const res = await api("/api/staging");
    const items = res.items || [];
    renderStaging(items);
    updateStagingTab(items.length);
  } catch (e) {
    els.stagingResults.innerHTML = `<div class="lib-empty">Couldn't load staging: ${escapeHtml(e.message)}</div>`;
  }
}
function renderStaging(items) {
  if (!items.length) { els.stagingResults.innerHTML = `<div class="lib-empty">No staged books.</div>`; return; }
  const item = items[0];
  const queueNote = items.length > 1 ? `<div class="lib-empty">${items.length - 1} more staged book${items.length === 2 ? "" : "s"} waiting.</div>` : "";
  els.stagingResults.innerHTML = `
    ${queueNote}
    <div class="staging-item" data-stage-id="${escapeHtml(item.id)}" data-stage-filename="${escapeHtml(item.filename)}">
      <div class="staging-title">${escapeHtml(item.filename)}</div>
      <div class="staging-grid">
        <label>Title<input data-meta="title" type="text" value="${escapeHtml(item.title || "")}" autocomplete="off"></label>
        <label>Author<input data-meta="author" type="text" value="${escapeHtml(item.author || "")}" autocomplete="off"></label>
        <label>Series<input data-meta="series" type="text" list="staging-series-options" value="${escapeHtml(item.series || "")}" autocomplete="off"></label>
        <label>Book #<input data-meta="series_index" type="text" inputmode="decimal" value="${escapeHtml(item.series_index || "")}" autocomplete="off"></label>
      </div>
      <div class="cover-tools">
        <button type="button" class="btn ghost" data-cover-search="${escapeHtml(item.id)}">Find covers</button>
        <div class="cover-candidates" data-cover-candidates></div>
      </div>
      <div class="row"><button class="btn primary" data-stage-import="${escapeHtml(item.id)}">Import</button></div>
    </div>
    <datalist id="staging-series-options">${knownSeriesNames().map((name) => `<option value="${escapeHtml(name)}"></option>`).join("")}</datalist>
  `;
  els.stagingResults.querySelectorAll("[data-cover-search]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = button.closest("[data-stage-id]");
      const payload = { filename: item.dataset.stageFilename || "" };
      item.querySelectorAll("[data-meta]").forEach((input) => { payload[input.dataset.meta] = input.value.trim(); });
      const target = item.querySelector("[data-cover-candidates]");
      button.disabled = true;
      target.innerHTML = `<div class="lib-empty">Searching...</div>`;
      try {
        const res = await api(`/api/staging/${encodeURIComponent(button.dataset.coverSearch)}/cover-candidates`, { method: "POST", body: JSON.stringify(payload) });
        renderCoverCandidates(target, res.candidates || []);
      } catch (e) {
        target.innerHTML = `<div class="lib-empty">Couldn't find covers: ${escapeHtml(e.message)}</div>`;
      } finally {
        button.disabled = false;
      }
    });
  });
  els.stagingResults.querySelectorAll("[data-stage-import]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = button.closest("[data-stage-id]");
      const payload = { filename: item.dataset.stageFilename || "" };
      item.querySelectorAll("[data-meta]").forEach((input) => { payload[input.dataset.meta] = input.value.trim(); });
      const selected = item.querySelector("[data-cover-url].selected");
      if (selected) payload.cover_url = selected.dataset.coverUrl;
      button.disabled = true;
      try {
        const res = await api(`/api/staging/${encodeURIComponent(button.dataset.stageImport)}/import`, { method: "POST", body: JSON.stringify(payload) });
        setLibraryData(res);
        renderSections();
        await loadStaging();
      } catch (e) {
        alert("Couldn't import book: " + e.message);
        button.disabled = false;
      }
    });
  });
}
function renderCoverCandidates(target, candidates) {
  if (!candidates.length) { target.innerHTML = `<div class="lib-empty">No cover matches found.</div>`; return; }
  target.innerHTML = candidates.map((c) => `
    <button type="button" class="cover-choice" data-cover-url="${escapeHtml(c.url)}" title="${escapeHtml(c.source)}: ${escapeHtml(c.label)}">
      <img src="/api/cover-proxy?url=${encodeURIComponent(c.url)}" alt="" loading="lazy" decoding="async">
      <span>${escapeHtml(c.source)}</span>
    </button>
  `).join("");
  target.querySelectorAll("[data-cover-url]").forEach((button) => {
    button.addEventListener("click", () => {
      target.querySelectorAll("[data-cover-url]").forEach((b) => b.classList.remove("selected"));
      button.classList.add("selected");
    });
  });
}

els.openDownload.addEventListener("click", () => { setAddTab(HAS_IRC ? "add" : "staging"); openModal(els.downloadModal, HAS_IRC ? els.ircQuery : null); loadStaging(); });
els.downloadModal.addEventListener("click", (e) => { if (e.target === els.downloadModal || e.target.hasAttribute("data-close-modal")) closeModal(els.downloadModal); });
els.segAdd.addEventListener("click", () => setAddTab("add"));
els.segStaging.addEventListener("click", () => { if (!els.segStaging.disabled) setAddTab("staging"); });

els.ircSearch.addEventListener("click", async () => {
  const query = els.ircQuery.value.trim();
  if (!query) return alert("Enter a search query.");
  els.ircLog.textContent = ""; els.ircLog.classList.remove("hidden"); els.ircResults.innerHTML = "";
  try { const res = await api("/api/irc/search", { method: "POST", body: JSON.stringify({ query }) }); currentJob = { id: res.job_id, next: 0 }; pollJob(els.ircLog, renderIrcResults); }
  catch (e) { appendLog(els.ircLog, `ERROR: ${e.message}`); }
});
function renderIrcResults(res) {
  const results = res.result || [];
  els.ircResults.innerHTML = results.length ? results.map((r, i) => `
    <div class="irc-result">
      <div class="irc-result-main">
        <div class="irc-title">${escapeHtml(r.filename)}</div>
        <div class="irc-meta">${escapeHtml(r.size || "size unknown")} · ${escapeHtml(r.bot)}</div>
      </div>
      <button class="btn ghost" data-irc-index="${i}">Download</button>
    </div>
  `).join("") : "<div class='lib-empty'>No EPUB results found.</div>";
  els.ircResults.querySelectorAll("[data-irc-index]").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = results[Number(button.dataset.ircIndex)];
      els.ircLog.classList.remove("hidden");
      appendLog(els.ircLog, `Requesting ${result.filename}`);
      try {
        const started = await api("/api/irc/download", { method: "POST", body: JSON.stringify({ result }) });
        currentJob = { id: started.job_id, next: 0 };
        pollJob(els.ircLog, loadStaging);
      } catch (e) {
        appendLog(els.ircLog, `ERROR: ${e.message}`);
      }
    });
  });
}

// Resolve once the viewer has a real (non-zero) width, so foliate measures and
// navigates against a laid-out container instead of a 0px one. Falls back after
// a timeout so a stuck layout never hangs the open.
function awaitViewerSize(timeout = 2000) {
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => {
      if ((els.viewer.clientWidth || 0) > 0 || performance.now() - start > timeout) resolve();
      else requestAnimationFrame(check);
    };
    check();
  });
}
async function openReader(book) {
  readerReady = false;
  lastRelocateMarker = null;
  pageTurnsSinceRefresh = 0;
  els.reader.classList.remove("hidden"); document.body.classList.add("reader-open");
  // Re-pull progress from the server before restoring position. The in-memory
  // `progress` map can be stale if this tab has been open while another device
  // advanced; restoring (and then re-saving) that stale spot is what clobbers
  // newer cross-device progress.
  try {
    await loadProgress();
    const fresh = progress.books[book.id];
    if (fresh) book = { ...book, ...fresh };
    progressBases.set(book.id, fresh ? fresh.last_opened || null : null);
  } catch { progressBases.set(book.id, null); }
  currentBook = book;
  els.reader.classList.remove("chrome-hidden");
  // Opening + parsing a book can take a few seconds; show a loading overlay so
  // the reader isn't just a blank screen until the first page renders.
  els.readerLoading.textContent = "Loading…"; els.readerLoading.classList.remove("hidden");
  els.viewer.innerHTML = ""; els.tocList.innerHTML = ""; els.bookmarksList.innerHTML = ""; closeTocView();
  currentLocation = { fraction: 0, tocHref: null, cfi: null, label: "Bookmark", sectionIndex: 0, timeSection: null, timeTotal: null };
  sectionFractions = []; chapters = []; bookMinutes = 0; progressSegments = [];
  if (els.readerProgressSegments) els.readerProgressSegments.innerHTML = "";
  updateBookmarkButton();
  readerView = document.createElement("foliate-view");
  readerView.className = "foliate-reader";
  els.viewer.appendChild(readerView);
  readerView.addEventListener("relocate", async (e) => {
    // First real position means the page has rendered — drop the loading overlay.
    els.readerLoading.classList.add("hidden");
    closeDictPopover();
    const loc = e.detail || {};
    noteReaderRelocate(loc);
    currentLocation = {
      fraction: loc.fraction || 0,
      tocHref: loc.tocItem?.href || null,
      cfi: loc.cfi || null,
      label: tocItemLabel(loc.tocItem),
      // foliate derives these from the spine section sizes: which section we're
      // in, and the minutes left in it and in the whole book.
      sectionIndex: loc.section?.current ?? 0,
      timeSection: Number.isFinite(loc.time?.section) ? loc.time.section : null,
      timeTotal: Number.isFinite(loc.time?.total) ? loc.time.total : null,
    };
    updateProgressUI();
    updateBookmarkButton();
    if (!els.tocView.classList.contains("hidden")) updateTocView();
    if (readerReady) await saveBookProgress(book, loc.cfi || null, loc.fraction || 0);
  });
  // The book renders in a sandboxed iframe that captures keyboard focus, so
  // forward key events from each loaded chapter document to our handler too.
  readerView.addEventListener("load", (e) => {
    const doc = e.detail?.doc;
    if (!doc) return;
    // Listen on both the document and its window, in capture phase, so a
    // forwarded hardware/volume key is caught no matter how it's dispatched.
    doc.addEventListener("keydown", handleReaderKey, true);
    doc.defaultView?.addEventListener("keydown", handleReaderKey, true);
    wireReaderInput(doc);
    // Each page turn into a new section spawns a fresh iframe; foliate only
    // refocuses it when the old view already had focus, so after using the
    // toolbar the new section can end up with no focused, wired frame — and
    // hardware page-turn keys go nowhere. Force focus onto this loaded section.
    try { readerView.renderer?.focusView?.(); } catch {}
  });
  await ensureFontAdvance(currentReaderFont());
  try {
    await readerView.open(`/api/book/${book.id}/file`);
  } catch {
    els.readerLoading.textContent = "Couldn't open this book.";
    return;
  }
  // The TOC is available as soon as the book is parsed; render it now so it
  // never depends on layout/render timing (which is flaky on slow devices).
  els.tocList.innerHTML = renderToc(readerView.book?.toc || []);
  // Section sizes and the TOC are known once the book is parsed; group the spine
  // into chapters and build the book bar's segments now so the first relocate
  // can paint them.
  try { sectionFractions = readerView.getSectionFractions?.() || []; } catch { sectionFractions = []; }
  buildChapterModel();
  buildProgressSegments();
  readerView.renderer.setAttribute("flow", "paginated");
  readerView.renderer.setAttribute("max-column-count", "1");
  // Wait for the viewer to have a real size before measuring/navigating — on
  // device it is still 0px right after un-hiding, which made the restore to the
  // saved position miss (leaving the book at the start) until a manual goTo.
  await awaitViewerSize();
  applyReaderTheme();
  try {
    await readerView.init({ lastLocation: book.cfi || null, showTextStart: true });
  } catch {
    // A stale/unresolvable CFI shouldn't blank the reader — open at the start.
    try { await readerView.init({ lastLocation: null, showTextStart: true }); } catch {}
  }
  applyReaderTheme();
  els.readerLoading.classList.add("hidden");
  els.tocList.innerHTML = renderToc(readerView.book.toc || []);
  // Re-assert the saved position once layout has settled; the first goTo during
  // init can land short if the view was still sizing (this is the same path that
  // "picking a chapter" exercises). Only then do we allow progress to save.
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    if (book.cfi) { try { await readerView.goTo(book.cfi); } catch {} }
    applyReaderTheme();
    readerReady = true;
  }));
}
function renderToc(items, depth = 0) {
  return items.map((i) => {
    const label = typeof i.label === "string" ? i.label : Object.values(i.label || {})[0] || "Chapter";
    const children = i.subitems || i.children || [];
    return `<button class="toc-item" data-href="${escapeHtml(i.href)}" style="padding-left:${16 + depth * 18}px">${escapeHtml(label)}</button>${children.length ? renderToc(children, depth + 1) : ""}`;
  }).join("");
}
function tocItemLabel(item) {
  if (!item) return "Bookmark";
  if (typeof item.label === "string") return item.label || "Bookmark";
  return Object.values(item.label || {})[0] || "Bookmark";
}
function currentBookmarks() {
  return currentBook ? (progress.bookmarks?.[currentBook.id] || []) : [];
}
function currentBookmark() {
  return currentLocation.cfi ? currentBookmarks().find((item) => item.cfi === currentLocation.cfi) : null;
}
function updateBookmarkButton() {
  if (!els.bookmarkToggle) return;
  const marked = !!currentBookmark();
  const available = !!currentBook && !!currentLocation.cfi;
  els.bookmarkToggle.classList.toggle("active", marked);
  els.bookmarkToggle.classList.toggle("unavailable", !available);
  els.bookmarkToggle.setAttribute("aria-pressed", String(marked));
  els.bookmarkToggle.setAttribute("aria-label", marked ? "Remove bookmark" : "Add bookmark");
  els.bookmarkToggle.title = marked ? "Remove bookmark" : "Add bookmark";
}
function renderBookmarks() {
  const items = currentBookmarks().slice().sort((a, b) => (a.percent || 0) - (b.percent || 0));
  els.bookmarksList.innerHTML = items.length ? items.map((item) => {
    const pct = Math.round((Number(item.percent) || 0) * 100);
    const date = fmtDate(item.created_at);
    return `<button class="toc-item bookmark-item" data-cfi="${escapeHtml(item.cfi)}"><span class="bookmark-item-label">${escapeHtml(item.label || "Bookmark")}</span><span class="bookmark-item-meta">${pct}% through${date ? ` · ${escapeHtml(date)}` : ""}</span></button>`;
  }).join("") : '<div class="bookmarks-empty">No bookmarks yet. Tap the upper-right corner of a page to add one.</div>';
}
function setTocTab(tab) {
  tocTab = tab === "bookmarks" ? "bookmarks" : "contents";
  const bookmarks = tocTab === "bookmarks";
  els.tocContentsTab.classList.toggle("active", !bookmarks);
  els.tocBookmarksTab.classList.toggle("active", bookmarks);
  els.tocContentsTab.setAttribute("aria-selected", String(!bookmarks));
  els.tocBookmarksTab.setAttribute("aria-selected", String(bookmarks));
  els.tocList.classList.toggle("hidden", bookmarks);
  els.bookmarksList.classList.toggle("hidden", !bookmarks);
  els.tocLocation.classList.toggle("hidden", bookmarks);
  if (bookmarks) { renderBookmarks(); els.bookmarksList.scrollTop = 0; }
}
async function toggleBookmark() {
  if (bookmarkSaving || !currentBook || !currentLocation.cfi) return;
  bookmarkSaving = true;
  const bookId = currentBook.id;
  const cfi = currentLocation.cfi;
  const bookmarked = !currentBookmark();
  try {
    const data = await api("/api/bookmarks", {
      method: "POST",
      body: JSON.stringify({
        book_id: bookId,
        cfi,
        bookmarked,
        percent: currentLocation.fraction || 0,
        label: currentLocation.label || "Bookmark",
      }),
    });
    progress.bookmarks ||= {};
    progress.bookmarks[bookId] = data.bookmarks || [];
    if (!progress.bookmarks[bookId].length) delete progress.bookmarks[bookId];
    updateBookmarkButton();
    if (tocTab === "bookmarks") renderBookmarks();
  } catch (e) {
    alert(`Couldn't ${bookmarked ? "add" : "remove"} bookmark: ${e.message}`);
  } finally {
    bookmarkSaving = false;
  }
}
// Highlight the chapter the reader is currently in, and return its button.
function markCurrentTocItem() {
  let current = null;
  els.tocList.querySelectorAll(".toc-item").forEach((b) => {
    const on = !!currentLocation.tocHref && b.dataset.href === currentLocation.tocHref;
    b.classList.toggle("current", on);
    if (on) current = b;
  });
  return current;
}
function updateTocView() {
  const pct = Math.round((currentLocation.fraction || 0) * 100);
  els.tocLocation.innerHTML = `You're about <span class="pct">${pct}%</span> through.`;
  return markCurrentTocItem();
}
function openTocView() {
  closeReaderPopups();
  closeDictPopover();
  const current = updateTocView();
  setTocTab("contents");
  els.tocView.classList.remove("hidden");
  if (current) current.scrollIntoView({ block: "center" });
  else els.tocList.scrollTop = 0;
}
function closeTocView() { els.tocView.classList.add("hidden"); }
function closeReader() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); if (readerView) { readerView.close(); readerView.remove(); } readerView = null; currentBook = null; lastRelocateMarker = null; pageTurnsSinceRefresh = 0; clearTimeout(refreshFlashTimer); closeTocView(); closeReaderPopups(); closeDictPopover(); els.reader.classList.add("hidden"); document.body.classList.remove("reader-open"); loadLibrary(); }
function saveReaderSettings() { localStorage.setItem("ebook-library.reader", JSON.stringify(readerSettings)); }
// Measure a font's average glyph advance once (it never changes for a face), so
// we can solve for the font size that yields a given characters-per-line measure.
async function ensureFontAdvance(font) {
  if (fontAdvanceCache[font.id]) return fontAdvanceCache[font.id];
  const primary = font.stack.split(",")[0];
  try { await document.fonts.load(`100px ${primary}`); await document.fonts.ready; } catch {}
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `100px ${font.stack}`;
  const width = ctx.measureText(MEASURE_SAMPLE).width;
  fontAdvanceCache[font.id] = (width / MEASURE_SAMPLE.length) / 100;
  return fontAdvanceCache[font.id];
}
// The width of a single text column, as foliate has actually laid it out.
function readerColumnWidth() {
  try {
    const doc = readerView?.renderer?.getContents?.()[0]?.doc;
    if (doc) {
      const cw = parseFloat(getComputedStyle(doc.documentElement).columnWidth);
      if (cw > 0) return cw;
    }
  } catch {}
  // Fallback before the document has rendered: approximate from the view width.
  const w = els.viewer.clientWidth || window.innerWidth;
  return w * (1 - READER_GAP_PCT / 100);
}
// How much to ease the cpl target for a given column width (1 = no easing on
// large screens, down to READER_SCALE_MIN on small ones).
function progressiveCplFactor(colWidth) {
  if (colWidth >= READER_WIDTH_FULL) return 1;
  if (colWidth <= READER_WIDTH_MIN) return READER_SCALE_MIN;
  const t = (colWidth - READER_WIDTH_MIN) / (READER_WIDTH_FULL - READER_WIDTH_MIN);
  return READER_SCALE_MIN + (1 - READER_SCALE_MIN) * t;
}
// font_size = column_width / (eased_target_cpl * advance) * user fontScale
function computeReaderFontSize() {
  const advance = fontAdvanceCache[currentReaderFont().id] || 0.5;
  const w = readerColumnWidth();
  const cpl = READER_BASE_CPL * progressiveCplFactor(w);
  return (w / (cpl * advance)) * (readerSettings.fontScale || 1);
}
function updateSizeButtons() {
  if (!els.sizeToggle) return;
  const s = readerSettings.fontScale || 1;
  els.sizeToggle.querySelectorAll("button[data-step]").forEach((b) => {
    const up = Number(b.dataset.step) > 0;
    b.disabled = up ? s >= FONT_SCALE_MAX - 1e-6 : s <= FONT_SCALE_MIN + 1e-6;
  });
}
function columnsConstrained() { return readerSettings.columns !== false; }
function rootFontPx() { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; }
function updateColumnsButton() {
  if (!els.readerColumns) return;
  const constrained = columnsConstrained();
  els.readerColumns.innerHTML = constrained ? COLUMNS_ON_SVG : COLUMNS_OFF_SVG;
  els.readerColumns.title = constrained ? "Column width: constrained" : "Column width: fill screen";
}
function progressEnabled() { return readerSettings.progress !== false; }
// The chapter containing the current position, or null before the first
// relocate. Keyed off the spine index rather than the book fraction: on the last
// page of a section foliate's fraction includes a one-page lookahead that can
// tip just past the chapter boundary, which would flip the bar a page early.
function currentChapter() {
  const index = currentLocation.sectionIndex ?? 0;
  return chapters.find((c) => index >= c.firstSection && index <= c.lastSection) || null;
}
// How far through the current chapter we are, 0-1. foliate's fraction is
// page-granular ((page - 1) / (pages - 2) within a section, plus one page of
// lookahead) so this reaches a true 100% on the chapter's last page.
function chapterFraction() {
  const chapter = currentChapter();
  if (!chapter) return sectionFraction();
  const span = chapter.end - chapter.start;
  if (!(span > 0)) return sectionFraction();
  return Math.min(1, Math.max(0, ((currentLocation.fraction || 0) - chapter.start) / span));
}
// Fallback for books we can't group into chapters (a format foliate gives no
// section sizes for, so buildChapterModel has nothing to work from): how far
// through the current spine section we are. foliate's paginator counts pages per
// section with 2 blank padding pages, so the position is (page - 1) / (pages - 2).
function sectionFraction() {
  const r = readerView?.renderer;
  if (!r) return 0;
  // r.pages/r.page read the paginator's internal view, which is briefly
  // undefined before the first section renders — reading it then throws.
  // Unguarded, that throw propagates up through updateProgressUI and aborts
  // applyReaderTheme before it sets the theme icon, applies the content styles
  // (leaving dark text on a dark background), and sets readerReady (so progress
  // never saves). Treat a not-yet-rendered view as 0.
  try {
    const pages = r.pages || 0, page = r.page || 0;
    if (pages > 2) return Math.min(1, Math.max(0, (page - 1) / (pages - 2)));
    return r.atEnd ? 1 : 0;
  } catch { return 0; }
}
// Minutes left in the current chapter. foliate only reports this per spine
// section, which is wrong for a chapter split across several — derive it from
// the chapter's remaining share of the book instead.
function chapterTimeLeft() {
  const chapter = currentChapter();
  if (!chapter || !bookMinutes) return currentLocation.timeSection;
  return Math.max(0, chapter.end - (currentLocation.fraction || 0)) * bookMinutes;
}
function progressModeIndex() {
  const raw = Math.round(Number(readerSettings.progressMode) || 0);
  return raw >= 0 && raw < PROGRESS_MODES.length ? raw : 0;
}
function progressMode() { return PROGRESS_MODES[progressModeIndex()]; }
function cycleProgressMode() {
  readerSettings.progressMode = (progressModeIndex() + 1) % PROGRESS_MODES.length;
  saveReaderSettings();
  updateProgressUI();
}
// Minutes remaining -> "h:mm". foliate estimates from section byte sizes at a
// fixed 1600 chars/minute, so this is a steady book-wide estimate rather than a
// measure of how fast this reader actually reads.
function formatTimeLeft(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
// Both readouts follow the bar they sit above: the chapter modes describe the
// current chapter, the book modes the whole book.
function progressLabelText(mode) {
  const chapter = mode.scope === "chapter";
  if (mode.label === "percent") {
    const fraction = chapter ? chapterFraction() : currentLocation.fraction || 0;
    return `${Math.round(fraction * 100)}%`;
  }
  if (mode.label !== "time") return "";
  const time = formatTimeLeft(chapter ? chapterTimeLeft() : currentLocation.timeTotal);
  return time ? `${time} left in ${chapter ? "chapter" : "book"}` : "";
}
// foliate's `sizePerTimeUnit` — the chars/minute it assumes when estimating how
// long a section takes to read (view.js passes 1600 when it builds
// SectionProgress). Mirrored here so per-chapter estimates match per-book ones.
const FOLIATE_CHARS_PER_MINUTE = 1600;
// Group the spine into chapters. A chapter is a run of consecutive spine
// sections that the TOC assigns to the same entry: publishers routinely split
// one long chapter across several spine files and give only the first a TOC
// entry (Seveneves' "Ymir" is Chapter_10.xhtml + Chapter_10a.xhtml). Treating
// each spine section as its own chapter made the chapter bar restart at 0%
// partway through such a chapter, and painted a book-bar segment that the
// contents view had no entry for and so could never navigate back to.
//
// foliate already resolves the owning TOC entry per section — including filling
// the gap for a continuation file — so ask it rather than re-deriving hrefs.
function buildChapterModel() {
  chapters = [];
  bookMinutes = 0;
  const sections = readerView?.book?.sections || [];
  if (!sections.length || sectionFractions.length !== sections.length + 1) return;
  // Non-linear sections (cover, nav) are sized 0 by foliate and so contribute
  // no reading time; mirror that here rather than counting them.
  const sizes = sections.map((s) => (s.linear !== "no" && s.size > 0 ? s.size : 0));
  bookMinutes = sizes.reduce((a, b) => a + b, 0) / FOLIATE_CHARS_PER_MINUTE;
  const owners = sections.map((_, i) => {
    // No range argument: this asks which TOC entry owns the *start* of the
    // section, which is what defines a chapter boundary.
    try { return readerView.getProgressOf(i)?.tocItem || null; } catch { return null; }
  });
  // Formats with no TOC (or none foliate can map to the spine) give every
  // section a null owner, which would collapse the whole book into one chapter.
  // Fall back to one chapter per spine section — the previous behaviour.
  const grouped = owners.some(Boolean);
  for (let i = 0; i < sections.length; i++) {
    const last = chapters[chapters.length - 1];
    // Sections with no owner at all only occur ahead of the first TOC entry
    // (foliate's gap-filling covers everything after it), so merging them keeps
    // unnavigable front matter as one block instead of several stray segments.
    if (grouped && last && last.tocItem === owners[i]) {
      last.lastSection = i;
      last.end = sectionFractions[i + 1];
      continue;
    }
    chapters.push({
      tocItem: owners[i],
      firstSection: i,
      lastSection: i,
      start: sectionFractions[i],
      end: sectionFractions[i + 1],
    });
  }
}
// The book bar is one segment per chapter, sized by that chapter's share of the
// book — so a chapter twice as long as its neighbours is twice as wide.
// Chapters foliate gives no size (non-linear front/back matter) are skipped.
function buildProgressSegments() {
  progressSegments = [];
  if (!els.readerProgressSegments) return;
  els.readerProgressSegments.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const [index, chapter] of chapters.entries()) {
    const share = chapter.end - chapter.start;
    if (!(share > 0)) continue;
    const seg = document.createElement("div");
    seg.className = "reader-progress-seg";
    seg.style.flexGrow = String(share);
    const fill = document.createElement("div");
    fill.className = "reader-progress-fill";
    seg.appendChild(fill);
    frag.appendChild(seg);
    progressSegments.push({ index, fill });
  }
  els.readerProgressSegments.appendChild(frag);
}
function paintProgressSegments() {
  const current = chapters.indexOf(currentChapter());
  const within = chapterFraction() * 100;
  for (const { index, fill } of progressSegments) {
    const pct = index < current ? 100 : index > current ? 0 : within;
    fill.style.width = `${pct.toFixed(1)}%`;
  }
}
function updateProgressUI() {
  if (!els.readerProgress) return;
  const on = progressEnabled();
  els.readerProgress.classList.toggle("hidden", !on);
  els.readerProgressCycle?.classList.toggle("hidden", !on);
  if (!on) return;
  const mode = progressMode();
  // A book with no usable section sizes can't be segmented; fall back to a
  // single bar showing the overall fraction rather than an empty strip.
  const segmented = mode.scope === "book" && progressSegments.length > 1;
  els.readerProgressTrack?.classList.toggle("hidden", segmented);
  els.readerProgressSegments?.classList.toggle("hidden", !segmented);
  if (segmented) paintProgressSegments();
  else if (els.readerProgressFill) {
    const fraction = mode.scope === "book" ? currentLocation.fraction || 0 : chapterFraction();
    els.readerProgressFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  }
  if (els.readerProgressLabel) {
    const text = progressLabelText(mode);
    els.readerProgressLabel.textContent = text;
    els.readerProgressLabel.classList.toggle("hidden", !text);
  }
  if (els.readerProgressCycle) els.readerProgressCycle.title = `Reading progress: ${mode.name}`;
}
function updateProgressButton() {
  if (!els.readerProgressToggle) return;
  els.readerProgressToggle.innerHTML = progressEnabled() ? PROGRESS_ON_SVG : PROGRESS_OFF_SVG;
  els.readerProgressToggle.title = progressEnabled() ? `Reading progress: ${progressMode().name}` : "Reading progress: off";
}
function refreshEveryPages() { return Math.max(0, Math.min(25, Math.round(Number(readerSettings.refreshEvery) || 0))); }
function formatRefreshEvery(value) { return value > 0 ? `After ${value} ${value === 1 ? "Page" : "Pages"}` : "Off"; }
function updateRefreshPanelUI() {
  const value = refreshEveryPages();
  if (els.readerRefreshSlider) els.readerRefreshSlider.value = String(value);
  if (els.readerRefreshValue) els.readerRefreshValue.textContent = formatRefreshEvery(value);
}
function updateRefreshButton() {
  if (!els.readerRefresh) return;
  const value = refreshEveryPages();
  els.readerRefresh.title = value > 0 ? `Page refresh: after ${value} ${value === 1 ? "page" : "pages"}` : "Page refresh: off";
}
function closeReaderRefreshMenu() { els.readerRefreshPanel.classList.add("hidden"); }
function toggleReaderRefreshMenu() {
  if (els.readerRefreshPanel.classList.contains("hidden")) {
    closeReaderFontMenu();
    updateRefreshPanelUI();
    els.readerRefreshPanel.classList.remove("hidden");
  } else closeReaderRefreshMenu();
}
function closeReaderPopups() {
  closeReaderFontMenu();
  closeReaderRefreshMenu();
}
function triggerReaderRefreshFlash() {
  if (!els.readerFlash) return;
  clearTimeout(refreshFlashTimer);
  const flash = els.readerFlash;
  // E-ink displays only clear ghosting when the controller runs a full
  // waveform refresh. To force that from the browser we paint solid full-
  // screen black, hold it long enough for the panel to settle, then paint
  // solid white and hold again. A fast fade doesn't trigger a global update.
  flash.classList.remove("hidden", "phase-black", "phase-white");
  void flash.offsetWidth;
  flash.classList.add("phase-black");
  refreshFlashTimer = setTimeout(() => {
    flash.classList.remove("phase-black");
    flash.classList.add("phase-white");
    refreshFlashTimer = setTimeout(() => {
      flash.classList.remove("phase-white");
      flash.classList.add("hidden");
    }, 400);
  }, 400);
}
function readerRelocateMarker(loc) {
  const page = readerView?.renderer?.page || 0;
  const section = loc.section?.current ?? loc.section?.index ?? loc.tocItem?.href ?? "";
  return `${section}|${page}|${loc.cfi || ""}`;
}
function noteReaderRelocate(loc) {
  const marker = readerRelocateMarker(loc);
  const prevFraction = currentLocation.fraction || 0;
  const nextFraction = Number(loc.fraction) || 0;
  const movedForward = nextFraction > prevFraction + 1e-6;
  if (!lastRelocateMarker) {
    lastRelocateMarker = marker;
    return;
  }
  if (marker === lastRelocateMarker) return;
  lastRelocateMarker = marker;
  if (!readerReady || !movedForward) return;
  const every = refreshEveryPages();
  if (!every) return;
  pageTurnsSinceRefresh += 1;
  if (pageTurnsSinceRefresh >= every) {
    pageTurnsSinceRefresh = 0;
    triggerReaderRefreshFlash();
  }
}
// Size the column. Constrained: cap it at a max width. Unconstrained: let it
// fill the view with 2rem of device padding on each side. `gap` is a % of the
// view, so derive the % that yields ~2rem; `max-inline-size` is set last as it
// forces foliate to re-lay-out, refreshing the column width we then measure.
function applyReaderLayout() {
  if (!readerView) return;
  if (columnsConstrained()) {
    readerView.renderer.setAttribute("gap", `${READER_GAP_PCT}%`);
    readerView.renderer.setAttribute("margin", `${READER_MARGIN_PX}px`);
    readerView.renderer.setAttribute("max-inline-size", `${READER_MAX_INLINE}px`);
  } else {
    const size = els.viewer.clientWidth || window.innerWidth;
    const padPx = READER_PAD_REM * rootFontPx();
    const gapPct = Math.max(1, Math.min(24, (2 * padPx / size) * 100));
    readerView.renderer.setAttribute("gap", `${gapPct}%`);
    readerView.renderer.setAttribute("margin", `${padPx}px`);
    readerView.renderer.setAttribute("max-inline-size", "100000px");
  }
}
function applyReaderTheme() {
  els.reader.dataset.readerTheme = readerSettings.theme;
  updateSizeButtons();
  updateColumnsButton();
  updateProgressButton();
  updateRefreshButton();
  updateRefreshPanelUI();
  updateProgressUI();
  const dark = readerSettings.theme === "dark";
  els.readerTheme.innerHTML = dark ? MOON_SVG : SUN_SVG;
  if (!readerView) return;
  applyReaderLayout();
  const fontPx = computeReaderFontSize();
  const font = currentReaderFont();
  readerView.renderer.setStyles?.(`
    ${font.face}
    html{font-size:${fontPx}px!important;color-scheme:${dark ? "dark" : "light"};background:${dark ? "#000" : "#fff"}!important;color:${dark ? "#fff" : "#000"}!important}
    html,body,body *{-webkit-font-smoothing:antialiased!important;-moz-osx-font-smoothing:grayscale!important;text-rendering:optimizeLegibility!important;font-smooth:always}
    body{font-family:${font.stack}!important;font-size:1rem!important;line-height:${READER_LINE_HEIGHT}!important;background:${dark ? "#000" : "#fff"}!important;color:${dark ? "#fff" : "#000"}!important}
    body *{font-family:${font.stack}!important}
    /* Normalize the book's own font sizes to rem so the measure-based scaling
       actually governs the type; otherwise books with absolute px/pt sizes
       ignore the root font-size and the +/- stepper appears to do nothing. */
    p,li,blockquote,dd,dt,td,th,figcaption,div,span{font-size:1rem!important}
    h1{font-size:1.7rem!important}h2{font-size:1.45rem!important}h3{font-size:1.25rem!important}
    h4{font-size:1.1rem!important}h5,h6{font-size:1rem!important}
    p,li,blockquote,dd{line-height:${READER_LINE_HEIGHT}!important}
    p,li,blockquote,dd{text-align:justify!important;-webkit-hyphens:auto;hyphens:auto}
    /* Only normalize vertical spacing. Zeroing the horizontal margins strips the
       anchor from hanging indents (margin-left + negative text-indent), pulling
       the first line outside the column, where pagination clips it. */
    p{margin-top:0!important;margin-bottom:1em!important}
    a{color:${dark ? "#9ecbff" : "#0645ad"}}
  `);
  requestAnimationFrame(() => readerView?.renderer?.render?.());
}
function stepFontScale(dir) {
  const next = (readerSettings.fontScale || 1) * (dir > 0 ? FONT_SCALE_STEP : 1 / FONT_SCALE_STEP);
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, next));
  if (clamped === readerSettings.fontScale) return;
  readerSettings.fontScale = clamped;
  saveReaderSettings();
  applyReaderTheme();
}
// The bottom edge bar is the only tap that toggles the reading menu (chrome).
// Fullscreen is a separate, explicit control so the two can never get out of sync.
function toggleReaderChrome() {
  els.reader.classList.toggle("chrome-hidden");
  if (els.reader.classList.contains("chrome-hidden")) closeReaderPopups();
}
function hideReaderChrome() {
  els.reader.classList.add("chrome-hidden");
  closeReaderPopups();
}
function toggleFullscreen() {
  if (!document.fullscreenEnabled) return;
  if (!document.fullscreenElement) els.reader.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
}
function updateFullscreenButton() {
  if (els.readerFullscreen) els.readerFullscreen.innerHTML = document.fullscreenElement ? FS_EXIT_SVG : FS_ENTER_SVG;
}
// Page turning is decided in SCREEN space, not by which element caught the tap:
// left PREV_ZONE_FRAC of the window turns back, the rest turns forward. The same
// rule is applied at all three places a tap can land, because in paginated mode
// foliate lays the chapter out as one very wide iframe inset by the reading
// margins:
//   1. .hit.left/.right — overlays over the dead margin gutter. Taps there never
//      reach the iframe, so something host-level has to catch them.
//   2. #epub-viewer — the rest of the non-text space (the gutter is only
//      READER_GAP_PCT/2 per side when constrained, ~2rem when not, and it moves
//      with the layout, so the overlays can't be sized to it reliably).
//   3. the book document itself — see wireReaderInput.
// Case 3 is why the overlays are kept narrow: an overlay wide enough to be a
// comfortable target would sit on top of real text and swallow the press-and-
// hold and drag that dictionary lookup needs, which is exactly what limited
// word selection to the middle of the screen. In-iframe coordinates are in
// chapter-strip space, so they are converted to host space via the frame rect
// (the same conversion evaluateSelection already does for the selection rect) —
// that conversion is correct however foliate has positioned the frame.
// A reliable tap = a short, near-stationary press (synthetic `click` is dropped
// by e-ink WebViews when a tap drifts a pixel, which is why taps "did nothing").
function onReaderTap(el, handler) {
  let sx = 0, sy = 0, st = 0, moved = false, down = false;
  let dictWasOpen = false;
  el.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) return;
    down = true; moved = false; sx = e.clientX; sy = e.clientY; st = Date.now();
    // Captured here because the document-level pointerdown listener closes the
    // definition popover before this pointerup runs — see dictTapConsumed.
    dictWasOpen = !els.dictPopover.classList.contains("hidden");
  });
  el.addEventListener("pointermove", (e) => {
    if (down && (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12)) moved = true;
  });
  el.addEventListener("pointerup", (e) => {
    if (!down) return;
    down = false;
    if (moved || Date.now() - st > 500) return;
    handler(e, dictWasOpen);
  });
}
// Was this tap spent dismissing a definition? Host-level taps can't just check
// whether the popover is open now: the document pointerdown listener has already
// closed it by the time pointerup runs, so the tap would look innocent and go on
// to turn the page as well. `dictWasOpen` is the state at pointerdown, which
// keeps the dismissal attributed to the tap that caused it. Taps inside the book
// never reach that listener, so they can pass nothing and be read live.
function dictTapConsumed(dictWasOpen) {
  if (!dictWasOpen && els.dictPopover.classList.contains("hidden")) return false;
  closeDictPopover();
  return true;
}
// The first tap dismisses an open definition or an open menu instead of turning,
// so a tap to put something away never also flips the page.
function readerTapConsumed(dictWasOpen) {
  if (dictTapConsumed(dictWasOpen)) return true;
  if (!els.reader.classList.contains("chrome-hidden")) { hideReaderChrome(); return true; }
  return false;
}
// Turn the page for a tap at host x.
function turnAtHostX(hostX) {
  if (hostX < window.innerWidth * PREV_ZONE_FRAC) readerPrev();
  else readerNext();
}
function pageTurnTap(e, dictWasOpen) {
  if (readerTapConsumed(dictWasOpen)) return;
  turnAtHostX(e.clientX);
}
onReaderTap(els.hitLeft, pageTurnTap);
onReaderTap(els.hitRight, pageTurnTap);
// Taps that land on the viewer are in the margin space around the text the
// narrow overlays don't cover; they are already in host coordinates.
onReaderTap(els.viewer, pageTurnTap);
// The top edge bar closes the book. It deliberately skips the chrome-hidden
// dismissal the page-turn edges do: leaving should never cost a second tap.
onReaderTap(els.hitBack, (e, dictWasOpen) => {
  if (dictTapConsumed(dictWasOpen)) return;
  closeReader();
});
els.hitBack.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); closeReader(); }
});
// The bottom edge bar is the dedicated reading-menu target.
onReaderTap(els.hitMenu, (e, dictWasOpen) => {
  if (dictTapConsumed(dictWasOpen)) return;
  toggleReaderChrome();
});
els.hitMenu.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleReaderChrome(); }
});
onReaderTap(els.bookmarkToggle, toggleBookmark);
els.bookmarkToggle.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleBookmark(); }
});
// The bottom-right corner sits inside the right page-turn overlay, so it takes
// the same first-tap dismissals before it starts cycling the progress detail.
onReaderTap(els.readerProgressCycle, (e, dictWasOpen) => {
  if (readerTapConsumed(dictWasOpen)) return;
  cycleProgressMode();
  updateProgressButton();
});
els.readerProgressCycle.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cycleProgressMode(); updateProgressButton(); }
});
// ---- Dictionary --------------------------------------------------------
// Wire per-chapter input. Text gets the full gesture set: a tap turns the page
// by the same screen-space zone rule as the overlays, while a press-and-hold or
// drag anywhere over the text — including under the prev/next zones — is a
// selection gesture and triggers the word lookup instead.
function wireReaderInput(doc) {
  let sx = 0, sy = 0, st = 0, moved = false, tracking = false;
  doc.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) return;
    tracking = true; moved = false; sx = e.clientX; sy = e.clientY; st = Date.now();
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (tracking && (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12)) moved = true;
  }, true);
  doc.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    // A drag or long-press is a selection gesture (dictionary), never a tap.
    if (moved || Date.now() - st > 500) return;
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (readerTapConsumed()) return;
    // Let foliate handle in-book links.
    if (e.target.closest && e.target.closest("a")) return;
    // Convert the tap out of chapter-strip space before applying the zone rule.
    const frame = doc.defaultView && doc.defaultView.frameElement;
    const fr = frame ? frame.getBoundingClientRect() : els.viewer.getBoundingClientRect();
    turnAtHostX(fr.left + e.clientX);
  }, true);
  doc.addEventListener("selectionchange", () => {
    clearTimeout(dictDebounce);
    dictDebounce = setTimeout(() => evaluateSelection(doc), 250);
  });
}
function evaluateSelection(doc) {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { closeDictPopover(); return; }
  // Single word only: strip surrounding punctuation, reject phrases / non-words.
  const word = sel.toString().trim().replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
  if (!word || /\s/.test(word) || !/^[A-Za-z][A-Za-z'-]*$/.test(word) || word.length > 64) { closeDictPopover(); return; }
  let rect;
  try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { return; }
  // The rect is in the iframe's coordinate space; offset to host-viewport coords.
  const frame = doc.defaultView && doc.defaultView.frameElement;
  const fr = frame ? frame.getBoundingClientRect() : els.viewer.getBoundingClientRect();
  lookupWord(word, { left: fr.left + rect.left, top: fr.top + rect.top, bottom: fr.top + rect.bottom, width: rect.width });
}
async function lookupWord(word, anchor) {
  const reqId = ++dictReqId;
  showDictPopover(`<div class="dict-word">${escapeHtml(word)}</div><div class="dict-status">Looking up…</div>`, anchor);
  let data;
  try { data = await api(`/api/dictionary/${encodeURIComponent(word.toLowerCase())}`); }
  catch { if (reqId === dictReqId) showDictPopover(`<div class="dict-word">${escapeHtml(word)}</div><div class="dict-status">Couldn't reach the dictionary.</div>`, anchor); return; }
  if (reqId !== dictReqId) return; // a newer selection superseded this lookup
  if (!data || data.notFound || !(data.meanings || []).length) {
    showDictPopover(`<div class="dict-word">${escapeHtml(word)}</div><div class="dict-status">No definition found.</div>`, anchor);
    return;
  }
  const head = `<div class="dict-word">${escapeHtml(data.word || word)}${data.phonetic ? `<span class="dict-phonetic">${escapeHtml(data.phonetic)}</span>` : ""}</div>`;
  const body = data.meanings.map((m) =>
    `${m.partOfSpeech ? `<div class="dict-pos">${escapeHtml(m.partOfSpeech)}</div>` : ""}<ol class="dict-defs">${m.definitions.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ol>`
  ).join("");
  showDictPopover(head + body, anchor);
}
function showDictPopover(html, anchor) {
  els.dictPopover.innerHTML = html;
  els.dictPopover.classList.remove("hidden");
  const pop = els.dictPopover, m = 8, vw = window.innerWidth, vh = window.innerHeight;
  // Prefer below the word; flip above if it would overflow the bottom edge.
  let top = anchor.bottom + m;
  if (top + pop.offsetHeight > vh - m) top = anchor.top - pop.offsetHeight - m;
  top = Math.max(m, Math.min(top, vh - pop.offsetHeight - m));
  // Center on the word, clamped within the viewport.
  let left = anchor.left + anchor.width / 2 - pop.offsetWidth / 2;
  left = Math.max(m, Math.min(left, vw - pop.offsetWidth - m));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}
// Bump the request id so any in-flight lookup is ignored when it returns.
function closeDictPopover() { dictReqId++; clearTimeout(dictDebounce); els.dictPopover.classList.add("hidden"); }
// Tapping the reader chrome (toolbar, edges) outside the popover dismisses it.
// Taps inside the book are handled by the per-document selection listener.
document.addEventListener("pointerdown", (e) => {
  if (!els.dictPopover.classList.contains("hidden") && !els.dictPopover.contains(e.target)) closeDictPopover();
  if (!els.readerFonts.classList.contains("hidden") && !els.readerFonts.contains(e.target) && !e.target.closest('[data-role="font-menu"]')) closeReaderFontMenu();
  if (!els.readerRefreshPanel.classList.contains("hidden") && !els.readerRefreshPanel.contains(e.target) && !e.target.closest("#reader-refresh")) closeReaderRefreshMenu();
});
els.readerClose.addEventListener("click", closeReader);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshOpenReaderProgress(); });
window.addEventListener("focus", refreshOpenReaderProgress);
els.tocToggle.addEventListener("click", openTocView);
els.readerCollapse.addEventListener("click", hideReaderChrome);
els.tocBack.addEventListener("click", closeTocView);
els.tocContentsTab.addEventListener("click", () => setTocTab("contents"));
els.tocBookmarksTab.addEventListener("click", () => setTocTab("bookmarks"));
els.tocList.addEventListener("click", (e) => { const b = e.target.closest("button[data-href]"); if (b && readerView) { readerView.goTo(b.dataset.href); closeTocView(); } });
els.bookmarksList.addEventListener("click", (e) => { const b = e.target.closest("button[data-cfi]"); if (b && readerView) { readerView.goTo(b.dataset.cfi); closeTocView(); } });
els.readerTheme.addEventListener("click", () => { readerSettings.theme = readerSettings.theme === "dark" ? "light" : "dark"; saveReaderSettings(); applyReaderTheme(); });
els.readerFullscreen.addEventListener("click", toggleFullscreen);
els.readerColumns.addEventListener("click", () => { readerSettings.columns = !columnsConstrained(); saveReaderSettings(); applyReaderTheme(); });
els.readerProgressToggle.addEventListener("click", () => {
  const on = !progressEnabled();
  readerSettings.progress = on;
  // Switching the readout off rewinds the detail cycle, so the next time it is
  // switched on it starts from the plain chapter bar again.
  if (!on) readerSettings.progressMode = 0;
  saveReaderSettings(); updateProgressButton(); updateProgressUI();
});
els.sizeToggle.addEventListener("click", (e) => {
  const fontButton = e.target.closest('button[data-role="font-menu"]');
  if (fontButton) return toggleReaderFontMenu();
  const b = e.target.closest("button[data-step]");
  if (b) stepFontScale(Number(b.dataset.step));
});
// Reader font picker: a small popup list above the control sheet. Each option
// previews itself in its own face; the current font is highlighted.
function renderReaderFontMenu() {
  els.readerFonts.innerHTML = FONTS.map((f) =>
    `<button type="button" class="reader-font-item${f.id === readerSettings.font ? " current" : ""}" data-font="${f.id}" style="font-family:${escapeHtml(f.stack)}">${escapeHtml(f.label)}</button>`
  ).join("");
}
function closeReaderFontMenu() { els.readerFonts.classList.add("hidden"); }
function toggleReaderFontMenu() {
  if (els.readerFonts.classList.contains("hidden")) { closeReaderRefreshMenu(); renderReaderFontMenu(); els.readerFonts.classList.remove("hidden"); }
  else closeReaderFontMenu();
}
function setReaderFont(id) {
  if (!FONT_BY_ID[id] || id === readerSettings.font) { closeReaderFontMenu(); return; }
  readerSettings.font = id;
  saveReaderSettings();
  if (els.libFont) els.libFont.value = readerSettings.font;
  closeReaderFontMenu();
  // Re-measure the new face's advance before re-laying out so the cpl-based
  // sizing stays right; applyReaderTheme falls back to a default until it lands.
  ensureFontAdvance(currentReaderFont()).then(applyReaderTheme);
  applyReaderTheme();
}
els.readerFonts.addEventListener("click", (e) => { const b = e.target.closest("button[data-font]"); if (b) setReaderFont(b.dataset.font); });
els.readerRefresh.addEventListener("click", toggleReaderRefreshMenu);
els.readerRefreshSlider.addEventListener("input", () => {
  readerSettings.refreshEvery = Math.max(0, Math.min(25, Math.round(Number(els.readerRefreshSlider.value) || 0)));
  pageTurnsSinceRefresh = 0;
  saveReaderSettings();
  updateRefreshButton();
  updateRefreshPanelUI();
});
if (!document.fullscreenEnabled) els.readerFullscreen.classList.add("hidden");
document.addEventListener("fullscreenchange", updateFullscreenButton);
updateFullscreenButton();
function scheduleReaderRelayout() {
  if (!readerView) return;
  clearTimeout(readerResizeTimer);
  readerResizeTimer = setTimeout(applyReaderTheme, 120);
}
window.addEventListener("resize", scheduleReaderRelayout);
// The reader unhides from display:none, so the viewer often measures 0px on the
// first render — foliate then lays the text into a zero-width column and the
// page looks blank until something forces another render (which is why toggling
// the theme "fixes" it). Re-lay-out whenever the viewer's real size lands, which
// also covers orientation changes and e-ink relayouts.
if ("ResizeObserver" in window) {
  new ResizeObserver(scheduleReaderRelayout).observe(els.viewer);
}
function readerNext() { if (readerView) readerView.goRight(); }
function readerPrev() { if (readerView) readerView.goLeft(); }
// Hook a native wrapper (e.g. an Android WebView that captures the BOOX volume
// buttons) can call: window.ebookTurnPage('next' | 'prev').
window.ebookTurnPage = (dir) => { if (readerView) (dir === "prev" ? readerPrev() : readerNext()); };

// Page-turn keys. We accept the usual e-reader keys (arrows, PageUp/Down, space)
// plus the volume keycodes — so whatever a BOOX button remap or wrapper emits,
// the reader turns the page. (Chrome itself does NOT deliver volume keys to a
// web page; those branches only fire if something forwards a real key event.)
function handleReaderKey(e) {
  if (!readerView) return;
  const tocOpen = !els.tocView.classList.contains("hidden");
  if (e.key === "Escape") { e.preventDefault(); return tocOpen ? closeTocView() : closeReader(); }
  if (tocOpen) return; // don't page through the book while the contents view is up
  const k = e.key, code = e.keyCode || e.which;
  if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "Spacebar" || k === "AudioVolumeDown" || code === 25) { e.preventDefault(); return readerNext(); }
  if (k === "ArrowLeft" || k === "PageUp" || k === "AudioVolumeUp" || code === 24) { e.preventDefault(); return readerPrev(); }
}
document.addEventListener("keydown", handleReaderKey);

function setTheme(mode) { if (mode === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", mode); localStorage.setItem("ebook-library.theme", mode); document.querySelectorAll("[data-theme-set]").forEach((b) => b.classList.toggle("active", b.dataset.themeSet === mode)); }
document.querySelectorAll("[data-theme-set]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.themeSet)));

// ---- Library drawer: search, sort, filter, layout, theme ----
function openDrawer() { els.drawer.classList.remove("hidden"); updateLibControls(); }
function closeDrawer() { els.drawer.classList.add("hidden"); }
els.openMenu.addEventListener("click", openDrawer);
els.drawer.addEventListener("click", (e) => { if (e.target.hasAttribute("data-close-drawer")) closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.drawer.classList.contains("hidden")) closeDrawer(); });
let libSearchTimer = null;
els.libSearch.addEventListener("input", () => {
  libSearch = els.libSearch.value;
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(renderSections, 120);
});
els.viewToggle.addEventListener("click", () => {
  libView.view = libView.view === "table" ? "cover" : "table";
  saveLibView(); updateLibControls(); renderSections();
});
els.sortToggle.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sort]"); if (!b) return;
  // Re-clicking the active sort flips direction; picking a new one starts at A→Z.
  if (b.dataset.sort === libView.sort && libView.sort !== "series") libView.dir = libView.dir === "desc" ? "asc" : "desc";
  else { libView.sort = b.dataset.sort; libView.dir = "asc"; }
  saveLibView(); updateLibControls(); renderSections();
});
els.sortDir.addEventListener("click", () => {
  if (libView.sort === "series") return;
  libView.dir = libView.dir === "desc" ? "asc" : "desc"; saveLibView(); updateLibControls(); renderSections();
});
els.libFont.addEventListener("change", () => setReaderFont(els.libFont.value));
els.filterAuthor.addEventListener("change", () => { libFilter.author = els.filterAuthor.value; renderSections(); });
els.filterGroup.addEventListener("change", () => { libFilter.group = els.filterGroup.value; renderSections(); });
els.clearFilters.addEventListener("click", () => {
  libSearch = ""; libFilter = { author: "", group: "" };
  els.libSearch.value = ""; updateLibControls(); renderSections();
});

els.refreshLibrary.addEventListener("click", async () => {
  els.refreshLibrary.disabled = true;
  try {
    await loadProgress();
    const res = await api("/api/library/refresh", { method: "POST" });
    setLibraryData(res);
    renderSections();
  } catch (e) {
    els.library.innerHTML = `<div class="lib-empty">Couldn't refresh library: ${escapeHtml(e.message)}</div>`;
  } finally {
    els.refreshLibrary.disabled = false;
  }
});

// True only when the optional IRC acquisition plugin is installed. When false,
// the "Add" tab (IRC search) is hidden but the Staging tab — for editing
// metadata on files dropped into the staging folder manually — stays usable.
let HAS_IRC = true;
async function loadIrcStatus() {
  try {
    const features = await api("/api/features");
    HAS_IRC = !!features.irc;
    if (!HAS_IRC) {
      els.segAdd.classList.add("hidden");
      els.paneAdd.classList.add("hidden");
      setAddTab("staging");
      els.openDownload.title = "Staged books";
      els.addIcon.innerHTML = `<path d="M12 5v14M5 12h14" />`;
      return;
    }
  } catch { /* fall through and try status anyway */ }
  try {
    const s = await api("/api/irc/status");
    els.addIcon.innerHTML = s.connected ? `<path d="M12 5v14M5 12h14" />` : `<path d="M12 8v5M12 17h.01" /><path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />`;
    els.openDownload.title = s.connected ? "Add books" : "Add books — IRC offline";
  } catch {
    els.addIcon.innerHTML = `<path d="M12 8v5M12 17h.01" /><path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />`;
    els.openDownload.title = "Add books — IRC status unknown";
  }
}
setTheme(localStorage.getItem("ebook-library.theme") || "system");
populateFontSelect();
updateLibControls();
applyReaderTheme();
loadIrcStatus().then(loadStaging);
loadLibrary();

// Register the service worker so the app is installable as a PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
