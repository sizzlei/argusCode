import './style.css';
import logoUrl from './assets/logo.svg';
import {
  api,
  backendReady,
  copyText,
  basename,
  dirname,
  inWails,
  isMac,
  join,
  onEvent,
  relative,
  SchemaTable,
} from './backend';
import { Explorer } from './explorer';
import {
  canFormat,
  DIALECTS,
  DialectId,
  formatText,
  LANGS,
  LangId,
  schemaNamespace,
  setDdlLint,
  setSqlKeywordCase,
  setSqlSchema,
} from './languages';
import { forceLinting, forEachDiagnostic } from '@codemirror/lint';
import { invalidateQuickOpen, quickOpen } from './quickopen';
import { SearchState, SearchView } from './search';
import { showEditorMenu } from './editormenu';
import { OutlineView } from './outline';
import { jsonMinify, jsonSortKeys, jsonToYaml, yamlSortKeys, yamlToJson } from './datatools';
import { pathAt } from './structure';
import { initDiff, openDiff } from './diff';
import { setNavigator, setSchemaIndex } from './sqltools';
import { ask, contextMenu, errText, h, isModalOpen, toast } from './ui';
import { DEFAULT_SETTINGS, GroupSession, Settings, Workbench } from './workbench';
import {
  comboOf,
  DEFAULT_KEYS,
  effectiveKeys,
  keyCapture,
  keymapOf,
  menuBindings,
  setBindings,
  setPlatform,
  shortcut,
} from './keybindings';
import { openSettings } from './settings';
import { checkForUpdates, initUpdates, isNewer, showReleaseNotes } from './update';

setPlatform(isMac);

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
  sidebarView: SideView;
  search: Partial<SearchState>;
  /** Version that last ran — release notes are shown once after an update. */
  lastVersion?: string;
  /** Time of the last automatic update check (ms). */
  lastUpdateCheck?: number;
}

const defaults: Session = {
  version: 1,
  root: '',
  expanded: [],
  supportedOnly: false,
  sidebarWidth: 250,
  sidebarVisible: true,
  settings: { ...DEFAULT_SETTINGS },
  editors: { groups: [], active: 0 },
  recentFolders: [],
  recentFiles: [],
  sidebarView: 'explorer',
  search: {},
};

let session: Session = structuredClone(defaults);

// ---- DOM skeleton ----------------------------------------------------------------

