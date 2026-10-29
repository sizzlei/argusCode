// Side-by-side comparison (read-only). @codemirror/merge is loaded only
// when a diff is first opened.

import { api } from './backend';
import { viewerExtensions } from './editor';
import { contextMenu, errText, h, toast } from './ui';
import type { Doc, Workbench } from './workbench';

let wbRef: Workbench | null = null;
export function initDiff(wb: Workbench) {
  wbRef = wb;
}

/** 'saved': active document vs. the file on disk. 'tabs': pick another open document. */
export async function openDiff(kind: 'saved' | 'tabs') {
  const wb = wbRef;
  const t = wb?.activeTab;
  if (!wb || !t) return toast('비교할 문서를 먼저 여세요.');
  const doc = t.doc;
  const current = wb.textOf(doc);
  if (kind === 'saved') {
    if (!doc.path) return toast('저장된 적이 없는 문서입니다.');
    let saved: string;
    try {
      saved = (await api.ReadFile(doc.path)).content;
    } catch (e) {
      return toast('파일을 읽을 수 없습니다: ' + errText(e), 'error');
    }
    if (saved === current) return toast('저장된 버전과 같습니다.');
    show(wb, `${doc.name}: 디스크의 파일`, saved, `현재 편집본`, current, doc);
    return;
  }
  // Prefer the active document of the neighbouring editor group.
  const others = wb.allDocs().filter((d) => d !== doc);
  if (!others.length) return toast('비교할 다른 탭이 없습니다.');
  const pick = (o: Doc) => show(wb, o.name, wb.textOf(o), doc.name, current, doc);
  if (wb.groups.length > 1) {
    const g = wb.groups.find((x) => x !== wb.activeGroup && x.active && x.active.doc !== doc);
    if (g?.active) return pick(g.active.doc);
  }
  contextMenu(
    window.innerWidth / 2 - 120,
    120,
    others.map((o) => ({ label: `${o.name} 와(과) 비교`, hint: o.path ? '' : '저장 안 됨', action: () => pick(o) })),
  );
}

async function show(wb: Workbench, titleA: string, a: string, titleB: string, b: string, doc: Doc) {
  const { MergeView, goToNextChunk, goToPreviousChunk } = await import('@codemirror/merge');
  const ext = viewerExtensions(doc.lang, wb.settings.dialect, doc.large);
  const host = h('div', { class: 'diff-host' });
  const count = h('span', { class: 'diff-count' });
  let mv: InstanceType<typeof MergeView>;
  const nav = (dir: 1 | -1) => {
    const v = mv.b;
    (dir > 0 ? goToNextChunk : goToPreviousChunk)({ state: v.state, dispatch: (tr) => v.dispatch(tr) });
    v.focus();
  };
  const close = () => {
    mv.destroy();
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    wb.activeGroup.view.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'F7' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
      e.preventDefault();
      nav(e.shiftKey || e.key === 'ArrowUp' ? -1 : 1);
    }
  };
  const overlay = h(
    'div',
    { class: 'diff-overlay' },
    h(
      'div',
      { class: 'diff-panel' },
      h(
        'div',
        { class: 'diff-head' },
        h(
          'span',
          { class: 'diff-title' },
          h('span', { class: 'diff-a' }, titleA),
          '  ↔  ',
          h('span', { class: 'diff-b' }, titleB),
        ),
        count,
        h('button', { class: 'btn small', title: '이전 변경 (⇧F7)', onclick: () => nav(-1) }, '▲ 이전'),
        h('button', { class: 'btn small', title: '다음 변경 (F7)', onclick: () => nav(1) }, '▼ 다음'),
        h('button', { class: 'btn small', title: '닫기 (Esc)', onclick: close }, '닫기'),
      ),
      host,
    ),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  mv = new MergeView({
    a: { doc: a, extensions: ext },
    b: { doc: b, extensions: ext },
    parent: host,
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  const n = mv.chunks.length;
  count.textContent = n ? `변경 ${n}곳` : '차이 없음';
  requestAnimationFrame(() => {
    if (n) nav(1);
    else mv.b.focus();
  });
}
