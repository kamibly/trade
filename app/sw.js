// Keeps the app's own files on the phone so Trade opens without a connection.
// Price APIs are other sites and pass straight through: a cached copy would
// hide real errors and show stale prices as if they were live.

const CACHE = 'trade-v38';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/backtest.js',
  './js/candles.js',
  './js/chart.js',
  './js/data.js',
  './js/fees.js',
  './js/filter.js',
  './js/forecast.js',
  './js/format.js',
  './js/indicators.js',
  './js/limiter.js',
  './js/notify.js',
  './js/paper.js',
  './js/portfolio.js',
  './js/scanner.js',
  './js/server.js',
  './js/setups.js',
  './js/ml.js',
  './js/signals.js',
  './js/storage.js',
  './vendor/lightweight-charts.standalone.production.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/badge-96.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // 'reload' skips the browser's HTTP cache so a new version never stores old files.
      .then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('trade-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Pages: try the network briefly so updates arrive, else the saved copy.
  // The saved copy also wins over an error page, so the app keeps working
  // when the site is down or taken offline (a 404 from GitHub Pages).
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const saved = await cache.match('./index.html');
      try {
        const res = await Promise.race([
          fetch(request),
          new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 4000)),
        ]);
        return res.ok || !saved ? res : saved;
      } catch {
        return saved || Response.error();
      }
    })());
    return;
  }

  // App files: the saved copy first; this version's files never change.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(hit => hit || fetch(request)),
  );
});

// Alerts from your OCI server while the app is closed.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Trade', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Trade', {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: data.tag || data.hash || 'trade',
    data: { hash: data.hash || 'signals', feedback: data.feedback || null },
    // Rate setup alerts right from the notification.
    actions: data.feedback ? [{ action: 'useful', title: 'Useful' }, { action: 'not-useful', title: 'Not useful' }] : [],
  }));
});

// Sends a rating to your server with the address and key the app saved.
async function sendRating(feedback, useful) {
  try {
    const cache = await caches.open('config-trade');
    const hit = await cache.match('./server-config');
    const cfg = hit ? await hit.json() : null;
    if (!cfg || !cfg.serverUrl || !cfg.serverKey) return;
    await fetch(`${cfg.serverUrl}/feedback`, {
      method: 'POST',
      headers: { 'X-API-Key': cfg.serverKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ setups: feedback.setups, id: feedback.id, useful }),
    });
  } catch { /* offline: the rating is lost, nothing else breaks */ }
}

// Tapping an alert opens the app on that symbol's chart; the buttons rate it.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const feedback = event.notification.data && event.notification.data.feedback;
  if (feedback && (event.action === 'useful' || event.action === 'not-useful')) {
    event.waitUntil(sendRating(feedback, event.action === 'useful'));
    return;
  }
  const hash = (event.notification.data && event.notification.data.hash) || 'signals';
  const url = new URL(`./#${hash}`, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => w.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      return open.navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});
