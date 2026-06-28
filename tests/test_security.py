import os
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


_config_dir = tempfile.TemporaryDirectory()
os.environ["EBOOK_LIB_CONFIG_DIR"] = _config_dir.name

import app  # noqa: E402


class SecurityHeaderTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_csp_blocks_inline_and_blob_scripts(self):
        response = self.client.get("/")
        self.addCleanup(response.close)
        policy = response.headers["Content-Security-Policy"]

        self.assertIn("script-src 'self'", policy)
        self.assertNotIn("'unsafe-inline'", policy.split("script-src", 1)[1].split(";", 1)[0])
        self.assertNotIn("blob:", policy.split("script-src", 1)[1].split(";", 1)[0])

    def test_security_headers_cover_api_responses(self):
        response = self.client.get("/api/features")
        self.addCleanup(response.close)

        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
        self.assertIn("camera=()", response.headers["Permissions-Policy"])

    def test_app_shell_has_no_executable_inline_script(self):
        html = (Path(app.STATIC_DIR) / "index.html").read_text(encoding="utf-8")

        self.assertIsNone(re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html, re.I))
        self.assertIn('<script src="theme.js"></script>', html)


class OptionalPluginTests(unittest.TestCase):
    def test_empty_submodule_directory_is_not_treated_as_plugin(self):
        self.assertFalse(app._valid_irc_plugin(SimpleNamespace()))

    def test_complete_client_contract_is_accepted(self):
        client = SimpleNamespace(
            status=lambda: {},
            search=lambda *args, **kwargs: [],
            download=lambda *args, **kwargs: None,
            start_background=lambda: None,
        )

        self.assertTrue(app._valid_irc_plugin(SimpleNamespace(client=client)))


if __name__ == "__main__":
    unittest.main()
