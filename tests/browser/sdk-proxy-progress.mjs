// The reader must not fight its own progress writes.
//
// The Android shell serves this same web bundle but puts a local queueing proxy
// in front of the server, and that proxy answers a write with
// {ok, queued, synced} — no `entry`. The web app used that `entry` to refresh the
// optimistic-concurrency token it sends as `base`, so on the shell the token
// froze at open time. Two things then went wrong:
//
//   1. Every focus event saw the proxy's freshly stamped timestamp as "newer
//      than my token", concluded another device had moved ahead, and jumped the
//      reader to whatever the queue last recorded. Because the proxy blocks on a
//      cloud round-trip before answering, that is often the *previous* page — so
//      a page turn followed by a focus event landed you back where you started,
//      and the resync then saved that older position. You could not advance.
//   2. The frozen token kept being forwarded to the real server, whose staleness
//      guard rejected every later write as a conflict that never happened.
//
// Neither reproduces against the real server, which always returns `entry`, so
// this test stands in the proxy's response shape at the network layer.
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { baseURL, engines, openBook, readState, turnPage } from "./reader-harness.mjs";


const BOOK = "HonLib Split Chapter Test";
// The shell forwards each write to cloud before answering, so a write is slow
// and there is a real window where the queue still holds the previous page.
const WRITE_LATENCY_MS = 1500;
// A position already on record when the book opens, so the app starts with a
// non-null token — the state in which the frozen-token bug bites.
const SEEDED_TOKEN = "2026-01-01T00:00:00.000Z";

async function bookId() {
  const library = await fetch(`${baseURL}/api/library`).then((r) => r.json());
  const book = library.books.find((b) => b.title === BOOK);
  if (!book) throw new Error(`fixture "${BOOK}" not in the library`);
  return book.id;
}

// Stand in for EbookRouter's progress handlers: POST queues and reports no
// entry, GET returns the queued row with the proxy's own timestamp on it.
async function installProxy(context, id) {
  const posts = [];
  let stored = { cfi: null, percent: 0, last_opened: SEEDED_TOKEN };
  await context.route(
    (url) => url.pathname === "/api/progress",
    async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ books: { [id]: stored }, bookmarks: {} }),
        });
      }
      const body = JSON.parse(request.postData() || "{}");
      posts.push(body);
      await new Promise((resolve) => setTimeout(resolve, WRITE_LATENCY_MS));
      stored = { cfi: body.cfi, percent: body.percent, last_opened: new Date().toISOString() };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, queued: true, synced: true }),
      });
    },
  );
  return posts;
}

async function waitForWrites(posts, count) {
  for (let i = 0; i < 200; i++) {
    if (posts.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`only saw ${posts.length} write(s), expected ${count}`);
}

async function runEngine(name, engine) {
  const id = await bookId();
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const posts = await installProxy(context, id);
    const page = await context.newPage();
    await openBook(page, BOOK);

    // Land the first write, then check the token was abandoned. Left in place it
    // would be forwarded forever and the real server would reject every write.
    await turnPage(page);
    await waitForWrites(posts, 1);
    assert.equal(posts[0].base, SEEDED_TOKEN, `${name}: first write should still carry the opening token`);
    const seen = posts.length;
    await turnPage(page);
    await waitForWrites(posts, seen + 1);
    assert.equal(
      posts[seen].base,
      null,
      `${name}: kept sending a token the backend never refreshes (${posts[seen].base})`,
    );

    // Now the trap itself: turn a page, then hand the window focus back while
    // the write is still in flight, so the proxy still holds the previous page.
    // app.js listens for the plain window focus event, which is what the shell's
    // WebView delivers on resume.
    const afterTurn = await turnPage(page);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(WRITE_LATENCY_MS * 2);

    const afterFocus = await readState(page);
    assert.equal(
      afterFocus.section,
      afterTurn.section,
      `${name}: focus moved the reader from section ${afterTurn.section} to ${afterFocus.section}`,
    );
    assert.ok(
      afterFocus.page >= afterTurn.page,
      `${name}: focus dragged the reader back from page ${afterTurn.page} to ${afterFocus.page}`,
    );

    // And the reader keeps advancing afterwards, rather than being pinned.
    const afterNext = await turnPage(page);
    assert.ok(
      afterNext.section > afterFocus.section || afterNext.page > afterFocus.page,
      `${name}: reader stuck at section ${afterFocus.section} page ${afterFocus.page}`,
    );

    await context.close();
    console.log(`${name}: reader held position across a focus event and kept advancing`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
