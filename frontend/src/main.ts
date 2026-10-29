import './style.css';
import { api, backendReady, basename, dirname, inWails, isMac, onEvent, relative } from './backend';
import { Explorer } from './explorer';
import { canFormat, DIALECTS, DialectId, formatText, LANGS, LangId } from './languages';
import { invalidateQuickOpen, quickOpen } from './quickopen';
import { ask, contextMenu, errText, h, isModalOpen, toast } from './ui';
import { GroupSession, Settings, Workbench } from './workbench';

// ---- session model -----------------------------------------------------------

interface Session {
  version: 1;
  root: string;
  expanded: string[];
  supportedOnly: boolean;
  sidebarWidth: number;
  sidebarVisible: boolean;
  settings: Settings;
  editors: { groups: GroupSession[]; active: number };
  recentFolders: string[];
  recentFiles: string[];
}

const defaults: Session = {
  version: 1,
  root: '',
  expanded: [],
  supportedOnly: false,
  sidebarWidth: 250,
  sidebarVisible: true,
  settings: { dialect: 'mysql', indent: 2, wrap: false, fontSize: 13 },
  editors: { groups: [], active: 0 },
  recentFolders: [],
  recentFiles: [],
};

let session: Session = structuredClone(defaults);

// ---- DOM skeleton ----------------------------------------------------------------

const sidebar = h('aside', { id: 'sidebar' });
const sideResizer = h('div', { class: 'resizer v', id: 'side-resizer' });
const editors = h('main', { id: 'editors' });
const statusbar = h('footer', { id: 'statusbar' });
document.getElementById('app')!.append(h('div', { id: 'workbench' }, sidebar, sideResizer, editors), statusbar);

/** Formats a shortcut for display, e.g. key('shift', 'O') → ⇧⌘O / Ctrl+Shift+O. */
function key(...parts: string[]): string {
  const k = parts.pop()!;
  if (isMac) {
    const sym: Record<string, string> = { shift: '⇧', alt: '⌥' };
    return parts.map((p) => sym[p]).join('') + (parts.includes('nomod') ? '' : '⌘') + k;
  }
  const name: Record<string, string> = { shift: 'Shift+', alt: 'Alt+' };
  return (parts.includes('nomod') ? '' : 'Ctrl+') + parts.map((p) => name[p] ?? '').join('') + k;
}

function welcome(): HTMLElement {
  const action = (label: string, key: string, cmd: string) =>
    h('button', { class: 'welcome-action', onclick: () => run(cmd) }, h('span', {}, label), h('kbd', {}, key));
  const recents = session.recentFolders.slice(0, 6);
  return h(
    'div',
    { class: 'welcome' },
    h('div', { class: 'welcome-logo' }, h('span', { class: 'eye' }), 'ArgusCode'),
    h('div', { class: 'welcome-sub' }, 'SQL · Markdown · JSON · YAML 을 위한 가벼운 편집기'),
    h(
      'div',
      { class: 'welcome-grid' },
      h(
        'div',
        {},
        h('h3', {}, '시작'),
        action('폴더 열기', key('shift', 'O'), 'folder.open'),
        action('파일 열기', key('O'), 'file.open'),
        action('새 SQL 파일', key('N'), 'file.new'),
        action('빠른 열기', key('P'), 'quickOpen'),
      ),
      h(
        'div',
        {},
        h('h3', {}, '최근 폴더'),
        recents.length
          ? h(
              'div',
              { class: 'recent-list' },
              ...recents.map((p) =>
                h(
                  'button',
                  { class: 'recent', title: p, onclick: () => openFolder(p) },
                  h('span', { class: 'recent-name' }, basename(p)),
                  h('span', { class: 'recent-path' }, dirname(p)),
                ),
              ),
            )
          : h('p', { class: 'muted' }, '아직 없습니다.'),
      ),
    ),
    h(
      'div',
      { class: 'welcome-keys' },
      keyHint('분할', key('\\')),
      keyHint('저장', key('S')),
      keyHint('정렬', key('nomod', 'shift', 'alt', 'F')),
      keyHint('MD 미리보기', key('shift', 'V')),
      keyHint('사이드바', key('B')),
      keyHint('그룹 이동', key('K')),
    ),
  );
}
const keyHint = (label: string, key: string) => h('span', {}, label, ' ', h('kbd', {}, key));

const wb = new Workbench(editors, session.settings, welcome);

const explorer = new Explorer(sidebar, {
  open: (p, keepFocus) => openFile(p, !keepFocus),
  renamed: (o, n) => {
    wb.pathRenamed(o, n);
    invalidateQuickOpen();
    saveSessionSoon();
  },
  openFolder: () => run('folder.open'),
  changed: () => {
    invalidateQuickOpen();
    saveSessionSoon();
  },
});

