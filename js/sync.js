/**
 * ============================================================
 * sync.js — Recension client sync layer
 * ============================================================
 *
 * Replaces Remnant's blob sync (assembleSyncPayload / pushToWorker /
 * pullFromWorker / replaceAll) with per-record sync over batched transport.
 *
 * ── DESIGN INVARIANTS (from recension-sync-design.md §8) ─────
 * These are load-bearing. Breaking one loses a manuscript.
 *
 *   1. IndexedDB is the source of truth. KV is a replica. Total KV loss
 *      costs sync, not the novel.
 *   2. PULL NEVER CLEARS. There is no clear() in any path in this file.
 *      Records absent from the server are KEPT unless a tombstone says
 *      otherwise. A failed pull degrades to "some records not updated yet,"
 *      never "manuscript wiped."
 *   3. A record is never cleared from the dirty set before its write is
 *      confirmed by the server.
 *   4. Tombstone is written BEFORE the key is deleted. If the process dies
 *      between them, a stale record covered by a tombstone is cleaned on the
 *      next pull. The reverse order lets a deleted record resurrect from
 *      another device.
 *   5. _authHeaders returning null ABORTS the request. Never send unsigned.
 *
 * ── WHY BATCHED ──────────────────────────────────────────────
 * The worker enforces 120 requests / 60s per account. One request per record
 * makes a 200-scene import fail partway with a 429. Records still land as
 * individual KV keys with individual metadata — only the HTTP layer batches.
 *
 *   Import 200 scenes   200 requests → 4
 *   Fresh-device sync   201 requests → 3
 *   Typical flush        4 requests → 1
 *
 * ── DIRTY SET ────────────────────────────────────────────────
 * Persisted in its own IndexedDB database ('recension-sync'), NOT in memory.
 * A crash or tab kill must not lose track of what needs syncing. It lives in
 * a separate DB from record content deliberately: it's sync-layer state, and
 * keeping it separate avoids coupling its schema version to the content
 * store's.
 *
 * ── BLOB SIGNING ─────────────────────────────────────────────
 * /blob requests sign the BLOB KEY STRING, not the body. The signed message
 * (METHOD:token:timestamp:sha256(payload)) does not include the path, so
 * signing the body would let a signature for one object validate for another
 * — and would mean hashing a 50MB upload client-side. See worker.js header.
 *
 * ── HOST APP INTERFACE ───────────────────────────────────────
 * Sync.init(config) is the only coupling. Nothing here knows about scenes,
 * cards, or the UI.
 *
 *   workerBase      fn  → worker base URL string, or '' if unconfigured
 *   getToken        fn  → current account token (raw token or 'google:<sub>')
 *   isGuest         fn  → true when local-only; sync is a no-op
 *
 *   getRecord       fn  (type, id) → record | null
 *   putRecord       fn  (type, id, record) → bool   LOCAL write, no dirty mark
 *   removeRecord    fn  (type, id) → bool           LOCAL delete, no tombstone
 *   getLocalIndex   fn  () → { 'scene:a1': updatedAt, ... } for every record
 *   buildMeta       fn  (type, record) → meta object for KV metadata
 *
 *   getAccount      fn  → account/preferences object to sync
 *   setAccount      fn  (obj) → merge a pulled account record
 *
 *   onStatus        fn  (status, detail) → 'idle'|'syncing'|'error'|'offline'
 *   onProgress      fn  ({done, total, phase}) → optional, fresh-device UI
 *   onAuthFailure   fn  () → Promise<bool>; true = credentials refreshed, retry
 *   toast           fn  (message)
 * ============================================================
 */

