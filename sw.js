// 极简 Service Worker：缓存静态资源，让二次访问秒开
// 仅缓存 data / 图片。HTML / admin.html 不缓存(保证刷新拿到最新版本)
const CACHE = 'almath-v6';
const ASSETS = [
  './data-P1.js',
  './data-P2.js',
  './data-P3.js',
  './data-P4.js',
  './sponsor-qr.jpg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // 仅缓存同源资源
  if (u.origin !== location.origin) return;
  // 仅 GET
  if (e.request.method !== 'GET') return;
  // HTML 不走 SW 缓存(导航 / index.html / admin.html),保证用户刷新拿到最新版本
  if (e.request.mode === 'navigate' || u.pathname.endsWith('.html')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) {
        // 命中缓存：后台异步更新
        e.waitUntil(
          fetch(e.request).then(res => {
            if (res.ok) {
              return caches.open(CACHE).then(c => c.put(e.request, res.clone()));
            }
          }).catch(()=>{})
        );
        return cached;
      }
      // 未命中：网络+缓存
      return fetch(e.request).then(res => {
        if (res.ok && (res.type === 'basic' || res.type === 'default')) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(()=>{
        // 离线 fallback: 返回 index
        if (e.request.mode === 'navigate') return caches.match('./');
      });
    })
  );
});
