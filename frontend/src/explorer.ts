// Directory tree in the sidebar. Directories are listed lazily on expand.

import { api, copyText, basename, dirname, Entry, isMac } from './backend';
import { isSupported, langForName, LANGS } from './languages';
import { ask, contextMenu, errText, h, prompt, toast } from './ui';

export interface ExplorerHooks {
  open(path: string, keepFocus?: boolean): void;
  renamed(oldPath: string, newPath: string): void;
  openFolder(): void;
  changed(): void; // expanded state changed (for session save)
  deleted(path: string): void;
}

export class Explorer {
  root = '';
  expanded = new Set<string>();
  supportedOnly = false;
  private cache = new Map<string, Entry[]>();
  private selected = '';
  private activePath = '';
  private treeEl: HTMLElement;
  private titleEl: HTMLElement;

  constructor(
    private el: HTMLElement,
    private hooks: ExplorerHooks,
  ) {
    this.titleEl = h('div', { class: 'explorer-title' });
    this.treeEl = h('div', { class: 'tree', tabindex: '0' });
    this.el.append(
      h(
        'div',
        { class: 'explorer-head' },
        this.titleEl,
        h(
          'div',
          { class: 'explorer-actions' },
          iconBtn('새 파일', 'M8 3v10M3 8h10', () => this.newEntry(false)),
          iconBtn('새 폴더', 'M2 4h4l1.5 1.5H14v7H2zM8 7.5v4M6 9.5h4', () => this.newEntry(true)),
          iconBtn('새로 고침', 'M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5', () => this.refresh()),
          iconBtn('모두 접기', 'M4 6l4 4 4-4M4 3h8', () => {
            this.expanded.clear();
            this.render();
            this.hooks.changed();
          }),
        ),
      ),
      this.treeEl,
    );
    this.treeEl.addEventListener('contextmenu', (e) => {
      if (e.target === this.treeEl && this.root) {
        e.preventDefault();
        this.menu(null, e.clientX, e.clientY);
      }
    });
    this.treeEl.addEventListener('keydown', (e) => this.onKey(e));
    this.render();
  }

  async setRoot(root: string, expanded: string[] = []) {
    this.root = root;
    this.cache.clear();
    this.expanded = new Set(expanded.filter((p) => p.startsWith(root)));
    this.selected = '';
    await this.loadExpanded();
    this.render();
  }

  setActive(path: string | null) {
    this.activePath = path ?? '';
    if (path && this.root && path.startsWith(this.root)) {
      // Reveal: expand ancestors that are already loaded.
      let d = dirname(path);
      let changed = false;
      while (d.length > this.root.length) {
        if (!this.expanded.has(d)) {
          this.expanded.add(d);
          changed = true;
        }
        d = dirname(d);
      }
      if (changed) {
        this.loadExpanded().then(() => this.render());
        return;
      }
    }
    this.render();
    this.treeEl.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
  }

  private async list(dir: string, force = false): Promise<Entry[]> {
    if (!force && this.cache.has(dir)) return this.cache.get(dir)!;
    try {
      const items = await api.ListDir(dir);
      this.cache.set(dir, items);
      return items;
    } catch (e) {
      this.cache.set(dir, []);
      this.expanded.delete(dir);
      return [];
    }
  }

  private async loadExpanded(force = false) {
    if (!this.root) return;
    await this.list(this.root, force);
    // Load breadth-first so parents exist before children.
    const dirs = [...this.expanded].sort((a, b) => a.length - b.length);
    await Promise.all(dirs.map((d) => this.list(d, force)));
  }

  async refresh() {
    await this.loadExpanded(true);
    this.render();
  }

  /** Re-lists only the given folders (from file-watcher events). */
  async refreshDirs(paths: Iterable<string>) {
    const dirs = [...new Set(paths)].filter((p) => this.cache.has(p));
    if (!dirs.length) return;
    await Promise.all(dirs.map((d) => this.list(d, true)));
    // Drop expanded folders that no longer exist.
    const all = new Set([...this.cache.values()].flat().map((e) => e.path));
    for (const e of [...this.expanded]) if (!all.has(e)) this.expanded.delete(e);
    this.render();
  }