const Sync = (() => {

  let C = null;

  // ── Tunables ──────────────────────────────────────────────────────
  const BULK_READ_MAX   = 100;   // must not exceed worker's BULK_READ_MAX
  const BULK_WRITE_MAX  = 50;    // must not exceed worker's BULK_WRITE_MAX
  const FLUSH_DEBOUNCE  = 10_000;      // 10s after last edit
  const PERIODIC_FLOOR  = 5 * 60_000;  // 5min catch-all
  const MAX_BACKOFF     = 5 * 60_000;
  const TOMBSTONE_TTL   = 90 * 24 * 60 * 60 * 1000; // 90 days

  // Record types that participate in per-record sync. The account record is
  // handled separately (it has optimistic concurrency via _rev).
  const TYPES = ['book', 'chapter', 'scene', 'card', 'event'];
  const ACCOUNT_KEY = '_account';
  const TOMB_KEY    = '_tombstones';

  // ── Sync-layer IndexedDB ('recension-sync') ───────────────────────
  // Two stores: `dirty` (record keys awaiting push) and `meta` (lastSync,
  // tombstones, rev). Separate DB from content — see header.

  const SYNC_DB = 'recension-sync';
  const SYNC_DB_VERSION = 1;
  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(SYNC_DB, SYNC_DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('dirty')) db.createObjectStore('dirty');
        if (!db.objectStoreNames.contains('meta'))  db.createObjectStore('meta');
      };
      req.onsuccess = e => {
        const db = e.target.result;
        // Mirrors notesStore.js: drop the cached handle when the connection
        // is closed out from under us, or every later transaction throws
        // InvalidStateError for the rest of the session.
        db.onversionchange = () => { db.close(); _dbPromise = null; };
        db.onclose         = () => { _dbPromise = null; };
        resolve(db);
      };
      req.onerror = e => { _dbPromise = null; reject(e.target.error); };
    });
    return _dbPromise;
  }

  // txWrite(storeName, fn) — runs fn(store) inside ONE transaction and
  // resolves true only on durable commit (tx.oncomplete).
  //
  // No awaits inside fn. This is the fix for the Remnant replaceAll() hazard:
  // IndexedDB auto-commits when the event loop yields with no pending
  // requests, so awaiting between operations on the same transaction is
  // unreliable (Safari especially).
  async function txWrite(storeName, fn) {
    let db;
    try { db = await openDB(); }
    catch (e) { console.warn('[Sync] openDB failed:', e); return false; }
    return new Promise(resolve => {
      let tx;
      try { tx = db.transaction(storeName, 'readwrite'); }
      catch (e) { console.warn('[Sync] transaction failed:', e); return resolve(false); }
      tx.oncomplete = () => resolve(true);
      tx.onabort    = () => { console.warn('[Sync] tx aborted:', tx.error); resolve(false); };
      tx.onerror    = () => { console.warn('[Sync] tx error:', tx.error); resolve(false); };
      try { fn(tx.objectStore(storeName)); }
      catch (e) { console.warn('[Sync] tx body failed:', e); resolve(false); }
    });
  }

  function wrap(req) {
    return new Promise(resolve => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  }

  async function readStore(storeName, fn) {
    try {
      const db = await openDB();
      return await fn(db.transaction(storeName, 'readonly').objectStore(storeName));
    } catch (e) { console.warn('[Sync] read failed:', e); return null; }
  }

  // ── Dirty set ─────────────────────────────────────────────────────

  // markDirty(type, id) — call from every local content mutation.
  // Idempotent; re-marking an already-dirty record is free.
  async function markDirty(type, id) {
    if (!type || !id) return;
    await txWrite('dirty', s => s.put(Date.now(), `${type}:${id}`));
    scheduleFlush();
  }

  async function markAccountDirty() {
    await txWrite('dirty', s => s.put(Date.now(), ACCOUNT_KEY));
    scheduleFlush();
  }

  async function getDirtyKeys() {
    return (await readStore('dirty', s => wrap(s.getAllKeys()))) || [];
  }

  async function clearDirty(keys) {
    if (!keys.length) return;
    return txWrite('dirty', s => { for (const k of keys) s.delete(k); });
  }

  // ── Meta store (tombstones, lastSync, account rev) ────────────────

  async function metaGet(key, fallback = null) {
    const v = await readStore('meta', s => wrap(s.get(key)));
    return v === null ? fallback : v;
  }
  async function metaSet(key, value) {
    return txWrite('meta', s => s.put(value, key));
  }

  // ── Tombstones ────────────────────────────────────────────────────
  // Ported from Remnant unchanged in substance: { 'scene:a1': deletedAt }.
  // Deletes are human-paced, so a single key is fine here.

  async function recordTombstone(type, id) {
    const t = await metaGet('tombstones', {});
    t[`${type}:${id}`] = Date.now();
    await metaSet('tombstones', t);
    await markDirty('_tomb', 'set'); // ensures the next flush pushes them
  }

  function reconcileTombstones(server, local) {
    const out = { ...(server || {}) };
    for (const [k, ts] of Object.entries(local || {})) {
      if (!out[k] || ts > out[k]) out[k] = ts;
    }
    return out;
  }

  function gcTombstones(t) {
    const cutoff = Date.now() - TOMBSTONE_TTL;
    const out = {};
    for (const [k, ts] of Object.entries(t || {})) if (ts > cutoff) out[k] = ts;
    return out;
  }

  // deleteRecord(type, id) — the sanctioned delete path.
  // TOMBSTONE FIRST, then local removal, then mark for remote deletion.
  // See invariant 4.
  async function deleteRecord(type, id) {
    await recordTombstone(type, id);
    await C.removeRecord(type, id);
    await markDirty(type, id); // flush sees it missing locally → issues remote delete
  }

  // ── Reconciliation ────────────────────────────────────────────────
  // Per-record union by updatedAt, ties to the device. Ported from Remnant's
  // reconcileById so both directions resolve conflicts identically.

  function pickNewer(serverRec, localRec) {
    if (!serverRec) return localRec;
    if (!localRec)  return serverRec;
    return (serverRec.updatedAt || 0) > (localRec.updatedAt || 0) ? serverRec : localRec;
  }

  // ── HTTP ──────────────────────────────────────────────────────────

  function base() { return (C.workerBase() || '').replace(/\/+$/, ''); }
  function tokenPath() { return encodeURIComponent(C.getToken()); }

  function splitKey(key) {
    const i = key.indexOf(':');
    return i === -1 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
  }

  // request(method, path, { body, signPayload }) — signPayload defaults to
  // the body; /blob passes the blob key instead. Returns
  // { ok, status, data } — never throws for HTTP errors.
  async function request(method, path, { body = null, signPayload = null, raw = null, contentType = null, extraHeaders = null } = {}) {
    const url = `${base()}${path}`;
    const payloadForSig = signPayload !== null ? signPayload : (body || '');

    const headers = await Auth._authHeaders(method, C.getToken(), payloadForSig);
    // Invariant 5: null means we could not produce credentials. Sending
    // anyway guarantees a 401 that surfaces as a generic network error and
    // wedges the device into permanent silent sync failure.
    if (!headers) {
      return { ok: false, status: 0, data: null, reason: 'no-credentials' };
    }
    if (body !== null)   headers['Content-Type'] = 'application/json';
    if (contentType)     headers['Content-Type'] = contentType;
    if (extraHeaders)    Object.assign(headers, extraHeaders);

    let res;
    try {
      res = await fetch(url, { method, headers, body: raw !== null ? raw : body });
    } catch (e) {
      return { ok: false, status: 0, data: null, reason: 'network' };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, data: null, reason: 'auth' };
    }
    if (res.status === 429) {
      return { ok: false, status: 429, data: null, reason: 'ratelimit' };
    }

    let data = null;
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) { try { data = await res.json(); } catch {} }
    return { ok: res.ok, status: res.status, data, res };
  }

  // withAuthRetry(fn) — on a 401/403, give the host one chance to refresh
  // credentials (Google silent re-auth, token migration) and retry once.
  async function withAuthRetry(fn) {
    let r = await fn();
    if (r.reason === 'auth') {
      const recovered = await C.onAuthFailure();
      if (recovered) r = await fn();
    }
    return r;
  }

  // ── Push ──────────────────────────────────────────────────────────

  let _flushTimer = null;
  let _flushing   = false;
  let _backoff    = 0;

  function scheduleFlush() {
    if (C?.isGuest?.()) return;
    clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => { flush(); }, FLUSH_DEBOUNCE);
  }

  /**
   * flush() — push everything in the dirty set.
   *
   * A dirty key whose record is missing locally is a DELETE (the local record
   * was removed via deleteRecord, which tombstoned it first). Present records
   * are writes.
   *
   * Only confirmed ids are cleared from the dirty set (invariant 3). Anything
   * that fails stays dirty and is retried on the next flush.
   */
  async function flush() {
    if (_flushing || C.isGuest() || !base()) return { ok: false, skipped: true };
    _flushing = true;
    C.onStatus('syncing');

    try {
      const dirty = await getDirtyKeys();
      if (!dirty.length) { C.onStatus('idle'); return { ok: true, pushed: 0 }; }

      const writes  = {};   // userKey → { value, meta }
      const deletes = [];   // userKey
      let pushAccount = false;
      let pushTombs   = false;

      for (const key of dirty) {
        if (key === ACCOUNT_KEY)   { pushAccount = true; continue; }
        if (key === '_tomb:set')   { pushTombs = true;   continue; }

        const [type, id] = splitKey(key);
        if (!TYPES.includes(type)) continue;

        const rec = await C.getRecord(type, id);
        if (!rec) { deletes.push(key); continue; }
        writes[key] = { value: rec, meta: C.buildMeta(type, rec) };
      }

      const confirmed = [];
      let failedAny = false;

      // Writes, in batches of BULK_WRITE_MAX.
      const writeEntries = Object.entries(writes);
      for (let i = 0; i < writeEntries.length; i += BULK_WRITE_MAX) {
        const chunk = Object.fromEntries(writeEntries.slice(i, i + BULK_WRITE_MAX));
        const body  = JSON.stringify({ records: chunk });
        const r = await withAuthRetry(() =>
          request('POST', `/storage/${tokenPath()}/bulkwrite`, { body }));

        if (!r.ok) { failedAny = true; break; }
        // Partial success is normal — KV has no multi-key atomicity.
        confirmed.push(...(r.data?.ok || []));
        if (r.data?.failed && Object.keys(r.data.failed).length) {
          failedAny = true;
          console.warn('[Sync] bulkwrite partial failure:', r.data.failed);
        }
      }

      // Deletes are individual — there is no bulk delete, and deletes are
      // rare enough (human-paced) that it doesn't matter.
      for (const key of deletes) {
        const r = await withAuthRetry(() =>
          request('DELETE', `/storage/${tokenPath()}/${key}`));
        // 404 means it was already gone — that's success for our purposes.
        if (r.ok || r.status === 404) confirmed.push(key);
        else { failedAny = true; break; }
      }

      if (pushTombs) {
        const tombs = gcTombstones(await metaGet('tombstones', {}));
        await metaSet('tombstones', tombs);
        const r = await withAuthRetry(() => request(
          'PUT', `/storage/${tokenPath()}/${TOMB_KEY}`,
          { body: JSON.stringify(tombs) }));
        if (r.ok) confirmed.push('_tomb:set'); else failedAny = true;
      }

      if (pushAccount) {
        const ok = await pushAccountRecord();
        if (ok) confirmed.push(ACCOUNT_KEY); else failedAny = true;
      }

      await clearDirty(confirmed);
      await metaSet('lastSync', Date.now());

      if (failedAny) {
        _backoff = Math.min(_backoff ? _backoff * 2 : 15_000, MAX_BACKOFF);
        setTimeout(() => flush(), _backoff);
        C.onStatus('error', 'Some changes not yet synced');
        return { ok: false, pushed: confirmed.length };
      }

      _backoff = 0;
      C.onStatus('idle');
      return { ok: true, pushed: confirmed.length };

    } finally {
      _flushing = false;
    }
  }

  // pushAccountRecord() — the account record carries server-authoritative
  // _rev optimistic concurrency. On 409 we re-pull, re-merge and retry once.
  async function pushAccountRecord(retried = false) {
    const acct = { ...C.getAccount() };
    const rev  = await metaGet('accountRev', 0);

    // X-Rev is what arms the worker's optimistic-concurrency check. Without
    // it the worker skips the check entirely (legacy-client path) and a
    // concurrent write from another device is silently clobbered.
    const r = await withAuthRetry(() => request(
      'PUT', `/storage/${tokenPath()}/${ACCOUNT_KEY}`,
      { body: JSON.stringify(acct), extraHeaders: { 'X-Rev': String(rev) } }
    ));

    if (r.status === 409 && !retried) {
      await pullAccount();
      return pushAccountRecord(true);
    }
    if (r.ok && r.data?.rev != null) await metaSet('accountRev', r.data.rev);
    return r.ok;
  }

  // ── Pull ──────────────────────────────────────────────────────────

  /**
   * pull() — diff against the server and fetch only what's genuinely newer.
   *
   * NEVER CLEARS (invariant 2). Local records absent from the server are kept
   * unless a tombstone covers them.
   */
  async function pull() {
    if (C.isGuest() || !base()) return { ok: false, skipped: true };
    C.onStatus('syncing');

    // 1. List every key with metadata. Paginated — a large project exceeds
    //    one page, and the old worker truncated silently at 1000.
    const remote = {};
    let cursor = null;
    do {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const r = await withAuthRetry(() => request('GET', `/storage/${tokenPath()}${q}`));
      if (!r.ok) { C.onStatus('error', 'Could not reach sync'); return { ok: false }; }
      for (const k of r.data?.keys || []) remote[k.key] = k.metadata || {};
      cursor = r.data?.cursor || null;
    } while (cursor);

    // 2. Tombstones first, so we don't fetch records that are already deleted.
    let tombs = await metaGet('tombstones', {});
    if (remote[TOMB_KEY]) {
      const r = await withAuthRetry(() => request('GET', `/storage/${tokenPath()}/${TOMB_KEY}`));
      if (r.ok && r.data?.value) tombs = reconcileTombstones(r.data.value, tombs);
    }
    tombs = gcTombstones(tombs);
    await metaSet('tombstones', tombs);

    // Apply tombstones locally. A tombstone newer than the local record wins.
    for (const [key, deletedAt] of Object.entries(tombs)) {
      const [type, id] = splitKey(key);
      if (!TYPES.includes(type)) continue;
      const local = await C.getRecord(type, id);
      if (local && (local.updatedAt || 0) < deletedAt) await C.removeRecord(type, id);
    }

    // 3. Diff. Fetch a record only when the server's updatedAt (from metadata,
    //    no value read) is newer than ours, or we don't have it at all.
    const localIndex = await C.getLocalIndex();
    const toFetch = [];
    for (const [key, meta] of Object.entries(remote)) {
      if (key.startsWith('_')) continue;
      if (tombs[key]) continue;
      const [type] = splitKey(key);
      if (!TYPES.includes(type)) continue;
      // Absent locally → always fetch, whatever the metadata says.
      // Relying on `serverAt > localAt` alone meant a record with missing
      // or empty metadata compared 0 > 0, was judged up to date, and was
      // never pulled — so a fresh device got the account record and none
      // of the manuscript.
      if (!(key in localIndex)) { toFetch.push(key); continue; }
      const serverAt = meta?.u || 0;
      const localAt  = localIndex[key] || 0;
      if (serverAt > localAt) toFetch.push(key);
    }

    // 4. Bulk fetch in pages.
    let done = 0;
    for (let i = 0; i < toFetch.length; i += BULK_READ_MAX) {
      const ids = toFetch.slice(i, i + BULK_READ_MAX);
      const r = await withAuthRetry(() => request(
        'POST', `/storage/${tokenPath()}/bulk`,
        { body: JSON.stringify({ ids }) }));
      if (!r.ok) { C.onStatus('error', 'Partial sync'); return { ok: false, fetched: done }; }

      for (const [key, serverRec] of Object.entries(r.data?.values || {})) {
        const [type, id] = splitKey(key);
        const localRec = await C.getRecord(type, id);
        const winner   = pickNewer(serverRec, localRec);
        // Only write when the server actually won — avoids pointless
        // IndexedDB churn and avoids bumping anything the user just edited.
        if (winner === serverRec) await C.putRecord(type, id, serverRec);
      }
      done += ids.length;
      C.onProgress?.({ done, total: toFetch.length, phase: 'records' });
    }

    // 5. Account record.
    if (remote[ACCOUNT_KEY]) await pullAccount();

    await metaSet('lastSync', Date.now());
    C.onStatus('idle');
    return { ok: true, fetched: done };
  }

  async function pullAccount() {
    const r = await withAuthRetry(() => request('GET', `/storage/${tokenPath()}/${ACCOUNT_KEY}`));

    // 410 → this token was migrated to Google. Hand off to the host.
    if (r.status === 410) { C.onStatus('error', 'Account migrated'); return false; }
    if (!r.ok) return false;

    const value = r.data?.value;
    if (value) {
      if (value._rev != null) await metaSet('accountRev', value._rev);
      C.setAccount(value);
    }
    return true;
  }

  /**
   * freshDeviceSync() — first sync on a device with no local data.
   *
   * Two phases, deliberately: metadata gives titles, word counts, status and
   * parent ids for every record, so the complete manuscript outline renders
   * from ONE request before a single body is fetched. Bodies then stream in.
   * On a phone over cellular this is the difference between instant and
   * unusable.
   */
  async function freshDeviceSync() {
    if (C.isGuest() || !base()) return { ok: false, skipped: true };
    C.onStatus('syncing');

    const stubs = {};
    let cursor = null;
    do {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const r = await withAuthRetry(() => request('GET', `/storage/${tokenPath()}${q}`));
      if (!r.ok) { C.onStatus('error', 'Could not reach sync'); return { ok: false }; }
      for (const k of r.data?.keys || []) {
        if (k.key.startsWith('_')) continue;
        stubs[k.key] = k.metadata || {};
      }
      cursor = r.data?.cursor || null;
    } while (cursor);

    // Phase 1 — outline from metadata alone.
    C.onProgress?.({ done: 0, total: Object.keys(stubs).length, phase: 'outline' });
    C.onOutlineReady?.(stubs);

    // Phase 2 — bodies. pull() fetches anything absent locally, which on a
    // fresh device is everything.
    await pull();
    return { ok: true };
  }

  // ── R2 blobs ──────────────────────────────────────────────────────
  //
  // Keys are client-relative: 'snap/<sceneId>/<iso>.json', 'archive/2026-03.zip',
  // 'img/<cardId>.jpg'. The worker inserts the hashed account identity, so a
  // client cannot reach another account's objects.
  //
  // The SIGNED PAYLOAD IS THE KEY, not the body. See header.

  async function putBlob(key, data, contentType = 'application/octet-stream') {
    if (C.isGuest() || !base()) return false;
    const r = await withAuthRetry(() => request(
      'PUT', `/blob/${tokenPath()}/${key}`,
      { raw: data, signPayload: key, contentType }
    ));
    return r.ok;
  }

  async function getBlob(key) {
    if (C.isGuest() || !base()) return null;
    const r = await withAuthRetry(() => request(
      'GET', `/blob/${tokenPath()}/${key}`, { signPayload: key }));
    if (!r.ok || !r.res) return null;
    return await r.res.blob();
  }

  async function deleteBlob(key) {
    if (C.isGuest() || !base()) return false;
    const r = await withAuthRetry(() => request(
      'DELETE', `/blob/${tokenPath()}/${key}`, { signPayload: key }));
    return r.ok;
  }

  async function listBlobs(prefix) {
    if (C.isGuest() || !base()) return [];
    const r = await withAuthRetry(() => request(
      'GET', `/blob/${tokenPath()}?prefix=${encodeURIComponent(prefix)}`,
      { signPayload: '' }));
    return r.ok ? (r.data?.objects || []) : [];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  let _periodic = null;

  function start() {
    stop();
    _periodic = setInterval(() => { flush(); }, PERIODIC_FLOOR);

    // Tab hidden / app backgrounded — flush now rather than waiting out the
    // debounce, since the tab may never come back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });

    // Last-chance best effort. Not guaranteed to complete; the dirty set is
    // persisted precisely so an interrupted flush costs nothing.
    window.addEventListener('pagehide', () => { flush(); });

    // Returning to the tab: pull, in case another device wrote while away.
    window.addEventListener('focus', () => { pull(); });
  }

  function stop() {
    clearInterval(_periodic);
    clearTimeout(_flushTimer);
    _periodic = null;
  }

  async function lastSyncTime() { return await metaGet('lastSync', 0); }
  async function pendingCount() { return (await getDirtyKeys()).length; }

  // ── Public API ────────────────────────────────────────────────────
  return {
    init(config) { C = config; },

    // Mutation hooks — call from the content store's write paths
    markDirty,
    markAccountDirty,
    deleteRecord,

    // Sync operations
    flush,
    pushAccount: pushAccountRecord,
    pull,
    freshDeviceSync,
    scheduleFlush,

    // Blobs (R2)
    putBlob, getBlob, deleteBlob, listBlobs,

    // Lifecycle
    start, stop,

    // Status
    lastSyncTime, pendingCount,

    /**
     * pushAll() — mark every local record dirty and flush.
     *
     * A repair tool. The dirty set is the only thing that decides what
     * gets pushed, so if it is ever wrong — cleared early, lost, diverged
     * after a failed write — the server silently stays behind and the UI
     * has no way to tell. This re-states everything.
     */
    async pushAll() {
      const index = await C.getLocalIndex();
      const keys = Object.keys(index);
      await txWrite('dirty', st => { for (const k of keys) st.put(Date.now(), k); });
      await markAccountDirty();
      return flush();
    },

    /**
     * diagnose() — what the server actually has, from the console.
     * Sync problems are otherwise silent: the UI can only say "incomplete".
     */
    async diagnose() {
      const out = { worker: base(), guest: C.isGuest(), token: C.getToken()?.slice(0, 6) + '…' };
      out.dirty = await getDirtyKeys();
      const r = await withAuthRetry(() => request('GET', `/storage/${tokenPath()}`));
      if (!r.ok) { out.listError = r.reason || r.status; console.table(out); return out; }
      const keys = r.data?.keys || [];
      out.remoteKeyCount = keys.length;
      out.remoteSample = keys.slice(0, 10).map(k => `${k.key} u=${k.metadata?.u ?? 'NONE'}`);
      out.withoutMetadata = keys.filter(k => !k.metadata?.u).map(k => k.key);
      out.localIndexCount = Object.keys(await C.getLocalIndex()).length;
      console.log(out);
      return out;
    },

    // Exposed for tests / debugging
    _pickNewer: pickNewer,
    _gcTombstones: gcTombstones,
    _reconcileTombstones: reconcileTombstones,
  };
})();
