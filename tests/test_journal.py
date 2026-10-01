import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import app
import journal
import library

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
from make_split_chapter_epub import make_epub  # noqa: E402


def passage(doc_id="11111111-1111-4111-8111-111111111111", updated="2026-10-01T10:00:00.000Z", **extra):
    doc = {
        "v": 1,
        "id": doc_id,
        "created": "2026-10-01T10:00:00.000Z",
        "updated": updated,
        "device": "device-a",
        "deleted": False,
        "text": "In a hole in the ground there lived a hobbit.",
        "context": {"before": "", "after": ""},
        "note": "",
        "tags": [],
        "style": {"highlight": "yellow", "underline": None},
        "journals": [],
        "source": {
            "book_key": "id:hobbit",
            "book_id": "abc",
            "title": "The Hobbit",
            "author": "J. R. R. Tolkien",
            "series": "Middle-earth",
            "series_index": 1,
            "chapter": "An Unexpected Party",
            "cfi": "epubcfi(/6/4!/4/2,/1:0,/1:44)",
            "percent": 0.02,
        },
    }
    doc.update(extra)
    return doc


def a_journal(doc_id="22222222-2222-4222-8222-222222222222", updated="2026-10-01T10:00:00.000Z", **extra):
    doc = {
        "v": 1,
        "id": doc_id,
        "created": "2026-10-01T10:00:00.000Z",
        "updated": updated,
        "device": "device-a",
        "deleted": False,
        "name": "Middle-earth",
        "cover": None,
        "sources": [{"type": "book", "book_key": "id:hobbit", "enabled": True}],
    }
    doc.update(extra)
    return doc


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "journal"
        self.index = Path(self.temp.name) / "config" / "journal-index.sqlite"
        self.store = journal.JournalStore(self.root, self.index)

    def tearDown(self):
        self.temp.cleanup()

    def file(self, kind, doc_id):
        return self.root / kind / f"{doc_id}.json"


class LastWriterWinsTests(StoreTestCase):
    def test_a_write_is_one_file_and_an_older_write_cannot_replace_it(self):
        applied, stored = self.store.put("passages", passage(note="first"))
        self.assertTrue(applied)
        on_disk = json.loads(self.file("passages", stored["id"]).read_text("utf-8"))
        self.assertEqual(on_disk["note"], "first")

        applied, stored = self.store.put(
            "passages", passage(updated="2026-10-01T09:00:00.000Z", note="stale")
        )

        self.assertFalse(applied)
        self.assertEqual(stored["note"], "first")
        self.assertEqual(self.store.get("passages", stored["id"])["note"], "first")

    def test_a_newer_write_replaces_and_a_repeat_is_a_no_op(self):
        self.store.put("passages", passage(note="first"))
        newer = passage(updated="2026-10-01T11:00:00.000Z", note="second", device="device-b")

        self.assertTrue(self.store.put("passages", newer)[0])
        self.assertFalse(self.store.put("passages", newer)[0])
        self.assertEqual(self.store.get("passages", newer["id"])["note"], "second")

    def test_an_exact_tie_settles_the_same_way_whichever_write_lands_first(self):
        one = passage(device="device-a", note="from a")
        two = passage(device="device-b", note="from b")
        other = journal.JournalStore(Path(self.temp.name) / "other", Path(self.temp.name) / "other.sqlite")

        self.store.put("passages", one)
        self.store.put("passages", two)
        other.put("passages", two)
        other.put("passages", one)

        self.assertEqual(self.store.get("passages", one["id"])["note"], "from b")
        self.assertEqual(other.get("passages", one["id"])["note"], "from b")

    def test_two_devices_changing_different_passages_keep_both(self):
        first = passage()
        second = passage("33333333-3333-4333-8333-333333333333", device="device-b")

        self.store.put("passages", first)
        self.store.put("passages", second)

        self.assertEqual(len(self.store.all("passages")), 2)

    def test_a_delete_is_a_marker_not_a_missing_file(self):
        self.store.put("passages", passage())
        marker = {
            "v": 1, "id": passage()["id"], "updated": "2026-10-01T12:00:00.000Z",
            "device": "device-a", "deleted": True,
        }

        self.assertTrue(self.store.put("passages", marker)[0])

        self.assertTrue(self.file("passages", marker["id"]).is_file())
        self.assertEqual(self.store.all("passages"), [])
        self.assertTrue(self.store.changes()["passages"][0]["deleted"])
        # A device that was offline during the delete cannot bring it back.
        self.assertFalse(self.store.put("passages", passage(note="edited offline"))[0])

    def test_unknown_fields_survive_for_newer_clients(self):
        self.store.put("passages", passage(v=2, future={"x": 1}))

        self.assertEqual(self.store.get("passages", passage()["id"])["future"], {"x": 1})


