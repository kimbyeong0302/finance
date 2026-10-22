// 앱 껍데기를 캐시해 오프라인에서도 열리게 한다. 데이터는 IndexedDB에 있으므로 캐시하지 않는다.
// 파일을 바꾸면 VERSION을 올린다.
const VERSION = 'v14';
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

// 같은 출처 파일만: 네트워크 먼저(새 버전을 바로 받는다), 안 되면(오프라인·느린 연결) 캐시.
// 예전에는 캐시를 먼저 보여 줘서, 홈 화면 앱이 고친 코드를 한참 동안 받지 못했다.
// 시세 API 등 외부 요청은 건드리지 않는다.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromNetwork = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    try {
      const res = await Promise.race([fromNetwork, timeout]);
      if (res) return res;
    } catch { /* 오프라인 */ }
    const cached = await cache.match(e.request, { ignoreSearch: true });
    return cached || fromNetwork;
  })());
});
