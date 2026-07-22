import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import progress


class ReadingProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path_patch = patch.object(
            progress, "PROGRESS_PATH", Path(self.temp.name) / "progress.json"
        )
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.temp.cleanup()

    def test_each_page_write_gets_a_new_conflict_token(self):
        first = progress.update_book_progress(
            "book-1", cfi="epubcfi(/page-1)", percent=0.1
        )["entry"]
        second = progress.update_book_progress(
            "book-1", cfi="epubcfi(/page-2)", percent=0.2,
            base=first["last_opened"],
        )["entry"]

        self.assertGreater(second["last_opened"], first["last_opened"])
        self.assertEqual(second["cfi"], "epubcfi(/page-2)")

    def test_previous_page_token_cannot_overwrite_newer_page(self):
        first = progress.update_book_progress(
            "book-1", cfi="epubcfi(/page-1)", percent=0.1
        )["entry"]
        second = progress.update_book_progress(
            "book-1", cfi="epubcfi(/page-2)", percent=0.2,
            base=first["last_opened"],
        )["entry"]

        stale = progress.update_book_progress(
            "book-1", cfi="epubcfi(/page-1)", percent=0.1,
            base=first["last_opened"],
        )

        self.assertTrue(stale["stale"])
        self.assertEqual(stale["entry"], second)

    def test_legacy_second_token_compares_correctly_with_microseconds(self):
        self.assertTrue(progress._is_older(
            "2026-07-22T12:00:00Z", "2026-07-22T12:00:00.123456Z"
        ))


if __name__ == "__main__":
    unittest.main()
