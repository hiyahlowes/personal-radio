// Personal Radio — Service Worker
// Network-first for HTML navigation; stale-while-revalidate for assets.
// On activation, claims all clients and signals them to reload so users
// always get the latest version without restarting the PWA.

const CACHE   = 'pr-shell-v2';
const VERSION = 'v2';

// App-shell assets to pre-cache on install
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

console.log(`[SW] network-first strategy active (${VERSION})`);

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  // Activate immediately — don't wait for old SW to become idle
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    // 1. Delete all old-version caches
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      // 2. Take control of all open tabs immediately
      .then(() => self.clients.claim())
      // 3. Tell every open client to reload so they get the new bundle
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(cs => {
        console.log(`[SW] new version activated — reloading ${cs.length} client(s)`);
        cs.forEach(c => c.postMessage({ type: 'RELOAD' }));
      })
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Netlify functions and API calls — always network, never cache
  if (url.pathname.startsWith('/.netlify/')) return;

  const isNavigation = request.mode === 'navigate';
  const isAsset = /\.(js|css|woff2?|png|svg|webp|ico|webmanifest)$/.test(url.pathname);

  if (isNavigation) {
    // ── Network-first for HTML ────────────────────────────────────────────────
    // Always try to fetch the latest index.html. Only fall back to cache
    // when the network is genuinely unavailable (offline).
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            caches.open(CACHE).then(c => c.put(request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(request).then(cached => cached ?? Response.error()))
    );
  } else if (isAsset) {
    // ── Stale-while-revalidate for JS/CSS/fonts/images ────────────────────────
    // Serve from cache immediately for speed; update cache in background.
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(request).then(cached => {
          const network = fetch(request).then(res => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          }).catch(() => cached);
          return cached ?? network;
        })
      )
    );
  }
  // All other same-origin requests fall through to the browser default
});
