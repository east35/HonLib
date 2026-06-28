import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

_config_dir = os.environ.get("EBOOK_LIB_CONFIG_DIR")
CONFIG_DIR = Path(_config_dir) if _config_dir else Path.home() / ".ebook-library-config"
PROGRESS_PATH = CONFIG_DIR / "progress.json"
_lock = threading.Lock()


def _now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_progress():
    if PROGRESS_PATH.exists():
        try:
            data = json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                books = data.get("books")
                if isinstance(books, dict):
                    return {"books": books}
        except Exception:
            pass
    return {"books": {}}


def save_progress(data):
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PROGRESS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, PROGRESS_PATH)


def get_book_progress(book_id):
    data = load_progress()
    return data["books"].get(book_id) or {}


def update_book_progress(book_id, *, cfi=None, percent=None, base=None):
    with _lock:
        data = load_progress()
        current = data["books"].get(book_id)
        # Staleness guard: `base` is the `last_opened` token the caller loaded its
        # position from. If we already hold a newer one, another device advanced
        # after this session synced — reject the write so a stale tab can't clobber
        # newer progress. Equal timestamps (same-second concurrent) are allowed.
        if base and current and current.get("last_opened") and base < current["last_opened"]:
            return {"stale": True, "entry": current}
        entry = data["books"].setdefault(book_id, {})
        if cfi is not None:
            entry["cfi"] = str(cfi)
        if percent is not None:
            try:
                entry["percent"] = max(0.0, min(1.0, float(percent)))
            except (TypeError, ValueError):
                entry["percent"] = 0.0
        entry["last_opened"] = _now_iso()
        save_progress(data)
        return {"stale": False, "entry": entry}


def reset_book_progress(book_id):
    with _lock:
        data = load_progress()
        existed = book_id in data["books"]
        if existed:
            del data["books"][book_id]
            save_progress(data)
        return existed
