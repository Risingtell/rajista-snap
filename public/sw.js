// Keeps Rajista Snap usable offline: the page and its files are cached. With no network, the app still opens,
// the product list still works, and the on-device model can still read invoices.
const CACHE = "snap-v6";
const isPage = (res) => (res.headers.get("content-type") ?? "").includes("text/html");
const assetsIn = (html) => [...new Set(html.match(/\/assets\/[^"'\s>]+/g) ?? [])];

// On install, cache the page, the manifest, the icon and the built bundles the page loads (read from the page
// itself), so the app opens offline after the first visit. Only a real page is accepted: an error or challenge page
// fails the install, and the browser tries again on the next visit. Sample photos are not cached here: nobody
// pays mobile data for samples they never open, and an optional file can never break this.
self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const page = await fetch("/", { cache: "no-store" });
      if (!page.ok || !isPage(page)) throw new Error("not the app page");
      const assets = assetsIn(await page.clone().text());
      if (!assets.length) throw new Error("the page lists no app files");
      const c = await caches.open(CACHE);
      await c.addAll(["/manifest.webmanifest", "/icon.svg", ...assets]);
      await c.put("/", page);
    })(),
  );
  self.skipWaiting();
});

// Drops any built bundle the given page no longer uses. Run whenever a new copy of the page is cached, which is
// what happens on every deploy, so old bundles do not pile up on visitors' phones.
async function prune(html) {
  const keep = new Set(assetsIn(html));
  if (!keep.size) return;
  const c = await caches.open(CACHE);
  for (const req of await c.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/assets/") && !keep.has(path)) await c.delete(req);
  }
}

// On activate, drop caches from earlier versions of this worker.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      await Promise.all((await caches.keys()).filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // AI, App Check and fonts go to the network as usual
  // Stores a copy of a good answer, and keeps the worker alive until it is stored.
  const keep = (key, res) => {
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
    }
    return res;
  };
  if (e.request.mode === "navigate") {
    // The app page: fresh when online, cached when not. Only an HTML answer may replace the cached page, so
    // opening the icon or a sample photo in a tab can never overwrite the app. A new page also prunes old bundles.
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok && isPage(r) && url.pathname === "/") e.waitUntil(r.clone().text().then(prune));
          return isPage(r) ? keep("/", r) : r;
        })
        .catch(async () => (await caches.match(e.request)) ?? caches.match("/")),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // Built files carry a content hash in their names, so a cached copy is always the right one. A missing bundle
    // is answered by the site with the app page (HTML), which must never be stored under a script's name.
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => (isPage(r) ? r : keep(e.request, r)))),
    );
    return;
  }
  // Everything else (sample photos, icon, manifest) keeps its name when it changes: network first, cache when offline.
  e.respondWith(fetch(e.request).then((r) => keep(e.request, r)).catch(() => caches.match(e.request)));
});
