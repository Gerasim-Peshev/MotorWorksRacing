/* MotorWorks Racing service worker: app shell + tracks cached for offline play. */
const CACHE = 'mw-racing-v2';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  'js/ui.js', 'js/drive.js', 'js/scene.js', 'js/track.js', 'js/physics.js', 'js/parts.js', 'js/tables.js', 'js/carmodel.js', 'js/ai.js', 'js/input.js', 'js/audio.js', 'js/store.js', 'js/i18n.js', 'js/bg.js', 'js/bg2.js', 'js/vendor/three.module.min.js',
  'fonts/fonts.css', 'fonts/fira-sans-cyrillic-400-normal.woff2', 'fonts/fira-sans-cyrillic-500-normal.woff2', 'fonts/fira-sans-cyrillic-600-normal.woff2', 'fonts/fira-sans-cyrillic-700-normal.woff2', 'fonts/fira-sans-latin-400-normal.woff2', 'fonts/fira-sans-latin-500-normal.woff2', 'fonts/fira-sans-latin-600-normal.woff2', 'fonts/fira-sans-latin-700-normal.woff2', 'fonts/oswald-cyrillic-500-normal.woff2', 'fonts/oswald-cyrillic-600-normal.woff2', 'fonts/oswald-cyrillic-700-normal.woff2', 'fonts/oswald-latin-500-normal.woff2', 'fonts/oswald-latin-600-normal.woff2', 'fonts/oswald-latin-700-normal.woff2',
  'tracks/index.json', 'tracks/nordschleife.json', 'tracks/spa.json', 'tracks/suzuka.json', 'tracks/catalunya.json', 'tracks/redbullring.json', 'tracks/nurburgring-gp.json', 'tracks/a1motorpark.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())) });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())) });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(res => { if (res && (res.ok || res.type === 'opaque')) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)) } return res }).catch(() => hit);
    return hit || net;
  }));
});
