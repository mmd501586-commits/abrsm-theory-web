/* Generated resource list is local. No analytics, remote requests or child data. */
importScripts('./precache.js');
const prefix = `abrsm-family-${new URL(self.registration.scope).pathname}-`;
const cacheName = prefix + self.__PRECACHE.version;
const resourceURLs = self.__PRECACHE.files.map(path => new URL(path, self.registration.scope).href);
const allowed = new Set(resourceURLs);
const indexURL = new URL('./index.html', self.registration.scope).href;

// Media players may request byte ranges, including when the device is offline.
async function cachedResponse(cache, url, request) {
  const response = await cache.match(url);
  if (!response) return fetch(request);
  const range = request.headers.get('Range');
  if (!range || !url.endsWith('.mp3')) return response;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  // A server may ignore unsupported multi-range/malformed Range headers.
  if (!match || (!match[1] && !match[2])) return response;
  const bytes = await response.arrayBuffer();
  const size = bytes.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}});
  }
  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), {status: 206, headers});
}

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
  event.respondWith(caches.open(cacheName).then(cache => cachedResponse(cache, url.href, event.request)));
});