class ValidationTests(StoreTestCase):
    def test_ids_that_could_form_a_path_are_refused(self):
        for bad in ("../../etc/passwd", "a/b", "short", "", ".hidden-file", "x" * 80):
            with self.assertRaises(journal.InvalidDocument, msg=bad):
                self.store.put("passages", passage(bad))
        self.assertFalse(self.root.exists())

    def test_malformed_documents_are_refused(self):
        cases = [
            passage(updated="yesterday"),
            passage(updated=None),
            passage(tags="gandalf"),
            passage(tags=[1]),
            passage(text=5),
            passage(style=[]),
            passage(deleted="yes"),
            passage(note="x" * (journal.MAX_DOC_BYTES + 1)),
            ["not", "an", "object"],
        ]
        for doc in cases:
            with self.assertRaises(journal.InvalidDocument):
                self.store.put("passages", doc)
        with self.assertRaises(journal.InvalidDocument):
            self.store.put("journals", a_journal(sources=["hobbit"]))
        with self.assertRaises(journal.InvalidDocument):
            self.store.put("bookmarks", passage())


class ChangeFeedTests(StoreTestCase):
    def test_a_cursor_returns_only_what_changed_after_it(self):
        self.store.put("journals", a_journal())
        self.store.put("passages", passage())
        first = self.store.changes()
        self.assertTrue(first["full"])
        self.assertEqual((len(first["journals"]), len(first["passages"])), (1, 1))

        quiet = self.store.changes(first["cursor"])
        self.assertFalse(quiet["full"])
        self.assertEqual((quiet["journals"], quiet["passages"]), ([], []))
        self.assertEqual(quiet["cursor"], first["cursor"])

        self.store.put("passages", passage(updated="2026-10-01T11:00:00.000Z", note="edited"))
        later = self.store.changes(first["cursor"])
        self.assertEqual([p["note"] for p in later["passages"]], ["edited"])
        self.assertEqual(later["journals"], [])

    def test_the_index_is_disposable_and_rebuilt_from_the_files(self):
        self.store.put("journals", a_journal())
        self.store.put("passages", passage(note="kept"))
        cursor = self.store.changes()["cursor"]

        self.index.unlink()
        rebuilt = self.store.changes(cursor)

        # The old cursor belongs to an index that no longer exists, so the
        # client is told to take everything again rather than miss a change.
        self.assertTrue(rebuilt["full"])
        self.assertNotEqual(rebuilt["cursor"], cursor)
        self.assertEqual([p["note"] for p in rebuilt["passages"]], ["kept"])
        self.assertEqual(len(rebuilt["journals"]), 1)

    def test_a_corrupt_index_is_replaced(self):
        self.store.put("passages", passage())
        self.index.write_bytes(b"this is not a database")

        self.assertEqual(len(self.store.changes()["passages"]), 1)

    def test_a_nonsense_cursor_gets_everything(self):
        self.store.put("passages", passage())

        for cursor in ("", "nope", "abc-12", f"{self.store.changes()['cursor'].split('-')[0]}-x"):
            self.assertTrue(self.store.changes(cursor)["full"], cursor)


