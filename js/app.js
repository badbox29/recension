/**
 * ============================================================
 * app.js — Recension
 * ============================================================
 *
 * Boot, the contents tree, tabs, the editor, and the wiring between
 * Auth / Sync / RecordStore.
 *
 * WHAT LIVES WHERE
 *   localStorage   small account + UI state only (App.data). Never content.
 *   IndexedDB      all content, via RecordStore. Source of truth.
 *   KV / R2        replica, via Sync. Losing it costs sync, not the novel.
 *
 * TWO MODES
 *   Desktop  full drafting surface — EasyMDE, editable metadata.
 *   Narrow   read-only. Title, metadata and prose all render as text.
 *            The manuscript travels; the drafting surface stays at the desk.
 *            This is a deliberate scope decision, not a limitation to fix
 *            later: CodeMirror 5 predates modern mobile input handling and
 *            fights Android IME and autocorrect. Rendering read-only is both
 *            less code and more reliable than making it editable.
 *
 * SAVE PATH
 *   keystroke → debounce 600ms → RecordStore.put() → marks dirty
 *             → Sync debounces 10s → batched push
 *   Nothing is ever saved by pushing to the server. The server is told
 *   afterwards.
 * ============================================================
 */

const STORAGE_KEY   = 'rec_appdata';
const AUTH_KEY      = 'rec_google_id_token';
const DISMISS_KEY   = 'rec_token_upgrade_dismissed';
const DARK_KEY      = 'rec_darkMode';

const SAVE_DEBOUNCE = 600;
const NARROW_QUERY  = '(max-width: 44rem)';

const App = {
  data: null,
  tree: null,
  activeScene: null,   // the full record currently in the editor
  editor: null,        // EasyMDE instance, created lazily
  readOnly: false,     // narrow viewport — editing disabled entirely

  // Continuous read-through. 'edit' shows one scene in the editor; 'read'
  // shows many scenes concatenated. Narrow viewports are locked to 'read',
  // which is why this is two modes and not three.
  view: 'edit',
  readScope: { kind: 'all', id: null },
  readReturn: null,    // where to land when coming back from an edit
};

const TYPE_KEY = 'rec_typography';

// ── Default state ──────────────────────────────────────────────────

function defaultData() {
  return {
    authMethod:   'guest',
    userToken:    Auth.generateToken(),
    workerUrl:    '',
    linkedGoogle: null,
    firstName: '', lastName: '', username: '',
    // Author identity, used by title pages and manuscript headers. Kept
    // separate from account fields: auth.js owns firstName/lastName for
    // the sign-in wizard, this is the publishing identity.
    author: {
      first: '', middle: '', last: '', pen: '',
      address: '', email: '', phone: '',
      agent: '', agentContact: '', copyright: '',
    },
    tabState:  { openIds: [], activeId: null },
    tocState:  { collapsedIds: [] },
    typewriter: false,
  };
}

function mergeData(raw) {
  const d = defaultData();
  if (!raw || typeof raw !== 'object') return d;
  return {
    ...d, ...raw,
    // defaultData() mints a fresh token every call, so any merge whose
    // input lacks one would silently replace the credential — and the app
    // would then be a different, empty account. The account record never
    // carries userToken (it's a credential, deliberately not synced), so
    // this path is hit on every pull. Keep what we already have.
    userToken: raw?.userToken || App.data?.userToken || d.userToken,
    author: { ...d.author, ...(raw.author && typeof raw.author === 'object' ? raw.author : {}) },
    tabState: (raw.tabState && typeof raw.tabState === 'object')
      ? { openIds: Array.isArray(raw.tabState.openIds) ? raw.tabState.openIds : [],
          activeId: raw.tabState.activeId ?? null }
      : d.tabState,
    tocState: (raw.tocState && typeof raw.tocState === 'object')
      ? { collapsedIds: Array.isArray(raw.tocState.collapsedIds) ? raw.tocState.collapsedIds : [] }
      : d.tocState,
  };
}

/**
 * accountForSync() — an explicit allowlist of what goes to KV.
 *
 * Remnant spread its whole state object into the payload, which dragged
 * userToken and workerUrl into storage as a side effect. Those are
 * per-device facts and credentials; they stay local.
 */
function accountForSync() {
  const d = App.data;
  return {
    authMethod: d.authMethod,
    linkedGoogle: d.linkedGoogle,
    // firstName/lastName/username were auth.js's own fields. They were
    // removed from the sign-up wizard (the author block below is the real
    // identity), so there is nothing left to replicate.
    author: d.author,
    tabState: d.tabState,
    tocState: d.tocState,
    typewriter: d.typewriter,
  };
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    App.data = mergeData(raw ? JSON.parse(raw) : null);
  } catch { App.data = defaultData(); }
}

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(App.data)); } catch {}
}

// Account state changed in a way worth replicating.
function saveAccount() {
  saveLocal();
  if (typeof Sync !== 'undefined') Sync.markAccountDirty();
}

// ── Typography ─────────────────────────────────────────────────────
//
// Measure and size are separate knobs and are often confused. Measure is
// characters per line and changes reading rhythm; size is how big the type
// is and changes eye strain. "Too narrow" usually means size, not measure.
//
// Stored per-device. It depends on the monitor you're sitting at, so
// syncing it across devices would be actively wrong.

const TYPE_DEFAULTS = { measure: 'book', size: 'md', readTitles: true };

function loadTypography() {
  let t = TYPE_DEFAULTS;
  try { t = { ...TYPE_DEFAULTS, ...(JSON.parse(localStorage.getItem(TYPE_KEY)) || {}) }; } catch {}
  applyTypography(t);
  return t;
}

function applyTypography(t) {
  document.documentElement.dataset.measure = t.measure;
  document.documentElement.dataset.size    = t.size;
  App.typography = t;
  try { localStorage.setItem(TYPE_KEY, JSON.stringify(t)); } catch {}
  App.editor?.codemirror?.refresh();
}

function setTypography(patch) {
  applyTypography({ ...App.typography, ...patch });
  syncTypePopover();
  if (App.view === 'read') renderReadView();
}

function syncTypePopover() {
  const t = App.typography;
  for (const b of document.querySelectorAll('[data-measure]'))
    b.setAttribute('aria-pressed', String(b.dataset.measure === t.measure));
  for (const b of document.querySelectorAll('[data-size]'))
    b.setAttribute('aria-pressed', String(b.dataset.size === t.size));
  $('pop-titles').checked = !!t.readTitles;
}

// ── Small DOM helpers ──────────────────────────────────────────────

const $ = id => document.getElementById(id);

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function openModal(id)  { const m = $(id); if (m) m.hidden = false; }
function closeModal(id) { const m = $(id); if (m) m.hidden = true; }

let _toastTimer = null;
function showToast(msg, duration = 3000) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.hidden = true; }, duration);
}

let _confirmHandler = null;
function showConfirm(message, onConfirm, okLabel = 'Delete') {
  $('confirm-message').textContent = message;
  $('confirm-ok-btn').textContent = okLabel;
  _confirmHandler = onConfirm;
  openModal('modal-confirm');
}

// ── Sync status indicator ──────────────────────────────────────────

