/**
 * ============================================================
 * app.js — Recension
 * ============================================================
 *
 * Boot, the contents tree, the editor, and the wiring between
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
  section: 'manuscript',   // which rail is showing: manuscript | cards
  tlZoom: 1,
  activeCard: null,
  activeEvent: null,
  lastCardType: 'character',
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
    // Which project to open at launch, and where you were inside each
    // one. Position is per project on purpose: reopening Angel Six-Two
    // should land where you were in Angel Six-Two, not wherever you
    // last looked in something else.
    lastProjectId: null,
    places: {},           // projectId → { openSceneId, section, collapsedIds }

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
    lastProjectId: raw?.lastProjectId ?? null,
    // Carry pre-project state forward: the old account-level scene and
    // collapse state become the first project's place, assigned once
    // the migration tells us which project that is.
    places: (raw?.places && typeof raw.places === 'object') ? raw.places : {},
    _legacyPlace: {
      openSceneId: raw?.openSceneId ?? raw?.tabState?.activeId ?? null,
      collapsedIds: Array.isArray(raw?.tocState?.collapsedIds) ? raw.tocState.collapsedIds : [],
    },

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
    lastProjectId: d.lastProjectId,
    places: d.places,

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

const TYPE_DEFAULTS = {
  measure: 'book', size: 'md', readTitles: true,
  // Per device, like the rest of this object — the spelling dictionary
  // lives in the browser, and autocorrect is a keyboard behaviour.
  spellcheck: true, autocorrect: true,
};

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
  t.replaceChildren();          // clear an Undo button from a previous toast
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

// Wikilinks are rendered as real links before anything else touches the
// text, so [[Name]] never leaks through as literal brackets.
function renderWikilinks(html, index) {
  return html.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, (_m, target, label) => {
    const t = target.trim();
    const known = index?.has(t.toLowerCase());
    const text = (label || t).trim();
    return `<a class="wl${known ? '' : ' unknown'}" data-link="${escapeHtml(t)}" href="#">${escapeHtml(text)}</a>`;
  });
}

function renderMarkdown(md, index) {
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
    return renderWikilinks(t, index)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|\W)_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/\n/g, '<br />');
  }
}

// ══ Projects ═══════════════════════════════════════════════════════
//
// A project is the working set: its books, its cast, its history.
// Cards and events belong to it rather than to a book, so a shared
// universe — two novels, one set of characters — works without
// duplicating anyone.
//
// Switching flushes to DISK and fires a sync without waiting on it.
// Blocking on the network would be the only place in the app that
// does, it would make switching impossible offline, and it would imply
// a guarantee we can't make. Sync is per record anyway: a dirty scene
// from a closed project is still in the dirty set and still goes up.

function place() {
  const id = RecordStore.currentProject();
  if (!id) return {};
  App.data.places[id] ||= { openSceneId: null, section: 'manuscript', collapsedIds: [] };
  return App.data.places[id];
}

function savePlace(patch) {
  const id = RecordStore.currentProject();
  if (!id) return;
  App.data.places[id] = { ...place(), ...patch };
  saveLocal();
}

async function renderProjectName() {
  const list = await RecordStore.listProjects();
  const cur = list.find(p => p.id === RecordStore.currentProject());
  $('project-name').textContent = cur?.title || 'Recension';
  $('btn-project').setAttribute('aria-label', `Project: ${cur?.title || 'none'}`);
}

async function openProjectMenu(anchor) {
  closeRowMenu();
  const menu = el('div', 'row-menu project-menu');
  const list = await RecordStore.listProjects();
  const cur = RecordStore.currentProject();

  for (const p of list) {
    const b = el('button', p.id === cur ? 'on' : null, p.title);
    b.addEventListener('click', e => {
      e.stopPropagation();
      closeRowMenu();
      if (p.id !== cur) switchProject(p.id);
    });
    menu.append(b);
  }

  menu.append(el('div', 'menu-rule'));

  const add = el('button', null, 'New project…');
  add.addEventListener('click', async e => {
    e.stopPropagation();
    closeRowMenu();
    const name = await askName('New project', 'Title');
    if (!name) return;
    const id = await RecordStore.createProject(name);
    if (id) switchProject(id);
  });
  menu.append(add);

  if (list.length > 1) {
    const merge = el('button', null, 'Merge projects…');
    merge.addEventListener('click', async e => {
      e.stopPropagation();
      closeRowMenu();
      const from = await askChoice('Merge which project into this one?',
        list.filter(p => p.id !== cur).map(p => ({ label: p.title, value: p.id })));
      if (!from) return;
      const target = list.find(p => p.id === cur);
      const source = list.find(p => p.id === from);
      showConfirm(
        `Move everything from “${source.title}” into “${target.title}”? ` +
        `Nothing is deleted — its books, cards and events all move across.`,
        async () => {
          // mergeProjects keeps the OLDEST, so force the survivor to be
          // the one you're standing in by making it look older.
          const keep = { ...target, createdAt: Math.min(target.createdAt || 0, (source.createdAt || 0) - 1) };
          await RecordStore.put('project', target.id, keep);
          await RecordStore.mergeProjects([keep, source]);
          RecordStore.setCurrentProject(target.id);
          invalidateCardIndex();
          await renderProjectName();
          await railSection(App.section || 'manuscript');
          showToast('Projects merged.');
        }, 'Merge');
    });
    menu.append(merge);

    const del = el('button', 'danger', 'Delete this project…');
    del.addEventListener('click', e => {
      e.stopPropagation();
      closeRowMenu();
      const name = list.find(p => p.id === cur)?.title || 'this project';
      showConfirm(
        `Delete "${name}"? Its books and cards stay — they become unassigned, ` +
        `and you can move them into another project.`,
        async () => {
          await RecordStore.deleteProject(cur);
          delete App.data.places[cur];
          const rest = await RecordStore.listProjects();
          switchProject(rest[0]?.id || await RecordStore.createProject('My writing'));
        });
    });
    menu.append(del);
  }

  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, r.left)}px`;
  _menu = menu;
}

async function switchProject(id) {
  // Disk first. The debounce may not have fired and the editor holds
  // text that isn't in IndexedDB yet.
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  // Network afterwards, unawaited. Nothing is lost if it fails — the
  // dirty set outlives the switch.
  Sync.flush();

  RecordStore.setCurrentProject(id);
  App.data.lastProjectId = id;
  saveLocal();

  App.activeScene = App.activeCard = App.activeEvent = null;
  App.view = 'edit';
  App.readReturn = null;
  invalidateCardIndex();
  for (const h of ['scene', 'card-edit', 'event-edit', 'readview',
                   'timeline-wrap', 'grid-wrap', 'board-wrap', 'map-wrap']) $(h).hidden = true;

  await renderProjectName();
  await railSection(place().section || 'manuscript');

  const scene = place().openSceneId;
  if (scene && await RecordStore.get('scene', scene)) await openScene(scene);
  else showEmpty();
  refreshSyncState();
}

// ══ Structural undo ════════════════════════════════════════════════
//
// Drag is the expected gesture for reordering a document tree —
// Scrivener, Ulysses, Obsidian and the rest all have it. What makes it
// safe THERE is undo: a misdrop is one keystroke from repaired.
//
// So this exists before drag does. It covers structural moves only;
// text undo is CodeMirror's job and already works per scene. Moving
// chapter 19 to position 3 in a 90,000-word draft is the kind of
// accident you might not notice for a week, and the remedy other
// tools use is not "don't allow it".

const UNDO_LIMIT = 30;
const undoStack = [];

function pushUndo(label, apply) {
  undoStack.push({ label, apply });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

async function undoLast() {
  const step = undoStack.pop();
  if (!step) { showToast('Nothing to undo.'); return; }
  await step.apply();
  await refreshAfterMove();
  showToast(`Undone: ${step.label}`);
}

async function refreshAfterMove() {
  await renderTree();
  if (App.section === 'plan') renderPlan();
  if (App.view === 'plan') renderSnowflake();
  if (App.view === 'board') renderBoard();
  refreshSyncState();
}

/**
 * moveWithUndo(type, id, to, label) — the only path a structural move
 * takes. Recording the undo at the same moment as the move is what
 * stops the two drifting apart.
 */
async function moveWithUndo(type, id, to, label) {
  const before = await RecordStore.moveRecord(type, id, to);
  if (!before) return;
  pushUndo(label, () => RecordStore.moveRecord(type, id, before));
  await refreshAfterMove();

  // Offered rather than announced. A move you meant needs no comment;
  // a move you didn't needs a way back that doesn't require knowing a
  // keyboard shortcut.
  showUndoToast(label);
}

let _undoToastTimer = null;
function showUndoToast(label) {
  const t = $('toast');
  t.replaceChildren();
  t.append(el('span', null, label));
  const b = el('button', 'toast-action', 'Undo');
  b.addEventListener('click', () => { t.hidden = true; undoLast(); });
  t.append(b);
  t.hidden = false;
  clearTimeout(_undoToastTimer);
  _undoToastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

// ══ Dragging in the rail ═══════════════════════════════════════════
//
// A scene can be dropped between any two scenes, in any chapter; a
// chapter between chapters, in any part or book. The drop target is
// an INSERTION POINT, not a container — "into chapter 3" leaves the
// position ambiguous and would land everything at the end.

const drag = { type: null, id: null };

function makeDraggable(node, type, id) {
  node.draggable = true;
  node.addEventListener('dragstart', e => {
    drag.type = type; drag.id = id;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set or the drag never starts.
    e.dataTransfer.setData('text/plain', id);
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    drag.type = drag.id = null;
    for (const el of document.querySelectorAll('.drop-into, .drop-before'))
      el.classList.remove('drop-into', 'drop-before');
  });
}

/**
 * dropZone(node, accept, describe, onDrop)
 *
 * `describe` returns where this would land, shown as a line above the
 * row rather than a highlight around it — a highlight says "into this
 * thing", which is the ambiguity we're avoiding.
 */
function dropZone(node, accept, onDrop) {
  node.addEventListener('dragover', e => {
    if (drag.type !== accept || !drag.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-before');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-before'));
  node.addEventListener('drop', async e => {
    node.classList.remove('drop-before');
    if (drag.type !== accept || !drag.id) return;
    e.preventDefault();
    e.stopPropagation();
    const id = drag.id;
    drag.type = drag.id = null;
    await onDrop(id);
  });
}

// ── Contents tree ──────────────────────────────────────────────────

function isCollapsed(id) { return (place().collapsedIds || []).includes(id); }

function setCollapsed(id, collapsed) {
  const set = new Set(place().collapsedIds || []);
  collapsed ? set.add(id) : set.delete(id);
  savePlace({ collapsedIds: [...set] });
  if (typeof Sync !== 'undefined') Sync.markAccountDirty();
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

const KIND_LABEL = { book: 'book', part: 'part', chapter: 'chapter', scene: 'scene' };

function openRowMenu(anchor, kind, id, title) {
  closeRowMenu();
  const menu = el('div', 'row-menu');

  // Containers can be read straight through. Scenes and cards can't —
  // a scene is already what the editor shows.
  if (kind === 'book' || kind === 'part' || kind === 'chapter') {
    const read = el('button', null, 'Read through');
    read.addEventListener('click', e => {
      e.stopPropagation();
      closeRowMenu();
      openRead({ kind, id });
    });
    menu.append(read);
  }

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

// askChoice(heading, options) — pick one of several. Same shape as
// askName; used when an action is ambiguous across multiple books.
function askChoice(heading, options) {
  return new Promise(resolve => {
    const overlay = el('div', 'modal-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const modal = el('div', 'modal modal-sm');
    const head  = el('div', 'modal-header');
    head.append(el('h2', 'modal-title', heading));
    const body  = el('div', 'modal-body');
    const list  = el('div', 'choice-list');

    let settled = false;
    const done = v => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); done(null); } }
    document.addEventListener('keydown', onKey, true);

    for (const o of options) {
      const b = el('button', 'choice', o.label);
      b.addEventListener('click', () => done(o.value));
      list.append(b);
    }

    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'ghost-btn', 'Cancel');
    cancel.addEventListener('click', () => done(null));
    actions.append(cancel);

    overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(null); });
    body.append(list, actions);
    modal.append(head, body);
    overlay.append(modal);
    document.body.append(overlay);
    list.firstChild?.focus();
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
      // Cards carry a name, everything else a title.
      if (rec) await RecordStore.put(kind, id, kind === 'card'
        ? { ...rec, name: next } : { ...rec, title: next });
      if (App.section === 'events') await renderEvents();
      await renderTree();
      if (App.section === 'cards') await renderCards();
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
    book:    `Delete "${name}"? Its parts and chapters stay, detached.`,
    part:    `Delete "${name}"? Its chapters stay, moved up under the book.`,
    chapter: `Delete "${name}"? Its scenes stay, moved to Unplaced.`,
    scene:   `Delete "${name}"? The text in it is lost.`,
    card:    `Delete "${name}"? The manuscript is untouched.`,
    event:   `Delete "${name}"? The manuscript is untouched.`,
  }[kind];

  showConfirm(message, async () => {
    if (kind === 'event') {
      await RecordStore.remove('event', id);
      if (App.activeEvent?.id === id) {
        App.activeEvent = null;
        $('event-edit').hidden = true;
        showEmpty();
      }
      await renderEvents();
      refreshSyncState();
      return;
    }
    if (kind === 'card') {
      await RecordStore.remove('card', id);
      if (App.activeCard?.id === id) {
        App.activeCard = null;
        $('card-edit').hidden = true;
        showEmpty();
      }
      await renderCards();
      refreshSyncState();
      return;
    }
    if (kind === 'book')    await RecordStore.deleteBook(id);
    if (kind === 'part')    await RecordStore.deletePart(id);
    if (kind === 'chapter') await RecordStore.deleteChapter(id);
    if (kind === 'scene') {
      await RecordStore.deleteScene(id);
      if (place().openSceneId === id) {
        App.activeScene = null;
        savePlace({ openSceneId: null });
      }
      saveAccount();
    }
    await renderTree();
    place().openSceneId ? openScene(place().openSceneId) : showEmpty();
    refreshSyncState();
  });
}

// ── Tree ───────────────────────────────────────────────────────────

// ── Creating structure ─────────────────────────────────────────────
// Each level asks for its name up front: a structural tier only exists
// because you had a name in mind for it. Scenes are the exception —
// those are made mid-flow, often before you know what the scene is.

async function newWork() {
  const name = await askName('New book', 'Title');
  if (!name) return;
  // First real content of a session — a genuine user gesture, and the
  // moment the data becomes worth protecting.
  maybeRequestPersistence();
  await RecordStore.createBook(name);
  renderTree();
}

async function newPart(bookId) {
  const name = await askName('New part', 'Part One');
  if (!name) return;
  await RecordStore.createPart(bookId, name);
  renderTree();
}

// partId null puts the chapter directly under the book, which is where
// most chapters live — parts are optional.
async function newChapter(bookId, partId = null) {
  const name = await askName('New chapter', 'Chapter One');
  if (!name) return;
  await RecordStore.createChapter(bookId, name, partId);
  renderTree();
}

async function renderTree() {
  App.tree = await RecordStore.getTree();
  const toc = $('toc');
  toc.replaceChildren();

  for (const work of App.tree.works) {
    const collapsed = isCollapsed(work.id);
    const row = tocLine('div', {
      className: 'toc-work',
      kind: 'book', id: work.id,
      title: work.title,
      figure: fmtWords(work.words),
      // Clicking the row expands it. Reading a whole book is rare and
      // lives in the row menu; hiding the entire tree behind a 10px
      // caret while the obvious click did something else was a trap.
      onOpen: () => { setCollapsed(work.id, !collapsed); renderTree(); },
    });
    row.prepend(caretFor(work.id, collapsed, renderTree));
    toc.append(row);
    if (collapsed) continue;

    for (const part of work.parts) {
      const pCollapsed = isCollapsed(part.id);
      const pRow = tocLine('div', {
        className: 'toc-part',
        kind: 'part', id: part.id,
        title: part.title,
        figure: fmtWords(part.words),
        onOpen: () => { setCollapsed(part.id, !pCollapsed); renderTree(); },
      });
      pRow.prepend(caretFor(part.id, pCollapsed, renderTree));
      dropZone(pRow, 'chapter', async id =>
        moveWithUndo('chapter', id, { parentId: part.id, bookId: work.id, index: 999 },
                     `Moved into “${part.title}”`));
      toc.append(pRow);
      if (pCollapsed) continue;

      for (const ch of part.chapters) toc.append(...chapterRows(ch, 'toc-chapter in-part'));
      const addInPart = addLink('+ chapter', 'toc-add-chapter in-part',
        () => newChapter(work.id, part.id));
      dropZone(addInPart, 'chapter', async id =>
        moveWithUndo('chapter', id, { parentId: part.id, bookId: work.id, index: 999 },
                     `Moved to the end of “${part.title}”`));
      toc.append(addInPart);
    }

    // Chapters sitting directly under the work. Parts are optional, and a
    // book with none — which is most books — looks exactly like this.
    for (const ch of work.looseChapters) toc.append(...chapterRows(ch, 'toc-chapter'));

    const addLoose = addLink('+ chapter', 'toc-add-chapter', () => newChapter(work.id, null));
    dropZone(addLoose, 'chapter', async id =>
      moveWithUndo('chapter', id, { parentId: null, bookId: work.id, index: 999 },
                   `Moved into “${work.title}”`));
    toc.append(addLoose);
    toc.append(addLink('+ part', 'toc-add-part-inner', () => newPart(work.id)));
  }

  if (App.tree.orphanChapters?.length) {
    toc.append(el('div', 'toc-group-label', 'Detached'));
    for (const ch of App.tree.orphanChapters) toc.append(...chapterRows(ch, 'toc-chapter'));
  }

  // "+ book" is the only top-level creation now that works are the top
  // tier. It sits above Unplaced, which is a trailing catch-all.
  toc.append(addLink('+ book', 'toc-add-part', newWork));

  // Unplaced is a real destination, not only a source. Before drag it
  // was a hole: three ways in and none out.
  const unplacedHead = el('div', 'toc-group-label', 'Unplaced');
  dropZone(unplacedHead, 'scene', async id =>
    moveWithUndo('scene', id, { parentId: null, index: 0 }, 'Moved to Unplaced'));
  toc.append(unplacedHead);

  for (const sc of App.tree.unfiled) toc.append(sceneRow(sc));

  const addUnplaced = addLink('+ scene', '', async () => {
    const id = await RecordStore.createScene(null);
    if (id) { await renderTree(); openScene(id); }
  });
  dropZone(addUnplaced, 'scene', async id =>
    moveWithUndo('scene', id, { parentId: null, index: 999 }, 'Moved to Unplaced'));
  toc.append(addUnplaced);

  $('rail-total').textContent = `${App.tree.totalWords.toLocaleString()} words`;
}

function addLink(label, className, onClick) {
  const b = el('button', `toc-add ${className}`.trim(), label);
  b.addEventListener('click', onClick);
  return b;
}

// A collapse caret. Shared by works, parts, chapters and card groups so
// the gesture means the same thing everywhere in the rail.
function caretFor(id, collapsed, rerender) {
  const caret = el('span', 'caret', collapsed ? '\u25B8' : '\u25BE');
  caret.addEventListener('click', e => {
    e.stopPropagation();
    setCollapsed(id, !collapsed);
    rerender();
  });
  return caret;
}

// chapterRows(ch, className) — a chapter heading, its scenes, and the
// "+ scene" link, as a flat array. Flat rather than nested because the
// rail is a single scrolling column; nesting DOM here would buy nothing
// and complicate the indentation, which is carried by className.
// A chapter's position among its siblings — those in the same part,
// or those directly under the same book.
function chapterIndex(ch) {
  const t = App.tree;
  if (!t) return 0;
  for (const w of t.works) {
    if (ch.partId) {
      const p = w.parts.find(x => x.id === ch.partId);
      if (p) return Math.max(0, p.chapters.findIndex(c => c.id === ch.id));
    } else if (w.id === ch.bookId) {
      return Math.max(0, w.looseChapters.findIndex(c => c.id === ch.id));
    }
  }
  return 0;
}

function chapterRows(ch, className) {
  const rows = [];
  const chWords = ch.scenes.reduce((n, s) => n + (s.wordCount || 0), 0);
  const collapsed = isCollapsed(ch.id);
  const deep = className.includes('in-part');

  const row = tocLine('div', {
    className,
    kind: 'chapter', id: ch.id,
    title: ch.title,
    figure: fmtWords(chWords),
    onOpen: () => { setCollapsed(ch.id, !collapsed); renderTree(); },
  });
  row.prepend(caretFor(ch.id, collapsed, renderTree));
  makeDraggable(row, 'chapter', ch.id);
  dropZone(row, 'chapter', async id => {
    if (id === ch.id) return;
    await moveWithUndo('chapter', id,
      { parentId: ch.partId || null, bookId: ch.bookId, index: chapterIndex(ch) },
      `Moved before “${ch.title || 'chapter'}”`);
  });
  rows.push(row);
  if (collapsed) return rows;

  for (const sc of ch.scenes) rows.push(sceneRow(sc, deep));

  const add = addLink('+ scene', deep ? 'in-part' : '', async () => {
    const id = await RecordStore.createScene(ch.id);
    if (id) { await renderTree(); openScene(id); }
  });
  // The add link at the foot of a chapter is also the drop target for
  // "at the end of this chapter" — including an empty one, which
  // otherwise has no row to aim at.
  dropZone(add, 'scene', async id =>
    moveWithUndo('scene', id, { parentId: ch.id, index: 999 },
                 `Moved to the end of “${ch.title || 'chapter'}”`));
  rows.push(add);
  return rows;
}

function sceneRow(sc, deep = false) {
  const row = tocLine('button', {
    className: deep ? 'toc-scene in-part' : 'toc-scene',
    kind: 'scene', id: sc.id,
    title: sc.title,
    figure: fmtWords(sc.wordCount),
    status: sc.status && sc.status !== 'draft' ? sc.status : null,
    current: place().openSceneId === sc.id,
    onOpen: () => { openScene(sc.id); if (App.readOnly) closeRail(); },
  });

  makeDraggable(row, 'scene', sc.id);
  // Dropping ON a scene means "before this one" — the line drawn above
  // the row says so. Landing "inside" a scene would mean nothing.
  dropZone(row, 'scene', async id => {
    if (id === sc.id) return;
    const at = await indexOfScene(sc.chapterId, sc.id);
    await moveWithUndo('scene', id, { parentId: sc.chapterId, index: at },
                       `Moved before “${sc.title || 'scene'}”`);
  });
  return row;
}

