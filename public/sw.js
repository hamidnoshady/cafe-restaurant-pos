/**
 * Service worker (Phase 12) — the minimum needed to make the POS installable
 * as a PWA and to keep the app window openable even if the server is briefly
 * unreachable (e.g. the moment right after boot before Docker is fully up).
 *
 * Deliberately conservative: this is an online-first app whose real offline
 * story is the server itself (the on-site laptop) plus the IndexedDB action
 * queue (Phase 5). So the service worker only:
 *   - Precaches a tiny offline fallback page and the app icon.
 *   - Serves navigations network-first, falling back to the cached shell only
 *     when the network genuinely fails — it never serves stale API data.
 *   - Never caches API responses (/api/*) — those must always hit the server
 *     so orders, auth, and sync are never served from a stale cache.
 */
const CACHE = "cafe-pos-shell-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET; never touch POST/PUT (orders, sync, login).
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept API calls or the WebSocket — always go to the network so
  // data is never stale and auth/sync behave exactly as when fully online.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  // Navigations (page loads): network-first, fall back to offline page.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())),
    );
    return;
  }

  // Static assets (icons, etc.): cache-first for the few we precache.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});
