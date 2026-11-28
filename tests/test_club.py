import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import app
import club
import library
import progress

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
from make_split_chapter_epub import make_epub  # noqa: E402

# The fixture's spine is one, two, two-continued, three; its contents list
# One, Two and Three. CFIs name a spine file by step 2 * (index + 1).
CFI_ONE, CFI_TWO, CFI_TWO_CONT, CFI_THREE = (f"epubcfi(/6/{2 * (i + 1)}!/4/2)" for i in range(4))


class ChapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "book.epub"
        make_epub(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_chapters_come_from_the_contents_list(self):
        chapters = library.book_chapters(self.path)["chapters"]
        self.assertEqual([c["label"] for c in chapters], ["One", "Two", "Three"])

    def test_a_split_chapter_stays_one_chapter(self):
        self.assertEqual(library.position_chapter(self.path, CFI_TWO), 1)
        self.assertEqual(library.position_chapter(self.path, CFI_TWO_CONT), 1)
        self.assertEqual(library.position_chapter(self.path, CFI_THREE), 2)

    def test_percent_is_used_when_there_is_no_cfi(self):
        self.assertEqual(library.position_chapter(self.path, "", 0.0), 0)
        self.assertEqual(library.position_chapter(self.path, "", 0.99), 2)

    def test_club_tag_survives_a_metadata_edit(self):
        library.write_club_id(self.path, "a" * 32)
        library.write_book_metadata(self.path, title="Renamed", series="Saga", series_index="2")
        self.assertEqual(library.read_club_id(self.path), "a" * 32)
        self.assertEqual(library.read_book_metadata(self.path)["title"], "Renamed")

    def test_club_tag_leaves_the_rest_of_the_metadata_alone(self):
        make_epub(self.path, series="Saga", series_index="2")
        library.write_club_id(self.path, "b" * 32)
        library.write_club_id(self.path, "c" * 32)
        meta = library.read_book_metadata(self.path)
        self.assertEqual((meta["series"], meta["series_index"], meta["club_id"]), ("Saga", "2", "c" * 32))

    def test_untagged_book_has_no_club_id(self):
        self.assertIsNone(library.read_club_id(self.path))


class TwoMemberTests(unittest.TestCase):
    """Two instances, simulated in one process by switching who 'we' are."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.club_dir = self.root / "club"
        self.dirs = {}
        for member in ("jim", "morgan"):
            base = self.root / member
            self.dirs[member] = {"books": base / "books", "staging": base / "staging", "progress": base / "progress.json"}
            self.dirs[member]["books"].mkdir(parents=True)
            self.dirs[member]["staging"].mkdir(parents=True)
        self.club_patch = patch.object(club, "CLUB_DIR", self.club_dir)
        self.club_patch.start()
        self.client = app.app.test_client()
        # Both instances have started once, which is what registers them.
        for member in ("jim", "morgan"):
            with self.as_member(member):
                app._club_publish()

    def tearDown(self):
        self.club_patch.stop()
        library.refresh_library(self.root)
        self.temp.cleanup()

    @contextmanager
    def as_member(self, member):
        d = self.dirs[member]
        patches = (
            patch.object(club, "MEMBER", member),
            patch.object(app, "LIBRARY_FOLDER", str(d["books"])),
            patch.object(app, "STAGING_FOLDER", str(d["staging"])),
            patch.object(progress, "PROGRESS_PATH", d["progress"]),
        )
        for p in patches:
            p.start()
        library.refresh_library(d["books"])
        try:
            yield d
        finally:
            for p in reversed(patches):
                p.stop()

    def stage(self, member, name="download.epub", **kwargs):
        path = self.dirs[member]["staging"] / name
        make_epub(path, **kwargs)
        return path

    def import_staged(self, filename, **extra):
        return self.client.post(
            "/api/staging/x/import",
            json={"filename": filename, "title": "Saga One", "series": "Saga", "series_index": "1", **extra},
        )

    def library_book(self, member):
        books = library.refresh_library(self.dirs[member]["books"])
        self.assertEqual(len(books), 1)
        return books[0]

    def test_book_club_import_gives_both_libraries_the_identical_file(self):
        self.stage("jim")
        with self.as_member("jim"):
            res = self.import_staged("download.epub", book_club=True)
            self.assertEqual(res.status_code, 200, res.get_json())
            self.assertEqual(res.get_json()["shared_with"], ["Morgan"])
            mine = self.library_book("jim")
        with self.as_member("morgan"):
            self.assertEqual(self.client.get("/api/library").status_code, 200)
            hers = self.library_book("morgan")
        self.assertTrue(mine["club_id"])
        self.assertEqual(mine["club_id"], hers["club_id"])
        self.assertEqual(mine["title"], "Saga One")
        jim_file = library.resolve_book_path(self.dirs["jim"]["books"], mine["path"]).read_bytes()
        morgan_file = library.resolve_book_path(self.dirs["morgan"]["books"], hers["path"]).read_bytes()
        self.assertEqual(jim_file, morgan_file)
        self.assertEqual(list((self.club_dir / "inbox" / "morgan").iterdir()), [])

    def test_plain_import_is_not_shared(self):
        self.stage("jim")
        with self.as_member("jim"):
            res = self.import_staged("download.epub")
            self.assertEqual(res.get_json()["shared_with"], [])
            self.assertIsNone(self.library_book("jim")["club_id"])
        self.assertFalse((self.club_dir / "inbox").exists())

    def test_book_club_import_needs_a_partner(self):
        (self.club_dir / "progress" / "morgan.json").unlink()
        path = self.stage("jim")
        with self.as_member("jim"):
            res = self.import_staged("download.epub", book_club=True)
        self.assertEqual(res.status_code, 400)
        self.assertTrue(path.exists(), "a refused import must leave the book in staging")

    def test_a_repeat_delivery_is_dropped(self):
        self.stage("jim")
        with self.as_member("jim"):
            self.import_staged("download.epub", book_club=True)
            mine = self.library_book("jim")
            club.share_book(library.resolve_book_path(self.dirs["jim"]["books"], mine["path"]))
        with self.as_member("morgan"):
            self.client.get("/api/library")
            self.client.get("/api/library")
            self.library_book("morgan")

    def test_both_places_are_shared(self):
        self.stage("jim")
        with self.as_member("jim"):
            self.import_staged("download.epub", book_club=True)
            mine = self.library_book("jim")
            self.client.post("/api/progress", json={"book_id": mine["id"], "cfi": CFI_THREE, "percent": 0.8})
        with self.as_member("morgan"):
            self.client.get("/api/library")
            hers = self.library_book("morgan")
            self.client.post("/api/progress", json={"book_id": hers["id"], "cfi": CFI_ONE, "percent": 0.1})
            state = self.client.get("/api/club").get_json()
        self.assertEqual(state["me"], "morgan")
        self.assertEqual(state["local"], {hers["club_id"]: hers["id"]})
        [saga] = state["clubs"]
        self.assertEqual(saga["name"], "Saga")
        self.assertEqual(saga["members"]["jim"]["books"][mine["club_id"]]["chapter_label"], "Three")
        self.assertEqual(saga["members"]["morgan"]["books"][hers["club_id"]]["chapter_label"], "One")
        self.assertEqual(saga["members"]["jim"]["position"], 2)
        self.assertEqual(saga["members"]["morgan"]["position"], 0)

    def test_positions_compare_across_books_of_a_series(self):
        self.stage("jim", "one.epub", identifier="urn:saga:1")
        self.stage("jim", "two.epub", identifier="urn:saga:2")
        with self.as_member("jim"):
            self.import_staged("one.epub", book_club=True)
            self.client.post("/api/staging/x/import", json={"filename": "two.epub", "title": "Saga Two", "series": "Saga", "series_index": "2", "book_club": True})
            books = {b["title"]: b for b in library.refresh_library(self.dirs["jim"]["books"])}
            self.client.post("/api/progress", json={"book_id": books["Saga One"]["id"], "cfi": CFI_THREE, "percent": 1.0})
            self.client.post("/api/progress", json={"book_id": books["Saga Two"]["id"], "cfi": CFI_TWO, "percent": 0.4})
        with self.as_member("morgan"):
            self.client.get("/api/library")
            [saga] = self.client.get("/api/club").get_json()["clubs"]
        self.assertEqual([b["title"] for b in saga["books"]], ["Saga One", "Saga Two"])
        # All three chapters of book one, then chapter Two (index 1) of book two.
        self.assertEqual(saga["members"]["jim"]["position"], 4)
        self.assertIsNone(saga["members"]["morgan"]["position"])


class DisabledTests(unittest.TestCase):
    def test_club_is_off_without_configuration(self):
        with patch.object(club, "CLUB_DIR", None):
            self.assertEqual(app.app.test_client().get("/api/club").get_json(), {"enabled": False})


if __name__ == "__main__":
    unittest.main()
