import base64
import hashlib
import mimetypes
import posixpath
import shutil
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import ebooklib
from ebooklib import epub


_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
_CACHE_TTL = 600
_cache_lock = threading.Lock()
_scan_lock = threading.Lock()
_cache = {"root": None, "at": 0, "books": None}


def book_id_for_relpath(relpath):
    return hashlib.sha256(relpath.encode("utf-8")).hexdigest()[:16]


def _safe_relpath(root, path):
    root = Path(root).resolve()
    path = Path(path).resolve()
    if root not in path.parents and path != root:
        raise ValueError("path escapes library root")
    return path.relative_to(root).as_posix()


def resolve_book_path(root, relpath):
    root = Path(root).resolve()
    candidate = (root / relpath).resolve()
    if root not in candidate.parents and candidate != root:
        raise ValueError("path escapes library root")
    if candidate.suffix.lower() != ".epub" or not candidate.is_file():
        raise FileNotFoundError(relpath)
    return candidate


def find_book_by_id(root, book_id):
    for book in scan_library(root, use_cache=True):
        if book["id"] == book_id:
            return book
    raise FileNotFoundError(book_id)


def _first_meta(book, name):
    vals = book.get_metadata("DC", name)
    if vals:
        value = vals[0][0]
        return str(value).strip() if value is not None else None
    return None


def _meta_property(book, prop):
    # ebooklib raises KeyError(None) when the book has no custom-namespace
    # metadata at all, so guard it — otherwise it aborts the whole parse.
    try:
        items = book.get_metadata(None, prop)
    except Exception:
        items = []
    for item in items:
        if item and item[0]:
            return str(item[0]).strip()
        if len(item) > 1 and item[1] and item[1].get("content"):
            return str(item[1]["content"]).strip()
    return None


def _calibre_meta(book, name):
    direct = _meta_property(book, f"calibre:{name}")
    if direct:
        return direct
    try:
        items = book.get_metadata("calibre", name)
    except Exception:
        items = []
    for item in items:
        if item and item[0]:
            return str(item[0]).strip()
        if len(item) > 1 and item[1] and item[1].get("content"):
            return str(item[1]["content"]).strip()
    return None


def _cover_item(book):
    for item in book.get_items():
        try:
            if item.get_type() == ebooklib.ITEM_IMAGE and item.get_media_type() in _IMAGE_TYPES:
                props = getattr(item, "properties", []) or []
                if "cover-image" in props:
                    return item
        except Exception:
            pass
    cover_meta = book.get_metadata("OPF", "cover")
    if cover_meta:
        cover_id = cover_meta[0][1].get("content") if len(cover_meta[0]) > 1 else None
        if cover_id:
            item = book.get_item_with_id(cover_id)
            if item is not None:
                return item
    for item in book.get_items():
        try:
            media = item.get_media_type()
            name = item.get_name().lower()
            if media in _IMAGE_TYPES and "cover" in posixpath.basename(name):
                return item
        except Exception:
            pass
    for item in book.get_items():
        try:
            if item.get_type() == ebooklib.ITEM_IMAGE and item.get_media_type() in _IMAGE_TYPES:
                return item
        except Exception:
            pass
    return None


def read_book_metadata(path):
    path = Path(path)
    title = path.stem
    author = "Unknown Author"
    series = None
    series_index = None
    genre = None
    cover_mime = None
    has_cover = False
    try:
        book = epub.read_epub(str(path), options={"ignore_ncx": True})
        title = _first_meta(book, "title") or title
        author = _first_meta(book, "creator") or author
        series = _calibre_meta(book, "series") or _meta_property(book, "belongs-to-collection")
        series_index = _calibre_meta(book, "series_index")
        genre = _first_meta(book, "subject")
        item = _cover_item(book)
        if item is not None:
            cover_mime = item.get_media_type() or mimetypes.guess_type(item.get_name())[0] or "image/jpeg"
            has_cover = True
    except Exception:
        pass
    if not has_cover:
        try:
            _, cover_mime = _zip_cover(path)
            has_cover = True
        except Exception:
            pass
    return {"title": title, "author": author, "series": series, "series_index": series_index, "genre": genre, "cover_mime": cover_mime, "has_cover": has_cover}


def read_cover(path):
    try:
        book = epub.read_epub(str(path), options={"ignore_ncx": True})
        item = _cover_item(book)
        if item is not None:
            mime = item.get_media_type() or mimetypes.guess_type(item.get_name())[0] or "image/jpeg"
            return item.get_content(), mime
    except Exception:
        pass
    return _zip_cover(path)


def _zip_cover(path):
    with zipfile.ZipFile(path) as zf:
        images = [
            n for n in zf.namelist()
            if not n.endswith("/") and Path(n).suffix.lower() in _IMAGE_EXTS
        ]
        if not images:
            raise FileNotFoundError("cover")
        preferred = [
            n for n in images
            if "cover" in Path(n).name.lower() or "_cvi" in Path(n).name.lower() or "cvi." in Path(n).name.lower()
        ]
        name = sorted(preferred or images)[0]
        mime = mimetypes.guess_type(name)[0] or "image/jpeg"
        return zf.read(name), mime


