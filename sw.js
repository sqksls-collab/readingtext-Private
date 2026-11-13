// 송지희 국어 – 앱 설치용 서비스워커 (항상 최신 화면을 먼저 불러오고, 인터넷이 끊기면 저장해 둔 화면을 보여줌)
const CACHE = 'sjh-v8';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/logo-vertical.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});

// ---- 푸시 알림 ----
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: '송지희 국어', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '송지희 국어', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: d.tag, data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) { if ('focus' in w) { if (w.navigate) w.navigate(url); return w.focus(); } }
    return clients.openWindow(url);
  }));
});