// Where a scene sits among its siblings, so a drop can be placed
// relative to it rather than appended.
async function indexOfScene(chapterId, sceneId) {
  const tree = App.tree || await RecordStore.getTree();
  const all = chapterId
    ? (RecordStore.allChapters(tree).find(c => c.id === chapterId)?.scenes || [])
    : (tree.unfiled || []);
  const i = all.findIndex(s => s.id === sceneId);
  return i === -1 ? all.length : i;
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

// The read view and every export share one idea of scope: a work, a
// part, a chapter, or everything. "Everything" is only meaningful when
// there's more than one book — with a single work its title is the
// honest heading, not "Whole manuscript".
function scopeLabel(scope) {
  const t = App.tree;
  if (scope.kind === 'book')
    return t.works.find(w => w.id === scope.id)?.title || 'Book';
  if (scope.kind === 'part') {
    for (const w of t.works) {
      const p = w.parts.find(x => x.id === scope.id);
      if (p) return `${w.title} — ${p.title}`;
    }
    return 'Part';
  }
  if (scope.kind === 'chapter')
    return RecordStore.allChapters(t).find(c => c.id === scope.id)?.title || 'Chapter';
  return t.works.length === 1 ? t.works[0].title : 'Everything';
}

// scenesInScope() — scenes in reading order, each tagged with the chapter
// it came from so the read view can break between chapters.
function scenesInScope(scope) {
  const t = App.tree;
  const out = [];
  const pushChapter = ch => ch.scenes.forEach((sc, i) =>
    out.push({ ...sc, chapterTitle: ch.title, chapterId: ch.id, firstInChapter: i === 0 }));
  const pushWork = w => {
    for (const p of w.parts) for (const ch of p.chapters) pushChapter(ch);
    for (const ch of w.looseChapters) pushChapter(ch);
  };

  if (scope.kind === 'chapter') {
    const ch = RecordStore.allChapters(t).find(c => c.id === scope.id);
    if (ch) pushChapter(ch);
    return out;
  }
  if (scope.kind === 'part') {
    for (const w of t.works) {
      const p = w.parts.find(x => x.id === scope.id);
      if (p) { for (const ch of p.chapters) pushChapter(ch); break; }
    }
    return out;
  }
  if (scope.kind === 'book') {
    const w = t.works.find(x => x.id === scope.id);
    if (w) pushWork(w);
    return out;
  }
  for (const w of t.works) pushWork(w);
  for (const ch of t.orphanChapters || []) pushChapter(ch);
  t.unfiled.forEach(sc => out.push({ ...sc, chapterTitle: null, firstInChapter: false }));
  return out;
}

async function openRead(scope = { kind: 'all', id: null }, focusSceneId = null) {
  if (App.activeScene) await flushActiveScene();
  App.view = 'read';
  App.readScope = scope;

  $('empty').hidden = true;
  $('scene').hidden = true;
  $('readview').hidden = false;
  $('timeline-wrap').hidden = true;
  $('grid-wrap').hidden = true;
  $('board-wrap').hidden = true;
  $('map-wrap').hidden = true;
  $('plan-wrap').hidden = true;
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
  const index  = await cardIndex();
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
    body.innerHTML = renderMarkdown(rec.body, index) ||
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
  if (!centred || centred === place().openSceneId) return;
  savePlace({ openSceneId: centred });              // position, not content — no need to sync it
  renderTree();
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
  await openRead(ret?.scope || defaultReadScope(), ret?.sceneId || null);
}

// With one book, "read everything" means that book — so it gets titled
// properly instead of "Everything".
function defaultReadScope() {
  const works = App.tree?.works || [];
  return works.length === 1
    ? { kind: 'book', id: works[0].id }
    : { kind: 'all', id: null };
}

function toggleRead() {
  if (App.view === 'read') {
    App.readReturn
      ? editFromRead(place().openSceneId)
      : exitRead();
  } else {
    openRead(defaultReadScope(), place().openSceneId);
  }
}

function exitRead() {
  App.view = 'edit';
  $('readview').hidden = true;
  $('btn-read').setAttribute('aria-pressed', 'false');
  place().openSceneId ? openScene(place().openSceneId) : showEmpty();
}

// ── Tabs ───────────────────────────────────────────────────────────




// ── Writing aids ───────────────────────────────────────────────────
//
// CodeMirror is a code editor, and it deliberately switches off
// everything a browser does to help with prose: it sets spellcheck,
// autocorrect and autocapitalize to "off" on its input. Sensible for
// code, wrong for a novel — on a phone it meant no capital letter
// after a full stop.
//
// Both are toggleable because both have a real cost here: spell check
// flags every name in the book until you teach the dictionary, and a
// phone's autocorrect will happily "fix" callsigns and surnames.

function applyWritingAids() {
  const cm = App.editor?.codemirror;
  if (!cm) return;
  const input = cm.getInputField();
  const t = App.typography || {};
  const spell = t.spellcheck !== false;
  const assist = t.autocorrect !== false;

  input.setAttribute('spellcheck', String(spell));
  // "sentences" rather than "on": capitalise after a full stop, not
  // every word.
  input.setAttribute('autocapitalize', assist ? 'sentences' : 'off');
  input.setAttribute('autocorrect', assist ? 'on' : 'off');
  // The attribute alone doesn't make an existing surface re-check.
  cm.refresh();
}

// ── Editor ─────────────────────────────────────────────────────────

function ensureEditor() {
  if (App.editor || App.readOnly) return App.editor;
  App.editor = new EasyMDE({
    element: $('editor'),
    toolbar: false,
    status: false,
    // EasyMDE's own checker downloads a dictionary from a CDN, which
    // breaks offline. The browser's is better and already knows the
    // words you've taught it.
    spellChecker: false,
    nativeSpellcheck: true,
    // The browser can only draw spelling squiggles on a contenteditable
    // surface. CodeMirror's default input is an invisible textarea, so
    // native spell check "worked" but had nowhere to show anything.
    inputStyle: 'contenteditable',
    autofocus: false,
    placeholder: 'Begin.',
    lineWrapping: true,
    autoDownloadFontAwesome: false,
  });
  const cm = App.editor.codemirror;
  // Older EasyMDE builds don't pass inputStyle through; set it directly.
  if (cm.getOption('inputStyle') !== 'contenteditable') {
    cm.setOption('inputStyle', 'contenteditable');
  }
  applyWritingAids();

  let _overlayTimer = null;
  cm.on('change', () => {
    scheduleSave();
    updateTally();
    if (_acMode !== 'wrap') updateAutocomplete();
    // Re-tokenising on every keystroke is wasted work; a short settle is
    // enough for a link to colour itself as soon as you close it.
    clearTimeout(_overlayTimer);
    _overlayTimer = setTimeout(refreshWikilinkOverlay, 300);
    // Conceal sooner than the overlay: leaving raw [[...]] on screen for
    // a third of a second after every keystroke is very visible.
    concealWikilinks(cm);
  });

  // Keydown is captured before CodeMirror handles it, so arrow keys and
  // Enter drive the suggestion list instead of moving the caret while
  // the popup is open.
  cm.on('keydown', (_cm, e) => {
    if (autocompleteKey(_cm, e)) { e.preventDefault(); e.stopPropagation(); }
  });

  // Ctrl/Cmd-click follows a link. A plain click must stay plain — it's
  // how you place the caret, and stealing it would make prose containing
  // links harder to edit than prose without them.
  cm.getWrapperElement().addEventListener('mousedown', e => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY });
    const target = linkAt(cm, pos);
    if (!target) return;
    e.preventDefault();
    // Park the caret after the link rather than inside it. Leaving it
    // in the middle means the link is still "being edited" when you
    // come back, and shows its full syntax.
    const line = cm.getLine(pos.line) || '';
    for (const m of line.matchAll(/\[\[[^\[\]]+\]\]/g)) {
      if (pos.ch >= m.index && pos.ch <= m.index + m[0].length) {
        cm.setCursor({ line: pos.line, ch: m.index + m[0].length });
        break;
      }
    }
    followLink(target);
  });

  // Select words and press [ to link them. The picker opens and YOUR
  // WORDS STAY AS WRITTEN — "Angel's" keeps its apostrophe and still
  // points at Angel Six, via [[Angel Six|Angel's]]. Typing [[ at a
  // caret is the other gesture: insert a link here, using the card's
  // own name.
  cm.on('beforeChange', (_cm, change) => {
    if (change.origin !== '+input' || change.text.join('') !== '[') return;
    if (!_cm.somethingSelected()) return;
    const sel = _cm.getSelection();
    if (!sel.trim() || sel.includes('\n')) return;

    change.cancel();   // don't type the bracket; open the picker instead
    _acMode = 'wrap';
    _acWrap = { from: _cm.getCursor('from'), to: _cm.getCursor('to'), text: sel };
    updateAutocomplete(sel);
  });

  // The list is fixed-position and the caret is not, so a scrolling
  // sheet would otherwise leave it hovering over unrelated text.
  $('sheet').addEventListener('scroll', () => {
    if (_acBox) positionAutocomplete(cm);
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (_acBox) positionAutocomplete(cm);
  });

  // Hovering a link in the EDITOR. CodeMirror has no per-token hover
  // event, so this reads the character under the pointer and asks
  // whether it falls inside a link — the same check Ctrl-click uses.
  let _hoverRaf = null;
  cm.getWrapperElement().addEventListener('mousemove', e => {
    if (_hoverRaf) return;
    _hoverRaf = requestAnimationFrame(() => {
      _hoverRaf = null;
      const pos = cm.coordsChar({ left: e.clientX, top: e.clientY });
      const target = linkAt(cm, pos);
      target ? scheduleCardTip(target, e.clientX, e.clientY) : hideCardTip();
    });
  });
  cm.getWrapperElement().addEventListener('mouseleave', hideCardTip);
  cm.on('scroll', hideCardTip);

  cm.on('blur', () => {
    setTimeout(closeAutocomplete, 120);
    concealWikilinks(cm);      // nothing should stay expanded once you leave
  });
  cm.on('focus', () => concealWikilinks(cm));
  // cursorActivity covers typing, arrow keys, and clicks alike — all the
  // ways the caret can end up on a different line.
  cm.on('cursorActivity', () => {
    if (App.data.typewriter) typewriterScroll();
    concealWikilinks(cm);
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
  maybeRequestPersistence();

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
  refreshSyncState();
}

// ── Opening scenes ─────────────────────────────────────────────────

async function openScene(id) {
  if (App.activeScene && App.activeScene.id !== id) await flushActiveScene();

  const sc = await RecordStore.get('scene', id);
  if (!sc) { showToast('That scene is gone.'); await renderTree(); return; }

  App.activeScene = sc;
  savePlace({ openSceneId: id });
  saveAccount();

  App.view = 'edit';
  await flushActiveCard();
  await flushActiveEvent();
  App.activeCard = null;
  App.activeEvent = null;
  $('card-edit').hidden = true;
  $('event-edit').hidden = true;
  $('readview').hidden = true;
  $('timeline-wrap').hidden = true;
  $('grid-wrap').hidden = true;
  $('board-wrap').hidden = true;
  $('map-wrap').hidden = true;
  $('plan-wrap').hidden = true;
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
    $('reading').innerHTML = renderMarkdown(sc.body, await cardIndex()) ||
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
    refreshWikilinkOverlay();
    // Opening an existing scene with text in it: put the caret at the end
    // and pull it up to the hold line, so you resume writing from there
    // rather than from the top of the page.
    if (App.data.typewriter && (sc.body || '').length) {
      cm.setCursor(cm.lineCount(), 0);
      requestAnimationFrame(() => typewriterScroll(true));
    }
  }

  updateTally();
  renderSceneNav(id);
  await renderTree();
  $('sheet').scrollTop = 0;
}

function showEmpty() {
  App.activeScene = null;
  $('scene').hidden = true;
  $('empty').hidden = false;
  $('tally').textContent = '';
}

// ── Scene to scene ─────────────────────────────────────────────────
//
// Previous and next at the foot of a scene. On a phone the rail is a
// drawer, so moving from one chapter to the next was: open drawer,
// scroll, tap, drawer closes — four actions for the most ordinary
// movement there is. These make it one, and make the app read like an
// ebook rather than a filing cabinet.
//
// Reading order, not creation order: parts, then chapters, then
// scenes, with unplaced scenes last. Same order the read view and the
// compile use, so "next" always means the same thing.

function sceneOrder() {
  const t = App.tree;
  if (!t) return [];
  const out = [];
  for (const ch of RecordStore.allChapters(t)) {
    for (const sc of ch.scenes) out.push({ ...sc, chapter: ch.title });
  }
  for (const sc of t.unfiled) out.push({ ...sc, chapter: null });
  return out;
}

function renderSceneNav(sceneId) {
  const nav = $('scene-nav');
  nav.replaceChildren();

  const order = sceneOrder();
  const i = order.findIndex(s => s.id === sceneId);
  if (i === -1) return;

  const side = (sc, dir) => {
    if (!sc) {
      // An empty half rather than nothing, so the remaining button
      // stays on its own side instead of sliding across the page.
      nav.append(el('span', 'sn-gap'));
      return;
    }
    const b = el('button', `sn ${dir}`);
    b.append(el('span', 'sn-dir', dir === 'prev' ? '\u2190 Previous' : 'Next \u2192'));
    b.append(el('span', 'sn-title', sc.title || 'Untitled scene'));
    if (sc.chapter) b.append(el('span', 'sn-chapter', sc.chapter));
    b.addEventListener('click', () => openScene(sc.id));
    nav.append(b);
  };

  side(order[i - 1], 'prev');
  side(order[i + 1], 'next');
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
  $('set-spellcheck').checked = App.typography?.spellcheck !== false;
  $('set-autocorrect').checked = App.typography?.autocorrect !== false;
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
  renderStorageStatus();
  renderSyncStatus();
  showSettingsTab(_settingsTab);
  openModal('modal-settings');
}

// The Google client id lives on the worker and is fetched at boot. A
// browser that had no worker address at boot therefore has no id, and
// Google sign-in stays unavailable until a reload. Re-fetch when an
// address is saved so the option appears straight away.
async function refreshGoogleClientId() {
  if (!App.data.workerUrl) return;
  try {
    const res = await fetch(`${App.data.workerUrl}/auth/config`);
    if (!res.ok) return;
    const { googleClientId } = await res.json();
    if (googleClientId && typeof Auth.setGoogleClientId === 'function') {
      Auth.setGoogleClientId(googleClientId);
    }
  } catch { /* offline — the boot fetch will pick it up next time */ }
}

/**
 * renderSyncStatus() — what sync is actually doing, on screen.
 *
 * Twice now a sync problem has been invisible from inside the app and
 * only findable in a browser console — which is not available on a
 * phone at all. A person should be able to tell whether their writing
 * has left the device by looking.
 */
async function renderSyncStatus() {
  const box = $('sync-status');
  if (!box) return;
  box.replaceChildren();

  const line = (k, v, bad = false) => {
    const r = el('div', 'st-row');
    r.append(el('span', 'st-k', k));
    const val = el('span', 'st-v' + (bad ? ' bad' : ''), v);
    r.append(val);
    box.append(r);
  };

  const guest = Auth.isGuest();
  line('Account', guest ? 'Guest — nothing leaves this device'
                        : (App.data.authMethod === 'google' ? 'Google' : 'Token'),
       guest);

  if (guest) return;

  line('Worker', App.data.workerUrl || 'not set', !App.data.workerUrl);

  const last = await Sync.lastSyncTime();
  line('Last synced', last ? new Date(last).toLocaleString() : 'never', !last);

  const pending = await Sync.pendingCount();
  // Pending is the number that matters: it is how much of today's
  // writing exists only here.
  line('Waiting to upload', pending ? `${pending} change${pending === 1 ? '' : 's'}` : 'nothing',
       pending > 20);

  if (!App.data.workerUrl) return;

  line('Reachable', 'checking…');
  try {
    const res = await fetch(`${App.data.workerUrl}/ping`, { cache: 'no-store' });
    const ok = res.ok && (await res.json().catch(() => null))?.ok;
    box.lastChild.lastChild.textContent = ok ? 'yes' : `answered ${res.status}`;
    box.lastChild.lastChild.classList.toggle('bad', !ok);
  } catch {
    // The common cause on a managed machine: *.workers.dev blocked by
    // web filtering. Everything saves locally and nothing ever leaves.
    box.lastChild.lastChild.textContent = 'no — blocked, offline, or wrong address';
    box.lastChild.lastChild.classList.add('bad');
  }
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
      await refreshGoogleClientId();
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

// Reduce [[Target|words]] to "words", and [[Target]] to "Target".
function stripWikilinks(text) {
  return (text || '')
    .replace(/\[\[([^\[\]|]+)\|([^\[\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\[\]]+)\]\]/g, '$1');
}

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

function manuscriptTitle(scope) {
  return scope ? scopeLabel(scope) : (App.tree?.works?.[0]?.title || 'Manuscript');
}

// Which book to export. With one it's obvious; with several, ask rather
// than silently concatenating unrelated novels into one file.
async function chooseWork(verb) {
  const works = App.tree?.works || [];
  if (works.length <= 1) return works.length ? { kind: 'book', id: works[0].id }
                                             : { kind: 'all', id: null };
  const pick = await askChoice(`${verb} which book?`,
    works.map(w => ({ label: w.title, value: w.id })));
  return pick ? { kind: 'book', id: pick } : null;
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
async function compileText(scope = { kind: 'all', id: null }) {
  const scenes = scenesInScope(scope);
  const words  = scenes.reduce((n, s) => n + (s.wordCount || 0), 0);
  const parts  = [titlePage(manuscriptTitle(scope), words)];

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
    // Links are an authoring aid, not part of the manuscript. A reader
    // or an agent should get the prose, not [[Angel Six|Angel]].
    parts.push(stripWikilinks((rec.body || '').trim()));
  }
  return parts.join('\n') + '\n';
}

// ══ Manuscript formats ═════════════════════════════════════════════
//
// .docx and .epub are both ZIPs of XML, and fflate is already here for
// the backup — so neither needs a library. A docx generator is ~600KB
// of dependency to write a few kilobytes of markup we can write
// ourselves, and it would have to be vendored for offline use.
//
// The docx follows Shunn standard manuscript format: Times New Roman
// 12pt, double-spaced, one-inch margins, half-inch first-line indents,
// a running header of SURNAME / TITLE / page. Not a style choice —
// it's what agents and editors expect, and deviating from it is the
// kind of small friction that makes a submission look amateur.

function xmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Markdown emphasis → runs. Deliberately minimal: prose uses italics
// and the occasional bold, and a full parser would be a lot of code to
// support syntax that shouldn't appear in a manuscript anyway.
function inlineRuns(text, { font = 'Times New Roman', size = 24 } = {}) {
  const parts = [];
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index) });
    if (m[2] !== undefined) parts.push({ t: m[2], b: true });
    else parts.push({ t: m[4], i: true });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ t: text.slice(last) });
  if (!parts.length) parts.push({ t: '' });

  return parts.map(p => {
    const props = [`<w:rFonts w:ascii="${font}" w:hAnsi="${font}"/>`, `<w:sz w:val="${size}"/>`];
    if (p.b) props.push('<w:b/>');
    if (p.i) props.push('<w:i/>');
    return `<w:r><w:rPr>${props.join('')}</w:rPr>` +
           `<w:t xml:space="preserve">${xmlEsc(p.t)}</w:t></w:r>`;
  }).join('');
}

