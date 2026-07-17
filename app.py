import hmac
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import threading
import time
import uuid
from datetime import timedelta
from pathlib import Path

import requests
from flask import Flask, abort, jsonify, redirect, render_template_string, request, send_file, send_from_directory, session

import library
import progress
import web_bundle
from acquisition.sites import find_site

IRC_CLIENT_METHODS = ("status", "search", "download", "start_background")


def _valid_irc_plugin(module):
    client = getattr(module, "client", None)
    return client is not None and all(
        callable(getattr(client, method, None))
        for method in IRC_CLIENT_METHODS
    )


try:
    from acquisition import irc as _irc  # optional submodule at acquisition/irc/
except ImportError:
    _irc = None

HAS_IRC = _valid_irc_plugin(_irc)
irc = _irc if HAS_IRC else None

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/epub+zip", ".epub")

CONFIG_DIR = Path(os.environ.get("EBOOK_LIB_CONFIG_DIR") or Path.home() / ".ebook-library-config")
LIBRARY_FOLDER = os.environ.get("EBOOK_LIB_FOLDER") or str(Path.home() / "Books" / "ebooks-dl")
STAGING_FOLDER = os.environ.get("EBOOK_LIB_STAGING") or str(Path.home() / "Books" / "staging")
CONTAINER_MODE = os.environ.get("EBOOK_LIB_CONTAINER") == "1"
IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
GOOGLE_BOOKS_API_KEY = os.environ.get("GOOGLE_BOOKS_API_KEY") or os.environ.get("EBOOK_LIB_GOOGLE_BOOKS_API_KEY") or ""
GOOGLE_CSE_API_KEY = os.environ.get("GOOGLE_CSE_API_KEY") or os.environ.get("EBOOK_LIB_GOOGLE_CSE_API_KEY") or ""
GOOGLE_CSE_CX = os.environ.get("GOOGLE_CSE_CX") or os.environ.get("EBOOK_LIB_GOOGLE_CSE_CX") or ""
HARDCOVER_API_KEY = os.environ.get("HARDCOVER_API_KEY") or os.environ.get("EBOOK_LIB_HARDCOVER_API_KEY") or ""
HARDCOVER_GRAPHQL_URL = os.environ.get("EBOOK_LIB_HARDCOVER_GRAPHQL_URL") or "https://api.hardcover.app/v1/graphql"

AUTH_PASSWORD = os.environ.get("EBOOK_LIB_PASSWORD") or ""
AUTH_USERNAME = os.environ.get("EBOOK_LIB_USERNAME") or ""
COOKIE_SECURE = os.environ.get("EBOOK_LIB_COOKIE_SECURE") == "1"
AUTH_ENABLED = bool(AUTH_PASSWORD)
PUBLIC_PATHS = {"/login", "/logout", "/style.css", "/manifest.webmanifest", "/sw.js", "/favicon.ico"}
PUBLIC_PREFIXES = ("/img/", "/vendor/")


def _load_secret_key():
    env = os.environ.get("EBOOK_LIB_SECRET_KEY")
    if env:
        return env
    path = CONFIG_DIR / "secret_key"
    try:
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
        key = secrets.token_hex(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(key, encoding="utf-8")
        return key
    except Exception:
        return secrets.token_hex(32)


app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
app.secret_key = _load_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=COOKIE_SECURE,
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)
web_bundle.register_routes(app)

CONTENT_SECURITY_POLICY = "; ".join((
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
))


@app.after_request
def _security_headers(response):
    # Foliate renders untrusted EPUB HTML in script-enabled blob iframes.
    # Restricting scripts to application-owned files prevents book-embedded
    # JavaScript from executing while retaining Foliate's WebKit event support.
    response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Permissions-Policy",
        "camera=(), geolocation=(), microphone=()",
    )
    return response