function setSyncState(state, detail) {
  const dot = $('sync-dot');
  if (!dot) return;
  dot.dataset.state = state;
  dot.title = detail || ({
    idle: 'Saved', syncing: 'Syncing…', dirty: 'Unsaved changes',
    error: 'Sync problem', offline: 'Offline',
  }[state] || '');
}

async function refreshSyncState() {
  if (Auth.isGuest())    return setSyncState('idle', 'Local only');
  if (!App.data.workerUrl) return setSyncState('idle', 'Sync not set up');
  const pending = await Sync.pendingCount();
  setSyncState(pending ? 'dirty' : 'idle');
}

// ── Minimal markdown for read-only rendering ───────────────────────
//
// Deliberately small. The reading view needs paragraphs, emphasis,
// headings, and blockquotes — the things prose actually uses. Pulling in a
// full parser for that would be weight on the mobile path, which is the one
// place weight matters most.

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function renderMarkdown(md) {
  if (!md) return '';
  const blocks = escapeHtml(md).split(/\n{2,}/);
  return blocks.map(block => {
    const b = block.trim();
    if (!b) return '';
    const h = b.match(/^(#{1,3})\s+(.*)$/s);
    if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    if (/^>\s?/.test(b)) return `<blockquote>${inline(b.replace(/^>\s?/gm, ''))}</blockquote>`;
    if (/^(\*\s*){3,}$|^(-\s*){3,}$/.test(b)) return '<hr />';
    return `<p>${inline(b)}</p>`;
  }).join('');

  function inline(t) {
    return t
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|\W)_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/\n/g, '<br />');
  }
}

// ── Contents tree ──────────────────────────────────────────────────

function isCollapsed(id) { return App.data.tocState.collapsedIds.includes(id); }

function setCollapsed(id, collapsed) {
  const set = new Set(App.data.tocState.collapsedIds);
  collapsed ? set.add(id) : set.delete(id);
  App.data.tocState.collapsedIds = [...set];
  saveAccount();
}

function fmtWords(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);
}

// One contents line: title, leader, figure. The leader is what makes this
// read as a table of contents rather than a file list.
//
// Every row carries the same actions (rename, delete) behind a hover
// affordance. Parts previously had none at all, which made a mistyped part
// permanent — the row menu is what fixes that.
function tocLine(node, { className, kind, id, title, figure, status, onOpen, current }) {
  const row = el(node, className);
  if (kind) { row.dataset.kind = kind; row.dataset.id = id; }

  const label = el('span', 'toc-title', title || 'Untitled');
  row.append(label);

  if (status) {
    const m = el('span', 'toc-mark');
    m.dataset.status = status;
    row.append(m);
  }
  row.append(el('span', 'toc-leader'));
  if (figure != null) row.append(el('span', 'toc-figure', figure));

  if (kind) {
    const more = el('button', 'toc-more', '\u22EF');
    more.setAttribute('aria-label', `Actions for ${title || 'item'}`);
    more.addEventListener('click', e => {
      e.stopPropagation();
      openRowMenu(more, kind, id, title);
    });
    row.append(more);
    // Double-click the row to rename — the fast path once you know it's there.
    row.addEventListener('dblclick', e => {
      e.stopPropagation();
      startRename(label, kind, id, title);
    });
  }

  if (current) row.setAttribute('aria-current', 'true');
  if (onOpen) row.addEventListener('click', onOpen);
  return row;
}

// ── Row menu ───────────────────────────────────────────────────────

let _menu = null;
function closeRowMenu() { _menu?.remove(); _menu = null; }
document.addEventListener('click', closeRowMenu);

const KIND_LABEL = { book: 'part', chapter: 'chapter', scene: 'scene' };

