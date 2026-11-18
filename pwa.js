// Optional progressive enhancement: normal study works without install support.
// This module never reloads a page. The app owns the save-before-switch boundary.
let registration;
let registrationPromise;
let checking;
let availableWorker;
let activationPromise;
let finishActivation;
let reloadRequired = false;
let previousController = navigator.serviceWorker?.controller || null;
let lastCheckAt = Date.now();
const observedWorkers = new WeakSet();
const FOREGROUND_CHECK_INTERVAL = 5 * 60 * 1000;
const INSTALL_TIMEOUT = 90000;

function report(state, message, updateAvailable = false) {
  const detail = {
    ready: Boolean(registration?.active || navigator.serviceWorker?.controller),
    state, message, updateAvailable, reloadRequired,
  };
  window.__PWA_STATUS = detail;
  window.dispatchEvent(new CustomEvent('pwa-status', { detail }));
  return detail;
}

function waitingWorker() {
  const waiting = registration?.waiting;
  return waiting?.state === 'installed' ? waiting : availableWorker?.state === 'installed' ? availableWorker : null;
}

function reportAvailable() {
  return report('available', reloadRequired
    ? '新版已在其他页面启用。保存本页进度后，即可安全切换。'
    : '新版本已准备好，可以保存当前进度后更新。', true);
}

function reportCurrent(message = '离线资料已就绪。当前没有待更新版本。') {
  if (reloadRequired || waitingWorker()) return reportAvailable();
  if (registration?.installing) return report('installing', '正在下载新版离线资料，可继续学习。');
  return report('current', message);
}

function watchWorker(worker) {
  if (!worker || observedWorkers.has(worker)) return;
  observedWorkers.add(worker);
  const changed = () => {
    if (worker.state === 'installed') {
      if (navigator.serviceWorker.controller) {
        availableWorker = worker;
        reportAvailable();
      } else report('installing', '离线资料已下载，正在完成首次准备…');
    } else if (worker.state === 'activated') {
      if (!activationPromise) reportCurrent();
    } else if (worker.state === 'redundant') {
      if (availableWorker === worker) availableWorker = null;
      if (reloadRequired || waitingWorker()) reportAvailable();
      else report('error', '新版安装未完成，当前学习和记录保留。请联网后重新检查更新。');
    } else if (worker.state === 'installing') {
      report('installing', '正在下载新版离线资料，可继续学习。');
    }
  };
  worker.addEventListener('statechange', changed);
  changed();
}

async function ensureRegistration() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    report('unsupported', '当前浏览方式不支持应用内更新。请用 HTTPS 原网址打开；本页仍可学习。');
    return null;
  }
  if (registration) return registration;
  if (registrationPromise) return registrationPromise;
  registrationPromise = (async () => {
    try {
      report('checking', '正在检查离线资源和应用更新…');
      registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      registration.addEventListener('updatefound', () => watchWorker(registration.installing));
      // register() may return after updatefound; observe an already installing worker too.
      watchWorker(registration.installing);
      if (waitingWorker()) reportAvailable();
      else if (!registration.installing) reportCurrent();
      navigator.serviceWorker.ready.then(() => {
        if (!checking && !activationPromise && window.__PWA_STATUS?.state !== 'error') reportCurrent();
      }).catch(() => {});
      return registration;
    } catch {
      report(navigator.onLine === false ? 'offline' : 'error', navigator.onLine === false
        ? '当前离线，无法检查新版。已缓存的学习内容仍可使用，联网后可重试。'
        : '暂时无法检查更新，当前学习和记录保留。请稍后重试。');
      return null;
    } finally { registrationPromise = null; }
  })();
  return registrationPromise;
}

function waitForInstallation(worker) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); worker.removeEventListener('statechange', changed); };
    const changed = () => {
      if (['installed', 'activated'].includes(worker.state)) { cleanup(); resolve(); }
      else if (worker.state === 'redundant') { cleanup(); reject(new Error('installation-failed')); }
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('installation-timeout')); }, INSTALL_TIMEOUT);
    worker.addEventListener('statechange', changed);
    changed();
  });
}

export function checkForUpdate() {
  if (checking) return checking;
  checking = (async () => {
    lastCheckAt = Date.now();
    const current = await ensureRegistration();
    if (!current) return window.__PWA_STATUS;
    if (reloadRequired || waitingWorker()) return reportAvailable();
    if (navigator.onLine === false) return report('offline', '当前离线，无法检查新版。已缓存的学习内容仍可使用，联网后可重试。');
    report('checking', '正在检查是否有新版本…');
    try {
      await current.update();
      // update() resolves before installation is necessarily complete.
      const worker = current.installing;
      if (worker) { watchWorker(worker); await waitForInstallation(worker); }
      return reportCurrent();
    } catch {
      if (reloadRequired || waitingWorker()) return reportAvailable();
      return report(navigator.onLine === false ? 'offline' : 'error', navigator.onLine === false
        ? '连接已断开，未能完成更新检查。当前进度保留，联网后可重试。'
        : '检查或安装新版未完成，当前学习和记录保留。请稍后重新检查。');
    }
  })().finally(() => { checking = null; });
  return checking;
}

export function applyUpdate() {
  if (activationPromise) return activationPromise;
  // Another tab may already have activated the worker. The caller must still save.
  if (reloadRequired) return Promise.resolve({ activated: true });
  const worker = waitingWorker();
  if (!worker) return Promise.reject(new Error('新版尚未准备完成，请先检查更新后重试。'));
  activationPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finishActivation = null;
      reportAvailable();
      reject(new Error('新版尚未完成切换，当前进度已保存。可稍后重试。'));
    }, 20000);
    finishActivation = () => { clearTimeout(timeout); finishActivation = null; resolve({ activated: true }); };
    report('activating', '进度已保存，正在切换新版…', true);
    try { worker.postMessage({ type: 'ACTIVATE_UPDATE' }); }
    catch (error) { clearTimeout(timeout); finishActivation = null; reject(error); }
  }).finally(() => { activationPromise = null; });
  return activationPromise;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const current = navigator.serviceWorker.controller;
    const replaced = previousController && current !== previousController;
    previousController = current;
    if (replaced || finishActivation) {
      reloadRequired = true;
      availableWorker = null;
      if (finishActivation) finishActivation();
      else reportAvailable();
    } else reportCurrent();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastCheckAt >= FOREGROUND_CHECK_INTERVAL && !activationPromise) checkForUpdate();
});
window.addEventListener('online', () => {
  if (document.visibilityState === 'visible' && window.__PWA_STATUS?.state === 'offline') checkForUpdate();
});

ensureRegistration();
