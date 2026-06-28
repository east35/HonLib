![HonLib logo](static/img/honlib-logo.png)

# HonLib

A self-hosted ebook library and reader you run with Docker. Browse your epub
collection in the browser, read in a clean paginated reader
([foliate-js](https://github.com/johnfactotum/foliate-js)) with themes, fonts,
tap-to-define dictionary lookup, and progress that syncs across devices.

Licensed [AGPL-3.0](LICENSE).

## Why HonLib

I wanted off the Kindle ecosystem — no proprietary formats, no vendor lock-in,
just my books, accessible from any device.

I tried KOReader first. It's powerful, but it's built for people who want to
tune every setting. I just wanted to read. So HonLib is the opposite bet: a
simple, self-hosted library and reader that works the same everywhere.

HonLib doesn't sync anything itself — that's not its job. Point it at a local
folder and it reads from disk; keeping that folder up to date is whatever
syncing tool you already use (Syncthing, Dropbox, a NAS share, whatever).
HonLib just notices when the files are there. The companion
[Android reader](https://github.com/east35/ebook-manga-local) takes the same
posture on the device side: read from local storage if the file is present,
fall back to the server otherwise.

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

- **Library** — cover grid or table view, search, sort, and filter your epubs.
- **Reader** — paginated reading with adjustable fonts (incl. dyslexia-friendly
  faces like Atkinson Hyperlegible), light/sepia/dark themes
  tuned for e-ink, and tap-a-word dictionary lookups.
- **Progress sync** — your place in each book follows you between devices.
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

## Configuration

All settings are environment variables, documented in `.env.example`. The most
common ones:

| Variable                  | Default          | Purpose                                          |
| ------------------------- | ---------------- | ------------------------------------------------ |
| `EBOOK_LIB_BOOKS_DIR`     | `./data/books`   | Host folder holding your epubs                   |
| `EBOOK_LIB_STAGING_DIR`   | `./data/staging` | Where downloads land before import               |
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
[east35/ebook-manga-local](https://github.com/east35/ebook-manga-local). Pull
it with the rest of the project:

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

Your library and `./config` are untouched by rebuilds.

## Backup

Back up two things:

- your books folder (`./data/books` or your `EBOOK_LIB_BOOKS_DIR`)
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