_THUMB_MAX = (400, 600)


def cover_thumbnail(path, cache_dir, max_dim=_THUMB_MAX):
    """Return (bytes, mime, etag) for a resized, JPEG-encoded cover thumbnail.

    Results are cached on disk keyed by the source file's path + mtime, so a
    cover is only extracted and re-encoded once. Falls back to the raw cover if
    Pillow is unavailable or decoding fails.
    """
    path = Path(path)
    mtime = int(path.stat().st_mtime)
    key = hashlib.sha1(f"{path}:{mtime}".encode()).hexdigest()
    cache_dir = Path(cache_dir)
    cache_file = cache_dir / f"{key}.jpg"

    if cache_file.exists():
        return cache_file.read_bytes(), "image/jpeg", key

    content, mime = read_cover(path)
    try:
        from io import BytesIO
        from PIL import Image

        img = Image.open(BytesIO(content))
        img.load()
        if img.mode not in ("RGB", "L"):
            background = Image.new("RGB", img.size, (255, 255, 255))
            img = img.convert("RGBA")
            background.paste(img, mask=img.split()[-1])
            img = background
        else:
            img = img.convert("RGB")
        img.thumbnail(max_dim, Image.LANCZOS)
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=82, optimize=True, progressive=True)
        data = buf.getvalue()
    except Exception:
        return content, mime, key

    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = cache_file.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(cache_file)
    except Exception:
        pass
    return data, "image/jpeg", key


def is_valid_epub(path):
    path = Path(path)
    if path.suffix.lower() != ".epub":
        return False
    try:
        with path.open("rb") as f:
            if f.read(4) != b"PK\x03\x04":
                return False
        with zipfile.ZipFile(path) as zf:
            return "mimetype" in zf.namelist() and zf.read("mimetype").strip() == b"application/epub+zip"
    except Exception:
        return False


def _scan_library_uncached(root):
    root = Path(root).resolve()
    if not root.is_dir():
        return []
    books = []
    for path in sorted(root.rglob("*.epub")):
        if not path.is_file():
            continue
        rel = _safe_relpath(root, path)
        meta = read_book_metadata(path)
        book_id = book_id_for_relpath(rel)
        parent = path.parent.name if path.parent != root else "Library"
        books.append({
            "id": book_id,
            "path": rel,
            "filename": path.name,
            "group": parent,
            "title": meta["title"],
            "author": meta["author"],
            "series": meta["series"],
            "genre": meta["genre"],
            "has_cover": meta["has_cover"],
            "cover_url": f"/api/book/{book_id}/cover" if meta["has_cover"] else None,
        })
    return books


def scan_library(root, use_cache=False):
    root = Path(root).resolve()
    now = time.time()
    if use_cache:
        with _cache_lock:
            if _cache["root"] == str(root) and _cache["books"] is not None and now - _cache["at"] < _CACHE_TTL:
                return list(_cache["books"])
    with _scan_lock:
        with _cache_lock:
            if _cache["root"] == str(root) and _cache["books"] is not None and now - _cache["at"] < _CACHE_TTL:
                return list(_cache["books"])
        books = _scan_library_uncached(root)
    with _cache_lock:
        _cache.update({"root": str(root), "at": now, "books": list(books)})
    return books


def refresh_library(root):
    with _cache_lock:
        _cache.update({"root": None, "at": 0, "books": None})
    return scan_library(root, use_cache=False)


def group_books(books):
    groups = []
    by_group = {}
    for book in books:
        group = book.get("group") or "Library"
        if group not in by_group:
            by_group[group] = {"name": group, "books": []}
            groups.append(by_group[group])
        by_group[group]["books"].append(book)
    return groups


def warm_cover_cache(root, cache_dir):
    """Pre-generate cover thumbnails for every book so first page loads are
    instant. Safe to run in a background thread; skips covers already cached
    and ignores per-book failures."""
    count = 0
    for book in scan_library(root, use_cache=True):
        if not book.get("has_cover"):
            continue
        try:
            path = resolve_book_path(root, book["path"])
            cover_thumbnail(path, cache_dir)
            count += 1
        except Exception:
            continue
    return count


def data_uri_for_cover(path):
    content, mime = read_cover(path)
    return f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"


def _opf_path(zf):
    rootfile = ET.fromstring(zf.read("META-INF/container.xml"))
    ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
    el = rootfile.find(".//c:rootfile[@media-type='application/oebps-package+xml']", ns)
    if el is None:
        el = rootfile.find(".//c:rootfile", ns)
    if el is None or not el.get("full-path"):
        raise FileNotFoundError("OPF package document")
    return el.get("full-path")


