const CACHE_NAME = 'olm-pwa-v23';
const APP_SHELL = [
  '/giai-olm',
  '/js/deployment.js',
  '/manifest.json',
  '/css/app.css',
  '/css/brand.css',
  '/css/motion.css',
  '/icons/giaiolm-logo-v1.png',
  '/js/api.js',
  '/js/ui.js',
  '/js/app.js',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch((err) => {
      console.warn('[SW] Cache precache warning:', err);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith('olm-pwa-') && key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Bypass API calls, SSE events, and admin pages entirely - never intercept
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.includes('admin') ||
    url.pathname === '/quan-ly-key' ||
    url.search.includes('admin') ||
    url.pathname === '/events'
  ) {
    return;
  }

  // Only the solver uses the offline shell.
  if (event.request.mode === 'navigate') {
    if (!['/giai-olm', '/giai-olm.html'].includes(url.pathname)) return;
    event.respondWith(
      fetch(event.request).catch(async () => {
        try {
          const cached = await caches.match('/giai-olm');
          if (cached) return cached;
        } catch (e) {}
        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      })
    );
    return;
  }

  // Scripts and CSS: Network first to ensure instant updates, cache as fallback
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.json')) {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch((e) => {});
        }
        return response;
      }).catch(async () => {
        try {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(event.request, { ignoreSearch: true });
          if (cached) return cached;
        } catch (e) {}
        return new Response('', { status: 404 });
      })
    );
    return;
  }

  // Other assets (images, icons): Stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fresh = fetch(event.request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch((e) => {});
        }
        return response;
      }).catch(() => cached || new Response('', { status: 404 }));
      return cached || fresh;
    }).catch(() => new Response('', { status: 404 }))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/giai-olm');
    })
  );
});
