// Passages and journals: the one place they are read, changed and synced.
//
// A highlight is saved the moment it is made. Saving means two things here and
// neither waits on the network: the document is applied to the in-memory copy
// the UI draws from, and it is put in an outbox that is sent in the background
// and survives a reload. So a capture can't be blocked, or lost, by a slow or
// absent server. Filing into a journal is just another change to the passage.
//
// Documents are whole objects owned by the device that last wrote them:
// permanent ids generated here, an `updated` time and the writing `device` on
// every one, and deletes recorded as a marker. Two copies of a document are
// reconciled by taking the newer `updated`; nothing else can conflict.
//
// Everything that talks to the server is in `transport`. Swapping how changes
// travel (another backend, a native bridge) means replacing those two calls.

export const FORMAT_VERSION = 1;

// Light tints, so the text over them stays legible when a screen renders them
// in grey. The same tints serve the reader's white-on-black theme, where the
// marked passage is shown inverted (dark text on the tint).
export const HIGHLIGHTS = [
  { id: "yellow", label: "Yellow", color: "#ffe566" },
  { id: "green", label: "Green", color: "#aee9a0" },
  { id: "blue", label: "Blue", color: "#a8d8ff" },
  { id: "pink", label: "Pink", color: "#ffb8dc" },
  { id: "orange", label: "Orange", color: "#ffc98a" },
];
export const UNDERLINES = [
  { id: "solid", label: "Solid" },
  { id: "dashed", label: "Dashed" },
  { id: "dotted", label: "Dotted" },
  { id: "wavy", label: "Wavy" },
  { id: "double", label: "Double" },
];
export const DEFAULT_HIGHLIGHT = "yellow";
export const DEFAULT_UNDERLINE = "solid";
const HIGHLIGHT_BY_ID = Object.fromEntries(HIGHLIGHTS.map((h) => [h.id, h]));
const UNDERLINE_BY_ID = Object.fromEntries(UNDERLINES.map((u) => [u.id, u]));
export function highlightById(id) { return HIGHLIGHT_BY_ID[id] || null; }
export function underlineById(id) { return UNDERLINE_BY_ID[id] || null; }
// "Yellow highlight, Dashed underline": the words shown wherever a passage is
// listed, so its colour is never carried by colour alone.
export function styleLabel(style) {
  const parts = [];
  const h = highlightById(style?.highlight), u = underlineById(style?.underline);
  if (h) parts.push(`${h.label} highlight`);
  if (u) parts.push(`${u.label} underline`);
  return parts.join(", ");
}

const OUTBOX_KEY = "ebook-library.journalOutbox";
const DEVICE_KEY = "ebook-library.device";
const KINDS = ["journals", "passages"];
const POLL_MS = 4000;

const docs = { journals: new Map(), passages: new Map() };
// kind/id -> the latest unsent version of that document.
const outbox = new Map();
const listeners = new Set();
let cursor = null;
let loaded = false;
let syncing = null;
let pollTimer = null;
let pollers = 0;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Older WebViews: same shape, from the same source of randomness.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let deviceId = null;
export function device() {
  if (deviceId) return deviceId;
  try { deviceId = localStorage.getItem(DEVICE_KEY); } catch {}
  if (!deviceId) {
    deviceId = uuid();
    try { localStorage.setItem(DEVICE_KEY, deviceId); } catch {}
  }
  return deviceId;
}

