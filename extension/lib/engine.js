// Translation engine: Google Translate's free web endpoint (the same engine
// Chrome's built-in translate uses), with batching, retries, a concurrency cap
// and a cache (memory + IndexedDB) so re-opening a paper is instant.
//
// ES module, used by the service worker (for web pages) and by the PDF viewer.

const T_ENDPOINT = 'https://translate.googleapis.com/translate_a/t';
const SINGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

const MAX_CHARS_PER_REQUEST = 4000;
const MAX_ITEMS_PER_REQUEST = 50;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 30000;

class HttpError extends Error {
  constructor(status) {
    super(status === 429
      ? 'Google Translate is rate-limiting requests (HTTP 429). Wait a minute and try again.'
      : `Translation service returned HTTP ${status}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- limiter
let activeRequests = 0;
const waiting = [];
function acquire() {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); // hand the slot over directly
  else activeRequests--;
}
async function withSlot(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- cache
const mem = new Map();
const MEM_MAX = 8000;
function memGet(k) {
  const v = mem.get(k);
  if (v !== undefined) {
    mem.delete(k);
    mem.set(k, v);
  }
  return v;
}
function memSet(k, v) {
  mem.set(k, v);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

const DB_MAX_ENTRIES = 40000;
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open('ptx-translation-cache', 1);
      } catch (e) {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('tr', { keyPath: 'k' });
        store.createIndex('t', 't');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

async function dbGetMany(keys) {
  const out = new Map();
  const db = await openDb();
  if (!db || !keys.length) return out;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction('tr', 'readonly');
    } catch (e) {
      resolve(out);
      return;
    }
    const store = tx.objectStore('tr');
    for (const k of keys) {
      const r = store.get(k);
      r.onsuccess = () => {
        if (r.result) out.set(k, r.result.v);
      };
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => resolve(out);
    tx.onabort = () => resolve(out);
  });
}

let putsSincePrune = 0;
async function dbPutMany(entries) {
  const db = await openDb();
  if (!db || !entries.length) return;
  await new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction('tr', 'readwrite');
    } catch (e) {
      resolve();
      return;
    }
    const store = tx.objectStore('tr');
    const now = Date.now();
    for (const [k, v] of entries) store.put({ k, v, t: now });
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
  if (++putsSincePrune >= 40) {
    putsSincePrune = 0;
    pruneDb(db);
  }
}

function pruneDb(db) {
  try {
    const tx = db.transaction('tr', 'readwrite');
    const store = tx.objectStore('tr');
    const countReq = store.count();
    countReq.onsuccess = () => {
      const excess = countReq.result - DB_MAX_ENTRIES;
      if (excess <= 0) return;
      let removed = 0;
      const target = excess + Math.floor(DB_MAX_ENTRIES / 10);
      store.index('t').openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && removed < target) {
          cursor.delete();
          removed++;
          cursor.continue();
        }
      };
    };
  } catch (e) {
    /* ignore */
  }
}

export async function clearCache() {
  mem.clear();
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction('tr', 'readwrite');
    tx.objectStore('tr').clear();
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

// ---------------------------------------------------------------- network
async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Translation request timed out');
    throw new Error('Network error while contacting Google Translate');
  } finally {
    clearTimeout(timer);
  }
}

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };

// Batch endpoint: one request, many strings, one translation per string.
async function requestBatch(texts, sl, tl) {
  const url = `${T_ENDPOINT}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t`;
  const body = new URLSearchParams();
  for (const t of texts) body.append('q', t);
  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: FORM_HEADERS, body: body.toString(), credentials: 'omit', cache: 'no-store' },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) throw new HttpError(res.status);
  const data = await res.json();
  if (texts.length === 1 && typeof data === 'string') return [data];
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error('Unexpected response from Google Translate');
  }
  return data.map((x) => {
    if (typeof x === 'string') return x;
    if (Array.isArray(x) && typeof x[0] === 'string') return x[0];
    throw new Error('Unexpected response item from Google Translate');
  });
}

// Classic single-string endpoint, used as a fallback.
async function requestSingle(text, sl, tl) {
  const url = `${SINGLE_ENDPOINT}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: FORM_HEADERS,
      body: new URLSearchParams({ q: text }).toString(),
      credentials: 'omit',
      cache: 'no-store',
    },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) throw new HttpError(res.status);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Unexpected response from Google Translate');
  return data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
}

async function requestWithRetry(texts, sl, tl) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await withSlot(() => requestBatch(texts, sl, tl));
    } catch (e) {
      lastErr = e;
      const s = e && e.status;
      if (s && s >= 400 && s < 500 && s !== 429 && s !== 408) break; // not retryable
      if (attempt < MAX_RETRIES) await sleep(Math.min(10000, 700 * 2 ** attempt) + Math.random() * 400);
    }
  }
  if (!(lastErr && lastErr.status === 429)) {
    // The batch endpoint misbehaved: fall back to one request per string.
    try {
      return await Promise.all(texts.map((t) => withSlot(() => requestSingle(t, sl, tl))));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Translation failed');
}

function makeGroups(texts) {
  const groups = [];
  let cur = [];
  let size = 0;
  for (const t of texts) {
    if (cur.length && (size + t.length > MAX_CHARS_PER_REQUEST || cur.length >= MAX_ITEMS_PER_REQUEST)) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += t.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Translate an array of strings.
 * @returns {Promise<{translations: (string|null)[], error: string|null}>}
 *   translations[i] is null if that string could not be translated.
 */
export async function translateTexts(texts, { sl = 'auto', tl = 'zh-CN' } = {}) {
  const translations = new Array(texts.length).fill(null);
  const keyOf = (t) => `${sl}\u0001${tl}\u0001${t}`;
  const need = new Map(); // text -> indices

  texts.forEach((t, i) => {
    if (typeof t !== 'string' || !t.trim()) {
      translations[i] = typeof t === 'string' ? t : '';
      return;
    }
    const hit = memGet(keyOf(t));
    if (hit !== undefined) {
      translations[i] = hit;
      return;
    }
    if (!need.has(t)) need.set(t, []);
    need.get(t).push(i);
  });

  if (need.size) {
    const fromDb = await dbGetMany([...need.keys()].map(keyOf));
    for (const [t, idxs] of [...need]) {
      const v = fromDb.get(keyOf(t));
      if (v !== undefined) {
        memSet(keyOf(t), v);
        for (const i of idxs) translations[i] = v;
        need.delete(t);
      }
    }
  }

  let error = null;
  if (need.size) {
    const fresh = [];
    await Promise.all(
      makeGroups([...need.keys()]).map(async (group) => {
        try {
          const out = await requestWithRetry(group, sl, tl);
          group.forEach((t, j) => {
            const v = out[j];
            memSet(keyOf(t), v);
            fresh.push([keyOf(t), v]);
            for (const i of need.get(t)) translations[i] = v;
          });
        } catch (e) {
          error = (e && e.message) || String(e);
        }
      })
    );
    dbPutMany(fresh); // fire and forget
  }
  return { translations, error };
}
