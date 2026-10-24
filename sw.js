// Offline support. The site's own files: always try the network first so updates show
// up right away, and fall back to the saved copy when there is no connection.
// Fonts and libraries never change, so those come straight from the saved copy.
const CACHE = "foodli-v7";
const CORE = ["./", "index.html", "style.css", "app.js", "recipes.js", "friend.js", "cloud.js", "firebase-config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  const fixed = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com"
    || (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"));
  if (!own && !fixed) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    if (own) {
      try {
        const res = await fetch(req, { cache: "no-cache" });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return (await cache.match(req, { ignoreSearch: true })) || Response.error();
      }
    }
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") cache.put(req, res.clone());
    return res;
  }));
});
