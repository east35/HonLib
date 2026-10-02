import "./vendor/foliate-js/view.js";
import * as CFI from "./vendor/foliate-js/epubcfi.js";
import * as store from "./journal-store.js";
import { UNFILED, dismissLoweredJournal, filingDismissed, initJournals, journalOverReader, lastStyle, lowerJournal, mountFilingTool, mountJournalsTool, mountNoteTool, mountStyleTool, mountTagTool, openJournal, quoteHtml, raiseJournal, renderShelf } from "./journal.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  openDownload: $("#open-download"), downloadModal: $("#download-modal"),
  refreshLibrary: $("#refresh-library"),
  ircQuery: $("#irc-query"), ircSearch: $("#irc-search"), ircLog: $("#irc-log"), ircResults: $("#irc-results"), stagingResults: $("#staging-results"), addIcon: $("#add-icon"),
  segAdd: $("#seg-add"), segStaging: $("#seg-staging"), paneAdd: $("#pane-add"), paneStaging: $("#pane-staging"),
  library: $("#library"), librarySection: $("#library-section"), inprogress: $("#inprogress"), inprogressSection: $("#inprogress-section"), finished: $("#finished"), finishedSection: $("#finished-section"),
  flatSection: $("#flat-section"), flatResults: $("#flat-results"),
  appUpdate: $("#app-update"), appUpdateMessage: $("#app-update-message"), appUpdateApply: $("#app-update-apply"), appUpdateDismiss: $("#app-update-dismiss"),
  openMenu: $("#open-menu"), drawer: $("#drawer"), libSearch: $("#lib-search"), viewToggle: $("#view-toggle"), sortToggle: $("#sort-toggle"), sortDir: $("#sort-dir"), filterAuthor: $("#filter-author"), filterGroup: $("#filter-group"), clearFilters: $("#clear-filters"), libFont: $("#lib-font"),
  bookActionsModal: $("#book-actions-modal"), bookActionsTitle: $("#book-actions-title"), bookActionReset: $("#book-action-reset"), bookActionDelete: $("#book-action-delete"),
  reader: $("#reader"), viewer: $("#epub-viewer"), readerLoading: $("#reader-loading"), readerClose: $("#reader-close"), tocView: $("#toc-view"), tocList: $("#toc-list"), tocLocation: $("#toc-location"), tocBack: $("#toc-back"), tocToggle: $("#toc-toggle"), tocContentsTab: $("#toc-contents-tab"), tocBookmarksTab: $("#toc-bookmarks-tab"), bookmarksList: $("#bookmarks-list"), bookmarkToggle: $("#bookmark-toggle"), readerTheme: $("#reader-theme"), readerFullscreen: $("#reader-fullscreen"), readerColumns: $("#reader-columns"), readerProgressToggle: $("#reader-progress-toggle"), readerProgress: $("#reader-progress"), readerProgressTrack: $("#reader-progress-track"), readerProgressFill: $("#reader-progress-fill"), readerProgressSegments: $("#reader-progress-segments"), readerProgressLabel: $("#reader-progress-label"), readerProgressCycle: $("#reader-progress-cycle"), sizeToggle: $("#reader-size"), readerFonts: $("#reader-fonts"), readerRefresh: $("#reader-refresh"), readerRefreshPanel: $("#reader-refresh-panel"), readerRefreshSlider: $("#reader-refresh-slider"), readerRefreshValue: $("#reader-refresh-value"), readerFlash: $("#reader-flash"), readerCollapse: $("#reader-collapse"), dictPopover: $("#dict-popover"), passageSheet: $("#passage-sheet"), tocPassagesTab: $("#toc-passages-tab"), passagesPanel: $("#passages-panel"), passagesList: $("#passages-list"), passagesScopeBook: $("#passages-scope-book"), passagesScopeJournal: $("#passages-scope-journal"), passagesSearch: $("#passages-search"), passagesTag: $("#passages-tag"), visitBar: $("#visit-bar"), visitLabel: $("#visit-label"), visitBack: $("#visit-back"), visitPlace: $("#visit-place"), hitLeft: $("#reader-hit-left"), hitCenter: $("#reader-hit-center"), hitRight: $("#reader-hit-right"), hitBack: $("#reader-hit-back"), hitMenu: $("#reader-hit-menu"),
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
let bookActionsBook = null;
let bookActionsMode = "maintenance";
let readerView = null;
// Dictionary popover state: `dictReqId` invalidates stale async lookups,
// `dictDebounce` coalesces the rapid selectionchange events of a drag-select.
let dictReqId = 0;
let dictDebounce = null;
// The text selected in the book and not yet acted on: { doc, index, range,
// text }. Kept from the moment a selection settles, so Save and the annotation
// bar act on what was selected even if the tap on them disturbs the selection.
let pendingSelection = null;
// The annotation sheet: { mode: "new" } while it offers to mark a fresh
// selection; { mode: "view", id } for a passage made earlier, which is shown
// with the way to its journal rather than opened for editing; { mode: "edit",
// id, tool, handle, notice, then } with the editing tools.
let passageSheet = null;
// Where on the screen the text an open sheet is about sits: { top, bottom } in
// the reader's own coordinates. The sheet docks at whichever edge leaves it in
// view. Null when nothing on this page is being marked.
let sheetSpan = null;
// A passage being carried over a page turn: { doc, index, node, offset,
// fraction } is where it starts, on a page already left behind. Its end is
// chosen on the page now showing.
let carry = null;
// True only while the reader itself is turning the page (see ownPageTurns).
let turningPage = false;
// Where each passage is drawn in the loaded section, for telling a tap on a
// mark from a tap on the page: passage id -> { doc, rects }.
const markRects = new Map();
// What has been handed to foliate to draw: passage id -> { cfi, sig }.
const drawnMarks = new Map();
// A visit: a book opened at a passage from a journal. Nothing about it is
// saved, so the reader's place and finished status are untouched.
// { passage, fromBook, viaJournal, returnCfi } where fromBook is the book that
// was being read when the journal was consulted from inside the reader (null
// from the journal on the home page), and viaJournal says that was the journal
// view opened over the page rather than the reader's Passages tab. returnCfi
// is set when the passage is in the very book being read: the page to go back
// to, since there is no other book to reopen.
let visit = null;
let passagesScope = "book";
let passagesPolling = false;
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
// Book id -> the CFIs this session has written for it. A resync exists to catch
// up to another device; when the position handed back is one we wrote ourselves
// there is nothing to catch up to, and jumping to it drags the reader backwards.
// Only writes a backend might still be echoing back can matter, and it is never
// more than a handful behind, so this keeps a short window rather than growing
// for the whole of a long reading session.
const ownWrites = new Map();
const OWN_WRITE_MEMORY = 50;
function noteOwnWrite(bookId, cfi) {
  if (!cfi) return;
  let seen = ownWrites.get(bookId);
  if (!seen) ownWrites.set(bookId, (seen = new Set()));
  // Re-inserting moves a repeated CFI back to the end of the eviction order.
  seen.delete(cfi);
  seen.add(cfi);
  for (const oldest of seen) {
    if (seen.size <= OWN_WRITE_MEMORY) break;
    seen.delete(oldest);
  }
}
function isOwnWrite(bookId, cfi) {
  return !!cfi && !!ownWrites.get(bookId)?.has(cfi);
}
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
const TAP_SLOP_PX = 12;           // a finger that drifts less than this has not moved
// Android's long press comes due at 400ms unless the device says otherwise. A
// press on the page that lasts that long was an attempt to select, not a tap,
// and a finger still down at that point is holding, not swiping.
const TAP_MAX_MS = 400;
const HOLD_MS = 400;
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
  // Record before sending: a write still in flight is exactly the one a backend
  // that is a step behind will echo back at us.
  noteOwnWrite(book.id, cfi);
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
          if (currentBook?.id === book.id && !isOwnWrite(book.id, entry.cfi)) await resyncReaderTo(entry);
        }
        return;
      }
      if (res.ok) {
        if (entry) {
          progress.books[book.id] = entry;
          progressBases.set(book.id, entry.last_opened || null);
        } else {
          // Accepting a write without returning the stored entry means this
          // backend isn't running the conflict protocol — the Android shell's
          // offline proxy queues the write and answers {ok, queued, synced}.
          // Our token can then never be refreshed, and a token that cannot be
          // refreshed is worse than none: it goes stale, and the real server
          // starts rejecting every later write as a conflict that never
          // happened. Drop it and let last-writer-wins do its job.
          progressBases.set(book.id, null);
        }
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
  // Coming back to the app is also when another device's highlights are most
  // likely to be waiting.
  store.sync();
  // A visit is deliberately somewhere other than the saved place.
  if (!currentBook || !readerView || !readerReady || visit) return;
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
  // A position this session wrote is not another device catching us up, however
  // new its timestamp looks — it is our own page turn coming back around.
  if (base && isNewerToken(entry.last_opened, base) && !isOwnWrite(currentBook.id, entry.cfi)) {
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
  let status = "";
  if (kind === "inprogress") status = fmtPercent(b.percent);
  else if (kind === "complete") status = "Finished";
  tr.innerHTML = `<td class="c-cover">${cover}</td>` +
    `<td class="c-title"><span class="row-title">${escapeHtml(b.title)}</span></td>` +
    `<td class="c-author">${escapeHtml(b.author || "")}</td>` +
    `<td class="c-status"><span class="row-status">${escapeHtml(status)}</span>${bookActionsButton(b, "row-menu")}</td>`;
  tr.addEventListener("click", () => openReader(b));
  tr.querySelector("[data-book-actions]").addEventListener("click", (e) => {
    e.stopPropagation();
    openBookActions(b);
  });
  return tr;
}

// One titled section (plain h2 header + cover grid or table) appended to a
// container. Same h2 as the top-level section titles — no count, no variation.
function appendGroupBlock(container, name, books, kind, group = null) {
  const block = document.createElement("section");
  block.className = "book-group";
  // The folder this shelf stands for, so a journal that belongs to it can be
  // placed on it (journal.js).
  if (group) block.dataset.group = group;
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
  if (!home) { renderResults(); renderShelf(); return; }
  // Home: in-progress rail, folder-grouped library, finished rail.
  const inprog = allBooks.filter(isInProgress);
  const finished = allBooks.filter(isFinished);
  els.inprogressSection.classList.toggle("hidden", !inprog.length);
  if (inprog.length) fillBooks(els.inprogress, inprog, "inprogress");
  els.finishedSection.classList.toggle("hidden", !finished.length);
  if (finished.length) fillBooks(els.finished, finished, "complete");
  els.library.innerHTML = "";
  if (!allBooks.length) { els.library.innerHTML = `<div class="lib-empty">No EPUBs found in the library folder.</div>`; renderShelf(); return; }
  const ordered = [...allGroups].sort((a, b) =>
    displaySeriesName(a.name).localeCompare(displaySeriesName(b.name), undefined, { sensitivity: "base" }));
  for (const group of ordered) {
    if (group.books.length) appendGroupBlock(els.library, displaySeriesName(group.name), group.books, "library", group.name);
  }
  renderShelf();
}
function renderResults() {
  const books = sortBooks(allBooks.filter(bookMatchesFilter));
  els.flatResults.className = "";
  els.flatResults.innerHTML = "";
  if (!books.length) { els.flatResults.innerHTML = `<div class="lib-empty">No books match your search and filters.</div>`; return; }
  const bySeries = libView.sort === "series";
  for (const sec of sectionize(books, libView.sort)) appendGroupBlock(els.flatResults, bySeries ? displaySeriesName(sec.name) : sec.name, sec.books, null, bySeries ? sec.name : null);
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

const MORE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>';
function bookActionsButton(book, extraClass = "") {
  return `<button type="button" class="book-menu-btn ${extraClass}" data-book-actions title="Book options" aria-label="Options for ${escapeHtml(book.title)}">${MORE_ICON}</button>`;
}
function resumeStrip(label, iso, book) {
  const date = fmtDate(iso);
  return `<div class="resume-strip"><span>${escapeHtml(label)}${date ? ` · ${escapeHtml(date)}` : ""}</span>` +
    `${bookActionsButton(book, "strip-menu")}</div>`;
}
function renderCard(b, kind) {
  const card = document.createElement("div");
  card.className = "series-card";
  const cover = b.cover_url ? `<img class="cover" src="${b.cover_url}" alt="" loading="lazy" decoding="async">` : `<div class="cover-placeholder">${escapeHtml(initials(b.title))}</div>`;
  let strip = "";
  if (kind === "inprogress") strip = resumeStrip(fmtPercent(b.percent), b.last_opened, b);
  else if (kind === "complete") strip = resumeStrip("Finished", b.last_opened, b);
  card.innerHTML = `${cover}${strip}`;
  card.title = b.title;
  card.addEventListener("click", () => kind === "library" ? openBookActions(b, "unread") : openReader(b));
  card.querySelector("[data-book-actions]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openBookActions(b);
  });
  return card;
}
async function resetProgress(book) {
  if (!confirm(`Reset reading progress for "${book.title}"?`)) return false;
  try {
    await api("/api/progress/reset", { method: "POST", body: JSON.stringify({ book_id: book.id }) });
  } catch (e) { alert("Couldn't reset progress: " + e.message); return false; }
  await loadLibrary();
  return true;
}

async function deleteBook(book, button) {
  if (!confirm(`Permanently delete "${book.title}" from HonLib?\n\nThis removes the EPUB from library storage and can't be undone.`)) return false;
  button.disabled = true;
  try {
    let res = await api(`/api/book/${encodeURIComponent(book.id)}/delete`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    delete progress.books[book.id];
    delete progress.bookmarks[book.id];
    progressBases.delete(book.id);
    ownWrites.delete(book.id);
    // The Android shell caches GET /api/library for offline startup. Re-reading
    // it after deletion updates that cache so the removed book cannot reappear
    // from stale metadata the next time the device starts without a network.
    try { res = await api("/api/library"); } catch {}
    setLibraryData(res);
    renderSections();
    return true;
  } catch (e) {
    alert("Couldn't delete book: " + e.message);
    button.disabled = false;
    return false;
  }
}

function openModal(el, focusEl) { el.classList.remove("hidden"); if (focusEl) focusEl.focus(); }
function closeModal(el) { el.classList.add("hidden"); }

function openBookActions(book, mode = "maintenance") {
  bookActionsBook = book;
  bookActionsMode = mode;
  els.bookActionsTitle.textContent = book.title;
  els.bookActionReset.textContent = mode === "unread" ? "Read" : "Reset progress";
  els.bookActionDelete.textContent = mode === "unread" ? "Remove" : "Delete book";
  els.bookActionReset.disabled = false;
  els.bookActionDelete.disabled = false;
  openModal(els.bookActionsModal, els.bookActionReset);
}
function closeBookActions() {
  closeModal(els.bookActionsModal);
  bookActionsBook = null;
  bookActionsMode = "maintenance";
}
els.bookActionsModal.addEventListener("click", (e) => {
  if (e.target === els.bookActionsModal || e.target.hasAttribute("data-close-book-actions")) closeBookActions();
});
els.bookActionReset.addEventListener("click", async () => {
  const book = bookActionsBook;
  if (!book) return;
  if (bookActionsMode === "unread") {
    closeBookActions();
    await openReader(book);
    return;
  }
  els.bookActionReset.disabled = true;
  const done = await resetProgress(book);
  els.bookActionReset.disabled = false;
  if (done) closeBookActions();
});
els.bookActionDelete.addEventListener("click", async () => {
  const book = bookActionsBook;
  if (!book) return;
  if (await deleteBook(book, els.bookActionDelete)) closeBookActions();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.bookActionsModal.classList.contains("hidden")) closeBookActions();
});

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
async function openReader(book, nextVisit = null) {
  readerReady = false;
  visit = nextVisit;
  lastRelocateMarker = null;
  pageTurnsSinceRefresh = 0;
  // A visit made from inside the reader replaces the book that is open.
  if (readerView) { try { readerView.close(); } catch {} readerView.remove(); readerView = null; }
  closeReaderSheets();
  pendingSelection = null; sheetSpan = null; markRects.clear(); tints.clear(); drawnMarks.clear();
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
  // Last session's writes are someone else's history now: if another device has
  // since moved to a position this one once wrote, that is a real catch-up.
  ownWrites.delete(book.id);
  currentBook = book;
  updateVisitBar();
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
    // The page has changed, so whatever was being marked is no longer where it
    // was. A passage carried over the turn asks for its end on the new page.
    sheetSpan = null;
    const loc = e.detail || {};
    if (carry && sectionIndexOf(carry.doc) != null) openCarryBar();
    else {
      carry = null;
      closeSelectionBar();
      // A selection left behind on the page before would go on swallowing taps
      // and swipes from somewhere it can't be seen.
      if (pendingSelection && lastRelocateMarker && readerRelocateMarker(loc) !== lastRelocateMarker) dropSelection();
    }
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
    if (readerReady && !visit) await saveBookProgress(book, loc.cfi || null, loc.fraction || 0);
  });
  // foliate asks how to draw each annotation it is given, and gives every
  // section an empty overlay when it loads.
  readerView.addEventListener("draw-annotation", (e) => {
    const { draw, annotation, doc, range } = e.detail;
    draw(passageMark, { id: annotation.id, doc, range });
  });
  readerView.addEventListener("create-overlay", (e) => drawSectionMarks(e.detail.index));
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
    if (visit) showVisitUnavailable();
    else els.readerLoading.textContent = "Couldn't open this book.";
    return;
  }
  ownPageTurns(readerView.renderer);
  // An older shell can serve a library listing that predates book keys. The
  // book itself says what its key is: the server derives it from the same
  // identifier.
  if (!book.key) {
    const identifier = String(readerView.book?.metadata?.identifier || "").trim().replace(/\s+/g, " ");
    if (identifier) currentBook = book = { ...book, key: `id:${identifier}` };
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
  // A visit opens at its passage; reading opens at the saved place.
  const start = (visit ? visit.passage.source?.cfi : book.cfi) || null;
  try {
    await readerView.init({ lastLocation: start, showTextStart: true });
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
    if (start) { try { await readerView.goTo(start); } catch {} }
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
  tocTab = tab === "bookmarks" || tab === "passages" ? tab : "contents";
  const tabs = { contents: [els.tocContentsTab, els.tocList], bookmarks: [els.tocBookmarksTab, els.bookmarksList], passages: [els.tocPassagesTab, els.passagesPanel] };
  for (const [name, [button, panel]] of Object.entries(tabs)) {
    button.classList.toggle("active", name === tocTab);
    button.setAttribute("aria-selected", String(name === tocTab));
    panel.classList.toggle("hidden", name !== tocTab);
  }
  els.tocLocation.classList.toggle("hidden", tocTab !== "contents");
  if (tocTab === "bookmarks") { renderBookmarks(); els.bookmarksList.scrollTop = 0; }
  if (tocTab === "passages") { renderPassagesPanel(); els.passagesList.scrollTop = 0; }
  setPassagesPolling(tocTab === "passages");
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
function openTocView(tab = "contents") {
  closeReaderPopups();
  closeReaderSheets();
  const current = updateTocView();
  setTocTab(tab);
  els.tocView.classList.remove("hidden");
  if (current) current.scrollIntoView({ block: "center" });
  else els.tocList.scrollTop = 0;
}
function closeTocView() { els.tocView.classList.add("hidden"); setPassagesPolling(false); }
function closeReader() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); if (readerView) { readerView.close(); readerView.remove(); } readerView = null; currentBook = null; visit = null; lastRelocateMarker = null; pageTurnsSinceRefresh = 0; clearTimeout(refreshFlashTimer); closeTocView(); closeReaderPopups(); closeReaderSheets(); pendingSelection = null; sheetSpan = null; markRects.clear(); tints.clear(); drawnMarks.clear(); updateVisitBar(); els.reader.classList.add("hidden"); document.body.classList.remove("reader-open"); loadLibrary(); }
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
    ${highlightRules()}
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
    // definition popover (or annotation sheet) before this pointerup runs — see
    // dictTapConsumed.
    dictWasOpen = readerSheetOpen();
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
  if (!dictWasOpen && !readerSheetOpen()) return false;
  closeReaderSheets();
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
// Text selected in the book whose sheet is not up yet (it waits for the
// selection to settle).
function bookSelecting() {
  try {
    return readerView.renderer.getContents().some(({ doc }) => { const sel = doc.getSelection(); return !!sel && !sel.isCollapsed; });
  } catch { return false; }
}
function pageTurnTap(e, dictWasOpen) {
  if (readerTapConsumed(dictWasOpen)) return;
  // A tap beside the text while some of it is selected puts the selection away.
  if (bookSelecting()) { dropSelection(); return; }
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
  leaveReader();
});
els.hitBack.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); leaveReader(); }
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
  const selecting = () => { const sel = doc.getSelection(); return !!sel && !sel.isCollapsed; };
  // A finger on the page is one of three things, and only one of them may move
  // the page. A swipe travels before the long press comes due, and is left to
  // Foliate, which scrolls with it and snaps to a page when it lifts. A tap
  // stays put and lifts early; it is HonLib's, turned by the pointerup below
  // (Foliate would snap() on its touchend too, and on a chapter's last page
  // that starts a second section transition alongside ours). A hold is a
  // selection being made or stretched, and it wobbles and drags: let Foliate
  // see that movement and it scrolls the page under the finger, then snaps to
  // the next one on the speed of the lift. So a touch that has been held, that
  // has raised the long-press menu, or that lands while text is selected is
  // withheld from Foliate from then on. Multi-touch stays with the renderer.
  let touchX = 0, touchY = 0, touchAt = 0, touchKind = null;   // "undecided" | "swipe" | "hold"
  doc.addEventListener("touchstart", (e) => {
    const touch = e.touches.length === 1 ? e.changedTouches[0] : null;
    touchKind = !touch ? null : selecting() ? "hold" : "undecided";
    touchX = touch?.clientX || 0;
    touchY = touch?.clientY || 0;
    touchAt = e.timeStamp;
  }, true);
  doc.addEventListener("touchmove", (e) => {
    if (!touchKind) return;
    if (touchKind === "undecided") {
      const touch = e.changedTouches[0];
      if (selecting() || e.timeStamp - touchAt >= HOLD_MS) touchKind = "hold";
      else if (!touch || Math.abs(touch.clientX - touchX) > TAP_SLOP_PX || Math.abs(touch.clientY - touchY) > TAP_SLOP_PX) touchKind = "swipe";
    }
    if (touchKind === "swipe") return;
    e.stopImmediatePropagation();
    // What Foliate would have done with it, minus the scrolling: it leaves a
    // zoomed-in page to be panned.
    if (e.cancelable && (window.visualViewport?.scale ?? 1) === 1) e.preventDefault();
  }, true);
  doc.addEventListener("touchcancel", () => { touchKind = null; }, true);
  doc.addEventListener("touchend", (e) => {
    if (!touchKind) return;
    if (touchKind !== "swipe") e.stopImmediatePropagation();
    touchKind = null;
    // The tap that ends a carried passage is spent on that: without the click
    // that would follow it, the page keeps the passage shown as selected.
    if (carry && e.cancelable) e.preventDefault();
  }, true);

  let sx = 0, sy = 0, st = 0, moved = false, held = false, tracking = false;
  doc.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) return;
    tracking = true; moved = false; held = false; sx = e.clientX; sy = e.clientY; st = Date.now();
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (tracking && (Math.abs(e.clientX - sx) > TAP_SLOP_PX || Math.abs(e.clientY - sy) > TAP_SLOP_PX)) moved = true;
  }, true);
  // The long press coming due, by the device's own clock. It says so whether
  // or not it found a word to select, and a press that got this far was never
  // a tap, however soon afterwards the finger lifts.
  doc.addEventListener("contextmenu", () => {
    held = true;
    if (touchKind === "undecided") touchKind = "hold";
  }, true);
  doc.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    // A drag or long-press is a selection gesture (dictionary), never a tap.
    if (moved || held || Date.now() - st > TAP_MAX_MS) return;
    // A passage carried over from the page before ends at the word tapped.
    if (carry) { endCarryAt(doc, e.clientX, e.clientY); return; }
    if (selecting()) return;
    if (readerTapConsumed()) return;
    // Let foliate handle in-book links.
    if (e.target.closest && e.target.closest("a")) return;
    // A tap on a highlight or underline opens that passage instead of turning.
    const marked = passageAt(doc, e.clientX, e.clientY);
    if (marked) { openPassageView(marked.id); return; }
    // Convert the tap out of chapter-strip space before applying the zone rule.
    const frame = doc.defaultView && doc.defaultView.frameElement;
    const fr = frame ? frame.getBoundingClientRect() : els.viewer.getBoundingClientRect();
    turnAtHostX(fr.left + e.clientX);
  }, true);
  doc.addEventListener("selectionchange", () => {
    followSelection(doc);
    clearTimeout(dictDebounce);
    dictDebounce = setTimeout(() => evaluateSelection(doc), 250);
  });
}
// The moment text is selected, and on every change as it is stretched: get out
// of its way. The reading menu sits over the foot of the page, and a sheet
// that is already up keeps to the edge of the selection as it grows.
function followSelection(doc) {
  const sel = doc.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  if (!els.reader.classList.contains("chrome-hidden")) hideReaderChrome();
  if (!readerSheetOpen() || (passageSheet && passageSheet.mode !== "new")) return;
  const span = spanInReader(doc, sel.getRangeAt(0).getClientRects());
  if (!span) return;
  sheetSpan = span;
  placeReaderSheets();
}
function evaluateSelection(doc) {
  const sel = doc.getSelection();
  const text = sel && sel.rangeCount && !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim() : "";
  // A carried passage is held here, not in the selection: the tap that picks
  // its end is free to clear whatever the page still has selected.
  if (carry) { if (text && carry.doc === doc) endCarry(doc, sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset); return; }
  if (!text) { pendingSelection = null; closeDictPopover(); closeSelectionBar(); return; }
  const index = sectionIndexOf(doc);
  const range = sel.getRangeAt(0).cloneRange();
  pendingSelection = index == null ? null : { doc, index, range, text, savedId: null };
  sheetSpan = spanInReader(doc, range.getClientRects());
  // A single word (surrounding punctuation stripped) is looked up; anything
  // more is a passage to annotate.
  const word = text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
  if (word && !/\s/.test(word) && /^[A-Za-z][A-Za-z'-]*$/.test(word) && word.length <= 64) { closePassageSheet(); lookupWord(word); return; }
  closeDictPopover();
  if (pendingSelection) openSelectionBar();
}
function dropSelection() {
  pendingSelection = null;
  try { readerView?.deselect(); } catch {}
}
// ---- Where the sheets sit ----------------------------------------------
// The definition and annotation sheets sit beside the text they are about:
// just under it, or just over it where there is no room beneath. The eye and
// the thumb are already there, and the words being marked are never the ones
// covered. With nothing on the page to sit beside, they dock at the foot of
// the screen.
const SHEET_EDGE_PX = 12;
// The gap left under a passage, which the system's selection handles hang
// into, and the smaller one left over it.
const SHEET_UNDER_PX = 32, SHEET_OVER_PX = 10;
// Top and bottom, in the reader's coordinates, of the part of some text that
// is on the page showing. `rects` are in the coordinates of `doc`, whose frame
// holds the whole chapter side by side, a page to a column.
function spanInReader(doc, rects) {
  const frame = doc?.defaultView?.frameElement;
  if (!frame) return null;
  const at = frame.getBoundingClientRect(), reader = els.reader.getBoundingClientRect();
  let top = Infinity, bottom = -Infinity;
  for (const r of rects) {
    if (at.left + r.right <= reader.left || at.left + r.left >= reader.right) continue;   // on another page
    top = Math.min(top, at.top + r.top - reader.top);
    bottom = Math.max(bottom, at.top + r.bottom - reader.top);
  }
  return top <= bottom ? { top, bottom } : null;
}
function markSpan(id) {
  const mark = markRects.get(id);
  return mark ? spanInReader(mark.doc, mark.rects) : null;
}
// `atTop` forces the top edge: the tools that bring up a keyboard sit there,
// where the keyboard can't cover them.
function placeReaderSheet(el, atTop = false) {
  if (el.classList.contains("hidden")) return;
  const reader = els.reader.getBoundingClientRect();
  // The highest it may sit: below the visit strip when there is one.
  const first = els.viewer.getBoundingClientRect().top - reader.top + SHEET_EDGE_PX;
  let top = atTop ? first : null;
  if (top == null && sheetSpan) {
    const height = el.offsetHeight, last = reader.height - SHEET_EDGE_PX - height;
    const under = sheetSpan.bottom + SHEET_UNDER_PX, over = sheetSpan.top - SHEET_OVER_PX - height;
    if (under <= last) top = under;
    else if (over >= first) top = over;
    else {
      // A passage that leaves no room either side: the edge that covers less of it.
      const covered = (from) => Math.max(0, Math.min(from + height, sheetSpan.bottom) - Math.max(from, sheetSpan.top));
      top = covered(first) < covered(last) ? first : last;
    }
  }
  el.classList.toggle("placed", top != null);
  el.style.top = top == null ? "" : `${Math.round(top)}px`;
}
function placeReaderSheets() {
  placeReaderSheet(els.dictPopover);
  placeReaderSheet(els.passageSheet, passageSheet?.tool === "tag" || passageSheet?.tool === "note");
}
async function lookupWord(word) {
  const reqId = ++dictReqId;
  showDictPopover(`<div class="dict-word">${escapeHtml(word)}</div><div class="dict-status">Looking up…</div>`);
  let data;
  try { data = await api(`/api/dictionary/${encodeURIComponent(word.toLowerCase())}`); }
  catch { if (reqId === dictReqId) showDictPopover(`<div class="dict-word">${escapeHtml(word)}</div><div class="dict-status">Couldn't reach the dictionary.</div>`); return; }
  if (reqId !== dictReqId) return; // a newer selection superseded this lookup
  if (!data || data.notFound || !(data.meanings || []).length) {
    showDictPopover(`<div class="dict-word">${escapeHtml(word)}</div><div class="dict-status">No definition found.</div>`);
    return;
  }
  const head = `<div class="dict-word">${escapeHtml(data.word || word)}${data.phonetic ? `<span class="dict-phonetic">${escapeHtml(data.phonetic)}</span>` : ""}</div>`;
  // Keep the sheet glanceable without touch scrolling: show the lead
  // definition for each of the first few parts of speech.
  const body = data.meanings.slice(0, 4).map((m) =>
    `${m.partOfSpeech ? `<div class="dict-pos">${escapeHtml(m.partOfSpeech)}</div>` : ""}<ol class="dict-defs">${(m.definitions || []).slice(0, 1).map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ol>`
  ).join("");
  const attribution = data.sourceUrl
    ? `<div class="dict-attribution">From <a href="${escapeHtml(data.sourceUrl)}" target="_blank" rel="noopener noreferrer">Wiktionary</a>, via <a href="https://freedictionaryapi.com/" target="_blank" rel="noopener noreferrer">FreeDictionaryAPI.com</a> under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.</div>`
    : "";
  showDictPopover(head + body + attribution);
}
function showDictPopover(html) {
  // Save keeps the word as a passage. Offered whenever there is a selection to
  // keep, whatever the lookup itself comes back with.
  const save = pendingSelection && currentBook
    ? `<button class="dict-save" type="button"${pendingSelection.savedId ? " disabled" : ""}>${pendingSelection.savedId ? "Saved" : "Save"}</button>` : "";
  els.dictPopover.innerHTML = `<button class="dict-close" type="button" aria-label="Close definition">Done</button>${save}${html}`;
  els.dictPopover.classList.toggle("can-save", !!save);
  els.dictPopover.classList.remove("hidden");
  placeReaderSheets();
  // Done puts the word away too: left selected, it would go on taking taps.
  els.dictPopover.querySelector(".dict-close").addEventListener("click", () => { closeDictPopover(); dropSelection(); });
  els.dictPopover.querySelector(".dict-save")?.addEventListener("click", saveDictWord);
}
// Bump the request id so any in-flight lookup is ignored when it returns.
function closeDictPopover() { dictReqId++; clearTimeout(dictDebounce); els.dictPopover.classList.add("hidden"); }
// ---- Annotations -------------------------------------------------------
// Selecting more than a word brings up the annotation bar: Highlight,
// Underline, Tag, Note. Any of them saves the passage on the spot (it is on
// record, drawn on the page and filed before the tap returns) and then turns
// the bar into that passage's sheet. Tapping a mark later opens the same sheet.
function readerSheetOpen() { return !els.dictPopover.classList.contains("hidden") || !!passageSheet; }
function closeReaderSheets() { closeDictPopover(); closePassageSheet(); }
function closeSelectionBar() { if (passageSheet?.mode === "new") closePassageSheet(); }
function sectionIndexOf(doc) {
  try { return readerView.renderer.getContents().find((c) => c.doc === doc)?.index ?? null; } catch { return null; }
}
// A little of the text either side of a passage. Not shown anywhere yet; kept
// so a passage can be found again if a new edition of its book shifts the CFI.
function selectionContext(range, span = 120) {
  try {
    const doc = range.startContainer.ownerDocument;
    const before = doc.createRange(), after = doc.createRange();
    before.selectNodeContents(doc.body); before.setEnd(range.startContainer, range.startOffset);
    after.selectNodeContents(doc.body); after.setStart(range.endContainer, range.endOffset);
    const clean = (s) => s.replace(/\s+/g, " ");
    return { before: clean(before.toString()).slice(-span).trimStart(), after: clean(after.toString()).slice(0, span).trimEnd() };
  } catch { return { before: "", after: "" }; }
}
// The library reports a series position as the text the EPUB holds ("2", "2.0").
function seriesIndexOf(book) {
  const raw = book.series_index;
  const n = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}
// Save the pending selection as a passage. Returns { passage, created, first,
// prompt }: `created` is false when the selection was already a passage,
// `first` is the journal created for the very first highlight, `prompt` says
// the book is in no journal and the reader hasn't yet been asked about it.
function capturePassage(style, { keepSelection = false } = {}) {
  const pending = pendingSelection;
  if (!pending || !currentBook || !readerView) return null;
  let cfi;
  try { cfi = readerView.getCFI(pending.index, pending.range); } catch { return null; }
  const key = store.bookKey(currentBook);
  // Marking exactly what an existing passage covers opens that one rather than
  // stacking a second on top of it.
  let passage = store.passagesForBook(key).find((p) => p.source?.cfi === cfi);
  let first = null, prompt = false;
  const created = !passage;
  if (!passage) {
    const filing = store.filingFor(currentBook);
    let tocItem = null;
    try { tocItem = readerView.getProgressOf(pending.index, pending.range)?.tocItem; } catch {}
    passage = store.savePassage({
      id: store.newId(),
      deleted: false,
      text: pending.text,
      context: selectionContext(pending.range),
      note: "",
      tags: [],
      style,
      journals: filing.journals,
      source: {
        book_key: key,
        book_id: currentBook.id,
        title: currentBook.title || "",
        author: currentBook.author || "",
        series: store.bookSeries(currentBook),
        series_index: seriesIndexOf(currentBook),
        chapter: tocItem ? tocItemLabel(tocItem) : "",
        cfi,
        percent: pending.fraction ?? (currentLocation.fraction || 0),
      },
    });
    first = filing.first;
    prompt = !filing.journals.length && !filingDismissed(key);
  }
  if (!keepSelection) { pendingSelection = null; try { readerView.deselect(); } catch {} }
  return { passage, created, first, prompt };
}
// Save on the definition sheet: the word becomes a passage and the definition
// stays up. Only a book that is in no journal yet interrupts, once, to ask
// where it should be collected.
function saveDictWord() {
  const pending = pendingSelection;
  const result = capturePassage({ highlight: lastStyle().highlight, underline: null }, { keepSelection: true });
  if (!result) return;
  if (result.prompt) { openPassageSheet(result.passage.id, "file"); return; }
  pending.savedId = result.passage.id;
  const button = els.dictPopover.querySelector(".dict-save");
  if (button) { button.textContent = "Saved"; button.disabled = true; }
}

// Drawing. foliate hands back the passage's range; the mark is built from the
// rectangles of its text, line by line, so a highlight covers the words and not
// the whole block of any paragraph the range happens to enclose.
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}
function lineRects(range) {
  const doc = range.startContainer.ownerDocument;
  const found = [];
  const add = (node) => {
    const r = doc.createRange();
    r.selectNodeContents(node);
    if (node === range.startContainer) r.setStart(node, range.startOffset);
    if (node === range.endContainer) r.setEnd(node, range.endOffset);
    for (const rect of r.getClientRects()) if (rect.width > 0.5 && rect.height > 0.5) found.push(rect);
  };
  const root = range.commonAncestorContainer;
  if (root.nodeType === 3) add(root);
  else {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (range.intersectsNode(node)) add(node);
  }
  // Join the pieces of one line (a word in italics is its own rectangle) so the
  // highlight is one clean bar and an underline doesn't break mid-line.
  const lines = [];
  for (const r of found) {
    const line = lines.find((l) =>
      Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > Math.min(l.bottom - l.top, r.height) * 0.6
      && r.left <= l.right + 3 && r.right >= l.left - 3);
    if (line) {
      line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom);
    } else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  return lines;
}
function underlineEl(style, r, ink) {
  const y = r.bottom - 1.5;
  const line = (at, attrs = {}) => svgEl("line", { x1: r.left, x2: r.right, y1: at, y2: at, stroke: ink, "stroke-width": 2, ...attrs });
  if (style === "dashed") return line(y, { "stroke-dasharray": "7 4" });
  if (style === "dotted") return line(y, { "stroke-width": 2.5, "stroke-dasharray": "0.1 5", "stroke-linecap": "round" });
  if (style === "double") {
    const g = svgEl("g");
    g.append(line(y + 0.5, { "stroke-width": 1.25 }), line(y - 2.5, { "stroke-width": 1.25 }));
    return g;
  }
  if (style === "wavy") {
    const half = 3.5, waves = Math.max(1, Math.round((r.right - r.left) / (half * 2)));
    const step = (r.right - r.left) / (waves * 2);
    let d = `M${r.left} ${y}`;
    for (let i = 0; i < waves * 2; i++) d += ` q${step / 2} ${i % 2 ? 2.5 : -2.5} ${step} 0`;
    return svgEl("path", { d, fill: "none", stroke: ink, "stroke-width": 1.5 });
  }
  return line(y);
}
// The tint of a highlight belongs behind the letters. The book's own document
// can put it there: a passage's range is registered as a CSS highlight, and the
// page paints the tint and then the text on it, as it does a selection. On the
// black page the same rule turns the letters dark, so the passage reads
// inverted; a tint dark enough to leave white letters readable cannot be seen
// at all on e-ink. The rules themselves are part of the reader's stylesheet
// (see highlightRules).
// Passage id -> { set, range }: the highlight a passage's range was added to.
const tints = new Map();
function highlightRules() {
  return store.HIGHLIGHTS.map((h) => `::highlight(honlib-${h.id}){background-color:${h.color};color:#000}`).join("");
}
// Tint `range` in the colour `colorId`, or clear the passage's tint when there
// is none. False when this document cannot paint highlights itself.
function tintPassage(id, doc, range, colorId) {
  const old = tints.get(id);
  if (old) { old.set.delete(old.range); tints.delete(id); }
  if (!range || !colorId) return true;
  const view = doc?.defaultView, registry = view?.CSS?.highlights;
  if (!registry || !view.Highlight) return false;
  const name = `honlib-${colorId}`;
  let set = registry.get(name);
  if (!set) { set = new view.Highlight(); registry.set(name, set); }
  set.add(range);
  tints.set(id, { set, range });
  return true;
}
// Where the document can't, the tint is drawn over the page and blended into
// it: multiplied on a white page, so the letters stay black, and "difference"
// on a black one, for the same inverted passage. That depends on the browser
// compositing the overlay together with the page beneath it; when it doesn't,
// the tint lands on top of the words, opaque. Without blending at all, fall
// back to a translucent wash.
const CAN_BLEND = typeof CSS !== "undefined" && CSS.supports?.("mix-blend-mode", "multiply") && CSS.supports?.("mix-blend-mode", "difference");
function passageMark(_rects, { id, doc, range }) {
  const g = svgEl("g");
  let rects = [];
  try { rects = lineRects(range); } catch {}
  markRects.set(id, { doc, rects });
  const p = store.passage(id);
  if (!p) { tintPassage(id); return g; }
  const dark = readerSettings.theme === "dark";
  const highlight = store.highlightById(p.style?.highlight);
  if (!tintPassage(id, doc, highlight && range, highlight?.id) && highlight) {
    const fill = svgEl("g", { fill: highlight.color });
    if (CAN_BLEND) fill.style.mixBlendMode = dark ? "difference" : "multiply";
    else fill.style.opacity = dark ? "0.6" : "0.4";
    for (const r of rects) fill.append(svgEl("rect", { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }));
    g.append(fill);
  }
  if (store.underlineById(p.style?.underline)) {
    // Ink against whatever is behind it: white on the bare black page, black
    // everywhere else, including on a highlight in the dark theme.
    const ink = dark && !highlight ? "#fff" : "#000";
    for (const r of rects) g.append(underlineEl(p.style.underline, r, ink));
  }
  return g;
}
function bookPassages() {
  return currentBook ? store.passagesForBook(store.bookKey(currentBook)).filter((p) => p.source?.cfi) : [];
}
function drawMark(p) {
  drawnMarks.set(p.id, { cfi: p.source.cfi, sig: JSON.stringify(p.style || {}) });
  Promise.resolve().then(() => readerView?.addAnnotation({ value: p.source.cfi, id: p.id })).catch(() => {});
}
function drawSectionMarks(index) {
  // Rectangles recorded for a section that has since been unloaded are dead.
  for (const [id, mark] of markRects) if (!mark.doc?.defaultView) { markRects.delete(id); tints.delete(id); }
  for (const p of bookPassages()) {
    let section = null;
    try { section = readerView.resolveCFI(p.source.cfi)?.index; } catch {}
    if (section === index) drawMark(p);
  }
}
// Bring the page in line with the store: draw what is new or restyled, remove
// what is gone. Runs on every change, local or from another device.
function syncMarks() {
  if (!readerView || !currentBook) return;
  const wanted = new Map(bookPassages().map((p) => [p.id, p]));
  const erased = new Set();
  for (const [id, drawn] of drawnMarks) {
    if (wanted.get(id)?.source.cfi === drawn.cfi) continue;
    drawnMarks.delete(id);
    markRects.delete(id);
    tintPassage(id);
    erased.add(drawn.cfi);
    Promise.resolve().then(() => readerView?.deleteAnnotation({ value: drawn.cfi })).catch(() => {});
  }
  for (const [id, p] of wanted) {
    // foliate keys a mark by its CFI. Two devices can each mark the very same
    // range, so erasing one passage's mark may have erased another's with it.
    if (erased.has(p.source.cfi) || drawnMarks.get(id)?.sig !== JSON.stringify(p.style || {})) drawMark(p);
  }
}
// The passage under a point of a loaded section, if any. Where marks overlap,
// the smaller one wins: it is the one that can't be reached any other way.
function passageAt(doc, x, y) {
  let best = null, bestArea = Infinity;
  for (const [id, mark] of markRects) {
    if (mark.doc !== doc) continue;
    if (!mark.rects.some((r) => x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 2)) continue;
    const area = mark.rects.reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);
    const p = store.passage(id);
    if (p && area < bestArea) { best = p; bestArea = area; }
  }
  return best;
}

