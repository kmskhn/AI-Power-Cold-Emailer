const CACHE_NAME = 'ai-emailer-v3';

const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ─────────────────────────────────────────────────────────────
// INSTALL
// ─────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );

  self.skipWaiting();
});

// ─────────────────────────────────────────────────────────────
// ACTIVATE
// ─────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

// ─────────────────────────────────────────────────────────────
// FETCH
// ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // ───────────────────────────────────────────────────────────
  // API → ALWAYS NETWORK
  // ───────────────────────────────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({
            error: 'You are offline. Please check your connection.',
          }),
          {
            headers: {
              'Content-Type': 'application/json',
            },
            status: 503,
          }
        )
      )
    );

    return;
  }

  // ───────────────────────────────────────────────────────────
  // HTML / PAGE NAVIGATION → NETWORK FIRST
  // ───────────────────────────────────────────────────────────
  if (request.mode === 'navigate' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Keep a fresh copy as offline fallback
          const responseClone = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put('/index.html', responseClone);
          });

          return response;
        })
        .catch(() => {
          return caches.match('/index.html');
        })
    );

    return;
  }

  // ───────────────────────────────────────────────────────────
  // STATIC ASSETS → CACHE FIRST
  // ───────────────────────────────────────────────────────────
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then((response) => {
        if (response.ok) {
          const responseClone = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }

        return response;
      });
    })
  );
});