function para(text, { align = 'left', indent = 720, spaceBefore = 0,
                      pageBreak = false, size = 24, bold = false } = {}) {
  const pPr = [];
  if (pageBreak) pPr.push('<w:pageBreakBefore/>');
  // Double spacing throughout, as the format requires.
  pPr.push('<w:spacing w:line="480" w:lineRule="auto" w:before="' + spaceBefore + '" w:after="0"/>');
  if (indent) pPr.push(`<w:ind w:firstLine="${indent}"/>`);
  if (align !== 'left') pPr.push(`<w:jc w:val="${align}"/>`);
  const body = bold
    ? `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="${size}"/><w:b/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`
    : inlineRuns(text, { size });
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${body}</w:p>`;
}

async function buildDocx(scope) {
  const scenes = scenesInScope(scope);
  const title = manuscriptTitle(scope);
  const words = scenes.reduce((n, s) => n + (s.wordCount || 0), 0);
  const au = App.data.author || {};
  const legal = [au.first, au.middle, au.last].filter(Boolean).join(' ');
  const byline = authorByline();
  const surname = au.last || (byline || 'Author').split(/\s+/).pop();

  const body = [];

  // ── Title page ──
  // Contact block flush left at the top, title a third of the way
  // down, word count with the byline. Straight out of the format.
  for (const line of [legal, ...(au.address || '').split('\n'), au.phone, au.email]
        .map(s => (s || '').trim()).filter(Boolean)) {
    body.push(para(line, { indent: 0 }));
  }
  if (au.agent) {
    body.push(para('', { indent: 0 }));
    body.push(para(`Represented by ${au.agent}`, { indent: 0 }));
    if (au.agentContact) body.push(para(au.agentContact, { indent: 0 }));
  }
  for (let i = 0; i < 6; i++) body.push(para('', { indent: 0 }));
  body.push(para(title.toUpperCase(), { align: 'center', indent: 0, bold: true }));
  body.push(para('', { indent: 0 }));
  if (byline) body.push(para(`by ${byline}`, { align: 'center', indent: 0 }));
  body.push(para('', { indent: 0 }));
  // Manuscript word counts are conventionally rounded.
  body.push(para(`about ${(Math.round(words / 100) * 100).toLocaleString()} words`,
    { align: 'center', indent: 0 }));

  // ── Text ──
  let lastChapter, firstChapter = true;
  for (const meta of scenes) {
    const rec = await RecordStore.get('scene', meta.id);
    if (!rec) continue;

    if (meta.chapterId !== lastChapter) {
      lastChapter = meta.chapterId;
      if (meta.chapterTitle) {
        // Every chapter starts a new page, a third of the way down.
        body.push(para(meta.chapterTitle.toUpperCase(),
          { align: 'center', indent: 0, pageBreak: true, spaceBefore: 2880 }));
        body.push(para('', { indent: 0 }));
      } else if (!firstChapter) {
        body.push(para('#', { align: 'center', indent: 0 }));
      }
      firstChapter = false;
    } else {
      // Scene break inside a chapter: a centred hash, the conventional
      // typescript mark.
      body.push(para('#', { align: 'center', indent: 0 }));
    }

    const text = stripWikilinks((rec.body || '').trim());
    for (const block of text.split(/\n{2,}/)) {
      const t = block.trim();
      if (!t) continue;
      // A markdown heading inside a scene becomes a centred line —
      // manuscripts have no h2.
      const h = t.match(/^#{1,6}\s+(.*)$/s);
      if (h) { body.push(para(h[1], { align: 'center', indent: 0 })); continue; }
      body.push(para(t.replace(/\n/g, ' ')));
    }
  }

  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:jc w:val="right"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>
<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr>
<w:t xml:space="preserve">${xmlEsc(surname)} / ${xmlEsc(title)} / </w:t></w:r>
<w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>
</w:p></w:hdr>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body.join('')}
<w:sectPr>
<w:headerReference w:type="default" r:id="rId10"/>
<w:pgSz w:w="12240" w:h="15840"/>
<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"
         w:header="720" w:footer="720" w:gutter="0"/>
<w:titlePg/>
</w:sectPr></w:body></w:document>`;

  const files = {
    'mimetype': fflate.strToU8('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    '[Content_Types].xml': fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`),
    '_rels/.rels': fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    'word/_rels/document.xml.rels': fflate.strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`),
    'word/header1.xml': fflate.strToU8(header),
    'word/document.xml': fflate.strToU8(document),
  };
  // The mimetype entry must be stored, not deflated.
  delete files['mimetype'];

  return fflate.zipSync(files, { level: 6 });
}

// ── EPUB ───────────────────────────────────────────────────────────
//
// For reading your own draft on a phone or an e-reader, which catches
// things the editor never will — pacing, repetition, a chapter that
// ends flat. One XHTML file per chapter, so the reader can page and
// bookmark properly.

function xhtmlChapter(title, paras) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${xmlEsc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section epub:type="chapter">
<h1>${xmlEsc(title)}</h1>
${paras}
</section></body></html>`;
}

async function buildEpub(scope) {
  const scenes = scenesInScope(scope);
  const title = manuscriptTitle(scope);
  const byline = authorByline() || 'Unknown';
  const uid = `urn:uuid:${(crypto.randomUUID?.() || Date.now().toString(36))}`;

  // Group into chapters — an ebook with one file per scene would give
  // a table of contents nobody wants to scroll.
  const chapters = [];
  let current = null;
  for (const meta of scenes) {
    const rec = await RecordStore.get('scene', meta.id);
    if (!rec) continue;
    const name = meta.chapterTitle || 'Unplaced';
    if (!current || current.title !== name) {
      current = { title: name, html: [] };
      chapters.push(current);
    } else {
      current.html.push('<p class="break">#</p>');
    }
    const text = stripWikilinks((rec.body || '').trim());
    for (const block of text.split(/\n{2,}/)) {
      const t = block.trim();
      if (!t) continue;
      const h = t.match(/^#{1,6}\s+(.*)$/s);
      if (h) { current.html.push(`<h2>${xmlEsc(h[1])}</h2>`); continue; }
      const inline = xmlEsc(t.replace(/\n/g, ' '))
        .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
        .replace(/(\*|_)(.+?)\1/g, '<em>$2</em>');
      current.html.push(`<p>${inline}</p>`);
    }
  }

  const files = {};
  const put = (name, text) => { files[name] = fflate.strToU8(text); };

  put('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf"
 media-type="application/oebps-package+xml"/></rootfiles></container>`);

  put('OEBPS/style.css', `body { font-family: Georgia, serif; line-height: 1.6; margin: 1em; }
h1 { font-size: 1.3em; margin: 2em 0 1.2em; text-align: center; font-weight: normal;
     letter-spacing: .08em; text-transform: uppercase; }
h2 { font-size: 1.05em; text-align: center; font-weight: normal; margin: 1.6em 0 .8em; }
p { margin: 0; text-indent: 1.4em; text-align: justify; }
/* The first paragraph after a heading or a break is not indented —
   an indent there marks a continuation that hasn't happened. */
h1 + p, h2 + p, .break + p { text-indent: 0; }
.break { text-align: center; text-indent: 0; margin: 1.2em 0; }`);

  chapters.forEach((c, i) => {
    put(`OEBPS/ch${i + 1}.xhtml`, xhtmlChapter(c.title, c.html.join('\n')));
  });

  const manifest = chapters.map((_, i) =>
    `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('');

  put('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head><body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${xmlEsc(c.title)}</a></li>`).join('')}
</ol></nav></body></html>`);

  put('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
<dc:title>${xmlEsc(title)}</dc:title>
<dc:creator>${xmlEsc(byline)}</dc:creator>
<dc:language>en</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
${manifest}</manifest>
<spine>${spine}</spine></package>`);

  // The mimetype entry must come first and be STORED, not deflated —
  // readers check the raw bytes at a fixed offset.
  return fflate.zipSync({
    'mimetype': [fflate.strToU8('application/epub+zip'), { level: 0 }],
    ...files,
  }, { level: 6 });
}

// ── Plain text ─────────────────────────────────────────────────────

async function buildPlainText(scope) {
  const md = await compileText(scope);
  return stripWikilinks(md)
    .replace(/^#{1,6}\s+/gm, '')       // headings become plain lines
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/^\s*[-*]\s+/gm, '');
}

// ── Chooser ────────────────────────────────────────────────────────

async function exportAs() {
  await flushActiveScene();
  const scope = await chooseWork('Compile');
  if (!scope) return;

  const fmt = await askChoice('Which format?', [
    { label: 'Word (.docx) — standard manuscript format', value: 'docx' },
    { label: 'EPUB — read it on a phone or e-reader',      value: 'epub' },
    { label: 'Markdown (.md)',                              value: 'md' },
    { label: 'Plain text (.txt)',                           value: 'txt' },
  ]);
  if (!fmt) return;

  const base = `${slug(manuscriptTitle(scope), 'manuscript')}-${stamp()}`;
  showToast('Compiling…');

  try {
    if (fmt === 'docx') {
      downloadBlob(await buildDocx(scope), `${base}.docx`,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    } else if (fmt === 'epub') {
      downloadBlob(await buildEpub(scope), `${base}.epub`, 'application/epub+zip');
    } else if (fmt === 'txt') {
      downloadBlob(await buildPlainText(scope), `${base}.txt`, 'text/plain;charset=utf-8');
    } else {
      downloadBlob(await compileText(scope), `${base}.md`, 'text/markdown;charset=utf-8');
    }
    showToast('Compiled.');
  } catch (e) {
    console.error(e);
    showToast('Compile failed — see the console.', 6000);
  }
}

async function exportManuscript() {
  await flushActiveScene();
  const scope = await chooseWork('Compile');
  if (!scope) return;
  const text = await compileText(scope);
  downloadBlob(text, `${slug(manuscriptTitle(scope), 'manuscript')}-${stamp()}.md`,
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
/**
 * collectRecords(projectId) — every record, or one project's worth.
 *
 * Scenes, chapters and parts have no projectId of their own: they
 * belong to a book, and the book belongs to a project. So a scoped
 * collection walks DOWN from the books rather than filtering each type
 * independently — filtering scenes by a field they don't have would
 * silently return nothing at all.
 */
async function collectRecords(projectId = null) {
  const [projects, books, parts, chapters, scenes, cards, events] = await Promise.all([
    RecordStore.getAll('project'), RecordStore.getAll('book'), RecordStore.getAll('part'),
    RecordStore.getAll('chapter'), RecordStore.getAll('scene'),
    RecordStore.getAll('card'), RecordStore.getAll('event'),
  ]);

  if (!projectId) return { projects, books, parts, chapters, scenes, cards, events };

  const keep = (obj, test) =>
    Object.fromEntries(Object.entries(obj).filter(([, r]) => test(r)));

  const myBooks = keep(books, b => b.projectId === projectId);
  const bookIds = new Set(Object.keys(myBooks));
  const myParts = keep(parts, pt => bookIds.has(pt.bookId));
  const myChapters = keep(chapters, c => bookIds.has(c.bookId) || myParts[c.partId]);
  const chapterIds = new Set(Object.keys(myChapters));

  return {
    projects: keep(projects, pr => pr.id === projectId),
    books: myBooks,
    parts: myParts,
    chapters: myChapters,
    scenes: keep(scenes, s => chapterIds.has(s.chapterId)),
    cards: keep(cards, c => c.projectId === projectId),
    events: keep(events, e => e.projectId === projectId),
  };
}

/**
 * exportBackup({ projectId }) — the restorable zip.
 *
 * projectId null backs up EVERYTHING, across every project. A backup
 * should be everything you own; anything narrower is an export.
 *
 * Layout mirrors the structure, so the folder is browsable on its own:
 *
 *   manuscript/<project>/<book>/<part>/<chapter>/01-scene.md
 *   compiled.md                (single-project exports only)
 *   images/<cardId>.jpg
 *   recension-backup.json      ← the restorable copy
 *
 * Numeric prefixes preserve reading order in a file listing, which
 * alphabetical names would scramble.
 */
async function exportBackup({ projectId = null } = {}) {
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  const records = await collectRecords(projectId);
  const { projects, books, parts, chapters, scenes, cards } = records;
  const files = {};
  const enc = fflate.strToU8;
  const single = !!projectId;

  const addScene = (path, i, rec) => {
    const head = [`# ${rec.title || 'Untitled scene'}`];
    if (rec.synopsis) head.push('', `> ${rec.synopsis}`);
    if (rec.pov)      head.push('', `POV: ${rec.pov}`);
    // Links are KEPT here. This copy exists to restore from, and
    // stripping them would make the backup lossy — compiled.md is the
    // reader-facing version.
    head.push('', (rec.body || '').trim(), '');
    files[`${path}/${pad(i + 1)}-${slug(rec.title, 'scene')}.md`] = enc(head.join('\n'));
  };

  const ordered = o => Object.values(o).sort((x, y) => (x.order || 0) - (y.order || 0));
  const scenesOf = chapterId => Object.values(scenes)
    .filter(s => s.chapterId === chapterId)
    .sort((x, y) => (x.order || 0) - (y.order || 0));
  const writeChapter = (path, ch, i) => {
    const cp = `${path}/${pad(i + 1)}-${slug(ch.title, 'chapter')}`;
    scenesOf(ch.id).forEach((s, si) => addScene(cp, si, s));
  };

  ordered(projects).forEach((proj, pi) => {
    // A single-project export needs no project folder — there is only
    // one, and the extra level would be noise.
    const root = single ? 'manuscript'
      : `manuscript/${pad(pi + 1)}-${slug(proj.title, 'project')}`;

    ordered(books).filter(b => b.projectId === proj.id).forEach((b, bi) => {
      const bp = `${root}/${pad(bi + 1)}-${slug(b.title, 'book')}`;
      ordered(parts).filter(pt => pt.bookId === b.id).forEach((pt, pti) => {
        const pp = `${bp}/${pad(pti + 1)}-${slug(pt.title, 'part')}`;
        ordered(chapters).filter(c => c.partId === pt.id)
          .forEach((c, ci) => writeChapter(pp, c, ci));
      });
      let n = 0;
      ordered(chapters).filter(c => c.bookId === b.id && !c.partId)
        .forEach(c => writeChapter(bp, c, n++));
    });
  });

  // Anything whose chapter or book is gone is still written out. A
  // backup that silently omits detached work is not a backup.
  const placed = new Set();
  for (const ch of Object.values(chapters)) scenesOf(ch.id).forEach(s => placed.add(s.id));
  Object.values(scenes).filter(s => !placed.has(s.id))
    .forEach((s, i) => addScene('manuscript/unplaced', i, s));

  if (single) files['compiled.md'] = enc(await compileText(defaultReadScope()));

  // Images as real files. The JSON carries only the imageKey string,
  // so without these a restored card would point at a portrait that
  // exists nowhere.
  for (const c of Object.values(cards)) {
    if (!c.imageKey) continue;
    const blob = await RecordStore.getImage(c.id);
    if (!blob) continue;
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    files[`images/${c.id}.${ext}`] = new Uint8Array(await blob.arrayBuffer());
  }

  files['recension-backup.json'] = enc(JSON.stringify({
    format: 'recension-backup',
    version: 2,
    scope: single ? 'project' : 'all',
    exportedAt: new Date().toISOString(),
    author: App.data.author,
    records,
  }, null, 2));

  const label = single ? slug(ordered(projects)[0]?.title, 'project') : 'everything';
  downloadBlob(fflate.zipSync(files, { level: 6 }),
    `recension-${label}-${stamp()}.zip`, 'application/zip');
  showToast(single ? 'Project exported.' : 'Backup downloaded.');
}

// ══ Snowflake ══════════════════════════════════════════════════════
//
// Randy Ingermanson's method: a story at increasing magnification. A
// sentence, then a paragraph, then a paragraph for each sentence of
// that paragraph, then a page for each of those.
//
// NOT A WIZARD, though it has one. Ingermanson is explicit that the
// steps loop — after step 4 you go back and fix step 2; after step 8
// you find step 3 was wrong. A pure wizard fights that, and the
// friction lands exactly when the method is working. So the steps are
// a view you can open at any point, and "Guide me" is a mode over the
// same records that walks them in order.
//
// NOTHING IS REQUIRED. Steps can be switched off per project; an
// unused step is hidden, never deleted, so turning it back on returns
// whatever was in it.

const SNOWFLAKE_STEPS = [
  { n: 1,  key: 'sentence',  title: 'Story in a sentence',
    blurb: 'One or two sentences. Swain\u2019s five parts, if they help.' },
  { n: 2,  key: 'paragraph', title: 'Story in a paragraph',
    blurb: 'Five sentences: the setup, three disasters, and the ending.' },
  { n: 3,  key: 'sheets',    title: 'Character sheets',
    blurb: 'A sheet for each important character. Creates cards.' },
  { n: 4,  key: 'expand2',   title: 'Paragraphs from sentences',
    blurb: 'Each sentence of step 2 becomes its own paragraph.' },
  { n: 5,  key: 'synopsis',  title: 'Character synopsis',
    blurb: 'The story from each character\u2019s point of view.' },
  { n: 6,  key: 'expand4',   title: 'Pages from paragraphs',
    blurb: 'Each paragraph of step 4 becomes a full page.' },
  { n: 7,  key: 'charts',    title: 'Character charts',
    blurb: 'Everything else you know about each character.' },
  { n: 8,  key: 'scenes',    title: 'Scene map',
    blurb: 'Every scene, with its point of view. Creates scenes.' },
  { n: 9,  key: 'narrative', title: 'Narrative description',
    blurb: 'A short summary of each scene \u2014 a mini first draft.' },
  { n: 10, key: 'draft',     title: 'Write the first draft',
    blurb: 'The part no method can do for you.' },
];

// Steps 1, 2 and 8 are the spine. The rest can be switched off, and
// several writers use none of them.
const SNOWFLAKE_CORE = ['sentence', 'paragraph', 'scenes', 'draft'];

const SWAIN_FIELDS = ['Situation', 'Character', 'Objective', 'Opponent', 'Disaster'];

// ── Sentence splitting ─────────────────────────────────────────────
//
// Step 2 is written as prose and STORED as its sentences, because
// step 4 expands sentence n into paragraph n. A naive split on ". "
// breaks on ranks and initials, which this material is full of —
// "Col. Mendoza", "J. R. Langford", "St. Louis".

const SPLIT_GUARDS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'St', 'Sgt', 'Col', 'Gen', 'Lt', 'Capt',
  'Cmdr', 'Maj', 'Cpl', 'Pvt', 'Adm', 'Gov', 'Sen', 'Rep', 'Jr', 'Sr',
  'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m', 'U.S', 'U.K',
];

function splitSentences(text) {
  const src = (text || '').replace(/\s+/g, ' ').trim();
  if (!src) return [];

  const out = [];
  let start = 0;

  for (let i = 0; i < src.length; i++) {
    if (!'.!?'.includes(src[i])) continue;

    // Carry closing quotes and brackets into the sentence they end.
    let j = i + 1;
    while (j < src.length && '"\u201D\u2019\')]'.includes(src[j])) j++;
    if (j < src.length && src[j] !== ' ') continue;

    const before = src.slice(start, i);
    const lastWord = before.split(/[\s(]/).pop();

    // A known abbreviation, or a single initial like "J." — neither
    // ends a sentence.
    if (SPLIT_GUARDS.includes(lastWord)) continue;
    if (/^[A-Z]$/.test(lastWord)) continue;

    // What follows decides it. A lowercase word after a terminator
    // means the sentence is still going — which is the case for an
    // ellipsis ("She waited... then she ran") and for dialogue with a
    // tag ('"Get down!" he shouted'). Both were splitting wrongly on
    // the punctuation alone.
    const next = src.slice(j).trimStart()[0];
    if (next && !/[A-Z0-9"'\u201C\u2018(\[]/.test(next)) continue;

    out.push(src.slice(start, j).trim());
    start = j + 1;
  }

  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// ── Snowflake state ────────────────────────────────────────────────

// Which step is open, and whether the guided walkthrough is running.
const snow = { step: 1, guided: false };

async function snowConfig() {
  const list = await RecordStore.listProjects();
  const proj = list.find(p => p.id === RecordStore.currentProject());
  return proj?.snowflake || { off: [], swain: {}, sentence: '', paragraph: '' };
}

async function saveSnowConfig(patch) {
  const id = RecordStore.currentProject();
  const rec = await RecordStore.get('project', id);
  if (!rec) return;
  const snowflake = { ...(rec.snowflake || {}), ...patch };
  await RecordStore.put('project', id, { ...rec, snowflake });
}

async function activeSteps() {
  const cfg = await snowConfig();
  // A switched-off step is HIDDEN, not deleted. Whatever you wrote in
  // it comes back when you turn it on — otherwise unchecking a box
  // would be a data loss with no confirmation.
  return SNOWFLAKE_STEPS.filter(s => !(cfg.off || []).includes(s.key));
}

// ── Rail ───────────────────────────────────────────────────────────

async function renderPlan() {
  const list = $('plan-list');
  list.replaceChildren();

  const cfg = await snowConfig();
  const steps = await activeSteps();
  const done = await stepProgress();

  for (const step of steps) {
    const row = el('button', 'toc-scene plan-row' + (snow.step === step.n ? ' on' : ''));
    row.setAttribute('aria-current', String(snow.step === step.n));
    row.append(el('span', 'plan-n', String(step.n)));
    row.append(el('span', 'toc-title', step.title));
    const state = done[step.key];
    if (state) row.append(el('span', 'plan-done', state));
    row.addEventListener('click', () => { snow.step = step.n; renderPlan(); renderSnowflake(); });
    list.append(row);
  }

  const hidden = SNOWFLAKE_STEPS.length - steps.length;
  const tog = el('button', 'toc-add', hidden ? `Steps \u00B7 ${hidden} hidden` : 'Choose steps');
  tog.addEventListener('click', openStepPicker);
  list.append(tog);
}

// A short state per step, so the rail says what's been done without
// claiming anything is "complete" — nothing in this method ever is.
async function stepProgress() {
  const cfg = await snowConfig();
  const [l2, l3, l4] = await Promise.all([
    RecordStore.beatsAt(2), RecordStore.beatsAt(3), RecordStore.beatsAt(4),
  ]);
  const cards = Object.values(await RecordStore.getAllIn('card'))
    .filter(c => c.cardType === 'character');
  const tree = App.tree || await RecordStore.getTree();
  const scenes = RecordStore.allChapters(tree).flatMap(c => c.scenes)
    .concat(tree.unfiled || []);

  const n = (v, unit) => v ? `${v}` : '';
  return {
    sentence:  cfg.sentence ? '\u2713' : '',
    paragraph: n(l2.length),
    sheets:    n(cards.length),
    expand2:   n(l3.length),
    synopsis:  n(cards.filter(c => c.body).length),
    expand4:   n(l4.length),
    charts:    n(cards.filter(c => Object.keys(c.fields || {}).length > 4).length),
    scenes:    n(scenes.length),
    narrative: n(scenes.filter(s => s.synopsis).length),
    draft:     tree.totalWords ? fmtWords(tree.totalWords) : '',
  };
}

async function openStepPicker() {
  const cfg = await snowConfig();
  const off = new Set(cfg.off || []);

  const overlay = el('div', 'modal-overlay');
  const modal = el('div', 'modal modal-sm');
  const head = el('div', 'modal-header');
  head.append(el('h2', 'modal-title', 'Which steps?'));
  const body = el('div', 'modal-body');
  body.append(el('p', 'note',
    'Turn off the ones you don\u2019t use. Nothing is deleted \u2014 a hidden ' +
    'step keeps whatever is in it and comes back if you turn it on again.'));

  for (const s of SNOWFLAKE_STEPS) {
    const row = el('label', 'row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !off.has(s.key);
    cb.disabled = SNOWFLAKE_CORE.includes(s.key);
    cb.addEventListener('change', () => {
      cb.checked ? off.delete(s.key) : off.add(s.key);
    });
    row.append(el('span', null, `${s.n}. ${s.title}`));
    row.append(cb);
    body.append(row);
  }

  const actions = el('div', 'modal-actions');
  const cancel = el('button', 'ghost-btn', 'Cancel');
  cancel.addEventListener('click', () => overlay.remove());
  const save = el('button', 'solid-btn', 'Save');
  save.addEventListener('click', async () => {
    await saveSnowConfig({ off: [...off] });
    overlay.remove();
    renderPlan();
    renderSnowflake();
  });
  actions.append(cancel, save);
  body.append(actions);

  modal.append(head, body);
  overlay.append(modal);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
}

// ── The sheet ──────────────────────────────────────────────────────

async function openPlan() {
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  App.view = 'plan';
  for (const id of ['scene', 'card-edit', 'event-edit', 'readview', 'timeline-wrap',
                    'grid-wrap', 'board-wrap', 'map-wrap', 'empty']) $(id).hidden = true;
  $('plan-wrap').hidden = false;
  $('tally').textContent = '';
  await renderSnowflake();
}

async function renderSnowflake() {
  const host = $('plan');
  host.replaceChildren();

  const steps = await activeSteps();
  const step = steps.find(s => s.n === snow.step) || steps[0];
  if (!step) return;
  snow.step = step.n;

  const head = el('header', 'sf-head');
  head.append(el('span', 'sf-n', `Step ${step.n}`));
  head.append(el('h1', null, step.title));
  head.append(el('p', 'sf-blurb', step.blurb));
  host.append(head);

  const body = el('div', 'sf-body');
  host.append(body);
  await STEP_VIEW[step.key](body);

  // Guided mode is the same records with next/back over them, not a
  // separate flow — so you can leave it at any point and the work is
  // simply there.
  const nav = el('nav', 'sf-nav');
  const i = steps.indexOf(step);
  if (i > 0) {
    const b = el('button', 'ghost-btn', `\u2190 ${steps[i - 1].title}`);
    b.addEventListener('click', () => { snow.step = steps[i - 1].n; renderPlan(); renderSnowflake(); });
    nav.append(b);
  } else nav.append(el('span', 'sn-gap'));
  if (i < steps.length - 1) {
    const b = el('button', 'solid-btn', `${steps[i + 1].title} \u2192`);
    b.addEventListener('click', () => { snow.step = steps[i + 1].n; renderPlan(); renderSnowflake(); });
    nav.append(b);
  }
  host.append(nav);
}

function sfField(parent, label, value, onChange, { rows = 2, placeholder = '' } = {}) {
  const wrap = el('label', 'sf-field');
  wrap.append(el('span', null, label));
  const ta = el('textarea');
  ta.rows = rows;
  ta.value = value || '';
  ta.placeholder = placeholder;
  ta.addEventListener('input', () => autoGrow(ta));
  ta.addEventListener('change', () => onChange(ta.value.trim()));
  wrap.append(ta);
  parent.append(wrap);
  requestAnimationFrame(() => autoGrow(ta));
  return ta;
}

const STEP_VIEW = {

  // ── 1 · Sentence ──
  async sentence(box) {
    const cfg = await snowConfig();
    sfField(box, 'The story, in a sentence or two', cfg.sentence,
      v => saveSnowConfig({ sentence: v }),
      { rows: 3, placeholder: 'A disgraced operator returns to the desert that broke her.' });

    box.append(el('p', 'note',
      'Swain\u2019s five parts, if they help you find it. They are a way in, not a form to complete.'));
    const grid = el('div', 'sf-swain');
    for (const f of SWAIN_FIELDS) {
      sfField(grid, f, cfg.swain?.[f], async v => {
        const c = await snowConfig();
        saveSnowConfig({ swain: { ...(c.swain || {}), [f]: v } });
      }, { rows: 1 });
    }
    box.append(grid);
  },

  // ── 2 · Paragraph, written as prose and stored as sentences ──
  async paragraph(box) {
    const cfg = await snowConfig();
    const beats = await RecordStore.beatsAt(2, null);

    box.append(el('p', 'note',
      'Write it as a paragraph. It splits into sentences underneath as you go \u2014 ' +
      'step 4 expands each one, so the split is the structure, not decoration.'));

    const prose = el('textarea', 'sf-prose');
    prose.rows = 5;
    prose.placeholder =
      'The setup, three disasters with the third the worst, and the ending.';
    // Once sentences have been edited by hand the prose box becomes a
    // read-only view of them joined: re-splitting would silently undo
    // a correction you made deliberately.
    prose.value = cfg.paragraph || beats.map(b => b.text).join(' ');
    prose.readOnly = !!cfg.paragraphLocked;
    box.append(prose);

    const parts = el('div', 'sf-parts');
    box.append(parts);

    const paint = list => {
      parts.replaceChildren();
      list.forEach((b, i) => {
        const row = el('div', 'sf-part');
        row.append(el('span', 'sf-role',
          RecordStore.BEAT_ROLES[i] || `Sentence ${i + 1}`));
        const ta = el('textarea');
        ta.rows = 1;
        ta.value = b.text || '';
        ta.addEventListener('input', () => autoGrow(ta));
        ta.addEventListener('change', async () => {
          const rec = await RecordStore.get('beat', b.id);
          if (rec) await RecordStore.put('beat', b.id, { ...rec, text: ta.value.trim() });
          // Hand authority to the sentences from here on.
          await saveSnowConfig({ paragraphLocked: true, paragraph: '' });
          prose.readOnly = true;
          renderPlan();
        });
        row.append(ta);
        parts.append(row);
        requestAnimationFrame(() => autoGrow(ta));
      });

      if (cfg.paragraphLocked) {
        const back = el('button', 'toc-add', 'Edit as prose again');
        back.addEventListener('click', async () => {
          if (!confirm('Rewriting as prose re-splits the sentences. Corrections you made to individual sentences may move.')) return;
          await saveSnowConfig({ paragraphLocked: false });
          renderSnowflake();
        });
        parts.append(back);
      }
    };

    paint(beats);

    let timer = null;
    prose.addEventListener('input', () => {
      autoGrow(prose);
      if (prose.readOnly) return;
      // Debounced, and only on completed sentences — splitting on every
      // keystroke makes a half-typed sentence jump between boxes.
      clearTimeout(timer);
      timer = setTimeout(() => resplit(prose.value), 400);
    });
    requestAnimationFrame(() => autoGrow(prose));

    async function resplit(text) {
      const sentences = splitSentences(text);
      const existing = await RecordStore.beatsAt(2, null);

      for (let i = 0; i < Math.max(sentences.length, existing.length); i++) {
        const s = sentences[i];
        const b = existing[i];
        if (s && b) {
          if (b.text !== s) await RecordStore.put('beat', b.id, { ...b, text: s });
        } else if (s) {
          await RecordStore.createBeat({ level: 2, text: s, order: i });
        } else if (b) {
          // Only remove an empty tail beat if nothing hangs off it.
          const kids = await RecordStore.beatsAt(3, b.id);
          if (!kids.length && !(b.text || '').trim()) await RecordStore.deleteBeat(b.id);
          else if (!kids.length) await RecordStore.deleteBeat(b.id);
        }
      }
      await saveSnowConfig({ paragraph: text });
      paint(await RecordStore.beatsAt(2, null));
      renderPlan();
    }
  },

  // ── 3, 5, 7 · The same cards, deepening ──
  async sheets(box)   { await characterStep(box, 'sheet'); },
  async synopsis(box) { await characterStep(box, 'synopsis'); },
  async charts(box)   { await characterStep(box, 'chart'); },

  // ── 4 and 6 · The expansion ──
  async expand2(box) { await expandStep(box, 2); },
  async expand4(box) { await expandStep(box, 3); },

  // ── 8 · Scene map ──
  async scenes(box) {
    const tree = App.tree || await RecordStore.getTree();
    const chapters = RecordStore.allChapters(tree);
    const beats = await RecordStore.beatTree();
    const flat = [];
    const walk = (list, depth) => list.forEach(b => {
      flat.push({ ...b, depth });
      walk(b.children, depth + 1);
    });
    walk(beats, 0);

    if (!flat.length) {
      box.append(el('p', 'rv-empty',
        'Write step 2 first \u2014 scenes here hang off the beats it creates.'));
      return;
    }

    box.append(el('p', 'note',
      'Every scene, with its point of view and what happens. A scene made here ' +
      'is a real scene in the manuscript \u2014 give it a chapter or it waits in Unplaced.'));

    for (const b of flat) {
      const sec = el('section', 'sf-beat');
      const h = el('div', 'sf-beat-head');
      h.append(el('span', 'sf-level', RecordStore.BEAT_LEVELS[b.level]));
      h.append(el('span', 'sf-beat-text', b.text || 'Untitled beat'));
      if (b.sceneCount) h.append(el('span', 'toc-figure',
        `${b.sceneCount} scene${b.sceneCount === 1 ? '' : 's'} \u00B7 ${fmtWords(b.words)}`));
      sec.append(h);

      for (const sc of b.scenes) {
        const row = el('button', 'sf-scene');
        row.append(el('span', 'toc-title', sc.title || 'Untitled scene'));
        if (sc.pov) row.append(el('span', 'sf-pov', sc.pov));
        row.append(el('span', 'toc-figure', fmtWords(sc.wordCount)));
        row.addEventListener('click', () => { railSection('manuscript'); openScene(sc.id); });
        sec.append(row);
      }

      const add = el('button', 'toc-add', '+ scene for this beat');
      add.addEventListener('click', () => newSceneForBeat(b, chapters));
      sec.append(add);
      box.append(sec);
    }

    const stray = await RecordStore.unplannedScenes();
    if (stray.length) {
      const sec = el('section', 'sf-beat');
      sec.append(el('div', 'sf-beat-head',
        `${stray.length} scene${stray.length === 1 ? '' : 's'} not tied to a beat`));
      sec.append(el('p', 'note',
        'Sometimes exactly right \u2014 the book found something the plan didn\u2019t. ' +
        'Worth a look either way.'));
      for (const sc of stray) {
        const row = el('button', 'sf-scene');
        row.append(el('span', 'toc-title', sc.title || 'Untitled scene'));
        row.append(el('span', 'sf-pov', sc.chapter || ''));
        row.addEventListener('click', () => { railSection('manuscript'); openScene(sc.id); });
        sec.append(row);
      }
      box.append(sec);
    }
  },

  // ── 9 · Narrative description ──
  async narrative(box) {
    const tree = App.tree || await RecordStore.getTree();
    const scenes = RecordStore.allChapters(tree).flatMap(ch =>
      ch.scenes.map(s => ({ ...s, chapter: ch.title })));
    if (!scenes.length) {
      box.append(el('p', 'rv-empty', 'No scenes yet \u2014 step 8 makes them.'));
      return;
    }
    box.append(el('p', 'note',
      'A short summary of each scene. Together they are a mini first draft to write against. ' +
      'This is the same synopsis field the scene editor shows.'));

    for (const sc of scenes) {
      const rec = await RecordStore.get('scene', sc.id);
      if (!rec) continue;
      sfField(box, `${sc.chapter} \u2014 ${sc.title}`, rec.synopsis, async v => {
        const fresh = await RecordStore.get('scene', sc.id);
        if (fresh) await RecordStore.put('scene', sc.id, { ...fresh, synopsis: v });
        renderPlan();
      }, { rows: 2, placeholder: 'What happens, and what it costs.' });
    }
  },

  // ── 10 · Draft ──
  async draft(box) {
    const tree = App.tree || await RecordStore.getTree();
    box.append(el('p', 'note',
      `${tree.totalWords.toLocaleString()} words so far. The plan is behind you now \u2014 ` +
      'it is there when you want it and does not need finishing.'));
    const go = el('button', 'solid-btn', 'Back to the manuscript');
    go.addEventListener('click', () => {
      railSection('manuscript');
      place().openSceneId ? openScene(place().openSceneId) : showEmpty();
    });
    box.append(go);
  },
};

// ── Shared step machinery ──────────────────────────────────────────

// Steps 3, 5 and 7 are the SAME CARDS at increasing depth, not three
// separate artefacts. The template repeats them because it's a Word
// document; a tool shouldn't. Step 3 adds the Snowflake fields, step 5
// fills the notes, step 7 adds whatever else you know.
const SNOWFLAKE_CARD_FIELDS = {
  sheet: ['Role', 'Storyline in a sentence', 'Motivation',
          'Goal — professional', 'Goal — personal', 'Goal — love',
          'Conflict — external', 'Conflict — internal', 'Epiphany'],
  chart: ['Born', 'Appearance', 'History', 'How they speak',
          'What they want that they cannot admit'],
};

async function characterStep(box, phase) {
  const cards = Object.values(await RecordStore.getAllIn('card'))
    .filter(c => c.cardType === 'character')
    .sort((x, y) => (x.name || '').localeCompare(y.name || ''));

  const blurb = {
    sheet: 'A sheet for each character who matters. These are ordinary cards — ' +
           'anything you add here shows up everywhere else in the app.',
    synopsis: 'The whole story, told from each character\u2019s point of view. ' +
              'Written into the card\u2019s notes.',
    chart: 'Everything else you know. Birthdate, history, how they talk.',
  }[phase];
  box.append(el('p', 'note', blurb));

  if (!cards.length) {
    box.append(el('p', 'rv-empty', 'No character cards yet.'));
  }

  for (const c of cards) {
    const sec = el('section', 'sf-beat');
    const h = el('div', 'sf-beat-head');
    const open = el('button', 'sf-card-name', c.name);
    open.addEventListener('click', () => { railSection('cards'); openCard(c.id); });
    h.append(open);
    sec.append(h);

    if (phase === 'synopsis') {
      sfField(sec, 'Their version of the story', c.body, async v => {
        const rec = await RecordStore.get('card', c.id);
        if (rec) await RecordStore.put('card', c.id, { ...rec, body: v });
        renderPlan();
      }, { rows: 5 });
    } else {
      for (const f of SNOWFLAKE_CARD_FIELDS[phase]) {
        sfField(sec, f, (c.fields || {})[f], async v => {
          const rec = await RecordStore.get('card', c.id);
          if (!rec) return;
          await RecordStore.put('card', c.id, { ...rec, fields: { ...rec.fields, [f]: v } });
          renderPlan();
        }, { rows: 1 });
      }
    }
    box.append(sec);
  }

  const add = el('button', 'toc-add', '+ character');
  add.addEventListener('click', async () => {
    const name = await askName('New character', 'Name');
    if (!name) return;
    const id = await RecordStore.createCard('character', name);
    if (!id) return;
    const rec = await RecordStore.get('card', id);
    const fields = {};
    for (const f of SNOWFLAKE_CARD_FIELDS.sheet) fields[f] = '';
    await RecordStore.put('card', id, { ...rec, fields });
    invalidateCardIndex();
    renderSnowflake();
    renderPlan();
  });
  box.append(add);
}

/**
 * expandStep(box, fromLevel) — steps 4 and 6.
 *
 * Each element of the level above gets one child here, and that
 * parentage is the method: paragraph n expands sentence n. Showing the
 * parent above each box is not decoration — it's the thing you are
 * expanding, and without it you're just writing more prose.
 */
async function expandStep(box, fromLevel) {
  const parents = await RecordStore.beatsAt(fromLevel);
  if (!parents.length) {
    box.append(el('p', 'rv-empty',
      fromLevel === 2 ? 'Write step 2 first.' : 'Write step 4 first.'));
    return;
  }

  box.append(el('p', 'note', fromLevel === 2
    ? 'One paragraph for each sentence above. The third disaster usually wants the most.'
    : 'One page for each paragraph. This is the last stop before scenes.'));

  for (const parent of parents) {
    const sec = el('section', 'sf-beat');
    const h = el('div', 'sf-beat-head');
    h.append(el('span', 'sf-level', RecordStore.BEAT_LEVELS[parent.level]));
    h.append(el('span', 'sf-beat-text', parent.text || '—'));
    sec.append(h);

    const kids = await RecordStore.beatsAt(fromLevel + 1, parent.id);
    const child = kids[0];

    sfField(sec, '', child?.text, async v => {
      if (child) {
        const rec = await RecordStore.get('beat', child.id);
        if (rec) await RecordStore.put('beat', child.id, { ...rec, text: v });
      } else if (v) {
        await RecordStore.createBeat({ parentId: parent.id, level: fromLevel + 1, text: v });
      }
      renderPlan();
    }, { rows: fromLevel === 2 ? 4 : 10,
         placeholder: fromLevel === 2 ? 'Expand this sentence into a paragraph.'
                                      : 'Expand this paragraph into a page.' });
    box.append(sec);
  }
}

/**
 * newSceneForBeat(beat, chapters) — make a scene that dramatizes a beat.
 *
 * Asks for the chapter up front. Creating forty scenes straight into
 * Unplaced would leave a pile to sort; choosing as you go means most
 * of them never go there. Leave it blank and Unplaced is exactly the
 * right home, which is what it is already for.
 */
async function newSceneForBeat(beat, chapters) {
  const title = await askName('New scene', 'What happens');
  if (!title) return;

  let chapterId = null;
  if (chapters.length) {
    chapterId = await askChoice('Put it in which chapter?', [
      ...chapters.map(c => ({ label: c.title, value: c.id })),
      { label: 'Leave it unplaced for now', value: '' },
    ]);
    if (chapterId === null) return;   // cancelled, as distinct from unplaced
  }

  const id = await RecordStore.createScene(chapterId || null, title);
  if (!id) return;
  const rec = await RecordStore.get('scene', id);
  await RecordStore.put('scene', id, { ...rec, beatId: beat.id });
  await renderTree();
  renderSnowflake();
  renderPlan();
}

// ══ Cards ══════════════════════════════════════════════════════════
//
// The reference layer: people, places, factions, objects, research.
// This is the half Scrivener doesn't really have — it keeps documents,
// not records, so nothing can answer "who appears where".
//
// FIELDS ARE FREE-FORM, on purpose. A character sheet for a spy thriller
// and one for a family saga share almost nothing; a fixed schema would be
// wrong for most books and unfixable for all of them. New cards get a few
// suggested fields as a starting point, and every one can be renamed or
// deleted.

// Starting fields per type. Suggestions, not structure — they exist so a
// blank card isn't an empty box, and they're deletable like any other.
const CARD_STARTERS = {
  character: ['Role', 'Age', 'Appearance', 'Wants', 'Fears'],
  location:  ['Region', 'Terrain', 'Feel', 'Significance'],
  faction:   ['Purpose', 'Allegiance', 'Leadership', 'Reach', 'Founded'],
  item:      ['Origin', 'Owner', 'Significance'],
  research:  ['Source', 'Relevance'],
};

const CARD_TYPE_SINGULAR = {
  character: 'character', location: 'place', faction: 'faction',
  item: 'object', research: 'research note',
};

const CARD_TYPE_LABEL = {
  character: 'Characters', location: 'Places', faction: 'Factions',
  item: 'Objects', research: 'Research',
};

function railSection(name) {
  App.section = name;
  savePlace({ section: name });
  for (const b of document.querySelectorAll('.rail-switch [role="tab"]'))
    b.setAttribute('aria-selected', String(b.dataset.section === name));
  $('toc').hidden         = name !== 'manuscript';
  $('card-list').hidden   = name !== 'cards';
  $('card-tools').hidden  = name !== 'cards';
  $('toc-tools').hidden   = name !== 'manuscript';
  $('event-list').hidden  = name !== 'events';
  $('ev-filter').hidden   = name !== 'events';
  $('plan-list').hidden   = name !== 'plan';
  saveLocal();
  if (name === 'cards')  return renderCards();
  if (name === 'events') return renderEvents();
  if (name === 'plan')   return renderPlan();
  return renderTree();
}

async function renderCards() {
  const list = $('card-list');
  list.replaceChildren();

  const cards = Object.values(await RecordStore.getAll('card'));

  // Every type is always shown, with its own add link underneath — the
  // same shape as "+ scene" under a chapter. Choosing the type by WHICH
  // link you click also fixes a real bug: creation used to guess the type
  // from whatever you made last and seed those fields.
  for (const type of RecordStore.CARD_TYPES) {
    const group = cards.filter(c => c.cardType === type)
                       .sort((x, y) => (x.name || '').localeCompare(y.name || ''));

    // Collapse state is keyed on a synthetic id so it rides along in the
    // same place record the parts and chapters use — one mechanism,
    // it's remembered.
    const groupId = `cards:${type}`;
    const collapsed = isCollapsed(groupId);

    const head = el('div', 'toc-group-head');
    head.append(caretFor(groupId, collapsed, renderCards));
    head.append(el('span', 'toc-group-label inline', CARD_TYPE_LABEL[type] || type));
    head.append(el('span', 'toc-leader'));
    if (group.length) head.append(el('span', 'toc-figure', String(group.length)));
    // The whole heading toggles, not just the caret — a five-pixel target
    // for something you do constantly is a bad trade.
    head.addEventListener('click', () => { setCollapsed(groupId, !collapsed); renderCards(); });
    list.append(head);

    if (collapsed) continue;

    for (const c of group) {
      list.append(tocLine('button', {
        className: 'toc-scene card-row',
        kind: 'card', id: c.id,
        title: c.name,
        figure: (c.tags || []).length ? String(c.tags.length) : null,
        current: App.activeCard?.id === c.id,
        onOpen: () => { openCard(c.id); if (App.readOnly) closeRail(); },
      }));
    }

    const add = el('button', 'toc-add', `+ ${CARD_TYPE_SINGULAR[type] || type}`);
    add.addEventListener('click', () => newCard(type));
    list.append(add);
  }
}

async function newCard(type = 'character') {
  const name = await askName(`New ${CARD_TYPE_SINGULAR[type] || 'card'}`, 'Name');
  if (!name) return;
  maybeRequestPersistence();

  const id = await RecordStore.createCard(type, name);
  if (!id) return;

  const rec = await RecordStore.get('card', id);
  await RecordStore.put('card', id, { ...rec, fields: startersFor(type) });
  await renderCards();
  openCard(id);
}

function startersFor(type) {
  const fields = {};
  for (const k of CARD_STARTERS[type] || []) fields[k] = '';
  return fields;
}

async function openCard(id) {
  await flushActiveScene();
  await flushActiveCard();

  const c = await RecordStore.get('card', id);
  if (!c) { showToast('That card is gone.'); return renderCards(); }

  App.activeCard = c;
  App.activeScene = null;
  App.activeEvent = null;
  App.view = 'edit';

  $('readview').hidden = true;
  $('empty').hidden = true;
  $('scene').hidden = true;
  $('event-edit').hidden = true;
  $('timeline-wrap').hidden = true;
  $('grid-wrap').hidden = true;
  $('board-wrap').hidden = true;
  $('map-wrap').hidden = true;
  $('plan-wrap').hidden = true;
  $('card-edit').hidden = false;
  $('btn-read').setAttribute('aria-pressed', 'false');

  $('card-name').value = c.name || '';
  $('card-type').value = c.cardType || 'character';
  $('card-tags').value = (c.tags || []).join(', ');
  $('card-aka').value  = (c.aka || []).join(', ');
  $('card-body').value = c.body || '';
  autoGrow($('card-body'));
  renderAppearances(c.id);
  renderCardFields(c.fields || {});
  paintCardImage(c.id);

  $('tally').textContent = '';
  renderCards();
  $('sheet').scrollTop = 0;
}

// Field rows. The key is editable too — renaming "Role" to "Rank" should
// not require deleting and re-adding.
function renderCardFields(fields) {
  const wrap = $('card-fields');
  wrap.replaceChildren();

  for (const [key, value] of Object.entries(fields)) {
    const row = el('div', 'card-field');

    const k = el('input', 'cf-key');
    k.value = key;
    k.setAttribute('aria-label', 'Field name');
    k.addEventListener('change', scheduleCardSave);

    // A textarea, not an input: "Mexico's counter-cyber terrorism service"
    // does not fit on one line, and a field you can't read the whole of is
    // worse than no field. Grows to its content, never scrolls internally.
    const v = el('textarea', 'cf-value');
    v.value = value ?? '';
    v.rows = 1;
    v.setAttribute('aria-label', key);
    v.addEventListener('input', () => { autoGrow(v); scheduleCardSave(); });
    // Enter commits rather than inserting a newline — these are field
    // values, not prose. Shift+Enter still breaks the line for an address
    // or a list.
    v.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); v.blur(); }
    });

    const del = el('button', 'cf-del', '\u00D7');
    del.type = 'button';
    del.setAttribute('aria-label', `Remove ${key}`);
    del.addEventListener('click', () => { row.remove(); flushActiveCard(); });

    row.append(k, v, del);
    wrap.append(row);
    autoGrow(v);
  }
}

// Height follows content. Reset to auto first, or the box can only ever
// grow — scrollHeight includes the height already set.
function autoGrow(node) {
  node.style.height = 'auto';
  node.style.height = `${node.scrollHeight}px`;
}

function readCardFields() {
  const out = {};
  for (const row of document.querySelectorAll('#card-fields .card-field')) {
    const k = row.querySelector('.cf-key').value.trim();
    if (!k) continue;                       // a nameless field is not a field
    out[k] = row.querySelector('.cf-value').value.trim();
  }
  return out;
}

function splitList(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean);
}

let _cardSaveTimer = null;
function scheduleCardSave() {
  setSyncState('dirty');
  clearTimeout(_cardSaveTimer);
  _cardSaveTimer = setTimeout(() => flushActiveCard(), SAVE_DEBOUNCE);
}

async function flushActiveCard() {
  clearTimeout(_cardSaveTimer);
  const c = App.activeCard;
  if (!c || $('card-edit').hidden) return;

  const next = {
    ...c,
    name:     $('card-name').value.trim() || 'Untitled',
    cardType: $('card-type').value,
    tags:     splitList($('card-tags').value),
    aka:      splitList($('card-aka').value),
    body:     $('card-body').value,
    fields:   readCardFields(),
  };

  // Same guard as scenes: don't bump updatedAt or queue a sync for a card
  // that was only looked at.
  const same = JSON.stringify(next) === JSON.stringify(c);
  if (same) { refreshSyncState(); return; }

  await RecordStore.put('card', c.id, next);
  invalidateCardIndex();          // name or aka may have changed
  App.activeCard = { ...next };
  App.lastCardType = next.cardType;
  await renderCards();
  refreshSyncState();
}

// ══ Card images ════════════════════════════════════════════════════
//
// A portrait, a map, a photograph of a place. Stored as a blob in
// IndexedDB and mirrored to R2 through the worker's /blob routes — the
// last part of the backend that had been built and never called.
//
// DOWNSCALED ON THE WAY IN. A phone photo is three to six megabytes;
// a card portrait needs a few hundred kilobytes at most. Uploading the
// original would mean slow syncs, a fat R2 bill eventually, and a
// mobile client pulling megabytes to show a thumbnail. The resize
// happens client-side before anything is stored, so the large version
// never exists anywhere.

const IMG_MAX = 1200;        // longest edge, px
const IMG_QUALITY = 0.82;    // JPEG quality after resize

/**
 * shrinkImage(file) → Blob
 *
 * Canvas downscale. Transparency is preserved by keeping PNGs as PNG;
 * everything else becomes JPEG, which is dramatically smaller for
 * photographs and is what most of these will be.
 */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMG_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const png = file.type === 'image/png';
  return await new Promise(res =>
    canvas.toBlob(res, png ? 'image/png' : 'image/jpeg', png ? undefined : IMG_QUALITY));
}

function blobKeyFor(cardId) { return `img/${cardId}`; }

async function setCardImage(cardId, file) {
  if (!file.type.startsWith('image/')) {
    showToast('That is not an image.');
    return;
  }

  showToast('Adding image…');
  let blob;
  try { blob = await shrinkImage(file); }
  catch (e) { console.error(e); showToast('Could not read that image.'); return; }

  await RecordStore.putImage(cardId, blob);

  const rec = await RecordStore.get('card', cardId);
  if (rec) await RecordStore.put('card', cardId, { ...rec, imageKey: blobKeyFor(cardId) });
  App.activeCard = await RecordStore.get('card', cardId);

  await paintCardImage(cardId);
  await renderCards();
  refreshSyncState();

  // Upload after the local write. The image is already usable; the
  // mirror is for other devices and can fail without costing anything
  // here.
  if (!Auth.isGuest() && App.data.workerUrl) {
    const ok = await Sync.putBlob(blobKeyFor(cardId), blob, blob.type);
    if (!ok) showToast('Image saved here, but not uploaded yet.', 5000);
  }
}

async function removeCardImage(cardId) {
  await RecordStore.deleteImage(cardId);
  const rec = await RecordStore.get('card', cardId);
  if (rec) await RecordStore.put('card', cardId, { ...rec, imageKey: null });
  App.activeCard = await RecordStore.get('card', cardId);
  await paintCardImage(cardId);
  await renderCards();
  if (!Auth.isGuest() && App.data.workerUrl) Sync.deleteBlob(blobKeyFor(cardId));
}

// Object URLs are revoked when replaced, or they accumulate for the
// life of the session — one leak per card you look at.
let _cardImgUrl = null;

async function paintCardImage(cardId) {
  const wrap = $('card-image');
  const img = $('card-img');
  const btn = $('btn-card-image');

  if (_cardImgUrl) { URL.revokeObjectURL(_cardImgUrl); _cardImgUrl = null; }

  let blob = await RecordStore.getImage(cardId);

  // Not here but recorded on the card: another device uploaded it.
  // Fetch once and keep it locally.
  if (!blob && App.activeCard?.imageKey && !Auth.isGuest() && App.data.workerUrl) {
    blob = await Sync.getBlob(App.activeCard.imageKey);
    if (blob) await RecordStore.putImage(cardId, blob);
  }

  if (!blob) {
    wrap.hidden = true;
    img.removeAttribute('src');
    btn.textContent = 'Add an image';
    return;
  }

  _cardImgUrl = URL.createObjectURL(blob);
  img.src = _cardImgUrl;
  wrap.hidden = false;
  btn.textContent = 'Replace image';
}

// ══ Events ═════════════════════════════════════════════════════════
//
// Peer records to cards, NOT properties of scenes. Born, married,
// divorced, died — most of a life happens offscreen and will never appear
// in the manuscript. Hanging events off scenes makes all of that
// unrepresentable, which is the flaw in every "tag your scenes with a
// date" implementation.
//
// ── DATES ──────────────────────────────────────────────────────────
// start/end are ISO 8601 STRINGS with a precision, not Date objects:
//
//   1892                 year     renders as a band across the year
//   1892-04              month
//   1892-04-17           day
//   1892-04-17T09:30     minute   renders as a point
//
// Three reasons for strings over timestamps:
//   1. ISO sorts lexically in chronological order, so ordering needs no
//      parsing and partial dates sort correctly against full ones.
//   2. Precision is preserved. "Married sometime in 1892" stays vague
//      instead of being silently promoted to 1 January.
//   3. BCE works via the leading-minus form (-0450) without fighting
//      JavaScript's Date, which handles year 0 and negatives badly.
//
// Precision is DERIVED from what you typed rather than asked for
// separately — a dropdown next to a date field is a question the text
// already answered.

const EVENT_KIND_MARK = {
  birth: '\u2217', death: '\u2020', marriage: '\u221E', divorce: '\u2260',
  meeting: '\u00B7', conflict: '\u2694', journey: '\u2192',
  discovery: '\u25C7', other: '\u00B7',
};

const ISO_SHAPES = [
  [/^-?\d{4}$/,                              'year'],
  [/^-?\d{4}-\d{2}$/,                        'month'],
  [/^-?\d{4}-\d{2}-\d{2}$/,                  'day'],
  [/^-?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/,   'minute'],
];

// parseWhen(text) → { iso, precision } | null
// Accepts the ISO shapes above plus a few things people actually type.
function parseWhen(text) {
  const t = (text || '').trim().replace(' ', 'T');
  if (!t) return null;
  for (const [re, precision] of ISO_SHAPES) {
    if (re.test(t)) return { iso: t, precision };
  }
  // "17 April 1892" / "April 1892" / "4/17/1892" — convenience only.
  const d = new Date(t);
  if (!isNaN(d)) {
    const y = String(d.getFullYear()).padStart(4, '0');
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return { iso: `${y}-${m}-${day}`, precision: 'day' };
  }
  return null;
}

// formatWhen(iso, precision) — display at the precision given, never more.
// Showing "1 January 1892" for a date recorded as "1892" invents detail
// the author did not supply.
function formatWhen(iso, precision) {
  if (!iso) return 'undated';
  const neg = iso.startsWith('-');
  const [datePart, timePart] = iso.replace(/^-/, '').split('T');
  const [y, m, d] = datePart.split('-');
  const era = neg ? ' BCE' : '';
  const MONTHS = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const month = MONTHS[Number(m) - 1] || '';

  if (precision === 'year'  || !m) return `${Number(y)}${era}`;
  if (precision === 'month' || !d) return `${month} ${Number(y)}${era}`;
  if (precision === 'minute' && timePart) return `${Number(d)} ${month} ${Number(y)}${era}, ${timePart}`;
  return `${Number(d)} ${month} ${Number(y)}${era}`;
}

// ── Rail ───────────────────────────────────────────────────────────

// Filter state. Per-device and per-session: which slice of the timeline
// you're looking at is a reading position, not a fact about the book.
const evFilter = { who: '', where: 'all', kind: null };

function eventMatches(e) {
  if (evFilter.kind && (e.kind || 'other') !== evFilter.kind) return false;
  if (evFilter.who && !(e.participants || []).includes(evFilter.who)) return false;
  if (evFilter.where === 'shown' && !e.sceneRef) return false;
  if (evFilter.where === 'off'   &&  e.sceneRef) return false;
  return true;
}

// Small colour chip beside the Kind select, so the editor agrees with
// the timeline and the rail about what this event looks like.
function paintKindCue() {
  const cue = $('ev-kind-cue');
  if (cue) cue.style.background = `var(--k-${$('ev-kind').value || 'other'})`;
}

async function renderEvents() {
  const list = $('event-list');
  list.replaceChildren();
  await fillEventFilter();

  const all = Object.values(await RecordStore.getAll('event'));
  const events = all.filter(eventMatches);

  if (!all.length) {
    list.append(el('p', 'rail-hint',
      'No events yet. Births, deaths, marriages, first meetings \u2014 ' +
      'including the ones that never appear on the page.'));
    list.append(addEventLink());
    return;
  }

  if (!events.length) {
    list.append(el('p', 'rail-hint',
      evFilter.kind ? `No ${evFilter.kind} events match.` : 'Nothing matches that filter.'));
    list.append(addEventLink());
    return;
  }

  // Undated events go last rather than being hidden: an event you haven't
  // dated yet is still an event, and burying it guarantees it stays undated.
  const dated   = events.filter(e => e.start)
                        .sort((x, y) => String(x.start).localeCompare(String(y.start)));
  const undated = events.filter(e => !e.start);

  let lastYear = null;
  for (const e of dated) {
    const year = String(e.start).replace(/^-/, '').slice(0, 4);
    if (year !== lastYear) {
      lastYear = year;
      list.append(el('div', 'toc-group-label ev-year',
        String(e.start).startsWith('-') ? `${Number(year)} BCE` : String(Number(year))));
    }
    list.append(eventRow(e));
  }

  if (undated.length) {
    list.append(el('div', 'toc-group-label', 'Undated'));
    for (const e of undated) list.append(eventRow(e));
  }

  if (events.length !== all.length) {
    list.append(el('p', 'rail-hint',
      `Showing ${events.length} of ${all.length}.`));
  }
  list.append(addEventLink());
}

function addEventLink() {
  const add = el('button', 'toc-add', '+ event');
  add.addEventListener('click', () => newEvent());
  return add;
}

// Only people who actually appear in an event are offered. A filter list
// of every card in the book, most of which would return nothing, is a
// list of dead ends.
async function fillEventFilter() {
  const sel = $('ev-filter-who');
  const cards = await RecordStore.getAll('card');
  const used = new Set();
  for (const e of Object.values(await RecordStore.getAll('event')))
    for (const id of e.participants || []) used.add(id);

  const keep = sel.value;
  sel.replaceChildren();
  sel.append(new Option('Everyone', ''));
  [...used]
    .map(id => cards[id])
    .filter(Boolean)
    .sort((x, y) => (x.name || '').localeCompare(y.name || ''))
    .forEach(c => sel.append(new Option(c.name, c.id)));
  sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
  evFilter.who = sel.value;
}

function eventRow(e) {
  const row = tocLine('button', {
    className: 'toc-scene ev-row',
    kind: 'event', id: e.id,
    title: e.title,
    figure: e.start ? formatWhen(e.start, e.precision).replace(/^\d+ /, '') : null,
    current: App.activeEvent?.id === e.id,
    onOpen: () => { openEvent(e.id); if (App.readOnly) closeRail(); },
  });
  const kind = e.kind || 'other';
  const mark = el('span', 'ev-mark', EVENT_KIND_MARK[kind] || '\u00B7');
  // Same colour as the dot on the timeline, so the rail and the chart
  // read as one thing rather than two lists that happen to agree.
  mark.style.color = `var(--k-${kind})`;
  mark.title = kind;
  row.prepend(mark);
  return row;
}

async function newEvent() {
  const title = await askName('New event', 'What happened');
  if (!title) return;
  const id = await RecordStore.createEvent({ title });
  if (!id) return;
  await renderEvents();
  openEvent(id);
}

// ── Writing aids ───────────────────────────────────────────────────
//
// CodeMirror is a code editor, and it deliberately switches off
// everything a browser does to help with prose: it sets spellcheck,
// autocorrect and autocapitalize to "off" on its input. Sensible for
// code, wrong for a novel — on a phone it meant no capital letter
// after a full stop.
//
// Both are toggleable because both have a real cost here: spell check
// flags every name in the book until you teach the dictionary, and a
// phone's autocorrect will happily "fix" callsigns and surnames.

function applyWritingAids() {
  const cm = App.editor?.codemirror;
  if (!cm) return;
  const input = cm.getInputField();
  const t = App.typography || {};
  const spell = t.spellcheck !== false;
  const assist = t.autocorrect !== false;

  input.setAttribute('spellcheck', String(spell));
  // "sentences" rather than "on": capitalise after a full stop, not
  // every word.
  input.setAttribute('autocapitalize', assist ? 'sentences' : 'off');
  input.setAttribute('autocorrect', assist ? 'on' : 'off');
  // The attribute alone doesn't make an existing surface re-check.
  cm.refresh();
}

// ── Editor ─────────────────────────────────────────────────────────

async function openEvent(id) {
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  const e = await RecordStore.get('event', id);
  if (!e) { showToast('That event is gone.'); return renderEvents(); }

  App.activeEvent = e;
  App.activeScene = null;
  App.activeCard = null;
  App.view = 'edit';

  for (const h of ['readview', 'empty', 'scene', 'card-edit', 'timeline-wrap',
                   'grid-wrap', 'board-wrap', 'map-wrap', 'plan-wrap']) $(h).hidden = true;
  $('event-edit').hidden = false;
  $('btn-read').setAttribute('aria-pressed', 'false');

  $('ev-title').value    = e.title || '';
  $('ev-kind').value     = e.kind || 'other';
  paintKindCue();
  $('ev-start').value    = e.start || '';
  $('ev-end').value      = e.end || '';
  $('ev-location').value = e.location || '';
  $('ev-body').value     = e.body || '';
  autoGrow($('ev-body'));

  await fillSceneOptions(e.sceneRef);
  await renderParticipants(e.participants || []);
  updateWhenHint();

  $('tally').textContent = '';
  renderEvents();
  $('sheet').scrollTop = 0;
}

// Live feedback on what the app understood, so a mistyped date is visible
// immediately rather than silently sorting to the wrong place.
function updateWhenHint() {
  const parsed = parseWhen($('ev-start').value);
  const hint = $('ev-when-hint');
  if (!$('ev-start').value.trim()) {
    hint.textContent = 'Year, month, or full date — 1892, 1892-04, 1892-04-17.';
    hint.classList.remove('bad');
  } else if (!parsed) {
    hint.textContent = 'Not a date I can read. Try 1892, 1892-04, or 1892-04-17.';
    hint.classList.add('bad');
  } else {
    hint.textContent = `Reads as ${formatWhen(parsed.iso, parsed.precision)}.`;
    hint.classList.remove('bad');
  }
}

async function fillSceneOptions(selected) {
  const sel = $('ev-scene');
  sel.replaceChildren();
  sel.append(new Option('Offscreen', ''));
  const tree = App.tree || await RecordStore.getTree();
  const push = (sc, chapter) =>
    sel.append(new Option(chapter ? `${chapter} — ${sc.title}` : sc.title, sc.id));
  for (const ch of RecordStore.allChapters(tree)) ch.scenes.forEach(s => push(s, ch.title));
  tree.unfiled.forEach(s => push(s, null));
  sel.value = selected || '';
}

// Participants are card ids, not names. A rename then costs nothing, and
// "which events involve this person" becomes a lookup instead of a search.
async function renderParticipants(ids) {
  const wrap = $('ev-participants');
  wrap.replaceChildren();
  const cards = await RecordStore.getAll('card');

  for (const id of ids) {
    const c = cards[id];
    const chip = el('span', 'ev-chip', c ? c.name : 'unknown');
    if (!c) chip.classList.add('missing');
    const x = el('button', 'ev-chip-x', '\u00D7');
    x.type = 'button';
    x.setAttribute('aria-label', `Remove ${c ? c.name : 'participant'}`);
    x.addEventListener('click', () => { chip.remove(); flushActiveEvent(); });
    chip.dataset.id = id;
    chip.append(x);
    wrap.append(chip);
  }

  const sel = $('ev-add-participant');
  sel.replaceChildren();
  sel.append(new Option('+ add someone', ''));
  const available = Object.values(cards)
    .filter(c => !ids.includes(c.id))
    .sort((x, y) => (x.name || '').localeCompare(y.name || ''));
  for (const c of available) sel.append(new Option(c.name, c.id));
  sel.disabled = !available.length;
}

function readParticipants() {
  return [...document.querySelectorAll('#ev-participants .ev-chip')].map(c => c.dataset.id);
}

let _evSaveTimer = null;
function scheduleEventSave() {
  setSyncState('dirty');
  clearTimeout(_evSaveTimer);
  _evSaveTimer = setTimeout(() => flushActiveEvent(), SAVE_DEBOUNCE);
}

async function flushActiveEvent() {
  clearTimeout(_evSaveTimer);
  const e = App.activeEvent;
  if (!e || $('event-edit').hidden) return;

  const startRaw = $('ev-start').value.trim();
  const endRaw   = $('ev-end').value.trim();
  const start = parseWhen(startRaw);
  const end   = parseWhen(endRaw);

  const next = {
    ...e,
    title: $('ev-title').value.trim() || 'Untitled event',
    kind:  $('ev-kind').value,
    // Keep the raw text when it doesn't parse. Discarding what someone
    // typed because the app couldn't read it is how you lose a date
    // nobody notices is gone.
    start: start ? start.iso : startRaw,
    end:   end ? end.iso : (endRaw || null),
    precision: start ? start.precision : (e.precision || 'day'),
    participants: readParticipants(),
    location: $('ev-location').value.trim(),
    sceneRef: $('ev-scene').value || null,
    body: $('ev-body').value,
  };

  if (JSON.stringify(next) === JSON.stringify(e)) { refreshSyncState(); return; }

  await RecordStore.put('event', e.id, next);
  App.activeEvent = { ...next };
  await renderEvents();
  refreshSyncState();
}

/**
 * applySignIn() — hand the whole UI over to a different account.
 *
 * Signing in is not a data refresh; it's a change of subject. Everything
 * pointing at the previous account has to let go first, or the editor
 * keeps showing text from an account you are no longer in, and the
 * remembered open scene may not exist here at all.
 *
 * eraseLocal comes from the "discard my guest notes" choice in the auth
 * wizard. It has to clear the DIRTY SET as well as the records: the dirty
 * set names ids belonging to the account being left, and flushing it
 * afterwards would write one account's manuscript into another's keys.
 */
async function applySignIn(data, isNew, { eraseLocal } = {}) {
  // 1. Stop editing. No flush — those writes belong to the old account.
  clearTimeout(_saveTimer);
  clearTimeout(_cardSaveTimer);
  clearTimeout(_evSaveTimer);
  App.activeScene = null;
  App.activeCard  = null;
  App.activeEvent = null;
  App.readReturn  = null;
  App._migrationPrompted = false;
  App.view = 'edit';
  for (const id of ['scene', 'card-edit', 'event-edit', 'readview']) $(id).hidden = true;
  if (App.editor) { App.editor.value(''); App.editor.codemirror.clearHistory(); }

  // 2. Adopt the new account.
  App.data = mergeData(data);
  saveLocal();

  if (eraseLocal) {
    await RecordStore.clear();
    await Sync.resetDirty();
  }

  applyTypewriterMode(App.data.typewriter);
  loadAuthorFields();

  // 3. Fetch. A brand-new account has nothing upstream; an existing one
  //    may be arriving on a device that has never seen this manuscript.
  if (!isNew) await Sync.freshDeviceSync();
  if (!Auth.isGuest() && App.data.workerUrl) Sync.start();

  // 4. Redraw everything, not just the tree — the rail may be showing
  //    cards or events, and those changed too. The project has to be
  //    re-established first: the account that just arrived may name one
  //    this device has never seen.
  await openLastProject();

  const active = place().openSceneId;
  if (active && await RecordStore.get('scene', active)) await openScene(active);
  else showEmpty();

  refreshSyncState();
}

// ══ Wikilinks in the editor ════════════════════════════════════════
//
// Three pieces, deliberately small:
//   1. An overlay mode that colours [[...]] without touching EasyMDE's
//      own markdown mode.
//   2. An autocomplete popup driven by keydown, offering cards as you
//      type after [[.
//   3. Ctrl/Cmd-click to open the card a link points at.
//
// This is the fiddliest surface in the app because it sits inside the
// thing you actually write in. It is kept minimal on purpose: no
// inline previews, no auto-replacement, nothing that rewrites what you
// typed while you are typing it.

// The store owns the cache now — a second copy here was the thing
// that went stale, because only some paths knew to clear it.
function invalidateCardIndex() { RecordStore.invalidateCards(); }
async function cardIndex() { return RecordStore.buildCardIndex(); }

// A CodeMirror overlay: runs alongside the markdown mode rather than
// replacing it, so bold and headings still highlight normally.
// Unresolved links get a different class — a link to a card that doesn't
// exist should look wrong on the page, not silently like any other.
function wikilinkOverlay(index) {
  return {
    token(stream) {
      if (stream.match(/\[\[/)) {
        const start = stream.pos;
        if (stream.skipTo(']]')) {
          const inner = stream.string.slice(start, stream.pos);
          stream.match(/\]\]/);
          const target = inner.split('|')[0].trim().toLowerCase();
          return index.has(target) ? 'wikilink' : 'wikilink-unknown';
        }
        // No closing ]] yet — you're mid-typing. Mark the two brackets
        // and stop. skipToEnd() here painted the whole rest of the
        // paragraph, because a paragraph is ONE logical line to
        // CodeMirror: every wrapped row lit up until the link closed.
        return 'wikilink-open';
      }
      // Advance to the next candidate rather than one char at a time.
      while (stream.next() != null && !stream.match(/\[\[/, false)) {}
      return null;
    },
  };
}

// ── Conceal ────────────────────────────────────────────────────────
//
// Hide the machinery of a link and show only the words. [[Angel Six|
// Angel]] reads as "Angel", tinted, exactly as it will on the page —
// the target is something you chose, not something you need to keep
// re-reading.
//
// The link reveals itself whenever the caret is inside it, so editing
// one is never a matter of guessing what you're editing. Marks are
// atomic, so arrow keys step over a concealed bracket pair rather than
// into the middle of it.

function concealWikilinks(cm) {
  for (const m of cm._wlMarks || []) m.clear();
  cm._wlMarks = [];

  // Only reveal for a caret that's actually being used. An editor
  // without focus has no meaningful caret — it's wherever you last left
  // it — and honouring it meant a link stayed expanded after you
  // followed it and came back, because following it put the caret
  // inside.
  const cur = cm.hasFocus() ? cm.getCursor() : null;
  const doc = cm.getValue().split('\n');

  doc.forEach((line, ln) => {
    for (const m of line.matchAll(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g)) {
      const start = m.index;
      const end = start + m[0].length;

      // Caret inside (or touching) this link — show it in full so it
      // can be edited.
      if (cur && cur.line === ln && cur.ch >= start && cur.ch <= end) continue;

      // Everything up to and including the pipe, or just the opening
      // brackets when there is no pipe.
      const headLen = m[2] !== undefined ? 2 + m[1].length + 1 : 2;

      cm._wlMarks.push(cm.markText(
        { line: ln, ch: start }, { line: ln, ch: start + headLen },
        { collapsed: true, atomic: true }));
      cm._wlMarks.push(cm.markText(
        { line: ln, ch: end - 2 }, { line: ln, ch: end },
        { collapsed: true, atomic: true }));
    }
  });
}

async function refreshWikilinkOverlay() {
  const cm = App.editor?.codemirror;
  if (!cm) return;
  const index = await cardIndex();
  if (cm._wlOverlay) cm.removeOverlay(cm._wlOverlay);
  cm._wlOverlay = wikilinkOverlay(index);
  cm.addOverlay(cm._wlOverlay);
  concealWikilinks(cm);
}

// ── Autocomplete ───────────────────────────────────────────────────

let _acBox = null, _acItems = [], _acIndex = 0, _acFrom = null;

// Two ways to make a link, and the popup serves both.
//
//   'type'  you typed [[ and are choosing a card. The card's name goes
//           into the prose.
//   'wrap'  you selected words and pressed [. The PROSE IS UNTOUCHED;
//           the chosen card becomes the link target behind it, using
//           [[Target|your words]]. "Angel's" stays "Angel's" and still
//           points at Angel Six.
let _acMode = 'type', _acWrap = null;

function closeAutocomplete() {
  _acBox?.remove();
  _acBox = null;
  _acItems = [];
  _acFrom = null;
  _acMode = 'type';
  _acWrap = null;
}

// Look back from the caret for an unclosed [[ on this line. Returns the
// partial text typed after it, or null.
function wikilinkContext(cm) {
  const cur = cm.getCursor();
  const line = cm.getLine(cur.line).slice(0, cur.ch);
  const open = line.lastIndexOf('[[');
  if (open === -1) return null;
  if (line.slice(open).includes(']]')) return null;
  return { from: { line: cur.line, ch: open + 2 }, query: line.slice(open + 2) };
}

async function updateAutocomplete(forcedQuery = null) {
  const cm = App.editor?.codemirror;
  if (!cm) return closeAutocomplete();

  let q;
  if (forcedQuery !== null) {
    q = forcedQuery.trim().toLowerCase();
  } else {
    const ctx = wikilinkContext(cm);
    if (!ctx) return closeAutocomplete();
    _acFrom = ctx.from;
    q = ctx.query.trim().toLowerCase();
  }
  const cards = Object.values(await RecordStore.getAll('card'));

  // Name matches before alias matches, prefix before substring — the
  // thing you most likely meant should not be third in the list.
  const scored = [];
  for (const c of cards) {
    const name = (c.name || '').toLowerCase();
    const aliases = (c.aka || []).map(x => (x || '').toLowerCase());
    let rank = null, via = null;
    if (!q) rank = 3;
    else if (name.startsWith(q)) rank = 0;
    else if (aliases.some(x => x.startsWith(q))) { rank = 1; via = (c.aka || [])[aliases.findIndex(x => x.startsWith(q))]; }
    else if (name.includes(q)) rank = 2;
    else if (aliases.some(x => x.includes(q))) { rank = 3; via = (c.aka || [])[aliases.findIndex(x => x.includes(q))]; }
    if (rank !== null) scored.push({ card: c, rank, via });
  }
  scored.sort((x, y) => x.rank - y.rank || (x.card.name || '').localeCompare(y.card.name || ''));

  // In wrap mode an exact hit isn't required — the words you selected
  // ("Angel's") often won't match any card name, and the whole point is
  // to pick the target yourself. So fall back to the full list.
  if (!scored.length && _acMode === 'wrap') {
    for (const c of cards) scored.push({ card: c, rank: 9, via: null });
    scored.sort((x, y) => (x.card.name || '').localeCompare(y.card.name || ''));
  }

  _acItems = scored.slice(0, 8);
  _acIndex = 0;
  if (!_acItems.length) return closeAutocomplete();
  drawAutocomplete(cm);
}

function drawAutocomplete(cm) {
  if (!_acBox) {
    _acBox = el('div', 'wl-complete');
    document.body.append(_acBox);
  }
  _acBox.dataset.mode = _acMode;
  if (_acMode === 'wrap') _acBox.dataset.text = _acWrap?.text || '';
  _acBox.replaceChildren();

  _acItems.forEach((it, i) => {
    const row = el('div', 'wl-item' + (i === _acIndex ? ' on' : ''));
    row.append(el('span', 'wl-name', it.card.name));
    // Show WHICH alias matched, so picking the right one of two similar
    // characters doesn't require opening both.
    if (it.via) row.append(el('span', 'wl-via', it.via));
    row.append(el('span', 'wl-kind', it.card.cardType));
    row.addEventListener('mousedown', e => { e.preventDefault(); acceptAutocomplete(cm, i); });
    _acBox.append(row);
  });

  positionAutocomplete(cm);
}

/**
 * positionAutocomplete(cm) — place the list near the caret, in the
 * viewport.
 *
 * Two things this has to get right. It flips ABOVE the caret when
 * there isn't room below, instead of running off the bottom of the
 * window where the last options can't be reached. And it re-runs on
 * scroll: the box is position:fixed but the caret is not, so a
 * scrolling sheet leaves the list stranded over unrelated text.
 */
function positionAutocomplete(cm) {
  if (!_acBox) return;
  const anchor = _acMode === 'wrap' && _acWrap ? _acWrap.to : true;
  const co = cm.cursorCoords(anchor, 'window');

  const gap = 6;
  const h = _acBox.offsetHeight;
  const w = _acBox.offsetWidth;

  const below = window.innerHeight - co.bottom - gap;
  const above = co.top - gap;
  // Prefer below, but only if the whole list fits — a half-visible
  // list is worse than one that opened the other way.
  const flip = below < h && above > below;

  _acBox.style.top = flip
    ? `${Math.max(8, co.top - gap - h)}px`
    : `${Math.min(co.bottom + gap, window.innerHeight - h - 8)}px`;
  _acBox.style.left = `${Math.max(8, Math.min(co.left, window.innerWidth - w - 8))}px`;
}

function acceptAutocomplete(cm, i = _acIndex) {
  const item = _acItems[i];
  if (!item) return closeAutocomplete();

  if (_acMode === 'wrap' && _acWrap) {
    const { from, to, text } = _acWrap;
    // Use the pipe form only when the words differ from the card name —
    // [[Angel Six|Angel Six]] is noise.
    const same = text.trim().toLowerCase() === (item.card.name || '').toLowerCase();
    const out = same ? `[[${text}]]` : `[[${item.card.name}|${text}]]`;
    cm.replaceRange(out, from, to);
    cm.setCursor({ line: to.line, ch: from.ch + out.length });
    closeAutocomplete();
    refreshWikilinkOverlay();
    return;
  }

  if (!_acFrom) return closeAutocomplete();
  const cur = cm.getCursor();
  const rest = cm.getLine(cur.line).slice(cur.ch);
  const closing = rest.startsWith(']]') ? '' : ']]';
  cm.replaceRange(item.card.name + closing, _acFrom, cur);
  closeAutocomplete();
  refreshWikilinkOverlay();
}

function autocompleteKey(cm, e) {
  if (!_acBox || !_acItems.length) return false;
  if (e.key === 'ArrowDown') { _acIndex = (_acIndex + 1) % _acItems.length; drawAutocomplete(cm); return true; }
  if (e.key === 'ArrowUp')   { _acIndex = (_acIndex - 1 + _acItems.length) % _acItems.length; drawAutocomplete(cm); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { acceptAutocomplete(cm); return true; }
  if (e.key === 'Escape') { closeAutocomplete(); return true; }
  return false;
}

// ── Card preview on hover ──────────────────────────────────────────
//
// The point of a link is that you don't have to leave the sentence to
// remember who someone is. Following it opens the card and loses your
// place; a preview answers the small question — what's her rank, when
// was she born, which faction — without moving.
//
// Deliberately partial: the first few filled fields, not the whole
// card. A tooltip that shows everything is a card, and you already
// have one of those a click away.

let _cardTip = null, _cardTipFor = null, _cardTipTimer = null, _cardTipUrl = null;
const CARD_TIP_DELAY = 350;   // long enough not to fire while reading

function hideCardTip() {
  clearTimeout(_cardTipTimer);
  _cardTipFor = null;
  if (_cardTipUrl) { URL.revokeObjectURL(_cardTipUrl); _cardTipUrl = null; }
  if (_cardTip) _cardTip.hidden = true;
}

function scheduleCardTip(target, x, y) {
  if (!target) return hideCardTip();
  if (target === _cardTipFor && _cardTip && !_cardTip.hidden) {
    return placeCardTip(x, y);
  }
  clearTimeout(_cardTipTimer);
  _cardTipFor = target;
  _cardTipTimer = setTimeout(() => showCardTip(target, x, y), CARD_TIP_DELAY);
}

async function showCardTip(target, x, y) {
  const card = await RecordStore.resolveLink(target);
  if (_cardTipFor !== target) return;        // pointer moved on while we waited

  if (!_cardTip) {
    _cardTip = el('div', 'card-tip');
    document.body.append(_cardTip);
  }
  _cardTip.replaceChildren();

  if (!card) {
    _cardTip.append(el('div', 'ct-unknown', `No card called “${target}”.`));
    _cardTip.append(el('div', 'ct-hint', 'Ctrl-click to create one.'));
  } else {
    _cardTip.style.setProperty('--k', `var(--c-${card.cardType || 'research'})`);

    const head = el('div', 'ct-head');
    head.append(el('span', 'ct-name', card.name || 'Untitled'));
    head.append(el('span', 'ct-type', card.cardType || ''));
    _cardTip.append(head);

    // The name you wrote, when it isn't the card's own — so a callsign
    // or a nickname is visibly the same person.
    if ((card.name || '').toLowerCase() !== target.toLowerCase()) {
      _cardTip.append(el('div', 'ct-alias', `written as “${target}”`));
    }

    const img = await RecordStore.getImage(card.id);
    if (img) {
      _cardTipUrl = URL.createObjectURL(img);
      const el_ = el('img', 'ct-img');
      el_.src = _cardTipUrl;
      el_.alt = '';
      _cardTip.append(el_);
    }

    const filled = Object.entries(card.fields || {}).filter(([, v]) => (v || '').trim());
    for (const [k, v] of filled.slice(0, 4)) {
      const r = el('div', 'ct-row');
      r.append(el('span', 'ct-k', k));
      r.append(el('span', 'ct-v', v));
      _cardTip.append(r);
    }
    if (filled.length > 4) {
      _cardTip.append(el('div', 'ct-hint', `+${filled.length - 4} more`));
    }
    if (!filled.length && (card.body || '').trim()) {
      const n = el('div', 'ct-note', card.body.trim().slice(0, 180));
      _cardTip.append(n);
    }
  }

  _cardTip.hidden = false;
  placeCardTip(x, y);
}

function placeCardTip(x, y) {
  if (!_cardTip || _cardTip.hidden) return;
  const pad = 14;
  const w = _cardTip.offsetWidth, h = _cardTip.offsetHeight;
  // Flip rather than overflow, same as the timeline tooltip.
  const left = x + pad + w > window.innerWidth ? x - pad - w : x + pad;
  const top  = y + pad + h > window.innerHeight ? y - pad - h : y + pad;
  _cardTip.style.left = `${Math.max(8, left)}px`;
  _cardTip.style.top  = `${Math.max(8, top)}px`;
}

// ── Following a link ───────────────────────────────────────────────

// The [[target]] under a position, if any.
function linkAt(cm, pos) {
  const line = cm.getLine(pos.line) || '';
  for (const m of line.matchAll(/\[\[([^\[\]|]+)(?:\|[^\[\]]+)?\]\]/g)) {
    if (pos.ch >= m.index && pos.ch <= m.index + m[0].length) return m[1].trim();
  }
  return null;
}

async function followLink(target) {
  const card = await RecordStore.resolveLink(target);
  if (card) { railSection('cards'); return openCard(card.id); }

  // An unresolved link is usually a character you meant to write up.
  // Offer to create it rather than just reporting a dead end.
  const make = await askChoice(`No card called "${target}".`,
    RecordStore.CARD_TYPES.map(t => ({ label: `Create a ${CARD_TYPE_SINGULAR[t]}`, value: t })));
  if (!make) return;
  const id = await RecordStore.createCard(make, target);
  if (!id) return;
  const rec = await RecordStore.get('card', id);
  await RecordStore.put('card', id, { ...rec, fields: startersFor(make) });
  invalidateCardIndex();
  await refreshWikilinkOverlay();
  railSection('cards');
  openCard(id);
}

/**
 * renderAppearances(cardId) — which scenes link to this card.
 *
 * Derived from the prose, not maintained by hand. This is the thing
 * neither Scrivener nor Manuskript can do: full-text search misses
 * pronouns, nicknames, and scenes where someone is discussed but
 * absent, while a [[link]] is an explicit statement that this scene is
 * about this person.
 */
async function renderAppearances(cardId) {
  const wrap = $('card-appears');
  wrap.replaceChildren();

  const { byCard } = await RecordStore.linkGraph();
  const hits = byCard[cardId] || [];
  if (!hits.length) {
    wrap.append(el('p', 'note',
      'Not linked from any scene yet. Write [[' +
      (App.activeCard?.name || 'name') + ']] in a scene to connect it.'));
    return;
  }

  const meta = Object.fromEntries(
    RecordStore.allChapters(App.tree).flatMap(ch =>
      ch.scenes.map(s => [s.id, `${ch.title} — ${s.title}`])));

  for (const { sceneId, count } of hits) {
    const b = el('button', 'appears-row');
    b.append(el('span', 'appears-title', meta[sceneId] || 'Unplaced scene'));
    if (count > 1) b.append(el('span', 'toc-figure', `\u00D7${count}`));
    b.addEventListener('click', () => { railSection('manuscript'); openScene(sceneId); });
    wrap.append(b);
  }
}

// ══ Import ═════════════════════════════════════════════════════════
//
// Restores from the zip that Download backup produces. The zip's
// recension-backup.json is the restorable copy — the .md files inside
// it are for humans and deliberately lossy (no ids, no ordering, no
// cards or events).
//
// A plain .json export is accepted too, for anyone who pulled just that
// file out of the zip.

async function readBackupFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());

  if (file.name.toLowerCase().endsWith('.json')) {
    return JSON.parse(new TextDecoder().decode(buf));
  }

  const entries = fflate.unzipSync(buf);
  const key = Object.keys(entries).find(k => k.endsWith('recension-backup.json'));
  if (!key) {
    throw new Error('No recension-backup.json in that zip. The .md files ' +
                    'alone cannot be restored — they carry no ids or ordering.');
  }
  const data = JSON.parse(new TextDecoder().decode(entries[key]));

  // Card images ride in the zip as real files, keyed by card id.
  data._images = {};
  for (const [name, bytes] of Object.entries(entries)) {
    const m = name.match(/(?:^|\/)images\/([^/]+)\.(png|jpg)$/);
    if (!m) continue;
    data._images[m[1]] = { bytes, type: m[2] === 'png' ? 'image/png' : 'image/jpeg' };
  }
  return data;
}

function describeBackup(data) {
  const r = data?.records || {};
  const count = t => Object.keys(r[t] || {}).length;
  const when = data?.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'unknown date';
  const projects = Object.keys(r.projects || {}).length;
  const bits = [
    [projects, 'project'], [count('book'), 'book'], [count('part'), 'part'],
    [count('chapter'), 'chapter'], [count('scene'), 'scene'],
    [count('card'), 'card'], [count('event'), 'event'],
  ].filter(([n]) => n)
   .map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`);

  const words = Object.values(r.scene || {})
    .reduce((n, s) => n + (s.wordCount || 0), 0);
  const images = Object.keys(data?._images || {}).length;
  if (images) bits.push(`${images} image${images === 1 ? '' : 's'}`);

  return {
    when,
    summary: bits.join(', ') || 'nothing',
    words,
    ok: bits.length > 0,
  };
}

async function runImport(file) {
  let data;
  try {
    data = await readBackupFile(file);
  } catch (e) {
    showToast(e.message || 'Could not read that file.', 6000);
    return;
  }

  if (data?.format && data.format !== 'recension-backup') {
    showToast('That file is not a Recension backup.', 5000);
    return;
  }

  const info = describeBackup(data);
  if (!info.ok) { showToast('That backup contains no records.', 5000); return; }

  // Say plainly what each choice does to what's already here. "Import"
  // with no explanation is how people overwrite a manuscript.
  const mode = await askChoice(
    `Backup from ${info.when} — ${info.summary}` +
    (info.words ? `, ${info.words.toLocaleString()} words.` : '.'),
    [
      { label: 'Add what is missing — nothing here is changed', value: 'add' },
      { label: 'Replace everything on this device',             value: 'replace' },
    ]);
  if (!mode) return;

  if (mode === 'replace') {
    const sure = await askChoice(
      'Replace deletes every book, scene, card and event on this device first. This cannot be undone.',
      [{ label: 'Yes, replace everything', value: 'yes' }]);
    if (!sure) return;
  }

  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  showToast('Importing…');

  // A backup taken before projects existed has no projectId anywhere.
  // Those records would import successfully and then be invisible in
  // every view, because the migration only runs when NO project exists
  // — and by now one does. Adopt them into the project you're in.
  const adopted = { ...data.records };
  for (const type of ['book', 'card', 'event']) {
    if (!adopted[type]) continue;
    adopted[type] = Object.fromEntries(Object.entries(adopted[type]).map(([id, rec]) =>
      [id, rec.projectId ? rec : { ...rec, projectId: RecordStore.currentProject() }]));
  }

  const stats = await RecordStore.importRecords(adopted, { mode });

  // Author details ride along in the backup, but never clobber details
  // already filled in on this device.
  if (data.author && mode === 'replace') {
    App.data.author = { ...App.data.author, ...data.author };
    saveAccount();
    loadAuthorFields();
  }

  // Restore any images that travelled with the backup.
  if (data._images) {
    for (const [cardId, { bytes, type }] of Object.entries(data._images)) {
      if (mode !== 'replace' && await RecordStore.getImage(cardId)) continue;
      await RecordStore.putImage(cardId, new Blob([bytes], { type }));
    }
  }

  invalidateCardIndex();
  App.activeScene = App.activeCard = App.activeEvent = null;
  for (const id of ['scene', 'card-edit', 'event-edit', 'readview']) $(id).hidden = true;

  await railSection(App.section || 'manuscript');
  showEmpty();
  refreshSyncState();

  const parts = [];
  if (stats.added)   parts.push(`${stats.added} added`);
  if (stats.skipped) parts.push(`${stats.skipped} already here, left alone`);
  showToast(parts.length ? `Imported: ${parts.join(', ')}.` : 'Nothing to import.', 6000);
}

// ══ Timeline ═══════════════════════════════════════════════════════
//
// A lane per person, time across the page. This is the view that makes
// events worth being records: a character's lane shows their whole life
// at once — born, married, divorced, died — including everything that
// happens offscreen and will never appear in a scene.
//
// Drawn as inline SVG. No library: axis ticks, bars and dots are a few
// dozen lines of geometry, and a chart library would bring styling that
// fights the rest of the app.
//
// PRECISION IS HONOURED. An event recorded as "1892" draws as a band
// across that year, not a point on 1 January. Pretending to know the
// day is how a timeline starts lying to you.

// Fractional year, so a day-precision date sits in the right place
// within its year. Returns null for anything unparseable.
function toYear(iso) {
  if (!iso) return null;
  const neg = String(iso).startsWith('-');
  const [datePart] = String(iso).replace(/^-/, '').split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y && y !== 0) return null;
  const year = (neg ? -y : y) + ((m || 1) - 1) / 12 + ((d || 1) - 1) / 365;
  return year;
}

// How wide an event is in years, given its precision. A year-precision
// event covers its whole year; a minute-precision one is a point.
function spanYears(precision) {
  return { year: 1, month: 1 / 12, day: 1 / 365, minute: 0 }[precision] ?? 1 / 365;
}

const EVENT_KINDS = ['birth', 'death', 'marriage', 'divorce', 'meeting',
                     'conflict', 'journey', 'discovery', 'other'];

const TL = {
  laneH: 30, padTop: 34, padLeft: 150, padRight: 24, minPxPerYear: 8,
};

async function renderTimeline() {
  const host = $('timeline');
  host.replaceChildren();

  const [allEvents, cards] = await Promise.all([
    RecordStore.getAll('event'), RecordStore.getAll('card'),
  ]);
  const events = Object.values(allEvents).filter(eventMatches).filter(e => toYear(e.start) !== null);

  if (!events.length) {
    host.append(el('p', 'rv-empty',
      'Nothing dated to plot yet. Give an event a year and it appears here.'));
    return;
  }

  // ── Lanes: one per person who takes part, plus a catch-all ──
  // Sorted by first appearance, so the page reads chronologically
  // downward as well as rightward.
  const laneOf = new Map();
  for (const e of events) {
    const ids = (e.participants || []).filter(id => cards[id]);
    if (!ids.length) {
      // Events with nobody attached still belong on the page — a war
      // starting isn't about one person, and hiding it would make the
      // timeline quietly incomplete.
      if (!laneOf.has('~')) laneOf.set('~', []);
      laneOf.get('~').push(e);
      continue;
    }
    for (const id of ids) {
      if (!laneOf.has(id)) laneOf.set(id, []);
      laneOf.get(id).push(e);
    }
  }

  const lanes = [...laneOf.entries()]
    .map(([id, evs]) => ({
      id,
      name: id === '~' ? 'No one named' : cards[id].name,
      events: evs.sort((x, y) => toYear(x.start) - toYear(y.start)),
      first: Math.min(...evs.map(e => toYear(e.start))),
    }))
    .sort((a, b) => a.first - b.first);

  // ── Scale ──
  const years = events.map(e => toYear(e.start));
  const ends  = events.map(e => toYear(e.end) ?? toYear(e.start) + spanYears(e.precision));
  let minY = Math.floor(Math.min(...years));
  let maxY = Math.ceil(Math.max(...ends));
  if (maxY - minY < 2) maxY = minY + 2;           // a single year needs room
  const pad = Math.max(1, Math.round((maxY - minY) * 0.04));
  minY -= pad; maxY += pad;

  const avail = Math.max(520, host.clientWidth || 720);
  const pxPerYear = Math.max(TL.minPxPerYear * App.tlZoom,
                             (avail - TL.padLeft - TL.padRight) / (maxY - minY));
  const width  = TL.padLeft + TL.padRight + (maxY - minY) * pxPerYear;
  const height = TL.padTop + lanes.length * TL.laneH + 16;
  const x = yr => TL.padLeft + (yr - minY) * pxPerYear;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.classList.add('tl-svg');

  const mk = (tag, attrs, text) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };

  // ── Axis ──
  // Tick every 1, 2, 5, 10… years, whichever keeps labels from colliding.
  const target = 90;                                   // px between labels
  const raw = target / pxPerYear;
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]
    .find(s => s >= raw) || 1000;

  for (let yr = Math.ceil(minY / step) * step; yr <= maxY; yr += step) {
    svg.append(mk('line', {
      x1: x(yr), y1: TL.padTop - 12, x2: x(yr), y2: height - 8, class: 'tl-grid',
    }));
    svg.append(mk('text', {
      x: x(yr), y: TL.padTop - 18, class: 'tl-tick', 'text-anchor': 'middle',
    }, yr < 0 ? `${-yr} BCE` : String(yr)));
  }

  // ── Lanes ──
  const sceneTitle = Object.fromEntries(
    RecordStore.allChapters(App.tree || { works: [] }).flatMap(ch =>
      ch.scenes.map(s => [s.id, `${ch.title} — ${s.title}`])));

  lanes.forEach((lane, i) => {
    const y = TL.padTop + i * TL.laneH + TL.laneH / 2;

    // A banded background. Nothing decorative — with a dozen lanes it's
    // what stops the eye sliding onto the wrong row halfway across.
    const band = mk('rect', {
      x: 0, y: y - TL.laneH / 2, width, height: TL.laneH,
      class: 'tl-lane' + (i % 2 ? ' alt' : ''),
    });
    svg.append(band);

    svg.append(mk('text', {
      x: TL.padLeft - 12, y: y + 4, class: 'tl-lane-name', 'text-anchor': 'end',
    }, lane.name));

    svg.append(mk('line', { x1: TL.padLeft, y1: y, x2: width - TL.padRight, y2: y, class: 'tl-rule' }));

    // A life bar: birth to death, when both are known. It's the spine
    // the rest of a character's events hang on.
    const birth = lane.events.find(e => e.kind === 'birth');
    const death = lane.events.find(e => e.kind === 'death');
    if (birth && death) {
      svg.append(mk('line', {
        x1: x(toYear(birth.start)), y1: y, x2: x(toYear(death.start)), y2: y,
        class: 'tl-life',
      }));
    }

    for (const e of lane.events) {
      const start = toYear(e.start);
      const end = toYear(e.end) ?? start + spanYears(e.precision);
      const w = Math.max(3, (end - start) * pxPerYear);

      const g = mk('g', { class: 'tl-ev', tabindex: '0', role: 'button' });
      // No SVG <title>: the browser's native tooltip arrives after a
      // second, in the OS font, and can't show participants. A styled
      // one follows the pointer immediately and says everything.
      g.setAttribute('aria-label', `${e.title}, ${formatWhen(e.start, e.precision)}`);

      if (w > 6) {
        // Imprecise or lasting — draw the span, so a year-precision date
        // visibly covers a year instead of claiming a day.
        g.append(mk('rect', {
          x: x(start), y: y - 5, width: w, height: 10, rx: 2,
          class: `tl-band k-${e.kind || 'other'}`,
        }));
      } else {
        g.append(mk('circle', {
          cx: x(start), cy: y, r: 4.5, class: `tl-dot k-${e.kind || 'other'}`,
        }));
      }

      const names = (e.participants || []).map(id => cards[id]?.name).filter(Boolean);
      g.addEventListener('mouseenter', ev => showTlTip(ev, e, names, sceneTitle[e.sceneRef]));
      g.addEventListener('mousemove', moveTlTip);
      g.addEventListener('mouseleave', hideTlTip);
      g.addEventListener('focus', ev => showTlTip(ev, e, names, sceneTitle[e.sceneRef]));
      g.addEventListener('blur', hideTlTip);

      g.addEventListener('click', () => { railSection('events'); openEvent(e.id); });
      g.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); railSection('events'); openEvent(e.id); }
      });
      svg.append(g);
    }
  });

  host.append(svg);
  renderLegend(Object.values(allEvents).filter(e => toYear(e.start) !== null));
}

/**
 * renderLegend(events) — the colour key, which doubles as a filter.
 *
 * A legend that only explains is a missed opportunity when the thing it
 * names is also the thing you want to isolate. Clicking a kind shows
 * only that kind; clicking it again clears it.
 *
 * Kinds with nothing in view are shown dimmed rather than hidden: the
 * palette stays legible as a whole, and "no divorces in this book" is
 * information too.
 */
function renderLegend(events) {
  const box = $('tl-legend');
  box.replaceChildren();

  const counts = {};
  for (const e of events) counts[e.kind || 'other'] = (counts[e.kind || 'other'] || 0) + 1;

  for (const kind of EVENT_KINDS) {
    const n = counts[kind] || 0;
    const on = evFilter.kind === kind;

    const b = el('button', 'tl-key' + (n ? '' : ' empty'));
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !n;

    const dot = el('span', 'tl-swatch');
    dot.style.background = `var(--k-${kind})`;
    b.append(dot);
    b.append(el('span', null, kind[0].toUpperCase() + kind.slice(1)));
    if (n) b.append(el('span', 'tl-key-n', String(n)));

    b.addEventListener('click', () => {
      evFilter.kind = on ? null : kind;
      renderTimeline();
      renderEvents();
    });
    box.append(b);
  }
}

// ── Tooltip ────────────────────────────────────────────────────────

let _tlTip = null;

function showTlTip(ev, e, names, scene) {
  if (!_tlTip) {
    _tlTip = el('div', 'tl-tip');
    document.body.append(_tlTip);
  }
  _tlTip.replaceChildren();

  const kind = e.kind || 'other';
  // The card takes the kind's own colour, so what you hovered and what
  // you're reading are obviously the same thing — otherwise every
  // tooltip looks identical and you lose track of which dot it belongs
  // to on a crowded lane.
  _tlTip.style.setProperty('--k', `var(--k-${kind})`);

  const head = el('div', 'tl-tip-head');
  head.append(el('span', 'tl-tip-mark', EVENT_KIND_MARK[kind] || '\u00B7'));
  head.append(el('span', 'tl-tip-title', e.title || 'Untitled event'));
  _tlTip.append(head);

  const meta = el('div', 'tl-tip-meta');
  meta.append(el('span', 'tl-tip-kind', kind[0].toUpperCase() + kind.slice(1)));
  meta.append(el('span', 'tl-tip-when', formatWhen(e.start, e.precision) +
    (e.end ? ` \u2013 ${formatWhen(e.end, e.precision)}` : '')));
  _tlTip.append(meta);

  const rows = [];
  if (names.length)  rows.push(['Who', names.join(', ')]);
  if (e.location)    rows.push(['Where', e.location]);
  // Whether it happens on the page is the distinction events exist for,
  // so it's always stated rather than only when there's a scene.
  rows.push(['Shown', scene || 'Offscreen']);

  for (const [k, v] of rows) {
    const r = el('div', 'tl-tip-row');
    r.append(el('span', 'tl-tip-k', k));
    r.append(el('span', 'tl-tip-v', v));
    _tlTip.append(r);
  }

  _tlTip.hidden = false;
  moveTlTip(ev);
}

function moveTlTip(ev) {
  if (!_tlTip || _tlTip.hidden) return;
  const pad = 14;
  const w = _tlTip.offsetWidth, h = _tlTip.offsetHeight;
  // Flip rather than overflow: near the right edge the tooltip goes to
  // the left of the pointer, near the bottom it goes above.
  const x = ev.clientX + pad + w > window.innerWidth ? ev.clientX - pad - w : ev.clientX + pad;
  const y = ev.clientY + pad + h > window.innerHeight ? ev.clientY - pad - h : ev.clientY + pad;
  _tlTip.style.left = `${Math.max(8, x)}px`;
  _tlTip.style.top  = `${Math.max(8, y)}px`;
}

function hideTlTip() { if (_tlTip) _tlTip.hidden = true; }

async function openTimeline() {
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  App.view = 'timeline';
  for (const id of ['scene', 'card-edit', 'event-edit', 'readview', 'empty']) $(id).hidden = true;
  $('timeline-wrap').hidden = false;
  $('grid-wrap').hidden = true;
  $('board-wrap').hidden = true;
  $('map-wrap').hidden = true;
  $('plan-wrap').hidden = true;
  hideTlTip();
  $('tally').textContent = '';
  await renderTimeline();
}

// ══ Board ══════════════════════════════════════════════════════════
//
// Scenes in columns by status. Status has existed since the first
// version and surfaced nowhere except a dagger in the margin of the
// rail — which tells you a scene is revised but never tells you where
// the draft as a whole stands.
//
// NO DRAG. Every other destructive or structural action here asks
// first; drag-and-drop is the one gesture that commits on release with
// no confirmation and no undo. On a board it would also be the easiest
// thing in the app to do by accident. Each card carries three explicit
// status buttons instead: deliberate, keyboard-reachable, and
// impossible to trigger by brushing a trackpad.

const BOARD_COLUMNS = [
  { id: 'draft',   label: 'Draft',   hint: 'Written once.' },
  { id: 'revised', label: 'Revised', hint: 'Been back through it.' },
  { id: 'final',   label: 'Final',   hint: 'Done until someone says otherwise.' },
];

async function renderBoard() {
  const host = $('board');
  host.replaceChildren();

  const scenes = sceneOrder();
  if (!scenes.length) {
    host.append(el('p', 'rv-empty', 'No scenes yet.'));
    return;
  }

  const total = scenes.reduce((n, s) => n + (s.wordCount || 0), 0);

  for (const col of BOARD_COLUMNS) {
    const mine = scenes.filter(s => (s.status || 'draft') === col.id);
    const words = mine.reduce((n, s) => n + (s.wordCount || 0), 0);

    const section = el('section', 'bd-col');

    const head = el('header', 'bd-head');
    head.append(el('h2', null, col.label));
    // The share of the manuscript in each state is the number that
    // actually answers "how far along am I".
    const pct = total ? Math.round((words / total) * 100) : 0;
    head.append(el('span', 'bd-count',
      `${mine.length} \u00B7 ${fmtWords(words)}${total ? ` \u00B7 ${pct}%` : ''}`));
    section.append(head);

    const bar = el('div', 'bd-bar');
    const fill = el('div', `bd-fill s-${col.id}`);
    fill.style.width = `${pct}%`;
    bar.append(fill);
    section.append(bar);

    const list = el('div', 'bd-list');
    if (!mine.length) {
      list.append(el('p', 'bd-empty', col.hint));
    }
    for (const sc of mine) list.append(boardCard(sc));
    section.append(list);

    host.append(section);
  }
}

function boardCard(sc) {
  const card = el('article', 'bd-card');

  const open = el('button', 'bd-open');
  open.append(el('span', 'bd-title', sc.title || 'Untitled scene'));
  if (sc.chapter) open.append(el('span', 'bd-chapter', sc.chapter));
  if (sc.synopsis) open.append(el('span', 'bd-syn', sc.synopsis));
  open.addEventListener('click', () => { railSection('manuscript'); openScene(sc.id); });
  card.append(open);

  const foot = el('div', 'bd-foot');
  foot.append(el('span', 'bd-words', fmtWords(sc.wordCount)));

  const set = el('div', 'bd-set', null);
  set.setAttribute('role', 'group');
  set.setAttribute('aria-label', `Status of ${sc.title || 'scene'}`);
  for (const col of BOARD_COLUMNS) {
    const b = el('button', `bd-pip s-${col.id}`, col.label[0]);
    b.title = col.label;
    b.setAttribute('aria-pressed', String((sc.status || 'draft') === col.id));
    b.addEventListener('click', async e => {
      e.stopPropagation();
      const rec = await RecordStore.get('scene', sc.id);
      if (!rec) return;
      await RecordStore.put('scene', sc.id, { ...rec, status: col.id });
      await renderTree();
      await renderBoard();
      refreshSyncState();
    });
    set.append(b);
  }
  foot.append(set);
  card.append(foot);
  return card;
}

async function openBoard() {
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  App.view = 'board';
  for (const id of ['scene', 'card-edit', 'event-edit', 'readview', 'timeline-wrap',
                    'grid-wrap', 'map-wrap', 'plan-wrap', 'empty']) $(id).hidden = true;
  $('board-wrap').hidden = false;
  $('tally').textContent = '';
  await renderBoard();
}

// ══ Mind map ═══════════════════════════════════════════════════════
//
// Cards as nodes, edges where two cards share a scene or an event.
// Nothing here is authored: the whole graph falls out of [[links]] in
// the prose and the participant lists on events, so it is a picture of
// the book as written rather than a diagram you maintain beside it.
//
// The layout is a small force simulation — repulsion between every
// pair, springs along edges, gravity toward the middle. No library: a
// graph library is a large dependency to vendor for offline use, and
// the whole simulation is about forty lines.
//
// DETERMINISTIC. Nodes start on a circle in a fixed order and the
// simulation runs a fixed number of steps, so the same book produces
// the same picture every time. A layout that reshuffles on every visit
// would make it impossible to build any familiarity with the shape.

const MAP = { w: 1100, h: 700, steps: 320 };

// The map has its own viewport rather than relying on the page.
// Browser zoom would take the rail and the header with it, which is
// the opposite of what you want when you're trying to read a cluster
// of names in the corner of a graph.
const mapView = { z: 1, x: 0, y: 0 };

function applyMapView(svg) {
  const w = MAP.w / mapView.z;
  const h = MAP.h / mapView.z;
  // Clamp so the graph can't be dragged off into empty space and lost.
  mapView.x = Math.max(-MAP.w * 0.5, Math.min(MAP.w * 1.5 - w, mapView.x));
  mapView.y = Math.max(-MAP.h * 0.5, Math.min(MAP.h * 1.5 - h, mapView.y));
  svg.setAttribute('viewBox', `${mapView.x} ${mapView.y} ${w} ${h}`);
}

function zoomMap(factor, cx = 0.5, cy = 0.5) {
  const svg = document.querySelector('.map-svg');
  if (!svg) return;
  const prev = mapView.z;
  mapView.z = Math.max(0.4, Math.min(6, mapView.z * factor));
  if (mapView.z === prev) return;
  // Keep whatever is under the pointer (or the centre) where it is,
  // instead of zooming toward the origin and losing your place.
  const w0 = MAP.w / prev, h0 = MAP.h / prev;
  const w1 = MAP.w / mapView.z, h1 = MAP.h / mapView.z;
  mapView.x += (w0 - w1) * cx;
  mapView.y += (h0 - h1) * cy;
  applyMapView(svg);
}

function fitMap() {
  mapView.z = 1; mapView.x = 0; mapView.y = 0;
  const svg = document.querySelector('.map-svg');
  if (svg) applyMapView(svg);
}

function mapGraph(links, events, cards) {
  const nodes = new Map();
  const edges = new Map();

  const touch = id => {
    if (cards[id] && !nodes.has(id)) {
      nodes.set(id, { id, card: cards[id], deg: 0 });
    }
    return nodes.has(id);
  };

  const join = (a, b, weight, why) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const e = edges.get(key) || { a: a < b ? a : b, b: a < b ? b : a, w: 0, why: new Set() };
    e.w += weight;
    e.why.add(why);
    edges.set(key, e);
  };

  // Two cards linked from the same scene are connected. This is the
  // edge that matters: it means they were on the page together.
  for (const [, list] of Object.entries(links.byScene)) {
    const ids = list.map(l => l.cardId).filter(touch);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) join(ids[i], ids[j], 1, 'scene');
  }

  // Participants in the same event, likewise — including events that
  // never appear on the page, which is where most of a backstory is.
  for (const e of Object.values(events)) {
    const ids = (e.participants || []).filter(touch);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) join(ids[i], ids[j], 1.5, 'event');
  }

  for (const e of edges.values()) {
    nodes.get(e.a).deg += e.w;
    nodes.get(e.b).deg += e.w;
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function layout(nodes, edges) {
  const { w, h, steps } = MAP;
  const cx = w / 2, cy = h / 2;

  // Fixed starting ring, ordered by name — the source of the
  // determinism promised above.
  nodes.sort((x, y) => (x.card.name || '').localeCompare(y.card.name || ''));
  nodes.forEach((n, i) => {
    const t = (i / nodes.length) * Math.PI * 2;
    n.x = cx + Math.cos(t) * Math.min(w, h) * 0.32;
    n.y = cy + Math.sin(t) * Math.min(w, h) * 0.32;
    n.vx = 0; n.vy = 0;
  });

  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const ideal = 120;

  for (let step = 0; step < steps; step++) {
    // Cooling, so it settles instead of oscillating forever.
    const heat = 1 - step / steps;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy) || 0.01;
        const push = 9000 / (d * d);
        dx /= d; dy /= d;
        a.vx -= dx * push; a.vy -= dy * push;
        b.vx += dx * push; b.vy += dy * push;
      }
    }

    for (const e of edges) {
      const a = byId[e.a], b = byId[e.b];
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      // A heavier edge pulls harder, so pairs that share many scenes
      // sit closer together than pairs that met once.
      const pull = (d - ideal) * 0.012 * Math.min(3, e.w);
      dx /= d; dy /= d;
      a.vx += dx * pull; a.vy += dy * pull;
      b.vx -= dx * pull; b.vy -= dy * pull;
    }

    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.006;
      n.vy += (cy - n.y) * 0.006;
      n.x += n.vx * heat; n.y += n.vy * heat;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x = Math.max(70, Math.min(w - 70, n.x));
      n.y = Math.max(40, Math.min(h - 40, n.y));
    }
  }
}

async function renderMap() {
  const host = $('map');
  host.replaceChildren();

  const [links, events, cards] = await Promise.all([
    RecordStore.linkGraph(), RecordStore.getAll('event'), RecordStore.getAll('card'),
  ]);

  const { nodes, edges } = mapGraph(links, events, cards);
  const connected = nodes.filter(n => n.deg > 0);

  if (connected.length < 2) {
    host.append(el('p', 'rv-empty',
      'Not enough connections yet. Two cards are joined when they appear ' +
      'in the same scene or the same event.'));
    return;
  }

  layout(connected, edges);

  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', MAP.h);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.classList.add('tl-svg', 'map-svg');
  applyMapView(svg);
  wireMapGestures(svg);

  const byId = Object.fromEntries(connected.map(n => [n.id, n]));

  const gEdges = mk('g', { class: 'mp-edges' });
  for (const e of edges) {
    const a = byId[e.a], b = byId[e.b];
    if (!a || !b) continue;
    const line = mk('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: 'mp-edge' + (e.why.has('event') && !e.why.has('scene') ? ' offpage' : ''),
      'stroke-width': Math.min(4, 0.7 + e.w * 0.5),
    });
    line.dataset.a = e.a;
    line.dataset.b = e.b;
    gEdges.append(line);
  }
  svg.append(gEdges);

  for (const n of connected) {
    // Size by degree, so the people the book is actually about are the
    // ones you see first.
    const r = 6 + Math.min(14, Math.sqrt(n.deg) * 3.2);
    const g = mk('g', { class: 'mp-node', tabindex: '0', role: 'button',
                        transform: `translate(${n.x} ${n.y})` });
    g.dataset.id = n.id;

    g.append(mk('circle', { r, class: `mp-dot t-${n.card.cardType || 'research'}` }));
    const label = mk('text', { y: r + 13, class: 'mp-label', 'text-anchor': 'middle' },
                     n.card.name || 'Untitled');
    g.append(label);

    const focus = on => {
      svg.classList.toggle('focusing', on);
      for (const line of gEdges.children) {
        const hit = line.dataset.a === n.id || line.dataset.b === n.id;
        line.classList.toggle('lit', on && hit);
      }
      for (const other of svg.querySelectorAll('.mp-node')) {
        const near = other === g || [...gEdges.children].some(l =>
          l.classList.contains('lit') &&
          (l.dataset.a === other.dataset.id || l.dataset.b === other.dataset.id));
        other.classList.toggle('dim', on && !near);
      }
    };

    g.addEventListener('mouseenter', () => focus(true));
    g.addEventListener('mouseleave', () => focus(false));
    g.addEventListener('focus', () => focus(true));
    g.addEventListener('blur', () => focus(false));
    g.addEventListener('click', () => { railSection('cards'); openCard(n.id); });
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); railSection('cards'); openCard(n.id); }
    });
    svg.append(g);
  }

  host.append(svg);

  const lonely = nodes.length - connected.length;
  const note = el('p', 'grid-note',
    `${connected.length} connected \u00B7 ${edges.length} link${edges.length === 1 ? '' : 's'}` +
    (lonely ? ` \u00B7 ${lonely} card${lonely === 1 ? '' : 's'} not yet connected` : ''));
  host.append(note);
}

/**
 * wireMapGestures(svg) — wheel to zoom, drag to pan.
 *
 * Panning by dragging the background is safe in a way dragging nodes
 * would not be: it moves the camera, never the data. Nothing here can
 * change the book.
 */
function wireMapGestures(svg) {
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomMap(e.deltaY < 0 ? 1.15 : 1 / 1.15,
            (e.clientX - r.left) / r.width,
            (e.clientY - r.top) / r.height);
  }, { passive: false });

  let panning = false, lastX = 0, lastY = 0;

  svg.addEventListener('pointerdown', e => {
    // Only the background pans. Starting a drag on a node would fight
    // the click that opens its card.
    if (e.target.closest('.mp-node')) return;
    panning = true;
    lastX = e.clientX; lastY = e.clientY;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  });

  svg.addEventListener('pointermove', e => {
    if (!panning) return;
    const r = svg.getBoundingClientRect();
    // Convert screen pixels to viewBox units, or panning drifts out of
    // step with the pointer the moment you zoom.
    mapView.x -= (e.clientX - lastX) * (MAP.w / mapView.z) / r.width;
    mapView.y -= (e.clientY - lastY) * (MAP.h / mapView.z) / r.height;
    lastX = e.clientX; lastY = e.clientY;
    applyMapView(svg);
  });

  const stop = e => {
    if (!panning) return;
    panning = false;
    svg.releasePointerCapture?.(e.pointerId);
    svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', stop);
  svg.addEventListener('pointercancel', stop);
}

async function openMap() {
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  App.view = 'map';
  for (const id of ['scene', 'card-edit', 'event-edit', 'readview', 'timeline-wrap',
                    'grid-wrap', 'board-wrap', 'plan-wrap', 'empty']) $(id).hidden = true;
  $('map-wrap').hidden = false;
  $('tally').textContent = '';
  await renderMap();
}

// ══ Grid ═══════════════════════════════════════════════════════════
//
// Scenes down, cards across, a mark where a scene links a card. The
// answer to "who is in this chapter" and "where does she disappear for
// forty pages" at a glance.
//
// DERIVED, NOT MAINTAINED. Wavemaker and Scrivener both make you tag
// scenes by hand, which means the grid is only ever as current as your
// last tagging session. Here the marks come from [[links]] in the prose
// itself, so a grid can't drift out of date — writing someone into a
// scene IS the act of putting them in the grid.
//
// Built as a table rather than SVG: sticky headers, text selection and
// keyboard navigation all come free, and the content is genuinely
// tabular.

const gridFilter = { type: 'character' };

async function renderGrid() {
  const host = $('grid');
  host.replaceChildren();

  const [graph, cards] = await Promise.all([
    RecordStore.linkGraph(), RecordStore.getAll('card'),
  ]);

  // Columns: cards of the chosen type that appear at least once. A
  // column of empty cells is noise — the card list is where you go to
  // see everyone.
  const used = new Set(Object.keys(graph.byCard));
  const cols = Object.values(cards)
    .filter(c => used.has(c.id))
    .filter(c => gridFilter.type === 'all' || c.cardType === gridFilter.type)
    .sort((x, y) => (x.name || '').localeCompare(y.name || ''));

  // Rows: every scene in reading order, including ones with no links.
  // An empty row is the useful signal here — a scene nobody appears in
  // is worth noticing.
  const rows = [];
  for (const ch of RecordStore.allChapters(App.tree || { works: [] })) {
    for (const sc of ch.scenes) rows.push({ ...sc, chapter: ch.title });
  }
  for (const sc of (App.tree?.unfiled || [])) rows.push({ ...sc, chapter: null });

  if (!cols.length || !rows.length) {
    host.append(el('p', 'rv-empty', cols.length
      ? 'No scenes yet.'
      : 'Nothing linked yet. Write [[a card name]] in a scene and it appears here.'));
    return;
  }

  const table = el('table', 'grid-table');

  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', 'g-corner', 'Scene'));
  hr.append(el('th', 'g-words', 'Words'));
  for (const c of cols) {
    const th = el('th', 'g-col');
    const btn = el('button', 'g-col-btn', c.name);
    btn.addEventListener('click', () => { railSection('cards'); openCard(c.id); });
    th.append(btn);
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  let lastChapter;
  for (const sc of rows) {
    if (sc.chapter !== lastChapter) {
      lastChapter = sc.chapter;
      const br = el('tr', 'g-chapter-row');
      const td = el('td', 'g-chapter');
      td.colSpan = cols.length + 2;
      td.textContent = sc.chapter || 'Unplaced';
      br.append(td);
      tbody.append(br);
    }

    const tr = el('tr');
    const nameCell = el('th', 'g-row');
    const nameBtn = el('button', 'g-row-btn', sc.title || 'Untitled');
    nameBtn.addEventListener('click', () => { railSection('manuscript'); openScene(sc.id); });
    nameCell.append(nameBtn);
    tr.append(nameCell);

    tr.append(el('td', 'g-words', fmtWords(sc.wordCount)));

    const links = Object.fromEntries((graph.byScene[sc.id] || []).map(l => [l.cardId, l.count]));
    for (const c of cols) {
      const td = el('td', 'g-cell');
      const n = links[c.id];
      if (n) {
        td.classList.add('on');
        // The count matters: one mention and a whole scene built around
        // someone look identical otherwise.
        td.append(el('span', 'g-mark', n > 1 ? String(n) : '\u25CF'));
        td.title = `${c.name} in ${sc.title} (${n} mention${n === 1 ? '' : 's'})`;
        td.addEventListener('click', () => { railSection('manuscript'); openScene(sc.id); });
      }
      tr.append(td);
    }
    tbody.append(tr);
  }

  table.append(tbody);
  host.append(table);

  const totals = el('p', 'grid-note');
  totals.textContent = `${rows.length} scenes \u00D7 ${cols.length} cards`;
  if (graph.unknown.size) {
    // Unresolved links are usually typos or people not written up yet.
    // Surfacing the count here is the only place they're visible.
    totals.textContent += ` \u2014 ${graph.unknown.size} unresolved link${graph.unknown.size === 1 ? '' : 's'}`;
  }
  host.append(totals);
}

async function openGrid() {
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  App.view = 'grid';
  for (const id of ['scene', 'card-edit', 'event-edit', 'readview', 'timeline-wrap', 'empty'])
    $(id).hidden = true;
  $('grid-wrap').hidden = false;
  $('board-wrap').hidden = true;
  $('map-wrap').hidden = true;
  $('plan-wrap').hidden = true;
  $('tally').textContent = '';
  await renderGrid();
}

// ══ Storage persistence ════════════════════════════════════════════
//
// By default IndexedDB sits in a "best-effort" bucket: under disk
// pressure browsers evict least-recently-used origins wholesale.
// navigator.storage.persist() asks to be skipped by that sweep.
//
// WHAT IT DOES NOT DO. It doesn't protect against you clearing site
// data, a private window, or uninstalling the browser. It is a seatbelt
// against the browser's own housekeeping, not a safe. Sync is the first
// line of defence here and the backup zip is the second; this only
// matters in the window where something is written locally and hasn't
// reached the worker yet.
//
// SAFARI is the case that actually bites, and it isn't about disk
// space: with tracking prevention on, an origin with no interaction for
// seven days has its script-created data deleted outright. Persistence
// exempts you; so does adding the site to the Home Screen.
//
// WHEN TO ASK. Firefox shows a real permission prompt, so this fires on
// the first meaningful content write — a genuine user gesture, at the
// moment the data becomes worth protecting. Asking during boot is how
// you get declined.

const PERSIST_ASKED_KEY = 'rec_persist_asked';

async function storageStatus() {
  if (!navigator.storage) return { supported: false };
  const persisted = navigator.storage.persisted
    ? await navigator.storage.persisted().catch(() => false)
    : false;
  let usage = null, quota = null;
  if (navigator.storage.estimate) {
    try { ({ usage, quota } = await navigator.storage.estimate()); } catch {}
  }
  return { supported: true, persisted, usage, quota };
}

/**
 * requestPersistence({ force }) — ask once, remember the answer.
 *
 * Re-prompting after a decline is worse than never asking: it trains
 * people to dismiss the dialog. `force` is for the Settings button,
 * where asking again is the explicit point.
 */
async function requestPersistence({ force = false } = {}) {
  if (!navigator.storage?.persist) return false;

  if (await navigator.storage.persisted().catch(() => false)) return true;
  if (!force && localStorage.getItem(PERSIST_ASKED_KEY)) return false;

  try { localStorage.setItem(PERSIST_ASKED_KEY, '1'); } catch {}

  let granted = false;
  try { granted = await navigator.storage.persist(); } catch { granted = false; }

  if (force) {
    showToast(granted
      ? 'Storage is now protected from automatic clearing.'
      : 'The browser declined. Adding Recension to your home screen usually helps.',
      6000);
  }
  renderStorageStatus();
  return granted;
}

// Fired from the first content write of a session. Silent either way —
// this is insurance, not a feature to announce.
let _persistTried = false;
function maybeRequestPersistence() {
  if (_persistTried) return;
  _persistTried = true;
  requestPersistence();
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

async function renderStorageStatus() {
  const note = $('storage-note');
  const btn = $('btn-persist');
  if (!note) return;

  const s = await storageStatus();
  if (!s.supported) {
    note.textContent = 'This browser does not report storage status.';
    if (btn) btn.hidden = true;
    return;
  }

  // Report what's actually stored rather than a reassuring abstraction.
  const used = fmtBytes(s.usage);
  const of = s.quota ? ` of about ${fmtBytes(s.quota)} available` : '';

  note.textContent = s.persisted
    ? `Protected. Your writing won't be cleared automatically. Using ${used}${of}.`
    : `Not protected — the browser may clear this site's data if the device runs low on space. Using ${used}${of}.`;
  note.classList.toggle('bad', !s.persisted);
  if (btn) btn.hidden = s.persisted;
}

// ══ Offline ════════════════════════════════════════════════════════
//
// Registers the service worker that caches the app shell. Without it,
// closing the tab without a connection meant Recension wouldn't load at
// all — the manuscript sat safe in IndexedDB and was unreachable.
//
// Deploys are handled by bumping SW_VERSION in sw.js. When a new worker
// takes over mid-session the page is running old code against possibly
// new assets, so it says so and offers a reload rather than swapping
// things out underneath someone who is writing.

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // A service worker needs a secure context. On localhost over http it
  // is allowed; anywhere else it silently won't register, which is
  // worth knowing when testing from a file:// URL.
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');

      reg.addEventListener('updatefound', () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener('statechange', () => {
          // installed + an existing controller means an UPDATE, not a
          // first install. A first install shouldn't announce itself.
          if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
            offerUpdate();
          }
        });
      });
    } catch (e) {
      console.warn('[app] service worker registration failed:', e);
    }
  });
}

