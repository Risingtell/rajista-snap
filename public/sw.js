// Keeps Rajista Snap usable offline: the page and its files are cached. With no network, the app still opens,
// the product list still works, and the on-device model can still read invoices.
const CACHE = "snap-v4";
const CORE = ["/", "/manifest.webmanifest", "/icon.svg"];

// On install, cache the core files and the built bundles the page loads (their names carry a content hash and
// are read from the page itself), so the app opens offline after the first visit. The sample photos are not
// cached here: nobody pays mobile data for samples they never open, and an optional file can never break this.
self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      const page = await fetch("/", { cache: "no-store" });
      const html = await page.clone().text();
      const assets = [...new Set(html.match(/\/assets\/[^"'\s>]+/g) ?? [])];
      await c.put("/", page);
      await c.addAll([...CORE.slice(1), ...assets]);
    })(),
  );
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

const keep = (key, res) => {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(key, copy));
  }
  return res;
};
const isPage = (res) => (res.headers.get("content-type") ?? "").includes("text/html");

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // AI, App Check and fonts go to the network as usual
  if (e.request.mode === "navigate") {
    // The app page: fresh when online, cached when not. Only an HTML answer may replace the cached page, so
    // opening the icon or a sample photo in a tab can never overwrite the app.
    e.respondWith(
      fetch(e.request)
        .then((r) => (isPage(r) ? keep("/", r) : r))
        .catch(async () => (await caches.match(e.request)) ?? caches.match("/")),
    );
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