// The sheet.
const SHEET_TOOLS = [["highlight", "Highlight"], ["underline", "Underline"], ["tag", "Add tag"], ["note", "Add note"]];
// The selection bar, and the same bar for a passage being carried over a page
// turn (see continuePassage). Reopening it must not let go of the carry.
function showNewSheet(html) {
  const carried = carry;
  carry = null;
  closePassageSheet();
  carry = carried;
  passageSheet = { mode: "new" };
  els.passageSheet.innerHTML = html;
  els.passageSheet.classList.remove("hidden");
  placeReaderSheets();
}
function openSelectionBar() {
  const text = pendingSelection.text;
  // A carried passage shows where it starts and where it now ends.
  const quote = text.length <= 140 ? text
    : carry ? `${text.slice(0, 70).trimEnd()} … ${text.slice(-60).trimStart()}`
    : `${text.slice(0, 140).trimEnd()}…`;
  showNewSheet(`<div class="ps-head"><div class="ps-quote">${escapeHtml(quote)}</div>${carry ? `<button type="button" class="ps-close" data-ps-close>Cancel</button>` : ""}</div>` +
    `<div class="ps-bar">${SHEET_TOOLS.map(([tool, label]) => `<button type="button" data-ps-new="${tool}">${label}</button>`).join("")}</div>` +
    (reachesPageEnd(pendingSelection) ? `<button type="button" class="ps-continue" data-ps-continue>Continue on next page</button>` : "") +
    (carry ? `<div class="ps-status">Tap another word to move the end.</div>` : ""));
}
// ---- A passage that runs on to the next page ---------------------------
// The page never turns under a selection (see ownPageTurns), so a passage that
// crosses the page break is carried across on request. Selecting to the foot
// of the page offers "Continue on next page"; that turns the page and asks for
// the last word of the passage, by a tap, which an e-reader's screen takes far
// more reliably than a second press-and-hold.
function reachesPageEnd(pending) {
  try {
    const visible = readerView.lastLocation?.range, renderer = readerView.renderer;
    if (!visible || visible.endContainer.ownerDocument !== pending.doc) return false;
    // The first and last pages of a section's strip are blank, for the turn
    // into its neighbours. A passage cannot leave its section.
    if (renderer.page >= renderer.pages - 2) return false;
    if (pending.range.compareBoundaryPoints(Range.END_TO_END, visible) >= 0) return true;
    const lastLine = (range) => [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5).pop();
    const end = lastLine(pending.range), foot = lastLine(visible);
    // On the page's last line: level with it, and in the same column.
    return !!end && !!foot && Math.abs(end.left - foot.left) < renderer.size && end.bottom > foot.top + 1;
  } catch { return false; }
}
function continuePassage() {
  const pending = pendingSelection;
  if (!pending || !readerView) return;
  carry = carry || { doc: pending.doc, index: pending.index, node: pending.range.startContainer, offset: pending.range.startOffset, fraction: currentLocation.fraction || 0 };
  // The relocation this causes opens the carry bar on the new page.
  turnPage(() => readerView.next());
}
function openCarryBar() {
  const text = pendingSelection?.text || "";
  showNewSheet(`<div class="ps-head"><div class="ps-quote">${escapeHtml(text.length > 140 ? `${text.slice(0, 140).trimEnd()}…` : text)}</div><button type="button" class="ps-close" data-ps-close>Cancel</button></div>` +
    `<div class="ps-status">Tap the last word of the passage.</div>`);
}
function caretAt(doc, x, y) {
  if (doc.caretPositionFromPoint) {
    const at = doc.caretPositionFromPoint(x, y);
    return at && { node: at.offsetNode, offset: at.offset };
  }
  const at = doc.caretRangeFromPoint?.(x, y);
  return at && { node: at.startContainer, offset: at.startOffset };
}
function endCarryAt(doc, x, y) {
  if (carry.doc !== doc) return;
  const at = caretAt(doc, x, y);
  if (!at || at.node.nodeType !== Node.TEXT_NODE) return;
  // Through to the end of the word that was tapped.
  const rest = at.node.data.slice(at.offset).search(/\s/);
  endCarry(doc, at.node, rest < 0 ? at.node.data.length : at.offset + rest);
}
function endCarry(doc, node, offset) {
  const range = doc.createRange();
  try { range.setStart(carry.node, carry.offset); range.setEnd(node, offset); } catch { return; }
  // An end before the start leaves nothing between them.
  const text = range.toString().replace(/\s+/g, " ").trim();
  if (!text) return;
  // Setting the selection below comes back round as a selection change; the
  // bar is already showing this very passage then, and is left alone.
  const was = pendingSelection?.range;
  const same = !!was && !!els.passageSheet.querySelector("[data-ps-new]")
    && was.compareBoundaryPoints(Range.START_TO_START, range) === 0 && was.compareBoundaryPoints(Range.END_TO_END, range) === 0;
  pendingSelection = { doc, index: carry.index, range, text, savedId: null, fraction: carry.fraction };
  // Shown as selected, where the page will hold a selection it did not make.
  try { doc.getSelection().setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset); } catch {}
  sheetSpan = spanInReader(doc, range.getClientRects());
  if (!same) openSelectionBar();
}
function captureFromBar(tool) {
  const last = lastStyle();
  const style = tool === "underline" ? { highlight: null, underline: last.underline } : { highlight: last.highlight, underline: null };
  const result = capturePassage(style);
  if (!result) { closePassageSheet(); return; }
  // Already a passage: show it, as a tap on its mark would.
  if (!result.created) { openPassageView(result.passage.id); return; }
  // An uncovered book asks where to file first, then carries on to the tool
  // that was tapped.
  if (result.prompt) openPassageSheet(result.passage.id, "file", { then: tool });
  else openPassageSheet(result.passage.id, tool, { notice: result.first ? `Saved to ${result.first.name}.` : "" });
}
// A passage made earlier opens to be read, not edited: its text and note, the
// way to it in its journal, and "Edit annotation" for the tools. Editing is one
// more tap away, so that a stray tap on a mark can't restyle or delete it.
function openPassageView(id) {
  closeReaderSheets();
  if (!store.passage(id)) return;
  sheetSpan = markSpan(id) || sheetSpan;
  passageSheet = { mode: "view", id };
  els.passageSheet.innerHTML = `<div class="ps-head"><div class="ps-quote"></div><button type="button" class="ps-close" data-ps-close>Done</button></div>` +
    `<div class="ps-note"></div><div class="ps-bar"></div><div class="ps-status"></div>`;
  els.passageSheet.classList.remove("hidden");
  updatePassageSheet();
}
function passageJournalNames(p) { return store.journalIdsOf(p).map((id) => store.journal(id).name); }
function updatePassageView(p) {
  const set = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
  set(els.passageSheet.querySelector(".ps-quote"), quoteHtml(p, 140));
  els.passageSheet.querySelector(".ps-note").textContent = p.note || "";
  // One way in per journal the passage is in; Unfiled when it is in none.
  const ids = store.journalIdsOf(p);
  const links = !ids.length ? [[UNFILED, "View in Unfiled"]]
    : ids.length === 1 ? [[ids[0], "View in journal"]]
    : ids.map((id) => [id, `View in ${store.journal(id).name}`]);
  set(els.passageSheet.querySelector(".ps-bar"),
    links.map(([id, label]) => `<button type="button" data-ps-journal="${escapeHtml(id)}">${escapeHtml(label)}</button>`).join("") +
    `<button type="button" data-ps-edit>Edit annotation</button>`);
  const names = passageJournalNames(p);
  const details = [names.length ? `In ${names.join(", ")}` : "Unfiled", store.styleLabel(p.style), ...(p.tags || []).map((t) => `#${t}`)];
  els.passageSheet.querySelector(".ps-status").textContent = details.filter(Boolean).join(" · ");
}
// The journal opens over the page, on this passage. The book stays open
// underneath, at the same place, and going back uncovers it.
function viewInJournal(passageId, journalId) {
  closePassageSheet();
  closeReaderPopups();
  openJournal(journalId, { focus: passageId, overReader: true });
}
function openPassageSheet(id, tool = null, { notice = "", then = null } = {}) {
  closeReaderSheets();
  if (!store.passage(id)) return;
  // A passage made a moment ago is not drawn yet; it is where the selection was.
  sheetSpan = markSpan(id) || sheetSpan;
  passageSheet = { mode: "edit", id, tool: null, handle: null, notice, then };
  els.passageSheet.innerHTML = `<div class="ps-head"><div class="ps-quote"></div><button type="button" class="ps-close" data-ps-close>Done</button></div>` +
    // With more than one journal, which of them this passage is in is a choice.
    `<div class="ps-bar">${SHEET_TOOLS.map(([name]) => `<button type="button" data-ps-tool="${name}"></button>`).join("")}${
      store.journals().length > 1 ? `<button type="button" data-ps-tool="journals"></button>` : ""}<button type="button" data-ps-delete>Delete</button></div>` +
    `<div class="ps-panel hidden"></div><div class="ps-status"></div>`;
  els.passageSheet.classList.remove("hidden");
  updatePassageSheet();
  if (tool) setSheetTool(tool);
}
function closePassageSheet() {
  const sheet = passageSheet;
  if (!sheet) return;
  const hadFocus = els.passageSheet.contains(document.activeElement);
  passageSheet = null;
  // Closing the sheet abandons a passage being carried over a page turn, and
  // the part of it still selected on the page before.
  if (carry) { carry = null; dropSelection(); }
  sheet.handle?.commit?.();
  els.passageSheet.classList.add("hidden");
  els.passageSheet.innerHTML = "";
  // Hand the keyboard back to the book, or hardware page-turn keys go nowhere.
  if (hadFocus) { try { readerView?.renderer?.focusView?.(); } catch {} }
}
// Refresh the sheet's labels in place. The buttons themselves are never
// replaced, so a change landing mid-tap can't swallow the tap.
function updatePassageSheet() {
  const sheet = passageSheet;
  if (!sheet || sheet.mode === "new") return;
  const p = store.passage(sheet.id);
  if (!p) { closePassageSheet(); return; }
  if (sheet.mode === "view") { updatePassageView(p); placeReaderSheets(); return; }
  const h = store.highlightById(p.style?.highlight), u = store.underlineById(p.style?.underline);
  const labels = {
    highlight: h ? `<span class="ps-swatch" style="background:${h.color}"></span>${escapeHtml(h.label)}` : "Highlight",
    underline: u ? `<span class="ps-line ul-${u.id}">${escapeHtml(u.label)}</span>` : "Underline",
    tag: (p.tags || []).length ? `Tags (${p.tags.length})` : "Add tag",
    note: p.note ? "Edit note" : "Add note",
    journals: store.journalIdsOf(p).length ? `Journals (${store.journalIdsOf(p).length})` : "Add to journal",
  };
  const set = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
  set(els.passageSheet.querySelector(".ps-quote"), quoteHtml(p, 140));
  for (const button of els.passageSheet.querySelectorAll("[data-ps-tool]")) {
    set(button, labels[button.dataset.psTool]);
    button.classList.toggle("active", button.dataset.psTool === sheet.tool);
    button.setAttribute("aria-pressed", String(button.dataset.psTool === sheet.tool));
  }
  const names = passageJournalNames(p);
  els.passageSheet.querySelector(".ps-status").textContent = sheet.notice || (names.length ? `In ${names.join(", ")}` : "Unfiled");
  placeReaderSheets();
}
function setSheetTool(tool) {
  const sheet = passageSheet;
  if (sheet?.mode !== "edit") return;
  const panel = els.passageSheet.querySelector(".ps-panel");
  sheet.handle?.commit?.();
  sheet.handle = null;
  sheet.tool = tool;
  panel.replaceChildren();
  panel.classList.toggle("hidden", !tool);
  if (tool === "highlight" || tool === "underline") sheet.handle = mountStyleTool(panel, sheet.id, [tool]);
  else if (tool === "tag") sheet.handle = mountTagTool(panel, sheet.id);
  else if (tool === "note") sheet.handle = mountNoteTool(panel, sheet.id, () => { if (passageSheet === sheet) setSheetTool(null); });
  else if (tool === "journals") sheet.handle = mountJournalsTool(panel, sheet.id);
  else if (tool === "file") {
    sheet.handle = mountFilingTool(panel, sheet.id, currentBook, () => {
      if (passageSheet !== sheet) return;
      const next = sheet.then;
      sheet.then = null;
      setSheetTool(next);
    });
  }
  updatePassageSheet();
  sheet.handle?.focus?.();
}
els.passageSheet.addEventListener("click", (e) => {
  const fresh = e.target.closest("[data-ps-new]"), tool = e.target.closest("[data-ps-tool]"), journal = e.target.closest("[data-ps-journal]");
  if (fresh) captureFromBar(fresh.dataset.psNew);
  else if (e.target.closest("[data-ps-continue]")) continuePassage();
  else if (journal && passageSheet?.id) viewInJournal(passageSheet.id, journal.dataset.psJournal);
  else if (e.target.closest("[data-ps-edit]") && passageSheet?.id) openPassageSheet(passageSheet.id);
  else if (tool) setSheetTool(passageSheet?.tool === tool.dataset.psTool ? null : tool.dataset.psTool);
  else if (e.target.closest("[data-ps-close]")) {
    // Cancel, on a passage not yet made: let go of the selection as well.
    const unmade = passageSheet?.mode === "new";
    closePassageSheet();
    if (unmade) dropSelection();
  }
  else if (e.target.closest("[data-ps-delete]") && passageSheet?.id) {
    if (!confirm("Delete this passage?\n\nIt is removed from every journal and from the book.")) return;
    const id = passageSheet.id;
    closePassageSheet();
    store.deletePassage(id);
  }
});

