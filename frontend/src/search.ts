// Sidebar "Search" view: find / replace across the open folder.

import { api, FileMatches, isMac, Match, SearchOptions } from './backend';
import { langForName, LANGS } from './languages';
import { ask, errText, h, toast } from './ui';
import type { Workbench } from './workbench';

export interface SearchState {
  query: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
  showReplace: boolean;
  showFilters: boolean;
}

export const defaultSearchState: SearchState = {
  query: '',
  replace: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: '',
  exclude: '',
  showReplace: false,
  showFilters: false,
};

export class SearchView {
  state: SearchState;
  private files: FileMatches[] = [];
  private collapsed = new Set<string>();
  private seq = 0;
  private timer = 0;
  private busy = false;
  private error = '';
  private truncated = false;

  private qInput: HTMLInputElement;
  private rInput: HTMLInputElement;
  private incInput: HTMLInputElement;
  private excInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private filterBox: HTMLElement;
  private summary: HTMLElement;
  private results: HTMLElement;
  private toggleBtns: Record<'caseSensitive' | 'wholeWord' | 'regex', HTMLElement>;
  private replaceToggle: HTMLElement;

  constructor(
    el: HTMLElement,
    private wb: Workbench,
    private root: () => string,
    initial: Partial<SearchState>,
    private changed: () => void,
  ) {
    this.state = { ...defaultSearchState, ...initial };
    const input = (placeholder: string, value: string, onEnter: () => void) => {
      const i = h('input', { class: 'sf-input', placeholder, spellcheck: 'false', value });
      i.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onEnter();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.wb.activeGroup.view.focus();
        }
      });
      return i;
    };
    this.qInput = input('검색', this.state.query, () => this.run(0));
    this.qInput.addEventListener('input', () => {
      this.state.query = this.qInput.value;
      this.schedule();
    });
    this.rInput = input('바꾸기', this.state.replace, () => this.replaceAll());
    this.rInput.addEventListener('input', () => {
      this.state.replace = this.rInput.value;
      this.renderResults();
      this.changed();
    });
    this.incInput = input('포함할 파일 (예: *.sql, db/)', this.state.include, () => this.run(0));
    this.excInput = input('제외할 파일 (예: backup/, *.min.json)', this.state.exclude, () => this.run(0));
    for (const [i, k] of [
      [this.incInput, 'include'],
      [this.excInput, 'exclude'],
    ] as const) {
      i.addEventListener('input', () => {
        this.state[k] = i.value;
        this.schedule();
      });
    }

    const toggle = (k: 'caseSensitive' | 'wholeWord' | 'regex', label: string, title: string) =>
      h(
        'button',
        {
          class: 'sf-toggle' + (this.state[k] ? ' on' : ''),
          title,
          onclick: () => {
            this.state[k] = !this.state[k];
            this.toggleBtns[k].classList.toggle('on', this.state[k]);
            this.run(0);
          },
        },
        label,
      );
    this.toggleBtns = {
      caseSensitive: toggle('caseSensitive', 'Aa', '대/소문자 구분'),
      wholeWord: toggle('wholeWord', 'ab', '단어 단위로'),
      regex: toggle('regex', '.*', '정규식 (RE2 문법, 바꾸기에서 ${1} 사용)'),
    };

    this.replaceToggle = h('button', {
      class: 'sf-expand' + (this.state.showReplace ? ' open' : ''),
      title: '바꾸기 표시',
      onclick: () => this.setShowReplace(!this.state.showReplace),
    });
    this.replaceRow = h(
      'div',
      { class: 'sf-row' },
      h('div', { class: 'sf-field' }, this.rInput),
      h('button', { class: 'sf-action', title: '모두 바꾸기', onclick: () => this.replaceAll() }, '모두'),
    );
    this.filterBox = h('div', { class: 'sf-filters' }, this.incInput, this.excInput);
    this.summary = h('div', { class: 'search-summary' });
    this.results = h('div', { class: 'search-results' });

    el.append(
      h('div', { class: 'pane-head' }, h('div', { class: 'pane-title' }, '검색')),
      h(
        'div',
        { class: 'search-form' },
        this.replaceToggle,
        h(
          'div',
          { class: 'sf-rows' },
          h(
            'div',
            { class: 'sf-row' },
            h(
              'div',
              { class: 'sf-field' },
              this.qInput,
              this.toggleBtns.caseSensitive,
              this.toggleBtns.wholeWord,
              this.toggleBtns.regex,
            ),
          ),
          this.replaceRow,
          h(
            'button',
            {
              class: 'sf-more',
              title: '파일 필터',
              onclick: () => {
                this.state.showFilters = !this.state.showFilters;
                this.filterBox.style.display = this.state.showFilters ? '' : 'none';
                this.changed();
              },
            },
            '⋯',
          ),
          this.filterBox,
        ),
      ),
      this.summary,
      this.results,
    );
    this.replaceRow.style.display = this.state.showReplace ? '' : 'none';
    this.filterBox.style.display = this.state.showFilters ? '' : 'none';
    this.renderResults();
  }

  /** Focuses the query box, optionally pre-filled with the editor selection. */
  focus(prefill?: string) {
    if (prefill && !prefill.includes('\n')) {
      this.qInput.value = this.state.query = prefill;
      this.run(0);
    }
    this.qInput.focus();
    this.qInput.select();
  }

  private setShowReplace(on: boolean) {
    this.state.showReplace = on;
    this.replaceRow.style.display = on ? '' : 'none';
    this.replaceToggle.classList.toggle('open', on);
    this.renderResults();
    this.changed();
    if (on) this.rInput.focus();
  }

  private opts(): SearchOptions {
    const s = this.state;
    return {
      query: s.query,
      caseSensitive: s.caseSensitive,
      wholeWord: s.wholeWord,
      regex: s.regex,
      include: s.include,
      exclude: s.exclude,
    };
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(0), 300);
  }

  /** Re-runs the current query (also called after files change). */
  refresh() {
    if (this.state.query) this.schedule();
  }

  async run(delay: number) {
    clearTimeout(this.timer);
    if (delay) {
      this.timer = window.setTimeout(() => this.run(0), delay);
      return;
    }
    this.changed();
    const my = ++this.seq;
    const root = this.root();
    if (!this.state.query || !root) {
      this.files = [];
      this.error = root ? '' : '먼저 폴더를 여세요.';
      this.busy = false;
      this.renderResults();
      return;
    }
    this.busy = true;
    this.error = '';
    this.renderSummary();
    try {
      const res = await api.SearchInFolder(root, this.opts());
      if (my !== this.seq) return;
      let files = res.files ?? [];
      this.truncated = res.truncated;
      // Unsaved editors: search what the user sees, not what is on disk.
      for (const doc of this.wb.allDocs()) {
        if (!doc.dirty || !doc.path || !doc.path.startsWith(root)) continue;
        const i = files.findIndex((f) => f.path === doc.path);
        if (i < 0 && (this.state.include || this.state.exclude)) continue;
        const ms = (await api.SearchInText(this.wb.textOf(doc), this.opts())) ?? [];
        if (my !== this.seq) return;
        const rel = doc.path
          .slice(root.length + 1)
          .split('\\')
          .join('/');
        if (i >= 0) {
          if (ms.length) files[i] = { ...files[i], matches: ms };
          else files.splice(i, 1);
        } else if (ms.length) {
          files.push({ path: doc.path, rel, matches: ms });
          files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
        }
      }
      this.files = files;
    } catch (e) {
      if (my !== this.seq) return;
      this.files = [];
      const msg = errText(e);
      this.error = /canceled/.test(msg) ? '' : msg.replace(/^error parsing regexp: /, '정규식 오류: ');
    }
    this.busy = false;
    this.renderResults();
  }

  // ---- replace ------------------------------------------------------------------

  private async replaceFiles(files: FileMatches[]) {
    if (!files.length) return;
    const repl = this.state.replace;
    const count = files.reduce((n, f) => n + f.matches.length, 0);
    const v = await ask(
      '모두 바꾸기',
      `${files.length}개 파일에서 ${count}개 항목을 '${repl}'(으)로 바꿀까요? 열려 있는 파일은 편집기에서 바뀌고(저장 필요), 열려 있지 않은 파일은 바로 디스크에 저장됩니다.`,
      [
        { label: '바꾸기', value: 'yes', primary: true },
        { label: '취소', value: '' },
      ],
    );
    if (!v) return;
    let done = 0;
    const onDisk: string[] = [];
    const opts = this.opts();
    try {
      for (const f of files) {
        const doc = this.wb.docByPath(f.path);
        if (doc) {
          const r = await api.ReplaceInText(this.wb.textOf(doc), opts, repl);
          this.wb.applyText(doc, r.text ?? '');
          done += r.count;
        } else {
          onDisk.push(f.path);
        }
      }
      const failed: string[] = [];
      for (const r of onDisk.length ? await api.ReplaceInFiles(onDisk, opts, repl) : []) {
        if (r.error) failed.push(r.path.split(/[\\/]/).pop() + ': ' + r.error);
        else done += r.count;
      }
      toast(
        `${done}개 항목을 바꿨습니다.` + (failed.length ? ` 실패: ${failed.join(', ')}` : ''),
        failed.length ? 'error' : 'info',
      );
    } catch (e) {
      toast('바꾸기 실패: ' + errText(e), 'error');
    }
    this.run(0);
  }

  replaceAll() {
    if (!this.state.showReplace) return this.setShowReplace(true);
    return this.replaceFiles(this.files);
  }

  // ---- rendering ---------------------------------------------------------------------

  private renderSummary() {
    const total = this.files.reduce((n, f) => n + f.matches.length, 0);
    this.summary.className = 'search-summary' + (this.error ? ' error' : '');
    if (this.error) this.summary.textContent = this.error;
    else if (this.busy) this.summary.textContent = '검색 중…';
    else if (!this.state.query) this.summary.textContent = '';
    else if (!total) this.summary.textContent = '결과가 없습니다.';
    else
      this.summary.textContent =
        `${this.files.length}개 파일에서 ${total}개 결과` + (this.truncated ? ' (일부만 표시)' : '');
  }

  private renderResults() {
    this.renderSummary();
    const replacing = this.state.showReplace && !this.state.regex;
    const rows: HTMLElement[] = [];
    for (const f of this.files) {
      const open = !this.collapsed.has(f.path);
      const name = f.rel.split('/').pop()!;
      const dir = f.rel.slice(0, f.rel.length - name.length).replace(/\/$/, '');
      const lang = langForName(name);
      rows.push(
        h(
          'div',
          {
            class: 'sr-file',
            title: f.path,
            onclick: () => {
              if (open) this.collapsed.add(f.path);
              else this.collapsed.delete(f.path);
              this.renderResults();
            },
          },
          h('span', { class: 'twisty' + (open ? ' open' : '') }),
          h('span', { class: 'badge lang-' + lang }, LANGS[lang].badge),
          h('span', { class: 'sr-name' }, name),
          h('span', { class: 'sr-dir' }, dir),
          h('span', { class: 'sr-count' }, String(f.matches.length)),
          h(
            'span',
            { class: 'sr-actions' },
            this.state.showReplace
              ? h(
                  'button',
                  {
                    class: 'sr-btn',
                    title: '이 파일에서 모두 바꾸기',
                    onclick: (e: MouseEvent) => {
                      e.stopPropagation();
                      this.replaceFiles([f]);
                    },
                  },
                  '⇄',
                )
              : null,
            h(
              'button',
              {
                class: 'sr-btn',
                title: '결과에서 제외',
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  this.files = this.files.filter((x) => x !== f);
                  this.renderResults();
                },
              },
              '×',
            ),
          ),
        ),
      );
      if (!open) continue;
      for (const m of f.matches) rows.push(this.matchRow(f, m, replacing));
    }
    this.results.replaceChildren(...rows);
  }

  private matchRow(f: FileMatches, m: Match, replacing: boolean): HTMLElement {
    return h(
      'div',
      {
        class: 'sr-match',
        title: `${f.rel}:${m.line}`,
        onclick: () => this.wb.reveal(f.path, m.line, m.col, m.len, false),
        ondblclick: () => this.wb.reveal(f.path, m.line, m.col, m.len, true),
      },
      h('span', { class: 'sr-line' }, String(m.line)),
      h(
        'span',
        { class: 'sr-preview' },
        m.before,
        replacing ? h('del', {}, m.text) : h('mark', {}, m.text),
        replacing ? h('ins', {}, this.state.replace) : null,
        m.after,
      ),
    );
  }
}

export const searchShortcut = isMac ? '⇧⌘F' : 'Ctrl+Shift+F';
