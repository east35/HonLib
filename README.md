![HonLib logo](static/img/honlib-logo.png)

# HonLib

A self-hosted ebook library and reader you run with Docker. Browse your epub
collection in the browser, read in a clean paginated reader
([foliate-js](https://github.com/johnfactotum/foliate-js)) with themes, fonts,
tap-to-define dictionary lookup, bookmarks, highlights collected into journals,
and progress that syncs across devices.

Licensed [AGPL-3.0](LICENSE).

Dictionary entries are sourced from Wiktionary via [FreeDictionaryAPI.com](https://freedictionaryapi.com/)
under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The reader links each entry to its Wiktionary source.

## Why HonLib

I wanted off the Kindle ecosystem — no proprietary formats, no vendor lock-in,
just my books, accessible from any device.

I tried KOReader first. It's powerful, but it's built for people who want to
tune every setting. I just wanted to read. So HonLib is the opposite bet: a
simple, self-hosted library and reader that works the same everywhere.

HonLib doesn't sync your books — that's not its job. Point it at a local
folder and it reads from disk; keeping that folder up to date is whatever
syncing tool you already use (Syncthing, Dropbox, a NAS share, whatever).
HonLib just notices when the files are there. What it does carry between
devices is what you do with the books: your place, your bookmarks, and your
highlights and journals. The companion
[Android reader](https://github.com/east35/lib-sdk) takes the same posture on
the device side: read from local storage if the file is present, fall back to
the server otherwise.

### Typography, not settings

I don't want to dial in font sizes, line heights, or margins by hand — and I
don't think you should have to either. Instead of a settings panel full of
sliders and numeric inputs, HonLib gives you a simple **+ / −** to bump text
size up or down, and handles everything else for you based on a few fixed
typographic principles:

- **45–75 characters per line** — the established readable range; text never
  sprawls or cramps regardless of screen size or text size
- **150% paragraph spacing** — consistent vertical rhythm without manual tuning
- **Two reading modes**, not infinite font knobs:
  - **Constrained** — fixed-width column, paginated, the closest thing to a
    printed page
  - **Adaptive** — reflows to the viewport, for whatever device you're holding

The goal is that the typography just works, the same way it would in a
well-set book. Bump the text size with + / − if you want it bigger or smaller —
line length, spacing, and column width all adjust automatically to stay in
range — but there's no font-size slider, no line-height knob, nothing else to
tune.

### Chapter progress, not book progress

The thin progress bar at the bottom of the reader shows **progress through the
current chapter**, not the whole book. Hitting 100% means you've reached the
end of that section; the bar resets when you cross into the next one. This is
deliberate — a per-chapter bar gives meaningful, frequent feedback on a long
e-ink page-turn, where a whole-book bar barely moves between turns. Library
shelving ("In Progress" / "Complete") still uses overall book percentage.

### Built for e-ink, EPUB only

The stark, high-contrast, brutalist look isn't an aesthetic flex — it's there
because HonLib is built to be read on e-ink. Heavy borders, flat black-on-white
panels, and no gradients or shadows are what render crisply on a slow refresh
display. It looks fine in a normal browser too, but the design is tuned for the
screens that benefit most.

HonLib **only supports EPUB**. No PDF, no MOBI, no AZW, no CBZ/CBR. If you
want any of those, convert them first (Calibre handles it) or use a different
reader. Keeping the format surface small is what makes the typography and the
reader behavior consistent.

## Features

- **Library** — cover grid or table view, search, sort, filter, and permanently
  delete unwanted EPUBs without visiting the NAS filesystem.
- **Reader** — paginated reading with adjustable fonts (incl. dyslexia-friendly
  faces like Atkinson Hyperlegible), light/sepia/dark themes
  tuned for e-ink, and tap-a-word dictionary lookups.
- **Progress sync** — your place in each book follows you between devices.
- **Bookmarks** — save exact page positions and return to them from the reader's
  Chapters / Bookmarks view.
- **Highlights and journals** — highlight or underline a passage and it lands in
  a journal that collects across books, series and authors, with notes, tags,
  search and Markdown export (see [Highlights and journals](#highlights-and-journals)).
- **Installable** — works as a PWA you can add to a phone or tablet home screen.
- **Plugin-friendly** — optional acquisition and Android wrapper modules can be
  added as git submodules (see [Optional modules](#optional-modules)).

## Requirements

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose.
- Some `.epub` files. The app reads epubs; it does not require any particular
  folder layout.

## Quick start

```sh
git clone --recurse-submodules <this-repo> HonLib
cd HonLib
docker compose up -d --build
```

Open **http://localhost:8781** (or `http://<host-ip>:8781` from another device
on your network).

By default the app stores everything next to the compose file:

- `./data/books`   — your library; drop `.epub` files here
- `./data/staging` — in-progress downloads (used by the optional acquisition plugin)
- `./data/journal` — highlights, notes and journals (keep this!)
- `./config`       — secret key, reading progress, and caches (keep this!)

To point at an existing library folder, copy `.env.example` to `.env` and set
`EBOOK_LIB_BOOKS_DIR`.

### How the library is organized

HonLib doesn't impose any schema on your files — it just walks the books folder
recursively and treats **subfolder names as the grouping shelf**. The default
"Series" browse is really just "group by folder," so the easiest way to get a
clean library is to mirror that:

```
data/books/
├── Foundation/             ← series folder → shelf "Foundation"
│   ├── 01 Foundation.epub
│   ├── 02 Foundation and Empire.epub
│   └── 03 Second Foundation.epub
├── The Expanse/            ← series folder → shelf "The Expanse"
│   ├── 01 Leviathan Wakes.epub
│   └── 02 Caliban's War.epub
└── Stranger in a Strange Land.epub   ← loose file → shelf "Library"
```

- A file inside a subfolder is grouped under that subfolder's name.
- A file dropped straight into the books folder is grouped under **"Library"**.
- Series order within a shelf comes from the EPUB's own
  `calibre:series_index` metadata, so naming files `01 …`, `02 …` keeps them
  in reading order even before the metadata is set.

If a book has no series folder, the **genre fallback** kicks in for the
"Genre" sort: HonLib reads the EPUB's `subject` metadata (Calibre and most
ebook tools write it) and groups by that. So even loose files get a sensible
shelf when you switch sort modes.

You can also sort by Title or Author at any time from the menu — those are
flat alphabetical views that ignore folders entirely.

Need to fix a title, author, or series for a book that's already been ingested?
Drop the file back into `data/staging/` and use the Staging panel to edit the
metadata before re-importing.

## Highlights and journals

Select a phrase while reading and an annotation bar offers **Highlight**,
**Underline**, **Add tag** and **Add note**. Select a single word and you get
its definition as before, with a **Save** button. Either way the passage is
saved the moment you make it. Tap a mark later and it shows you the passage and
its note, with **View in journal** (the journal opens over the page, on that
passage) and **Edit annotation** (the tools, to restyle, retag or delete it).

The bar sits beside what you are marking: just over the selection, or under it
where there is no room above. With text selected, tap a word to end the
selection there (further on to stretch it, inside it to cut it short), tap a
word before it to start it there, or drag either end. On a touchscreen the
reader takes the selection over once your finger lifts, so the system's handles
and its Copy / Share / Select all bar don't sit on top of the annotation bar;
press-and-hold and drag works as usual until then. **Cancel**, or a tap off the
text, lets the selection go.

The page never turns under a selection. When a passage runs past the foot of
the page, select to the end of the page and the bar offers **Continue on next
page**; the page turns, and a tap on the passage's last word finishes it.

- **Styles** — a passage can have a highlight colour (yellow, green, blue, pink,
  orange), an underline style (solid, dashed, dotted, wavy, double), or both.
  Colours are true colours on every device, and every swatch and every saved
  passage also carries its colour's name, so nothing depends on telling tints
  apart on a grayscale screen.
- **Journals** — a journal sits on the home page like a book, but opens as a
  list of passages you can search and filter. On each passage, tap the quote to
  change its style, the note to edit it, a tag to remove it, and **Add Tag** or
  **Add Note** where one would be; the **⋯** menu has the rest (add to
  clipboard, view in book, remove from journal, delete). Each journal has *sources*: single
  books, whole series, or whole authors (series and authors include books you
  add later). A highlight goes into every journal that covers its book, and
  any one passage can then be kept out of a journal or put into another
  (**Journals** on its sheet in the reader, **Choose journals** in its menu in a
  journal). The
  first highlight you ever make creates "My First Journal"; a highlight in a
  book no journal covers is saved and you're offered a journal for it, or it
  waits in **Unfiled**.
- **Passages keep themselves** — each one carries its text, your note and tags,
  and a snapshot of where it came from, so it survives the book being deleted.
  A passage whose book is still in the library but no longer a source of the
  journal is marked *Source off*; one whose book is gone is marked *Book
  missing*.
- **Between journal and book** — *View in book* opens the book at the passage
  without touching your saved place or finished status; *Back to journal* and
  *Go to my place* take you out. From inside a book, the **Passages** tab (beside
  Chapters and Bookmarks) lists this book's passages or the whole journal.
- **Export** — journal settings can download the journal as Markdown.

### Where annotations live

One small JSON file per passage and per journal, under `EBOOK_LIB_JOURNAL_DIR`
(`./data/journal` by default). Nothing is written into an EPUB or into the
books folder.

```
data/journal/
├── journals/<journal-id>.json
└── passages/<passage-id>.json
```

Devices send each change to the server as they make it, and an open journal
checks for changes every few seconds, so a passage captured on an e-reader
shows up on a tablet within moments. Two devices changing the same passage are
settled by whichever change is newer; changes to different passages never
conflict. A delete is recorded as a marker in the file rather than by removing
it, which is how other devices learn of it.

Syncthing is not required, but the folder is safe to sync with it as a second
route: files that appear or change there are picked up, and a Syncthing
conflict copy is settled by the same newest-wins rule. A search index is kept
in the config folder (`journal-index.sqlite`); it is rebuilt from the files and
can be deleted at any time.

## Configuration

All settings are environment variables, documented in `.env.example`. The most
common ones:

| Variable                  | Default          | Purpose                                          |
| ------------------------- | ---------------- | ------------------------------------------------ |
| `EBOOK_LIB_BOOKS_DIR`     | `./data/books`   | Host folder holding your epubs                   |
| `EBOOK_LIB_STAGING_DIR`   | `./data/staging` | Where downloads land before import               |
| `EBOOK_LIB_JOURNAL_DIR`   | `./data/journal` | Where highlights, notes and journals are stored  |
| `EBOOK_LIB_PASSWORD`      | _(empty)_        | Set to enable login. Empty = no auth (LAN only)  |
| `EBOOK_LIB_USERNAME`      | _(empty)_        | Optional username for login                      |
| `EBOOK_LIB_COOKIE_SECURE` | _(empty)_        | Set to `1` only when served entirely over HTTPS  |

The host port is set in `docker-compose.yml` (`8781:8765`) — change the left
number if `8781` is taken.

### Security note

There is **no login until you set `EBOOK_LIB_PASSWORD`**. That's convenient on
a trusted home network but means anyone who can reach the port can use the app.
Set a password before exposing it beyond your LAN, and only set
`EBOOK_LIB_COOKIE_SECURE=1` when every entry point is HTTPS (e.g. behind a
reverse proxy with TLS).

## Optional modules

HonLib ships intentionally light. Optional components are tracked as git
submodules so the core web app remains usable without checking them out.

The core renderer, [foliate-js](https://github.com/johnfactotum/foliate-js),
is also pinned as a submodule at `static/vendor/foliate-js`. Unlike the optional
components below, it must be initialized before building:

```sh
git submodule update --init static/vendor/foliate-js
```

### Acquisition plugin (`acquisition/irc/`)

If a Python package exists at `acquisition/irc/` exposing a `client` object,
HonLib exposes "Add books" UI and the `/api/irc/*` endpoints. Without it those
endpoints return 503 and the UI is hidden. The contract:

```python
# acquisition/irc/__init__.py
class _Client:
    def status(self) -> dict: ...
    def search(self, query: str, *, log, stop) -> list[dict]: ...
    def download(self, result: dict, dest: str, *, log, stop) -> Path: ...
    def start_background(self) -> None: ...

client = _Client()
```

The official plugin is maintained separately and pinned here as a submodule:

```sh
git submodule update --init acquisition/irc
docker compose up -d --build
```

The plugin currently has no additional Python dependencies.

### Android wrapper (`android/`)

A native Android reader is tracked as a submodule at `android/`, sourced from
[east35/lib-sdk](https://github.com/east35/lib-sdk). Pull it with the rest of
the project:

```sh
git clone --recurse-submodules <this-repo> HonLib
# or, after a plain clone:
git submodule update --init --recursive
```

See `android/README.md` for build instructions. The web app works fine without
it.

## Updating

```sh
git pull
git submodule update --init --recursive
docker compose up -d --build
```

Your library, your journals and `./config` are untouched by rebuilds.

If you run HonLib from your own compose file rather than the one in this repo,
add the journal volume to it (`<host folder>:/data/journal`, with
`EBOOK_LIB_JOURNAL_DIR=/data/journal`). Without it, annotations are kept in the
config volume under `journal/` so that a rebuild cannot lose them.

## Backup

Back up three things:

- your books folder (`./data/books` or your `EBOOK_LIB_BOOKS_DIR`)
- your journal folder (`./data/journal` or your `EBOOK_LIB_JOURNAL_DIR`)
- `./config` (holds the secret key and reading progress)

## Bundled fonts

The reader ships with [Literata](https://fonts.google.com/specimen/Literata)
(default), Vollkorn, Atkinson Hyperlegible, and Nunito — all
under SIL Open Font License.

## Tech

Flask behind a single Gunicorn worker with threads, with a vanilla-JS frontend using
[foliate-js](https://github.com/johnfactotum/foliate-js) for rendering.
Foliate is pinned to an exact commit rather than following its moving `main`
branch. Everything is baked into the Docker image at build time.

### Scripted EPUB security test

The browser regression test generates an EPUB containing a harmless script
probe, opens it through HonLib in Chromium and WebKit, and verifies CSP blocks
it. A CSP-stripped negative control must execute the same probe.

```sh
npm install
npx playwright install chromium webkit
npm run test:scripted-epub
```

### Reader and journal tests

The reader's position tracking and the annotation features are tested the same
way, against a throwaway library of generated EPUBs:

```sh
pip install -r requirements.txt
npm run test:reader
npm run test:journal
```