const sidebar = h('aside', { id: 'sidebar' });
const explorerPane = h('div', { class: 'side-pane' });
const searchPane = h('div', { class: 'side-pane search-view' });
type SideView = 'explorer' | 'search' | 'outline';
const outlinePane = h('div', { class: 'side-pane' });
const activityBtn = (view: SideView, title: string, d: string) => {
  const b = h('button', { class: 'activity-btn', title, onclick: () => showSidebarView(view, true) });
  b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  b.dataset.view = view;
  return b;
};
const activityBar = h(
  'div',
  { class: 'activity-bar' },
  activityBtn('explorer', '탐색기', 'M2.5 3.5h4l1.5 1.5h5.5v8h-11z'),
  activityBtn('search', '검색', 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.5 10.5 14 14'),
  activityBtn('outline', '개요', 'M3 4h10M5 8h8M5 12h8M3 8h.01M3 12h.01'),
);
sidebar.append(activityBar, explorerPane, searchPane, outlinePane);
const sideResizer = h('div', { class: 'resizer v', id: 'side-resizer' });
const editors = h('main', { id: 'editors' });
const statusbar = h('footer', { id: 'statusbar' });
document.getElementById('app')!.append(h('div', { id: 'workbench' }, sidebar, sideResizer, editors), statusbar);

let startupMs = 0;

function welcome(): HTMLElement {
  const action = (label: string, key: string, cmd: string) =>
    h(
      'button',
      { class: 'welcome-action', onclick: () => run(cmd) },
      h('span', {}, label),
      key ? h('kbd', {}, key) : null,
    );
  const recents = session.recentFolders.slice(0, 6);
  return h(
    'div',
    { class: 'welcome' },
    h('div', { class: 'welcome-logo' }, h('img', { class: 'logo', src: logoUrl, alt: '' }), 'ArgusCode'),
    h('div', { class: 'welcome-sub' }, 'SQL · Markdown · JSON · YAML · JS · Shell 을 위한 가벼운 편집기'),
    h(
      'div',
      { class: 'welcome-grid' },
      h(
        'div',
        {},
        h('h3', {}, '시작'),
        action('폴더 열기', shortcut('folder.open'), 'folder.open'),
        action('파일 열기', shortcut('file.open'), 'file.open'),
        action('새 SQL 파일', shortcut('file.new'), 'file.new'),
        action('빠른 열기', shortcut('quickOpen'), 'quickOpen'),
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
    startupMs
      ? h('div', { class: 'welcome-startup', title: '프로세스 시작부터 화면 준비까지' }, `시작 시간 ${startupMs}ms`)
      : null,
    h(
      'div',
      { class: 'welcome-keys' },
      keyHint('분할', 'pane.split'),
      keyHint('저장', 'file.save'),
      keyHint('정렬', 'format'),
      keyHint('MD 미리보기', 'md.preview'),
      keyHint('사이드바', 'sidebar.toggle'),
      keyHint('그룹 이동', 'pane.next'),
    ),
  );
}
const keyHint = (label: string, cmd: string) => {
  const k = shortcut(cmd);
  return k ? h('span', {}, label, ' ', h('kbd', {}, k)) : null;
};

const wb = new Workbench(editors, session.settings, welcome);

const explorer = new Explorer(explorerPane, {
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
    updateWatchSoon();
  },
  deleted: (p) => {
    wb.pathsRemoved(p);
    invalidateQuickOpen();
  },
});

// "Go to definition" from SQL: open the DDL file and select the name.
setNavigator(async (file, line, name) => {
  if (!session.root) return;
  const path = join(session.root, file);
  const tab = await wb.openPath(path);
  if (!tab) return;
  const doc = tab.group.view.state.doc;
  const ln = doc.line(Math.min(Math.max(1, line), doc.lines));
  const idx = ln.text.toLowerCase().indexOf(name.toLowerCase());
  await wb.reveal(path, ln.number, Math.max(0, idx), idx >= 0 ? name.length : 0);
});

const outlineView = new OutlineView(outlinePane, wb);
initDiff(wb);
wb.onCommand = (cmd) => run(cmd);
wb.reviewInfo = () => ({ path: session.settings.ddlRulesPath, count: ddl.count, errors: ddl.errors });
wb.copyText = (text) =>
  copyText(text).then(
    () => toast('DDL 검토 결과를 Markdown으로 복사했습니다.'),
    () => toast('복사하지 못했습니다.', 'error'),
  );

// Created in boot() once the saved search state is known.
let searchView: SearchView | null = null;

function showSidebarView(view: SideView, focus = false) {
  session.sidebarView = view;
  if (!session.sidebarVisible) toggleSidebar(true);
  explorerPane.style.display = view === 'explorer' ? '' : 'none';
  searchPane.style.display = view === 'search' ? '' : 'none';
  outlinePane.style.display = view === 'outline' ? '' : 'none';
  outlineView.visible = view === 'outline';
  if (outlineView.visible) outlineView.update(0);
  for (const b of activityBar.querySelectorAll<HTMLElement>('.activity-btn'))
    b.classList.toggle('active', b.dataset.view === view);
  if (focus && view === 'search') {
    const t = wb.activeTab;
    let sel = '';
    if (t) {
      const st = wb.stateOf(t);
      const r = st.selection.main;
      if (!r.empty && r.to - r.from < 200) sel = st.sliceDoc(r.from, r.to);
    }
    searchView?.focus(sel);
  } else if (focus) {
    (explorerPane.querySelector('.tree') as HTMLElement | null)?.focus();
  }
  saveSessionSoon();
}

// ---- file watching ---------------------------------------------------------------------

let watchTimer = 0;
function updateWatchSoon() {
  clearTimeout(watchTimer);
  watchTimer = window.setTimeout(() => {
    const dirs = session.settings.watch ? [...new Set([...explorer.visibleDirs(), ...wb.openDirs()])] : [];
    api.WatchDirs(dirs).catch(() => {});
  }, 300);
}

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
  updateWatchSoon();
  searchView?.refresh();
  scanSchemaSoon(0);
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

// ---- settings ------------------------------------------------------------------

function setFontFamily(f: string) {
  const root = document.documentElement.style;
  if (f) root.setProperty('--editor-font', `${f}, var(--font-mono)`);
  else root.removeProperty('--editor-font');
  for (const g of wb.groups) g.view.requestMeasure();
}

function applySetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  const st = session.settings;
  switch (key) {
    case 'fontSize':
      return setFontSize(value as number); // saves
    case 'indent':
      wb.setIndent(value as number);
      break;
    case 'wrap':
      wb.setWrap(value as boolean);
      break;
    case 'dialect':
      wb.setDialect(value as DialectId);
      relintDdl();
      break;
    case 'ddlRulesPath':
      st.ddlRulesPath = value as string;
      saveSessionSoon();
      return; // the settings dialog reloads the rules itself
    case 'whitespace':
      wb.setWhitespace(value as Settings['whitespace']);
      break;
    case 'fontFamily':
      st.fontFamily = value as string;
      setFontFamily(st.fontFamily);
      break;
    case 'sqlKeywordCase':
      st.sqlKeywordCase = value as Settings['sqlKeywordCase'];
      setSqlKeywordCase(st.sqlKeywordCase === 'upper');
      wb.refreshSqlLanguage();
      break;
    case 'watch':
      st.watch = value as boolean;
      updateWatchSoon();
      break;
    case 'theme':
      applyTheme(value as Settings['theme']);
      break;
    case 'keybindings':
      st.keybindings = value as Settings['keybindings'];
      applyKeybindings();
      break;
    case 'autoSave':
      st.autoSave = value as Settings['autoSave'];
      clearTimeout(autoSaveTimer);
      break;
    default:
      st[key] = value;
  }
  updateChrome();
  saveSessionSoon();
}

function showSettings() {
  openSettings({
    settings: session.settings,
    apply: applySetting,
    startupMs,
    ddl: {
      status: () => ({ path: session.settings.ddlRulesPath, count: ddl.count, errors: ddl.errors }),
      browse: () => api.OpenFileDialog().catch(() => ''),
      createTemplate: createDdlTemplate,
      open: (p) => void openFile(p),
      reload: () => loadDdlRules(true),
    },
    updates: {
      check: () => void checkForUpdates(true, autoCheck()),
      notes: () => void showReleaseNotes('v' + __APP_VERSION__, false),
    },
  });
}

// ---- DDL review -------------------------------------------------------------------

const ddl = { count: 0, errors: [] as string[], modTime: 0, path: '' };

const ddlDialect = () => {
  const d = session.settings.dialect;
  return d === 'postgresql' ? 'postgresql' : d === 'plsql' ? 'oracle' : 'mysql';
};

/** (Re)loads the ruleset from settings and installs the linter on SQL editors. */
async function loadDdlRules(force = false) {
  const path = session.settings.ddlRulesPath.trim();
  if (!path) {
    if (ddl.path || force) {
      Object.assign(ddl, { count: 0, errors: [], modTime: 0, path: '' });
      setDdlLint([]);
      wb.refreshSqlLanguage();
      updateStatus();
      wb.refreshReview();
    }
    return;
  }
  let text: string;
  let modTime = 0;
  try {
    const fc = await api.ReadFile(path);
    text = fc.content;
    modTime = (await api.Stat(path)).modTime;
  } catch (e) {
    Object.assign(ddl, { count: 0, errors: ['규칙 파일을 읽지 못했습니다: ' + errText(e)], modTime: 0, path });
    setDdlLint([]);
    wb.refreshSqlLanguage();
    updateStatus();
    wb.refreshReview();
    return;
  }
  if (!force && path === ddl.path && modTime === ddl.modTime) return;
  const m = await import('./ddlreview');
  const res = await m.loadRuleset(text);
  const hadErrors = ddl.errors.join('\n');
  Object.assign(ddl, { count: res.rules.length, errors: res.errors, modTime, path });
  setDdlLint(res.rules.length ? m.ddlLinter(res.rules, ddlDialect, scheduleStatus) : []);
  wb.refreshSqlLanguage();
  updateStatus();
  wb.refreshReview();
  if (res.errors.length && res.errors.join('\n') !== hadErrors)
    toast(`DDL 검토 규칙 오류 ${res.errors.length}개 — 설정 > DDL 검토에서 확인하세요`, 'error');
}

async function createDdlTemplate(): Promise<string | null> {
  const dir = await api.SettingsDir().catch(() => '');
  if (!dir) {
    toast('설정 폴더를 찾지 못했습니다.', 'error');
    return null;
  }
  const path = join(dir, 'ddl-rules.yaml');
  const st = await api.Stat(path).catch(() => null);
  if (!st?.exists) {
    const { templateYaml } = await import('./ddlreview');
    await api.WriteFile(path, templateYaml(), 'LF', false);
    toast('규칙 템플릿을 만들었습니다: ' + path);
  }
  return path;
}

/** Re-runs the DDL review (e.g. after the SQL dialect changed). */
function relintDdl() {
  if (ddl.count) for (const g of wb.groups) forceLinting(g.view);
}

function openProblems() {
  wb.toggleReview();
}

let statusTimer = 0;
function scheduleStatus() {
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    updateStatus();
    wb.refreshReview();
  }, 50);
}