  /** Folders currently visible in the tree (for the file watcher). */
  visibleDirs(): string[] {
    return this.root ? [this.root, ...[...this.expanded].filter((d) => this.cache.has(d))] : [];
  }

  // ---- rendering -------------------------------------------------------------

  render() {
    if (!this.root) {
      this.titleEl.textContent = '탐색기';
      this.treeEl.replaceChildren(
        h(
          'div',
          { class: 'tree-empty' },
          h('p', {}, '열린 폴더가 없습니다.'),
          h('button', { class: 'btn primary', onclick: () => this.hooks.openFolder() }, '폴더 열기'),
        ),
      );
      return;
    }
    this.titleEl.textContent = basename(this.root).toUpperCase();
    this.titleEl.title = this.root;
    const rows: HTMLElement[] = [];
    const walk = (dir: string, depth: number) => {
      const items = this.cache.get(dir) ?? [];
      for (const it of items) {
        if (!it.isDir && this.supportedOnly && !isSupported(it.name)) continue;
        rows.push(this.row(it, depth));
        if (it.isDir && this.expanded.has(it.path)) walk(it.path, depth + 1);
      }
    };
    walk(this.root, 0);
    this.treeEl.replaceChildren(...rows);
  }

  private row(it: Entry, depth: number): HTMLElement {
    const open = this.expanded.has(it.path);
    const lang = it.isDir ? null : langForName(it.name);
    const el = h(
      'div',
      {
        class:
          'row' +
          (it.isDir ? ' dir' : ' file') +
          (it.path === this.activePath ? ' active' : '') +
          (it.path === this.selected ? ' selected' : '') +
          (lang === 'text' ? ' unsupported' : ''),
        style: { paddingLeft: 8 + depth * 14 + 'px' },
        title: it.path,
        'data-path': it.path,
      },
      it.isDir
        ? h('span', { class: 'twisty' + (open ? ' open' : '') })
        : h('span', { class: 'badge lang-' + lang }, LANGS[lang!].badge),
      h('span', { class: 'row-name' }, it.name),
    );
    el.addEventListener('click', () => this.activate(it, true));
    el.addEventListener('dblclick', () => {
      if (!it.isDir) this.hooks.open(it.path);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.selected = it.path;
      this.render();
      this.menu(it, e.clientX, e.clientY);
    });
    return el;
  }

  private async activate(it: Entry, keepFocus: boolean) {
    this.selected = it.path;
    if (it.isDir) {
      if (this.expanded.has(it.path)) this.expanded.delete(it.path);
      else {
        this.expanded.add(it.path);
        await this.list(it.path);
      }
      this.render();
      this.hooks.changed();
    } else {
      this.hooks.open(it.path, keepFocus);
    }
  }

  private visibleEntries(): Entry[] {
    const out: Entry[] = [];
    const walk = (dir: string) => {
      for (const it of this.cache.get(dir) ?? []) {
        if (!it.isDir && this.supportedOnly && !isSupported(it.name)) continue;
        out.push(it);
        if (it.isDir && this.expanded.has(it.path)) walk(it.path);
      }
    };
    if (this.root) walk(this.root);
    return out;
  }