let _updateOffered = false;
function offerUpdate() {
  if (_updateOffered) return;
  _updateOffered = true;

  const bar = el('div', 'update-bar');
  bar.append(el('span', null, 'A new version is ready.'));
  const btn = el('button', 'ghost-btn', 'Reload');
  btn.addEventListener('click', async () => {
    // Flush first. Reloading over unsaved words would be an unusually
    // cruel way to deliver an improvement.
    await flushActiveScene();
    await flushActiveCard();
    await flushActiveEvent();
    location.reload();
  });
  const later = el('button', 'ghost-btn', 'Later');
  later.addEventListener('click', () => bar.remove());
  bar.append(btn, later);
  document.body.append(bar);
}

// ══ Search ═════════════════════════════════════════════════════════
//
// One box over everything: scenes, cards, events, chapters. Opens on
// Ctrl/Cmd-K, which is where a decade of other tools have trained
// everyone's hands to reach.
//
// Results are a palette, not a page: arrow keys move, Enter opens, and
// the whole thing closes on the way. Sending you to a separate results
// screen would mean two navigations to read one sentence.

let _searchTimer = null;
let _searchResults = [];
let _searchIndex = 0;

function openSearch() {
  $('search-overlay').hidden = false;
  const box = $('search-input');
  box.value = '';
  box.focus();
  $('search-results').replaceChildren();
  $('search-hint').textContent = 'Scenes, cards, events — anything with words in it.';
  _searchResults = [];
  _searchIndex = 0;
}

