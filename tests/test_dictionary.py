import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import app


class DictionaryLookupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache_dir = Path(self.temp.name) / "dict-cache"
        self.patches = (
            patch.object(app, "AUTH_ENABLED", False),
            patch.object(app, "DICT_CACHE_DIR", self.cache_dir),
        )
        for item in self.patches:
            item.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self._stop_patches)
        self.client = app.app.test_client()

    def _stop_patches(self):
        for item in reversed(self.patches):
            item.stop()

    @staticmethod
    def response(status, payload=None):
        return SimpleNamespace(status_code=status, json=lambda: payload)

    def test_old_negative_cache_is_discarded_and_definition_is_cached(self):
        self.cache_dir.mkdir()
        (self.cache_dir / "hello.json").write_text(
            json.dumps({"word": "hello", "notFound": True}), encoding="utf-8"
        )
        entries = [{
            "language": {"code": "en", "name": "English"},
            "partOfSpeech": "interjection",
            "pronunciations": [{"type": "ipa", "text": "/hɛˈloʊ/"}],
            "senses": [{"definition": "A greeting."}],
        }]
        result = {
            "word": "hello",
            "entries": entries,
            "source": {"url": "https://en.wiktionary.org/wiki/hello"},
        }

        with patch.object(app.requests, "get", return_value=self.response(200, result)) as get:
            first = self.client.get("/api/dictionary/hello")
            second = self.client.get("/api/dictionary/hello")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["meanings"][0]["definitions"], ["A greeting."])
        self.assertEqual(first.get_json()["sourceUrl"], "https://en.wiktionary.org/wiki/hello")
        self.assertEqual(second.get_json(), first.get_json())
        get.assert_called_once()

    def test_legacy_provider_is_used_when_primary_is_unavailable(self):
        primary = self.response(503)
        fallback = self.response(200, [{
            "phonetic": "/hɛˈloʊ/",
            "meanings": [{
                "partOfSpeech": "exclamation",
                "definitions": [{"definition": "A greeting."}],
            }],
        }])

        with patch.object(app.requests, "get", side_effect=[primary, fallback]) as get:
            response = self.client.get("/api/dictionary/hello")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["meanings"][0]["definitions"], ["A greeting."])
        self.assertNotIn("sourceUrl", response.get_json())
        self.assertEqual(get.call_count, 2)

    def test_temporary_upstream_error_is_not_cached(self):
        with patch.object(app.requests, "get", side_effect=[self.response(503)] * 4) as get:
            first = self.client.get("/api/dictionary/hello")
            second = self.client.get("/api/dictionary/hello")

        self.assertEqual(first.status_code, 503)
        self.assertTrue(first.get_json()["unavailable"])
        self.assertEqual(second.status_code, 503)
        self.assertEqual(get.call_count, 4)
        self.assertFalse(self.cache_dir.exists())

    def test_not_found_response_is_cached_briefly(self):
        with patch.object(app.requests, "get", side_effect=[self.response(404)] * 2) as get:
            first = self.client.get("/api/dictionary/notaword")
            second = self.client.get("/api/dictionary/notaword")

        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.get_json()["notFound"])
        self.assertTrue(second.get_json()["notFound"])
        self.assertEqual(get.call_count, 2)
        self.assertTrue(self.cache_dir.joinpath("notaword.json").exists())


if __name__ == "__main__":
    unittest.main()