function openRowMenu(anchor, kind, id, title) {
  closeRowMenu();
  const menu = el('div', 'row-menu');

  const rename = el('button', null, 'Rename');
  rename.addEventListener('click', e => {
    e.stopPropagation();
    closeRowMenu();
    const label = anchor.parentElement.querySelector('.toc-title');
    startRename(label, kind, id, title);
  });

  const del = el('button', 'danger', 'Delete');
  del.addEventListener('click', e => {
    e.stopPropagation();
    closeRowMenu();
    confirmDelete(kind, id, title);
  });

  menu.append(rename, del);
  document.body.append(menu);

  const r = anchor.getBoundingClientRect();
  menu.style.top  = `${r.bottom + 4}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  _menu = menu;
}

// ── Name prompt ────────────────────────────────────────────────────
//
// Used when creating a part or chapter. Naming at creation beats creating
// an "Untitled" record and hunting for the rename: the structural level
// only exists because you had a name in mind for it.
//
// Built in JS rather than markup so the modal lives next to its only
// caller. Returns the trimmed name, or null if cancelled.

function askName(heading, placeholder, initial = '') {
  return new Promise(resolve => {
    const overlay = el('div', 'modal-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const modal = el('div', 'modal modal-sm');
    const head  = el('div', 'modal-header');
    head.append(el('h2', 'modal-title', heading));

    const body  = el('div', 'modal-body');
    const input = el('input', 'name-input');
    input.placeholder = placeholder;
    input.value = initial;
    input.setAttribute('aria-label', heading);

    const actions = el('div', 'modal-actions');
    const cancel  = el('button', 'ghost-btn', 'Cancel');
    const create  = el('button', 'solid-btn', 'Create');

    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const submit = () => done(input.value.trim() || null);

    cancel.addEventListener('click', () => done(null));
    create.addEventListener('click', submit);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(null); });

    // Captured, so Escape closes this and not whatever is underneath it.
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); submit(); }
    }
    document.addEventListener('keydown', onKey, true);

    actions.append(cancel, create);
    body.append(input, actions);
    modal.append(head, body);
    overlay.append(modal);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

// ── Inline rename ──────────────────────────────────────────────────
// Swaps the title span for an input in place. A prompt() dialog would be
// fewer lines but throws you out of the page you're reading.

function startRename(labelEl, kind, id, current) {
  if (!labelEl || labelEl.dataset.editing) return;
  labelEl.dataset.editing = '1';

  const input = el('input', 'toc-rename');
  input.value = current || '';
  input.setAttribute('aria-label', `Rename ${KIND_LABEL[kind] || 'item'}`);
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const commit = async (save) => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    input.replaceWith(labelEl);
    delete labelEl.dataset.editing;
    if (save && next && next !== current) {
      const rec = await RecordStore.get(kind, id);
      if (rec) await RecordStore.put(kind, id, { ...rec, title: next });
      await renderTree();
      renderTabs();
      refreshSyncState();
    }
  };

  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('dblclick', e => e.stopPropagation());
}

// ── Delete ─────────────────────────────────────────────────────────
// Containers detach their children rather than destroying them, so the
// confirm text says exactly what will happen to the words.

function confirmDelete(kind, id, title) {
  const name = title || `this ${KIND_LABEL[kind]}`;
  const message = {
    book:    `Delete "${name}"? Its chapters stay, moved to the top level.`,
    chapter: `Delete "${name}"? Its scenes stay, moved to Unplaced.`,
    scene:   `Delete "${name}"? The text in it is lost.`,
  }[kind];

  showConfirm(message, async () => {
    if (kind === 'book')    await RecordStore.deleteBook(id);
    if (kind === 'chapter') await RecordStore.deleteChapter(id);
    if (kind === 'scene') {
      await RecordStore.deleteScene(id);
      App.data.tabState.openIds = App.data.tabState.openIds.filter(x => x !== id);
      if (App.data.tabState.activeId === id) {
        App.activeScene = null;
        App.data.tabState.activeId = App.data.tabState.openIds.at(-1) || null;
      }
      saveAccount();
    }
    await renderTree();
    renderTabs();
    App.data.tabState.activeId ? openScene(App.data.tabState.activeId) : showEmpty();
    refreshSyncState();
  });
}

// ── Tree ───────────────────────────────────────────────────────────

async function renderTree() {
  App.tree = await RecordStore.getTree();
  const toc = $('toc');
  toc.replaceChildren();

  for (const book of App.tree.books) {
    const collapsed = isCollapsed(book.id);
    const bookWords = book.chapters.reduce(
      (n, c) => n + c.scenes.reduce((m, s) => m + (s.wordCount || 0), 0), 0);

    const partRow = tocLine('div', {
      className: 'toc-part',
      kind: 'book', id: book.id,
      title: book.title,
      figure: fmtWords(bookWords),
      onOpen: () => openRead({ kind: 'book', id: book.id }),
    });
    const caret = el('span', 'caret', collapsed ? '\u25B8' : '\u25BE');
    caret.addEventListener('click', e => {
      e.stopPropagation();
      setCollapsed(book.id, !collapsed);
      renderTree();
    });
    partRow.prepend(caret);
    toc.append(partRow);
    if (collapsed) continue;

    for (const ch of book.chapters) toc.append(...chapterRows(ch, 'toc-chapter'));

    const addCh = el('button', 'toc-add toc-add-chapter', '+ chapter');
    addCh.addEventListener('click', () => newChapter(book.id));
    toc.append(addCh);
  }

  // Chapters with no part. Parts are optional — see createChapter().
  for (const ch of App.tree.looseChapters) toc.append(...chapterRows(ch, 'toc-chapter loose'));

  // A top-level "+ chapter" only when there are no parts. With parts on the
  // page it would be ambiguous which one it adds to, and each part already
  // carries its own — that ambiguity was the duplicate button.
  if (!App.tree.books.length) {
    const addLoose = el('button', 'toc-add toc-add-chapter', '+ chapter');
    addLoose.addEventListener('click', () => newChapter(null));
    toc.append(addLoose);
  }

  // Unplaced scenes and their add action stay together, so "+ scene" here
  // reads as "add to Unplaced" rather than as a second global button.
  toc.append(el('div', 'toc-group-label', 'Unplaced'));
  for (const sc of App.tree.unfiled) toc.append(sceneRow(sc));
  const addScene = el('button', 'toc-add', '+ scene');
  addScene.addEventListener('click', async () => {
    const id = await RecordStore.createScene(null);
    if (id) { await renderTree(); openScene(id); }
  });
  toc.append(addScene);

  $('rail-total').textContent = `${App.tree.totalWords.toLocaleString()} words`;
}

function chapterRows(ch, className) {
  const rows = [];
  const chWords = ch.scenes.reduce((n, s) => n + (s.wordCount || 0), 0);
  const collapsed = isCollapsed(ch.id);

  const row = tocLine('div', {
    className,
    kind: 'chapter', id: ch.id,
    title: ch.title,
    figure: fmtWords(chWords),
    onOpen: () => openRead({ kind: 'chapter', id: ch.id }),
  });
  const caret = el('span', 'caret', collapsed ? '\u25B8' : '\u25BE');
  caret.addEventListener('click', e => {
    e.stopPropagation();
    setCollapsed(ch.id, !collapsed);
    renderTree();
  });
  row.prepend(caret);
  rows.push(row);
  if (collapsed) return rows;

  for (const sc of ch.scenes) rows.push(sceneRow(sc));

  const add = el('button', 'toc-add', '+ scene');
  add.addEventListener('click', async () => {
    const id = await RecordStore.createScene(ch.id);
    if (id) { await renderTree(); openScene(id); }
  });
  rows.push(add);
  return rows;
}

async function newPart() {
  const name = await askName('New part', 'Part One');
  if (!name) return;
  await RecordStore.createBook(name);
  renderTree();
}

async function newChapter(bookId) {
  const name = await askName('New chapter', 'Chapter One');
  if (!name) return;
  await RecordStore.createChapter(bookId, name);
  renderTree();
}

function sceneRow(sc) {
  return tocLine('button', {
    className: 'toc-scene',
    kind: 'scene', id: sc.id,
    title: sc.title,
    figure: fmtWords(sc.wordCount),
    status: sc.status && sc.status !== 'draft' ? sc.status : null,
    current: App.data.tabState.activeId === sc.id,
    onOpen: () => { openScene(sc.id); if (App.readOnly) closeRail(); },
  });
}

// ── Continuous read-through ────────────────────────────────────────
//
// Scrivener calls this Scrivenings. It's read-only here on purpose:
// reading a draft and revising it are different activities, and click is
// already how you select text. If clicking dropped you into an editor, you
// could never select a sentence or double-click a word — and the gesture
// would be unrecoverable mid-flow.
//
// Editing is reached deliberately instead: a margin marker at each scene
// boundary (never ambiguous about which scene it means, unlike a floating
// button when two scenes are half on screen), or the E key for the scene
// currently centred.

function scopeLabel(scope) {
  if (scope.kind === 'all') return 'Whole manuscript';
  if (scope.kind === 'book')
    return App.tree.books.find(b => b.id === scope.id)?.title || 'Part';
  const all = [...App.tree.books.flatMap(b => b.chapters), ...App.tree.looseChapters];
  return all.find(c => c.id === scope.id)?.title || 'Chapter';
}

// scenesInScope() — scenes in tree order, each tagged with the chapter it
// came from so the read view can show breaks between chapters.
function scenesInScope(scope) {
  const out = [];
  const pushChapter = ch => ch.scenes.forEach((sc, i) =>
    out.push({ ...sc, chapterTitle: ch.title, chapterId: ch.id, firstInChapter: i === 0 }));

  if (scope.kind === 'chapter') {
    const all = [...App.tree.books.flatMap(b => b.chapters), ...App.tree.looseChapters];
    const ch = all.find(c => c.id === scope.id);
    if (ch) pushChapter(ch);
    return out;
  }
  const books = scope.kind === 'book'
    ? App.tree.books.filter(b => b.id === scope.id)
    : App.tree.books;
  for (const b of books) for (const ch of b.chapters) pushChapter(ch);
  if (scope.kind === 'all') {
    for (const ch of App.tree.looseChapters) pushChapter(ch);
    App.tree.unfiled.forEach(sc =>
      out.push({ ...sc, chapterTitle: null, firstInChapter: false }));
  }
  return out;
}

async function openRead(scope = { kind: 'all', id: null }, focusSceneId = null) {
  if (App.activeScene) await flushActiveScene();
  App.view = 'read';
  App.readScope = scope;

  $('empty').hidden = true;
  $('scene').hidden = true;
  $('readview').hidden = false;
  $('btn-read').setAttribute('aria-pressed', 'true');

  await renderReadView();

  if (focusSceneId) {
    const node = document.querySelector(`.rv-scene[data-id="${focusSceneId}"]`);
    node?.scrollIntoView({ block: 'start' });
  } else {
    $('sheet').scrollTop = 0;
  }
  updateSpy();
}

async function renderReadView() {
  const rv = $('readview');
  rv.replaceChildren();

  const scenes = scenesInScope(App.readScope);
  const words = scenes.reduce((n, s) => n + (s.wordCount || 0), 0);

  const head = el('header', 'rv-head');
  head.append(el('h1', null, scopeLabel(App.readScope)));
  head.append(el('p', 'rv-count',
    `${words.toLocaleString()} words · ${scenes.length} scene${scenes.length === 1 ? '' : 's'}`));
  rv.append(head);

  if (!scenes.length) {
    rv.append(el('p', 'rv-empty', 'Nothing written here yet.'));
    return;
  }

  // Bodies aren't in the tree index, so they're read here — the one place
  // in the app that deliberately loads many scene bodies at once.
  for (const meta of scenes) {
    const rec = await RecordStore.get('scene', meta.id);
    if (!rec) continue;

    if (meta.firstInChapter && meta.chapterTitle && App.readScope.kind !== 'chapter') {
      rv.append(el('h2', 'rv-chapter', meta.chapterTitle));
    }

    const sec = el('section', 'rv-scene');
    sec.dataset.id = meta.id;

    // Margin marker: anchored to the scene, so it is never ambiguous which
    // scene it would open.
    const mark = el('button', 'rv-edit');
    mark.type = 'button';
    mark.setAttribute('aria-label', `Edit "${rec.title || 'scene'}"`);
    mark.innerHTML = '<svg viewBox="0 0 20 20"><path d="M13.5 3.5l3 3L7 16H4v-3z"/></svg>';
    mark.addEventListener('click', () => editFromRead(meta.id));
    sec.append(mark);

    if (App.typography.readTitles) {
      const t = el('h3', 'rv-title', rec.title || 'Untitled scene');
      sec.append(t);
    } else if (!meta.firstInChapter) {
      sec.append(el('div', 'rv-break', '\u00A7'));
    }

    const body = el('div', 'rv-body');
    body.innerHTML = renderMarkdown(rec.body) ||
      '<p class="rv-blank">This scene is empty.</p>';
    sec.append(body);
    rv.append(sec);
  }
}

// ── Scroll-spy ─────────────────────────────────────────────────────
// Whichever scene occupies the middle of the viewport is "where you are".
// Drives both the contents highlight and the tab bar, so you always know
// your position without looking away from the prose.

let _spyRaf = null;
function updateSpy() {
  if (App.view !== 'read') return;
  const centred = centredScene();
  if (!centred || centred === App.data.tabState.activeId) return;
  App.data.tabState.activeId = centred;
  saveLocal();              // position, not content — no need to sync it
  renderTree();
  renderTabs();
}

function centredScene() {
  const mid = window.innerHeight / 2;
  let best = null, bestDist = Infinity;
  for (const sec of document.querySelectorAll('.rv-scene')) {
    const r = sec.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) continue;
    const dist = Math.abs(Math.max(r.top, 0) - mid);
    if (r.top <= mid && r.bottom >= mid) return sec.dataset.id;
    if (dist < bestDist) { bestDist = dist; best = sec.dataset.id; }
  }
  return best;
}

// ── Read ⇄ edit handoff ────────────────────────────────────────────

// Land near the paragraph you were looking at, not at the top of the
// scene. Otherwise every edit starts with hunting for the sentence that
// bothered you. Paragraph index is approximate and that's fine.
function paragraphAtViewport(sceneEl) {
  if (!sceneEl) return 0;
  const paras = sceneEl.querySelectorAll('.rv-body > *');
  const mid = window.innerHeight / 2;
  let idx = 0;
  paras.forEach((p, i) => { if (p.getBoundingClientRect().top <= mid) idx = i; });
  return idx;
}

async function editFromRead(sceneId) {
  if (App.readOnly) return;   // narrow viewports don't edit at all
  const sec = document.querySelector(`.rv-scene[data-id="${sceneId}"]`);
  App.readReturn = { scope: App.readScope, sceneId, para: paragraphAtViewport(sec) };

  App.view = 'edit';
  $('readview').hidden = true;
  $('btn-read').setAttribute('aria-pressed', 'false');
  await openScene(sceneId);

  // Put the caret on roughly the paragraph that was on screen.
  const cm = App.editor?.codemirror;
  if (cm && App.readReturn.para > 0) {
    const blocks = (App.activeScene.body || '').split(/\n{2,}/);
    const upto = blocks.slice(0, App.readReturn.para).join('\n\n');
    const line = upto ? upto.split('\n').length : 0;
    cm.setCursor({ line, ch: 0 });
    cm.scrollIntoView({ line, ch: 0 }, 200);
  }
}

// Reciprocal: closing the editor returns to the same place in the read
// view. A one-way trip would lose your place on every typo fix.
async function backToRead() {
  const ret = App.readReturn;
  App.readReturn = null;
  await openRead(ret?.scope || { kind: 'all', id: null }, ret?.sceneId || null);
}

function toggleRead() {
  if (App.view === 'read') {
    App.readReturn
      ? editFromRead(App.data.tabState.activeId)
      : exitRead();
  } else {
    openRead({ kind: 'all', id: null }, App.data.tabState.activeId);
  }
}

function exitRead() {
  App.view = 'edit';
  $('readview').hidden = true;
  $('btn-read').setAttribute('aria-pressed', 'false');
  App.data.tabState.activeId ? openScene(App.data.tabState.activeId) : showEmpty();
}

// ── Tabs ───────────────────────────────────────────────────────────

function renderTabs() {
  const bar = $('tabs');
  bar.replaceChildren();

  for (const id of App.data.tabState.openIds) {
    const meta = findSceneMeta(id);
    if (!meta) continue;

    const tab = el('button', 'tab');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(App.data.tabState.activeId === id));
    tab.append(el('span', 'tab-label', meta.title || 'Untitled'));

    const close = el('button', 'tab-close');
    close.setAttribute('aria-label', `Close ${meta.title || 'scene'}`);
    close.innerHTML = '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>';
    close.addEventListener('click', e => { e.stopPropagation(); closeTab(id); });

    tab.append(close);
    tab.addEventListener('click', () => openScene(id));
    bar.append(tab);
  }
}

function findSceneMeta(id) {
  if (!App.tree) return null;
  for (const b of App.tree.books)
    for (const c of b.chapters) {
      const hit = c.scenes.find(s => s.id === id);
      if (hit) return hit;
    }
  return App.tree.unfiled.find(s => s.id === id) || null;
}

async function closeTab(id) {
  if (App.data.tabState.activeId === id) await flushActiveScene();
  App.data.tabState.openIds = App.data.tabState.openIds.filter(x => x !== id);
  if (App.data.tabState.activeId === id) {
    App.data.tabState.activeId = App.data.tabState.openIds.at(-1) || null;
  }
  saveAccount();
  renderTabs();
  App.data.tabState.activeId ? openScene(App.data.tabState.activeId) : showEmpty();
}

// ── Editor ─────────────────────────────────────────────────────────

function ensureEditor() {
  if (App.editor || App.readOnly) return App.editor;
  App.editor = new EasyMDE({
    element: $('editor'),
    toolbar: false,
    status: false,
    spellChecker: false,
    autofocus: false,
    placeholder: 'Begin.',
    lineWrapping: true,
    // Markdown in, markdown out. No smart substitution — an editor that
    // rewrites what you typed is an editor you have to fight.
    autoDownloadFontAwesome: false,
  });
  App.editor.codemirror.on('change', () => {
    scheduleSave();
    updateTally();
  });
  // cursorActivity covers typing, arrow keys, and clicks alike — all the
  // ways the caret can end up on a different line.
  App.editor.codemirror.on('cursorActivity', () => {
    if (App.data.typewriter) typewriterScroll();
  });
  return App.editor;
}

// ── Typewriter scrolling ───────────────────────────────────────────
//
// Behaviour, deliberately in this order:
//
//   1. A scene opens at the top, as normal. No blank space, no jump.
//   2. Text fills downward until the caret reaches the hold line (a little
//      above centre).
//   3. From there the caret STAYS PUT and the text scrolls up past it.
//
// Two mistakes are easy to make here and I made both.
//
// COORDINATES. CodeMirror runs in auto-height mode with its own scrolling
// disabled; #sheet is the scroller. getScrollInfo() therefore reports the
// whole document height, not a viewport, and 'local' cursor coords are
// relative to CodeMirror rather than the page. Everything below is in
// viewport coordinates.
//
// WRAPPED LINES ARE NOT NEW LINES. Gating on cm.getCursor().line looks
// right and is wrong: typing a long paragraph wraps across many visual
// rows while the LOGICAL line number never changes, so the gate blocks
// every scroll and the text just fills to the bottom. The only thing that
// matters is the caret's pixel height, so that is what's measured.

// Extra slack BELOW the text, so the last lines of a scene can still be
// pulled up to the hold line. Nothing is added above: the scene should
// open at the top exactly as it does with the mode off.
function applyTypewriterMode(on) {
  document.documentElement.classList.toggle('typewriter', !!on);
  App.editor?.codemirror?.refresh();
}

// Where the caret comes to rest, as a fraction of the visible height.
// Slightly above centre — dead centre leaves so much blank below that it
// reads as writing into a void.
const TYPEWRITER_ANCHOR = 0.44;

function typewriterScroll(force = false) {
  const cm = App.editor?.codemirror;
  if (!cm) return;

  const sheet = $('sheet');
  const view  = sheet.getBoundingClientRect();
  const caret = cm.cursorCoords(null, 'window');   // viewport coords
  const target = view.top + view.height * TYPEWRITER_ANCHOR;
  const delta  = caret.top - target;

  // Above the hold line: let the page fill normally. This is what makes a
  // fresh scene start at the top instead of in the middle of nowhere.
  // `force` overrides it — opening an existing scene pulls the caret up to
  // the hold line so you carry on writing from there.
  if (!force && delta <= 0) return;
  if (Math.abs(delta) < 1) return;

  sheet.scrollTop += delta;
}

function updateTally() {
  const text = App.readOnly
    ? (App.activeScene?.body || '')
    : (App.editor?.value() || '');
  const n = RecordStore.countWords(text);
  $('tally').textContent = n ? `${n.toLocaleString()} words` : '';
}

let _saveTimer = null;
function scheduleSave() {
  setSyncState('dirty');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { flushActiveScene(); }, SAVE_DEBOUNCE);
}

/**
 * flushActiveScene() — write the open scene to IndexedDB.
 *
 * This is the actual save. Sync happens later and separately; if the
 * network is gone or the worker is down, the work is still safe here.
 */
async function flushActiveScene() {
  clearTimeout(_saveTimer);
  const sc = App.activeScene;
  if (!sc || App.readOnly) return;

  const next = {
    ...sc,
    title:    $('scene-title').value.trim() || 'Untitled scene',
    pov:      $('scene-pov').value.trim(),
    status:   $('scene-status').value,
    synopsis: $('scene-synopsis').value.trim(),
    body:     App.editor ? App.editor.value() : sc.body,
  };

  // Nothing changed — don't bump updatedAt and don't mark dirty. Otherwise
  // opening a scene and closing it again would queue a pointless sync.
  const unchanged = ['title','pov','status','synopsis','body']
    .every(k => next[k] === sc[k]);
  if (unchanged) { refreshSyncState(); return; }

  await RecordStore.put('scene', sc.id, next);
  App.activeScene = { ...next };
  await renderTree();
  renderTabs();
  refreshSyncState();
}

// ── Opening scenes ─────────────────────────────────────────────────

async function openScene(id) {
  if (App.activeScene && App.activeScene.id !== id) await flushActiveScene();

  const sc = await RecordStore.get('scene', id);
  if (!sc) { showToast('That scene is gone.'); await renderTree(); return; }

  App.activeScene = sc;
  if (!App.data.tabState.openIds.includes(id)) App.data.tabState.openIds.push(id);
  App.data.tabState.activeId = id;
  saveAccount();

  App.view = 'edit';
  $('readview').hidden = true;
  $('btn-read').setAttribute('aria-pressed', 'false');
  $('empty').hidden = true;
  $('scene').hidden = false;

  $('scene-title').value    = sc.title || '';
  $('scene-pov').value      = sc.pov || '';
  $('scene-status').value   = sc.status || 'draft';
  $('scene-synopsis').value = sc.synopsis || '';

  if (App.readOnly) {
    $('prose').hidden = true;
    $('reading').hidden = false;
    $('reading').innerHTML = renderMarkdown(sc.body) ||
      '<p style="color:var(--ink-faint)">This scene is empty.</p>';
  } else {
    $('prose').hidden = false;
    $('reading').hidden = true;
    ensureEditor();
    // setValue fires a change event; suppress the save it would schedule,
    // or merely opening a scene would mark it dirty.
    const cm = App.editor.codemirror;
    const prev = App.editor.value();
    if (prev !== (sc.body || '')) {
      App.editor.value(sc.body || '');
      clearTimeout(_saveTimer);
    }
    cm.refresh();
    cm.clearHistory();   // undo must not cross scene boundaries
    // Opening an existing scene with text in it: put the caret at the end
    // and pull it up to the hold line, so you resume writing from there
    // rather than from the top of the page.
    if (App.data.typewriter && (sc.body || '').length) {
      cm.setCursor(cm.lineCount(), 0);
      requestAnimationFrame(() => typewriterScroll(true));
    }
  }

  updateTally();
  renderTabs();
  await renderTree();
  $('sheet').scrollTop = 0;
}

function showEmpty() {
  App.activeScene = null;
  $('scene').hidden = true;
  $('empty').hidden = false;
  $('tally').textContent = '';
}

// ── Rail ───────────────────────────────────────────────────────────

function openRail()  { $('rail').classList.add('open');  $('scrim').hidden = false;
                       $('btn-contents').setAttribute('aria-expanded', 'true'); }
function closeRail() { $('rail').classList.remove('open'); $('scrim').hidden = true;
                       $('btn-contents').setAttribute('aria-expanded', 'false'); }
function toggleRail() {
  if (App.readOnly) {
    $('rail').classList.contains('open') ? closeRail() : openRail();
  } else {
    const r = $('rail');
    r.hidden = !r.hidden;
    $('btn-contents').setAttribute('aria-expanded', String(!r.hidden));
  }
}

// ── Settings ───────────────────────────────────────────────────────

// Which tab was last open, remembered per device. Coming back to Settings
// and landing somewhere other than where you left is a small, repeated
// irritation.
let _settingsTab = 'interface';

function showSettingsTab(name) {
  _settingsTab = name;
  for (const b of document.querySelectorAll('.set-tabs [role="tab"]'))
    b.setAttribute('aria-selected', String(b.dataset.panel === name));
  // Class, not the hidden attribute: the panels are stacked in one grid
  // cell and the inactive ones stay in flow (visibility:hidden) so the
  // modal keeps the height of the tallest. visibility:hidden also takes
  // them out of the tab order and hides them from screen readers, which
  // display:none would do but opacity:0 would not.
  for (const p of document.querySelectorAll('.set-panel'))
    p.classList.toggle('is-active', p.id === `panel-${name}`);
  document.querySelector('#modal-settings .modal-body').scrollTop = 0;
}

function bindSettingsTabs() {
  const tabs = [...document.querySelectorAll('.set-tabs [role="tab"]')];
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => showSettingsTab(b.dataset.panel));
    // Arrow keys move between tabs, as a tablist should.
    b.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = tabs[(i + d + tabs.length) % tabs.length];
      next.focus();
      showSettingsTab(next.dataset.panel);
    });
  });
}


function openSettings() {
  $('set-dark').checked = document.documentElement.classList.contains('dark');
  $('set-typewriter').checked = !!App.data.typewriter;
  $('set-worker').value = App.data.workerUrl || '';

  Sync.lastSyncTime().then(t => {
    $('sync-note').textContent = !App.data.workerUrl
      ? 'Add your worker address to sync across devices.'
      : t ? `Last synced ${new Date(t).toLocaleString()}.`
          : 'Not synced yet.';
  });

  if (typeof Auth?.renderSettingsSection === 'function') Auth.renderSettingsSection();
  // Sync and account actions are meaningless as a guest — there's nothing
  // to sync with yet. Hide rather than disable: a dead button invites a
  // click and then explains itself, which is worse than not being there.
  $('account-actions').style.display = Auth.isGuest() ? 'none' : '';
  loadAuthorFields();
  showSettingsTab(_settingsTab);
  openModal('modal-settings');
}

/**
 * saveWorkerUrl() — store the address and immediately say whether it works.
 *
 * Saving silently is the wrong shape here: a typo in this field produces no
 * error until some later sync fails for reasons that look unrelated.
 * GET /ping is unauthenticated and cheap, so the field can verify itself.
 */
async function saveWorkerUrl() {
  const raw = $('set-worker').value.trim().replace(/\/+$/, '');
  const note = $('sync-note');

  if (!raw) {
    App.data.workerUrl = '';
    saveLocal();
    note.textContent = 'Sync is off. Everything stays on this device.';
    showToast('Sync turned off.');
    return;
  }

  if (!/^https?:\/\//i.test(raw)) {
    note.textContent = 'Include the https:// at the start of the address.';
    return;
  }

  App.data.workerUrl = raw;
  saveLocal();
  $('set-worker').value = raw;
  note.textContent = 'Checking…';

  try {
    const res = await fetch(`${raw}/ping`);
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (body?.ok) {
      note.textContent = 'Connected. Set up an account below to start syncing.';
      showToast('Worker connected.');
      if (!Auth.isGuest()) Sync.start();
    } else {
      note.textContent = `Reached that address, but it answered ${res.status}. Check the URL points at your worker.`;
    }
  } catch {
    note.textContent = 'Saved, but that address did not answer. Check it and your connection.';
  }
}

// ── Author details ─────────────────────────────────────────────────
// Saved on blur rather than per keystroke: these are typed once and
// rarely touched, so there's no reason to queue a sync on every letter.

const AUTHOR_FIELDS = {"au-first": "first", "au-middle": "middle", "au-last": "last", "au-pen": "pen", "au-address": "address", "au-email": "email", "au-phone": "phone", "au-agent": "agent", "au-agent-contact": "agentContact", "au-copyright": "copyright"};

function loadAuthorFields() {
  for (const [id, key] of Object.entries(AUTHOR_FIELDS)) {
    const node = $(id);
    if (node) node.value = App.data.author?.[key] || '';
  }
}

function bindAuthorFields() {
  for (const [id, key] of Object.entries(AUTHOR_FIELDS)) {
    const node = $(id);
    if (!node) continue;
    node.addEventListener('change', () => {
      App.data.author = { ...App.data.author, [key]: node.value.trim() };
      saveAccount();
    });
  }
}

// authorByline() — what goes under a title. Falls back through byline,
// full name, then nothing, so a title page never prints a stray comma.
function authorByline() {
  const a = App.data.author || {};
  if (a.pen) return a.pen;
  return [a.first, a.middle, a.last].filter(Boolean).join(' ');
}

// ══ Export ═════════════════════════════════════════════════════════
//
// Two different jobs, deliberately two different files.
//
//   BACKUP   Everything, restorable. One .md per scene in a folder tree
//            you can read without this app, plus a JSON of every record
//            with ids and ordering intact. The JSON is what a restore
//            reads; the .md files are what a human reads.
//
//   COMPILE  The manuscript as one continuous document, title page and
//            all. What you hand to a reader.
//
// A backup only a human can read isn't a backup, and a manuscript with
// folder structure in it isn't a manuscript. Hence both.

function slug(s, fallback = 'untitled') {
  const out = (s || '').trim().toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || fallback;
}

function pad(n) { return String(n).padStart(2, '0'); }

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function downloadBlob(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke on a delay: revoking synchronously can cancel the download in
  // some browsers before they have finished reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function manuscriptTitle() {
  const books = App.tree?.books || [];
  return books.length === 1 ? books[0].title : 'Manuscript';
}

/**
 * titlePage() — a standard manuscript front page.
 *
 * Contact block first, then title and byline with an approximate word
 * count. Roughly Shunn format, which is what agents and editors expect
 * and nobody is ever annoyed to receive.
 */
function titlePage(title, words) {
  const a = App.data.author || {};
  const legal  = [a.first, a.middle, a.last].filter(Boolean).join(' ');
  const byline = authorByline();

  const contact = [
    legal,
    ...(a.address || '').split('\n').map(l => l.trim()).filter(Boolean),
    a.phone,
    a.email,
  ].filter(Boolean);

  if (a.agent) {
    contact.push('', `Represented by ${a.agent}`);
    if (a.agentContact) contact.push(a.agentContact);
  }

  const out = [];
  if (contact.length) out.push(contact.join('  \n'), '');
  out.push('', '', `# ${title}`);
  if (byline) out.push('', `by ${byline}`);
  // Manuscript word counts are conventionally rounded, not exact.
  out.push('', `*about ${(Math.round(words / 100) * 100).toLocaleString()} words*`);
  if (a.copyright) out.push('', a.copyright);
  out.push('', '---', '');
  return out.join('\n');
}

