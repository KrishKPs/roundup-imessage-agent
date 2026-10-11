// Roundup app shell: the pages and styles load instantly and work with a flaky connection.
// Live data (/api, /events) always goes to the network; nothing private is ever cached.
const SHELL = "roundup-shell-v1";
const FILES = ["/app", "/new", "/web.css", "/qrcode.min.js", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname === "/events") return; // live data: network only
  // Pages: network first (always the latest), fall back to the cached shell when offline.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && FILES.includes(url.pathname)) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("/app"))));
});
