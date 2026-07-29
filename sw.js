/* Nightstand service worker. Cache-first, everything precached.
   To ship an update: bump CACHE_VERSION, commit, push. */
const CACHE_VERSION = 'nightstand-v3';

const SHELL = [
  './',
  'index.html',
  'app.js',
  'app.css',
  'manifest.webmanifest',
  'papers/manifest.json',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(SHELL);
    // precache every paper listed in the library manifest
    try {
      const res = await cache.match('papers/manifest.json') || await fetch('papers/manifest.json');
      const manifest = await res.clone().json();
      const files = (manifest.papers || []).map(p => p.file);
      await cache.addAll(files);
    } catch (e) { /* papers fetched lazily if precache fails */ }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(event.request);
      if (res.ok && new URL(event.request.url).origin === location.origin) {
        cache.put(event.request, res.clone());
      }
      return res;
    } catch (e) {
      // offline and not cached: for navigations fall back to the shell
      if (event.request.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503 });
    }
  })());
});
