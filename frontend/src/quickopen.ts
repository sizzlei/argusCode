// Cmd/Ctrl+P fuzzy file finder.

import { api, basename, join } from './backend';
import { langForName, LANGS } from './languages';
import { h, toast } from './ui';

let cache: { root: string; files: string[] } | null = null;

export function invalidateQuickOpen() {
  cache = null;
}

/** Scores `q` as a subsequence of `s`; higher is better, -1 = no match. */
function score(q: string, s: string): number {
  const ls = s.toLowerCase();
  const base = ls.slice(ls.lastIndexOf('/') + 1);
  let si = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    const i = ls.indexOf(ch, si);
    if (i < 0) return -1;
    streak = i === si ? streak + 1 : 0;
    total += 1 + streak * 2 + (i === 0 || '/._-'.includes(ls[i - 1]) ? 3 : 0);
    si = i + 1;
  }
  if (base.includes(q)) total += 20;
  if (base.startsWith(q)) total += 10;
  return total - s.length * 0.01;
}

export async function quickOpen(root: string, open: (path: string) => void, recent: string[]) {
  if (!root) {
    toast('먼저 폴더를 여세요.');
    return;
  }
  if (document.querySelector('.quick-open')) return;
  const prevFocus = document.activeElement as HTMLElement | null;
  const input = h('input', { class: 'input', placeholder: '파일 이름으로 검색…', spellcheck: 'false' });
  const list = h('div', { class: 'qo-list' });
  const panel = h('div', { class: 'quick-open' }, input, list);
  const overlay = h('div', { class: 'qo-overlay' }, panel);
  document.body.append(overlay);
  input.focus();

  let files: string[] = [];
  let results: string[] = [];
  let sel = 0;

  const close = (restore = true) => {
    overlay.remove();
    if (restore) prevFocus?.focus?.();
  };

  const render = () => {
    list.replaceChildren(
      ...results.map((rel, i) => {
        const name = basename(rel);
        const dir = rel.slice(0, rel.length - name.length).replace(/\/$/, '');
        const lang = langForName(name);
        const row = h(
          'div',
          { class: 'qo-row' + (i === sel ? ' sel' : '') },
          h('span', { class: 'badge lang-' + lang }, LANGS[lang].badge),
          h('span', { class: 'qo-name' }, name),
          h('span', { class: 'qo-dir' }, dir),
        );
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(i);
        });
        return row;
      }),
    );
    if (!results.length)
      list.append(h('div', { class: 'qo-empty' }, files.length ? '일치하는 파일이 없습니다.' : '불러오는 중…'));
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };

  const filter = () => {
    const q = input.value.trim().toLowerCase().replace(/\\/g, '/').replace(/\s+/g, '');
    if (!q) {
      const rec = recent.filter((r) => files.includes(r));
      results = [...rec, ...files.filter((f) => !rec.includes(f))].slice(0, 50);
    } else {
      results = files
        .map((f) => [f, score(q, f)] as const)
        .filter(([, s]) => s >= 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([f]) => f);
    }
    sel = 0;
    render();
  };

  const choose = (i: number) => {
    const rel = results[i];
    if (!rel) return;
    close(false);
    open(join(root, rel));
  };

  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // Korean IME composition in progress
    if (e.key === 'ArrowDown') {
      sel = Math.min(results.length - 1, sel + 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      sel = Math.max(0, sel - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  render();
  if (cache?.root === root) files = cache.files;
  else {
    try {
      files = await api.ListFiles(root);
      cache = { root, files };
    } catch (e) {
      files = [];
    }
  }
  filter();
}
