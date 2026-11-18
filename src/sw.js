/* 只在用户选择离线包后启用；从与页面相同的 IndexedDB 读取资源，不预取模型。 */
const base = self.registration.scope;
const store = createVoiceStore(base);
const index = new URL('index.html', base).href;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const path = url.origin + url.pathname;
  if (!url.search && path.indexOf(base + 'voice-assets/') === 0) {
    // 只执行安装器已经校验并完整保存的 JS / 模型；缓存被回收时不偷偷下载。
    event.respondWith(store.match(req.url).then(hit => hit || Response.error()));
  } else if (req.mode === 'navigate' && (path === base || path === index)) {
    event.respondWith((async () => {
      let res;
      try { res = await fetch(req); } catch (_) { /* 断网 */ }
      if (res && res.ok) {
        // 在线页面优先。不覆盖旧的可用副本，除非新页面成功写入。
        try { await store.putResponse(index, res.clone()); } catch (_) { /* 空间不足也能在线使用 */ }
        return res;
      }
      return (await store.match(index)) || res || Response.error();
    })());
  } else if (!url.search && path.indexOf(base) === 0 && ['manifest', 'image'].indexOf(req.destination) !== -1) {
    event.respondWith(store.match(req.url).then(hit => hit || fetch(req)));
  }
});
