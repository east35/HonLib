"""Build and serve the versioned Android web-shell bundle."""

import hashlib
import json
import os
import zipfile
from pathlib import Path

from flask import abort, jsonify, send_file


APP_ID = "honlib"
SCHEMA_VERSION = 1
MIN_SHELL_API_VERSION = 1
BUNDLE_DIR = Path(os.environ.get("HONLIB_APP_BUNDLE_DIR", "/app/app-bundle"))


def build_bundle(static_dir, output_dir):
    """Create a byte-for-byte reproducible ZIP and its canonical manifest."""
    static_dir = Path(static_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    temporary = output_dir / "bundle.zip.tmp"
    files = sorted(path for path in static_dir.rglob("*") if path.is_file())
    if not any(path.relative_to(static_dir).as_posix() == "index.html" for path in files):
        raise ValueError("web bundle requires static/index.html")

    uncompressed_size = 0
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            data = path.read_bytes()
            uncompressed_size += len(data)
            info = zipfile.ZipInfo(path.relative_to(static_dir).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

    data = temporary.read_bytes()
    version = hashlib.sha256(data).hexdigest()
    archive_path = output_dir / f"{version}.zip"
    temporary.replace(archive_path)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "appId": APP_ID,
        "bundleVersion": version,
        "archivePath": f"/api/app-bundle/{version}.zip",
        "sha256": version,
        "sizeBytes": len(data),
        "uncompressedSizeBytes": uncompressed_size,
        "minShellApiVersion": MIN_SHELL_API_VERSION,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return manifest


def register_routes(app):
    @app.get("/api/app-bundle/manifest")
    def app_bundle_manifest():
        try:
            manifest = json.loads((BUNDLE_DIR / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            abort(503)
        response = jsonify(manifest)
        response.headers["Cache-Control"] = "private, no-cache"
        return response

    @app.get("/api/app-bundle/<version>.zip")
    def app_bundle_archive(version):
        if len(version) != 64 or any(ch not in "0123456789abcdef" for ch in version):
            abort(404)
        try:
            manifest = json.loads((BUNDLE_DIR / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            abort(503)
        if version != manifest.get("bundleVersion"):
            abort(404)
        path = BUNDLE_DIR / f"{version}.zip"
        if not path.is_file():
            abort(503)
        response = send_file(path, mimetype="application/zip", conditional=True)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response
