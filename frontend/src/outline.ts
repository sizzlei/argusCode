// Sidebar "Outline" view: statements (SQL), headings (Markdown), keys (JSON/YAML).

import { EditorView } from '@codemirror/view';
import { h } from './ui';
import { outline, OutlineItem } from './structure';
import type { Workbench } from './workbench';

export class OutlineView {
  private list: HTMLElement;
  private title: HTMLElement;
  private filterInput: HTMLInputElement;
  private items: OutlineItem[] = [];
  private timer = 0;
  private lastKey = '';
  visible = false;

  constructor(
    el: HTMLElement,
    private wb: Workbench,
  ) {
    this.title = h('div', { class: 'pane-title' }, '개요');
    this.filterInput = h('input', { class: 'sf-input outline-filter', placeholder: '필터', spellcheck: 'false' });
    this.filterInput.addEventListener('input', () => this.render());
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.filterInput.value = '';
        this.render();
      }
    });
    this.list = h('div', { class: 'outline-list' });
    el.append(
      h('div', { class: 'pane-head' }, this.title),
      h('div', { class: 'outline-filter-wrap' }, this.filterInput),
      this.list,
    );
  }

  /** Recomputes the outline soon (debounced; skipped while hidden). */
  update(delay = 250) {
    if (!this.visible) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.compute(), delay);
  }

  private compute() {
    const t = this.wb.activeTab;
    if (!t || t.doc.large) {
      this.items = [];
      this.lastKey = '';
      this.title.textContent = '개요';
      this.render(t?.doc.large ? '대용량 파일은 개요를 만들지 않습니다.' : '열린 문서가 없습니다.');
      return;
    }
    const st = this.wb.stateOf(t);
    const key = t.doc.id + ':' + st.doc.length + ':' + st.doc.lines + ':' + t.doc.lang;
    if (key !== this.lastKey || !this.items.length) {
      this.items = outline(st, t.doc.lang);
      this.lastKey = key;
    }
    this.title.textContent = '개요 — ' + t.doc.name;
    this.render(this.items.length ? '' : '표시할 항목이 없습니다.');
  }

  private render(empty = '') {
    const t = this.wb.activeTab;
    const q = this.filterInput.value.trim().toLowerCase();
    const head = t ? this.wb.stateOf(t).selection.main.head : -1;
    let current = -1;
    this.items.forEach((it, i) => {
      if (it.from <= head) current = i;
    });
    const rows = this.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => !q || it.label.toLowerCase().includes(q) || it.detail?.toLowerCase().includes(q))
      .map(({ it, i }) =>
        h(
          'div',
          {
            class: 'outline-row' + (i === current ? ' current' : ''),
            style: { paddingLeft: 12 + (q ? 0 : it.level) * 14 + 'px' },
            title: it.detail ? `${it.label} — ${it.detail}` : it.label,
            onclick: () => this.jump(it),
          },
          h('span', { class: 'outline-label' }, it.label),
          it.detail ? h('span', { class: 'outline-detail' }, it.detail) : null,
        ),
      );
    if (!rows.length) rows.push(h('div', { class: 'tree-empty' }, empty || (q ? '일치하는 항목이 없습니다.' : '')));
    this.list.replaceChildren(...rows);
    this.list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  /** Cursor moved: only re-highlight the current item. */
  cursorMoved() {
    if (!this.visible) return;
    if (!this.items.length) return this.update();
    this.render();
  }

  private jump(it: OutlineItem) {
    const t = this.wb.activeTab;
    if (!t) return;
    const v = t.group.view;
    v.dispatch({
      selection: { anchor: it.from },
      effects: EditorView.scrollIntoView(it.from, { y: 'start', yMargin: 40 }),
    });
    v.focus();
  }
}