// ---- actions -------------------------------------------------------------------------

async function openFile(path: string, focus = true) {
  const t = await wb.openPath(path, wb.activeGroup, focus);
  if (t) {
    session.recentFiles = [path, ...session.recentFiles.filter((p) => p !== path)].slice(0, 30);
    saveSessionSoon();
  }
}

async function openFolder(path: string) {
  session.root = path;
  session.recentFolders = [path, ...session.recentFolders.filter((p) => p !== path)].slice(0, 10);
  wb.root = path;
  await explorer.setRoot(path, session.expanded);
  invalidateQuickOpen();
  if (!session.sidebarVisible) toggleSidebar(true);
  wb.refreshEmpty();
  updateChrome();
  saveSessionSoon();
}

function toggleSidebar(force?: boolean) {
  session.sidebarVisible = force ?? !session.sidebarVisible;
  sidebar.style.display = session.sidebarVisible ? '' : 'none';
  sideResizer.style.display = session.sidebarVisible ? '' : 'none';
  saveSessionSoon();
}

function setFontSize(px: number) {
  session.settings.fontSize = Math.min(28, Math.max(9, px));
  document.documentElement.style.setProperty('--editor-font-size', session.settings.fontSize + 'px');
  for (const g of wb.groups) g.view.requestMeasure();
  saveSessionSoon();
}

async function formatActive() {
  const t = wb.activeTab;
  if (!t) return;
  if (!canFormat(t.doc.lang)) {
    toast(`${LANGS[t.doc.lang].label} 문서는 자동 정렬을 지원하지 않습니다.`);
    return;
  }
  try {
    const out = await formatText(t.doc.lang, wb.stateOf(t).doc.toString(), {
      dialect: session.settings.dialect,
      indent: session.settings.indent,
    });
    wb.replaceAll(t, out);
  } catch (e) {
    toast('정렬 실패: ' + errText(e), 'error');
  }
}

async function confirmQuit() {
  const dirty = wb.allDocs().filter((d) => d.dirty);
  if (dirty.length) {
    const v = await ask(
      '저장하지 않은 파일',
      `${dirty.length}개 파일에 저장하지 않은 변경 사항이 있습니다: ${dirty.map((d) => d.name).join(', ')}`,
      [
        { label: '모두 저장', value: 'save', primary: true },
        { label: '저장 안 함', value: 'discard', danger: true },
        { label: '취소', value: '' },
      ],
    );
    if (!v) return;
    if (v === 'save' && !(await wb.saveAll())) return;
  }
  await saveSessionNow();
  api.Quit();
}

// ---- commands -------------------------------------------------------------------------

const commands: Record<string, () => unknown> = {
  'file.new': () => wb.newUntitled(),
  'file.open': async () => {
    const p = await api.OpenFileDialog();
    if (p) openFile(p);
  },
  'folder.open': async () => {
    const p = await api.OpenFolderDialog();
    if (p) openFolder(p);
  },
  'file.save': () => wb.save(),
  'file.saveAs': () => wb.save(wb.activeTab, true),
  'file.saveAll': () => wb.saveAll(),
  'tab.close': () => {
    const t = wb.activeTab;
    if (t) wb.closeTab(t);
  },
  'tab.next': () => cycleTab(1),
  'tab.prev': () => cycleTab(-1),
  quickOpen: () =>
    quickOpen(
      session.root,
      (p) => openFile(p),
      session.recentFiles
        .filter((p) => p.startsWith(session.root))
        .map((p) => relative(session.root, p).split('\\').join('/')),
    ),
  'sidebar.toggle': () => toggleSidebar(),
  'pane.split': () => wb.split(),
  'pane.next': () => wb.focusNextGroup(),
  'md.preview': () => wb.togglePreview(),
  format: () => formatActive(),
  'zoom.in': () => setFontSize(session.settings.fontSize + 1),
  'zoom.out': () => setFontSize(session.settings.fontSize - 1),
  'zoom.reset': () => setFontSize(13),
};

