// Caches the app shell so the home-screen app still opens offline. API calls always go to the network.
const CACHE = "quick-cal-v4";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "parse.js",
  "gcal.js",
  "quick-parse.js",
  "request-template.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for same-origin files so a new deploy shows up on the next launch;
// the cached copy is only used offline. "no-cache" skips GitHub Pages' 10-minute HTTP cache.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      fetch(e.request.url, { cache: "no-cache" })
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(async () => (await cache.match(e.request, { ignoreSearch: true })) ?? Response.error()),
    ),
  );
});
