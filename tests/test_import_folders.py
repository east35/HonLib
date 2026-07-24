import tempfile
import unittest
from pathlib import Path

import app


class FolderKeyTests(unittest.TestCase):
    def test_case_and_leading_the_do_not_make_a_new_series(self):
        key = app._folder_key("The Dark Tower")
        self.assertEqual(key, app._folder_key("dark tower"))
        self.assertEqual(key, app._folder_key("Dark Tower"))
        self.assertEqual(key, app._folder_key("Dark Tower, The"))
        self.assertEqual(key, app._folder_key("  the   dark   tower  "))

    def test_distinct_series_keep_distinct_keys(self):
        self.assertNotEqual(app._folder_key("Discworld"), app._folder_key("Dark Tower"))
        self.assertNotEqual(app._folder_key("Dune"), app._folder_key("Dune Messiah"))


class LibraryDirTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_reuses_an_existing_folder_spelled_differently(self):
        existing = self.root / "dark tower"
        existing.mkdir()
        self.assertEqual(app._library_dir_for(self.root, "The Dark Tower"), existing)

    def test_creates_a_new_folder_when_nothing_matches(self):
        (self.root / "Discworld").mkdir()
        self.assertEqual(
            app._library_dir_for(self.root, "Dark Tower"), self.root / "Dark Tower"
        )

    def test_existing_folders_are_never_renamed(self):
        existing = self.root / "dark tower"
        existing.mkdir()
        app._library_dir_for(self.root, "The Dark Tower")
        self.assertEqual([p.name for p in self.root.iterdir()], ["dark tower"])

    def test_a_library_that_already_holds_a_split_picks_one_side_consistently(self):
        (self.root / "dark tower").mkdir()
        (self.root / "The Dark Tower").mkdir()
        first = app._library_dir_for(self.root, "Dark Tower")
        second = app._library_dir_for(self.root, "the dark tower")
        self.assertEqual(first, second)

    def test_files_are_not_mistaken_for_folders(self):
        (self.root / "Dark Tower").write_text("not a folder")
        self.assertEqual(
            app._library_dir_for(self.root, "Dark Tower"), self.root / "Dark Tower"
        )

    def test_author_folders_are_resolved_the_same_way(self):
        existing = self.root / "stephen king"
        existing.mkdir()
        self.assertEqual(app._library_dir_for(self.root, "Stephen King"), existing)


if __name__ == "__main__":
    unittest.main()