function closeSearch() {
  $('search-overlay').hidden = true;
  clearTimeout(_searchTimer);
}

function scheduleSearch() {
  clearTimeout(_searchTimer);
  // Short debounce: the scan is fast, but running it on every keystroke
  // of a long word is work nobody sees the result of.
  _searchTimer = setTimeout(runSearch, 140);
}

const SEARCH_ICON = {
  scene: '\u00B6', card: '\u25C6', event: '\u2022',
  chapter: '\u00A7', part: '\u2016', book: '\u25A0',
};

async function runSearch() {
  const q = $('search-input').value.trim();
  const list = $('search-results');
  const hint = $('search-hint');

  if (q.length < 2) {
    list.replaceChildren();
    hint.textContent = 'Keep typing — two letters or more.';
    _searchResults = [];
    return;
  }

  // The prose is the source of truth, so anything unsaved has to be
  // written before it can be found. Searching and not finding the
  // sentence you just typed would be a bad first impression.
  await flushActiveScene();
  await flushActiveCard();
  await flushActiveEvent();

  _searchResults = await RecordStore.search(q);
  _searchIndex = 0;

  list.replaceChildren();
  if (!_searchResults.length) {
    hint.textContent = `Nothing for "${q}".`;
    return;
  }
  hint.textContent = `${_searchResults.length} result${_searchResults.length === 1 ? '' : 's'}`;

  _searchResults.forEach((r, i) => {
    const row = el('button', 'sr' + (i === _searchIndex ? ' on' : ''));
    row.append(el('span', 'sr-icon', SEARCH_ICON[r.type] || '\u00B7'));

    const main = el('span', 'sr-main');
    main.append(el('span', 'sr-title', r.title));
    if (r.snippet) {
      // Mark the match in place rather than rewriting the sentence
      // around it — you should see the line as it's actually written.
      const s = el('span', 'sr-snip');
      const { text, at, len } = r.snippet;
      if (at >= 0) {
        s.append(document.createTextNode(text.slice(0, at)));
        s.append(el('mark', null, text.slice(at, at + len)));
        s.append(document.createTextNode(text.slice(at + len)));
      } else {
        s.textContent = text;
      }
      main.append(s);
    }
    row.append(main);
    row.append(el('span', 'sr-where', r.context || r.type));

    row.addEventListener('click', () => openResult(r));
    row.addEventListener('mouseenter', () => { _searchIndex = i; paintSearchSelection(); });
    list.append(row);
  });
}