// compileText() — the whole manuscript as one markdown document.
async function compileText() {
  const scenes = scenesInScope({ kind: 'all', id: null });
  const words  = scenes.reduce((n, s) => n + (s.wordCount || 0), 0);
  const parts  = [titlePage(manuscriptTitle(), words)];

  let lastChapter;
  let first = true;
  for (const meta of scenes) {
    const rec = await RecordStore.get('scene', meta.id);
    if (!rec) continue;

    if (meta.chapterId !== lastChapter) {
      lastChapter = meta.chapterId;
      if (meta.chapterTitle) parts.push(`\n## ${meta.chapterTitle}\n`);
    } else if (!first) {
      // Scene break inside a chapter. A centred hash is the conventional
      // typescript mark for a break and survives any converter.
      parts.push('\n#\n');
    }
    first = false;
    parts.push((rec.body || '').trim());
  }
  return parts.join('\n') + '\n';
}

async function exportManuscript() {
  await flushActiveScene();
  const text = await compileText();
  downloadBlob(text, `${slug(manuscriptTitle(), 'manuscript')}-${stamp()}.md`,
               'text/markdown;charset=utf-8');
  showToast('Manuscript compiled.');
}

/**
 * exportBackup() — everything, as a zip.
 *
 *   manuscript/01-part-one/02-chapter-two/03-the-ascent.md
 *   manuscript/unplaced/01-a-fragment.md
 *   compiled.md
 *   recension-backup.json      ← the restorable copy
 *
 * Numeric prefixes preserve reading order in a file listing, which
 * alphabetical names would scramble.
 */
