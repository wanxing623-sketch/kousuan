/* 只在用户选择离线包后安装；绝不在 install 里预取模型。缓存按 Pages 项目隔离。 */
const base = self.registration.scope;
const shellName = 'kousuan-shell-v1:' + base;
const packName = 'kousuan-voice:' + base;
const index = new URL('index.html', base).href;
const shell = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png']
  .map(name => new URL(name, base).href);

// Save a complete body with a fresh response, not the loader's HTTP/redirect state.
// In particular the offline document must be usable as a navigation after WebKit restarts.
async function saveShell(cache, url, response) {
  if (!response.ok) throw new Error('Cannot cache ' + url);
  const headers = new Headers(response.headers);
  // The body has already been decoded; retain CSP and other document policies.
  ['Content-Encoding', 'Content-Length', 'Cache-Control'].forEach(name => headers.delete(name));
  await cache.put(url, new Response(await response.arrayBuffer(), { headers }));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(shellName);
    await Promise.all(shell.map(async url => saveShell(cache, url, await fetch(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
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
        try { await saveShell(cache, index, res.clone()); } catch (_) { /* 保留旧副本 */ }
        return res;
      }
      return (await cache.match(index)) || res || Response.error();
    })());
  } else if (shell.indexOf(path) !== -1 && !url.search) {
    event.respondWith(caches.open(shellName).then(cache => cache.match(req)).then(hit => hit || fetch(req)));
  }
});
