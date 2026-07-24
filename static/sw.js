// ebook-library service worker — app-shell caching for an installable PWA.
// Network-first for the shell (so rebuilds are picked up), cache fallback when
// offline. API calls and book files are never cached (always live).

const CACHE = "ebook-library-v5";
const SHELL = [
  "/",
  "/index.html",
  "/theme.js",
  "/app.js",
  "/style.css",
  "/manifest.webmanifest",
  "/img/icon-192.png",
  "/img/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never touch API or book-file traffic — always go to the network.
  if (url.pathname.startsWith("/api/")) return;

  // Network-first for everything else, falling back to cache when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Don't cache auth redirects (e.g. the login page served for "/").
        if (res && res.ok && !res.redirected && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match("/index.html"))
      )
  );
});
