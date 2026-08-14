import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import library
import progress


class DeleteBookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.books = self.root / "books"
        self.staging = self.root / "staging"
        self.config = self.root / "config"
        self.books.mkdir()
        self.staging.mkdir()
        self.progress_path = self.config / "progress.json"
        self.patches = (
            patch.object(app, "LIBRARY_FOLDER", str(self.books)),
            patch.object(app, "STAGING_FOLDER", str(self.staging)),
            patch.object(progress, "PROGRESS_PATH", self.progress_path),
        )
        for item in self.patches:
            item.start()
        self.client = app.app.test_client()
        library.refresh_library(self.books)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def add_book(self, relative_path):
        path = self.books / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        # Scanning intentionally tolerates malformed downloads, which are one
        # of the primary reasons users need this deletion path.
        path.write_bytes(b"wrong ebook download")
        return path

    def test_delete_removes_library_file_and_reader_state_without_using_staging(self):
        doomed = self.add_book("Series/Wrong Edition.epub")
        keeper = self.add_book("Series/Right Edition.epub")
        book_id = library.book_id_for_relpath("Series/Wrong Edition.epub")
        progress.update_book_progress(book_id, cfi="epubcfi(/6/2)", percent=0.4)
        progress.update_bookmark(book_id, cfi="epubcfi(/6/4)", add=True)
        before_staging = list(self.staging.iterdir())
        library.refresh_library(self.books)

        response = self.client.post(f"/api/book/{book_id}/delete", json={})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(doomed.exists())
        self.assertTrue(keeper.exists())
        self.assertEqual(list(self.staging.iterdir()), before_staging)
        self.assertNotIn(book_id, progress.load_progress()["books"])
        self.assertNotIn(book_id, progress.load_progress()["bookmarks"])
        self.assertEqual(
            [book["title"] for book in response.get_json()["books"]],
            ["Right Edition"],
        )

    def test_delete_requires_json_and_leaves_book_in_place(self):
        path = self.add_book("Keep Me.epub")
        book_id = library.book_id_for_relpath("Keep Me.epub")
        library.refresh_library(self.books)

        response = self.client.post(f"/api/book/{book_id}/delete")

        self.assertEqual(response.status_code, 415)
        self.assertTrue(path.exists())

    def test_unknown_book_does_not_delete_anything(self):
        path = self.add_book("Keep Me.epub")
        library.refresh_library(self.books)

        response = self.client.post("/api/book/not-a-book/delete", json={})

        self.assertEqual(response.status_code, 404)
        self.assertTrue(path.exists())
        self.assertEqual(list(self.staging.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
