import { createState } from './core.js';

const DB_NAME = 'abrsm-theory-family';
const STORE = 'records';
const KEY = 'progress';
const LOCAL_KEY = 'abrsm-theory-progress-v1';
const BACKUP_KEY = 'progress-backups-v1';
const LOCAL_BACKUP_KEY = LOCAL_KEY + '-backups';
const MAX_BACKUPS = 3;
const LOCK_NAME = DB_NAME + '-progress-write';
let databasePromise;
let writeQueue = Promise.resolve();
let memoryState = null;
let revision = 0;
let baseline = null;
let protectionReason = null;
let status = {
  mode: 'initializing', durable: false, persisted: false,
  message: '正在读取本机学习记录。', lastError: null, reason: null,
};

const copy = value => structuredClone(value);
const messageOf = error => error instanceof Error ? error.message : String(error || '');
const fingerprint = value => JSON.stringify(value ?? null);
const orderRecords = (a, b) => b.revision - a.revision || (b.savedAt || 0) - (a.savedAt || 0);
const issue = (reason, message) => Object.assign(new Error(message), { reason });

export function storageStatus() { return { ...status }; }

function setMode(mode, message, error = null, reason = null) {
  status = { ...status, mode, durable: mode !== 'memory' && mode !== 'initializing',
    message, lastError: error ? messageOf(error) : null, reason };
}

function protect(reason, error) {
  protectionReason = reason;
  setMode('memory', reason === 'conflict'
    ? '另一个页面已更改本机记录。为保护已有记录，本页已停止保存；请先导出本页记录，再检查本机记录。'
    : '尚未可靠读到本机原记录，已停止写入以防覆盖。请保留浏览器数据，先检查本机记录并导出本页内容。', error, reason);
  return storageStatus();
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let request;
    let finished = false;
    const timeout = setTimeout(() => {
      finished = true;
      reject(new Error('本机数据库打开超时。'));
    }, 2500);
    const fail = error => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(error || new Error('无法打开本机数据库。'));
      }
    };
    try {
      if (!globalThis.indexedDB) { fail(new Error('当前浏览器不提供 IndexedDB。')); return; }
      request = globalThis.indexedDB.open(DB_NAME, 1);
    } catch (error) { fail(error); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error('另一个页面暂时阻塞了本机数据库。'));
    request.onsuccess = () => {
      if (finished) { request.result.close(); return; }
      finished = true;
      clearTimeout(timeout);
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = undefined; };
      resolve(database);
    };
  });
  // Retry a failed open on the next diagnostic, without allowing a failed load
  // to authorize writes. The protection flag is deliberately not cleared here.
  databasePromise.catch(() => { databasePromise = undefined; });
  return databasePromise;
}

function openExistingDatabase() {
  // Diagnostics never create a database or reuse/reset the writer's connection.
  // Opening without a version reads an existing database unchanged. If none
  // exists, abort the initial upgrade so no empty database is left behind.
  return new Promise((resolve, reject) => {
    let request;
    let finished = false;
    let missing = false;
    const timeout = setTimeout(() => finish(new Error('本机数据库检查超时。')), 2500);
    function finish(error, database = null) {
      if (finished) { database?.close(); return; }
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(database);
    }
    try {
      if (!globalThis.indexedDB) { finish(new Error('当前浏览器不提供 IndexedDB。')); return; }
      request = globalThis.indexedDB.open(DB_NAME);
    } catch (error) { finish(error); return; }
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction.abort();
    };
    request.onerror = event => {
      if (missing) { event.preventDefault(); finish(null); }
      else finish(request.error || new Error('无法检查本机数据库。'));
    };
    request.onblocked = () => finish(new Error('另一个页面暂时阻塞了本机数据库。'));
    request.onsuccess = () => finish(null, request.result);
  });
}

async function readDatabase(key = KEY, { existingOnly = false } = {}) {
  const database = await (existingOnly ? openExistingDatabase() : openDatabase());
  if (!database) return null;
  try { return await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(key);
    let value;
    request.onsuccess = () => { value = request.result ?? null; };
    request.onerror = () => reject(request.error || new Error('读取失败。'));
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error || new Error('读取失败。'));
    transaction.onabort = () => reject(transaction.error || new Error('读取中止。'));
  }); } finally { if (existingOnly) database.close(); }
}

function validState(value) {
  return value && value.schemaVersion === 1 && typeof value.datasetVersion === 'string' &&
    value.settings && Number.isInteger(value.settings.dailyNew) && Number.isFinite(value.settings.examMinutes) &&
    value.learned && value.skills && value.lastSeen && Array.isArray(value.history) && Array.isArray(value.exams) &&
    Object.prototype.hasOwnProperty.call(value, 'activeSession');
}

