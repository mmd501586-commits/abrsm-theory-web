import { createState } from './core.js';

const DB_NAME = 'abrsm-theory-family';
const STORE = 'records';
const KEY = 'progress';
const LOCAL_KEY = 'abrsm-theory-progress-v1';
let databasePromise;
let writeQueue = Promise.resolve();
let memoryState = null;
let revision = 0;
let corruptedOnly = false;
let status = {
  mode: 'initializing', durable: false, persisted: false,
  message: '正在读取本机学习记录。', lastError: null,
};

const copy = value => structuredClone(value);
const messageOf = error => error instanceof Error ? error.message : String(error || '');

export function storageStatus() { return { ...status }; }

function setMode(mode, message, error = null) {
  status = { ...status, mode, durable: mode !== 'memory' && mode !== 'initializing', message, lastError: error ? messageOf(error) : null };
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器不提供 IndexedDB。')); return; }
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
    try { request = globalThis.indexedDB.open(DB_NAME, 1); } catch (error) { fail(error); return; }
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
  // Keep a rejected attempt from becoming an unhandled promise; callers still receive it.
  databasePromise.catch(() => {});
  return databasePromise;
}

async function readDatabase() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error || new Error('读取中止。'));
  });
}

async function writeDatabase(value, key = KEY) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('数据库写入失败。'));
    transaction.onabort = () => reject(transaction.error || new Error('数据库写入中止。'));
  });
}

function readLocal() {
  const raw = globalThis.localStorage.getItem(LOCAL_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function writeLocal(value) { globalThis.localStorage.setItem(LOCAL_KEY, JSON.stringify(value)); }

function validState(value) {
  return value && value.schemaVersion === 1 && typeof value.datasetVersion === 'string' &&
    value.settings && Number.isInteger(value.settings.dailyNew) && Number.isFinite(value.settings.examMinutes) &&
    value.learned && value.skills && value.lastSeen && Array.isArray(value.history) && Array.isArray(value.exams) &&
    Object.prototype.hasOwnProperty.call(value, 'activeSession');
}

function unwrap(value) {
  if (!value) return null;
  if (value.storageVersion === 1 && Number.isInteger(value.revision) && value.revision >= 0 && validState(value.state)) return value;
  if (validState(value)) return { storageVersion: 1, revision: 0, savedAt: 0, state: value };
  throw new Error('本机记录格式损坏，原记录未被覆盖。');
}

export async function loadState(version = '') {
  await writeQueue;
  // A failed write may leave an older durable snapshot behind. Do not let a
  // second in-page load replace the newer unsaved answers with that old copy.
  if (memoryState && (corruptedOnly || status.mode === 'memory')) return copy(memoryState);
  let databaseRaw = null;
  let localRaw = null;
  let databaseError = null;
  let localError = null;
  let databaseRecord = null;
  let localRecord = null;
  try { databaseRaw = await readDatabase(); databaseRecord = unwrap(databaseRaw); } catch (error) { databaseError = error; }
  try { localRaw = readLocal(); localRecord = unwrap(localRaw); } catch (error) { localError = error; }
  const existing = [databaseRecord, localRecord].filter(Boolean).sort((a, b) => b.revision - a.revision || b.savedAt - a.savedAt)[0];
  if (existing) {
    memoryState = copy(existing.state);
    revision = existing.revision;
    const fromDatabase = existing === databaseRecord;
    setMode(fromDatabase ? 'indexeddb' : 'localstorage',
      fromDatabase ? '学习记录保存在本机。建议定期导出备份。' : '已从本机备用存储恢复记录。建议导出备份。', databaseError);
    // Repair an older durable copy only on the next explicit save, never during load.
  } else {
    const hasCorruption = Boolean(databaseRaw || localRaw ||
      (localError && /JSON|Unexpected|格式|token|property/i.test(messageOf(localError))));
    if (hasCorruption) {
      corruptedOnly = true;
      memoryState = createState(version);
      setMode('memory', '本机原记录无法读取，已保留且未覆盖。当前为临时模式，请保留原浏览器数据并先导出本次记录。', localError || databaseError);
    } else {
      memoryState = memoryState || createState(version);
      if (!databaseError) setMode('indexeddb', '学习记录保存在本机。建议定期导出备份。');
      else if (!localError) {
        try {
          // A successful read alone does not prove storage is writable (private mode/quota).
          const testKey = LOCAL_KEY + '-write-test';
          globalThis.localStorage.setItem(testKey, '1');
          globalThis.localStorage.removeItem(testKey);
          setMode('localstorage', '已使用本机备用存储。建议导出备份。', databaseError);
        } catch (error) { setMode('memory', '浏览器禁止保存。当前记录仅在此页面暂存，关闭前请导出备份。', error); }
      } else setMode('memory', '浏览器禁止保存。当前记录仅在此页面暂存，关闭前请导出备份。', localError);
    }
  }
  try { status.persisted = Boolean(await globalThis.navigator?.storage?.persisted?.()); } catch { /* Persistence support is optional. */ }
  return copy(memoryState);
}

export function saveState(state) {
  if (!validState(state)) return Promise.reject(new Error('学习记录格式无效，未写入存储。'));
  const snapshot = copy(state);
  // Snapshot at call time, then serialize writes to prevent an earlier slow write overwriting a newer answer.
  const operation = async () => {
    memoryState = copy(snapshot);
    if (corruptedOnly) return storageStatus();
    revision += 1;
    const value = { storageVersion: 1, revision, savedAt: Date.now(), state: snapshot };
    let localSaved = false;
    let localError = null;
    try { writeLocal(value); localSaved = true; } catch (error) { localError = error; }
    try {
      await writeDatabase(value);
      setMode('indexeddb', '学习记录保存在本机。建议定期导出备份。');
    } catch (error) {
      if (localSaved) setMode('localstorage', '已使用本机备用存储。建议导出备份。', error);
      else setMode('memory', '保存失败，当前记录仅在此页面暂存。关闭前请导出备份。', localError || error);
    }
    return storageStatus();
  };
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => {}, () => {});
  return result;
}

export async function requestPersistence() {
  try {
    status.persisted = Boolean(await globalThis.navigator?.storage?.persist?.());
  } catch (error) { status.lastError = messageOf(error); }
  return status.persisted;
}
