import re
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
BASE = "https://standardebooks.org"


class Cancelled(Exception):
    pass


def match(url):
    try:
        host = urlparse(url).netloc.lower()
        return host in {"standardebooks.org", "www.standardebooks.org"}
    except Exception:
        return False


def _safe_name(name):
    name = re.sub(r"[^A-Za-z0-9._ -]+", "", name).strip(" .")
    return name or "standard-ebooks-download.epub"


def _download_url(page_url, log):
    r = requests.get(page_url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    candidates = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(" ", strip=True).lower()
        if ".epub" in href.lower() and "kepub" not in href.lower() and "advanced" not in text:
            candidates.append(href)
    if not candidates:
        raise ValueError("No EPUB download link found on Standard Ebooks page")
    href = candidates[0]
    if href.startswith("/"):
        href = BASE + href
    log(f"Found EPUB: {href}")
    return href


def download(url, out, log=print, stop=None):
    if not match(url):
        raise ValueError("Unsupported URL")
    stop = stop or (lambda: False)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    epub_url = url if urlparse(url).path.lower().endswith(".epub") else _download_url(url, log)
    filename = _safe_name(Path(urlparse(epub_url).path).name or "standard-ebooks.epub")
    if not filename.lower().endswith(".epub"):
        filename += ".epub"
    dest = out / filename
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(epub_url, headers={"User-Agent": UA}, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        seen = 0
        with tmp.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 256):
                if stop():
                    raise Cancelled("cancelled")
                if not chunk:
                    continue
                f.write(chunk)
                seen += len(chunk)
                if total:
                    log(f"Downloaded {seen / total:.0%}")
    tmp.replace(dest)
    log(f"Saved {dest}")
    return dest