LOGIN_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HonLib — sign in</title><style>:root{--bg:#fff;--fg:#000}@media(prefers-color-scheme:dark){:root{--bg:#000;--fg:#fff}}*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}form{width:100%;max-width:320px;border:2px solid var(--fg);padding:24px;display:flex;flex-direction:column;gap:14px}h1{margin:0;font-size:22px}input{background:var(--bg);color:var(--fg);border:2px solid var(--fg);padding:12px 14px;font-size:16px}button{background:var(--fg);color:var(--bg);border:2px solid var(--fg);padding:12px 14px;font-size:15px;font-weight:700;cursor:pointer}.err{font-size:13px;font-weight:700}</style></head><body><div class="wrap"><form method="post" action="/login"><h1>HonLib</h1><p>Sign in to continue.</p>{% if show_user %}<input name="username" type="text" placeholder="Username" autocomplete="username" autofocus>{% endif %}<input name="password" type="password" placeholder="Password" autocomplete="current-password" {% if not show_user %}autofocus{% endif %}>{% if error %}<div class="err">{{ error }}</div>{% endif %}<button type="submit">Sign in</button></form></div></body></html>"""


def _credentials_ok(username, password):
    ok = hmac.compare_digest(password.encode(), AUTH_PASSWORD.encode())
    if AUTH_USERNAME:
        ok = hmac.compare_digest(username.encode(), AUTH_USERNAME.encode()) and ok
    return ok


@app.before_request
def _require_auth():
    if not AUTH_ENABLED or session.get("authed"):
        return None
    p = request.path
    if p in PUBLIC_PATHS or any(p.startswith(pre) for pre in PUBLIC_PREFIXES):
        return None
    if p.startswith("/api/"):
        return jsonify({"ok": False, "error": "auth required"}), 401
    return redirect("/login")


@app.route("/login", methods=["GET", "POST"])
def login():
    if not AUTH_ENABLED or session.get("authed"):
        return redirect("/")
    error = ""
    if request.method == "POST":
        if _credentials_ok(request.form.get("username", ""), request.form.get("password", "")):
            session.permanent = True
            session["authed"] = True
            return redirect("/")
        error = "Incorrect credentials."
    return render_template_string(LOGIN_HTML, error=error, show_user=bool(AUTH_USERNAME))


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")


jobs = {}
jobs_lock = threading.Lock()


def new_job(kind):
    jid = uuid.uuid4().hex[:8]
    with jobs_lock:
        jobs[jid] = {"id": jid, "kind": kind, "lines": [], "done": False, "ok": None, "error": None, "cancel": False, "result": None, "started": time.time()}
    return jid


def job_log(jid, line):
    with jobs_lock:
        if jid in jobs:
            jobs[jid]["lines"].append(str(line))


def job_should_stop(jid):
    with jobs_lock:
        return bool(jobs.get(jid, {}).get("cancel"))


def finish_job(jid, ok, error=None, result=None):
    with jobs_lock:
        if jid in jobs:
            jobs[jid]["ok"] = ok
            jobs[jid]["error"] = error
            jobs[jid]["result"] = result
            jobs[jid]["done"] = True
            if error:
                jobs[jid]["lines"].append(f"ERROR: {error}")


def current_library_folder():
    return LIBRARY_FOLDER


def current_staging_folder():
    return STAGING_FOLDER


def _book_path_by_id(book_id):
    book = library.find_book_by_id(current_library_folder(), book_id)
    return library.resolve_book_path(current_library_folder(), book["path"]), book


def _safe_staging_files():
    root = Path(current_staging_folder()).resolve()
    if not root.is_dir():
        return []
    files = []
    for path in sorted(root.glob("*.epub")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        meta = library.read_book_metadata(path)
        files.append({
            "id": hashlib.sha256(rel.encode("utf-8")).hexdigest()[:16],
            "filename": path.name,
            "title": meta["title"],
            "author": meta["author"],
            "series": meta["series"],
            "series_index": meta.get("series_index"),
        })
    return files


def _staging_path_by_id(staging_id):
    root = Path(current_staging_folder()).resolve()
    for item in _safe_staging_files():
        if item["id"] == staging_id:
            path = (root / item["filename"]).resolve()
            if root not in path.parents or path.suffix.lower() != ".epub" or not path.is_file():
                break
            return path
    raise FileNotFoundError(staging_id)


def _staging_path_by_filename(filename):
    root = Path(current_staging_folder()).resolve()
    name = Path(str(filename or "").replace("\\", "/")).name
    if not name:
        raise FileNotFoundError(filename)
    path = (root / name).resolve()
    if root not in path.parents or path.suffix.lower() != ".epub" or not path.is_file():
        raise FileNotFoundError(filename)
    return path


def _safe_name(value, fallback):
    value = re.sub(r'[\\/:*?"<>|]+', " ", str(value or "").strip())
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value or fallback


def _unique_destination(path):
    if not path.exists():
        return path
    for i in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise FileExistsError(path)


def _format_series_index(value):
    value = str(value or "").strip()
    if not value:
        return ""
    try:
        number = float(value)
        if number.is_integer():
            return f"{int(number):02d}"
    except ValueError:
        pass
    return value.zfill(2) if value.isdigit() else value


def _library_destination_for(path):
    meta = library.read_book_metadata(path)
    title = _safe_name(meta.get("title") or path.stem, "Untitled")
    author = _safe_name(meta.get("author"), "Unknown Author")
    series = _safe_name(meta.get("series"), "") if meta.get("series") else ""
    series_index = _format_series_index(meta.get("series_index"))
    root = Path(current_library_folder()).resolve()
    if series:
        prefix = f"{series_index} - " if series_index else ""
        dest = root / series / f"{prefix}{title}.epub"
    else:
        dest = root / author / f"{title}.epub"
    return _unique_destination(dest)


def _candidate_key(url):
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def _cover_candidates(title, author):
    title = (title or "").strip()
    author = (author or "").strip()
    query = " ".join(part for part in (title, author) if part).strip()
    if not query:
        return []
    buckets = {}
    order = []
    seen = set()

    def add(source, label, url):
        if not url:
            return
        url = url.replace("http://", "https://")
        if url in seen:
            return
        seen.add(url)
        if source not in buckets:
            buckets[source] = []
            order.append(source)
        buckets[source].append({"id": _candidate_key(url), "source": source, "label": label, "url": url})

    if GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX:
        try:
            resp = requests.get("https://www.googleapis.com/customsearch/v1", params={
                "key": GOOGLE_CSE_API_KEY,
                "cx": GOOGLE_CSE_CX,
                "q": f"{query} book cover",
                "searchType": "image",
                "imgType": "photo",
                "safe": "active",
                "num": 6,
            }, timeout=8)
            if resp.ok:
                for item in resp.json().get("items", []):
                    add("Google Images", item.get("title") or "Google Images", item.get("link"))
        except requests.RequestException:
            pass

    try:
        params = {"q": query, "maxResults": 8}
        if GOOGLE_BOOKS_API_KEY:
            params["key"] = GOOGLE_BOOKS_API_KEY
        resp = requests.get("https://www.googleapis.com/books/v1/volumes", params=params, timeout=8)
        if resp.ok:
            for item in resp.json().get("items", []):
                info = item.get("volumeInfo") or {}
                images = info.get("imageLinks") or {}
                url = images.get("extraLarge") or images.get("large") or images.get("medium") or images.get("thumbnail") or images.get("smallThumbnail")
                label = info.get("title") or "Google Books"
                add("Google Books", label, url)
    except requests.RequestException:
        pass

    if HARDCOVER_API_KEY:
        try:
            hardcover_auth = HARDCOVER_API_KEY if HARDCOVER_API_KEY.lower().startswith("bearer ") else f"Bearer {HARDCOVER_API_KEY}"
            gql = """
            query CoverSearch($query: String!) {
              search(query: $query, query_type: "Book") {
                results
              }
            }
            """
            resp = requests.post(
                HARDCOVER_GRAPHQL_URL,
                json={"query": gql, "variables": {"query": query}},
                headers={"Authorization": hardcover_auth, "Content-Type": "application/json"},
                timeout=8,
            )
            if resp.ok:
                results = ((resp.json().get("data") or {}).get("search") or {}).get("results") or []
                if isinstance(results, dict):
                    results = results.get("hits") or results.get("items") or results.get("results") or list(results.values())
                if not isinstance(results, list):
                    results = []
                for item in results[:8]:
                    document = item.get("document") if isinstance(item, dict) else None
                    book = document or item
                    if not isinstance(book, dict):
                        continue
                    label = book.get("title") or book.get("name") or "Hardcover"
                    image = book.get("image") or book.get("cached_image") or book.get("cover")
                    if isinstance(image, dict):
                        image = image.get("url") or image.get("image_url")
                    add("Hardcover", label, image)
        except requests.RequestException:
            pass

    # Interleave across sources round-robin so every provider is represented
    # (otherwise one prolific source like Google Books fills the whole cap).
    out = []
    idx = 0
    while len(out) < 6:
        progressed = False
        for source in order:
            bucket = buckets[source]
            if idx < len(bucket):
                out.append(bucket[idx])
                progressed = True
                if len(out) >= 6:
                    break
        if not progressed:
            break
        idx += 1
    return out


def _fetch_cover(url):
    if not (url or "").startswith("https://"):
        raise ValueError("Unsupported cover URL")
    resp = requests.get(url, timeout=20, headers={"User-Agent": "ebook-library/1.0"})
    resp.raise_for_status()
    mime = resp.headers.get("content-type", "").split(";")[0].lower()
    if mime not in IMAGE_MIME_TYPES and not resp.content.startswith((b"\xff\xd8", b"\x89PNG", b"RIFF")):
        raise ValueError("Cover URL did not return an image")
    return resp.content, mime if mime in IMAGE_MIME_TYPES else "image/jpeg"


def _download_cover(url):
    content, _ = _fetch_cover(url)
    return content


def _cover_response(url):
    content, mime = _fetch_cover(url)
    from io import BytesIO
    resp = send_file(BytesIO(content), mimetype=mime)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


def run_url_download(jid, url):
    try:
        site = find_site(url)
        if not site:
            raise ValueError("Unsupported URL. Standard Ebooks URLs are supported in v1.")
        Path(current_staging_folder()).mkdir(parents=True, exist_ok=True)
        dest = site.download(url, current_staging_folder(), log=lambda line: job_log(jid, line), stop=lambda: job_should_stop(jid))
        if not library.is_valid_epub(dest):
            try:
                Path(dest).unlink()
            except Exception:
                pass
            raise ValueError("Downloaded file is not a valid EPUB")
        finish_job(jid, True, result={"path": str(dest)})
    except Exception as e:
        finish_job(jid, False, str(e))


def run_irc_search(jid, query):
    try:
        result = irc.client.search(query, log=lambda line: job_log(jid, line), stop=lambda: job_should_stop(jid))
        finish_job(jid, True, result=result)
    except Exception as e:
        finish_job(jid, False, str(e))


def run_irc_download(jid, result):
    try:
        Path(current_staging_folder()).mkdir(parents=True, exist_ok=True)
        dest = irc.client.download(result, current_staging_folder(), log=lambda line: job_log(jid, line), stop=lambda: job_should_stop(jid))
        if not library.is_valid_epub(dest):
            raise ValueError("Downloaded file is not a valid EPUB")
        finish_job(jid, True, result={"path": str(dest)})
    except Exception as e:
        finish_job(jid, False, str(e))


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/config")
def config():
    return jsonify({"folder": current_library_folder(), "staging": current_staging_folder(), "exists": Path(current_library_folder()).is_dir(), "locked": CONTAINER_MODE})


DICT_CACHE_DIR = CONFIG_DIR / "dict-cache"
DICT_WORD_RE = re.compile(r"^[a-z][a-z'-]{0,63}$")


@app.route("/api/dictionary/<word>")
def dictionary(word):
    # Look up a single English word via the free dictionaryapi.dev, caching each
    # result (hits and misses) to disk so repeat lookups are instant and offline.
    word = (word or "").strip().lower()
    if not DICT_WORD_RE.match(word):
        return jsonify({"word": word, "notFound": True})
    cache_file = DICT_CACHE_DIR / f"{word}.json"
    try:
        if cache_file.is_file():
            return jsonify(json.loads(cache_file.read_text("utf-8")))
    except (OSError, ValueError):
        pass
    try:
        resp = requests.get(f"https://api.dictionaryapi.dev/api/v2/entries/en/{word}", timeout=6)
    except requests.RequestException:
        # Network failure: don't cache (it may be transient), just report a miss.
        return jsonify({"word": word, "notFound": True})
    if resp.status_code == 200:
        try:
            payload = _trim_dictionary(word, resp.json())
        except ValueError:
            payload = {"word": word, "notFound": True}
    else:
        payload = {"word": word, "notFound": True}
    try:
        DICT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(payload), "utf-8")
    except OSError:
        pass
    return jsonify(payload)


def _trim_dictionary(word, entries):
    # Reduce the upstream response to just what the popover renders: a phonetic
    # and part-of-speech-grouped definition strings (a handful per part of speech).
    phonetic = ""
    meanings = []
    for entry in entries if isinstance(entries, list) else []:
        if not phonetic:
            phonetic = entry.get("phonetic") or next((p.get("text") for p in entry.get("phonetics", []) if p.get("text")), "")
        for meaning in entry.get("meanings", []):
            defs = [d.get("definition") for d in meaning.get("definitions", []) if d.get("definition")][:4]
            if defs:
                meanings.append({"partOfSpeech": meaning.get("partOfSpeech") or "", "definitions": defs})
    if not meanings:
        return {"word": word, "notFound": True}
    return {"word": word, "phonetic": phonetic, "meanings": meanings[:4]}


@app.route("/api/progress", methods=["GET"])
def get_progress():
    return jsonify(progress.load_progress())


@app.route("/api/progress", methods=["POST"])
def post_progress():
    data = request.get_json(force=True) or {}
    book_id = (data.get("book_id") or "").strip()
    if not book_id:
        return jsonify({"ok": False, "error": "book_id required"}), 400
    result = progress.update_book_progress(
        book_id, cfi=data.get("cfi"), percent=data.get("percent"), base=data.get("base")
    )
    if result.get("stale"):
        return jsonify({"ok": False, "stale": True, "book_id": book_id, "entry": result["entry"]}), 409
    return jsonify({"ok": True, "book_id": book_id, "entry": result["entry"]})


@app.route("/api/progress/reset", methods=["POST"])
def reset_progress():
    data = request.get_json(force=True) or {}
    book_id = (data.get("book_id") or "").strip()
    if not book_id:
        return jsonify({"ok": False, "error": "book_id required"}), 400
    progress.reset_book_progress(book_id)
    return jsonify({"ok": True, "book_id": book_id})


@app.route("/api/download", methods=["POST"])
def start_url_download():
    data = request.get_json(force=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "Missing URL"}), 400
    jid = new_job("url-download")
    threading.Thread(target=run_url_download, args=(jid, url), daemon=True).start()
    return jsonify({"ok": True, "job_id": jid})