// ---- auto save ----------------------------------------------------------------

let autoSaveTimer = 0;
let autoSaving = false;
/** Saves dirty documents that already have a file (never prompts for a path). */
async function autoSaveNow() {
  clearTimeout(autoSaveTimer);
  if (autoSaving || session.settings.autoSave === 'off' || isModalOpen()) return;
  autoSaving = true;
  try {
    for (const d of wb.allDocs())
      if (d.dirty && d.path && !d.missing && d.tabs.length) await wb.save(d.tabs[0], false, true);
  } finally {
    autoSaving = false;
  }
}

async function formatActive() {
  const t = wb.activeTab;
  if (!t) return;
  if (!canFormat(t.doc.lang)) {
    toast(`${LANGS[t.doc.lang].label} 문서는 자동 정렬을 지원하지 않습니다.`);
    return;
  }
  const st = wb.stateOf(t);
  const r = st.selection.main;
  const opts = {
    dialect: session.settings.dialect,
    indent: session.settings.indent,
    sqlStyle: session.settings.sqlStyle,
  };
  try {
    if (r.empty) {
      wb.replaceAll(t, await formatText(t.doc.lang, st.doc.toString(), opts));
      return;
    }
    // Format only the selection; keep it at its current indentation.
    const sel = st.sliceDoc(r.from, r.to);
    const line = st.doc.lineAt(r.from);
    const lead = /^[ \t]*/.exec(line.text)![0];
    const pad = r.from - line.from <= lead.length ? lead : ' '.repeat(r.from - line.from);
    let out = await formatText(t.doc.lang, sel, { ...opts, fragment: true });
    out = out
      .split('\n')
      .map((l, i) => (i === 0 || !l ? l : pad + l))
      .join('\n');
    if (/\n$/.test(sel) && !out.endsWith('\n')) out += '\n';
    const from = r.from + (r.from - line.from <= lead.length ? lead.length - (r.from - line.from) : 0);
    const v = t.group.view;
    v.dispatch({
      changes: { from: Math.min(from, r.to), to: r.to, insert: out.replace(/^[ \t]+/, '') },
      selection: { anchor: Math.min(from, r.to), head: Math.min(from, r.to) + out.replace(/^[ \t]+/, '').length },
      scrollIntoView: true,
    });
  } catch (e) {
    toast('정렬 실패: ' + errText(e), 'error');
  }
}

