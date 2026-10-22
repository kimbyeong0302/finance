// 앱 껍데기를 캐시해 오프라인에서도 열리게 한다. 데이터는 IndexedDB에 있으므로 캐시하지 않는다.
// 파일을 바꾸면 VERSION을 올린다.
const VERSION = 'v13';
const CACHE = `my-finance-${VERSION}`;
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.json',
  'js/app.js', 'js/db.js', 'js/ledger.js', 'js/parse.js', 'js/settle.js', 'js/invest.js', 'js/prices.js', 'js/util.js', 'js/lock.js',
  'vendor/dexie.min.js', 'vendor/chart.umd.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('my-finance-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 같은 출처 파일만: 캐시 먼저 보여주고 뒤에서 새로 받아 캐시 갱신. 시세 API 등 외부 요청은 건드리지 않는다.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
