// Versioned caches are separate from the durable review queue in IndexedDB.
const BUILD = "__BUILD__";
const PREFIX = "learnharness-review-";
const CACHE = PREFIX + BUILD;
const ASSETS = __ASSETS__;
const marker = build => "/review/__ready__/" + build;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS.map(url => new Request(url, { cache: "reload" })));
    await cache.put(marker(BUILD), new Response("ready"));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const owned = (await caches.keys()).filter(key => key.startsWith(PREFIX));
    const previous = owned.filter(key => key !== CACHE).slice(-1);
    await Promise.all(owned.filter(key => key !== CACHE && !previous.includes(key)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type !== "IS_CACHED" || !event.ports[0]) return;
  event.waitUntil((async () => {
    const ready = await caches.match(marker(event.data.build));
    event.ports[0].postMessage({ ready: !!ready, build: BUILD });
  })());
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith("/review/")) return;
  // API and ordinary LearnHarness pages are never intercepted or cached.
  if (event.request.mode === "navigate" && ["/review/", "/review/index.html"].includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match("/review/index.html")).then(response => response || fetch(event.request)));
  } else if (url.pathname.startsWith("/review/assets/") || ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(response => response || fetch(event.request)));
  }
});