@app.route("/api/jobs/<jid>")
def job_status(jid):
    since = int(request.args.get("since", 0))
    with jobs_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({"ok": False, "error": "Unknown job"}), 404
        lines = j["lines"][since:]
        return jsonify({"ok": True, "done": j["done"], "error": j["error"], "success": j["ok"], "result": j.get("result"), "next": since + len(lines), "lines": lines})


@app.route("/api/jobs/<jid>/cancel", methods=["POST"])
def cancel_job(jid):
    with jobs_lock:
        if jid not in jobs:
            return jsonify({"ok": False}), 404
        jobs[jid]["cancel"] = True
    return jsonify({"ok": True})


@app.route("/api/features")
def features():
    return jsonify({"irc": HAS_IRC})


@app.route("/api/irc/status")
def irc_status():
    if not HAS_IRC:
        return jsonify({"available": False}), 503
    return jsonify(irc.client.status())


@app.route("/api/irc/search", methods=["POST"])
def irc_search():
    if not HAS_IRC:
        return jsonify({"ok": False, "error": "irc plugin not installed"}), 503
    data = request.get_json(force=True) or {}
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"ok": False, "error": "query required"}), 400
    jid = new_job("irc-search")
    threading.Thread(target=run_irc_search, args=(jid, query), daemon=True).start()
    return jsonify({"ok": True, "job_id": jid})


