import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { engines, openBook } from "./reader-harness.mjs";

const BOOK = "HonLib Split Chapter Test";

async function runEngine(name, engine) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const requested = [];
    await page.route("**/api/dictionary/*", (route) => {
      const word = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
      requested.push(word);
      const payload = word === "refractions"
        ? { word, meanings: [{ partOfSpeech: "noun", definitions: ["plural of refraction"] }] }
        : { word: "refraction", meanings: [{ partOfSpeech: "noun", definitions: ["The change in direction of a wave passing between media."] }] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await openBook(page, BOOK);

    // Replace one visible word with a controlled one and select it exactly as
    // a browser selection would; this exercises the ordinary selectionchange
    // path without exposing implementation-only hooks.
    await page.evaluate(() => {
      const view = document.querySelector("foliate-view"), visible = view.lastLocation.range;
      const doc = visible.startContainer.ownerDocument;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node, match;
      while ((node = walker.nextNode())) {
        if (!visible.intersectsNode(node)) continue;
        match = /[A-Za-z]{4,}/.exec(node.data);
        if (match) break;
      }
      node.data = node.data.slice(0, match.index) + "refractions" + node.data.slice(match.index + match[0].length);
      const range = doc.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + "refractions".length);
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      doc.dispatchEvent(new Event("selectionchange"));
    });
    await page.locator("#dict-popover .dict-defs").waitFor();
    assert.match(await page.locator("#dict-popover").textContent(), /change in direction/i, `${name}: plural note replaced no definition`);
    assert.deepEqual(requested, ["refractions", "refraction"], `${name}: lookup did not follow the plural lemma once`);

    await context.close();
    console.log(`${name}: plural dictionary entries resolve to the lemma definition`);
  } finally {
    await browser.close();
  }
}

for (const [name, engine] of engines({ chromium, webkit })) {
  if (!engine) throw new Error(`unsupported browser: ${name}`);
  await runEngine(name, engine);
}
