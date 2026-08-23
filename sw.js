/* Service worker for map.html — keeps the app usable with no signal.
 *
 * Strategy per resource:
 *   app shell (map.html, vendor/*, manifest, icons)  cache-first, precached on install
 *   data/wineries.json                               network-first, cached copy as fallback
 *   CARTO basemap tiles                              stale-while-revalidate, capped store,
 *                                                    so any area you've panned over stays
 *                                                    viewable offline
 * Everything else (the dashboard index.html included) passes straight through untouched.
 *
 * Bump VERSION whenever map.html or vendor files change so clients pick them up.
 */
'use strict';

const VERSION = 'v3';
const SHELL_CACHE = 'nwm-shell-' + VERSION;
const DATA_CACHE = 'nwm-data-' + VERSION;
const TILE_CACHE = 'nwm-tiles-' + VERSION;
const TILE_LIMIT = 800;                     // ~25–40 MB; oldest evicted beyond this

const rel = (p) => new URL(p, self.registration.scope).toString();

const SHELL = [
  'map.html',
  'manifest.webmanifest',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/markercluster/leaflet.markercluster.js',
  'vendor/markercluster/MarkerCluster.css',
  'vendor/markercluster/MarkerCluster.Default.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
].map(rel);

const DATA_URL = rel('data/wineries.json');
const TILE_HOST = /\.basemaps\.cartocdn\.com$/;

self.addEventListener('install', (e) => {
  e.waitUntil(Promise.all([
    // Snapshot the data at install so the map works offline from the very first
    // visit; the network-first fetch handler keeps this copy up to date afterwards.
    caches.open(DATA_CACHE).then((c) =>
      fetch(DATA_URL, { cache: 'no-cache' })
        .then((r) => { if (r.ok) return c.put(DATA_URL, r); })
        .catch(() => {})
    ),
    caches.open(SHELL_CACHE)
      // addAll rejects wholesale on one 404; fetch individually so a missing
      // optional asset can't block install.
      .then((c) => Promise.allSettled(SHELL.map((u) =>
        fetch(u, { cache: 'no-cache' }).then((r) => { if (r.ok) return c.put(u, r); })
      )))
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('nwm-') && ![SHELL_CACHE, DATA_CACHE, TILE_CACHE].includes(k))
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  // FIFO is close enough to LRU here: keys() returns insertion order.
  for (let i = 0; i < keys.length - TILE_LIMIT; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Basemap tiles: serve cached immediately, refresh in the background.
  if (TILE_HOST.test(url.host)) {
    e.respondWith((async () => {
      const c = await caches.open(TILE_CACHE);
      const hit = await c.match(e.request);
      const refresh = fetch(e.request)
        .then((r) => {
          if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); trimTiles(); }
          return r;
        })
        .catch(() => null);
      return hit || (await refresh) || new Response('', { status: 504 });
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // Winery data: freshest wins, cache is the offline fallback.
  if (e.request.url.split('?')[0] === DATA_URL) {
    e.respondWith((async () => {
      const c = await caches.open(DATA_CACHE);
      let net = null;
      try { net = await fetch(e.request); } catch { /* offline */ }
      if (net && net.ok) { c.put(DATA_URL, net.clone()); return net; }
      const hit = await c.match(DATA_URL);      // cache also covers a 5xx from the host
      return hit || net || new Response(JSON.stringify({ offline: true, wineries: [] }),
        { status: 503, headers: { 'content-type': 'application/json' } });
    })());
    return;
  }

  // App shell: cache-first. Only URLs we precached — anything else stays untouched.
  const clean = url.origin + url.pathname;
  if (SHELL.includes(clean)) {
    e.respondWith(
      caches.match(clean).then((hit) => hit ||
        fetch(e.request).then((r) => {
          if (r.ok) caches.open(SHELL_CACHE).then((c) => c.put(clean, r.clone()));
          return r;
        }))
    );
  }
});