// ---- Passages tab ------------------------------------------------------
// Beside Chapters and Bookmarks. "This book" lists its passages in page order;
// "Journal" lists everything in the journals this book belongs to, across
// books, so a passage from an earlier volume is one tap away mid-read.
function setPassagesPolling(on) {
  if (on === passagesPolling) return;
  passagesPolling = on;
  if (on) store.startPolling(); else store.stopPolling();
}
function comparePassagesInBook(a, b) {
  try { return CFI.compare(a.source.cfi, b.source.cfi); }
  catch { return (Number(a.source?.percent) || 0) - (Number(b.source?.percent) || 0); }
}
// The journals this book belongs to: those that collect from it now, and any
// that still hold passages from when they did.
function panelJournalIds() {
  const ids = new Set(store.journalsCovering(currentBook).map((j) => j.id));
  for (const p of bookPassages()) for (const id of store.journalIdsOf(p)) ids.add(id);
  return [...ids];
}
function panelJournalPassages() {
  const ids = panelJournalIds();
  return store.passages().filter((p) => store.journalIdsOf(p).some((id) => ids.includes(id)));
}
function panelPassages() {
  if (passagesScope === "book") return bookPassages().sort(comparePassagesInBook);
  const key = store.bookKey(currentBook), query = els.passagesSearch.value, tag = els.passagesTag.value;
  return panelJournalPassages()
    .filter((p) => store.matchesQuery(p, query) && (!tag || store.hasTag(p, tag)))
    .sort((a, b) => {
      const ka = a.source?.book_key, kb = b.source?.book_key;
      if (ka === kb) return comparePassagesInBook(a, b);
      // The open book first, then the others by title.
      if (ka === key || kb === key) return ka === key ? -1 : 1;
      return String(a.source?.title || "").localeCompare(String(b.source?.title || ""), undefined, { sensitivity: "base" });
    });
}
function renderPassagesPanel() {
  if (!currentBook) return;
  const journalScope = passagesScope === "journal";
  els.passagesScopeBook.classList.toggle("active", !journalScope);
  els.passagesScopeJournal.classList.toggle("active", journalScope);
  els.passagesScopeBook.setAttribute("aria-pressed", String(!journalScope));
  els.passagesScopeJournal.setAttribute("aria-pressed", String(journalScope));
  els.passagesSearch.classList.toggle("hidden", !journalScope);
  els.passagesTag.classList.toggle("hidden", !journalScope);
  if (journalScope && document.activeElement !== els.passagesTag) {
    const tags = store.tagsOf(panelJournalPassages()), current = els.passagesTag.value;
    els.passagesTag.innerHTML = `<option value="">All tags</option>` + tags.map((t) => `<option value="${escapeHtml(t.tag)}">${escapeHtml(t.tag)} (${t.count})</option>`).join("");
    els.passagesTag.value = tags.some((t) => t.tag === current) ? current : "";
  }
  const key = store.bookKey(currentBook);
  const list = panelPassages();
  if (!list.length) {
    const message = !journalScope ? "No passages yet. Select some text on a page to highlight it."
      : !panelJournalIds().length ? "This book isn't in a journal yet."
      : "No passages match.";
    els.passagesList.innerHTML = `<div class="bookmarks-empty">${message}</div>`;
    return;
  }
  els.passagesList.innerHTML = list.map((p) => {
    const s = p.source || {};
    const meta = [s.book_key !== key ? s.title : "", s.chapter, `${Math.round((Number(s.percent) || 0) * 100)}% through`, store.styleLabel(p.style), ...(p.tags || []).map((t) => `#${t}`)];
    return `<button class="toc-item passage-item" data-passage-id="${escapeHtml(p.id)}"><span class="passage-item-quote">${quoteHtml(p, 220)}</span>` +
      `${p.note ? `<span class="passage-item-note">${escapeHtml(p.note)}</span>` : ""}<span class="bookmark-item-meta">${meta.filter(Boolean).map(escapeHtml).join(" · ")}</span></button>`;
  }).join("");
}
function setPassagesScope(scope) {
  passagesScope = scope === "journal" ? "journal" : "book";
  renderPassagesPanel();
  els.passagesList.scrollTop = 0;
}
els.passagesScopeBook.addEventListener("click", () => setPassagesScope("book"));
els.passagesScopeJournal.addEventListener("click", () => setPassagesScope("journal"));
let passagesSearchTimer = null;
els.passagesSearch.addEventListener("input", () => {
  clearTimeout(passagesSearchTimer);
  passagesSearchTimer = setTimeout(renderPassagesPanel, 120);
});
els.passagesTag.addEventListener("change", renderPassagesPanel);
els.passagesList.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-passage-id]");
  const p = b && store.passage(b.dataset.passageId);
  if (!p || !readerView || !currentBook) return;
  // A visit either way: looking up a passage is not reading on from it, even
  // when it is in the book that is open.
  if (p.source?.book_key === store.bookKey(currentBook)) { closeTocView(); visitInOpenBook(p, false); }
  else visitPassage(p);
});

