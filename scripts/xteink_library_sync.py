#!/usr/bin/env python3
"""Mirror one server library into /HonLib on a CrossPoint reader.

This runs on the book server. It touches only its tracked books in /HonLib.
"""

import argparse
import hashlib
import http.client
import json
import os
import posixpath
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


DEST_ROOT = "/HonLib"


def request(base, path, *, data=None, timeout=10, headers=None):
    url = base.rstrip("/") + path
    req = urllib.request.Request(url, data=data, headers=headers or {})
    return urllib.request.urlopen(req, timeout=timeout)


def get_json(base, path, *, timeout=10):
    with request(base, path, timeout=timeout) as response:
        return json.load(response)


def form_post(base, endpoint, fields):
    body = urllib.parse.urlencode(fields).encode()
    with request(base, endpoint, data=body,
                 headers={"Content-Type": "application/x-www-form-urlencoded"}) as response:
        return response.read().decode("utf-8", "replace")


def list_dir(base, directory):
    query = urllib.parse.urlencode({"path": directory})
    items = get_json(base, "/api/files?" + query)
    if not isinstance(items, list):
        raise ValueError(f"Invalid file listing for {directory}")
    return items


def device_inventory(base):
    files = {}
    dirs = {"/"}
    pending = ["/"]
    while pending:
        directory = pending.pop()
        if len(dirs) > 500:
            raise ValueError("Device has too many folders to inspect safely")
        for item in list_dir(base, directory):
            name = item.get("name", "")
            if not isinstance(name, str) or name in ("", ".", "..") or "/" in name:
                raise ValueError(f"Invalid device entry in {directory}")
            if name.startswith("."):
                continue
            path = posixpath.join(directory, name)
            if item.get("isDirectory"):
                dirs.add(path)
                pending.append(path)
            elif item.get("isEpub") or name.lower().endswith(".epub"):
                files[path] = int(item["size"])
    return files, dirs


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_device_file(base, path):
    digest = hashlib.sha256()
    query = urllib.parse.urlencode({"path": path})
    with request(base, "/download?" + query, timeout=120) as response:
        for chunk in iter(lambda: response.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_books(root):
    root = root.resolve()
    for book in sorted(root.rglob("*"), key=lambda p: str(p).casefold()):
        if book.suffix.lower() != ".epub" or not book.is_file() or book.is_symlink():
            continue
        if root not in book.resolve().parents:
            continue
        yield book.relative_to(root).as_posix(), book


def load_state(path, serial):
    try:
        state = json.loads(path.read_text())
        if state.get("serial") == serial and isinstance(state.get("books"), dict):
            return state
    except (OSError, ValueError, AttributeError):
        pass
    return {"version": 1, "serial": serial, "books": {}}


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=".sync-", delete=False) as tmp:
        json.dump(state, tmp, indent=2, sort_keys=True)
        tmp.write("\n")
        temp_path = Path(tmp.name)
    os.replace(temp_path, path)


def ensure_directory(base, dirs, path):
    if path in dirs:
        return
    parent = posixpath.dirname(path)
    ensure_directory(base, dirs, parent)
    form_post(base, "/mkdir", {"name": posixpath.basename(path), "path": parent})
    dirs.add(path)


def device_has_file(base, path, size):
    return any(item.get("name") == posixpath.basename(path)
               and not item.get("isDirectory") and int(item["size"]) == size
               for item in list_dir(base, posixpath.dirname(path)))


def move_file(base, files, dirs, old_path, destination, size):
    ensure_directory(base, dirs, posixpath.dirname(destination))
    form_post(base, "/move", {"path": old_path, "dest": posixpath.dirname(destination)})
    if not device_has_file(base, destination, size):
        raise RuntimeError(f"Device did not confirm move to {destination}")
    files.pop(old_path, None)
    files[destination] = size


def delete_file(base, files, path):
    if not path.startswith(DEST_ROOT + "/"):
        raise ValueError(f"Refusing to delete outside {DEST_ROOT}: {path}")
    form_post(base, "/delete", {"path": path})
    if any(item.get("name") == posixpath.basename(path)
           for item in list_dir(base, posixpath.dirname(path))):
        raise RuntimeError(f"Device did not confirm deletion of {path}")
    files.pop(path, None)


def remove_empty_directories(base, dirs):
    for directory in sorted(dirs, key=lambda path: path.count("/"), reverse=True):
        if directory == DEST_ROOT or not directory.startswith(DEST_ROOT + "/"):
            continue
        if not list_dir(base, directory):
            form_post(base, "/delete", {"path": directory})
            dirs.remove(directory)