function unwrap(value) {
  if (value === null || value === undefined) return null;
  if (value.storageVersion === 1 && Number.isInteger(value.revision) && value.revision >= 0 && validState(value.state)) return value;
  if (validState(value)) return { storageVersion: 1, revision: 0, savedAt: 0, state: value };
  throw new Error('本机记录格式损坏，原记录未被覆盖。');
}

function unwrapBackups(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('本机历史副本格式损坏，原副本未被覆盖。');
  return raw.map(value => {
    const record = unwrap(value);
    if (!record) throw new Error('本机历史副本格式损坏，原副本未被覆盖。');
    return record;
  });
}

async function databaseSource() {
  let raw;
  try {
    if (!globalThis.indexedDB) return { kind: 'unavailable', raw: null, record: null };
    raw = await readDatabase();
    return { kind: 'readable', raw, record: unwrap(raw) };
  } catch (error) { return { kind: raw === undefined ? 'error' : 'invalid', raw, error }; }
}

function localSource() {
  let raw;
  try {
    if (!globalThis.localStorage) return { kind: 'unavailable', raw: null, record: null };
    raw = globalThis.localStorage.getItem(LOCAL_KEY);
    return { kind: 'readable', raw, record: raw === null ? null : unwrap(JSON.parse(raw)) };
  } catch (error) { return { kind: raw === undefined ? 'error' : 'invalid', raw, error }; }
}

export async function loadState(version = '') {
  await writeQueue;
  // Never replace uncommitted page answers with an older persistent copy.
  if (memoryState && (protectionReason || status.mode === 'memory')) return copy(memoryState);
  const database = await databaseSource();
  const local = localSource();
  const existing = [database.record, local.record].filter(Boolean).sort(orderRecords)[0];
  memoryState = existing ? copy(existing.state) : (memoryState || createState(version));
  revision = existing?.revision || 0;
  baseline = { database, local };
  const uncertain = [database, local].find(source => source.kind === 'error' || source.kind === 'invalid');
  if (uncertain) protect('read-uncertain', uncertain.error);
  else if (database.kind === 'readable') {
    setMode('indexeddb', existing === local.record && existing !== database.record
      ? '已从本机备用存储读取记录。建议导出备份。'
      : '学习记录保存在本机。建议定期导出备份。');
  } else if (local.kind === 'readable') {
    try {
      const testKey = LOCAL_KEY + '-write-test';
      globalThis.localStorage.setItem(testKey, '1');
      globalThis.localStorage.removeItem(testKey);
      setMode('localstorage', '已使用本机备用存储。建议导出备份。');
    } catch (error) { setMode('memory', '浏览器禁止保存。当前记录仅在此页面暂存，关闭前请导出备份。', error, 'save-failed'); }
  } else protect('read-uncertain', new Error('当前浏览器不提供可读取的本机存储。'));
  try { status.persisted = Boolean(await globalThis.navigator?.storage?.persisted?.()); } catch { /* Optional. */ }
  return copy(memoryState);
}

function assertDatabaseBaseline(raw) {
  if (fingerprint(raw) !== fingerprint(baseline.database.raw)) {
    throw issue('conflict', '本机数据库已被另一个页面更改。');
  }
}

function assertLocalBaseline() {
  if (baseline.local.kind === 'unavailable') return;
  let raw;
  try { raw = globalThis.localStorage.getItem(LOCAL_KEY); }
  catch (error) { throw issue('read-uncertain', messageOf(error)); }
  if (raw !== baseline.local.raw) throw issue('conflict', '本机备用记录已被另一个页面更改。');
}

function localBackups() {
  if (baseline.local.kind === 'unavailable') return [];
  const raw = globalThis.localStorage.getItem(LOCAL_BACKUP_KEY);
  return unwrapBackups(raw === null ? null : JSON.parse(raw));
}