function cycleTab(dir: number) {
  const g = wb.activeGroup;
  if (g.tabs.length < 2 || !g.active) return;
  const i = g.tabs.indexOf(g.active);
  wb.activate(g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
}

// Menu accelerators and the keydown fallback can both fire for one keystroke
// (depending on platform); run each command at most once per 150 ms.
const lastRun = new Map<string, number>();
function run(cmd: string) {
  if (isModalOpen() && cmd !== 'file.save') return;
  const now = performance.now();
  if (now - (lastRun.get(cmd) ?? -1e9) < 150) return;
  lastRun.set(cmd, now);
  const fn = commands[cmd];
  if (!fn) return;
  Promise.resolve()
    .then(fn)
    .catch((e) => toast(errText(e), 'error'));
}

const keymap: [string, string][] = [
  ['mod+n', 'file.new'],
  ['mod+o', 'file.open'],
  ['mod+shift+o', 'folder.open'],
  ['mod+s', 'file.save'],
  ['mod+shift+s', 'file.saveAs'],
  ['mod+alt+s', 'file.saveAll'],
  ['mod+w', 'tab.close'],
  ['mod+p', 'quickOpen'],
  ['mod+b', 'sidebar.toggle'],
  ['mod+\\', 'pane.split'],
  ['mod+k', 'pane.next'],
  ['mod+shift+v', 'md.preview'],
  ['shift+alt+f', 'format'],
  ['mod+=', 'zoom.in'],
  ['mod++', 'zoom.in'],
  ['mod+-', 'zoom.out'],
  ['mod+0', 'zoom.reset'],
  ['ctrl+tab', 'tab.next'],
  ['ctrl+shift+tab', 'tab.prev'],
];

function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (isMac && e.ctrlKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  let key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  // Use the physical key for letters/digits so Alt/Shift/Korean IME don't change it.
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === 'Backslash') key = '\\';
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'Minus') key = '-';
  parts.push(key);
  // ctrl+tab on Windows comes through as "mod+tab"
  const combo = parts.join('+');
  return !isMac ? combo.replace(/^mod\+(shift\+)?tab$/, 'ctrl+$1tab') : combo;
}

document.addEventListener(
  'keydown',
  (e) => {
    const combo = comboOf(e);
    const hit = keymap.find(([k]) => k === combo);
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      run(hit[1]);
      return;
    }
    // Cmd/Ctrl+1..4 focus editor groups.
    const m = /^mod\+([1-4])$/.exec(combo);
    if (m) {
      const g = wb.groups[+m[1] - 1];
      if (g) {
        e.preventDefault();
        wb.setActiveGroup(g);
        g.view.focus();
      }
    }
  },
  true,
);

// ---- status bar & title -------------------------------------------------------------

function statusItem(text: string, title: string, onclick?: (e: MouseEvent) => void, cls = '') {
  return h(onclick ? 'button' : 'span', { class: 'sb-item ' + cls, title, onclick }, text);
}

function updateStatus() {
  const t = wb.activeTab;
  const left = h(
    'div',
    { class: 'sb-left' },
    statusItem(session.root ? '⌂ ' + basename(session.root) : '폴더 없음', session.root || '폴더 열기', () =>
      run('folder.open'),
    ),
  );
  const right = h('div', { class: 'sb-right' });
  if (t) {
    const st = wb.stateOf(t);
    const sel = st.selection.main;
    const line = st.doc.lineAt(sel.head);
    const selLen = st.selection.ranges.reduce((n, r) => n + r.to - r.from, 0);
    const doc = t.doc;
    right.append(
      statusItem(
        `Ln ${line.number}, Col ${sel.head - line.from + 1}` + (selLen ? ` (${selLen} 선택)` : ''),
        '커서 위치',
      ),
      statusItem(`Spaces: ${session.settings.indent}`, '들여쓰기', (e) =>
        contextMenu(
          e.clientX,
          e.clientY - 80,
          [2, 4].map((n) => ({
            label: (n === session.settings.indent ? '✓ ' : '') + `Spaces ${n}`,
            action: () => {
              wb.setIndent(n);
              saveSessionSoon();
            },
          })),
        ),
      ),
      statusItem('UTF-8' + (doc.bom ? ' BOM' : ''), '인코딩 (클릭: BOM 전환)', () => {
        doc.bom = !doc.bom;
        markEncodingChange();
      }),
      statusItem(doc.eol, '줄바꿈 (클릭: LF/CRLF 전환)', () => {
        doc.eol = doc.eol === 'LF' ? 'CRLF' : 'LF';
        markEncodingChange();
      }),
      statusItem(session.settings.wrap ? 'Wrap' : 'No Wrap', '자동 줄바꿈', () => {
        wb.setWrap(!session.settings.wrap);
        saveSessionSoon();
      }),
    );
    if (doc.lang === 'sql') {
      right.append(
        statusItem(
          DIALECTS[session.settings.dialect].label,
          'SQL 방언',
          (e) =>
            contextMenu(
              e.clientX,
              e.clientY - 120,
              (Object.keys(DIALECTS) as DialectId[]).map((d) => ({
                label: (d === session.settings.dialect ? '✓ ' : '') + DIALECTS[d].label,
                action: () => {
                  wb.setDialect(d);
                  saveSessionSoon();
                },
              })),
            ),
          'accent',
        ),
      );
    }
    right.append(
      statusItem(LANGS[doc.lang].label, '언어 모드', (e) =>
        contextMenu(
          e.clientX,
          e.clientY - 140,
          (Object.keys(LANGS) as LangId[]).map((l) => ({
            label: (l === doc.lang ? '✓ ' : '') + LANGS[l].label,
            action: () => wb.setLanguage(t, l),
          })),
        ),
      ),
    );
  }
  statusbar.replaceChildren(left, right);
}

