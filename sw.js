/* Generated resource list is local. No analytics, remote requests or child data. */
importScripts('./precache.js');
const prefix = `abrsm-family-${new URL(self.registration.scope).pathname}-`;
const cacheName = prefix + self.__PRECACHE.version;
const resourceURLs = self.__PRECACHE.files.map(path => new URL(path, self.registration.scope).href);
const allowed = new Set(resourceURLs);
const indexURL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  // An incomplete download fails installation; never claim partial caching is ready.
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(resourceURLs)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(prefix) && name !== cacheName).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' && url.href.startsWith(self.registration.scope)) {
    event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(indexURL)) || fetch(event.request)));
    return;
  }
  url.search = '';
  if (!allowed.has(url.href)) return;
  event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(url.href)) || fetch(event.request)));
});