function backupList(value, databaseRaw, databaseBackups, localHistory) {
  const candidates = [unwrap(databaseRaw), baseline.local.record].filter(Boolean).sort(orderRecords);
  const seen = new Set([fingerprint(value.state)]);
  return [...candidates, ...databaseBackups, ...localHistory].filter(record => {
    const key = fingerprint(record.state);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_BACKUPS).map(copy);
}

// The comparison and both IndexedDB writes share one readwrite transaction.
// A stale page must never write the localStorage mirror before this commits.
async function commitDatabase(value, clearBackups, localHistory) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    let failure;
    let checked = false;
    let backups = [];
    const stop = error => {
      // Synchronous put/delete failures happen after the baseline was checked,
      // just like asynchronous write aborts; they are not failed reads.
      failure = error.reason ? error : issue(checked ? 'save-failed' : 'read-uncertain', messageOf(error));
      transaction.abort();
    };
    const request = store.get(KEY);
    request.onerror = () => { failure = issue('read-uncertain', messageOf(request.error)); };
    request.onsuccess = () => {
      try {
        assertDatabaseBaseline(request.result ?? null);
        assertLocalBaseline();
        if (clearBackups) {
          checked = true;
          store.put(value, KEY);
          store.delete(BACKUP_KEY);
          return;
        }
        const backupRequest = store.get(BACKUP_KEY);
        backupRequest.onerror = () => { failure = issue('read-uncertain', messageOf(backupRequest.error)); };
        backupRequest.onsuccess = () => {
          try {
            assertLocalBaseline();
            backups = backupList(value, request.result ?? null, unwrapBackups(backupRequest.result), localHistory);
            checked = true;
            store.put(backups, BACKUP_KEY);
            store.put(value, KEY);
          } catch (error) { stop(error); }
        };
      } catch (error) { stop(error); }
    };
    transaction.oncomplete = () => resolve(backups);
    const failed = () => reject(failure || issue(checked ? 'save-failed' : 'read-uncertain',
      messageOf(transaction.error) || '数据库写入中止。'));
    transaction.onerror = failed;
    transaction.onabort = failed;
  });
}

function commitLocal(value, backups, clearBackups) {
  assertLocalBaseline();
  const local = globalThis.localStorage;
  const serialized = JSON.stringify(value);
  if (!clearBackups) {
    // A backup failure stops a local-only write, preserving the current record.
    local.setItem(LOCAL_BACKUP_KEY, JSON.stringify(backups));
  }
  // This second check catches changes made while the backup was being written.
  assertLocalBaseline();
  local.setItem(LOCAL_KEY, serialized);
  if (local.getItem(LOCAL_KEY) !== serialized) throw issue('conflict', '保存时另一个页面更新了备用记录。');
  baseline.local = { kind: 'readable', raw: serialized, record: copy(value) };
  if (clearBackups) local.removeItem(LOCAL_BACKUP_KEY);
}

// If the database rejected a write (e.g. quota), do not blindly fall back to
// localStorage: read/check it again while a readonly transaction holds its view.
async function commitFallback(value, backups, clearBackups) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(KEY);
    let failure;
    request.onerror = () => { failure = issue('read-uncertain', messageOf(request.error)); };
    request.onsuccess = () => {
      try { assertDatabaseBaseline(request.result ?? null); commitLocal(value, backups, clearBackups); }
      catch (error) { failure = error; }
    };
    transaction.oncomplete = () => failure ? reject(failure) : resolve();
    transaction.onerror = () => reject(failure || issue('read-uncertain', '重新读取本机数据库失败。'));
    transaction.onabort = () => reject(failure || issue('read-uncertain', '重新读取本机数据库中止。'));
  });
}

async function guardedSave(snapshot, clearBackups) {
  if (!baseline) return protect('read-uncertain', new Error('尚未读取本机记录。'));
  if (protectionReason) return storageStatus();
  let histories;
  try {
    assertLocalBaseline();
    histories = clearBackups ? [] : localBackups();
  } catch (error) { return protect(error.reason || 'read-uncertain', error); }
  const value = { storageVersion: 1, revision: revision + 1, savedAt: Date.now(), state: snapshot };
  let backups = backupList(value, baseline.database.raw, [], histories);
  if (baseline.database.kind === 'readable') {
    try {
      backups = await commitDatabase(value, clearBackups, histories);
    } catch (error) {
      if (error.reason !== 'save-failed') return protect(error.reason || 'read-uncertain', error);
      if (clearBackups) {
        // A local-only clear cannot erase the database or its historical copies.
        // Leave both stores intact rather than report a partial clear as success.
        setMode('memory', '本机数据库未能清空，原记录和历史副本仍保留。请检查本机记录；清空操作尚未完成。', error, 'save-failed');
        return storageStatus();
      }
      if (baseline.local.kind === 'readable') {
        try {
          await commitFallback(value, backups, clearBackups);
          revision = value.revision;
          setMode('localstorage', '已使用本机备用存储。建议导出备份。', error);
          return storageStatus();
        } catch (fallbackError) { error = fallbackError; }
      }
      if (error.reason === 'conflict' || error.reason === 'read-uncertain') return protect(error.reason, error);
      setMode('memory', '保存失败，当前更改只在本页暂存。关闭前请导出备份。', error, 'save-failed');
      return storageStatus();
    }
    baseline.database = { kind: 'readable', raw: copy(value), record: copy(value) };
    revision = value.revision;
    if (baseline.local.kind === 'readable') {
      try { commitLocal(value, backups, clearBackups); }
      catch (error) {
        if (error.reason === 'conflict' || error.reason === 'read-uncertain') return protect(error.reason, error);
        if (clearBackups) {
          setMode('memory', '当前数据库已清空，但备用存储未能完整清除。请检查本机记录；清空操作尚未完成。', error, 'save-failed');
          return storageStatus();
        }
        setMode('indexeddb', '学习记录已保存在本机数据库，备用副本写入失败。建议导出备份。', error);
        return storageStatus();
      }
    }
    setMode('indexeddb', '学习记录保存在本机。建议定期导出备份。');
  } else {
    try {
      commitLocal(value, backups, clearBackups);
      revision = value.revision;
      setMode('localstorage', '已使用本机备用存储。建议导出备份。');
    } catch (error) {
      if (error.reason === 'conflict' || error.reason === 'read-uncertain') return protect(error.reason, error);
      setMode('memory', '保存失败，当前更改只在本页暂存。关闭前请导出备份。', error, 'save-failed');
    }
  }
  return storageStatus();
}