class SyncedFolderTests(StoreTestCase):
    """A second route in: files written to the folder by something else."""

    def drop(self, kind, doc, name=None):
        path = self.root / kind / (name or f"{doc['id']}.json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc), encoding="utf-8")
        return path

    def test_files_that_appear_or_change_are_picked_up(self):
        cursor = self.store.changes()["cursor"]
        self.drop("passages", passage(note="arrived by folder sync"))
        self.store.refresh(force=True)

        arrived = self.store.changes(cursor)
        self.assertEqual([p["note"] for p in arrived["passages"]], ["arrived by folder sync"])

        self.drop("passages", passage(updated="2026-10-01T11:00:00.000Z", note="changed on another device"))
        self.store.refresh(force=True)

        changed = self.store.changes(arrived["cursor"])
        self.assertEqual([p["note"] for p in changed["passages"]], ["changed on another device"])

    def test_an_older_write_cannot_beat_a_file_the_index_has_not_seen_yet(self):
        self.store.put("passages", passage(note="original"))
        # Lands between two walks of the folder.
        self.drop("passages", passage(updated="2026-10-01T12:00:00.000Z", note="synced in"))

        applied, stored = self.store.put(
            "passages", passage(updated="2026-10-01T11:00:00.000Z", note="older api write")
        )

        self.assertFalse(applied)
        self.assertEqual(stored["note"], "synced in")

    def test_a_conflict_copy_is_never_its_own_passage_and_the_newer_side_wins(self):
        self.store.put("passages", passage(note="kept on this side"))
        doc_id = passage()["id"]
        self.drop(
            "passages",
            passage(updated="2026-10-01T12:00:00.000Z", note="newer on the other side"),
            name=f"{doc_id}.sync-conflict-20261001-120000-ABCDEFG.json",
        )
        self.store.refresh(force=True)

        self.assertEqual([p["note"] for p in self.store.all("passages")], ["newer on the other side"])

    def test_an_older_conflict_copy_changes_nothing(self):
        self.store.put("passages", passage(updated="2026-10-01T12:00:00.000Z", note="newest"))
        doc_id = passage()["id"]
        self.drop(
            "passages",
            passage(updated="2026-10-01T09:00:00.000Z", note="older"),
            name=f"{doc_id}.sync-conflict-20261001-090000-ABCDEFG.json",
        )
        self.store.refresh(force=True)

        self.assertEqual([p["note"] for p in self.store.all("passages")], ["newest"])

    def test_unreadable_and_stray_files_are_ignored(self):
        self.drop("passages", passage())
        (self.root / "passages" / "44444444-4444-4444-8444-444444444444.json").write_text("{half", "utf-8")
        (self.root / "passages" / "notes.txt").write_text("not ours", "utf-8")
        # A document filed under a name that is not its own id is not trusted.
        self.drop("passages", passage("55555555-5555-4555-8555-555555555555"),
                  name="66666666-6666-4666-8666-666666666666.json")
        self.store.refresh(force=True)

        self.assertEqual([p["id"] for p in self.store.all("passages")], [passage()["id"]])


class SearchTests(StoreTestCase):
    def test_search_matches_every_word_across_text_note_tags_and_source(self):
        self.store.put("passages", passage(tags=["Gandalf"], note="the opening line"))
        self.store.put("passages", passage(
            "33333333-3333-4333-8333-333333333333",
            text="All we have to decide is what to do with the time that is given us.",
            journals=["22222222-2222-4222-8222-222222222222"],
            created="2026-10-02T10:00:00.000Z",
        ))

        self.assertEqual(len(self.store.search("")), 2)
        self.assertEqual([p["id"] for p in self.store.search("hobbit HOLE")], [passage()["id"]])
        self.assertEqual(len(self.store.search("gandalf")), 1)
        self.assertEqual(len(self.store.search("opening")), 1)
        self.assertEqual(len(self.store.search("tolkien")), 2)
        self.assertEqual(self.store.search("hobbit dragon"), [])
        self.assertEqual(len(self.store.search("", tag="gandalf")), 1)
        self.assertEqual(
            [p["id"] for p in self.store.search("", journal="22222222-2222-4222-8222-222222222222")],
            ["33333333-3333-4333-8333-333333333333"],
        )
        # Newest first.
        self.assertEqual(self.store.search("")[0]["id"], "33333333-3333-4333-8333-333333333333")

    def test_deleted_passages_are_not_found(self):
        self.store.put("passages", passage())
        self.store.put("passages", {
            "v": 1, "id": passage()["id"], "updated": "2026-10-01T12:00:00.000Z",
            "device": "device-a", "deleted": True,
        })

        self.assertEqual(self.store.search("hobbit"), [])


class SourceTests(unittest.TestCase):
    hobbit = {"key": "id:hobbit", "title": "The Hobbit", "author": "J. R. R. Tolkien",
              "series": "Middle-earth", "group": "Middle-earth"}
    loose = {"key": "id:roverandom", "title": "Roverandom", "author": "J. R. R. Tolkien",
             "series": None, "group": "J. R. R. Tolkien"}
    shelved = {"key": "id:fellowship", "title": "The Fellowship of the Ring", "author": "J. R. R. Tolkien",
               "series": None, "group": "The Lord of the Rings"}

    def covers(self, source, book):
        return journal.journal_covers({"sources": [source]}, book)

    def test_a_book_source_covers_only_that_book(self):
        source = {"type": "book", "book_key": "id:hobbit", "enabled": True}

        self.assertTrue(self.covers(source, self.hobbit))
        self.assertFalse(self.covers(source, self.loose))

    def test_series_and_author_sources_ignore_case_and_a_leading_the(self):
        self.assertTrue(self.covers({"type": "series", "name": "middle-earth", "enabled": True}, self.hobbit))
        self.assertTrue(self.covers({"type": "author", "name": "j. r. r. tolkien", "enabled": True}, self.loose))
        self.assertTrue(self.covers({"type": "series", "name": "Lord of the Rings, The", "enabled": True}, self.shelved))

    def test_a_folder_counts_as_a_series_unless_it_is_just_the_author(self):
        self.assertEqual(journal.book_series(self.shelved), "The Lord of the Rings")
        self.assertEqual(journal.book_series(self.loose), "")

    def test_a_source_that_is_off_covers_nothing(self):
        self.assertFalse(self.covers({"type": "book", "book_key": "id:hobbit", "enabled": False}, self.hobbit))


class ExportTests(unittest.TestCase):
    def test_markdown_has_a_heading_per_book_and_everything_about_each_passage(self):
        j = a_journal()
        passages = [
            passage(note="Where it all starts.", tags=["openings", "bilbo"],
                    style={"highlight": "green", "underline": "dashed"}, journals=[j["id"]]),
            passage("33333333-3333-4333-8333-333333333333", journals=[j["id"]],
                    text="Not all those who wander are lost.",
                    style={"highlight": None, "underline": "wavy"},
                    source={"book_key": "id:fellowship", "title": "The Fellowship of the Ring",
                            "author": "J. R. R. Tolkien", "series": "Middle-earth", "series_index": 2,
                            "chapter": "Strider", "percent": 0.4}),
            passage("44444444-4444-4444-8444-444444444444", journals=[j["id"]],
                    text="A book that has gone.",
                    source={"book_key": "id:gone", "title": "Lost Tales", "author": "J. R. R. Tolkien"}),
            passage("55555555-5555-4555-8555-555555555555", journals=[], text="Filed nowhere."),
            passage("66666666-6666-4666-8666-666666666666", journals=[j["id"]], deleted=True, text="Deleted."),
        ]
        books = [
            {"key": "id:hobbit", "title": "The Hobbit", "author": "J. R. R. Tolkien", "series": "Middle-earth"},
            {"key": "id:fellowship", "title": "The Fellowship of the Ring", "author": "J. R. R. Tolkien",
             "series": "Middle-earth"},
        ]

        text = journal.render_markdown(j, passages, books)

        self.assertTrue(text.startswith("# Middle-earth\n"))
        self.assertIn("3 passages from 3 books.", text)
        self.assertIn("## The Hobbit — J. R. R. Tolkien", text)
        self.assertIn("> In a hole in the ground there lived a hobbit.", text)
        self.assertIn("**Note:** Where it all starts.", text)
        self.assertIn(
            "Chapter: An Unexpected Party · Green highlight, Dashed underline · Tags: openings, bilbo", text
        )
        # In the library, but this journal only enables The Hobbit.
        self.assertIn("Chapter: Strider · Wavy underline · Status: Source off", text)
        self.assertIn("Status: Book missing", text)
        self.assertNotIn("Filed nowhere.", text)
        self.assertNotIn("Deleted.", text)
        self.assertLess(text.index("## The Hobbit"), text.index("## The Fellowship of the Ring"))


class JournalApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.books = root / "books"
        self.books.mkdir()
        self.store = journal.JournalStore(root / "journal", root / "config" / "journal-index.sqlite")
        self.patches = (
            patch.object(journal, "store", self.store),
            patch.object(app, "LIBRARY_FOLDER", str(self.books)),
        )
        for item in self.patches:
            item.start()
        library.refresh_library(self.books)
        self.client = app.app.test_client()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_a_write_is_stored_and_comes_back_in_the_feed(self):
        doc = passage()

        saved = self.client.post(f"/api/journal/passages/{doc['id']}", json=doc)
        feed = self.client.get("/api/journal/sync").get_json()

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.get_json()["applied"], True)
        self.assertEqual(feed["passages"], [doc])
        again = self.client.get(f"/api/journal/sync?since={feed['cursor']}").get_json()
        self.assertEqual((again["full"], again["passages"]), (False, []))

    def test_a_losing_write_is_told_which_version_won(self):
        self.client.post(f"/api/journal/passages/{passage()['id']}", json=passage(note="newer", updated="2026-10-01T12:00:00.000Z"))

        lost = self.client.post(f"/api/journal/passages/{passage()['id']}", json=passage(note="older"))

        self.assertEqual(lost.status_code, 200)
        self.assertEqual(lost.get_json()["applied"], False)
        self.assertEqual(lost.get_json()["doc"]["note"], "newer")

    def test_writes_must_be_json_for_a_known_kind_and_match_their_address(self):
        doc = passage()
        url = f"/api/journal/passages/{doc['id']}"

        self.assertEqual(self.client.post(url, data={"id": doc["id"]}).status_code, 415)
        self.assertEqual(self.client.post("/api/journal/passages/99999999-9999-4999-8999-999999999999", json=doc).status_code, 400)
        self.assertEqual(self.client.post(url, json=passage(updated="soon")).status_code, 400)
        self.assertEqual(self.client.post(f"/api/journal/bookmarks/{doc['id']}", json=doc).status_code, 404)
        self.assertEqual(self.client.get("/api/journal/sync").get_json()["passages"], [])

    def test_search_endpoint(self):
        self.client.post(f"/api/journal/passages/{passage()['id']}", json=passage())

        self.assertEqual(len(self.client.get("/api/journal/search?q=hobbit").get_json()["passages"]), 1)
        self.assertEqual(self.client.get("/api/journal/search?q=dragon").get_json()["passages"], [])

    def test_export_downloads_markdown_named_after_the_journal(self):
        j = a_journal(name="Middle-earth: notes")
        self.client.post(f"/api/journal/journals/{j['id']}", json=j)
        self.client.post(f"/api/journal/passages/{passage()['id']}", json=passage(journals=[j["id"]]))

        response = self.client.get(f"/api/journal/journals/{j['id']}/export.md")
        self.addCleanup(response.close)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["Content-Type"].startswith("text/markdown"))
        self.assertIn("Middle-earth notes.md", response.headers["Content-Disposition"])
        self.assertIn("> In a hole in the ground there lived a hobbit.", response.get_data(as_text=True))
        self.assertEqual(self.client.get("/api/journal/journals/nope/export.md").status_code, 404)
        self.assertEqual(
            self.client.get("/api/journal/journals/77777777-7777-4777-8777-777777777777/export.md").status_code, 404
        )


class BookKeyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.books = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def scan(self):
        return {book["path"]: book for book in library.refresh_library(self.books)}

    def test_the_key_is_the_epub_identifier_and_survives_a_move(self):
        make_epub(self.books / "split.epub")
        before = self.scan()["split.epub"]

        (self.books / "Shelf").mkdir()
        (self.books / "split.epub").rename(self.books / "Shelf" / "renamed.epub")
        after = self.scan()["Shelf/renamed.epub"]

        self.assertEqual(before["key"], "id:urn:uuid:honlib-split-chapter-test")
        self.assertEqual(after["key"], before["key"])
        self.assertNotEqual(after["id"], before["id"])

    def test_the_key_is_the_declared_unique_identifier_not_just_the_first(self):
        make_epub(self.books / "split.epub")
        path = self.books / "split.epub"
        # An ISBN listed ahead of the identifier the package names as its own.
        with zipfile.ZipFile(path) as src:
            members = {name: src.read(name) for name in src.namelist()}
        opf = members["EPUB/package.opf"].decode("utf-8").replace(
            '<dc:identifier id="book-id">',
            '<dc:identifier id="isbn">urn:isbn:9780000000000</dc:identifier>\n    <dc:identifier id="book-id">',
        )
        with zipfile.ZipFile(path, "w") as dst:
            for name, data in members.items():
                dst.writestr(name, opf if name == "EPUB/package.opf" else data)

        self.assertEqual(self.scan()["split.epub"]["key"], "id:urn:uuid:honlib-split-chapter-test")

    def test_a_book_with_no_identifier_falls_back_to_title_and_author(self):
        (self.books / "Some  Title.epub").write_bytes(b"not really an epub")

        self.assertEqual(self.scan()["Some  Title.epub"]["key"], "ta:some title|unknown author")


if __name__ == "__main__":
    unittest.main()
