// Keeps Rajista Snap usable offline: the page and its files are cached. With no network, the app still opens,
// the product list still works, and the on-device model can still read invoices.
const CACHE = "snap-v3";
// Only the core app is cached on install, so a slow or failed download of anything optional (the sample
// photos) can never break offline support, and nobody pays mobile data for samples they never open.
const CORE = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const keep = (req, res) => {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
};

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // AI, App Check and fonts go to the network as usual
  if (e.request.mode === "navigate") {
    // The page: fresh when online, cached when not.
    e.respondWith(fetch(e.request).then((r) => keep(new Request("/"), r)).catch(() => caches.match("/")));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // Built files carry a content hash in their names, so a cached copy is always the right one.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => keep(e.request, r))));
    return;
  }
  // Everything else (sample photos, icon, manifest) keeps its name when it changes: network first, cache when offline.
  e.respondWith(fetch(e.request).then((r) => keep(e.request, r)).catch(() => caches.match(e.request)));
});
