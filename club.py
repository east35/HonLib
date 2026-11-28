"""Book club: two HonLib instances on one box reading the same books together.

Each instance runs in its own container with its own library. They meet in one
shared folder (EBOOK_LIB_CLUB_DIR), which lives on the server only and is never
synced to a reader:

    progress/<member>.json   one member's position in their club books, and
                             which other books they own (to flag duplicates)
    inbox/<member>/*.epub    a club book on its way into that member's library

Every file has a single writer (its member, or the member sending a book), and
every write is an atomic replace, so the two containers never need to lock
anything.

A club is a series made of club-tagged books, or one club book with no series.
A book is club-tagged when its OPF carries <meta name="honlib:club">, written
at import time; both members then hold a byte-identical copy.
"""

import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import library

_MEMBER = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
FINISHED = 0.995

CLUB_DIR = Path(os.environ["EBOOK_LIB_CLUB_DIR"]) if os.environ.get("EBOOK_LIB_CLUB_DIR") else None
MEMBER = (os.environ.get("EBOOK_LIB_MEMBER") or "").strip().lower()


def enabled():
    return CLUB_DIR is not None and bool(_MEMBER.match(MEMBER))


def display_name(member):
    return member.replace("-", " ").title()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _read_json(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def new_club_id():
    return uuid.uuid4().hex


def club_key(book):
    """Which club a club-tagged book belongs to: its series, else itself."""
    series = " ".join(str(book.get("series") or "").split()).casefold()
    return f"s:{series}" if series else f"b:{book['club_id']}"


def members():
    """Everyone who has joined: each instance writes its progress file at start."""
    if not enabled():
        return []
    found = {MEMBER}
    try:
        for path in (CLUB_DIR / "progress").glob("*.json"):
            if _MEMBER.match(path.stem):
                found.add(path.stem)
    except OSError:
        pass
    return sorted(found)


def partners():
    return [m for m in members() if m != MEMBER]


# ---- Sharing books ---------------------------------------------------------

def share_book(path):
    """Drop a copy of a club book into every partner's inbox. Returns who got it."""
    path = Path(path)
    club_id = library.read_club_id(path)
    if not enabled() or not club_id:
        return []
    sent = []
    for member in partners():
        dest = CLUB_DIR / "inbox" / member / f"{club_id}.epub"
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.tmp")
        shutil.copyfile(path, tmp)
        os.replace(tmp, dest)
        sent.append(member)
    return sent


def inbox_waiting():
    if not enabled():
        return []
    try:
        return sorted(p for p in (CLUB_DIR / "inbox" / MEMBER).glob("*.epub") if p.is_file())
    except OSError:
        return []


def collect_inbox(books, destination_for):
    """Move books waiting in this member's inbox into the library.

    `books` is the current library scan; a book whose club tag is already
    there is a repeat delivery and is dropped. `destination_for(path)` names the
    library file for it, exactly as a staging import would.
    """
    waiting = inbox_waiting()
    if not waiting:
        return 0
    have = {b.get("club_id") for b in books if b.get("club_id")}
    moved = 0
    for path in waiting:
        club_id = library.read_club_id(path)
        if not club_id or club_id in have or not library.is_valid_epub(path):
            path.unlink(missing_ok=True)
            continue
        dest = destination_for(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # The library is synced to the reader, so the file must appear there
        # whole: copy under a name the scan and the reader ignore, then rename.
        tmp = dest.with_name(f".{dest.name}.part")
        shutil.copyfile(path, tmp)
        os.replace(tmp, dest)
        path.unlink(missing_ok=True)
        have.add(club_id)
        moved += 1
    return moved


# ---- Progress --------------------------------------------------------------

def _entry_for(book, path, saved):
    chapters = library.book_chapters(path)["chapters"]
    percent = float(saved.get("percent") or 0)
    index = library.position_chapter(path, saved.get("cfi"), percent) if saved else None
    return {
        "title": book.get("title"),
        "series": book.get("series"),
        "series_index": book.get("series_index"),
        "percent": percent,
        "chapter": index,
        "chapter_label": chapters[index]["label"] if index is not None and index < len(chapters) else None,
        "chapter_count": len(chapters),
        "updated": saved.get("last_opened"),
    }


def publish_progress(books, saved_progress, resolve_path):
    """Rewrite this member's progress file from the library and progress.json."""
    if not enabled():
        return None
    entries = {}
    for book in books:
        if not book.get("club_id"):
            continue
        try:
            path = resolve_path(book)
        except (OSError, ValueError):
            continue
        entries[book["club_id"]] = _entry_for(book, path, saved_progress.get(book["id"]) or {})
    # Identity keys of the rest of the library, so a partner can tell before
    # sharing a book that this member already owns a copy of their own.
    own = sorted({b["key"] for b in books if not b.get("club_id") and b.get("key")})
    data = {"member": MEMBER, "updated": _now(), "books": entries, "library_keys": own}
    _write_json(CLUB_DIR / "progress" / f"{MEMBER}.json", data)
    return data


def partners_owning(key):
    """Partners whose library already holds their own copy of this book."""
    owners = []
    for member in partners():
        data = _read_json(CLUB_DIR / "progress" / f"{member}.json") or {}
        if key in (data.get("library_keys") or []):
            owners.append(member)
    return owners


def _member_progress(member):
    data = _read_json(CLUB_DIR / "progress" / f"{member}.json") or {}
    books = data.get("books")
    return books if isinstance(books, dict) else {}


# ---- What the app shows ----------------------------------------------------

def _order(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("inf")


def state():
    """Every club and where each member is in it.

    `position` counts chapters from the start of the series (the chapters of
    every earlier book, plus the chapter reached in this one), so two members
    can be compared across books. Both hold identical files, so front matter
    counts the same for both. None means not started.
    """
    if not enabled():
        return {"enabled": False}
    everyone = members()
    progress_by = {m: _member_progress(m) for m in everyone}
    # Book details come from whoever has a copy; the files are identical.
    books = {}
    for member in everyone:
        for club_id, entry in progress_by[member].items():
            books.setdefault(club_id, entry)
    clubs = {}
    for club_id, entry in books.items():
        key = club_key({"series": entry.get("series"), "club_id": club_id})
        club = clubs.setdefault(key, {"key": key, "name": entry.get("series") or entry.get("title") or "Book club", "books": []})
        club["books"].append({"club_id": club_id, "title": entry.get("title"), "series_index": entry.get("series_index"),
                              "chapter_count": entry.get("chapter_count") or 0})
    for club in clubs.values():
        club["books"].sort(key=lambda b: (_order(b["series_index"]), str(b["title"] or "")))
        order = {b["club_id"]: i for i, b in enumerate(club["books"])}
        before, running = {}, 0
        for b in club["books"]:
            before[b["club_id"]] = running
            running += b["chapter_count"]
        club["members"] = {}
        for member in everyone:
            positions = {b: e for b, e in progress_by[member].items() if b in order}
            started = [b for b, e in positions.items() if (e.get("percent") or 0) > 0]
            current = max(started, key=lambda b: order[b]) if started else None
            position = None
            if current:
                entry = positions[current]
                if (entry.get("percent") or 0) >= FINISHED:
                    position = before[current] + (entry.get("chapter_count") or 0)
                else:
                    position = before[current] + (entry.get("chapter") or 0)
            club["members"][member] = {
                "name": display_name(member),
                "books": positions,
                "current": current,
                "position": position,
            }
    return {
        "enabled": True,
        "me": MEMBER,
        "members": [{"id": m, "name": display_name(m)} for m in everyone],
        "clubs": sorted(clubs.values(), key=lambda c: c["name"].casefold()),
    }