// ---- transport -----------------------------------------------------------
const transport = {
  async pull(since) {
    const res = await fetch(`/api/journal/sync${since ? `?since=${encodeURIComponent(since)}` : ""}`, { cache: "no-store" });
    if (res.status === 401) { window.location.href = "/login"; return new Promise(() => {}); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  // Resolves to { doc } when the server took a position on the write: `doc` is
  // the version it now holds. Resolves to { rejected: true } when it will never
  // accept it. Throws when it could not be reached, so the write is kept.
  async push(kind, doc) {
    const res = await fetch(`/api/journal/${kind}/${encodeURIComponent(doc.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (res.status === 401) { window.location.href = "/login"; return new Promise(() => {}); }
    if (res.status === 400 || res.status === 413) return { rejected: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    return { doc: data && data.doc };
  },
};

// ---- merge ---------------------------------------------------------------
function stamp(doc) { return Date.parse(doc?.updated) || 0; }
// Newer `updated` wins; the device id settles an exact tie the same way on
// every replica.
function isNewer(candidate, current) {
  if (!current) return true;
  const a = stamp(candidate), b = stamp(current);
  if (a !== b) return a > b;
  return String(candidate.device || "") > String(current.device || "");
}
function adopt(kind, doc) {
  if (!doc || typeof doc.id !== "string") return false;
  if (!isNewer(doc, docs[kind].get(doc.id))) return false;
  docs[kind].set(doc.id, doc);
  return true;
}
let batching = 0, notifyPending = false;
function notify() {
  if (batching) { notifyPending = true; return; }
  for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } }
}
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// Make several changes and tell listeners once, so renaming a tag across a
// journal redraws the page one time rather than once per passage.
export function batch(fn) {
  batching += 1;
  try { return fn(); }
  finally {
    batching -= 1;
    if (!batching && notifyPending) { notifyPending = false; notify(); }
  }
}

function loadOutbox() {
  try {
    for (const [key, doc] of JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]")) {
      const kind = key.split("/")[0];
      if (!KINDS.includes(kind) || !doc || typeof doc.id !== "string") continue;
      outbox.set(key, doc);
      adopt(kind, doc);
    }
  } catch {}
}
function saveOutbox() {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify([...outbox])); } catch {}
}

async function flushOutbox() {
  let changed = false;
  for (const [key, doc] of [...outbox]) {
    const kind = key.split("/")[0];
    let result;
    try { result = await transport.push(kind, doc); }
    catch { break; } // unreachable: keep everything, try again on the next sync
    // Only clear the entry if it wasn't replaced by a newer edit while this
    // one was in flight.
    if (outbox.get(key) === doc) { outbox.delete(key); saveOutbox(); }
    if (result.doc && adopt(kind, result.doc)) changed = true;
  }
  return changed;
}

// Send what is waiting, then take what changed elsewhere. Safe to call often
// and from anywhere; overlapping calls share one round trip.
export function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    let changed = false;
    try {
      changed = await flushOutbox();
      const data = await transport.pull(cursor);
      for (const kind of KINDS) for (const doc of data[kind] || []) if (adopt(kind, doc)) changed = true;
      if (data.cursor) cursor = data.cursor;
      if (!loaded) { loaded = true; changed = true; }
    } catch {}
    finally { syncing = null; }
    if (changed) notify();
    return changed;
  })();
  return syncing;
}

let initialized = false;
export function initStore() {
  if (initialized) return sync();
  initialized = true;
  loadOutbox();
  device();
  // Anything still waiting from an offline spell goes as soon as there is a
  // network again, without waiting for the next edit.
  window.addEventListener("online", () => sync());
  return sync();
}
export function isLoaded() { return loaded; }
export function pendingCount() { return outbox.size; }

// A view that shows journals keeps them fresh while it is open, so a passage
// captured on another device appears within moments. Counted, so two open
// views share one timer and closing one doesn't stop the other.
export function startPolling() {
  pollers += 1;
  if (pollTimer) return;
  const tick = () => { if (!document.hidden) sync(); };
  pollTimer = setInterval(tick, POLL_MS);
  sync();
}
export function stopPolling() {
  pollers = Math.max(0, pollers - 1);
  if (pollers || !pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---- writes --------------------------------------------------------------
function nowAfter(previous) {
  // Two edits in the same millisecond must still be ordered, and a device
  // whose clock is behind must still be able to change what it just read.
  const now = Date.now(), last = Date.parse(previous) || 0;
  return new Date(Math.max(now, last + 1)).toISOString();
}
function write(kind, doc) {
  const current = docs[kind].get(doc.id);
  const next = { ...doc, v: doc.v || FORMAT_VERSION, updated: nowAfter(current?.updated), device: device() };
  if (!next.created) next.created = next.updated;
  docs[kind].set(next.id, next);
  outbox.set(`${kind}/${next.id}`, next);
  saveOutbox();
  notify();
  // Not awaited: the caller's change is already real. sync() is single-flight,
  // so if one is running this write goes out with the next.
  sync().then(() => { if (outbox.size) sync(); });
  return next;
}

export function savePassage(doc) { return write("passages", doc); }
export function saveJournal(doc) { return write("journals", doc); }
export function newId() { return uuid(); }

function live(kind) { return [...docs[kind].values()].filter((d) => !d.deleted); }
export function journals() {
  return live("journals").sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base", numeric: true }));
}
export function journal(id) { const d = docs.journals.get(id); return d && !d.deleted ? d : null; }
export function passages() { return live("passages"); }
export function passage(id) { const d = docs.passages.get(id); return d && !d.deleted ? d : null; }

export function createJournal(name, sources = []) {
  return saveJournal({ id: uuid(), deleted: false, name: String(name || "").trim() || "Journal", cover: null, sources });
}
// A delete keeps only what is needed to say "this is gone, as of then".
function tombstone(doc) {
  return { v: doc.v, id: doc.id, created: doc.created, deleted: true };
}
export function deleteJournal(id) {
  const doc = docs.journals.get(id);
  return doc ? saveJournal(tombstone(doc)) : null;
}
export function deletePassage(id) {
  const doc = docs.passages.get(id);
  return doc ? savePassage(tombstone(doc)) : null;
}
export function updatePassage(id, changes) {
  const doc = passage(id);
  return doc ? savePassage({ ...doc, ...changes }) : null;
}
export function updateJournal(id, changes) {
  const doc = journal(id);
  return doc ? saveJournal({ ...doc, ...changes }) : null;
}

// ---- membership ----------------------------------------------------------
// `journals` on a passage is explicit membership: it is what lets a passage
// stay in a journal after its source is turned off. Ids of journals that have
// since been deleted are ignored rather than cleaned up, so deleting a journal
// is one write, not one per passage.
export function journalIdsOf(p) { return (p.journals || []).filter((id) => journal(id)); }
export function isUnfiled(p) { return journalIdsOf(p).length === 0; }
export function passagesInJournal(id) { return passages().filter((p) => (p.journals || []).includes(id)); }
export function unfiledPassages() { return passages().filter(isUnfiled); }
export function passagesForBook(bookKey) { return passages().filter((p) => p.source?.book_key === bookKey); }
export function addToJournal(passageId, journalId) {
  const p = passage(passageId);
  if (!p || (p.journals || []).includes(journalId)) return p;
  return savePassage({ ...p, journals: [...journalIdsOf(p), journalId] });
}
export function removeFromJournal(passageId, journalId) {
  const p = passage(passageId);
  if (!p) return null;
  return savePassage({ ...p, journals: journalIdsOf(p).filter((id) => id !== journalId) });
}

// ---- sources -------------------------------------------------------------
// Which books a journal collects from. journal.py repeats these rules for the
// Markdown export; keep the two in step.

// Identity of a series or author name: case and a leading "The" (or trailing
// ", The") are ignored, the way the library files and sorts them.
export function nameKey(name) {
  return String(name || "").trim().replace(/\s+/g, " ").replace(/^the\s+/i, "").replace(/,\s*the$/i, "").toLowerCase();
}
// Older shells can serve a library listing with no `key`; fall back to the
// same title+author form the server uses for a book with no identifier.
export function bookKey(book) {
  if (!book) return "";
  if (book.key) return book.key;
  const part = (v) => String(v || "").trim().replace(/\s+/g, " ").toLowerCase();
  return `ta:${part(book.title)}|${part(book.author)}`;
}
// The series a book belongs to: its metadata, or failing that the folder it is
// shelved in when that folder isn't simply its author's.
export function bookSeries(book) {
  const series = String(book?.series || "").trim();
  if (series) return series;
  const group = String(book?.group || "").trim();
  if (group && group !== "Library" && nameKey(group) !== nameKey(book.author)) return group;
  return "";
}
export function sourceMatches(source, book) {
  if (!source || !book) return false;
  if (source.type === "book") return !!source.book_key && source.book_key === bookKey(book);
  const wanted = nameKey(source.name);
  if (!wanted) return false;
  if (source.type === "series") return nameKey(bookSeries(book)) === wanted;
  if (source.type === "author") return nameKey(book.author) === wanted;
  return false;
}
export function sourceKey(source) {
  return source.type === "book" ? `book:${source.book_key}` : `${source.type}:${nameKey(source.name)}`;
}
export function journalCovers(j, book) {
  return (j.sources || []).some((s) => s.enabled !== false && sourceMatches(s, book));
}
export function journalsCovering(book) { return journals().filter((j) => journalCovers(j, book)); }
// Where a new passage from this book is filed: every journal that covers the
// book, with no prompt. The very first highlight of all creates "My First
// Journal" for its book. Otherwise nowhere yet: it is saved Unfiled, and the
// reader is offered a journal for the book afterwards. Never guesses while the
// journals haven't loaded, which would create a second "first" journal.
export function filingFor(book) {
  const covering = journalsCovering(book);
  if (covering.length) return { journals: covering.map((j) => j.id), first: null };
  if (loaded && !journals().length && !passages().length) {
    const first = createJournal("My First Journal", [sourceFor(book, "book")]);
    return { journals: [first.id], first };
  }
  return { journals: [], first: null };
}
// A source for a book at the given scope ("book" | "series" | "author"), or
// null when the book has nothing to offer at that scope.
export function sourceFor(book, scope) {
  if (scope === "series") { const name = bookSeries(book); return name ? { type: "series", name, enabled: true } : null; }
  if (scope === "author") { const name = String(book.author || "").trim(); return name ? { type: "author", name, enabled: true } : null; }
  return { type: "book", book_key: bookKey(book), enabled: true };
}
// Does a passage come from this source? Judged from the snapshot the passage
// carries, so it still answers for a book that has left the library.
export function sourceMatchesPassage(source, p) {
  const s = p.source || {};
  if (source.type === "book") return !!source.book_key && source.book_key === s.book_key;
  const wanted = nameKey(source.name);
  if (!wanted) return false;
  if (source.type === "series") return nameKey(s.series) === wanted;
  if (source.type === "author") return nameKey(s.author) === wanted;
  return false;
}
// Passages a source would bring into a journal that aren't in it yet.
export function passagesOutsideJournal(source, journalId) {
  return passages().filter((p) => sourceMatchesPassage(source, p) && !(p.journals || []).includes(journalId));
}
// Turn a source on in a journal (adding it if new). Returns the saved journal.
export function enableSource(journalId, source) {
  const j = journal(journalId);
  if (!j) return null;
  const key = sourceKey(source);
  const sources = (j.sources || []).filter((s) => sourceKey(s) !== key);
  sources.push({ ...source, enabled: true });
  return saveJournal({ ...j, sources });
}
export function setSourceEnabled(journalId, key, enabled) {
  const j = journal(journalId);
  if (!j) return null;
  return saveJournal({ ...j, sources: (j.sources || []).map((s) => (sourceKey(s) === key ? { ...s, enabled } : s)) });
}
export function removeSource(journalId, key) {
  const j = journal(journalId);
  if (!j) return null;
  return saveJournal({ ...j, sources: (j.sources || []).filter((s) => sourceKey(s) !== key) });
}

// Why a passage no longer follows its book, as seen from one journal:
// "source-off" when the book is in the library but not enabled in the journal,
// "book-missing" when the book has left the library. "linked" otherwise.
export const LINK_STATES = {
  "source-off": { label: "Source off", hint: "This book is in the library but is not a source of this journal." },
  "book-missing": { label: "Book missing", hint: "This book is no longer in the library, so the passage cannot open its page." },
};
export function findBook(p, books) {
  const key = p.source?.book_key;
  return key ? books.find((b) => bookKey(b) === key) || null : null;
}
export function linkState(p, j, books) {
  const book = findBook(p, books);
  if (!book) return "book-missing";
  if (j && !journalCovers(j, book)) return "source-off";
  return "linked";
}

// ---- tags ----------------------------------------------------------------
// Tags are plain strings on passages; the tag list is whatever is in use, so
// there is no shared tags file for two devices to fight over.
function tagKey(tag) { return String(tag || "").trim().toLowerCase(); }
export function cleanTag(tag) { return String(tag || "").trim().replace(/\s+/g, " ").replace(/^#+/, "").slice(0, 60); }
function countTags(list) {
  const seen = new Map();
  for (const p of list) for (const raw of p.tags || []) {
    const key = tagKey(raw);
    if (!key) continue;
    const entry = seen.get(key) || { tag: raw, count: 0 };
    entry.count += 1;
    seen.set(key, entry);
  }
  return [...seen.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
}
export function allTags() { return countTags(passages()); }
export function tagsInJournal(journalId) { return countTags(passagesInJournal(journalId)); }
export function tagsOf(list) { return countTags(list); }
// Suggestions for a tag field: tags used in the given journals first, then
// every other tag, both narrowed by what has been typed.
export function suggestTags(journalIds, typed = "", exclude = []) {
  const q = tagKey(typed);
  const skip = new Set(exclude.map(tagKey));
  const inJournals = countTags(passages().filter((p) => (p.journals || []).some((id) => journalIds.includes(id))));
  const first = new Set(inJournals.map((t) => tagKey(t.tag)));
  const rest = q ? allTags().filter((t) => !first.has(tagKey(t.tag))) : [];
  return [...inJournals, ...rest].map((t) => t.tag).filter((t) => !skip.has(tagKey(t)) && (!q || tagKey(t).includes(q)));
}
export function hasTag(p, tag) { const key = tagKey(tag); return (p.tags || []).some((t) => tagKey(t) === key); }
export function addTag(passageId, tag) {
  const p = passage(passageId), clean = cleanTag(tag);
  if (!p || !clean || hasTag(p, clean)) return p;
  return savePassage({ ...p, tags: [...(p.tags || []), clean] });
}
export function removeTag(passageId, tag) {
  const p = passage(passageId), key = tagKey(tag);
  if (!p) return null;
  return savePassage({ ...p, tags: (p.tags || []).filter((t) => tagKey(t) !== key) });
}
// Rename a tag on every passage in a journal. Renaming to a tag that is already
// in use is a merge: passages carrying both end up with the one.
export function renameTag(journalId, from, to) {
  const clean = cleanTag(to), key = tagKey(from);
  if (!clean || !key) return 0;
  return batch(() => {
    let n = 0;
    for (const p of passagesInJournal(journalId)) {
      if (!hasTag(p, from)) continue;
      const tags = [];
      for (const t of p.tags || []) {
        const next = tagKey(t) === key ? clean : t;
        if (!tags.some((x) => tagKey(x) === tagKey(next))) tags.push(next);
      }
      savePassage({ ...p, tags });
      n += 1;
    }
    return n;
  });
}
export function deleteTag(journalId, tag) {
  return batch(() => {
    let n = 0;
    for (const p of passagesInJournal(journalId)) {
      if (!hasTag(p, tag)) continue;
      removeTag(p.id, tag);
      n += 1;
    }
    return n;
  });
}

// ---- search --------------------------------------------------------------
// Run against the local copy, so a journal can be searched with no network.
export function matchesQuery(p, query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const s = p.source || {};
  const hay = [p.text, p.note, ...(p.tags || []), s.title, s.author, s.series, s.chapter].filter(Boolean).join("\n").toLowerCase();
  return terms.every((t) => hay.includes(t));
}
