#!/usr/bin/env python3
"""Generate an EPUB whose middle chapter is split across two spine files.

Publishers routinely break a long chapter into several spine documents and give
only the first one a TOC entry (Seveneves' "Ymir" is Chapter_10.xhtml plus
Chapter_10a.xhtml). A reader that equates "spine section" with "chapter" shows
such a chapter restarting at 0% partway through, and paints a progress segment
that the contents view has no entry for. This fixture reproduces that shape:

    spine:  one  two  two-continued  three
    toc:    One  Two  -              Three

The title, author, series and identifier can be overridden, so the same shape
also serves as "another book" wherever a test needs a small library.
"""

import argparse
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


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
    <dc:identifier id="book-id">{identifier}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-06-28T00:00:00Z</meta>{series}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
    <item id="two" href="two.xhtml" media-type="application/xhtml+xml"/>
    <item id="two-continued" href="two-continued.xhtml" media-type="application/xhtml+xml"/>
    <item id="three" href="three.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="one"/>
    <itemref idref="two"/>
    <itemref idref="two-continued"/>
    <itemref idref="three"/>
  </spine>
</package>
"""
# "Two" spans two spine files but gets a single entry, exactly as a real
# publisher's split chapter does. There is deliberately no entry for
# two-continued.xhtml.
NAV = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Contents</title></head>
<body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
  <ol>
    <li><a href="one.xhtml#one">One</a></li>
    <li><a href="two.xhtml#two">Two</a></li>
    <li><a href="three.xhtml#three">Three</a></li>
  </ol>
</nav></body>
</html>
"""
DOCUMENT = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{title}</title></head>
<body>
{heading}
{paragraphs}
</body>
</html>
"""
# Each document needs enough text to paginate into many pages, so the tests can
# step across a boundary rather than teleporting over it.
PARAGRAPH = (
    "<p id=\"{id}\">{title} paragraph {n}. "
    + ("Filler text that exists only to make this section long enough to span "
       "several rendered pages at any reasonable font size. ") * 6
    + "</p>"
)


def document(title, anchor, paragraphs=40):
    heading = f'<h1 id="{anchor}">{title}</h1>' if anchor else ""
    body = "\n".join(
        PARAGRAPH.format(id=f"{anchor or 'cont'}-p{n}", title=title, n=n)
        for n in range(paragraphs)
    )
    return DOCUMENT.format(title=title, heading=heading, paragraphs=body)


def make_epub(
    output,
    title="HonLib Split Chapter Test",
    author="HonLib Test Suite",
    identifier="urn:uuid:honlib-split-chapter-test",
    series=None,
    series_index=None,
):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    series_meta = ""
    if series:
        series_meta = f'\n    <meta name="calibre:series" content="{escape(series, {chr(34): "&quot;"})}"/>'
        if series_index is not None:
            series_meta += f'\n    <meta name="calibre:series_index" content="{series_index}"/>'
    package = PACKAGE.format(
        identifier=escape(identifier), title=escape(title), author=escape(author), series=series_meta,
    )
    with zipfile.ZipFile(output, "w") as epub:
        epub.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
        epub.writestr("META-INF/container.xml", CONTAINER)
        epub.writestr("EPUB/package.opf", package)
        epub.writestr("EPUB/nav.xhtml", NAV)
        epub.writestr("EPUB/one.xhtml", document("One", "one"))
        epub.writestr("EPUB/two.xhtml", document("Two", "two"))
        # No heading and no anchor: this is the middle of chapter Two.
        epub.writestr("EPUB/two-continued.xhtml", document("Two", None))
        epub.writestr("EPUB/three.xhtml", document("Three", "three"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("output", metavar="OUTPUT.epub")
    parser.add_argument("--title")
    parser.add_argument("--author")
    parser.add_argument("--identifier")
    parser.add_argument("--series")
    parser.add_argument("--series-index")
    args = vars(parser.parse_args())
    make_epub(args.pop("output"), **{key: value for key, value in args.items() if value is not None})
