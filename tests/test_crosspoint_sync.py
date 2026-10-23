import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import crosspoint_sync
import library
import progress
from tests.fixtures.make_split_chapter_epub import make_epub


class CrossPointSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.book_path = self.root / "Story.epub"
        make_epub(self.book_path)
        self.client = app.app.test_client()
        self.patches = [
            patch.object(app, "LIBRARY_FOLDER", str(self.root)),
            patch.object(app, "CROSSPOINT_SYNC_USERNAME", "reader"),
            patch.object(app, "CROSSPOINT_SYNC_PASSWORD", "sync-only-secret"),
            patch.object(progress, "PROGRESS_PATH", self.root / "progress.json"),
        ]
        for item in self.patches:
            item.start()
        self.headers = {
            "x-auth-user": "reader",
            "x-auth-key": hashlib.md5(b"sync-only-secret").hexdigest(),
        }

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_document_ids_match_crosspoint_methods(self):
        self.assertEqual(crosspoint_sync.filename_document_id("Story.epub"),
                         hashlib.md5(b"Story.epub").hexdigest())
        data = self.book_path.read_bytes()
        sampled = b"".join(data[offset:offset + 1024]
                           for offset in (0,) + tuple(1024 << (2 * i) for i in range(11))
                           if offset < len(data))
        self.assertEqual(crosspoint_sync.binary_document_id(self.book_path),
                         hashlib.md5(sampled).hexdigest())

    def test_cfi_maps_to_spine_and_paragraph(self):
        cfi = "epubcfi(/6/4[two]!/4/4/1:10)"
        self.assertEqual(crosspoint_sync.cfi_to_xpath(self.book_path, cfi),
                         "/body/DocFragment[2]/body/p[1]/text()[1].10")
        self.assertEqual(
            crosspoint_sync.xpath_to_cfi(self.book_path,
                                         "/body/DocFragment[2]/body/p[1]/text()[1].10"),
            "epubcfi(/6/4!/4/4/1:10)",
        )

    def test_device_fetches_honlib_progress(self):
        book = library.scan_library(self.root)[0]
        progress.update_book_progress(book["id"],
                                      cfi="epubcfi(/6/4[two]!/4/4/1:10)", percent=0.35)
        response = self.client.get("/syncs/progress/" + crosspoint_sync.binary_document_id(self.book_path),
                                   headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["progress"],
                         "/body/DocFragment[2]/body/p[1]/text()[1].10")
        self.assertEqual(response.json["percentage"], 0.35)
        self.assertGreater(response.json["timestamp"], 0)
        self.assertEqual(self.client.get("/users/auth", headers=self.headers).json,
                         {"authorized": "OK"})

    def test_wrong_credentials_do_not_expose_progress(self):
        document = crosspoint_sync.filename_document_id("Story.epub")
        self.assertEqual(self.client.get("/syncs/progress/" + document).status_code, 401)
        self.assertEqual(self.client.get("/users/auth").status_code, 401)

    def test_missing_progress_returns_empty_record(self):
        document = crosspoint_sync.filename_document_id("Story.epub")
        self.assertEqual(self.client.get("/syncs/progress/" + document,
                                         headers=self.headers).json, {})

    def test_device_upload_moves_honlib_progress(self):
        document = crosspoint_sync.binary_document_id(self.book_path)
        response = self.client.put("/syncs/progress", headers=self.headers, json={
            "document": document,
            "progress": "/body/DocFragment[2]/body/p[4]/text()[1].23",
            "percentage": 0.42,
            "device": "CrossPoint",
            "device_id": "crosspoint-reader",
        })
        self.assertEqual(response.status_code, 200)
        book = library.scan_library(self.root)[0]
        saved = progress.get_book_progress(book["id"])
        self.assertEqual(saved["cfi"], "epubcfi(/6/4!/4/10/1:23)")
        self.assertEqual(saved["percent"], 0.42)
        self.assertEqual(self.client.get("/api/progress").json["books"][book["id"]], saved)

    def test_chapter_only_upload_uses_percentage_without_old_cfi(self):
        book = library.scan_library(self.root)[0]
        progress.update_book_progress(book["id"], cfi="epubcfi(/6/2!/4/2/1:3)", percent=0.1)
        document = crosspoint_sync.filename_document_id("Story.epub")
        response = self.client.put("/syncs/progress", headers=self.headers, json={
            "document": document,
            "progress": "/body/DocFragment[2]/body",
            "percentage": 0.5,
        })
        self.assertEqual(response.status_code, 200)
        saved = progress.get_book_progress(book["id"])
        self.assertEqual(saved["cfi"], "")
        self.assertEqual(saved["percent"], 0.5)

    def test_unknown_or_unauthorized_upload_cannot_move_progress(self):
        payload = {"document": "0" * 32, "progress": "", "percentage": 0.9}
        self.assertEqual(self.client.put("/syncs/progress", json=payload).status_code, 401)
        self.assertEqual(self.client.put("/syncs/progress", headers=self.headers,
                                         json=payload).status_code, 404)
        self.assertEqual(progress.load_progress()["books"], {})


if __name__ == "__main__":
    unittest.main()