// ---- JSON / YAML tools ------------------------------------------------------------------

async function dataConvert() {
  const t = wb.activeTab;
  if (!t || (t.doc.lang !== 'json' && t.doc.lang !== 'yaml'))
    return toast('JSON 또는 YAML 문서에서 사용할 수 있습니다.');
  const text = wb.stateOf(t).doc.toString();
  const ind = session.settings.indent;
  try {
    const toYaml = t.doc.lang === 'json';
    const out = toYaml ? await jsonToYaml(text, ind) : await yamlToJson(text, ind);
    const base = t.doc.name.replace(/\.[^.]+$/, '');
    wb.newUntitled(wb.activeGroup, toYaml ? 'yaml' : 'json', base + (toYaml ? '.yaml' : '.json'), out);
  } catch (e) {
    toast(errText(e), 'error');
  }
}

/** Log command documents (DocumentDB profiler, MongoDB slow log …) → mongosh, in a new tab. */
async function mongoToShell() {
  const t = wb.activeTab;
  if (!t) return toast('변환할 로그나 명령을 붙여 넣은 문서를 먼저 여세요.');
  const st = wb.stateOf(t);
  const r = st.selection.main;
  const text = r.empty ? st.doc.toString() : st.sliceDoc(r.from, r.to);
  const [{ convertCommands }, { wrapLongLines }] = await Promise.all([import('./mongocmd'), import('./jswrap')]);
  const unit = ' '.repeat(session.settings.indent);
  const res = convertCommands(text, (c) => wrapLongLines(c, 100, unit));
  if (!res.converted) return toast('변환할 MongoDB / DocumentDB 명령을 찾지 못했습니다.', 'error');
  const base = t.doc.name.replace(/\.[^.]+$/, '');
  wb.newUntitled(wb.activeGroup, 'javascript', base + '.mongosh.js', res.text);
  toast(`${res.converted}개 명령을 변환했습니다` + (res.skipped ? ` (${res.skipped}줄 건너뜀)` : '') + '.');
}

