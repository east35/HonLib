"""KOReader Sync book identity and position mapping for CrossPoint."""

import hashlib
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile
from functools import lru_cache
from pathlib import Path


_STEP = re.compile(r"/(\d+)(?:\[[^\]]*\])?(?::(\d+))?")
_CFI = re.compile(r"^epubcfi\((.*)\)$")
_XPATH = re.compile(r"^/body/DocFragment\[(\d+)\]/body(.*)$")
_XPATH_TEXT = re.compile(r"/text\(\)\[(\d+)\]\.(\d+)$")
_XPATH_ELEMENT = re.compile(r"/([A-Za-z_][\w.:-]*)\[(\d+)\]")


def filename_document_id(filename):
    return hashlib.md5(filename.encode("utf-8")).hexdigest()


@lru_cache(maxsize=512)
def _binary_document_id(path, size, mtime_ns):
    digest = hashlib.md5()
    with open(path, "rb") as book:
        for offset in (0,) + tuple(1024 << (2 * i) for i in range(11)):
            if offset >= size:
                continue
            book.seek(offset)
            digest.update(book.read(1024))
    return digest.hexdigest()


def binary_document_id(path):
    path = Path(path)
    stat = path.stat()
    return _binary_document_id(str(path), stat.st_size, stat.st_mtime_ns)


def _local_name(tag):
    return tag.rsplit("}", 1)[-1].lower()


def _epub_context(epub_path, spine_index):
    with zipfile.ZipFile(epub_path) as archive:
        container = ET.fromstring(archive.read("META-INF/container.xml"))
        package_path = next(
            node.attrib["full-path"] for node in container.iter()
            if _local_name(node.tag) == "rootfile"
        )
        package = ET.fromstring(archive.read(package_path))
        manifest = {
            node.attrib["id"]: node.attrib["href"] for node in package.iter()
            if _local_name(node.tag) == "item"
        }
        package_children = [node for node in package if isinstance(node.tag, str)]
        spine_node = next(node for node in package_children if _local_name(node.tag) == "spine")
        itemrefs = [node for node in spine_node if _local_name(node.tag) == "itemref"]
        href = manifest[itemrefs[spine_index].attrib["idref"]]
        doc_path = posixpath.normpath(posixpath.join(posixpath.dirname(package_path), href))
        package_step = 2 * (package_children.index(spine_node) + 1)
        item_step = 2 * (spine_index + 1)
        return ET.fromstring(archive.read(doc_path)), f"/{package_step}/{item_step}"


def _spine_document(epub_path, spine_index):
    return _epub_context(epub_path, spine_index)[0]


def _text_offset(text, utf16_offset):
    """CFI offsets count UTF-16 units; CrossPoint XPath counts characters."""
    units = 0
    for index, char in enumerate(text or ""):
        units += 2 if ord(char) > 0xFFFF else 1
        if units > utf16_offset:
            return index
        if units == utf16_offset:
            return index + 1
    return len(text or "")