function paintSearchSelection() {
  const rows = [...$('search-results').children];
  rows.forEach((r, i) => r.classList.toggle('on', i === _searchIndex));
  rows[_searchIndex]?.scrollIntoView({ block: 'nearest' });
}

async function openResult(r) {
  closeSearch();
  if (r.type === 'scene')  { railSection('manuscript'); return openScene(r.id); }
  if (r.type === 'card')   { railSection('cards');      return openCard(r.id); }
  if (r.type === 'event')  { railSection('events');     return openEvent(r.id); }
  // Containers have no editor of their own — reading them is the
  // closest thing to opening them.
  railSection('manuscript');
  if (r.type === 'chapter') return openRead({ kind: 'chapter', id: r.id });
  if (r.type === 'part')    return openRead({ kind: 'part', id: r.id });
  if (r.type === 'book')    return openRead({ kind: 'book', id: r.id });
}

function searchKey(e) {
  if ($('search-overlay').hidden) return false;
  if (e.key === 'Escape')    { closeSearch(); return true; }
  if (!_searchResults.length) return false;
  if (e.key === 'ArrowDown') { _searchIndex = (_searchIndex + 1) % _searchResults.length; paintSearchSelection(); return true; }
  if (e.key === 'ArrowUp')   { _searchIndex = (_searchIndex - 1 + _searchResults.length) % _searchResults.length; paintSearchSelection(); return true; }
  if (e.key === 'Enter')     { openResult(_searchResults[_searchIndex]); return true; }
  return false;
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
    // The third argument carries { eraseLocal } from the wizard's
    // "discard my guest notes" choice. Ignoring it meant discard kept
    // everything — and then pushed it into the account just joined.
    onSignedIn: async (data, isNew, opts) => {
      await applySignIn(data, isNew, opts || {});
      showToast(isNew ? 'Account created.' : 'Signed in.');
    },
    onGuestReady: async (data) => {
      await applySignIn(data || App.data, true, {});
    },
    onSessionExpired: () => setSyncState('error', 'Sign-in expired'),
    // Called by auth.js at account creation to prove the worker is
    // reachable AND to lay down the account record. flush() alone was not
    // enough: it only pushes what's in the dirty set, and creating an
    // account doesn't mark anything dirty — so it reported success having
    // written nothing, and the account was then unfindable from any other
    // device. Write the account record explicitly, then flush the content.
    // Called by auth.js just before it reloads on sign-out. auth.js only
    // clears localStorage; the manuscript lives in IndexedDB and would
    // otherwise follow you into the next account.
    onSignOut: async () => {
      await RecordStore.clear();
      await Sync.resetDirty();
    },

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
    // Background pulls (returning to the app, the periodic timer) have
    // to settle up the same way the boot pull does — merging split
    // projects and refreshing link resolution — or they'd bring records
    // in that the screen never reflects.
    onPulled: () => afterPull(),

    /**
     * This device is holding a token that has since been upgraded to
     * Google sign-in on another device. The token is dead — /auth/migrate
     * deletes the source key space — so there is nothing to recover by
     * retrying. Say so plainly and send them to sign in.
     *
     * Local content is left alone. It's a copy of what already moved to
     * the Google account, and deleting a manuscript because a credential
     * changed would be an unforgivable way to be tidy.
     */
    onAccountMigrated: () => {
      if (App._migrationPrompted) return;   // once per session, not per pull
      App._migrationPrompted = true;
      showToast('This account now uses Google sign-in.', 6000);
      setTimeout(() => Auth.showAccountSetup(), 400);
    },
    onAuthFailure: async () => {
      if (typeof Auth.handleAuthFailure === 'function') return await Auth.handleAuthFailure();
      return false;
    },
    toast: showToast,
  });

  // ── Events ──────────────────────────────────────────────────────
  registerServiceWorker();
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
  // Rendered wikilinks in the read view and the mobile reading pane.
  // Plain click is fine here — this text isn't editable, so there's no
  // caret to place and nothing to steal.
  $('sheet').addEventListener('mousemove', e => {
    const link = e.target.closest?.('a.wl');
    link ? scheduleCardTip(link.dataset.link, e.clientX, e.clientY) : hideCardTip();
  });
  $('sheet').addEventListener('mouseleave', hideCardTip);

  $('sheet').addEventListener('click', e => {
    const link = e.target.closest('a.wl');
    if (!link) return;
    e.preventDefault();
    followLink(link.dataset.link);
  });

  $('sheet').addEventListener('scroll', () => {
    hideCardTip();
    if (App.view !== 'read' || _spyRaf) return;
    _spyRaf = requestAnimationFrame(() => { _spyRaf = null; updateSpy(); });
  }, { passive: true });
  $('scrim').addEventListener('click', closeRail);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-search').addEventListener('click', openSearch);
  $('btn-project').addEventListener('click', e => {
    e.stopPropagation();
    openProjectMenu($('btn-project'));
  });
  $('search-input').addEventListener('input', scheduleSearch);
  $('search-overlay').addEventListener('mousedown', e => {
    if (e.target === $('search-overlay')) closeSearch();
  });
  $('settings-close').addEventListener('click', () => closeModal('modal-settings'));


  $('ev-filter-who').addEventListener('change', e => {
    evFilter.who = e.target.value;
    renderEvents();
    if (App.view === 'timeline') renderTimeline();
  });
  $('btn-timeline').addEventListener('click', openTimeline);
  $('btn-grid').addEventListener('click', openGrid);
  $('btn-board').addEventListener('click', openBoard);
  $('btn-map').addEventListener('click', openMap);
  $('mp-in').addEventListener('click', () => zoomMap(1.4));
  $('mp-out').addEventListener('click', () => zoomMap(1 / 1.4));
  $('mp-fit').addEventListener('click', fitMap);
  for (const b of document.querySelectorAll('.grid-types button')) {
    b.addEventListener('click', () => {
      gridFilter.type = b.dataset.type;
      for (const o of document.querySelectorAll('.grid-types button'))
        o.setAttribute('aria-pressed', String(o === b));
      renderGrid();
    });
  }
  $('tl-in').addEventListener('click', () => { App.tlZoom = Math.min(App.tlZoom * 1.6, 60); renderTimeline(); });
  $('tl-out').addEventListener('click', () => { App.tlZoom = Math.max(App.tlZoom / 1.6, 1); renderTimeline(); });
  $('tl-fit').addEventListener('click', () => { App.tlZoom = 1; renderTimeline(); });
  for (const b of document.querySelectorAll('.ev-filter-where button')) {
    b.addEventListener('click', () => {
      evFilter.where = b.dataset.where;
      for (const o of document.querySelectorAll('.ev-filter-where button'))
        o.setAttribute('aria-pressed', String(o === b));
      renderEvents();
      if (App.view === 'timeline') renderTimeline();
    });
  }

  for (const id of ['ev-title', 'ev-location', 'ev-body'])
    $(id).addEventListener('input', scheduleEventSave);
  $('ev-body').addEventListener('input', () => autoGrow($('ev-body')));
  for (const id of ['ev-kind', 'ev-scene'])
    $(id).addEventListener('change', () => flushActiveEvent());
  $('ev-kind').addEventListener('change', paintKindCue);
  for (const id of ['ev-start', 'ev-end']) {
    $(id).addEventListener('input', updateWhenHint);
    $(id).addEventListener('change', () => flushActiveEvent());
  }
  $('ev-add-participant').addEventListener('change', async e => {
    const id = e.target.value;
    if (!id) return;
    await renderParticipants([...readParticipants(), id]);
    flushActiveEvent();
  });
  for (const b of document.querySelectorAll('.rail-switch [role="tab"]')) {
    b.addEventListener('click', async () => {
      await railSection(b.dataset.section);
      if (b.dataset.section === 'plan') openPlan();
    });
  }

  for (const id of ['card-name', 'card-tags', 'card-aka', 'card-body'])
    $(id).addEventListener('input', scheduleCardSave);
  $('card-body').addEventListener('input', () => autoGrow($('card-body')));
  // Changing a card's type adds the new type's starter fields if they're
  // missing. Additive only: nothing you typed is removed, and unwanted
  // rows delete like any other.
  $('card-type').addEventListener('change', async () => {
    const type = $('card-type').value;
    const current = readCardFields();
    let added = 0;
    for (const k of CARD_STARTERS[type] || []) {
      if (!(k in current)) { current[k] = ''; added++; }
    }
    if (added) renderCardFields(current);
    await flushActiveCard();
    if (added) showToast(`Added ${added} ${CARD_TYPE_SINGULAR[type]} field${added === 1 ? '' : 's'}.`);
  });
  $('btn-card-image').addEventListener('click', () => $('card-image-file').click());
  $('card-image-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';           // so the same file can be chosen twice
    if (file && App.activeCard) await setCardImage(App.activeCard.id, file);
  });
  $('btn-remove-image').addEventListener('click', () => {
    if (!App.activeCard) return;
    showConfirm('Remove this image?', () => removeCardImage(App.activeCard.id), 'Remove');
  });

  $('btn-add-field').addEventListener('click', () => {
    const fields = readCardFields();
    fields[''] = '';                       // an empty row to type into
    renderCardFields(fields);
    document.querySelector('#card-fields .card-field:last-child .cf-key')?.focus();
  });
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
  $('set-spellcheck').addEventListener('change', e => {
    applyTypography({ ...App.typography, spellcheck: e.target.checked });
    applyWritingAids();
  });
  $('set-autocorrect').addEventListener('change', e => {
    applyTypography({ ...App.typography, autocorrect: e.target.checked });
    applyWritingAids();
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
  $('btn-sync-status-refresh').addEventListener('click', renderSyncStatus);
  $('btn-sync-now').addEventListener('click', async () => {
    // Report the actual blocker. "Sync incomplete" for a guest account is
    // true but useless — there's nothing to sync TO yet.
    if (!App.data.workerUrl) { showToast('Add your worker address first.'); return; }
    if (Auth.isGuest())      { showToast('Create an account below to sync.'); return; }

    await flushActiveScene();
    const pushed = await Sync.flush();
    const pulled = await Sync.pull();
    await afterPull();
    if (pushed.ok && pulled.ok) showToast('Synced.');
    else showToast('Sync incomplete — it will retry on its own.');
    renderSyncStatus();
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
    // The CHOOSER, not the token leaf. Going straight to showSetupLoadToken
    // skipped the screen that offers Google, so the only way to reach
    // Google sign-in was to open the token form and press Back — which
    // nobody would ever guess.
    Auth.showSetupLoadChoice();
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

  $('btn-export-manuscript').addEventListener('click', () => exportAs()
    .catch(e => { console.error(e); showToast('Compile failed - see the console.'); }));
  $('btn-persist').addEventListener('click', () => requestPersistence({ force: true }));
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';           // so the same file can be picked twice
    if (file) await runImport(file);
  });

  $('btn-export-project').addEventListener('click', () =>
    exportBackup({ projectId: RecordStore.currentProject() })
      .catch(e => { console.error(e); showToast('Export failed — see the console.'); }));
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

  // Ctrl/Cmd-Z undoes a structural move — but never while the caret is
  // in text. Text undo belongs to CodeMirror and already works.
  document.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (document.activeElement?.closest?.('.CodeMirror')) return;
    if (!undoStack.length) return;
    e.preventDefault();
    undoLast();
  }, true);

  // Ctrl/Cmd-K opens search — where a decade of other tools have
  // trained everyone's hands to reach. Captured, so it works from
  // inside the editor too.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      $('search-overlay').hidden ? openSearch() : closeSearch();
      return;
    }
    if (searchKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

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
  window.addEventListener('beforeunload', () => {
    flushActiveScene(); flushActiveCard(); flushActiveEvent();
  });

  // ── Start ───────────────────────────────────────────────────────

  await openLastProject();

  if (!Auth.isGuest() && App.data.workerUrl) {
    Sync.start();
    Sync.pull().then(async r => {
      if (r?.migrated) return;     // handled by onAccountMigrated
      await afterPull();
    });
  }

  if (typeof Auth.bootCheck === 'function') await Auth.bootCheck();

  const active = place().openSceneId;
  if (active && await RecordStore.get('scene', active)) openScene(active);
  else showEmpty();

  refreshSyncState();
});

