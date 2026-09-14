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
  readOnly: false,
};

// ── Default state ──────────────────────────────────────────────────

function defaultData() {
  return {
    authMethod:   'guest',
    userToken:    Auth.generateToken(),
    workerUrl:    '',
    linkedGoogle: null,
    firstName: '', lastName: '', username: '',
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
    firstName: d.firstName, lastName: d.lastName, username: d.username,
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
      onOpen: () => { setCollapsed(book.id, !collapsed); renderTree(); },
    });
    partRow.prepend(el('span', 'caret', collapsed ? '\u25B8' : '\u25BE'));
    toc.append(partRow);
    if (collapsed) continue;

    for (const ch of book.chapters) toc.append(...chapterRows(ch, 'toc-chapter'));

    const addCh = el('button', 'toc-add toc-add-chapter', '+ chapter');
    addCh.addEventListener('click', async () => {
      await RecordStore.createChapter(book.id);
      renderTree();
    });
    toc.append(addCh);
  }

  // Chapters with no part. Parts are optional — see createChapter().
  for (const ch of App.tree.looseChapters) toc.append(...chapterRows(ch, 'toc-chapter loose'));

  if (App.tree.unfiled.length) {
    toc.append(el('div', 'toc-group-label', 'Unplaced'));
    for (const sc of App.tree.unfiled) toc.append(sceneRow(sc));
  }

  const addLoose = el('button', 'toc-add toc-add-chapter', '+ chapter');
  addLoose.addEventListener('click', async () => {
    await RecordStore.createChapter(null);
    renderTree();
  });
  toc.append(addLoose);

  const addScene = el('button', 'toc-add toc-add-chapter', '+ scene');
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
    onOpen: () => { setCollapsed(ch.id, !collapsed); renderTree(); },
  });
  row.prepend(el('span', 'caret', collapsed ? '\u25B8' : '\u25BE'));
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
    if (App.data.typewriter) centerCursor();
  });
  return App.editor;
}

// Typewriter scrolling: keep the caret near the vertical middle instead of
// letting it walk to the bottom edge of the window.
function centerCursor() {
  const cm = App.editor?.codemirror;
  if (!cm) return;
  const cursor = cm.cursorCoords(null, 'local');
  const target = cm.getScrollInfo().clientHeight / 2;
  const sheet = $('sheet');
  const rect = $('prose').getBoundingClientRect();
  sheet.scrollTop += (cursor.top + rect.top) - target - sheet.getBoundingClientRect().top;
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
  openModal('modal-settings');
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
    pushToWorker:  () => Sync.flush(),
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
  $('btn-contents').addEventListener('click', toggleRail);
  $('scrim').addEventListener('click', closeRail);
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => closeModal('modal-settings'));

  // Creating a part immediately opens its name for editing — a structural
  // level you can't name is worse than no button at all.
  $('btn-new-part').addEventListener('click', async () => {
    const id = await RecordStore.createBook('Untitled part');
    await renderTree();
    const label = document.querySelector(`[data-id="${id}"] .toc-title`);
    if (label) startRename(label, 'book', id, 'Untitled part');
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
  $('set-typewriter').addEventListener('change', e => {
    App.data.typewriter = e.target.checked;
    saveAccount();
  });
  $('set-worker').addEventListener('change', e => {
    App.data.workerUrl = e.target.value.trim().replace(/\/+$/, '');
    saveLocal();
    showToast(App.data.workerUrl ? 'Worker address saved.' : 'Sync turned off.');
  });
  $('btn-sync-now').addEventListener('click', async () => {
    await flushActiveScene();
    const r = await Sync.flush();
    await Sync.pull();
    await renderTree();
    showToast(r.ok ? 'Synced.' : 'Sync incomplete — will retry.');
  });

  $('confirm-cancel-btn').addEventListener('click', () => closeModal('modal-confirm'));
  $('confirm-ok-btn').addEventListener('click', () => {
    closeModal('modal-confirm');
    const fn = _confirmHandler; _confirmHandler = null;
    if (fn) fn();
  });

  // Esc closes the topmost open modal.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    for (const id of ['modal-confirm', 'modal-settings', 'modal-account-setup']) {
      if (!$(id).hidden) { closeModal(id); return; }
    }
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