async function exportBackup() {
  await flushActiveScene();

  const files = {};
  const enc = fflate.strToU8;

  const [books, chapters, scenes, cards, events] = await Promise.all([
    RecordStore.getAll('book'), RecordStore.getAll('chapter'),
    RecordStore.getAll('scene'), RecordStore.getAll('card'),
    RecordStore.getAll('event'),
  ]);

  const addScene = (path, i, rec) => {
    const head = [`# ${rec.title || 'Untitled scene'}`];
    if (rec.synopsis) head.push('', `> ${rec.synopsis}`);
    if (rec.pov)      head.push('', `POV: ${rec.pov}`);
    head.push('', (rec.body || '').trim(), '');
    files[`${path}/${pad(i + 1)}-${slug(rec.title, 'scene')}.md`] = enc(head.join('\n'));
  };

  const tree = App.tree;
  tree.books.forEach((b, bi) => {
    const bp = `manuscript/${pad(bi + 1)}-${slug(b.title, 'part')}`;
    b.chapters.forEach((c, ci) => {
      const cp = `${bp}/${pad(ci + 1)}-${slug(c.title, 'chapter')}`;
      c.scenes.forEach((s, si) => { if (scenes[s.id]) addScene(cp, si, scenes[s.id]); });
    });
  });
  tree.looseChapters.forEach((c, ci) => {
    const cp = `manuscript/${pad(ci + 1)}-${slug(c.title, 'chapter')}`;
    c.scenes.forEach((s, si) => { if (scenes[s.id]) addScene(cp, si, scenes[s.id]); });
  });
  tree.unfiled.forEach((s, si) => {
    if (scenes[s.id]) addScene('manuscript/unplaced', si, scenes[s.id]);
  });

  files['compiled.md'] = enc(await compileText());

  // The restorable copy: full records with ids, timestamps and ordering —
  // everything the .md files drop on the way out.
  files['recension-backup.json'] = enc(JSON.stringify({
    format: 'recension-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    author: App.data.author,
    records: { books, chapters, scenes, cards, events },
  }, null, 2));

  const zipped = fflate.zipSync(files, { level: 6 });
  downloadBlob(zipped, `recension-backup-${stamp()}.zip`, 'application/zip');
  showToast('Backup downloaded.');
}

