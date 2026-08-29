const CACHE = 'myservice-admin-v6';
const SHELL = [
  './index.html',
  './style.css?v=20260829-2',
  './app.js?v=20260829-2',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 网络优先，失败时回退缓存（保证 socket.io 等实时请求不被缓存干扰）
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ---------- Web Push ----------
self.addEventListener('push', (e) => {
  let data = { title: '新客服消息', body: '', url: './index.html' };
  try { data = Object.assign(data, e.data.json()); } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: data.url },
      tag: 'myservice-msg', // 同一个tag会替换掉上一条，不会堆一堆通知
      renotify: true
    })
  );
});

// 点击通知：优先复用已经打开的窗口，用postMessage告诉它内部切到指定会话(不产生页面跳转，
// 不会往历史记录里堆条目，避免"多点几个不同的推送通知"之后返回时历史记录乱掉、
// 触发iOS那个跳出scope弹简化浏览器视图的老问题)；真的没有已打开的窗口才新开一个。
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || './index.html';
  let convId = '';
  try { convId = new URL(targetUrl, self.location.href).searchParams.get('conv') || ''; } catch (err) {}

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if (convId) client.postMessage({ type: 'open-conversation', conversationId: convId });
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
