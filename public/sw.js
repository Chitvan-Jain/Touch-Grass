// Keeps the app page and fonts on the phone so it opens with no signal (D31). API calls are never cached.
const C = 'grassroots-v1';
const FILES = ['/', '/fonts/barlow-condensed-latin-700-normal.woff2', '/fonts/barlow-condensed-latin-800-normal.woff2',
  '/fonts/space-mono-latin-400-normal.woff2', '/fonts/space-mono-latin-700-normal.woff2', '/fonts/inter-latin-400-normal.woff2', '/fonts/inter-latin-600-normal.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => Promise.all(FILES.map(u => c.add(u).catch(() => {}))))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(m => m || caches.match('/'))));
});