// ── Responsive mode ────────────────────────────────────────────────

function applyMode() {
  const narrow = window.matchMedia(NARROW_QUERY).matches;
  if (narrow === App.readOnly) return;
  App.readOnly = narrow;
  if (narrow) { $('rail').hidden = false; closeRail(); }
  else        { closeRail(); $('rail').hidden = false; }
  if (App.activeScene) openScene(App.activeScene.id);
}

// ── Boot ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  loadLocal();
  App.readOnly = window.matchMedia(NARROW_QUERY).matches;

  // The Google client id lives on the worker, not in frontend source, so it
  // has to be fetched BEFORE Auth.init — init consumes it, and a later call
  // would replace the whole config rather than patch it. An offline start is
  // fine: googleClientId stays empty, which disables only the Google button.
  let googleClientId = '';
  if (App.data.workerUrl) {
    try {
      const res = await fetch(`${App.data.workerUrl}/auth/config`);
      if (res.ok) googleClientId = (await res.json()).googleClientId || '';
    } catch { /* sync just waits */ }
  }

  // ── Auth ────────────────────────────────────────────────────────
  Auth.init({
    googleClientId,
    storageKey:        STORAGE_KEY,
    storageAuthKey:    AUTH_KEY,
    storageDismissKey: DISMISS_KEY,
    workerBase: () => App.data.workerUrl || '',
    getData:    () => App.data,
    setData:    (d) => { App.data = d; saveLocal(); },
    mergeData,
    onSignedIn: async (data, isNew) => {
      App.data = mergeData(data);
      saveLocal();
      // A brand-new account has nothing upstream; an existing one may be a
      // device that has never seen this manuscript.
      if (!isNew) await Sync.freshDeviceSync();
      await renderTree();
      renderTabs();
      showToast(`Welcome to Recension`);
    },
    onGuestReady: async () => { await renderTree(); renderTabs(); },
    onSessionExpired: () => setSyncState('error', 'Sign-in expired'),
    // Called by auth.js at account creation to prove the worker is
    // reachable AND to lay down the account record. flush() alone was not
    // enough: it only pushes what's in the dirty set, and creating an
    // account doesn't mark anything dirty — so it reported success having
    // written nothing, and the account was then unfindable from any other
    // device. Write the account record explicitly, then flush the content.
    pushToWorker: async () => {
      const wrote = await Sync.pushAccount();
      if (!wrote) return false;
      const r = await Sync.flush();
      return r.ok !== false;
    },
    startSyncPing: () => Sync.start(),
    openModal, closeModal,
    toast: showToast,
    appName:  'Recension',
    appEmoji: '📖',
  });

  // ── Sync ────────────────────────────────────────────────────────
  Sync.init({
    ...RecordStore.syncInterface(),
    workerBase: () => App.data.workerUrl || '',
    getToken:   () => App.data.userToken,
    isGuest:    () => Auth.isGuest(),
    getAccount: accountForSync,
    setAccount: (raw) => {
      // Only the allowlisted keys come back. Local-only fields — token,
      // worker URL — must survive a pull untouched.
      App.data = mergeData({ ...App.data, ...raw, userToken: App.data.userToken,
                             workerUrl: App.data.workerUrl });
      saveLocal();
    },
    onStatus: (state, detail) => setSyncState(state, detail),
    onProgress: ({ done, total, phase }) => {
      if (phase === 'records' && total) setSyncState('syncing', `Fetching ${done}/${total}`);
    },
    onOutlineReady: () => renderTree(),
    onAuthFailure: async () => {
      if (typeof Auth.handleAuthFailure === 'function') return await Auth.handleAuthFailure();
      return false;
    },
    toast: showToast,
  });

  // ── Events ──────────────────────────────────────────────────────
  loadTypography();
  syncTypePopover();
  bindAuthorFields();
  bindSettingsTabs();
  applyTypewriterMode(App.data.typewriter);

  $('btn-contents').addEventListener('click', toggleRail);
  $('btn-read').addEventListener('click', toggleRead);

  $('btn-type').addEventListener('click', e => {
    e.stopPropagation();
    const pop = $('type-popover');
    const show = pop.hidden;
    pop.hidden = !show;
    $('btn-type').setAttribute('aria-expanded', String(show));
    if (show) {
      const r = $('btn-type').getBoundingClientRect();
      pop.style.top  = `${r.bottom + 6}px`;
      pop.style.left = `${Math.min(r.left - 80, window.innerWidth - pop.offsetWidth - 10)}px`;
    }
  });
  $('type-popover').addEventListener('click', e => {
    e.stopPropagation();
    const m = e.target.closest('[data-measure]');
    const z = e.target.closest('[data-size]');
    if (m) setTypography({ measure: m.dataset.measure });
    if (z) setTypography({ size: z.dataset.size });
  });
  $('pop-titles').addEventListener('change', e =>
    setTypography({ readTitles: e.target.checked }));
  document.addEventListener('click', () => {
    $('type-popover').hidden = true;
    $('btn-type').setAttribute('aria-expanded', 'false');
  });

  // Scroll-spy, rAF-throttled so a fast scroll through 60 scenes doesn't
  // re-render the contents tree on every frame.
  $('sheet').addEventListener('scroll', () => {
    if (App.view !== 'read' || _spyRaf) return;
    _spyRaf = requestAnimationFrame(() => { _spyRaf = null; updateSpy(); });
  }, { passive: true });
  $('scrim').addEventListener('click', closeRail);
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => closeModal('modal-settings'));

  $('btn-new-part').addEventListener('click', newPart);
  $('btn-empty-new').addEventListener('click', async () => {
    const id = await RecordStore.createScene(null);
    if (id) { await renderTree(); openScene(id); }
  });

  for (const f of ['scene-title', 'scene-pov', 'scene-synopsis']) {
    $(f).addEventListener('input', scheduleSave);
  }
  $('scene-status').addEventListener('change', () => flushActiveScene());

  $('set-dark').addEventListener('change', e => {
    document.documentElement.classList.toggle('dark', e.target.checked);
    try { localStorage.setItem(DARK_KEY, JSON.stringify(e.target.checked)); } catch {}
  });
  $('set-typewriter').addEventListener('change', e => {
    App.data.typewriter = e.target.checked;
    saveAccount();
    applyTypewriterMode(e.target.checked);
    // Let the new padding land before measuring against it.
    if (e.target.checked) requestAnimationFrame(() => typewriterScroll(true));
  });
  $('btn-save-worker').addEventListener('click', saveWorkerUrl);
  // Enter in the field still works, for anyone who expects it to.
  $('set-worker').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveWorkerUrl(); }
  });
  $('btn-sync-now').addEventListener('click', async () => {
    // Report the actual blocker. "Sync incomplete" for a guest account is
    // true but useless — there's nothing to sync TO yet.
    if (!App.data.workerUrl) { showToast('Add your worker address first.'); return; }
    if (Auth.isGuest())      { showToast('Create an account below to sync.'); return; }

    await flushActiveScene();
    const pushed = await Sync.flush();
    const pulled = await Sync.pull();
    await renderTree();
    renderTabs();
    if (pushed.ok && pulled.ok) showToast('Synced.');
    else showToast('Sync incomplete — it will retry on its own.');
    Sync.lastSyncTime().then(t => {
      $('sync-note').textContent = t ? `Last synced ${new Date(t).toLocaleString()}.` : 'Not synced yet.';
    });
  });

  // Account controls. auth.js owns the wizards; these just open them.
  $('btn-create-account').addEventListener('click', () => {
    if (!App.data.workerUrl) {
      showToast('Add and save your worker address first.');
      return;
    }
    closeModal('modal-settings');
    Auth.showSetupFresh();
  });
  $('btn-load-token').addEventListener('click', () => {
    if (!App.data.workerUrl) {
      showToast('Add and save your worker address first.');
      return;
    }
    closeModal('modal-settings');
    Auth.showSetupLoadToken();
  });
  $('btn-copy-token').addEventListener('click', () => {
    navigator.clipboard.writeText(App.data.userToken || '')
      .then(() => showToast('Token copied.'))
      .catch(() => showToast('Select the token and copy it manually.'));
  });
  $('settings-upgrade-google').addEventListener('click', () => {
    closeModal('modal-settings');
    Auth.showGoogleUpgradeFlow();
  });
  $('btn-switch-account').addEventListener('click', () => {
    closeModal('modal-settings');
    Auth.showGuestSwitchConfirm();
  });

  $('btn-export-manuscript').addEventListener('click', () => exportManuscript()
    .catch(e => { console.error(e); showToast('Compile failed - see the console.'); }));
  $('btn-export-backup').addEventListener('click', () => exportBackup()
    .catch(e => { console.error(e); showToast('Backup failed - see the console.'); }));

  $('confirm-cancel-btn').addEventListener('click', () => closeModal('modal-confirm'));
  $('confirm-ok-btn').addEventListener('click', () => {
    closeModal('modal-confirm');
    const fn = _confirmHandler; _confirmHandler = null;
    if (fn) fn();
  });

  // E edits the scene currently centred in the read view. Once you know the
  // view, reaching for the margin marker is slower than the thought that
  // prompted it — the marker stays as the discoverable route.
  document.addEventListener('keydown', e => {
    if (App.view !== 'read' || App.readOnly) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (e.key === 'e' || e.key === 'E') {
      const id = centredScene();
      if (id) { e.preventDefault(); editFromRead(id); }
    }
  });

  // Esc closes the topmost open modal.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    for (const id of ['modal-confirm', 'modal-settings', 'modal-account-setup']) {
      if (!$(id).hidden) { closeModal(id); return; }
    }
    if (!$('type-popover').hidden) { $('type-popover').hidden = true; return; }
    // Nothing else open and we arrived here from reading — go back.
    if (App.view === 'edit' && App.readReturn) backToRead();
  });

  // Ctrl/Cmd-S flushes to disk and pushes. Writers press it reflexively;
  // it should do something honest rather than open the browser's dialog.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      flushActiveScene().then(() => Sync.flush());
      showToast('Saved.');
    }
  });

  window.matchMedia(NARROW_QUERY).addEventListener('change', applyMode);
  window.addEventListener('beforeunload', () => { flushActiveScene(); });

  // ── Start ───────────────────────────────────────────────────────

  await renderTree();
  renderTabs();

  if (!Auth.isGuest() && App.data.workerUrl) {
    Sync.start();
    Sync.pull().then(() => { renderTree(); renderTabs(); });
  }

  if (typeof Auth.bootCheck === 'function') await Auth.bootCheck();

  const active = App.data.tabState.activeId;
  if (active && await RecordStore.get('scene', active)) openScene(active);
  else showEmpty();

  refreshSyncState();
});
