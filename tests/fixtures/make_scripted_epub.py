#!/usr/bin/env python3
"""Generate a harmless EPUB whose script reports if the browser executes it."""

import sys
import zipfile
from pathlib import Path


MIMETYPE = "application/epub+zip"
CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""
PACKAGE = """<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="book-id"
         xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:honlib-scripted-epub-test</dc:identifier>
    <dc:title>HonLib Scripted EPUB Security Test</dc:title>
    <dc:creator>HonLib Test Suite</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-06-28T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>
"""
NAV = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Contents</title></head>
<body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
  <ol><li><a href="chapter.xhtml">Security test</a></li></ol>
</nav></body>
</html>
"""
CHAPTER = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Security test</title></head>
<body>
  <h1 id="honlib-csp-status">Script did not run</h1>
  <p>This chapter must render, but its script must not execute.</p>
  <script id="honlib-csp-probe">
    document.getElementById("honlib-csp-status").textContent = "SCRIPT EXECUTED";
    parent.postMessage({ type: "honlib-csp-test" }, "*");
  </script>
</body>
</html>
"""


def make_epub(output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w") as epub:
        epub.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
        epub.writestr("META-INF/container.xml", CONTAINER)
        epub.writestr("EPUB/package.opf", PACKAGE)
        epub.writestr("EPUB/nav.xhtml", NAV)
        epub.writestr("EPUB/chapter.xhtml", CHAPTER)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} OUTPUT.epub")
    make_epub(sys.argv[1])
