"""Annotation storage: one JSON file per passage and per journal.

The files are the data. Everything else here is derived from them and can be
thrown away: the SQLite index next to the config exists only so a change feed,
a listing and a search don't have to re-read every file on each request.

Clients own the shape of a document. Ids are generated on the device, every
write carries the `updated` time and the `device` that made it, and a delete is
a marker (`deleted: true`) rather than a missing file. That is what makes two
devices safe to write independently: a conflict is always one document against
another version of itself, and the newer `updated` wins.

The folder can also be synced by something else (Syncthing). Files that appear
or change there are picked up by `refresh`, exactly as if they had arrived
through the API.
"""

import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

FORMAT_VERSION = 1
KINDS = ("journals", "passages")

_config_dir = os.environ.get("EBOOK_LIB_CONFIG_DIR")
CONFIG_DIR = Path(_config_dir) if _config_dir else Path.home() / ".ebook-library-config"


def _default_journal_dir():
    # ./data/journal, beside the other data folders. Inside a container that
    # path is part of the image and is thrown away on every rebuild, so a
    # deployment whose compose file predates the journal volume keeps its
    # annotations in the config volume instead, which is always mounted.
    if os.environ.get("EBOOK_LIB_CONTAINER") == "1":
        return CONFIG_DIR / "journal"
    return Path(__file__).resolve().parent / "data" / "journal"


JOURNAL_DIR = Path(os.environ.get("EBOOK_LIB_JOURNAL_DIR") or _default_journal_dir())
INDEX_PATH = CONFIG_DIR / "journal-index.sqlite"

# An id becomes a file name, so it is restricted to what a UUID (or any other
# device-generated token) needs and nothing a path could be built from.
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{7,63}$")
MAX_DOC_BYTES = 256 * 1024
# How often a request may trigger a walk of the journal folder to look for
# files written by something other than this process.
REFRESH_INTERVAL = 5.0
INDEX_SCHEMA = 1

# Syncthing writes the losing side of a conflict next to the original as
# "<name>.sync-conflict-<date>-<time>-<device>.json".
_CONFLICT_RE = re.compile(r"^(?P<id>[A-Za-z0-9-]+)\.sync-conflict-[^/]*\.json$")

_STRING_FIELDS = {
    "passages": ("text", "note"),
    "journals": ("name",),
}
_LIST_FIELDS = {
    "passages": ("tags", "journals"),
    "journals": ("sources",),
}
_DICT_FIELDS = {
    "passages": ("context", "style", "source"),
    "journals": (),
}


class InvalidDocument(ValueError):
    pass