def _first_child(parent, tag):
    found = parent.find(tag)
    if found is not None:
        return found
    return ET.SubElement(parent, tag)


def _set_text(metadata, tag, value, attrs=None):
    attrs = attrs or {}
    el = metadata.find(tag)
    if el is None:
        el = ET.SubElement(metadata, tag, attrs)
    else:
        el.attrib.clear()
        el.attrib.update(attrs)
    el.text = value


def _remove_calibre_meta(metadata):
    for child in list(metadata):
        name = child.get("name")
        if name in {"calibre:series", "calibre:series_index"}:
            metadata.remove(child)


def _opf_dir(opf_name):
    parent = posixpath.dirname(opf_name)
    return f"{parent}/" if parent else ""


def _cover_href(opf_root, opf_name):
    metadata = opf_root.find(f"{{{epub.NAMESPACES['OPF']}}}metadata")
    manifest = opf_root.find(f"{{{epub.NAMESPACES['OPF']}}}manifest")
    if manifest is None:
        return None
    cover_id = None
    if metadata is not None:
        for child in metadata:
            if child.tag.endswith("meta") and child.get("name") == "cover" and child.get("content"):
                cover_id = child.get("content")
                break
    for item in manifest:
        media = item.get("media-type")
        props = item.get("properties", "")
        href = item.get("href")
        if not href:
            continue
        if cover_id and item.get("id") == cover_id:
            return posixpath.normpath(_opf_dir(opf_name) + href)
        if media in _IMAGE_TYPES and "cover-image" in props.split():
            return posixpath.normpath(_opf_dir(opf_name) + href)
    for item in manifest:
        href = item.get("href")
        media = item.get("media-type")
        if href and media in _IMAGE_TYPES and "cover" in posixpath.basename(href).lower():
            return posixpath.normpath(_opf_dir(opf_name) + href)
    return None


def _rewrite_epub(path, transform):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        with zipfile.ZipFile(path, "r") as src:
            updates = transform(src)
            with zipfile.ZipFile(tmp, "w") as dst:
                for info in src.infolist():
                    data = updates.get(info.filename)
                    if data is None:
                        data = src.read(info.filename)
                    dst.writestr(info, data)
        shutil.move(str(tmp), str(path))
    except Exception:
        try:
            tmp.unlink()
        except Exception:
            pass
        raise


def write_book_metadata(path, title=None, author=None, series=None, series_index=None):
    ET.register_namespace("dc", epub.NAMESPACES["DC"])
    ET.register_namespace("opf", epub.NAMESPACES["OPF"])
    clean_title = str(title or "").strip()
    clean_author = str(author or "").strip()
    clean_series = str(series or "").strip()
    clean_series_index = str(series_index or "").strip()
    def transform(src):
        opf_name = _opf_path(src)
        opf_root = ET.fromstring(src.read(opf_name))
        metadata = _first_child(opf_root, f"{{{epub.NAMESPACES['OPF']}}}metadata")
        if clean_title:
            _set_text(metadata, f"{{{epub.NAMESPACES['DC']}}}title", clean_title)
        if clean_author:
            _set_text(metadata, f"{{{epub.NAMESPACES['DC']}}}creator", clean_author, {"id": "creator"})
        _remove_calibre_meta(metadata)
        if clean_series:
            ET.SubElement(metadata, "meta", {"name": "calibre:series", "content": clean_series})
            if clean_series_index:
                ET.SubElement(metadata, "meta", {"name": "calibre:series_index", "content": clean_series_index})
        return {opf_name: ET.tostring(opf_root, encoding="utf-8", xml_declaration=True)}
    _rewrite_epub(path, transform)
    return read_book_metadata(path)


def _existing_cover_member(zf):
    """Zip member the reader treats as the cover, matching _zip_cover's pick.

    Used to replace covers in epubs whose OPF doesn't declare a cover-image
    href (so _cover_href returns None) but that still ship a cover image.
    """
    images = [
        n for n in zf.namelist()
        if not n.endswith("/") and Path(n).suffix.lower() in _IMAGE_EXTS
    ]
    if not images:
        return None
    preferred = [
        n for n in images
        if "cover" in Path(n).name.lower() or "_cvi" in Path(n).name.lower() or "cvi." in Path(n).name.lower()
    ]
    return sorted(preferred or images)[0]


def replace_book_cover(path, content):
    path = Path(path)
    def transform(src):
        opf_name = _opf_path(src)
        opf_root = ET.fromstring(src.read(opf_name))
        href = _cover_href(opf_root, opf_name)
        if not href:
            # OPF doesn't declare a cover image; fall back to the image the
            # reader actually displays so the chosen cover still takes effect.
            href = _existing_cover_member(src)
        if not href:
            raise FileNotFoundError("cover image")
        return {href: content}
    _rewrite_epub(path, transform)
    return read_book_metadata(path)
