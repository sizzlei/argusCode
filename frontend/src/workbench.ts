// The editor area: documents, tabs, editor groups (split panes).
//
// Model
//   Doc   – one file (or untitled buffer). Owns the "saved" snapshot.
//   Tab   – a Doc shown inside a Group. Each Tab keeps its own EditorState
//           (own undo history, selection, scroll). Tabs of the same Doc in
//           different groups are kept in sync change-by-change.
//   Group – a pane with a tab bar and ONE EditorView; switching tabs swaps
//           the view's state, which keeps memory and DOM cost low.

import { Annotation, EditorState, Text, Transaction, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { api, copyText, basename, dirname, isMac } from './backend';
import {
  createState,
  langComp,
  indentComp,
  wrapComp,
  wsComp,
  indentExtension,
  whitespaceExtension,
  Whitespace,
} from './editor';
import { DialectId, LangId, LANGS, langForName, languageExtension, extOf, onLanguageLoaded } from './languages';
import { ask, contextMenu, errText, h, toast } from './ui';
import { markUnopenable } from './filetypes';

const remote = Annotation.define<boolean>();
const MAX_GROUPS = 4;

export interface Settings {
  dialect: DialectId;
  indent: number;
  wrap: boolean;
  fontSize: number;
  /** SQL format layout: keywords at the left margin, or right-aligned river. */
  sqlStyle: 'left' | 'river';
  /** Editor font family; empty = the built-in monospace stack. */
  fontFamily: string;
  whitespace: Whitespace;
  /** Case of keywords inserted by SQL autocomplete. */
  sqlKeywordCase: 'upper' | 'lower';
  trimTrailing: boolean;
  finalNewline: boolean;
  autoSave: 'off' | 'delay' | 'blur';
  /** Files above this size (MB) open in plain-text large-file mode. */
  largeFileMB: number;
  /** Reload files changed on disk by other programs. */
  watch: boolean;
  /** YAML ruleset for the DDL review ('' = off). */
  ddlRulesPath: string;
}

export const DEFAULT_SETTINGS: Settings = {
  dialect: 'mysql',
  indent: 2,
  wrap: false,
  fontSize: 13,
  sqlStyle: 'left',
  fontFamily: '',
  whitespace: 'none',
  sqlKeywordCase: 'upper',
  trimTrailing: false,
  finalNewline: false,
  autoSave: 'off',
  largeFileMB: 3,
  watch: true,
  ddlRulesPath: '',
};

export interface GroupSession {
  tabs: string[];
  active: string | null;
  flex: number;
}

let docSeq = 0;
let untitledSeq = 0;
let groupSeq = 0;

export class Doc {
  id = ++docSeq;
  eol: 'LF' | 'CRLF' = 'LF';
  bom = false;
  modTime = 0;
  dirty = false;
  /** Set when EOL/BOM changed: dirty even though the text is unchanged. */
  metaDirty = false;
  /** Large-file mode: no syntax highlighting / linting (set at open). */
  large = false;
  missing = false;
  tabs: Tab[] = [];
  constructor(
    public path: string | null,
    public name: string,
    public lang: LangId,
    public saved: Text,
  ) {}
}

export class Tab {
  state!: EditorState;
  scrollTop = 0;
  scrollLeft = 0;
  constructor(
    public doc: Doc,
    public group: Group,
  ) {}
}

export class Group {
  id = ++groupSeq;
  tabs: Tab[] = [];
  active: Tab | null = null;
  flex = 1;
  previewOn = false;
  /** Execution-plan panel (takes precedence over the Markdown preview). */
  planOn = false;
  /** DDL review panel (SQL documents). */
  reviewOn = false;
  el: HTMLElement;
  tabbar: HTMLElement;
  body: HTMLElement;
  host: HTMLElement;
  preview: HTMLElement;
  empty: HTMLElement;
  view: EditorView;

  constructor() {
    this.tabbar = h('div', { class: 'tabbar' });
    this.host = h('div', { class: 'cm-host' });
    this.preview = h('div', { class: 'md-preview markdown-body' });
    this.empty = h('div', { class: 'group-empty' });
    this.body = h('div', { class: 'group-body' }, this.host, this.preview, this.empty);
    this.el = h('div', { class: 'group' }, this.tabbar, this.body);
    this.view = new EditorView({ parent: this.host, state: EditorState.create({ doc: '' }) });
  }
}

type Listener = (what: 'tabs' | 'cursor' | 'dirty' | 'active' | 'saved' | 'edit') => void;

export class Workbench {
  groups: Group[] = [];
  activeGroup!: Group;
  root = '';
  private docs = new Map<string, Doc>();
  private listeners: Listener[] = [];
  private previewTimers = new Map<number, number>();
  private lastDirty = false;
  /** Runs an app command (set by main.ts). */
  onCommand?: (cmd: string) => void;
  /** Ruleset state for the DDL review panel (set by main.ts). */
  reviewInfo?: () => { path: string; count: number; errors: string[] } | null;
  /** Clipboard writer for the review panel (set by main.ts). */
  copyText?: (text: string) => void;

  constructor(
    private container: HTMLElement,
    public settings: Settings,
    private welcome: () => HTMLElement,
  ) {
    this.activeGroup = this.addGroup(0);
    this.layout();
    // JavaScript / shell support arrives asynchronously: re-apply it to open tabs.
    onLanguageLoaded((id) => {
      for (const t of this.allTabs())
        if (t.doc.lang === id)
          this.reconfigure(t, langComp.reconfigure(languageExtension(id, this.settings.dialect, t.doc.large)));
      this.emit('cursor');
    });
  }

  // ---- events --------------------------------------------------------------

  on(fn: Listener) {
    this.listeners.push(fn);
  }
  private emit(what: Parameters<Listener>[0]) {
    for (const l of this.listeners) l(what);
    if (what === 'dirty' || what === 'tabs') {
      const d = this.hasDirty();
      if (d !== this.lastDirty) {
        this.lastDirty = d;
        api.SetDirty(d).catch(() => {});
      }
    }
  }

  // ---- queries -------------------------------------------------------------

  get activeTab(): Tab | null {
    return this.activeGroup.active;
  }

  stateOf(tab: Tab): EditorState {
    return tab.group.active === tab ? tab.group.view.state : tab.state;
  }

  allTabs(): Tab[] {
    return this.groups.flatMap((g) => g.tabs);
  }

  allDocs(): Doc[] {
    const set = new Set<Doc>();
    for (const t of this.allTabs()) set.add(t.doc);
    return [...set];
  }

  hasDirty(): boolean {
    return this.allDocs().some((d) => d.dirty);
  }

  // ---- groups & layout -------------------------------------------------------

  private addGroup(index: number): Group {
    const g = new Group();
    this.groups.splice(index, 0, g);
    g.view.contentDOM.addEventListener('focus', () => this.setActiveGroup(g));
    g.el.addEventListener('mousedown', () => this.setActiveGroup(g), true);
    g.tabbar.addEventListener('dblclick', (e) => {
      if (e.target === g.tabbar) this.newUntitled(g);
    });
    this.showGroupContent(g);
    return g;
  }

  private removeGroup(g: Group) {
    const i = this.groups.indexOf(g);
    if (i < 0 || this.groups.length === 1) return;
    this.groups.splice(i, 1);
    g.view.destroy();
    if (this.activeGroup === g) this.setActiveGroup(this.groups[Math.max(0, i - 1)]);
    this.layout();
  }

  setActiveGroup(g: Group) {
    if (this.activeGroup === g) return;
    this.activeGroup = g;
    for (const x of this.groups) x.el.classList.toggle('active', x === g);
    this.emit('active');
  }

  layout() {
    this.container.replaceChildren();
    this.groups.forEach((g, i) => {
      if (i > 0) this.container.append(this.makeResizer(this.groups[i - 1], g));
      g.el.style.flex = `${g.flex} 1 0`;
      g.el.classList.toggle('active', g === this.activeGroup);
      this.container.append(g.el);
    });
    this.container.classList.toggle('split', this.groups.length > 1);
    for (const g of this.groups) this.renderTabs(g);
  }

  private makeResizer(left: Group, right: Group): HTMLElement {
    const r = h('div', { class: 'resizer v' });
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      const total = left.el.offsetWidth + right.el.offsetWidth;
      const flexSum = left.flex + right.flex;
      const startX = e.clientX;
      const startW = left.el.offsetWidth;
      const move = (ev: PointerEvent) => {
        const w = Math.min(Math.max(startW + ev.clientX - startX, 160), total - 160);
        left.flex = (w / total) * flexSum;
        right.flex = flexSum - left.flex;
        left.el.style.flex = `${left.flex} 1 0`;
        right.el.style.flex = `${right.flex} 1 0`;
      };
      const up = () => {
        r.removeEventListener('pointermove', move);
        r.removeEventListener('pointerup', up);
        this.emit('tabs');
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up);
    });
    return r;
  }

  /** Shows editor / empty placeholder / welcome screen for a group. */
  private showGroupContent(g: Group) {
    const hasTab = !!g.active;
    g.host.style.display = hasTab ? '' : 'none';
    const showPreview = hasTab && this.previewMode(g) !== null;
    g.preview.style.display = showPreview ? '' : 'none';
    g.body.classList.toggle('with-preview', showPreview);
    g.empty.style.display = hasTab ? 'none' : '';
    if (!hasTab) {
      g.empty.replaceChildren(
        this.groups.length <= 1 ? this.welcome() : h('div', { class: 'group-hint' }, '빈 편집 영역'),
      );
    }
    if (showPreview) this.schedulePreview(g, 0);
  }

  // ---- tabs ------------------------------------------------------------------

  private makeTab(doc: Doc, group: Group, text: string | Text, index?: number): Tab {
    const tab = new Tab(doc, group);
    tab.state = createState(text.toString(), doc.lang, this.settings, this.listenerFor(tab), doc.large);
    doc.tabs.push(tab);
    const i = index ?? (group.active ? group.tabs.indexOf(group.active) + 1 : group.tabs.length);
    group.tabs.splice(i, 0, tab);
    return tab;
  }

  private onDocChanged(tab: Tab, trs: readonly Transaction[]) {
    const local = trs.filter((tr) => tr.docChanged && !tr.annotation(remote));
    if (local.length) {
      for (const other of tab.doc.tabs) {
        if (other === tab) continue;
        for (const tr of local) {
          const spec = {
            changes: tr.changes,
            annotations: [remote.of(true), Transaction.addToHistory.of(false)],
          };
          if (other.group.active === other) other.group.view.dispatch(spec);
          else other.state = other.state.update(spec).state;
        }
      }
    }
    const was = tab.doc.dirty;
    // Comparing multi-MB texts on every keystroke is costly; in large-file
    // mode any edit simply marks the document dirty.
    tab.doc.dirty = tab.doc.metaDirty || tab.doc.large || !this.stateOf(tab).doc.eq(tab.doc.saved);
    if (was !== tab.doc.dirty) {
      for (const t of tab.doc.tabs) this.renderTabs(t.group);
      this.emit('dirty');
    }
    if (local.length) this.emit('edit');
    for (const t of tab.doc.tabs) {
      if (t.group.active === t && this.previewMode(t.group)) this.schedulePreview(t.group, 300);
    }
  }

  activate(tab: Tab, focus = true) {
    const g = tab.group;
    if (g.active && g.active !== tab) {
      const prev = g.active;
      prev.state = g.view.state;
      prev.scrollTop = g.view.scrollDOM.scrollTop;
      prev.scrollLeft = g.view.scrollDOM.scrollLeft;
    }
    if (g.active !== tab) {
      g.active = tab;
      g.view.setState(tab.state);
      const { scrollTop, scrollLeft } = tab;
      requestAnimationFrame(() => {
        g.view.scrollDOM.scrollTop = scrollTop;
        g.view.scrollDOM.scrollLeft = scrollLeft;
      });
    }
    this.setActiveGroup(g);
    this.showGroupContent(g);
    this.renderTabs(g);
    if (focus) g.view.focus();
    this.emit('tabs');
    this.emit('cursor');
  }

  /** Detaches a tab from its group without asking. */
  private detach(tab: Tab) {
    const g = tab.group;
    const i = g.tabs.indexOf(tab);
    if (i < 0) return;
    if (g.active === tab) {
      tab.state = g.view.state;
      tab.scrollTop = g.view.scrollDOM.scrollTop;
    }
    g.tabs.splice(i, 1);
    tab.doc.tabs = tab.doc.tabs.filter((t) => t !== tab);
    if (tab.doc.tabs.length === 0 && tab.doc.path) this.docs.delete(tab.doc.path);
    if (g.active === tab) {
      g.active = null;
      const next = g.tabs[i] ?? g.tabs[i - 1];
      if (next) {
        this.activate(next, g === this.activeGroup);
      } else {
        g.view.setState(EditorState.create({ doc: '' }));
        this.showGroupContent(g);
      }
    }
    this.renderTabs(g);
  }

  async closeTab(tab: Tab, force = false): Promise<boolean> {
    const doc = tab.doc;
    if (!force && doc.dirty && doc.tabs.length === 1) {
      if (tab.group.active !== tab) this.activate(tab, false);
      const v = await ask(
        '저장하지 않은 변경 사항',
        `'${doc.name}'의 변경 사항을 저장할까요? 저장하지 않으면 변경 내용이 사라집니다.`,
        [
          { label: '저장', value: 'save', primary: true },
          { label: '저장 안 함', value: 'discard', danger: true },
          { label: '취소', value: '' },
        ],
      );
      if (!v) return false;
      if (v === 'save' && !(await this.save(tab))) return false;
    }
    const g = tab.group;
    this.detach(tab);
    if (g.tabs.length === 0 && this.groups.length > 1) this.removeGroup(g);
    this.emit('tabs');
    this.emit('dirty');
    return true;
  }

  async closeTabs(tabs: Tab[]): Promise<boolean> {
    for (const t of [...tabs]) if (!(await this.closeTab(t))) return false;
    return true;
  }

  // ---- open / new -------------------------------------------------------------

  async openPath(path: string, group: Group = this.activeGroup, focus = true): Promise<Tab | null> {
    const existing = this.docs.get(path);
    if (existing) {
      const inGroup = existing.tabs.find((t) => t.group === group);
      if (inGroup) {
        this.activate(inGroup, focus);
        return inGroup;
      }
      const t = this.makeTab(existing, group, this.stateOf(existing.tabs[0]).doc);
      this.activate(t, focus);
      return t;
    }
    let fc;
    try {
      fc = await api.ReadFile(path);
    } catch (e) {
      const msg = errText(e);
      markUnopenable(path, msg);
      toast(
        /binary/i.test(msg)
          ? `'${basename(path)}'은(는) 텍스트 파일이 아니라 편집기로 열 수 없습니다.`
          : `열 수 없습니다: ${basename(path)} — ${msg}`,
        'error',
      );
      return null;
    }
    // Another call may have opened it while we were reading.
    if (this.docs.has(path)) return this.openPath(path, group, focus);
    const doc = new Doc(path, basename(path), langForName(path), Text.of(fc.content.split('\n')));
    doc.large = fc.content.length > this.settings.largeFileMB * 1024 * 1024;
    if (doc.large) toast(`'${doc.name}'은(는) 큰 파일이라 하이라이트·문법 검사 없이 열었습니다 (대용량 모드).`);
    doc.eol = fc.eol;
    doc.bom = fc.bom;
    doc.modTime = fc.modTime;
    this.docs.set(path, doc);
    const t = this.makeTab(doc, group, doc.saved);
    this.activate(t, focus);
    return t;
  }

  newUntitled(group: Group = this.activeGroup, lang: LangId = 'sql', name?: string, text = ''): Tab {
    const doc = new Doc(null, name ?? `Untitled-${++untitledSeq}`, lang, Text.empty);
    const t = this.makeTab(doc, group, text);
    // A pre-filled buffer is unsaved work.
    if (text) doc.dirty = true;
    this.activate(t);
    return t;
  }

  // ---- save ------------------------------------------------------------------

  /** `auto`: an auto-save; leaves whitespace on lines being edited alone. */
  async save(tab: Tab | null = this.activeTab, saveAs = false, auto = false): Promise<boolean> {
    if (!tab) return false;
    const doc = tab.doc;
    this.cleanupOnSave(doc, auto);
    const snapshot = this.stateOf(tab).doc;
    let path = doc.path;
    if (!path || saveAs) {
      const defDir = doc.path ? dirname(doc.path) : this.root;
      let name = doc.path || extOf(doc.name) ? doc.name : doc.name + defaultExt(doc.lang);
      const p = await api.SaveAsDialog(defDir, name).catch((e) => {
        toast(errText(e), 'error');
        return '';
      });
      if (!p) return false;
      path = p;
      if (!extOf(basename(path)) && doc.lang !== 'text') path += defaultExt(doc.lang);
      if (path !== doc.path && this.docs.has(path)) {
        toast('같은 파일이 이미 다른 탭에 열려 있습니다. 그 탭을 먼저 닫아 주세요.', 'error');
        return false;
      }
    } else {
      // Detect a conflicting change on disk.
      const st = await api.Stat(path).catch(() => null);
      if (st?.exists && doc.modTime && st.modTime > doc.modTime + 1) {
        const v = await ask(
          '파일이 디스크에서 변경됨',
          `'${doc.name}'이(가) 다른 프로그램에서 수정되었습니다. 덮어쓸까요?`,
          [
            { label: '덮어쓰기', value: 'yes', danger: true },
            { label: '취소', value: '' },
          ],
        );
        if (!v) return false;
      }
    }
    try {
      doc.modTime = await api.WriteFile(path, snapshot.toString(), doc.eol, doc.bom);
    } catch (e) {
      toast(`저장 실패: ${errText(e)}`, 'error');
      return false;
    }
    if (path !== doc.path) this.setDocPath(doc, path);
    doc.saved = snapshot;
    doc.metaDirty = false;
    doc.missing = false;
    doc.dirty = !this.stateOf(tab).doc.eq(snapshot);
    for (const t of doc.tabs) this.renderTabs(t.group);
    this.emit('dirty');
    this.emit('tabs');
    this.emit('saved');
    return true;
  }

  /** Applies the trim-trailing-whitespace / final-newline settings. */
  private cleanupOnSave(doc: Doc, auto: boolean) {
    if (doc.large || !doc.tabs.length) return;
    const cur = this.textOf(doc);
    let text = cur;
    // Markdown uses two trailing spaces as a hard line break.
    if (this.settings.trimTrailing && doc.lang !== 'markdown') {
      // On auto-save, keep whitespace on lines with a cursor: the user may be
      // in the middle of typing "select |".
      const keep = new Set<number>();
      if (auto)
        for (const t of doc.tabs)
          for (const r of this.stateOf(t).selection.ranges) keep.add(this.stateOf(t).doc.lineAt(r.head).number);
      text = text
        .split('\n')
        .map((l, i) => (keep.has(i + 1) ? l : l.replace(/[ \t]+(\r?)$/, '$1')))
        .join('\n');
    }
    if (this.settings.finalNewline && text.length && !text.endsWith('\n')) text += '\n';
    if (text !== cur) this.applyText(doc, text);
  }

  async saveAll(): Promise<boolean> {
    for (const d of this.allDocs()) {
      if (!d.dirty) continue;
      if (!(await this.save(d.tabs[0]))) return false;
    }
    return true;
  }

  private setDocPath(doc: Doc, path: string) {
    if (doc.path) this.docs.delete(doc.path);
    doc.path = path;
    doc.name = basename(path);
    this.docs.set(path, doc);
    const lang = langForName(path);
    if (lang !== doc.lang) {
      doc.lang = lang;
      for (const t of doc.tabs)
        this.reconfigure(t, langComp.reconfigure(languageExtension(lang, this.settings.dialect, doc.large)));
    }
  }

  /** Called after a file or folder was renamed in the explorer. */
  pathRenamed(oldPath: string, newPath: string) {
    for (const d of this.allDocs()) {
      if (!d.path) continue;
      if (d.path === oldPath) this.setDocPath(d, newPath);
      else if (d.path.startsWith(oldPath + '/') || d.path.startsWith(oldPath + '\\'))
        this.setDocPath(d, newPath + d.path.slice(oldPath.length));
    }
    for (const g of this.groups) this.renderTabs(g);
    this.emit('tabs');
  }

  // ---- disk sync ---------------------------------------------------------------

  private replaceText(doc: Doc, text: string) {
    for (const t of doc.tabs) {
      const st = this.stateOf(t);
      const spec = {
        changes: { from: 0, to: st.doc.length, insert: text },
        annotations: [remote.of(true)],
      };
      if (t.group.active === t) t.group.view.dispatch(spec);
      else t.state = t.state.update(spec).state;
    }
  }

  async reload(doc: Doc) {
    if (!doc.path) return;
    try {
      const fc = await api.ReadFile(doc.path);
      this.replaceText(doc, fc.content);
      doc.saved = this.stateOf(doc.tabs[0]).doc;
      doc.modTime = fc.modTime;
      doc.eol = fc.eol;
      doc.bom = fc.bom;
      doc.dirty = false;
      doc.metaDirty = false;
      doc.missing = false;
      for (const t of doc.tabs) this.renderTabs(t.group);
      this.emit('dirty');
    } catch (e) {
      toast(`다시 읽기 실패: ${errText(e)}`, 'error');
    }
  }

  private notified = new Set<string>();
  /** Checks open files for changes made by other programs. */
  async checkDisk(only?: Set<string>) {
    for (const doc of this.allDocs()) {
      if (!doc.path || doc.tabs.length === 0) continue;
      if (only && !only.has(doc.path)) continue;
      const st = await api.Stat(doc.path).catch(() => null);
      if (!st) continue;
      const was = doc.missing;
      doc.missing = !st.exists;
      if (doc.missing !== was) for (const t of doc.tabs) this.renderTabs(t.group);
      if (!st.exists || st.modTime <= doc.modTime + 1) continue;
      if (!doc.dirty) {
        await this.reload(doc);
        continue;
      }
      const key = doc.path + ':' + st.modTime;
      if (this.notified.has(key)) continue;
      this.notified.add(key);
      toast(`'${doc.name}'이(가) 디스크에서 변경되었습니다.`, 'info', [
        { label: '다시 읽기', run: () => this.reload(doc) },
        {
          label: '내 변경 유지',
          run: () => {
            doc.modTime = st.modTime;
          },
        },
      ]);
    }
  }

  // ---- helpers for search / explorer --------------------------------------------

  docByPath(path: string): Doc | undefined {
    return this.docs.get(path);
  }

  textOf(doc: Doc): string {
    return this.stateOf(doc.tabs[0]).doc.toString();
  }

  /** Replaces a document's text with `text` as one minimal, undoable edit. */
  applyText(doc: Doc, text: string) {
    const cur = this.textOf(doc);
    if (cur === text) return;
    let a = 0;
    const max = Math.min(cur.length, text.length);
    while (a < max && cur.charCodeAt(a) === text.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
    const change = { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) };
    for (const t of doc.tabs) {
      const spec = { changes: change, annotations: [remote.of(true)] };
      if (t.group.active === t) t.group.view.dispatch(spec);
      else t.state = t.state.update(spec).state;
    }
    doc.dirty = doc.metaDirty || !this.stateOf(doc.tabs[0]).doc.eq(doc.saved);
    for (const t of doc.tabs) this.renderTabs(t.group);
    this.emit('dirty');
  }

  /** Opens a file and selects a range given as 1-based line + UTF-16 column. */
  async reveal(path: string, line: number, col: number, len: number, focus = true) {
    const tab = await this.openPath(path, this.activeGroup, focus);
    if (!tab) return;
    const v = tab.group.view;
    const doc = v.state.doc;
    if (line > doc.lines) return;
    const l = doc.line(line);
    const from = Math.min(l.from + col, l.to);
    const to = Math.min(from + len, l.to);
    v.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
  }

  /** Called after files/folders were moved to the trash. */
  async pathsRemoved(path: string) {
    const under = (p: string) => p === path || p.startsWith(path + '/') || p.startsWith(path + '\\');
    for (const d of this.allDocs()) {
      if (!d.path || !under(d.path)) continue;
      if (d.dirty) {
        d.missing = true;
        for (const t of d.tabs) this.renderTabs(t.group);
      } else {
        for (const t of [...d.tabs]) await this.closeTab(t, true);
      }
    }
  }

  /** Folders of open files (for the file watcher). */
  openDirs(): string[] {
    return [
      ...new Set(
        this.allDocs()
          .filter((d) => d.path)
          .map((d) => dirname(d.path!)),
      ),
    ];
  }

  // ---- split / move -------------------------------------------------------------

  split(tab: Tab | null = this.activeTab): Tab | null {
    if (!tab) return null;
    if (this.groups.length >= MAX_GROUPS) {
      toast(`최대 ${MAX_GROUPS}개까지 분할할 수 있습니다.`);
      return null;
    }
    const i = this.groups.indexOf(tab.group);
    const g = this.addGroup(i + 1);
    this.layout();
    const nt = this.makeTab(tab.doc, g, this.stateOf(tab).doc);
    this.activate(nt);
    return nt;
  }

  /** Moves a tab into another group (or a new group when target is "new"). */
  moveTab(tab: Tab, target: Group | 'new-right', index?: number) {
    const src = tab.group;
    let dest: Group;
    if (target === 'new-right') {
      if (src.tabs.length === 1) return; // nothing to split off
      if (this.groups.length >= MAX_GROUPS) {
        toast(`최대 ${MAX_GROUPS}개까지 분할할 수 있습니다.`);
        return;
      }
      dest = this.addGroup(this.groups.indexOf(src) + 1);
      this.layout();
    } else {
      dest = target;
    }
    if (dest === src) {
      // Reorder within the same tab bar.
      const from = src.tabs.indexOf(tab);
      let to = index ?? src.tabs.length;
      if (to > from) to--;
      src.tabs.splice(from, 1);
      src.tabs.splice(to, 0, tab);
      this.renderTabs(src);
      this.emit('tabs');
      return;
    }
    const twin = tab.doc.tabs.find((t) => t.group === dest);
    const state = this.stateOf(tab);
    const scroll = src.active === tab ? src.view.scrollDOM.scrollTop : tab.scrollTop;
    this.detach(tab);
    let moved: Tab;
    if (twin) {
      moved = twin;
    } else {
      // Re-use the same Tab object: its update listener stays valid.
      moved = tab;
      moved.group = dest;
      moved.state = state;
      moved.scrollTop = scroll;
      tab.doc.tabs.push(moved);
      if (tab.doc.path) this.docs.set(tab.doc.path, tab.doc);
      dest.tabs.splice(index ?? dest.tabs.length, 0, moved);
    }
    if (src.tabs.length === 0 && this.groups.length > 1) this.removeGroup(src);
    this.activate(moved);
  }

  private listenerFor(tab: Tab) {
    return EditorView.updateListener.of((u) => {
      if (u.docChanged) this.onDocChanged(tab, u.transactions);
      if ((u.selectionSet || u.docChanged) && tab.group === this.activeGroup) this.emit('cursor');
      if (u.focusChanged && u.view.hasFocus) this.setActiveGroup(tab.group);
    });
  }

  focusNextGroup() {
    if (this.groups.length < 2) return;
    const i = this.groups.indexOf(this.activeGroup);
    const g = this.groups[(i + 1) % this.groups.length];
    this.setActiveGroup(g);
    if (g.active) g.view.focus();
  }

  // ---- settings ------------------------------------------------------------------

  private reconfigure(tab: Tab, effect: StateEffect<unknown>) {
    if (tab.group.active === tab) tab.group.view.dispatch({ effects: effect });
    else tab.state = tab.state.update({ effects: effect }).state;
  }

  setDialect(d: DialectId) {
    this.settings.dialect = d;
    for (const t of this.allTabs())
      if (t.doc.lang === 'sql') this.reconfigure(t, langComp.reconfigure(languageExtension('sql', d, t.doc.large)));
    this.emit('cursor');
  }

  /** Re-applies the SQL language (after the completion schema changed). */
  refreshSqlLanguage() {
    for (const t of this.allTabs())
      if (t.doc.lang === 'sql')
        this.reconfigure(t, langComp.reconfigure(languageExtension('sql', this.settings.dialect, t.doc.large)));
  }

  setIndent(n: number) {
    this.settings.indent = n;
    for (const t of this.allTabs()) this.reconfigure(t, indentComp.reconfigure(indentExtension(n)));
    this.emit('cursor');
  }

  setWhitespace(w: Whitespace) {
    this.settings.whitespace = w;
    for (const t of this.allTabs()) this.reconfigure(t, wsComp.reconfigure(whitespaceExtension(w)));
  }

  setWrap(on: boolean) {
    this.settings.wrap = on;
    for (const t of this.allTabs()) this.reconfigure(t, wrapComp.reconfigure(on ? EditorView.lineWrapping : []));
    this.emit('cursor');
  }

  setLanguage(tab: Tab, lang: LangId) {
    tab.doc.lang = lang;
    for (const t of tab.doc.tabs)
      this.reconfigure(t, langComp.reconfigure(languageExtension(lang, this.settings.dialect, t.doc.large)));
    for (const t of tab.doc.tabs) this.renderTabs(t.group);
    this.showGroupContent(tab.group);
    this.emit('cursor');
  }

  /** Replaces the whole text of the active tab as one undoable change. */
  replaceAll(tab: Tab, text: string) {
    if (tab.group.active !== tab) this.activate(tab);
    const v = tab.group.view;
    const sel = v.state.selection.main.head;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      selection: { anchor: Math.min(sel, text.length) },
      scrollIntoView: true,
    });
  }

  /** Marks a document dirty after an EOL/BOM change. */
  markMetaDirty(doc: Doc) {
    doc.metaDirty = true;
    doc.dirty = true;
    for (const t of doc.tabs) this.renderTabs(t.group);
    this.emit('dirty');
  }

  /** Re-renders the welcome / empty placeholders. */
  refreshEmpty() {
    for (const g of this.groups) if (!g.active) this.showGroupContent(g);
  }

  // ---- markdown preview -------------------------------------------------------

  /** What the side panel of a group shows, if anything. */
  private previewMode(g: Group): 'plan' | 'md' | 'review' | null {
    if (!g.active) return null;
    if (g.reviewOn && g.active.doc.lang === 'sql') return 'review';
    if (g.planOn) return 'plan';
    if (g.previewOn && g.active.doc.lang === 'markdown') return 'md';
    return null;
  }

  /** Shows/hides the execution-plan panel for the active document. */
  togglePlan(g: Group = this.activeGroup) {
    if (!g.active) return toast('실행계획이나 데드락 기록을 붙여 넣은 문서를 먼저 여세요.');
    g.planOn = !g.planOn;
    if (g.planOn) g.reviewOn = false;
    this.showGroupContent(g);
    if (!g.planOn) g.preview.className = 'md-preview markdown-body';
  }

  togglePreview(g: Group = this.activeGroup) {
    if (!g.active || g.active.doc.lang !== 'markdown') {
      toast('Markdown 문서에서만 미리보기를 사용할 수 있습니다.');
      return;
    }
    g.previewOn = !g.previewOn;
    if (g.previewOn) {
      g.planOn = false;
      g.reviewOn = false;
    }
    g.preview.className = 'md-preview markdown-body';
    this.showGroupContent(g);
  }

  /** Shows/hides the DDL review panel. */
  toggleReview(g: Group = this.activeGroup, force?: boolean) {
    if (!g.active || g.active.doc.lang !== 'sql') {
      toast('SQL 문서에서 DDL 검토 패널을 열 수 있습니다.');
      return;
    }
    g.reviewOn = force ?? !g.reviewOn;
    if (g.reviewOn) {
      g.planOn = false;
      g.previewOn = false;
    }
    g.preview.className = g.reviewOn ? 'review-view' : 'md-preview markdown-body';
    this.showGroupContent(g);
  }

  /** Re-renders open DDL review panels (after a lint run). */
  refreshReview() {
    for (const g of this.groups) if (this.previewMode(g) === 'review') this.schedulePreview(g, 0);
  }

  private schedulePreview(g: Group, delay: number) {
    clearTimeout(this.previewTimers.get(g.id));
    this.previewTimers.set(
      g.id,
      window.setTimeout(() => this.renderPreview(g), delay),
    );
  }

  private async renderPreview(g: Group) {
    const mode = this.previewMode(g);
    if (mode === 'review') {
      const { renderReview } = await import('./reviewpanel');
      renderReview(g.preview, g.view, {
        info: () => this.reviewInfo?.() ?? null,
        openSettings: () => this.onCommand?.('app.settings'),
        copy: (t) => this.copyText?.(t),
      });
      return;
    }
    if (mode === 'plan') {
      const { renderPlanView } = await import('./planview');
      renderPlanView(g.preview, g.view.state.doc.toString(), {
        jump: (line) => {
          const doc = g.view.state.doc;
          if (line + 1 > doc.lines) return;
          const l = doc.line(line + 1);
          g.view.dispatch({
            selection: { anchor: l.from, head: l.to },
            effects: EditorView.scrollIntoView(l.from, { y: 'center' }),
          });
          g.view.focus();
        },
      });
      return;
    }
    if (mode !== 'md') return;
    const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]);
    const html = await marked.parse(g.view.state.doc.toString(), { gfm: true, breaks: false });
    g.preview.innerHTML = DOMPurify.sanitize(html);
    for (const a of g.preview.querySelectorAll('a')) a.addEventListener('click', (e) => e.preventDefault());
  }

  // ---- session ------------------------------------------------------------------

  session(): { groups: GroupSession[]; active: number } {
    return {
      groups: this.groups.map((g) => ({
        tabs: g.tabs.map((t) => t.doc.path).filter((p): p is string => !!p),
        active: g.active?.doc.path ?? null,
        flex: g.flex,
      })),
      active: this.groups.indexOf(this.activeGroup),
    };
  }

  async restore(s: { groups: GroupSession[]; active: number }) {
    const valid = s.groups.filter((g) => g.tabs.length).slice(0, MAX_GROUPS);
    for (let gi = 0; gi < valid.length; gi++) {
      const gs = valid[gi];
      const g = gi === 0 ? this.groups[0] : this.addGroup(this.groups.length);
      g.flex = gs.flex || 1;
      if (gi > 0) this.layout();
      for (const p of gs.tabs) {
        const st = await api.Stat(p).catch(() => null);
        if (st?.exists) await this.openPath(p, g, false);
      }
      const act = g.tabs.find((t) => t.doc.path === gs.active) ?? g.tabs[0];
      if (act) this.activate(act, false);
    }
    for (const g of [...this.groups]) if (!g.tabs.length && this.groups.length > 1) this.removeGroup(g);
    this.layout();
    const ag = this.groups[s.active] ?? this.groups[0];
    this.setActiveGroup(ag);
    if (ag.active) ag.view.focus();
    else this.showGroupContent(ag);
  }

  // ---- tab bar rendering ---------------------------------------------------------

  renderTabs(g: Group) {
    const names = new Map<string, number>();
    for (const t of g.tabs) names.set(t.doc.name, (names.get(t.doc.name) ?? 0) + 1);
    const els = g.tabs.map((t) => {
      const d = t.doc;
      const desc = names.get(d.name)! > 1 && d.path ? basename(dirname(d.path)) : '';
      const el = h(
        'div',
        {
          class: 'tab' + (g.active === t ? ' active' : '') + (d.dirty ? ' dirty' : '') + (d.missing ? ' missing' : ''),
          title: d.path ?? d.name,
        },
        h('span', { class: 'badge lang-' + d.lang }, LANGS[d.lang].badge),
        h('span', { class: 'tab-name' }, d.name),
        desc ? h('span', { class: 'tab-desc' }, desc) : null,
        h('span', {
          class: 'tab-close',
          title: '닫기',
          onmousedown: (e: MouseEvent) => e.stopPropagation(),
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            this.closeTab(t);
          },
        }),
      );
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.closeTab(t);
          return;
        }
        if (e.button !== 0) return;
        this.beginTabDrag(t, e);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.tabMenu(t, e.clientX, e.clientY);
      });
      return el;
    });
    g.tabbar.replaceChildren(...els, h('div', { class: 'tabbar-fill' }));
    g.tabbar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private tabMenu(t: Tab, x: number, y: number) {
    const g = t.group;
    const mod = isMac ? '⌘' : 'Ctrl+';
    contextMenu(x, y, [
      { label: '닫기', hint: mod + 'W', action: () => this.closeTab(t) },
      {
        label: '다른 탭 닫기',
        action: () => this.closeTabs(g.tabs.filter((x) => x !== t)),
        disabled: g.tabs.length < 2,
      },
      {
        label: '오른쪽 탭 닫기',
        action: () => this.closeTabs(g.tabs.slice(g.tabs.indexOf(t) + 1)),
        disabled: g.tabs.indexOf(t) === g.tabs.length - 1,
      },
      { label: '모두 닫기', action: () => this.closeTabs(g.tabs) },
      { separator: true, label: '' },
      { label: '오른쪽으로 분할', hint: mod + '\\', action: () => this.split(t) },
      { label: '오른쪽 그룹으로 이동', action: () => this.moveTab(t, 'new-right'), disabled: g.tabs.length < 2 },
      { separator: true, label: '' },
      {
        label: '저장된 버전과 비교',
        disabled: !t.doc.path,
        action: () => {
          this.activate(t);
          this.onCommand?.('diff.saved');
        },
      },
      {
        label: '다른 탭과 비교…',
        action: () => {
          this.activate(t);
          this.onCommand?.('diff.tabs');
        },
      },
      { separator: true, label: '' },
      {
        label: '경로 복사',
        action: () => t.doc.path && copyText(t.doc.path),
        disabled: !t.doc.path,
      },
      {
        label: isMac ? 'Finder에서 보기' : '탐색기에서 보기',
        action: () => t.doc.path && api.RevealInFinder(t.doc.path),
        disabled: !t.doc.path,
      },
    ]);
  }

  // ---- tab drag & drop (pointer based; independent of HTML5 DnD) ---------------

  private beginTabDrag(tab: Tab, down: MouseEvent) {
    const startX = down.clientX;
    const startY = down.clientY;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let indicator: HTMLElement | null = null;
    let drop: { group: Group | 'new-right'; index?: number; groupForNew?: Group } | null = null;

    const clear = () => {
      indicator?.remove();
      indicator = null;
      for (const g of this.groups) g.body.classList.remove('drop-into', 'drop-right');
    };

    const move = (e: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 6) return;
        dragging = true;
        ghost = h('div', { class: 'tab-ghost' }, tab.doc.name);
        document.body.append(ghost);
        document.body.classList.add('dragging-tab');
      }
      ghost!.style.left = Math.min(e.clientX + 10, window.innerWidth - ghost!.offsetWidth - 4) + 'px';
      ghost!.style.top = e.clientY + 8 + 'px';
      clear();
      drop = null;
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const g = this.groups.find((x) => x.el.contains(target));
      if (!g || !target) return;
      if (g.tabbar.contains(target)) {
        const tabs = [...g.tabbar.querySelectorAll<HTMLElement>('.tab')];
        let index = tabs.length;
        for (let i = 0; i < tabs.length; i++) {
          const r = tabs[i].getBoundingClientRect();
          if (e.clientX < r.left + r.width / 2) {
            index = i;
            break;
          }
        }
        const ref = tabs[index];
        const r = (ref ?? tabs[tabs.length - 1] ?? g.tabbar).getBoundingClientRect();
        indicator = h('div', { class: 'tab-drop-indicator' });
        indicator.style.left = (ref ? r.left : tabs.length ? r.right : r.left) - 1 + 'px';
        indicator.style.top = r.top + 'px';
        indicator.style.height = r.height + 'px';
        document.body.append(indicator);
        drop = { group: g, index };
      } else {
        const r = g.body.getBoundingClientRect();
        const rightZone = e.clientX > r.left + r.width * 0.7;
        if (rightZone && (g !== tab.group || g.tabs.length > 1) && this.groups.length < MAX_GROUPS) {
          g.body.classList.add('drop-right');
          drop = { group: 'new-right', groupForNew: g };
        } else if (g !== tab.group) {
          g.body.classList.add('drop-into');
          drop = { group: g };
        }
      }
    };

    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      ghost?.remove();
      document.body.classList.remove('dragging-tab');
      clear();
      if (!dragging) {
        this.activate(tab);
        return;
      }
      if (!drop) return;
      if (drop.group === 'new-right') {
        const g = drop.groupForNew!;
        if (g === tab.group) this.moveTab(tab, 'new-right');
        else {
          // Create a new group to the right of g and move the tab there.
          const ng = this.addGroup(this.groups.indexOf(g) + 1);
          this.layout();
          this.moveTab(tab, ng);
        }
      } else {
        this.moveTab(tab, drop.group, drop.index);
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
}

function defaultExt(lang: LangId): string {
  return { sql: '.sql', markdown: '.md', json: '.json', yaml: '.yaml', javascript: '.js', shell: '.sh', text: '.txt' }[
    lang
  ];
}