async function dataTransform(kind: 'sort' | 'minify') {
  const t = wb.activeTab;
  if (!t || (t.doc.lang !== 'json' && t.doc.lang !== 'yaml'))
    return toast('JSON 또는 YAML 문서에서 사용할 수 있습니다.');
  const text = wb.stateOf(t).doc.toString();
  const ind = session.settings.indent;
  try {
    let out: string;
    if (kind === 'minify') out = jsonMinify(text);
    else out = t.doc.lang === 'json' ? jsonSortKeys(text, ind) : await yamlSortKeys(text, ind);
    wb.replaceAll(t, out);
  } catch (e) {
    toast(errText(e), 'error');
  }
}

// ---- SQL schema (DDL in the folder → completion) -----------------------------------

let schemaTables: SchemaTable[] = [];
let schemaTimer = 0;
function scanSchemaSoon(delay = 600) {
  clearTimeout(schemaTimer);
  schemaTimer = window.setTimeout(scanSchema, delay);
}
async function scanSchema(notify = false) {
  const root = session.root;
  try {
    schemaTables = root ? ((await api.ScanSchema(root)) ?? []) : [];
  } catch {
    return;
  }
  if (root !== session.root) return;
  setSqlSchema(schemaNamespace(schemaTables));
  setSchemaIndex(schemaTables);
  wb.refreshSqlLanguage();
  updateStatus();
  wb.refreshReview();
  if (notify) {
    const cols = schemaTables.reduce((n, t) => n + (t.columns?.length ?? 0), 0);
    toast(`DDL에서 테이블/뷰 ${schemaTables.length}개, 컬럼 ${cols}개를 읽었습니다.`);
  }
}

/** Asks about unsaved files and saves the session; false when cancelled. */
async function prepareQuit(): Promise<boolean> {
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
    if (!v) return false;
    if (v === 'save' && !(await wb.saveAll())) return false;
  }
  await saveSessionNow();
  return true;
}

async function confirmQuit() {
  if (await prepareQuit()) api.Quit();
}

const autoCheck = () => ({
  at: session.lastUpdateCheck ?? 0,
  save: (t: number) => {
    session.lastUpdateCheck = t;
    saveSessionSoon();
  },
});

/** After an update: release notes once. Then the periodic update check. */
function afterBoot() {
  initUpdates({ prepareQuit });
  const last = session.lastVersion;
  if (last !== __APP_VERSION__) {
    session.lastVersion = __APP_VERSION__;
    saveSessionSoon();
    if (last && isNewer(__APP_VERSION__, last)) void showReleaseNotes('v' + __APP_VERSION__, true);
  }
  // (Not in the browser preview: its mock always reports a newer version.)
  if (session.settings.updateCheck && inWails()) setTimeout(() => void checkForUpdates(false, autoCheck()), 4000);
}

// ---- commands -------------------------------------------------------------------------

const commands: Record<string, () => unknown> = {
  'app.settings': showSettings,
  'app.checkUpdate': () => checkForUpdates(true, autoCheck()),
  'problems.open': () => openProblems(),
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
  'view.explorer': () => showSidebarView('explorer', true),
  'view.search': () => showSidebarView('search', true),
  'view.outline': () => showSidebarView('outline', true),
  'pane.split': () => wb.split(),
  'pane.next': () => wb.focusNextGroup(),
  'md.preview': () => wb.togglePreview(),
  'plan.toggle': () => wb.togglePlan(),
  format: () => formatActive(),
  'data.convert': () => dataConvert(),
  'mongo.toShell': () => mongoToShell(),
  'data.sortKeys': () => dataTransform('sort'),
  'data.minify': () => dataTransform('minify'),
  'diff.saved': () => openDiff('saved'),
  'diff.tabs': () => openDiff('tabs'),
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
  if (keyCapture.active) return; // recording a shortcut in the settings
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

let keymap = keymapOf(DEFAULT_KEYS);

/** Switches the app colours (CSS variables), the editors and the native window. */
function applyTheme(theme: Settings['theme']) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('argus-theme', t);
  } catch {
    // storage unavailable — the session still has the theme
  }
  wb.setTheme(t);
  api.SetTheme(t).catch(() => {});
}

