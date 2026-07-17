import hashlib
import importlib
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

import web_bundle


class WebBundleBuildTests(unittest.TestCase):
    def test_build_is_deterministic_and_rooted_at_static_contents(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            static = root / "static"
            (static / "js").mkdir(parents=True)
            (static / "index.html").write_text("hello", encoding="utf-8")
            (static / "js" / "app.js").write_text("app", encoding="utf-8")
            first = web_bundle.build_bundle(static, root / "one")
            os.utime(static / "index.html", None)
            second = web_bundle.build_bundle(static, root / "two")

            self.assertEqual(first, second)
            first_zip = (root / "one" / f"{first['bundleVersion']}.zip").read_bytes()
            second_zip = (root / "two" / f"{second['bundleVersion']}.zip").read_bytes()
            self.assertEqual(first_zip, second_zip)
            self.assertEqual(hashlib.sha256(first_zip).hexdigest(), first["sha256"])
            with zipfile.ZipFile(root / "one" / f"{first['bundleVersion']}.zip") as archive:
                self.assertEqual(archive.namelist(), ["index.html", "js/app.js"])
            self.assertEqual(first["uncompressedSizeBytes"], 8)


class WebBundleRouteTests(unittest.TestCase):
    def setUp(self):
        self.bundle_temp = tempfile.TemporaryDirectory()
        self.config_temp = tempfile.TemporaryDirectory()
        os.environ["HONLIB_APP_BUNDLE_DIR"] = self.bundle_temp.name
        os.environ["EBOOK_LIB_CONFIG_DIR"] = self.config_temp.name
        os.environ["EBOOK_LIB_PASSWORD"] = "secret"
        import app
        self.bundle_module = importlib.reload(web_bundle)
        self.app_module = importlib.reload(app)
        self.manifest = self.bundle_module.build_bundle(
            Path(self.app_module.STATIC_DIR), Path(self.bundle_temp.name)
        )
        self.client = self.app_module.app.test_client()

    def tearDown(self):
        self.bundle_temp.cleanup()
        self.config_temp.cleanup()
        os.environ.pop("HONLIB_APP_BUNDLE_DIR", None)
        os.environ.pop("EBOOK_LIB_PASSWORD", None)

    def login(self):
        self.client.post("/login", data={"password": "secret"})

    def test_routes_require_authentication(self):
        with self.client.get("/api/app-bundle/manifest") as response:
            self.assertEqual(response.status_code, 401)
        with self.client.get(self.manifest["archivePath"]) as response:
            self.assertEqual(response.status_code, 401)

    def test_manifest_and_archive_contract_and_cache_headers(self):
        self.login()
        with self.client.get("/api/app-bundle/manifest") as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), self.manifest)
            self.assertEqual(response.headers["Cache-Control"], "private, no-cache")
        with self.client.get(self.manifest["archivePath"]) as archive:
            self.assertEqual(archive.status_code, 200)
            self.assertEqual(hashlib.sha256(archive.data).hexdigest(), self.manifest["sha256"])
            self.assertEqual(archive.headers["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertEqual(self.client.get("/api/app-bundle/" + "0" * 64 + ".zip").status_code, 404)


if __name__ == "__main__":
    unittest.main()