@app.route("/api/irc/download", methods=["POST"])
def irc_download():
    if not HAS_IRC:
        return jsonify({"ok": False, "error": "irc plugin not installed"}), 503
    data = request.get_json(force=True) or {}
    result = data.get("result")
    if not isinstance(result, dict):
        return jsonify({"ok": False, "error": "result required"}), 400
    jid = new_job("irc-download")
    threading.Thread(target=run_irc_download, args=(jid, result), daemon=True).start()
    return jsonify({"ok": True, "job_id": jid})


@app.route("/api/staging")
def list_staging():
    return jsonify({"folder": current_staging_folder(), "items": _safe_staging_files()})


@app.route("/api/cover-proxy")
def cover_proxy():
    url = request.args.get("url", "")
    try:
        return _cover_response(url)
    except Exception:
        abort(404)


@app.route("/api/staging/<staging_id>/cover-candidates", methods=["POST"])
def staging_cover_candidates(staging_id):
    try:
        _staging_path_by_id(staging_id)
    except FileNotFoundError:
        return jsonify({"ok": False, "error": "Staged book not found"}), 404
    data = request.get_json(silent=True) or {}
    candidates = _cover_candidates(data.get("title"), data.get("author"))
    return jsonify({"ok": True, "candidates": candidates})


@app.route("/api/staging/<staging_id>/import", methods=["POST"])
def import_staged_book(staging_id):
    data = request.get_json(silent=True) or {}
    try:
        src = _staging_path_by_id(staging_id)
    except FileNotFoundError:
        try:
            src = _staging_path_by_filename(data.get("filename"))
        except FileNotFoundError:
            return jsonify({"ok": False, "error": "Staged book not found"}), 404
    try:
        if any(k in data for k in ("title", "author", "series", "series_index")):
            library.write_book_metadata(
                src,
                title=data.get("title"),
                author=data.get("author"),
                series=data.get("series"),
                series_index=data.get("series_index"),
            )
        if data.get("cover_url"):
            library.replace_book_cover(src, _download_cover(data.get("cover_url")))
        dest = _library_destination_for(src)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        books = library.refresh_library(current_library_folder())
        return jsonify({
            "ok": True,
            "path": dest.relative_to(Path(current_library_folder()).resolve()).as_posix(),
            "books": books,
            "groups": library.group_books(books),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/library")
def list_library():
    books = library.scan_library(current_library_folder(), use_cache=True)
    prog = progress.load_progress().get("books", {})
    for book in books:
        p = prog.get(book["id"], {})
        book["percent"] = float(p.get("percent") or 0)
        book["last_opened"] = p.get("last_opened")
    return jsonify({"folder": current_library_folder(), "books": books, "groups": library.group_books(books)})


@app.route("/api/library/refresh", methods=["POST"])
def refresh_library():
    books = library.refresh_library(current_library_folder())
    prog = progress.load_progress().get("books", {})
    for book in books:
        p = prog.get(book["id"], {})
        book["percent"] = float(p.get("percent") or 0)
        book["last_opened"] = p.get("last_opened")
    return jsonify({"folder": current_library_folder(), "books": books, "groups": library.group_books(books)})


@app.route("/api/book/<book_id>/file")
def book_file(book_id):
    path, _ = _book_path_by_id(book_id)
    return send_file(path, mimetype="application/epub+zip", as_attachment=False, download_name=path.name)


@app.route("/api/book/<book_id>/cover")
def book_cover(book_id):
    path, _ = _book_path_by_id(book_id)
    try:
        content, mime, etag = library.cover_thumbnail(path, CONFIG_DIR / "cover-cache")
    except Exception:
        abort(404)
    if request.if_none_match and etag in request.if_none_match:
        return "", 304
    from io import BytesIO
    resp = send_file(BytesIO(content), mimetype=mime)
    resp.set_etag(etag)
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


_runtime_lock = threading.Lock()
_runtime_started = False


def _warm_library():
    folder = current_library_folder()
    library.scan_library(folder, use_cache=True)
    library.warm_cover_cache(folder, CONFIG_DIR / "cover-cache")


def initialize_runtime():
    global _runtime_started
    with _runtime_lock:
        if _runtime_started:
            return
        _runtime_started = True
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    Path(current_staging_folder()).mkdir(parents=True, exist_ok=True)
    if HAS_IRC:
        irc.client.start_background()
    threading.Thread(target=_warm_library, daemon=True).start()


if __name__ == "__main__":
    initialize_runtime()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8765")), threaded=True)