/**
 * openLastProject() — establish the working set before anything draws.
 *
 * ensureProject() runs the one-time migration for content written
 * before projects existed: it creates a project named after the first
 * book and adopts every record without one. Silent by design — you
 * shouldn't have to answer a question about a change you didn't ask
 * for, and the app looks identical afterwards.
 */
/**
 * afterPull() — settle up once records have arrived from elsewhere.
 *
 * Two things can only be dealt with here, because both depend on
 * seeing what another device did.
 *
 * The migration ran on every device BEFORE its first pull, so each
 * minted its own project for the same content. Once they sync, a book
 * can sit in one project and its cards in another, and every link
 * between them reads as unresolved. reconcileAutoProjects() merges
 * them, deterministically, so every device picks the same survivor.
 *
 * And a pull can bring new cards, which the link index must be told
 * about or links to them stay grey until a reload.
 */
async function afterPull() {
  const merged = await RecordStore.reconcileAutoProjects();
  if (!merged) await offerProjectMerge();
  if (merged) {
    RecordStore.setCurrentProject(merged);
    App.data.lastProjectId = merged;
    saveLocal();
    await renderProjectName();
    // Covers both repairs: a genuine merge, and records adopted back
    // out of a project that no longer exists.
    showToast('Cards and events from your other devices have been reconnected.', 6000);
  }

  invalidateCardIndex();
  refreshWikilinkOverlay();
  await renderTree();
  if (App.section === 'cards') renderCards();
  if (App.section === 'events') renderEvents();
}