// ---- Visits ------------------------------------------------------------
// Journal to book. The book opens at the passage and nothing about the visit is
// saved: the reader's place in that book and whether it is finished are exactly
// as they were. "Go to my place" turns the visit into ordinary reading from the
// saved place; backing out returns to the journal, and to the page that was
// open if the journal was consulted from inside a book. That holds when the
// passage is in the very book being read: going to look at it must not become
// the reader's place.
function visitPassage(passage) {
  const book = store.findBook(passage, allBooks);
  if (!book) { alert("This book is no longer in the library, so the passage can't open its page."); return; }
  const viaJournal = journalOverReader();
  // The visit shows on top; the journal waits underneath for "Back to journal".
  if (viaJournal) lowerJournal();
  if (readerView && currentBook && store.bookKey(currentBook) === passage.source?.book_key) {
    visitInOpenBook(passage, viaJournal);
    return;
  }
  // A visit made from within a visit keeps the original way back.
  const fromBook = visit ? visit.fromBook : currentBook;
  openReader(book, { passage, fromBook: fromBook || null, viaJournal: viaJournal || !!visit?.viaJournal });
}
// A passage in the book that is already open. No book to switch to: the visit
// starts where the reader is, remembering the page to return to.
function visitInOpenBook(passage, viaJournal) {
  // Already visiting (this book from another, or another passage a moment
  // ago): the way back stays as it was.
  visit = visit
    ? { ...visit, passage, viaJournal: viaJournal || visit.viaJournal }
    : { passage, fromBook: null, viaJournal, returnCfi: currentLocation.cfi || progress.books[currentBook.id]?.cfi || null };
  updateVisitBar();
  readerView.goTo(passage.source.cfi);
}
function updateVisitBar() {
  els.visitBar.classList.toggle("hidden", !visit);
  if (!visit) return;
  els.visitLabel.textContent = visit.returnCfi !== undefined ? "Visiting a passage"
    : `Visiting ${currentBook?.title || visit.passage.source?.title || "a passage"}`;
}
// Back to the journal as it was consulted: the journal view over the page, or
// the reader's own Passages tab.
function reopenJournal(viaJournal) {
  if (viaJournal) raiseJournal();
  else openTocView("passages");
}
function leaveReader() {
  if (!visit) { closeReader(); return; }
  const { fromBook, viaJournal } = visit;
  // Within the open book: back to the page that was being read.
  if (visit.returnCfi !== undefined) { goToMyPlace().then(() => reopenJournal(viaJournal)); return; }
  if (!fromBook) { closeReader(); return; }
  // Back to the book that was open.
  openReader(fromBook).then(() => {
    if (!viaJournal) passagesScope = "journal";
    reopenJournal(viaJournal);
  });
}
async function goToMyPlace() {
  if (!visit || !readerView || !currentBook) return;
  const saved = visit.returnCfi || progress.books[currentBook.id]?.cfi;
  // Hold saving until the reader has arrived, so the passage's page isn't
  // recorded as the place on the way there.
  readerReady = false;
  visit = null;
  updateVisitBar();
  try {
    if (saved) await readerView.goTo(saved);
    else await readerView.goToTextStart();
  } catch {}
  readerReady = true;
}
// Offline, a visit needs the book on this device. Its absence is not an error
// worth alarming anyone over, and the passage is still readable in the journal.
function showVisitUnavailable() {
  els.readerLoading.innerHTML = `<div class="visit-unavailable"><p>This book isn't on this device.</p><p>Did you sync the book to this device with Syncthing?</p><p class="visit-unavailable-note">The passage itself is still in your journal.</p><button type="button" class="btn">Back to journal</button></div>`;
  els.readerLoading.querySelector("button").addEventListener("click", leaveReader);
}
els.visitBack.addEventListener("click", leaveReader);
els.visitPlace.addEventListener("click", () => {
  const viaJournal = !!visit?.viaJournal;
  goToMyPlace().then(() => { if (viaJournal) dismissLoweredJournal(); });
});

