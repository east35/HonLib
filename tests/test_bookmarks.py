import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import progress


class BookmarkPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "progress.json"
        self.path_patch = patch.object(progress, "PROGRESS_PATH", self.path)
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.temp.cleanup()

    def test_add_is_idempotent_and_remove_preserves_reading_progress(self):
        progress.update_book_progress("book-1", cfi="epubcfi(/old)", percent=0.2)
        first = progress.update_bookmark(
            "book-1", cfi="epubcfi(/page)", add=True, percent=0.45, label="Chapter 4"
        )
        second = progress.update_bookmark(
            "book-1", cfi="epubcfi(/page)", add=True, percent=0.46, label="Chapter 4"
        )

        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 1)
        self.assertEqual(second[0]["percent"], 0.46)
        self.assertEqual(second[0]["label"], "Chapter 4")

        self.assertEqual(
            progress.update_bookmark("book-1", cfi="epubcfi(/page)", add=False), []
        )
        self.assertEqual(progress.load_progress()["books"]["book-1"]["cfi"], "epubcfi(/old)")

    def test_old_progress_files_gain_an_empty_bookmark_map(self):
        self.path.write_text('{"books":{"book-1":{"percent":0.1}}}', encoding="utf-8")

        self.assertEqual(progress.load_progress()["bookmarks"], {})

    def test_api_adds_and_removes_a_bookmark(self):
        client = app.app.test_client()
        add = client.post("/api/bookmarks", json={
            "book_id": "book-1",
            "cfi": "epubcfi(/page)",
            "bookmarked": True,
            "percent": 0.5,
            "label": "A long chapter",
        })
        remove = client.post("/api/bookmarks", json={
            "book_id": "book-1",
            "cfi": "epubcfi(/page)",
            "bookmarked": False,
        })

        self.assertEqual(add.status_code, 200)
        self.assertEqual(add.get_json()["bookmarks"][0]["label"], "A long chapter")
        self.assertEqual(remove.status_code, 200)
        self.assertEqual(remove.get_json()["bookmarks"], [])

    def test_api_requires_a_book_and_position(self):
        client = app.app.test_client()

        self.assertEqual(client.post("/api/bookmarks", json={}).status_code, 400)
        self.assertEqual(
            client.post("/api/bookmarks", json={"book_id": "book-1"}).status_code, 400
        )


if __name__ == "__main__":
    unittest.main()
