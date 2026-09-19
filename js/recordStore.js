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
 *   project { id, title, order, createdAt, updatedAt, snowflake }
 *           The working set. Books, cards, events and beats belong to
 *           one. `snowflake` holds the step-1 fields and which steps
 *           are switched on.
 *   beat    { id, projectId, parentId, level, text, order }
 *           One link in the Snowflake expansion. Level 2 is a sentence
 *           of the paragraph, level 3 a paragraph expanding it, level
 *           4 a page expanding that. parentId is the element one level
 *           up that this one expands — that parentage IS the method.
 *   book    { id, projectId, title, subtitle, order, createdAt, updatedAt }
 *           A WORK — one novel. The type name stays `book` because that is
 *           what existing records and KV keys already say; renaming it
 *           would mean migrating every key for a label change.
 *   part    { id, bookId, title, order, createdAt, updatedAt }
 *           Optional tier. Most novels have none, so a chapter may hang
 *           directly off the work with partId null.
 *   chapter { id, bookId, partId, title, synopsis, order, createdAt, updatedAt }
 *           bookId is always set; partId is null for a chapter that sits
 *           directly under the work.
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
  const DB_VERSION = 2;   // 2: added the images store
  const RECORDS    = 'records';
  const INDEX      = 'index';
  const IMAGES     = 'images';

  const TYPES = ['project', 'book', 'part', 'chapter', 'scene', 'card', 'event', 'beat'];

  // Records that belong to a project rather than to a book. A project
  // is the working set: its books, its cast, its history. Cards and
  // events sit here rather than on a book so a shared universe — two
  // novels, one set of characters — works without duplicating anyone.
  const PROJECT_SCOPED = ['book', 'card', 'event', 'beat'];

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
        // Blobs, keyed by card id. Separate from records so a portrait
        // is never serialized alongside JSON that's read constantly.
        if (!db.objectStoreNames.contains(IMAGES))  db.createObjectStore(IMAGES);
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
  //   o  order        LOCAL ONLY — stripped before the entry becomes KV
  //                   metadata. The tree can't render without it, and
  //                   re-reading every body just to sort was a full
  //                   manuscript load on every tree render.

  function indexEntry(type, rec) {
    const e = { u: rec.updatedAt || 0 };
    if (type === 'scene') {
      e.t = rec.title || '';
      e.w = rec.wordCount || 0;
      e.s = rec.status || 'draft';
      e.p = rec.chapterId || '';
      e.o = rec.order || 0;
    } else if (type === 'chapter') {
      e.t = rec.title || '';
      // Parent is the part when there is one, else the work. `g` records
      // which, so the tree can be rebuilt from metadata alone.
      e.p = rec.partId || rec.bookId || '';
      e.g = rec.partId ? 'part' : 'book';
      e.o = rec.order || 0;
    } else if (type === 'part') {
      e.t = rec.title || '';
      e.p = rec.bookId || '';
      e.o = rec.order || 0;
    } else if (type === 'book') {
      e.t = rec.title || '';
      e.o = rec.order || 0;
      e.j = rec.projectId || '';
    } else if (type === 'project') {
      e.t = rec.title || '';
      e.o = rec.order || 0;
    } else if (type === 'beat') {
      e.t = (rec.text || '').slice(0, 80);
      e.o = rec.order || 0;
      e.p = rec.parentId || '';
      e.s = String(rec.level || 2);
      e.j = rec.projectId || '';
    } else if (type === 'card') {
      e.t = rec.name || '';
      e.s = rec.cardType || '';
      e.j = rec.projectId || '';
    } else if (type === 'event') {
      e.t = rec.title || '';
      e.s = rec.start || '';
      e.j = rec.projectId || '';
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
      // Wikilinks count as what they READ as. [[Angel Six|Angel]] is one
      // word on the page, not three — and the hidden target isn't prose.
      .replace(/\[\[([^\[\]|]+)\|([^\[\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
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
    if (ok && type === 'card') invalidateCards();
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
    if (type === 'card') invalidateCards();
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
    if (type === 'card') invalidateCards();
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

  // ══ Projects ═════════════════════════════════════════════════════

  let _currentProject = null;

  function currentProject() { return _currentProject; }
  function setCurrentProject(id) {
    // The index is project-scoped, so switching invalidates it too.
    if (id !== _currentProject) invalidateCards();
    _currentProject = id || null;
  }

  async function createProject(title) {
    const id = newId();
    const all = await getAll('project');
    const ok = await put('project', id, {
      id, title: title || 'Untitled project', order: nextOrder(all),
    });
    return ok ? id : null;
  }

  async function listProjects() {
    return sortByOrder(Object.values(await getAll('project')));
  }

  // getAllIn(type) — records of a project-scoped type belonging to the
  // current project. Everything that draws the rail, the grid, the map
  // or the timeline goes through here, so a second project can never
  // bleed into the first one's views.
  async function getAllIn(type) {
    const all = await getAll(type);
    if (!PROJECT_SCOPED.includes(type) || !_currentProject) return all;
    const out = {};
    for (const [id, rec] of Object.entries(all)) {
      if ((rec.projectId || null) === _currentProject) out[id] = rec;
    }
    return out;
  }

  /**
   * ensureProject() — one-time migration, silent.
   *
   * Everything written before projects existed has no projectId. Rather
   * than asking about it, adopt it: create one project named after the
   * first book and assign every orphan to it. Runs once — after it, any
   * record without a projectId is genuinely new and gets the current
   * one at creation.
   *
   * Returns the id to open.
   */
  async function ensureProject() {
    const projects = await listProjects();

    const orphans = { book: [], card: [], event: [] };
    for (const type of PROJECT_SCOPED) {
      for (const rec of Object.values(await getAll(type))) {
        if (!rec.projectId) orphans[type].push(rec);
      }
    }
    const strays = orphans.book.length + orphans.card.length + orphans.event.length;

    if (!projects.length && !strays) {
      // Genuinely empty account. One project so there is somewhere to
      // put the first book.
      const id = await createProject('My writing');
      setCurrentProject(id);
      return id;
    }

    let home = projects[0]?.id;
    if (strays && !home) {
      const name = sortByOrder(orphans.book)[0]?.title || 'My writing';
      home = await createProject(name);
    }

    if (strays) {
      for (const type of PROJECT_SCOPED) {
        for (const rec of orphans[type]) {
          await _write(type, rec.id, { ...rec, projectId: home });
          if (typeof Sync !== 'undefined') Sync.markDirty(type, rec.id);
        }
      }
    }

    setCurrentProject(home);
    return home;
  }

  async function deleteProject(id) {
    // Detach rather than destroy, as everywhere else — the books and
    // cards survive and can be moved into another project. Only a
    // scene deletion is allowed to lose words.
    for (const type of PROJECT_SCOPED) {
      for (const rec of Object.values(await getAll(type))) {
        if (rec.projectId === id) await put(type, rec.id, { ...rec, projectId: null });
      }
    }
    return remove('project', id);
  }

  // ══ Snowflake ════════════════════════════════════════════════════
  //
  // Ingermanson's method models a story at increasing magnification:
  // a sentence, then a paragraph, then a paragraph per sentence, then
  // a page per paragraph. Every element expands exactly one element
  // from the level above, and that parentage is the whole point — it
  // is what makes step 4 a magnification of step 2 rather than a
  // second, unrelated document.
  //
  // So beats are a tree, not four text fields. A tool that stored the
  // four levels as four blobs would be a form; this can answer which
  // paragraph expands which sentence, and which scenes dramatize
  // which beat.

  const BEAT_LEVELS = { 2: 'sentence', 3: 'paragraph', 4: 'page' };

  // The five Ingermanson names for the level-2 sentences. Five is his
  // number, not a law: a sixth sentence gets a beat and no label
  // rather than being crammed into the fifth.
  const BEAT_ROLES = ['Setup', 'Disaster', 'Disaster', 'Disaster', 'Ending'];

  async function createBeat({ parentId = null, level = 2, text = '', order = null } = {}) {
    const id = newId();
    const siblings = Object.fromEntries(
      Object.entries(await getAllIn('beat'))
        .filter(([, b]) => (b.parentId || null) === (parentId || null) && b.level === level));
    const ok = await put('beat', id, {
      id, projectId: _currentProject, parentId: parentId || null, level, text,
      order: order ?? nextOrder(siblings),
    });
    return ok ? id : null;
  }

  // beatsAt(level, parentId) — one rung of the ladder, in order.
  async function beatsAt(level, parentId = undefined) {
    const all = Object.values(await getAllIn('beat')).filter(b => b.level === level);
    const scoped = parentId === undefined
      ? all : all.filter(b => (b.parentId || null) === (parentId || null));
    return sortByOrder(scoped);
  }

  /**
   * beatTree() — the expansion as a nested structure, with the scenes
   * that dramatize each beat attached.
   *
   * The scene counts are what make the plan checkable against the
   * book: a beat with no scenes is structure you planned and haven't
   * written, and a beat carrying 18,000 words is a paragraph that got
   * away from you.
   */
  async function beatTree() {
    const beats = Object.values(await getAllIn('beat'));
    const scenes = Object.values(await getAll('scene'));

    const byBeat = {};
    for (const sc of scenes) {
      if (!sc.beatId) continue;
      (byBeat[sc.beatId] ||= []).push(sc);
    }

    const build = (level, parentId) => sortByOrder(
      beats.filter(b => b.level === level && (b.parentId || null) === (parentId || null))
    ).map(b => {
      const mine = byBeat[b.id] || [];
      const children = level < 4 ? build(level + 1, b.id) : [];
      return {
        ...b,
        children,
        scenes: mine,
        words: mine.reduce((n, s) => n + (s.wordCount || 0), 0) +
               children.reduce((n, c) => n + c.words, 0),
        sceneCount: mine.length + children.reduce((n, c) => n + c.sceneCount, 0),
      };
    });

    return build(2, null);
  }

  // Scenes that serve no beat. Sometimes exactly right — the book
  // found something the plan didn't — and sometimes drift worth
  // noticing. Either way it should be visible rather than inferred.
  async function unplannedScenes() {
    const tree = await getTree();
    const out = [];
    for (const ch of allChapters(tree)) {
      for (const sc of ch.scenes) {
        const rec = await get('scene', sc.id);
        if (rec && !rec.beatId) out.push({ ...sc, chapter: ch.title });
      }
    }
    return out;
  }

  async function deleteBeat(id) {
    // Children are detached, not destroyed, and scenes keep their text
    // — the same rule as everywhere: only deleting a scene loses words.
    for (const b of Object.values(await getAllIn('beat'))) {
      if (b.parentId === id) await put('beat', b.id, { ...b, parentId: null });
    }
    for (const sc of Object.values(await getAll('scene'))) {
      if (sc.beatId === id) await put('scene', sc.id, { ...sc, beatId: null });
    }
    return remove('beat', id);
  }

  // ── Manuscript tree ───────────────────────────────────────────────

  async function createBook(title) {
    const id = newId();
    const books = await getAllIn('book');
    const ok = await put('book', id, {
      id, projectId: _currentProject, title: title || 'Untitled', order: nextOrder(books),
    });
    return ok ? id : null;
  }

  // createChapter(bookId) — bookId null creates a LOOSE chapter, shown at the
  // top level of the contents. Parts are optional: most novels don't have
  // them, and requiring one before you can make a chapter would force the
  // writer to invent a structural level they don't want.
  async function createPart(bookId, title) {
    const id = newId();
    const all = await getAll('part');
    const siblings = Object.fromEntries(
      Object.entries(all).filter(([, p]) => p.bookId === bookId));
    const ok = await put('part', id, {
      id, bookId, title: title || 'Untitled part', order: nextOrder(siblings),
    });
    return ok ? id : null;
  }

  // createChapter(bookId, partId) — partId null puts the chapter directly
  // under the work. Parts are optional: most novels have none, and
  // requiring one would force the writer to invent a tier they don't want.
  async function createChapter(bookId, title, partId = null) {
    const id = newId();
    const all = await getAll('chapter');
    const siblings = Object.fromEntries(Object.entries(all).filter(
      ([, c]) => c.bookId === bookId && (c.partId || null) === (partId || null)));
    const ok = await put('chapter', id, {
      id, bookId, partId: partId || null,
      title: title || 'Untitled chapter', synopsis: '', order: nextOrder(siblings),
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
   *
   * Reads ONLY the index store. No scene body is deserialized, so this stays
   * cheap at 150k words and is safe to call on every render.
   */
  /**
   * getTree() — the whole library, bodies excluded.
   *
   * Reads ONLY the index store. No scene body is deserialized, so this
   * stays cheap at 150k words and is safe to call on every render.
   *
   *   works[] → parts[] → chapters[] → scenes[]
   *           → looseChapters[]      (no part)
   *   unfiled[]                       (scenes with no chapter)
   */
  async function getTree() {
    const idx = await getIndex();
    // Books carry the project in their index entry (`j`), so the tree
    // can be scoped without reading a single record body.
    const mine = id => !_currentProject || (idx[`book:${id}`]?.j || null) === _currentProject;
    const books = [], parts = [], chapters = [], scenes = [];

    for (const [k, e] of Object.entries(idx)) {
      const [type, id] = splitKey(k);
      const base = { id, title: e.t, order: e.o || 0, updatedAt: e.u };
      if (type === 'book')       { if (mine(id)) books.push(base); }
      else if (type === 'part')    parts.push({ ...base, bookId: e.p || null });
      else if (type === 'chapter') chapters.push({
        ...base,
        partId: e.g === 'part' ? e.p : null,
        bookId: e.g === 'part' ? null : (e.p || null),
      });
      else if (type === 'scene')   scenes.push({
        ...base, chapterId: e.p || null, wordCount: e.w, status: e.s,
      });
    }

    // A chapter under a part knows its part but not its work — the index
    // holds one parent. Resolve the work through the part.
    const partById = Object.fromEntries(parts.map(p => [p.id, p]));
    for (const c of chapters) {
      if (c.partId) c.bookId = partById[c.partId]?.bookId || null;
    }

    // Chapters whose book belongs to another project are dropped here
    // rather than being filtered at every call site. Scenes follow
    // their chapters, so filtering chapters is enough.
    const bookIds = new Set(books.map(b => b.id));
    const visible = c => !_currentProject || !c.bookId || bookIds.has(c.bookId);

    const withScenes = c => ({
      ...c, scenes: sortByOrder(scenes.filter(s => s.chapterId === c.id)),
    });
    const wordsOf = list => list.reduce(
      (n, c) => n + c.scenes.reduce((m, s) => m + (s.wordCount || 0), 0), 0);

    const works = sortByOrder(books).map(b => {
      const mine = chapters.filter(c => c.bookId === b.id && visible(c));
      const workParts = sortByOrder(parts.filter(p => p.bookId === b.id)).map(p => {
        const inPart = sortByOrder(mine.filter(c => c.partId === p.id)).map(withScenes);
        return { ...p, chapters: inPart, words: wordsOf(inPart) };
      });
      const loose = sortByOrder(mine.filter(c => !c.partId)).map(withScenes);
      return {
        ...b,
        parts: workParts,
        looseChapters: loose,
        words: workParts.reduce((n, p) => n + p.words, 0) + wordsOf(loose),
      };
    });

    return {
      works,
      // Chapters whose work was deleted would otherwise vanish silently.
      orphanChapters: sortByOrder(
        chapters.filter(c => !c.bookId && !c.partId)).map(withScenes),
      unfiled: sortByOrder(scenes.filter(s => !s.chapterId)),
      totalWords: scenes.reduce((n, s) => n + (s.wordCount || 0), 0),
    };
  }

  // allChapters(tree) — every chapter in reading order, flattened.
  function allChapters(tree) {
    const out = [];
    for (const w of tree.works) {
      for (const p of w.parts) out.push(...p.chapters);
      out.push(...w.looseChapters);
    }
    out.push(...(tree.orphanChapters || []));
    return out;
  }

  // ── Cards ─────────────────────────────────────────────────────────

  const CARD_TYPES = ['character', 'location', 'faction', 'item', 'research'];

  async function createCard(cardType, name) {
    if (!CARD_TYPES.includes(cardType)) return null;
    const id = newId();
    const ok = await put('card', id, {
      id, projectId: _currentProject, cardType, name: name || 'Untitled',
      aka: [], fields: {}, tags: [], body: '', imageKey: null,
    });
    return ok ? id : null;
  }

  // findCardByName(name) — matches the card's name or any of its aka
  // entries, case-insensitively. This is what resolves a [[wikilink]].
  async function findCardByName(name) {
    if (!name) return null;
    const needle = name.trim().toLowerCase();
    const cards = await getAllIn('card');
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
      id, projectId: _currentProject, title: title || 'Untitled Event', kind,
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
    const events = Object.values(await getAllIn('event'));
    const filtered = participantId
      ? events.filter(e => (e.participants || []).includes(participantId))
      : events;
    return filtered.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }

  // eventsForCard(cardId) — every event this person took part in, in
  // order. This is the query the timeline is built from, and the reason
  // participants are stored as card ids rather than names: a rename costs
  // nothing and the lookup never misses on a nickname.
  async function eventsForCard(cardId) {
    const events = Object.values(await getAllIn('event'));
    return events
      .filter(e => (e.participants || []).includes(cardId))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }

  // ══ Wikilinks ════════════════════════════════════════════════════
  //
  // [[Card Name]] written inline in scene prose. The link is TEXT IN THE
  // BODY, not a record: the graph is derived by scanning. That choice
  // buys a lot — no new record type, no sync changes, and a scene stays
  // readable as plain markdown in an export or in any other editor.
  //
  // What it costs: renaming a card doesn't rewrite existing links. The
  // aka field absorbs most of that (an old name kept as an alias keeps
  // resolving), and a "rename and update references" action can handle
  // the rest if it ever becomes a real irritation.

  const LINK_RE = /\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g;

  // extractLinks(text) → ['Angel', 'Sonoran Desert']
  // Supports [[Card Name|display text]], keeping the target only.
  function extractLinks(text) {
    if (!text) return [];
    const out = [];
    for (const m of String(text).matchAll(LINK_RE)) {
      const target = m[1].trim();
      if (target) out.push(target);
    }
    return out;
  }

  // buildCardIndex() → Map of lowercased name AND every alias → card.
  // One pass, so resolving a whole scene's links doesn't re-scan the
  // card set per link.
  // Anything that changes a card's name, aliases or project membership
  // has to drop the cached index. Leaving that to call sites meant the
  // sync path — which writes cards without going through put() — left
  // a stale index behind, and links to cards pulled from another
  // device stayed grey until a reload.
  let _cardIndexCache = null;
  function invalidateCards() { _cardIndexCache = null; }

  async function buildCardIndex() {
    if (_cardIndexCache) return _cardIndexCache;
    const index = new Map();
    for (const c of Object.values(await getAllIn('card'))) {
      const keys = [c.name, ...(c.aka || [])];
      for (const k of keys) {
        const key = (k || '').trim().toLowerCase();
        // First card wins on a collision rather than the last, so the
        // resolution a writer already saw stays stable.
        if (key && !index.has(key)) index.set(key, c);
      }
    }
    _cardIndexCache = index;
    return index;
  }

  /**
   * linkGraph() — who appears where, derived from the prose.
   *
   *   byCard   cardId  → [{ sceneId, count }]
   *   byScene  sceneId → [{ cardId, name }]
   *   unknown  Map of unresolved target → [sceneId]
   *
   * `unknown` matters: a link to a card that doesn't exist is usually a
   * typo or a character you meant to write up. Silently dropping those
   * would hide both.
   */
  async function linkGraph() {
    const [scenes, index] = await Promise.all([getAll('scene'), buildCardIndex()]);
    const byCard = {}, byScene = {}, unknown = new Map();

    for (const sc of Object.values(scenes)) {
      const counts = new Map();
      for (const target of extractLinks(sc.body)) {
        const card = index.get(target.toLowerCase());
        if (!card) {
          if (!unknown.has(target)) unknown.set(target, []);
          unknown.get(target).push(sc.id);
          continue;
        }
        counts.set(card.id, (counts.get(card.id) || 0) + 1);
      }
      if (!counts.size) continue;
      byScene[sc.id] = [];
      for (const [cardId, count] of counts) {
        (byCard[cardId] ||= []).push({ sceneId: sc.id, count });
        byScene[sc.id].push({ cardId, count });
      }
    }
    return { byCard, byScene, unknown };
  }

  // resolveLink(target) — the card a [[target]] points at, or null.
  async function resolveLink(target) {
    return (await buildCardIndex()).get((target || '').trim().toLowerCase()) || null;
  }

  // ══ Images ═══════════════════════════════════════════════════════
  //
  // Card portraits and maps. Stored LOCALLY as blobs in their own
  // IndexedDB store, and mirrored to R2 through the worker.
  //
  // Why not in the card record: a record is JSON that gets read on
  // every tree render and pushed to KV on every edit. A 200KB portrait
  // riding along with it would be re-serialized constantly, and KV
  // values are the wrong home for binary anyway — that is exactly what
  // R2 is for, and the routes have been sitting unused since the
  // worker was written.
  //
  // The card keeps only `imageKey`, a string. The bytes live here.

  async function putImage(cardId, blob) {
    const ok = await tx(IMAGES, 'readwrite', st => st.put(blob, cardId));
    return ok;
  }

  async function getImage(cardId) {
    return await read(IMAGES, s => wrap(s.get(cardId)));
  }

  async function deleteImage(cardId) {
    return tx(IMAGES, 'readwrite', st => st.delete(cardId));
  }

  // ══ Search ═══════════════════════════════════════════════════════
  //
  // One pass over everything: scene titles, synopses and prose, card
  // names, aliases, fields and notes, event titles and notes.
  //
  // No index is maintained. At novel scale — a few hundred records,
  // maybe a megabyte of text — a linear scan is a few milliseconds, and
  // an index would be one more thing that can silently fall out of step
  // with the records it describes.

  // A snippet of the text around the first hit, with the match marked.
  // Returning the whole body would make every result look the same; the
  // point is to see the sentence, not the scene.
  function snippet(text, needle, width = 90) {
    if (!text) return null;
    const i = text.toLowerCase().indexOf(needle);
    if (i === -1) return null;

    const start = Math.max(0, i - Math.floor(width / 3));
    const end = Math.min(text.length, i + needle.length + Math.floor(width * 2 / 3));
    let out = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) out = '…' + out;
    if (end < text.length) out += '…';

    return { text: out, at: out.toLowerCase().indexOf(needle), len: needle.length };
  }

  /**
   * search(query) → [{ type, id, title, context, snippet, score }]
   *
   * Ranked, because an unranked list of everything containing "angel"
   * is barely better than no search. A title match beats a body match;
   * a whole-word match beats a fragment. Ties break on recency, so the
   * thing you were last working on surfaces first.
   */
  async function search(query, { limit = 40 } = {}) {
    const q = (query || '').trim().toLowerCase();
    if (q.length < 2) return [];

    const word = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const results = [];

    const consider = (type, id, title, context, fields) => {
      let score = 0, snip = null;
      for (const [weight, value] of fields) {
        const v = String(value || '');
        if (!v) continue;
        const lower = v.toLowerCase();
        if (!lower.includes(q)) continue;
        // A match at a word boundary is worth more than one buried
        // inside another word — "angel" in "Angel Six" beats "angel"
        // in "evangelical".
        score = Math.max(score, weight * (word.test(v) ? 2 : 1));
        if (!snip) snip = snippet(v, q);
      }
      if (score) results.push({ type, id, title, context, snippet: snip, score });
    };

    // Current project only. A result from another project would either
    // open something you can't see or switch context underneath you;
    // neither is what a search box should do.
    const [books, parts, chapters, scenes, cards, events] = await Promise.all([
      getAllIn('book'), getAll('part'), getAll('chapter'),
      getAll('scene'), getAllIn('card'), getAllIn('event'),
    ]);

    // Chapter titles, so a scene result can say where it lives.
    const chapterOf = {};
    for (const c of Object.values(chapters)) chapterOf[c.id] = c.title;

    for (const b of Object.values(books))
      consider('book', b.id, b.title, 'Book', [[10, b.title]]);

    for (const p of Object.values(parts))
      consider('part', p.id, p.title, 'Part', [[9, p.title]]);

    for (const c of Object.values(chapters))
      consider('chapter', c.id, c.title, 'Chapter', [[9, c.title], [4, c.synopsis]]);

    for (const sc of Object.values(scenes))
      consider('scene', sc.id, sc.title || 'Untitled scene',
        chapterOf[sc.chapterId] || 'Unplaced',
        [[10, sc.title], [6, sc.synopsis], [5, sc.pov], [3, sc.body]]);

    for (const c of Object.values(cards))
      consider('card', c.id, c.name || 'Untitled', c.cardType,
        [[10, c.name], [8, (c.aka || []).join(' ')], [5, (c.tags || []).join(' ')],
         [4, Object.entries(c.fields || {}).map(([k, v]) => `${k} ${v}`).join(' ')],
         [3, c.body]]);

    for (const e of Object.values(events))
      consider('event', e.id, e.title || 'Untitled event', e.kind || 'event',
        [[10, e.title], [5, e.location], [3, e.body]]);

    const stamp = { scene: scenes, card: cards, event: events,
                    chapter: chapters, part: parts, book: books };
    return results
      .sort((a, b) => b.score - a.score ||
        ((stamp[b.type]?.[b.id]?.updatedAt || 0) - (stamp[a.type]?.[a.id]?.updatedAt || 0)))
      .slice(0, limit);
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
      // `o` (order) is local-only: the tree needs it, KV metadata is
      // byte-capped, and order already travels inside the record itself.
      buildMeta: (type, rec) => { const { o, ...meta } = indexEntry(type, rec); return meta; },
    };
  }

  // ══ Moving things ════════════════════════════════════════════════
  //
  // Order lives on the child record, so a move is a write to the thing
  // being moved plus a renumber of its new siblings. No parent holds
  // an array of ids to keep in step.
  //
  // Renumbering uses whole integers rather than fractional midpoints.
  // Fractions avoid touching siblings but drift toward unreadable
  // precision after enough moves, and at a chapter's worth of scenes
  // the cost of rewriting the siblings is nothing.

  const PARENT_FIELD = { scene: 'chapterId', chapter: 'partId', book: 'projectId' };

  function siblingsOf(all, type, parentId, chapterParentBook = null) {
    return sortByOrder(Object.values(all).filter(r => {
      if (type === 'chapter') {
        // A chapter hangs off a part OR directly off a book, so its
        // parent is whichever is set.
        return (r.partId || null) === (parentId || null) &&
               (parentId ? true : (r.bookId || null) === (chapterParentBook || null));
      }
      return (r[PARENT_FIELD[type]] || null) === (parentId || null);
    }));
  }

  /**
   * moveRecord(type, id, { parentId, bookId, index }) — reposition one
   * record, returning what it takes to put it back.
   *
   * The return value is the undo: the parent and index it came from.
   * Structural moves are the one place in the app where a single
   * gesture can reorganise a manuscript, so every one of them has to
   * be reversible.
   */
  async function moveRecord(type, id, { parentId = null, bookId = null, index = null } = {}) {
    const rec = await get(type, id);
    if (!rec) return null;

    const all = await getAll(type);
    const field = PARENT_FIELD[type];
    const before = {
      parentId: rec[field] || null,
      bookId: type === 'chapter' ? (rec.bookId || null) : null,
      index: siblingsOf(all, type, rec[field] || null, rec.bookId || null)
        .findIndex(r => r.id === id),
    };

    const updated = { ...rec, [field]: parentId || null };
    if (type === 'chapter') {
      // A chapter always knows its book, whether or not it sits in a part.
      updated.bookId = bookId || rec.bookId || null;
    }

    const target = siblingsOf(all, type, parentId || null, updated.bookId)
      .filter(r => r.id !== id);
    const at = index === null || index > target.length ? target.length : Math.max(0, index);
    target.splice(at, 0, updated);

    for (let i = 0; i < target.length; i++) {
      const r = target[i];
      const next = r.id === id ? { ...updated, order: i } : { ...r, order: i };
      if (r.order !== i || r.id === id) await put(type, r.id, next);
    }

    return before;
  }

  // ── Structural deletes ────────────────────────────────────────────
  //
  // Only a scene holds prose, so only deleting a scene can lose words.
  // Deleting a container therefore DETACHES its children rather than
  // destroying them: chapters of a deleted part become loose, scenes of a
  // deleted chapter become unplaced. A structural tidy-up must never be a
  // way to silently lose a draft.

  async function deleteBook(id) {
    for (const p of Object.values(await getAll('part'))) {
      if (p.bookId === id) await put('part', p.id, { ...p, bookId: null });
    }
    for (const c of Object.values(await getAll('chapter'))) {
      if (c.bookId === id) await put('chapter', c.id, { ...c, bookId: null });
    }
    return remove('book', id);
  }

  // Deleting a part keeps its chapters, moving them up to sit directly
  // under the work — the same detach-not-destroy rule as everywhere else.
  async function deletePart(id) {
    const part = await get('part', id);
    for (const c of Object.values(await getAll('chapter'))) {
      if (c.partId === id) {
        await put('chapter', c.id, { ...c, partId: null, bookId: part?.bookId || c.bookId });
      }
    }
    return remove('part', id);
  }

  async function deleteChapter(id) {
    const scenes = await getAll('scene');
    for (const s of Object.values(scenes)) {
      if (s.chapterId === id) await put('scene', s.id, { ...s, chapterId: null });
    }
    return remove('chapter', id);
  }

  async function deleteScene(id) { return remove('scene', id); }

  /**
   * importRecords(records, { mode }) — restore from a backup.
   *
   *   'add'     insert records this device doesn't have. NEVER overwrites
   *             anything already here.
   *   'replace' wipe local content first, then write the backup verbatim.
   *
   * There is deliberately no newest-wins middle mode. That rule is right
   * for SYNC, where both sides are one account diverging and the loser is
   * recoverable from the other device. An import is a single irreversible
   * event against a file of unknown provenance: a backup from a machine
   * you'd been writing on could carry a draft you abandoned on purpose,
   * and "newer" would quietly reinstate it over your current text — with
   * no way to find out afterwards what it changed.
   *
   * If you do want newer-wins, that's a sync operation: point the other
   * device at this account and let record-level reconciliation do it.
   *
   * Every written record is marked dirty so a restore propagates to the
   * worker rather than sitting on one device.
   */
  async function importRecords(records, { mode = 'add' } = {}) {
    const stats = { added: 0, skipped: 0, byType: {} };
    if (!records || typeof records !== 'object') return stats;

    if (mode === 'replace') await clear();

    for (const type of TYPES) {
      const incoming = records[type];
      if (!incoming || typeof incoming !== 'object') continue;
      stats.byType[type] = 0;

      for (const [id, rec] of Object.entries(incoming)) {
        if (!rec || typeof rec !== 'object') continue;

        if (mode !== 'replace' && await get(type, id)) { stats.skipped++; continue; }

        // Written verbatim — ids, ordering and timestamps are the whole
        // point of the JSON copy. put() would stamp a new updatedAt and
        // make every restored record look freshly edited.
        const ok = await _write(type, id, { ...rec, id });
        if (ok) {
          stats.added++;
          stats.byType[type]++;
          if (typeof Sync !== 'undefined') Sync.markDirty(type, id);
        }
      }
    }
    return stats;
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
    moveRecord,
    createBeat, beatsAt, beatTree, unplannedScenes, deleteBeat,
    BEAT_LEVELS, BEAT_ROLES,
    createProject, listProjects, deleteProject, ensureProject,
    currentProject, setCurrentProject, getAllIn, PROJECT_SCOPED,
    createBook, createPart, createChapter, createScene, getTree, allChapters,
    deleteBook, deletePart, deleteChapter, deleteScene,
    // Cards
    createCard, findCardByName, CARD_TYPES,
    putImage, getImage, deleteImage,
    extractLinks, buildCardIndex, linkGraph, resolveLink, invalidateCards, LINK_RE,
    // Events
    createEvent, getTimeline, eventsForCard, PRECISIONS,
    // Helpers
    countWords, nextOrder, sortByOrder, newId, TYPES,
    search,
    // Wiring
    syncInterface,
    importRecords,
    clear,
  };
})();