def upload(base, book, directory):
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "http" or not parsed.hostname:
        raise ValueError("Device transfer URL must be plain HTTP on the local network")
    boundary = uuid.uuid4().hex
    filename = book.name.replace("\\", "\\\\").replace('"', '\\"')
    if "\r" in filename or "\n" in filename:
        raise ValueError("Invalid book filename")
    preamble = (f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                "Content-Type: application/epub+zip\r\n\r\n").encode("utf-8")
    closing = f"\r\n--{boundary}--\r\n".encode()
    query = urllib.parse.urlencode({"path": directory})
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=180)
    try:
        connection.putrequest("POST", "/upload?" + query)
        connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        connection.putheader("Content-Length", str(len(preamble) + book.stat().st_size + len(closing)))
        connection.endheaders()
        connection.send(preamble)
        with book.open("rb") as source:
            for chunk in iter(lambda: source.read(64 * 1024), b""):
                connection.send(chunk)
        connection.send(closing)
        response = connection.getresponse()
        result = response.read().decode("utf-8", "replace")
        if response.status != 200 or not result.startswith("File uploaded successfully:"):
            raise RuntimeError(f"Upload failed for {book.name}: HTTP {response.status} {result}")
    finally:
        connection.close()


def sync(args):
    root = args.library.resolve()
    if not root.is_dir():
        raise ValueError(f"Library folder does not exist: {root}")
    try:
        status = get_json(args.device, "/api/status", timeout=4)
    except (OSError, urllib.error.URLError, TimeoutError):
        print("XTEINK is not in File Transfer mode; will try again later.")
        return 0
    serial = status.get("serial")
    if serial != args.serial:
        raise ValueError(f"Unexpected device serial: {serial!r}; refusing to copy books")
    if status.get("mode") != "STA":
        raise ValueError("XTEINK is not on the joined network")

    files, dirs = device_inventory(args.device)
    state = load_state(args.state, serial)
    sources = list(source_books(root))
    if not sources:
        raise ValueError("Source library is empty; refusing to change the device")
    expected = {relative for relative, _ in sources}
    missing = set(state["books"]) - expected
    if len(missing) > args.max_deletions and not args.allow_large_delete:
        raise ValueError(f"{len(missing)} books disappeared from the source; "
                         "refusing a large deletion without --allow-large-delete")
    copied = moved = unchanged = deleted = 0
    for relative, book in sources:
        info = book.stat()
        destination = posixpath.join(DEST_ROOT, relative)
        record = state["books"].get(relative, {})
        recorded_path = record.get("device_path")
        known_same = (recorded_path == destination
                      and record.get("size") == info.st_size
                      and record.get("mtime_ns") == info.st_mtime_ns
                      and files.get(recorded_path) == info.st_size)
        if known_same:
            unchanged += 1
            continue

        local_hash = sha256_file(book)
        if (recorded_path != destination
                and isinstance(recorded_path, str)
                and files.get(recorded_path) == info.st_size
                and files.get(destination) is None
                and sha256_device_file(args.device, recorded_path) == local_hash):
            if args.dry_run:
                print(f"Would move into HonLib: {relative}")
                moved += 1
                continue
            move_file(args.device, files, dirs, recorded_path, destination, info.st_size)
            print(f"Moved into HonLib: {relative}", flush=True)
            moved += 1
            target = destination
        elif (record.get("sha256") == local_hash
                and files.get(destination) == info.st_size):
            target = destination
        else:
            target = None
            if (files.get(destination) == info.st_size
                    and sha256_device_file(args.device, destination) == local_hash):
                target = destination

        if target is None:
            if args.dry_run:
                print(f"Would copy: {relative}")
                copied += 1
                continue
            ensure_directory(args.device, dirs, posixpath.dirname(destination))
            upload(args.device, book, posixpath.dirname(destination))
            if not device_has_file(args.device, destination, info.st_size):
                raise RuntimeError(f"Device did not report the expected file size for {relative}")
            files[destination] = info.st_size
            target = destination
            copied += 1
            print(f"Copied: {relative}", flush=True)
        else:
            unchanged += 1

        if not args.dry_run:
            state["books"][relative] = {
                "device_path": target, "size": info.st_size,
                "mtime_ns": info.st_mtime_ns, "sha256": local_hash,
            }
            save_state(args.state, state)
        if args.limit and copied >= args.limit:
            break

    if not args.limit:
        for relative in sorted(missing):
            record = state["books"][relative]
            path = record.get("device_path")
            if not isinstance(path, str) or not path.startswith(DEST_ROOT + "/"):
                raise ValueError(f"Removed book was outside the managed folder: {relative}")
            if path in files:
                if (files[path] != record.get("size")
                        or sha256_device_file(args.device, path) != record.get("sha256")):
                    raise ValueError(f"Device book changed since sync; keeping {path}")
                if args.dry_run:
                    print(f"Would remove: {relative}")
                else:
                    delete_file(args.device, files, path)
                    print(f"Removed: {relative}", flush=True)
            if not args.dry_run:
                del state["books"][relative]
                save_state(args.state, state)
            deleted += 1
        if deleted and not args.dry_run:
            remove_empty_directories(args.device, dirs)

    print(f"Books checked: {len(sources)}; copied: {copied}; moved: {moved}; "
          f"removed: {deleted}; already present: {unchanged}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max-deletions", type=int, default=25)
    parser.add_argument("--allow-large-delete", action="store_true")
    args = parser.parse_args()
    try:
        return sync(args)
    except Exception as error:
        print(f"Sync failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
