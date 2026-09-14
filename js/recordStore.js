/**
 * ============================================================
 * recordStore.js — Recension content store (IndexedDB)
 * ============================================================
 *
 * Every piece of content Recension owns: the manuscript tree
 * (book → chapter → scene), the card database, and the event timeline.
 *
 * Descends from Remnant's notesStore.js. What carried over, what didn't:
 *
 *   KEPT — writeRecord() resolving only on tx.oncomplete. A silently dropped
 *          write is how an unsaved scene renders as if it were saved.
 *   KEPT — onversionchange/onclose nulling the cached connection, or every
 *          later transaction throws InvalidStateError for the whole session.
 *   KEPT — order lives on the CHILD record, never in a parent's id array.
 *          Reordering stays a single-record write. This is also what lets
 *          KV sync work without a manifest key: every record is
 *          self-describing, so the tree rebuilds from enumeration alone.
 *
 *   DROPPED — Ciphers. Encrypted scenes can't be word-counted, searched,
 *             wikilink-indexed, compiled, or read on the mobile client. Every
 *             feature would need a cipher branch. Wrong trade for a tool whose
 *             job is cross-referencing its own contents.
 *   DROPPED — Fragments and the decay/Dust lifecycle. A 28-day timer that
 *             quietly deletes a plot idea is hostile to novel material.
 *             Unfiled scenes serve the same "not placed yet" purpose.
 *
 * ── TWO OBJECT STORES, AND WHY ───────────────────────────────
 *
 *   records   'scene:a1' → the full record, body included
 *   index     'scene:a1' → { u, t, w, s, p }   (~60 bytes)
 *
 * The index duplicates a few fields on purpose. getLocalIndex() runs on every
 * pull, and deserializing every scene body just to read updatedAt would mean
 * loading the entire novel into memory to answer "what changed." The index
 * store is small enough to read whole, every time, forever.
 *
 * It is also exactly the shape sent as KV metadata, so buildMeta() is a
 * lookup rather than a computation, and local and remote indexes are directly
 * comparable.
 *
 * Both stores are written in ONE transaction. They cannot drift.
 *
 * ── DIRTY MARKING: put() vs putLocal() ───────────────────────
 *
 * This distinction is load-bearing. Get it wrong and pull marks every pulled
 * record dirty, which pushes it straight back to the server in an endless loop.
 *
 *   put()       user edit      → writes + marks dirty
 *   putLocal()  sync pulled it → writes, does NOT mark dirty
 *   remove()    user delete    → routed through Sync.deleteRecord (tombstone first)
 *   removeLocal() sync applied a tombstone → local removal only
 *
 * ── RECORD SHAPES ────────────────────────────────────────────
 *
 *   book    { id, title, order, createdAt, updatedAt }
 *   chapter { id, bookId, title, synopsis, order, createdAt, updatedAt }
 *   scene   { id, chapterId, title, body, synopsis, pov, status,
 *             wordCount, order, createdAt, updatedAt }
 *           chapterId null = unfiled ("not placed yet")
 *           status: 'draft' | 'revised' | 'final'
 *   card    { id, cardType, name, aka[], fields{}, tags[], body,
 *             imageKey, createdAt, updatedAt }
 *           cardType: 'character' | 'location' | 'faction' | 'item' | 'research'
 *   event   { id, title, kind, start, end, precision, participants[],
 *             location, sceneRef, body, createdAt, updatedAt }
 *
 * ── DATES ON EVENTS ──────────────────────────────────────────
 *
 * start/end are ISO 8601 STRINGS, not Date objects or epoch numbers:
 *   '1892'                → precision 'year'    renders as a fuzzy band
 *   '1892-04'             → precision 'month'
 *   '1892-04-17'          → precision 'day'
 *   '1892-04-17T09:30'    → precision 'minute'  renders as a point
 *
 * ISO strings sort correctly as plain text, so ordering needs no parsing.
 * Precision is what stops "married sometime in 1892" from rendering as false
 * precision on a timeline. BCE uses the leading-minus form ('-0450').
 *
 * A fictional calendar, if ever wanted, swaps the formatter — not the data.
 * ============================================================
 */

