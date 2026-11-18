/* 只在用户选择离线包后安装；绝不在 install 里预取模型。缓存按 Pages 项目隔离。 */
const base = self.registration.scope;
const shellName = 'kousuan-shell-v1:' + base;
const packName = 'kousuan-voice:' + base;
const index = new URL('index.html', base).href;
const shell = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png']
  .map(name => new URL(name, base).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(shellName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const path = url.origin + url.pathname;
  if (!url.search && path.indexOf(base + 'voice-assets/') === 0) {
    // 只执行安装器已经校验并完整保存的 JS / 模型；缓存被回收时不偷偷下载。
    event.respondWith(caches.open(packName).then(cache => cache.match(req)).then(hit => hit || Response.error()));
  } else if (req.mode === 'navigate' && (path === base || path === index)) {
    // HTML 内联 CSS/JS，联网优先拿新版；断网重开（含带查询参数的链接）回到同一入口。
    event.respondWith((async () => {
      const cache = await caches.open(shellName);
      let res;
      try { res = await fetch(req); } catch (_) { /* 断网 */ }
      if (res && res.ok) {
        // 即使空间已满、不能刷新离线副本，也不能挡住在线页面。
        try { await cache.put(index, res.clone()); } catch (_) { /* 保留旧副本 */ }
        return res;
      }
      return (await cache.match(index)) || res || Response.error();
    })());
  } else if (shell.indexOf(path) !== -1 && !url.search) {
    event.respondWith(caches.open(shellName).then(cache => cache.match(req)).then(hit => hit || fetch(req)));
  }
});