/** BOM / EOL changes make the document "dirty" even without text edits. */
function markEncodingChange() {
  const t = wb.activeTab;
  if (!t) return;
  wb.markMetaDirty(t.doc);
}

function updateTitle() {
  const t = wb.activeTab;
  const parts = [];
  if (t) parts.push((t.doc.dirty ? '● ' : '') + t.doc.name);
  if (session.root) parts.push(basename(session.root));
  parts.push('ArgusCode');
  const title = parts.join(' — ');
  document.title = title;
  (window as any).runtime?.WindowSetTitle?.(title);
}

function updateChrome() {
  updateStatus();
  updateTitle();
  explorer.setActive(wb.activeTab?.doc.path ?? null);
}

let statusRaf = 0;
wb.on((what) => {
  if (what === 'cursor') {
    cancelAnimationFrame(statusRaf);
    statusRaf = requestAnimationFrame(updateStatus);
    return;
  }
  if (what === 'saved') {
    explorer.refresh();
    invalidateQuickOpen();
    return;
  }
  updateChrome();
  if (what === 'tabs' || what === 'active') saveSessionSoon();
});

// ---- sidebar resize --------------------------------------------------------------------

sideResizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sideResizer.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startW = sidebar.offsetWidth;
  const move = (ev: PointerEvent) => {
    session.sidebarWidth = Math.min(600, Math.max(160, startW + ev.clientX - startX));
    sidebar.style.width = session.sidebarWidth + 'px';
  };
  const up = () => {
    sideResizer.removeEventListener('pointermove', move);
    sideResizer.removeEventListener('pointerup', up);
    saveSessionSoon();
  };
  sideResizer.addEventListener('pointermove', move);
  sideResizer.addEventListener('pointerup', up);
});

// ---- session persistence --------------------------------------------------------------

let saveTimer = 0;
function collectSession(): Session {
  session.expanded = [...explorer.expanded];
  session.supportedOnly = explorer.supportedOnly;
  session.editors = wb.session();
  return session;
}
function saveSessionSoon() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSessionNow, 800);
}
async function saveSessionNow() {
  clearTimeout(saveTimer);
  try {
    await api.SaveSession(JSON.stringify(collectSession()));
  } catch {
    /* ignore */
  }
}

// ---- backend events --------------------------------------------------------------------

function bindBackendEvents() {
  onEvent('cmd', (cmd: string) => run(cmd));
  onEvent('app:before-close', () => confirmQuit());
  onEvent('app:file-drop', async (paths: string[]) => {
    for (const p of paths ?? []) {
      if (await api.IsDir(p)) {
        await openFolder(p);
      } else {
        await openFile(p);
      }
    }
  });
}

let focusTimer = 0;
window.addEventListener('focus', () => {
  clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => {
    wb.checkDisk();
    explorer.refresh();
    invalidateQuickOpen();
  }, 100);
});
window.addEventListener('beforeunload', () => {
  saveSessionNow();
});
document.addEventListener('contextmenu', (e) => {
  // Suppress the default webview menu except inside the editor text.
  if (!(e.target as HTMLElement).closest('.cm-content, input')) e.preventDefault();
});

// ---- boot ---------------------------------------------------------------------------------

async function boot() {
  await backendReady();
  bindBackendEvents();
  try {
    const raw = await api.LoadSession();
    if (raw) {
      const s = JSON.parse(raw);
      session = { ...structuredClone(defaults), ...s, settings: { ...defaults.settings, ...(s.settings ?? {}) } };
    }
  } catch {
    session = structuredClone(defaults);
  }
  Object.assign(wb.settings, session.settings);
  session.settings = wb.settings;
  sidebar.style.width = session.sidebarWidth + 'px';
  toggleSidebar(session.sidebarVisible);
  setFontSize(session.settings.fontSize);
  explorer.supportedOnly = session.supportedOnly;
  document.body.classList.toggle('mac', isMac);

  const start = await api.StartPath().catch(() => '');
  if (start) {
    if (await api.IsDir(start)) {
      session.editors = { groups: [], active: 0 };
      await openFolder(start);
    } else {
      if (session.root) await openFolder(session.root);
      await openFile(start);
    }
  } else {
    if (session.root && (await api.IsDir(session.root))) {
      wb.root = session.root;
      await explorer.setRoot(session.root, session.expanded);
    } else {
      session.root = '';
    }
    await wb.restore(session.editors);
  }
  if (!inWails() && !session.root) await openFolder('/demo');
  wb.layout();
  wb.refreshEmpty();
  updateChrome();
}

boot().catch((e) => toast('초기화 실패: ' + errText(e), 'error'));