/**
 * offerProjectMerge() — ask about duplicates the app can't merge alone.
 *
 * The automatic merge only runs on projects the migration marked. An
 * account migrated before that marker existed has two identically
 * named projects and no proof they were automatic — and merging two
 * projects somebody made deliberately would be worse than leaving the
 * split. So this asks, once per session, naming what it found.
 *
 * The split is not cosmetic: a book in one project and its cards in
 * the other means every link between them reads as unresolved, and
 * records appear and disappear as each device's copy wins.
 */
let _mergeOffered = false;
async function offerProjectMerge() {
  if (_mergeOffered) return;
  const groups = await RecordStore.duplicateProjectGroups();
  if (!groups.length) return;
  _mergeOffered = true;

  const group = groups[0];
  const name = group[0].title || 'this project';
  const pick = await askChoice(
    `There are ${group.length} projects called “${name}”, most likely because ` +
    `Recension was set up on more than one device before projects existed. ` +
    `While they stay separate, cards and events can sit in one while the ` +
    `manuscript sits in the other — which is why some links show as unknown.`,
    [{ label: 'Merge them into one', value: 'merge' }]);
  if (pick !== 'merge') return;

  const keep = await RecordStore.mergeProjects(group);
  RecordStore.setCurrentProject(keep);
  App.data.lastProjectId = keep;
  saveLocal();
  await renderProjectName();
  invalidateCardIndex();
  await railSection(App.section || 'manuscript');
  showToast('Projects merged.', 5000);
}

async function openLastProject() {
  const home = await RecordStore.ensureProject();

  // Reopen the last project if it still exists; otherwise fall back to
  // whatever the migration settled on.
  const list = await RecordStore.listProjects();
  const wanted = App.data.lastProjectId;
  const id = list.some(p => p.id === wanted) ? wanted : home;
  RecordStore.setCurrentProject(id);
  App.data.lastProjectId = id;

  // Pre-project accounts kept one scene and one collapse set at the
  // account level. Hand them to the project that just adopted their
  // content, so the first launch lands where the last one left off.
  if (App.data._legacyPlace && !App.data.places[id]) {
    const { openSceneId, collapsedIds } = App.data._legacyPlace;
    if (openSceneId || collapsedIds?.length) {
      App.data.places[id] = { openSceneId, section: 'manuscript', collapsedIds };
    }
  }
  delete App.data._legacyPlace;
  saveLocal();

  // Records orphaned onto a deleted project are invisible everywhere
  // and don't need a pull to be repaired — the damage is already local.
  const repaired = await RecordStore.reconcileAutoProjects();
  if (repaired) RecordStore.setCurrentProject(repaired);

  await renderProjectName();
  await railSection(place().section || 'manuscript');

  setTimeout(() => offerProjectMerge(), 1200);
}