// A journal or passage changed, here or on another device.
function onJournalChange() {
  syncMarks();
  updatePassageSheet();
  if (tocTab === "passages" && !els.tocView.classList.contains("hidden") && document.activeElement !== els.passagesSearch) renderPassagesPanel();
}
// Tapping the reader chrome (toolbar, edges) outside the popover dismisses it.
// Taps inside the book are handled by the per-document selection listener.
document.addEventListener("pointerdown", (e) => {
  if (!els.dictPopover.classList.contains("hidden") && !els.dictPopover.contains(e.target)) closeDictPopover();
  if (passageSheet && !els.passageSheet.contains(e.target)) closePassageSheet();
  if (!els.readerFonts.classList.contains("hidden") && !els.readerFonts.contains(e.target) && !e.target.closest('[data-role="font-menu"]')) closeReaderFontMenu();
  if (!els.readerRefreshPanel.classList.contains("hidden") && !els.readerRefreshPanel.contains(e.target) && !e.target.closest("#reader-refresh")) closeReaderRefreshMenu();
});
els.readerClose.addEventListener("click", leaveReader);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshOpenReaderProgress(); });
window.addEventListener("focus", refreshOpenReaderProgress);
els.tocToggle.addEventListener("click", openTocView);
els.readerCollapse.addEventListener("click", hideReaderChrome);
els.tocBack.addEventListener("click", closeTocView);
els.tocContentsTab.addEventListener("click", () => setTocTab("contents"));
els.tocBookmarksTab.addEventListener("click", () => setTocTab("bookmarks"));
els.tocPassagesTab.addEventListener("click", () => setTocTab("passages"));
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
  // A soft keyboard resizes the window. Re-paginating the book behind a note
  // that is being typed would flash an e-ink screen on every keystroke's worth
  // of layout; wait until the field is left.
  if (typingInReader()) { relayoutHeld = true; return; }
  relayoutHeld = false;
  readerResizeTimer = setTimeout(applyReaderTheme, 120);
}
let relayoutHeld = false;
function typingInReader() {
  const active = document.activeElement;
  return !!active && els.reader.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName);
}
els.reader.addEventListener("focusout", () => setTimeout(() => { if (relayoutHeld && !typingInReader()) scheduleReaderRelayout(); }, 0));
window.addEventListener("resize", scheduleReaderRelayout);
// The reader unhides from display:none, so the viewer often measures 0px on the
// first render — foliate then lays the text into a zero-width column and the
// page looks blank until something forces another render (which is why toggling
// the theme "fixes" it). Re-lay-out whenever the viewer's real size lands, which
// also covers orientation changes and e-ink relayouts.
if ("ResizeObserver" in window) {
  new ResizeObserver(scheduleReaderRelayout).observe(els.viewer);
}
// Foliate turns the page by itself when a selection runs past the end of the
// one showing, so that a drag can carry on. On a touchscreen nothing is being
// dragged: a long press on a word hyphenated across the page break is enough,
// and the page is gone from under the passage being marked. Page turns are the
// reader's to make, so the renderer's own are let through only from here. A
// passage that does run on is continued by asking (see continuePassage).
function ownPageTurns(renderer) {
  for (const dir of ["next", "prev"]) {
    const turn = renderer[dir].bind(renderer);
    renderer[dir] = (...args) => (turningPage ? turn(...args) : Promise.resolve());
  }
}
function turnPage(go) {
  turningPage = true;
  try { return go(); } finally { turningPage = false; }
}
// A passage being carried forward keeps its sheet through a turn of the page.
function readerNext() { if (readerView) { if (!carry) closePassageSheet(); turnPage(() => readerView.goRight()); } }
function readerPrev() { if (readerView) { closePassageSheet(); turnPage(() => readerView.goLeft()); } }
// Hook a native wrapper (e.g. an Android WebView that captures the BOOX volume
// buttons) can call: window.ebookTurnPage('next' | 'prev').
window.ebookTurnPage = (dir) => { if (readerView && !journalOverReader()) (dir === "prev" ? readerPrev() : readerNext()); };

