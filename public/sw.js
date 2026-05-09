const CACHE = 'stock-alert-v34';
const STATIC = ['/', '/css/style.css', '/js/app.js', '/manifest.json', '/icons/logo.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(e.request).then(r => r || new Response(JSON.stringify({ error: '오프라인' }), {
          headers: { 'Content-Type': 'application/json' }
        }))
      )
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      });
      return cached || network;
    })
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch (_) {}
  const { title = 'NATO', body = '', tag = 'stock', icon = '/icons/logo.png' } = data;
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon,
      badge: '/icons/logo.png',
      vibrate: [200, 100, 200, 100, 200],
      requireInteraction: true,
      data: data.data || {},
      actions: [
        { action: 'open', title: '앱 열기' },
        { action: 'dismiss', title: '닫기' }
      ]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action !== 'dismiss') {
    e.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const existing = list.find(c => c.url.includes(self.location.origin));
        if (existing) return existing.focus();
        return clients.openWindow('/');
      })
    );
  }
});
