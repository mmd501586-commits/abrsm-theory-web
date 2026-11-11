// Optional progressive enhancement: normal study works without install support.
let registration;
let reloading = false;
function report(ready, message, updateAvailable = false) {
  const detail = { ready, message, updateAvailable };
  window.__PWA_STATUS = detail;
  window.dispatchEvent(new CustomEvent('pwa-status', { detail }));
}

async function start() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    report(false, '当前浏览方式可学习；离线使用需 HTTPS 网址或本机 localhost。');
    return;
  }
  report(false, '正在准备离线资料…');
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    const updateReady = () => report(true, '新版本已准备好，结束本次练习后可更新。', true);
    if (registration.waiting) updateReady();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) updateReady();
        if (worker.state === 'redundant') report(false, '离线资料未缓存完成，请联网后重试。');
      });
    });
    await navigator.serviceWorker.ready;
    if (registration.waiting) updateReady();
    else report(true, '离线资料已就绪，学习记录保存在本设备。');
  } catch {
    report(false, '离线缓存暂不可用；联网学习仍可继续。');
  }
}

window.addEventListener('pwa-apply-update', () => {
  if (!registration?.waiting) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) { reloading = true; window.location.reload(); }
  }, { once: true });
  registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
});

start();