  private onKey(e: KeyboardEvent) {
    const items = this.visibleEntries();
    if (!items.length) return;
    let i = items.findIndex((x) => x.path === this.selected);
    const cur = items[i];
    switch (e.key) {
      case 'ArrowDown':
        i = Math.min(items.length - 1, i + 1);
        break;
      case 'ArrowUp':
        i = Math.max(0, i - 1);
        break;
      case 'ArrowRight':
        if (cur?.isDir && !this.expanded.has(cur.path)) {
          this.activate(cur, true);
          e.preventDefault();
          return;
        }
        break;
      case 'ArrowLeft':
        if (cur?.isDir && this.expanded.has(cur.path)) {
          this.activate(cur, true);
          e.preventDefault();
          return;
        }
        if (cur) {
          const p = dirname(cur.path);
          i = items.findIndex((x) => x.path === p);
          if (i < 0) return;
        }
        break;
      case 'Enter':
        if (cur) {
          e.preventDefault();
          cur.isDir ? this.activate(cur, true) : this.hooks.open(cur.path);
        }
        return;
      case 'F2':
        if (cur) this.rename(cur);
        return;
      case 'Delete':
      case 'Backspace':
        if (cur && (e.key === 'Delete' || e.metaKey)) {
          e.preventDefault();
          this.trash(cur);
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    this.selected = items[Math.max(0, i)].path;
    this.render();
    this.treeEl.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  // ---- actions ------------------------------------------------------------------

  private targetDir(): string {
    if (!this.selected) return this.root;
    const all = [...this.cache.values()].flat();
    const it = all.find((x) => x.path === this.selected);
    if (!it) return this.root;
    return it.isDir ? it.path : dirname(it.path);
  }

  async newEntry(isDir: boolean, dir = this.targetDir()) {
    if (!this.root) return this.hooks.openFolder();
    const name = await prompt(
      isDir ? '새 폴더 이름' : '새 파일 이름 (예: query.sql)',
      isDir ? '' : 'untitled.sql',
      !isDir,
    );
    if (!name) return;
    try {
      const p = isDir ? await api.CreateDir(dir, name) : await api.CreateFile(dir, name);
      if (dir !== this.root) this.expanded.add(dir);
      await this.list(dir, true);
      this.selected = p;
      this.render();
      this.hooks.changed();
      if (!isDir) this.hooks.open(p);
    } catch (e) {
      toast(errText(e), 'error');
    }
  }

  async rename(it: Entry) {
    const name = await prompt('새 이름', it.name, !it.isDir);
    if (!name || name === it.name) return;
    try {
      const np = await api.Rename(it.path, name);
      const dir = dirname(it.path);
      if (this.expanded.delete(it.path)) this.expanded.add(np);
      await this.list(dir, true);
      this.selected = np;
      this.render();
      this.hooks.renamed(it.path, np);
    } catch (e) {
      toast(errText(e), 'error');
    }
  }

  async trash(it: Entry) {
    const where = isMac ? '휴지통' : '휴지통(Recycle Bin)';
    const v = await ask(
      `${where}으로 이동`,
      `'${it.name}'${it.isDir ? ' 폴더와 그 안의 모든 파일' : ''}을(를) ${where}으로 옮길까요? ${where}에서 복원할 수 있습니다.`,
      [
        { label: '이동', value: 'yes', danger: true },
        { label: '취소', value: '' },
      ],
    );
    if (!v) return;
    try {
      await api.MoveToTrash(it.path);
    } catch (e) {
      toast(`이동 실패: ${errText(e)}`, 'error');
      return;
    }
    this.expanded.delete(it.path);
    await this.list(dirname(it.path), true);
    if (this.selected === it.path) this.selected = '';
    this.render();
    this.hooks.deleted(it.path);
  }

  private menu(it: Entry | null, x: number, y: number) {
    const dir = it ? (it.isDir ? it.path : dirname(it.path)) : this.root;
    const path = it?.path ?? this.root;
    contextMenu(x, y, [
      ...(it && !it.isDir
        ? [
            { label: '열기', action: () => this.hooks.open(it.path) },
            { separator: true, label: '' },
          ]
        : []),
      { label: '새 파일…', action: () => this.newEntry(false, dir) },
      { label: '새 폴더…', action: () => this.newEntry(true, dir) },
      { separator: true, label: '' },
      { label: '이름 바꾸기…', hint: 'F2', action: () => it && this.rename(it), disabled: !it },
      { label: '휴지통으로 이동', hint: isMac ? '⌘⌫' : 'Delete', action: () => it && this.trash(it), disabled: !it },
      { label: '경로 복사', action: () => copyText(path) },
      { label: isMac ? 'Finder에서 보기' : '탐색기에서 보기', action: () => api.RevealInFinder(path) },
      { separator: true, label: '' },
      {
        label: (this.supportedOnly ? '✓ ' : '') + '지원 형식만 표시 (sql/md/json/yaml)',
        action: () => {
          this.supportedOnly = !this.supportedOnly;
          this.render();
          this.hooks.changed();
        },
      },
    ]);
  }
}

function iconBtn(title: string, d: string, onclick: () => void): HTMLElement {
  const b = h('button', { class: 'icon-btn', title, onclick });
  b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return b;
}