def _parse_time(value):
    if not isinstance(value, str) or not value:
        raise InvalidDocument("updated must be an ISO 8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise InvalidDocument("updated must be an ISO 8601 timestamp") from e
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _stamp(doc):
    """Ordering key for last-writer-wins. The device id only breaks an exact
    tie, so that every replica settles on the same winner."""
    return (_parse_time(doc.get("updated")), str(doc.get("device") or ""))


def normalize(kind, doc, doc_id=None):
    """Check a document is safe to store and return it. Unknown fields are kept:
    a newer client may write things this server has never heard of."""
    if kind not in KINDS:
        raise InvalidDocument("unknown document kind")
    if not isinstance(doc, dict):
        raise InvalidDocument("document must be an object")
    if not isinstance(doc.get("id"), str) or not ID_RE.match(doc["id"]):
        raise InvalidDocument("invalid id")
    if doc_id is not None and doc["id"] != doc_id:
        raise InvalidDocument("id does not match")
    _parse_time(doc.get("updated"))
    if "deleted" in doc and not isinstance(doc["deleted"], bool):
        raise InvalidDocument("deleted must be a boolean")
    if "v" in doc and (isinstance(doc["v"], bool) or not isinstance(doc["v"], int)):
        raise InvalidDocument("v must be an integer")
    for field in _STRING_FIELDS[kind]:
        if field in doc and not isinstance(doc[field], str):
            raise InvalidDocument(f"{field} must be a string")
    for field in _LIST_FIELDS[kind]:
        if field in doc and not isinstance(doc[field], list):
            raise InvalidDocument(f"{field} must be a list")
    for field in _DICT_FIELDS[kind]:
        if field in doc and doc[field] is not None and not isinstance(doc[field], dict):
            raise InvalidDocument(f"{field} must be an object")
    if kind == "passages":
        for field in ("tags", "journals"):
            if any(not isinstance(item, str) for item in doc.get(field) or []):
                raise InvalidDocument(f"{field} must contain strings")
    else:
        if any(not isinstance(item, dict) for item in doc.get("sources") or []):
            raise InvalidDocument("sources must contain objects")
    if len(_encode(doc).encode("utf-8")) > MAX_DOC_BYTES:
        raise InvalidDocument("document too large")
    return doc


def _encode(doc):
    return json.dumps(doc, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def _search_text(kind, doc):
    if doc.get("deleted"):
        return ""
    if kind == "journals":
        return str(doc.get("name") or "").casefold()
    source = doc.get("source") or {}
    parts = [doc.get("text"), doc.get("note"), *(doc.get("tags") or [])]
    parts += [source.get(key) for key in ("title", "author", "series", "chapter")]
    return "\n".join(str(part) for part in parts if part).casefold()


class JournalStore:
    """The single way in and out of the journal folder."""

    def __init__(self, root, index_path):
        self.root = Path(root)
        self.index_path = Path(index_path)
        self._lock = threading.RLock()
        self._refreshed_at = 0.0
        # Conflict copies already folded in, so a walk doesn't re-read them.
        self._conflicts_seen = {}

    # ---- index ---------------------------------------------------------

    def _connect(self):
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in (0, 1):
            db = None
            try:
                db = sqlite3.connect(self.index_path, timeout=10)
                db.row_factory = sqlite3.Row
                self._ensure_schema(db)
                return db
            except sqlite3.DatabaseError:
                # The index is disposable: an unreadable or outdated one is
                # replaced and rebuilt from the files on the next refresh.
                if db is not None:
                    db.close()
                if attempt:
                    raise
                self.index_path.unlink(missing_ok=True)
                self._refreshed_at = 0.0

    def _ensure_schema(self, db):
        db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        row = db.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
        if row is not None and row["value"] != str(INDEX_SCHEMA):
            raise sqlite3.DatabaseError("journal index schema changed")
        if row is None:
            db.execute(
                """CREATE TABLE IF NOT EXISTS docs (
                       kind TEXT NOT NULL,
                       id TEXT NOT NULL,
                       seq INTEGER NOT NULL,
                       deleted INTEGER NOT NULL,
                       mtime_ns INTEGER NOT NULL,
                       size INTEGER NOT NULL,
                       body TEXT NOT NULL,
                       search TEXT NOT NULL,
                       PRIMARY KEY (kind, id)
                   )"""
            )
            db.execute("CREATE INDEX IF NOT EXISTS docs_seq ON docs (seq)")
            # A fresh index numbers its changes from zero again, so cursors
            # handed out by an earlier one mean nothing. The epoch lets a client
            # holding such a cursor be told to start over.
            db.executemany(
                "INSERT INTO meta (key, value) VALUES (?, ?)",
                [("schema", str(INDEX_SCHEMA)), ("epoch", secrets.token_hex(8)), ("seq", "0")],
            )
            db.commit()

            # Nothing is in it yet, whatever the last walk found.
            self._refreshed_at = 0.0

    def _open(self):
        """A connection to an index that reflects the folder."""
        self.refresh()
        db = self._connect()
        if not self._refreshed_at:
            # The index was removed or replaced since the last walk.
            db.close()
            self.refresh(force=True)
            db = self._connect()
        return db

    def _meta(self, db, key):
        return db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()["value"]

    def _next_seq(self, db):
        seq = int(self._meta(db, "seq")) + 1
        db.execute("UPDATE meta SET value = ? WHERE key = 'seq'", (str(seq),))
        return seq

    def _index_doc(self, db, kind, doc, stat):
        db.execute(
            "INSERT OR REPLACE INTO docs (kind, id, seq, deleted, mtime_ns, size, body, search)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                kind, doc["id"], self._next_seq(db), 1 if doc.get("deleted") else 0,
                stat.st_mtime_ns, stat.st_size,
                json.dumps(doc, ensure_ascii=False), _search_text(kind, doc),
            ),
        )

    # ---- files ---------------------------------------------------------

    def _path(self, kind, doc_id):
        return self.root / kind / f"{doc_id}.json"

    def _read_file(self, kind, path, doc_id):
        try:
            return normalize(kind, json.loads(path.read_text(encoding="utf-8")), doc_id)
        except (OSError, ValueError):
            return None

    def _write_file(self, kind, doc):
        path = self._path(kind, doc["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_text(_encode(doc), encoding="utf-8")
        os.replace(tmp, path)
        return path.stat()

    def _fold_conflict(self, db, kind, path, doc_id):
        """A Syncthing conflict copy is never a document of its own. It is the
        other side of a concurrent edit, so it competes with the original the
        way any other write does, and the newer `updated` wins."""
        try:
            stat = path.stat()
        except OSError:
            return
        seen = (stat.st_mtime_ns, stat.st_size)
        if self._conflicts_seen.get(str(path)) == seen:
            return
        self._conflicts_seen[str(path)] = seen
        doc = self._read_file(kind, path, doc_id)
        if doc is None:
            return
        current = self._read_file(kind, self._path(kind, doc_id), doc_id)
        if current is None or _stamp(doc) > _stamp(current):
            self._index_doc(db, kind, doc, self._write_file(kind, doc))

    def refresh(self, force=False):
        """Bring the index in line with the folder. Cheap when nothing changed:
        one directory walk comparing size and mtime."""
        with self._lock:
            now = time.monotonic()
            if not force and self._refreshed_at and now - self._refreshed_at < REFRESH_INTERVAL:
                return
            db = self._connect()
            try:
                for kind in KINDS:
                    known = {
                        row["id"]: (row["mtime_ns"], row["size"])
                        for row in db.execute("SELECT id, mtime_ns, size FROM docs WHERE kind = ?", (kind,))
                    }
                    present = set()
                    conflicts = []
                    try:
                        entries = list(os.scandir(self.root / kind))
                    except OSError:
                        entries = []
                    for entry in entries:
                        name = entry.name
                        if name.startswith(".") or not name.endswith(".json") or not entry.is_file():
                            continue
                        conflict = _CONFLICT_RE.match(name)
                        if conflict:
                            conflicts.append((Path(entry.path), conflict.group("id")))
                            continue
                        doc_id = name[:-len(".json")]
                        if not ID_RE.match(doc_id):
                            continue
                        try:
                            stat = entry.stat()
                        except OSError:
                            continue
                        present.add(doc_id)
                        if known.get(doc_id) == (stat.st_mtime_ns, stat.st_size):
                            continue
                        doc = self._read_file(kind, Path(entry.path), doc_id)
                        if doc is None:
                            # Half-written or malformed: leave it out rather
                            # than serve it, and look again on the next walk.
                            present.discard(doc_id)
                            continue
                        self._index_doc(db, kind, doc, stat)
                    for path, doc_id in conflicts:
                        if ID_RE.match(doc_id):
                            self._fold_conflict(db, kind, path, doc_id)
                            if self._path(kind, doc_id).is_file():
                                present.add(doc_id)
                    for doc_id in set(known) - present:
                        db.execute("DELETE FROM docs WHERE kind = ? AND id = ?", (kind, doc_id))
                db.commit()
            finally:
                db.close()
            self._refreshed_at = time.monotonic()

    # ---- access --------------------------------------------------------

    def put(self, kind, doc):
        """Store a document unless a newer version of it is already here.

        Returns (applied, stored). `stored` is what the folder holds afterwards,
        so a caller whose write lost can adopt the version that won.
        """
        doc = normalize(kind, doc)
        with self._lock:
            db = self._open()
            try:
                current = self._current(db, kind, doc["id"])
                if current is not None and _stamp(doc) <= _stamp(current):
                    db.commit()
                    return False, current
                self._index_doc(db, kind, doc, self._write_file(kind, doc))
                db.commit()
                return True, doc
            finally:
                db.close()

    def _get(self, db, kind, doc_id):
        row = db.execute("SELECT body FROM docs WHERE kind = ? AND id = ?", (kind, doc_id)).fetchone()
        return json.loads(row["body"]) if row else None

    def _current(self, db, kind, doc_id):
        """The version a write has to beat. Walks are spaced out, so the file is
        checked directly: a newer copy that landed in the folder a moment ago
        must not lose to an older write just because the index hasn't seen it."""
        path = self._path(kind, doc_id)
        try:
            stat = path.stat()
        except OSError:
            return None
        row = db.execute(
            "SELECT mtime_ns, size, body FROM docs WHERE kind = ? AND id = ?", (kind, doc_id)
        ).fetchone()
        if row and (row["mtime_ns"], row["size"]) == (stat.st_mtime_ns, stat.st_size):
            return json.loads(row["body"])
        doc = self._read_file(kind, path, doc_id)
        if doc is not None:
            self._index_doc(db, kind, doc, stat)
        return doc

    def get(self, kind, doc_id):
        with self._lock:
            db = self._open()
            try:
                return self._get(db, kind, doc_id)
            finally:
                db.close()

    def changes(self, since=None):
        """Everything that changed after `since`, a cursor from an earlier call.

        Deleted documents are included, as markers, so a client learns of the
        delete. Without a usable cursor the whole folder is returned and `full`
        says so.
        """
        with self._lock:
            db = self._open()
            try:
                epoch = self._meta(db, "epoch")
                after = 0
                full = True
                if isinstance(since, str) and since.startswith(f"{epoch}-"):
                    try:
                        after = max(0, int(since[len(epoch) + 1:]))
                        full = False
                    except ValueError:
                        after = 0
                out = {kind: [] for kind in KINDS}
                for row in db.execute("SELECT kind, body FROM docs WHERE seq > ? ORDER BY seq", (after,)):
                    out[row["kind"]].append(json.loads(row["body"]))
                return {"cursor": f"{epoch}-{self._meta(db, 'seq')}", "full": full, **out}
            finally:
                db.close()

    def all(self, kind):
        with self._lock:
            db = self._open()
            try:
                rows = db.execute("SELECT body FROM docs WHERE kind = ? AND deleted = 0 ORDER BY seq", (kind,))
                return [json.loads(row["body"]) for row in rows]
            finally:
                db.close()

    def search(self, query="", journal=None, tag=None, limit=500):
        """Passages containing every word of `query`, newest first."""
        terms = str(query or "").casefold().split()
        with self._lock:
            db = self._open()
            try:
                sql = "SELECT body FROM docs WHERE kind = 'passages' AND deleted = 0"
                args = []
                for term in terms:
                    sql += " AND instr(search, ?) > 0"
                    args.append(term)
                found = [json.loads(row["body"]) for row in db.execute(sql, args)]
            finally:
                db.close()
        if journal:
            found = [doc for doc in found if journal in (doc.get("journals") or [])]
        if tag:
            wanted = str(tag).casefold()
            found = [doc for doc in found if wanted in [t.casefold() for t in doc.get("tags") or []]]
        found.sort(key=lambda doc: str(doc.get("created") or doc.get("updated") or ""), reverse=True)
        return found[:max(1, int(limit))]


store = JournalStore(JOURNAL_DIR, INDEX_PATH)


# ---- sources -------------------------------------------------------------
# Which books a journal collects from. The reader decides this on the device at
# the moment of capture (static/journal-store.js); it is repeated here only so
# an export can say whether a passage's book is still one of its journal's
# sources. Keep the two in step.

def name_key(name):
    """Identity of a series or author name: case and a leading "The" (or a
    trailing ", The") are ignored, the way the library files and sorts them."""
    value = re.sub(r"\s+", " ", str(name or "").strip())
    value = re.sub(r"^the\s+", "", value, flags=re.IGNORECASE)
    value = re.sub(r",\s*the$", "", value, flags=re.IGNORECASE)
    return value.casefold()


def book_series(book):
    """The series a library book belongs to: its metadata, or failing that the
    folder it is shelved in when that folder isn't simply its author's."""
    series = str(book.get("series") or "").strip()
    if series:
        return series
    group = str(book.get("group") or "").strip()
    if group and group != "Library" and name_key(group) != name_key(book.get("author")):
        return group
    return ""


def source_matches(source, book):
    kind = source.get("type")
    if kind == "book":
        return bool(source.get("book_key")) and source.get("book_key") == book.get("key")
    wanted = name_key(source.get("name"))
    if not wanted:
        return False
    if kind == "series":
        return name_key(book_series(book)) == wanted
    if kind == "author":
        return name_key(book.get("author")) == wanted
    return False


def journal_covers(journal, book):
    return any(
        source.get("enabled", True) and source_matches(source, book)
        for source in journal.get("sources") or []
        if isinstance(source, dict)
    )


def link_state(passage, journal, books_by_key):
    """"linked", or why a passage no longer follows its book: "source-off" when
    the book is in the library but not enabled in this journal, "book-missing"
    when the book has left the library."""
    book = books_by_key.get((passage.get("source") or {}).get("book_key"))
    if book is None:
        return "book-missing"
    if not journal_covers(journal, book):
        return "source-off"
    return "linked"


# ---- export --------------------------------------------------------------

HIGHLIGHT_NAMES = {"yellow": "Yellow", "green": "Green", "blue": "Blue", "pink": "Pink", "orange": "Orange"}
UNDERLINE_NAMES = {"solid": "Solid", "dashed": "Dashed", "dotted": "Dotted", "wavy": "Wavy", "double": "Double"}
LINK_STATE_NAMES = {"source-off": "Source off", "book-missing": "Book missing"}


def style_label(style):
    style = style if isinstance(style, dict) else {}
    parts = []
    highlight = style.get("highlight")
    if highlight:
        parts.append(f"{HIGHLIGHT_NAMES.get(highlight, str(highlight).title())} highlight")
    underline = style.get("underline")
    if underline:
        parts.append(f"{UNDERLINE_NAMES.get(underline, str(underline).title())} underline")
    return ", ".join(parts)


def _quote(text):
    lines = str(text or "").strip().splitlines() or [""]
    return "\n".join(f"> {line}".rstrip() for line in lines)


def _position(passage):
    source = passage.get("source") or {}
    try:
        return float(source.get("percent") or 0)
    except (TypeError, ValueError):
        return 0.0


def _series_position(source):
    try:
        return float(source.get("series_index"))
    except (TypeError, ValueError):
        return float("inf")


def render_markdown(journal, passages, books):
    """One Markdown document for a journal: a heading per book, and under it
    each passage as a quote with its note, tags, chapter, colour and, when it
    has one, its unlinked status."""
    books_by_key = {book.get("key"): book for book in books if book.get("key")}
    members = [
        p for p in passages
        if not p.get("deleted") and journal["id"] in (p.get("journals") or [])
    ]
    by_book = {}
    for passage in members:
        source = passage.get("source") or {}
        key = source.get("book_key") or f"{source.get('title')}|{source.get('author')}"
        by_book.setdefault(key, []).append(passage)

    def book_order(item):
        source = item[1][0].get("source") or {}
        return (
            name_key(source.get("series")) or "￿",
            _series_position(source),
            name_key(source.get("title")),
        )

    out = [f"# {journal.get('name') or 'Journal'}", ""]
    count = len(members)
    out += [f"{count} passage{'' if count == 1 else 's'} from {len(by_book)} book{'' if len(by_book) == 1 else 's'}.", ""]
    for _, group in sorted(by_book.items(), key=book_order):
        source = group[0].get("source") or {}
        heading = source.get("title") or "Untitled"
        if source.get("author"):
            heading += f" — {source['author']}"
        out += [f"## {heading}", ""]
        if source.get("series"):
            out += [f"*{source['series']}*", ""]
        for passage in sorted(group, key=lambda p: (_position(p), str(p.get("created") or ""))):
            src = passage.get("source") or {}
            out += [_quote(passage.get("text")), ""]
            if str(passage.get("note") or "").strip():
                out += [f"**Note:** {passage['note'].strip()}", ""]
            details = []
            if src.get("chapter"):
                details.append(f"Chapter: {src['chapter']}")
            label = style_label(passage.get("style"))
            if label:
                details.append(label)
            tags = [tag for tag in passage.get("tags") or [] if tag]
            if tags:
                details.append("Tags: " + ", ".join(tags))
            state = link_state(passage, journal, books_by_key)
            if state != "linked":
                details.append(f"Status: {LINK_STATE_NAMES[state]}")
            if details:
                out += [" · ".join(details), ""]
    return "\n".join(out).rstrip() + "\n"