const RecordStore = (() => {

  const DB_NAME    = 'recension';
  const DB_VERSION = 1;
  const RECORDS    = 'records';
  const INDEX      = 'index';

  const TYPES = ['book', 'chapter', 'scene', 'card', 'event'];

  let _dbPromise = null;

  // ── Connection ────────────────────────────────────────────────────

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
        if (!db.objectStoreNames.contains(INDEX))   db.createObjectStore(INDEX);
      };
      req.onsuccess = e => {
        const db = e.target.result;
        db.onversionchange = () => { db.close(); _dbPromise = null; };
        db.onclose         = () => { _dbPromise = null; };
        resolve(db);
      };
      req.onerror = e => { _dbPromise = null; reject(e.target.error); };
    });
    return _dbPromise;
  }

  function wrap(req) {
    return new Promise(resolve => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = e => { console.warn('[RecordStore]', e.target.error); resolve(null); };
    });
  }

  /**
   * tx(storeNames, mode, fn) — run fn(stores) inside ONE transaction,
   * resolving true only on durable commit.
   *
   * NO AWAITS INSIDE fn. IndexedDB auto-commits when the event loop yields
   * with no pending requests, so awaiting between operations on the same
   * transaction is unreliable — Safari especially. This is the fix for the
   * hazard in Remnant's replaceAll(), which did `await wrap(s.clear())` and
   * then issued puts on the same store.
   */
  async function tx(storeNames, mode, fn) {
    let db;
    try { db = await openDB(); }
    catch (e) { console.warn('[RecordStore] openDB failed:', e); return false; }
    return new Promise(resolve => {
      let t;
      try { t = db.transaction(storeNames, mode); }
      catch (e) { console.warn('[RecordStore] transaction failed:', e); return resolve(false); }
      t.oncomplete = () => resolve(true);
      t.onabort    = () => { console.warn('[RecordStore] tx aborted:', t.error); resolve(false); };
      t.onerror    = () => { console.warn('[RecordStore] tx error:', t.error); resolve(false); };
      try {
        const stores = {};
        for (const n of [].concat(storeNames)) stores[n] = t.objectStore(n);
        fn(stores);
      } catch (e) { console.warn('[RecordStore] tx body failed:', e); resolve(false); }
    });
  }

  async function read(storeName, fn) {
    try {
      const db = await openDB();
      return await fn(db.transaction(storeName, 'readonly').objectStore(storeName));
    } catch (e) { console.warn('[RecordStore] read failed:', e); return null; }
  }

  // ── Keys and ids ──────────────────────────────────────────────────

  const key = (type, id) => `${type}:${id}`;

  function splitKey(k) {
    const i = k.indexOf(':');
    return i === -1 ? [k, ''] : [k.slice(0, i), k.slice(i + 1)];
  }

  function newId() {
    return crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  // ── Index entries ─────────────────────────────────────────────────
  //
  // Same shape as the KV metadata the worker stores, so buildMeta() is a
  // lookup and local/remote comparison is direct. Short field names because
  // Cloudflare caps serialized KV metadata at 1024 bytes.
  //
  //   u  updatedAt    the sync comparison field
  //   t  title/name   for outline rendering without fetching bodies
  //   w  word count   scenes only
  //   s  status       scenes only
  //   p  parent id    chapterId / bookId — lets the tree rebuild from metadata

  function indexEntry(type, rec) {
    const e = { u: rec.updatedAt || 0 };
    if (type === 'scene') {
      e.t = rec.title || '';
      e.w = rec.wordCount || 0;
      e.s = rec.status || 'draft';
      e.p = rec.chapterId || '';
    } else if (type === 'chapter') {
      e.t = rec.title || '';
      e.p = rec.bookId || '';
    } else if (type === 'book') {
      e.t = rec.title || '';
    } else if (type === 'card') {
      e.t = rec.name || '';
      e.s = rec.cardType || '';
    } else if (type === 'event') {
      e.t = rec.title || '';
      e.s = rec.start || '';
    }
    return e;
  }

  // ── Word counting ─────────────────────────────────────────────────
  // Markdown-aware enough to not count syntax as prose. Deliberately simple:
  // this runs on every scene save and needs to be fast, not perfect.

  function countWords(md) {
    if (!md) return 0;
    const text = md
      .replace(/```[\s\S]*?```/g, ' ')      // fenced code
      .replace(/`[^`]*`/g, ' ')             // inline code
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images → label only
      .replace(/^[#>\-*+\s]+/gm, ' ')       // headings, quotes, bullets
      .replace(/[*_~]/g, '');
    const m = text.match(/[A-Za-z0-9'’\u00C0-\u024F\u0400-\u04FF-]+/g);
    return m ? m.length : 0;
  }

  // ── Core read ─────────────────────────────────────────────────────

  async function get(type, id) {
    if (!type || !id) return null;
    return await read(RECORDS, s => wrap(s.get(key(type, id))));
  }

  // getAll(type) — every record of one type as { [id]: record }.
  // Loads bodies. For outline rendering use getIndex() instead.
  async function getAll(type) {
    const prefix = `${type}:`;
    const out = {};
    const res = await read(RECORDS, async s => {
      const [keys, vals] = await Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]);
      return { keys: keys || [], vals: vals || [] };
    });
    if (!res) return out;
    res.keys.forEach((k, i) => {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = res.vals[i];
    });
    return out;
  }

  // getIndex() — { 'scene:a1': {u,t,w,s,p}, ... } for EVERY record.
  // Cheap: reads only the index store, never a body.
  async function getIndex() {
    const out = {};
    const res = await read(INDEX, async s => {
      const [keys, vals] = await Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]);
      return { keys: keys || [], vals: vals || [] };
    });
    if (!res) return out;
    res.keys.forEach((k, i) => { out[k] = res.vals[i]; });
    return out;
  }

  // ── Core write ────────────────────────────────────────────────────

  // _write(type, id, rec) — record and index in ONE transaction, so they
  // cannot drift. Returns true only on durable commit.
  async function _write(type, id, rec) {
    return tx([RECORDS, INDEX], 'readwrite', st => {
      st[RECORDS].put(rec, key(type, id));
      st[INDEX].put(indexEntry(type, rec), key(type, id));
    });
  }

  async function _erase(type, id) {
    return tx([RECORDS, INDEX], 'readwrite', st => {
      st[RECORDS].delete(key(type, id));
      st[INDEX].delete(key(type, id));
    });
  }

  /**
   * put(type, id, rec) — a USER edit. Writes and marks dirty for sync.
   * Stamps updatedAt and recomputes scene word count.
   */
  async function put(type, id, rec) {
    if (!TYPES.includes(type) || !id || !rec) return false;
    const now = Date.now();
    const record = { ...rec, id, updatedAt: now, createdAt: rec.createdAt || now };
    if (type === 'scene') record.wordCount = countWords(record.body);

    const ok = await _write(type, id, record);
    if (ok && typeof Sync !== 'undefined') Sync.markDirty(type, id);
    return ok;
  }

  /**
   * putLocal(type, id, rec) — sync pulled this from the server. Writes it
   * verbatim (updatedAt is the server's) and does NOT mark dirty.
   *
   * Marking dirty here would push every pulled record straight back to the
   * server on the next flush — an endless loop that would also keep
   * overwriting other devices' newer writes.
   */
  async function putLocal(type, id, rec) {
    if (!TYPES.includes(type) || !id || !rec) return false;
    return _write(type, id, rec);
  }

  /**
   * remove(type, id) — a USER delete. Routed through Sync so a tombstone is
   * written BEFORE the record disappears. Deleting via removeLocal() instead
   * skips the tombstone, and the record resurrects from another device on the
   * next pull.
   */
  async function remove(type, id) {
    if (typeof Sync !== 'undefined') return Sync.deleteRecord(type, id);
    return _erase(type, id);
  }

  // removeLocal(type, id) — sync applying a tombstone. No new tombstone.
  async function removeLocal(type, id) {
    return _erase(type, id);
  }

  // ── Ordering ──────────────────────────────────────────────────────
  // order lives on the child. nextOrder() appends; reorder() is a
  // single-record write.

  function nextOrder(siblings) {
    const vals = Object.values(siblings || {}).map(r => r.order || 0);
    return vals.length ? Math.max(...vals) + 1 : 0;
  }

  function sortByOrder(arr) {
    return arr.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // ── Manuscript tree ───────────────────────────────────────────────

  async function createBook(title) {
    const id = newId();
    const books = await getAll('book');
    const ok = await put('book', id, { id, title: title || 'Untitled', order: nextOrder(books) });
    return ok ? id : null;
  }

  async function createChapter(bookId, title) {
    const id = newId();
    const all = await getAll('chapter');
    const siblings = Object.fromEntries(Object.entries(all).filter(([, c]) => c.bookId === bookId));
    const ok = await put('chapter', id, {
      id, bookId, title: title || 'Untitled Chapter', synopsis: '', order: nextOrder(siblings),
    });
    return ok ? id : null;
  }

  // createScene(chapterId) — chapterId null creates an UNFILED scene.
  // Unfiled is a first-class state, not an error: it's where scenes written
  // before they have a home live.
  async function createScene(chapterId = null, title = '') {
    const id = newId();
    const all = await getAll('scene');
    const siblings = Object.fromEntries(
      Object.entries(all).filter(([, s]) => (s.chapterId || null) === chapterId));
    const ok = await put('scene', id, {
      id, chapterId, title: title || 'Untitled Scene',
      body: '', synopsis: '', pov: '', status: 'draft',
      wordCount: 0, order: nextOrder(siblings),
    });
    return ok ? id : null;
  }

  /**
   * getTree() — the whole manuscript structure, bodies excluded.
   * Built from the index store, so this is cheap enough to call on render.
   */
  async function getTree() {
    const idx = await getIndex();
    const books = [], chapters = [], scenes = [];
    for (const [k, e] of Object.entries(idx)) {
      const [type, id] = splitKey(k);
      if (type === 'book')         books.push({ id, title: e.t, updatedAt: e.u });
      else if (type === 'chapter') chapters.push({ id, title: e.t, bookId: e.p, updatedAt: e.u });
      else if (type === 'scene')   scenes.push({ id, title: e.t, chapterId: e.p || null,
                                                 wordCount: e.w, status: e.s, updatedAt: e.u });
    }
    // The index doesn't carry `order` (it's not needed for sync and metadata
    // is byte-capped), so pull it from the records for the tree view only.
    const [bRec, cRec, sRec] = await Promise.all([getAll('book'), getAll('chapter'), getAll('scene')]);
    for (const b of books)    b.order = bRec[b.id]?.order || 0;
    for (const c of chapters) c.order = cRec[c.id]?.order || 0;
    for (const s of scenes)   s.order = sRec[s.id]?.order || 0;

    return {
      books: sortByOrder(books).map(b => ({
        ...b,
        chapters: sortByOrder(chapters.filter(c => c.bookId === b.id)).map(c => ({
          ...c,
          scenes: sortByOrder(scenes.filter(s => s.chapterId === c.id)),
        })),
      })),
      unfiled: sortByOrder(scenes.filter(s => !s.chapterId)),
      totalWords: scenes.reduce((n, s) => n + (s.wordCount || 0), 0),
    };
  }

  // ── Cards ─────────────────────────────────────────────────────────

  const CARD_TYPES = ['character', 'location', 'faction', 'item', 'research'];

  async function createCard(cardType, name) {
    if (!CARD_TYPES.includes(cardType)) return null;
    const id = newId();
    const ok = await put('card', id, {
      id, cardType, name: name || 'Untitled',
      aka: [], fields: {}, tags: [], body: '', imageKey: null,
    });
    return ok ? id : null;
  }

  // findCardByName(name) — matches the card's name or any of its aka
  // entries, case-insensitively. This is what resolves a [[wikilink]].
  async function findCardByName(name) {
    if (!name) return null;
    const needle = name.trim().toLowerCase();
    const cards = await getAll('card');
    for (const c of Object.values(cards)) {
      if ((c.name || '').trim().toLowerCase() === needle) return c;
      if ((c.aka || []).some(a => (a || '').trim().toLowerCase() === needle)) return c;
    }
    return null;
  }

  // ── Events ────────────────────────────────────────────────────────
  //
  // Events are FIRST-CLASS records, peer to cards — not properties of scenes.
  // Most of a character's life (birth, marriage, death) happens offscreen and
  // will never appear in the manuscript. Modelling events as scene metadata
  // makes those unrepresentable.
  //
  // sceneRef is optional: the same structure holds both "depicted in chapter
  // 12" and "happened in 1847, never shown."

  const PRECISIONS = ['year', 'month', 'day', 'minute'];

  async function createEvent({ title, kind = 'other', start, end = null,
                               precision = 'day', participants = [],
                               location = null, sceneRef = null } = {}) {
    if (!PRECISIONS.includes(precision)) precision = 'day';
    const id = newId();
    const ok = await put('event', id, {
      id, title: title || 'Untitled Event', kind,
      start: start || '', end, precision,
      participants, location, sceneRef, body: '',
    });
    return ok ? id : null;
  }

  /**
   * getTimeline({ participantId, tag } = {}) — events in chronological order.
   *
   * Sorts on the raw ISO string. This works without parsing because ISO 8601
   * sorts lexically in chronological order, and it means partial dates
   * ('1892') sort correctly against full ones ('1892-04-17') without being
   * coerced to a false precision.
   */
  async function getTimeline({ participantId = null } = {}) {
    const events = Object.values(await getAll('event'));
    const filtered = participantId
      ? events.filter(e => (e.participants || []).includes(participantId))
      : events;
    return filtered.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }

  // ── Sync interface ────────────────────────────────────────────────
  // Exactly the config shape sync.js expects. Pass this into Sync.init().

  function syncInterface() {
    return {
      getRecord:     (type, id)      => get(type, id),
      putRecord:     (type, id, rec) => putLocal(type, id, rec),
      removeRecord:  (type, id)      => removeLocal(type, id),
      getLocalIndex: async () => {
        const idx = await getIndex();
        const out = {};
        for (const [k, e] of Object.entries(idx)) out[k] = e.u || 0;
        return out;
      },
      buildMeta: (type, rec) => indexEntry(type, rec),
    };
  }

  // ── Reset ─────────────────────────────────────────────────────────
  // Guest switch-account only. Never called to "clean up."

  async function clear() {
    return tx([RECORDS, INDEX], 'readwrite', st => {
      st[RECORDS].clear();
      st[INDEX].clear();
    });
  }

  return {
    // Core
    get, getAll, getIndex, put, putLocal, remove, removeLocal,
    // Tree
    createBook, createChapter, createScene, getTree,
    // Cards
    createCard, findCardByName, CARD_TYPES,
    // Events
    createEvent, getTimeline, PRECISIONS,
    // Helpers
    countWords, nextOrder, sortByOrder, newId, TYPES,
    // Wiring
    syncInterface,
    clear,
  };
})();
