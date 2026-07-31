const CACHE_NAME = 'decimen-offline-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Caches the main entry points
      return cache.addAll([
        '/',
        '/index.html',
        '/send/index.html',
        '/receive/index.html'
      ]);
    })
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});
