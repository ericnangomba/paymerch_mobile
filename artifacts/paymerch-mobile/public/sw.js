/**
 * Paymerch Mobile - Progressive Web App service worker.
 *
 * Cache-first for the static app shell (icons, manifest, splash, the hashed
 * JavaScript bundle under /_expo/static/) so the app is usable offline and can
 * be installed. Navigation requests are served from the cache first and refreshed
 * in the background so users always get the latest build once online.
 */
const CACHE_NAME = 'paymerch-mobile-v1';

const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/favicon-32x32.png',
  '/favicon-48x48.png',
  '/apple-touch-icon.png',
  '/icons/192.png',
  '/icons/512.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.map((name) => (name !== CACHE_NAME ? caches.delete(name) : undefined))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Cache-first for the expo bundle, fonts, public icons and app shell assets.
  const isShellAsset =
    url.pathname.startsWith('/_expo/static/') ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/favicon') ||
    url.pathname.startsWith('/apple-touch-icon');

  if (isShellAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          return response;
        });
      }),
    );
    return;
  }

  // Navigation requests: serve cached shell, then refresh from network.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then((cached) => {
        const network = fetch(request).then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', cloned));
          return response;
        });
        return cached || network;
      }),
    );
    return;
  }

  // Everything else: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).catch(() => undefined)),
  );
});