export function saveState(state, { clearBackups = false } = {}) {
  if (!validState(state)) return Promise.reject(new Error('学习记录格式无效，未写入存储。'));
  const snapshot = copy(state);
  const operation = async () => {
    memoryState = copy(snapshot);
    // Web Locks serialize cooperating pages. IndexedDB still uses transaction
    // CAS; older browsers retain synchronous local checks/readback as fallback.
    const locks = globalThis.navigator?.locks;
    return locks?.request
      ? locks.request(LOCK_NAME, () => guardedSave(snapshot, clearBackups))
      : guardedSave(snapshot, clearBackups);
  };
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => {}, () => {});
  return result;
}

function describeSource(id, label, raw, isLocal = false) {
  try {
    const value = isLocal && raw !== null ? JSON.parse(raw) : raw;
    const record = unwrap(value);
    if (!record) return { id, label, status: 'missing' };
    const state = copy(record.state);
    return { id, label, status: 'available', raw: copy(raw), state, revision: record.revision,
      savedAt: record.savedAt || 0, historyCount: state.history.length,
      skillsCount: Object.keys(state.skills).length, learnedCount: Object.keys(state.learned).length,
      examCount: state.exams.length, quizCount: state.quizzes?.length || 0 };
  } catch (error) { return { id, label, status: 'invalid', raw: copy(raw), error: messageOf(error) }; }
}

function describeBackups(id, label, raw, isLocal = false) {
  if (raw === null || raw === undefined) return [{ id, label, status: 'missing' }];
  try {
    const values = isLocal ? JSON.parse(raw) : raw;
    if (!Array.isArray(values)) throw new Error('历史副本格式无法读取。');
    if (!values.length) return [{ id, label, status: 'missing' }];
    return values.map((value, index) => describeSource(`${id}-${index}`, `${label} ${index + 1}`, value));
  } catch (error) { return [{ id, label, status: 'invalid', raw: copy(raw), error: messageOf(error) }]; }
}

export async function inspectStoredProgress() {
  // Deliberately does not call loadState, update a baseline, or repair replicas.
  // Inspection must not turn a conflicted page into an authorized writer.
  await writeQueue;
  const sources = [];
  if (memoryState) sources.push(describeSource('memory', '当前页面', recordForMemory()));
  else sources.push({ id: 'memory', label: '当前页面', status: 'missing' });
  for (const [key, id, label, history] of [
    [KEY, 'indexeddb', '本机数据库', false], [BACKUP_KEY, 'indexeddb-backup', '数据库历史副本', true],
  ]) {
    try {
      if (!globalThis.indexedDB) throw new Error('当前浏览器不提供 IndexedDB。');
      const raw = await readDatabase(key, { existingOnly: true });
      sources.push(...(history ? describeBackups(id, label, raw) : [describeSource(id, label, raw)]));
    } catch (error) { sources.push({ id, label, status: 'error', error: messageOf(error) }); }
  }
  for (const [key, id, label, history] of [
    [LOCAL_KEY, 'localstorage', '本机备用存储', false], [LOCAL_BACKUP_KEY, 'localstorage-backup', '备用存储历史副本', true],
  ]) {
    try {
      const raw = globalThis.localStorage.getItem(key);
      sources.push(...(history ? describeBackups(id, label, raw, true) : [describeSource(id, label, raw, true)]));
    } catch (error) { sources.push({ id, label, status: 'error', error: messageOf(error) }); }
  }
  return { sources, checkedAt: Date.now() };
}

function recordForMemory() { return { storageVersion: 1, revision, savedAt: 0, state: memoryState }; }

export async function requestPersistence() {
  try { status.persisted = Boolean(await globalThis.navigator?.storage?.persist?.()); }
  catch (error) { status.lastError = messageOf(error); }
  return status.persisted;
}