def cfi_to_xpath(epub_path, cfi):
    """Translate a Foliate point CFI to CrossPoint's KOReader-style XPath.

    Return None when the CFI cannot be resolved. The caller may still supply
    the overall percentage, which CrossPoint can use as an approximate fallback.
    """
    match = _CFI.fullmatch(cfi or "")
    if not match or "!" not in match.group(1):
        return None
    package_part, content_part = match.group(1).split("!", 1)
    package_steps = [int(n) for n, _ in _STEP.findall(package_part)]
    if len(package_steps) < 2 or package_steps[-1] % 2:
        return None
    spine_index = package_steps[-1] // 2 - 1
    # For a range CFI, the first comma separates the common path from its
    # start point. The start point is where HonLib resumes reading.
    if "," in content_part:
        common, start, _ = content_part.split(",", 2)
        content_part = common + start
    steps = [(int(n), int(offset) if offset else None)
             for n, offset in _STEP.findall(content_part)]
    if spine_index < 0 or not steps:
        return None
    try:
        root = _spine_document(epub_path, spine_index)
        node = root
        path = []
        for step_index, (number, offset) in enumerate(steps):
            children = [child for child in node if isinstance(child.tag, str)]
            if number % 2:
                if step_index != len(steps) - 1 or offset is None:
                    return None
                gap = (number - 1) // 2
                chunks = [node.text or ""] + [child.tail or "" for child in children]
                if gap >= len(chunks):
                    return None
                text_index = sum(bool(chunk) for chunk in chunks[:gap + 1])
                if not chunks[gap] or not text_index:
                    return None
                char_offset = _text_offset(chunks[gap], offset)
                return f"/body/DocFragment[{spine_index + 1}]/body" + "".join(path) + f"/text()[{text_index}].{char_offset}"
            child_index = number // 2 - 1
            if child_index < 0 or child_index >= len(children):
                return None
            child = children[child_index]
            if _local_name(child.tag) != "body":
                same_tag_index = sum(_local_name(sibling.tag) == _local_name(child.tag)
                                     for sibling in children[:child_index + 1])
                path.append(f"/{_local_name(child.tag)}[{same_tag_index}]")
            node = child
        if path:
            return f"/body/DocFragment[{spine_index + 1}]/body" + "".join(path) + "/text()[1].0"
    except (KeyError, IndexError, OSError, ValueError, ET.ParseError, zipfile.BadZipFile):
        pass
    return None


def xpath_to_cfi(epub_path, xpath):
    """Resolve a CrossPoint text XPath to a Foliate CFI in the same EPUB.

    A chapter-only or malformed XPath is deliberately left unresolved so the
    reader can use the percentage rather than jumping to a wrong chapter start.
    """
    match = _XPATH.fullmatch(xpath or "")
    if not match:
        return None
    spine_index = int(match.group(1)) - 1
    path = match.group(2)
    text_match = _XPATH_TEXT.search(path)
    if spine_index < 0 or not text_match:
        return None
    element_path = path[:text_match.start()]
    elements = list(_XPATH_ELEMENT.finditer(element_path))
    if "".join(item.group(0) for item in elements) != element_path:
        return None
    try:
        root, package_cfi = _epub_context(epub_path, spine_index)
        root_children = [child for child in root if isinstance(child.tag, str)]
        body = next(child for child in root_children if _local_name(child.tag) == "body")
        cfi_steps = [2 * (root_children.index(body) + 1)]
        node = body
        for element in elements:
            tag = element.group(1).split(":")[-1].lower()
            wanted_index = int(element.group(2))
            if wanted_index < 1:
                return None
            children = [child for child in node if isinstance(child.tag, str)]
            same_tag = [child for child in children if _local_name(child.tag) == tag]
            if wanted_index > len(same_tag):
                return None
            child = same_tag[wanted_index - 1]
            cfi_steps.append(2 * (children.index(child) + 1))
            node = child
        children = [child for child in node if isinstance(child.tag, str)]
        chunks = [node.text or ""] + [child.tail or "" for child in children]
        text_index = int(text_match.group(1))
        nonempty_gaps = [index for index, chunk in enumerate(chunks) if chunk]
        if text_index < 1 or text_index > len(nonempty_gaps):
            return None
        gap = nonempty_gaps[text_index - 1]
        codepoint_offset = int(text_match.group(2))
        chunk = chunks[gap]
        if codepoint_offset > len(chunk):
            return None
        utf16_offset = len(chunk[:codepoint_offset].encode("utf-16-le")) // 2
        content_cfi = "".join(f"/{step}" for step in cfi_steps)
        return f"epubcfi({package_cfi}!{content_cfi}/{2 * gap + 1}:{utf16_offset})"
    except (KeyError, IndexError, OSError, StopIteration, ValueError,
            ET.ParseError, zipfile.BadZipFile):
        return None