// Page-turn keys. We accept the usual e-reader keys (arrows, PageUp/Down, space)
// plus the volume keycodes — so whatever a BOOX button remap or wrapper emits,
// the reader turns the page. (Chrome itself does NOT deliver volume keys to a
// web page; those branches only fire if something forwards a real key event.)
function handleReaderKey(e) {
  // With the journal over the page, keys are the journal's.
  if (!readerView || journalOverReader()) return;
  const tocOpen = !els.tocView.classList.contains("hidden");
  if (e.key === "Escape") {
    e.preventDefault();
    if (readerSheetOpen()) return closeReaderSheets();
    return tocOpen ? closeTocView() : leaveReader();
  }
  // Keys typed into a note, a tag or a search box are text, not page turns.
  if (e.target?.closest?.("input, textarea, select")) return;
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
// ---- Update notice -------------------------------------------------------
// Compare the build stamped into the bundle we were served with the one the
// server is offering. Current Android shells expose an explicit apply action
// that downloads (if necessary), activates, restarts the local proxy, and
// reloads. Older shells retain the cold-start instructions and never see a
// control they cannot handle.
//
// build-id.json exists only inside a built bundle; in a browser this 404s and
// the notice never appears, which is right — a reload there is already enough.
const UPDATE_DISMISSED_KEY = "ebook-library.updateDismissed";

function resetAppUpdateApply() {
  if (!els.appUpdateApply) return;
  els.appUpdateApply.disabled = false;
  els.appUpdateApply.textContent = "Apply update";
}

function configureAppUpdateAction() {
  const direct = typeof window.__readerShellApplyUpdate === "function";
  if (els.appUpdateMessage) {
    els.appUpdateMessage.textContent = direct
      ? "An update is available."
      : "An update is available. Fully close HonLib from Android's recent apps, then reopen it.";
  }
  els.appUpdateApply?.classList.toggle("hidden", !direct);
  resetAppUpdateApply();
}

window.addEventListener("hon-reader-shell-ready", configureAppUpdateAction);
window.addEventListener("hon-reader-update-failed", resetAppUpdateApply);
if (els.appUpdateApply) {
  els.appUpdateApply.onclick = () => {
    const apply = window.__readerShellApplyUpdate;
    if (typeof apply !== "function") return;
    els.appUpdateApply.disabled = true;
    els.appUpdateApply.textContent = "Applying…";
    try { apply(); } catch { resetAppUpdateApply(); }
  };
}

async function checkForAppUpdate() {
  let running, offered;
  try {
    const stamp = await fetch("/build-id.json", { cache: "no-store" });
    if (!stamp.ok) return;
    running = (await stamp.json()).buildId;
    const manifest = await fetch("/api/app-bundle/manifest", { cache: "no-store" });
    if (!manifest.ok) return;
    offered = (await manifest.json()).buildId;
  } catch { return; }
  if (!running || !offered || running === offered) return;
  // Dismissal is per-build, so declining one update never suppresses the next.
  if (localStorage.getItem(UPDATE_DISMISSED_KEY) === offered) return;
  configureAppUpdateAction();
  els.appUpdate?.classList.remove("hidden");
  if (els.appUpdateDismiss) {
    els.appUpdateDismiss.onclick = () => {
      try { localStorage.setItem(UPDATE_DISMISSED_KEY, offered); } catch {}
      els.appUpdate.classList.add("hidden");
    };
  }
}

setTheme(localStorage.getItem("ebook-library.theme") || "system");
populateFontSelect();
updateLibControls();
applyReaderTheme();
loadIrcStatus().then(loadStaging);
loadLibrary();
initJournals({ books: () => allBooks, visit: visitPassage, isHome: libIsHome, layout: () => libView.view });
store.subscribe(onJournalChange);
checkForAppUpdate();

// Register the service worker so the app is installable as a PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
