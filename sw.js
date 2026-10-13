const CACHE = 'hkm-shell-c78252ddeee76b93';
const ROOT = new URL('./', self.location.href);
const FILES = ['index.html', 'app.js', 'offline.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const PATHS = new Set(FILES.map(file => new URL(file, ROOT).pathname));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(file => new Request(new URL(file, ROOT), {cache: 'reload'})))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('hkm-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== ROOT.origin) return;
  const path = url.pathname === ROOT.pathname ? new URL('index.html', ROOT).pathname : url.pathname;
  if (!PATHS.has(path)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(new URL(path, ROOT.origin).href);
    return saved || fetch(event.request);
  })());
});