/** Applies the shortcut settings to the keydown handler, hints and the native menu. */
function applyKeybindings() {
  const keys = effectiveKeys(session.settings.keybindings);
  setBindings(keys);
  keymap = keymapOf(keys);
  api.SetKeybindings(menuBindings(keys)).catch(() => {});
  wb.refreshEmpty();
}

document.addEventListener(
  'keydown',
  (e) => {
    if (keyCapture.active) return;
    const combo = comboOf(e);
    if (!combo) return;
    const hit = keymap.get(combo);
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      run(hit);
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
        `줄 ${line.number}, 열 ${sel.head - line.from + 1}` + (selLen ? ` (${selLen}자 선택)` : ''),
        '커서 위치',
      ),
      statusItem(`공백 ${session.settings.indent}칸`, '들여쓰기', (e) =>
        contextMenu(
          e.clientX,
          e.clientY - 80,
          [2, 4].map((n) => ({
            label: (n === session.settings.indent ? '✓ ' : '') + `공백 ${n}칸`,
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
      statusItem(session.settings.wrap ? '자동 줄바꿈' : '줄바꿈 없음', '자동 줄바꿈 켜기/끄기', () => {
        wb.setWrap(!session.settings.wrap);
        saveSessionSoon();
      }),
    );
    if (doc.lang === 'sql') {
      right.append(
        statusItem(
          `⛁ ${schemaTables.length}`,
          session.root
            ? `폴더의 DDL에서 찾은 테이블/뷰 ${schemaTables.length}개 — 자동완성에 사용 (클릭: 다시 읽기)`
            : '폴더를 열면 DDL(.sql)의 테이블/컬럼을 자동완성에 사용합니다',
          () => scanSchema(true),
        ),
      );
      right.append(
        statusItem(
          DIALECTS[session.settings.dialect].label,
          'SQL 방언',
          (e) =>
            contextMenu(e.clientX, e.clientY - 190, [
              ...(Object.keys(DIALECTS) as DialectId[]).map((d) => ({
                label: (d === session.settings.dialect ? '✓ ' : '') + DIALECTS[d].label,
                action: () => {
                  wb.setDialect(d);
                  relintDdl();
                  saveSessionSoon();
                },
              })),
              { separator: true, label: '' },
              ...(
                [
                  ['left', '정렬: 왼쪽 정렬 (SELECT 줄바꿈)'],
                  ['river', '정렬: River (키워드 오른쪽 정렬)'],
                ] as const
              ).map(([v, label]) => ({
                label: (session.settings.sqlStyle === v ? '✓ ' : '') + label,
                action: () => {
                  session.settings.sqlStyle = v;
                  saveSessionSoon();
                },
              })),
            ]),
          'accent',
        ),
      );
    }
    if (doc.lang === 'sql' && (ddl.count || ddl.errors.length)) {
      if (!ddl.count) right.append(statusItem('DDL 규칙 오류', ddl.errors.join('\n'), () => showSettings(), 'warn'));
      else {
        const n = { error: 0, warning: 0, info: 0, hint: 0 };
        forEachDiagnostic(st, (d) => {
          if (d.source === 'DDL 검토') n[d.severity]++;
        });
        const total = n.error + n.warning + n.info;
        const label = total
          ? 'DDL ' +
            [n.error && `✕ ${n.error}`, n.warning && `⚠ ${n.warning}`, n.info && `ⓘ ${n.info}`]
              .filter(Boolean)
              .join(' ')
          : 'DDL ✓';
        right.append(
          statusItem(
            label,
            total
              ? `DDL 검토: 오류 ${n.error} · 경고 ${n.warning} · 정보 ${n.info} (클릭: 검토 패널)`
              : `DDL 검토 규칙 ${ddl.count}개 — 위반 없음`,
            () => openProblems(),
            n.error ? 'error' : n.warning ? 'warn' : '',
          ),
        );
      }
    }
    if ((doc.lang === 'json' || doc.lang === 'yaml') && !doc.large) {
      const p = pathAt(st, doc.lang, sel.head);
      if (p && p !== '$')
        right.append(
          statusItem(
            p.length > 48 ? '…' + p.slice(-47) : p,
            `${p}\n클릭하면 경로를 복사합니다`,
            () => {
              copyText(p).then(
                () => toast('경로를 복사했습니다: ' + p),
                () => toast('복사하지 못했습니다.', 'error'),
              );
            },
            'path',
          ),
        );
    }
    if (doc.large)
      right.append(statusItem('대용량 모드', '3MB가 넘는 파일은 하이라이트·문법 검사 없이 엽니다', undefined, 'warn'));
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
  if (what !== 'edit') outlineView.update(what === 'cursor' ? 300 : 50);
  if (what === 'cursor') {
    cancelAnimationFrame(statusRaf);
    statusRaf = requestAnimationFrame(updateStatus);
    return;
  }
  if (what === 'edit') {
    if (session.settings.autoSave === 'delay') {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = window.setTimeout(autoSaveNow, 1000);
    }
    return;
  }
  if (what === 'saved') {
    if (session.settings.ddlRulesPath && wb.activeTab?.doc.path === session.settings.ddlRulesPath) loadDdlRules();
    explorer.refresh();
    invalidateQuickOpen();
    if (wb.activeTab?.doc.lang === 'sql') scanSchemaSoon();
    return;
  }
  updateChrome();
  if (what === 'tabs' || what === 'active') saveSessionSoon();
  if (what === 'tabs') updateWatchSoon();
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
  if (searchView) session.search = searchView.state;
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
  onEvent('fs:changed', (paths: string[]) => {
    const set = new Set(paths ?? []);
    explorer.refreshDirs(set);
    wb.checkDisk(set);
    invalidateQuickOpen();
    if (session.sidebarView === 'search' && session.sidebarVisible) searchView?.refresh();
    if ([...set].some((p) => /\.(sql|ddl)$/i.test(p))) scanSchemaSoon();
  });
}

let focusTimer = 0;
window.addEventListener('focus', () => {
  clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => {
    loadDdlRules(); // picks up edits made to the rules file elsewhere
    wb.checkDisk();
    explorer.refresh();
    invalidateQuickOpen();
  }, 100);
});
window.addEventListener('blur', () => {
  if (session.settings.autoSave === 'blur') autoSaveNow();
});
// Leaving an editor (e.g. clicking the sidebar or another group) also counts.
document.addEventListener('focusout', (e) => {
  if (session.settings.autoSave !== 'blur') return;
  const from = e.target as HTMLElement;
  const to = e.relatedTarget as HTMLElement | null;
  if (from.closest?.('.cm-editor') && from.closest('.cm-editor') !== to?.closest?.('.cm-editor')) autoSaveNow();
});
window.addEventListener('beforeunload', () => {
  saveSessionNow();
});
document.addEventListener('contextmenu', (e) => {
  const target = e.target as HTMLElement;
  // Text inputs keep the native menu (copy/paste in search boxes).
  if (target.closest('input')) return;
  e.preventDefault();
  // Editor: our Korean menu instead of the WebView's English one.
  const g = wb.groups.find((x) => x.view.dom.contains(target) && !target.closest('.cm-gutters, .cm-panels'));
  if (g?.active) {
    wb.setActiveGroup(g);
    showEditorMenu(g.view, e, {
      langOf: (v) => wb.groups.find((x) => x.view === v)?.active?.doc.lang ?? null,
      run,
    });
  }
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
  setFontFamily(session.settings.fontFamily);
  setSqlKeywordCase(session.settings.sqlKeywordCase === 'upper');
  wb.setWhitespace(session.settings.whitespace);
  applyTheme(session.settings.theme);
  applyKeybindings();
  loadDdlRules();
  explorer.supportedOnly = session.supportedOnly;
  searchView = new SearchView(searchPane, wb, () => session.root, session.search, saveSessionSoon);
  showSidebarView(['search', 'outline'].includes(session.sidebarView) ? session.sidebarView : 'explorer');
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
  updateChrome();
  updateWatchSoon();
  if (session.root) scanSchemaSoon(0);
  requestAnimationFrame(async () => {
    startupMs = await api.StartupMillis().catch(() => 0);
    console.info(`[ArgusCode] ready in ${startupMs} ms`);
    wb.refreshEmpty();
    afterBoot();
  });
}

boot().catch((e) => toast('초기화 실패: ' + errText(e), 'error'));
