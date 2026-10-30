// DDL review side panel: the findings of the rule-based review for the active
// SQL document, grouped by statement, with severity filters, click-to-jump and
// "copy as Markdown" for tickets / review comments. Loaded on demand.

import { EditorView } from '@codemirror/view';
import { forEachDiagnostic, type Diagnostic } from '@codemirror/lint';

export interface ReviewInfo {
  path: string;
  count: number;
  errors: string[];
  /** The built-in online DDL impact check is on (works without a ruleset). */
  impact: boolean;
}

export interface ReviewHooks {
  info(): ReviewInfo | null;
  openSettings(): void;
  copy(text: string): void;
}

type Sev = 'error' | 'warning' | 'info';
const SEV: Sev[] = ['error', 'warning', 'info'];
const SEV_LABEL: Record<Sev, string> = { error: '오류', warning: '경고', info: '정보' };
const SEV_ICON: Record<Sev, string> = { error: '✕', warning: '⚠', info: 'ⓘ' };

const hidden = new Set<Sev>();
const collapsed = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const STMT = /^\s*(CREATE|ALTER|DROP|TRUNCATE|COMMENT\s+ON|RENAME)\b/i;

interface Item {
  d: Diagnostic;
  sev: Sev;
  line: number;
  id?: string;
  text: string;
}

export function renderReview(host: HTMLElement, view: EditorView, hooks: ReviewHooks) {
  host.className = 'review-view';
  const scroll = host.scrollTop;
  const info = hooks.info();
  const doc = view.state.doc;

  // Diagnostics of the DDL review, grouped by the statement they belong to.
  const groups = new Map<number, { title: string; line: number; items: Item[] }>();
  const counts: Record<Sev, number> = { error: 0, warning: 0, info: 0 };
  forEachDiagnostic(view.state, (d) => {
    if (d.source !== 'DDL 검토') return;
    const sev = (d.severity === 'hint' ? 'info' : d.severity) as Sev;
    counts[sev]++;
    const line = doc.lineAt(Math.min(d.from, doc.length));
    let head = line;
    for (let n = line.number; n >= 1 && n > line.number - 400; n--) {
      const l = doc.line(n);
      if (STMT.test(l.text)) {
        head = l;
        break;
      }
    }
    const m = /^\[([^\]]+)\]\s*/.exec(d.message);
    let g = groups.get(head.number);
    if (!g) groups.set(head.number, (g = { title: head.text.trim(), line: head.number, items: [] }));
    g.items.push({ d, sev, line: line.number, id: m?.[1], text: m ? d.message.slice(m[0].length) : d.message });
  });
  const total = counts.error + counts.warning + counts.info;

  // ---- header ---------------------------------------------------------------
  const head = el('div', 'rv-head');
  const title = el('div', 'rv-title');
  title.append(el('span', 'rv-name', 'DDL 검토'));
  if (info?.path) title.append(el('span', 'rv-rules', `규칙 ${info.count}개 · ${info.path.split(/[\\/]/).pop()}`));
  else if (info?.impact) title.append(el('span', 'rv-rules', '규칙 파일 없음 · 온라인 DDL 영향만 표시'));
  head.append(title);

  if (!info?.impact && (!info?.path || (!info.count && !info.errors.length))) {
    host.replaceChildren(
      head,
      notice(
        '규칙 파일이 없습니다',
        '설정 > DDL 검토에서 회사·팀 규칙 파일(YAML)을 지정하면 이 문서의 DDL을 검토합니다.',
        hooks,
      ),
    );
    return;
  }
  if (!info.impact && !info.count && info.errors.length) {
    host.replaceChildren(head, notice('규칙 파일에 오류가 있습니다', info.errors.slice(0, 5).join('\n'), hooks));
    return;
  }

  const bar = el('div', 'rv-bar');
  for (const s of SEV) {
    const b = el(
      'button',
      'rv-chip rv-' + s + (hidden.has(s) ? ' off' : ''),
      `${SEV_ICON[s]} ${SEV_LABEL[s]} ${counts[s]}`,
    );
    b.title = hidden.has(s) ? `${SEV_LABEL[s]} 보이기` : `${SEV_LABEL[s]} 숨기기`;
    b.addEventListener('click', () => {
      if (hidden.has(s)) hidden.delete(s);
      else hidden.add(s);
      renderReview(host, view, hooks);
    });
    bar.append(b);
  }
  const copy = el('button', 'rv-copy', 'Markdown 복사');
  copy.title = '검토 결과를 Markdown 표로 복사 (티켓·리뷰 코멘트용)';
  copy.disabled = !total;
  copy.addEventListener('click', () => hooks.copy(markdown([...groups.values()])));
  bar.append(copy);
  head.append(bar);

  if (!total) {
    const ok = el('div', 'rv-ok');
    ok.append(
      el('div', 'rv-ok-mark', '✓'),
      el(
        'div',
        '',
        /\b(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(doc.toString()) ? '지적할 내용이 없습니다' : '검토할 DDL이 없습니다',
      ),
    );
    host.replaceChildren(head, ok);
    return;
  }

  // ---- list -----------------------------------------------------------------
  const list = el('div', 'rv-list');
  const jump = (d: Diagnostic) => {
    view.dispatch({
      selection: { anchor: d.from, head: d.to },
      effects: EditorView.scrollIntoView(d.from, { y: 'center' }),
    });
    view.focus();
  };
  for (const g of [...groups.values()].sort((a, b) => a.line - b.line)) {
    const items = g.items.filter((i) => !hidden.has(i.sev));
    if (!items.length) continue;
    const key = g.title;
    const isCollapsed = collapsed.has(key);
    const gh = el('div', 'rv-group' + (isCollapsed ? '' : ' open'));
    const worst = SEV.find((s) => items.some((i) => i.sev === s))!;
    gh.append(
      el('span', 'rv-twisty'),
      el('span', 'rv-gtitle', g.title.length > 80 ? g.title.slice(0, 79) + '…' : g.title),
      el('span', 'rv-gcount rv-' + worst, String(items.length)),
    );
    gh.title = `${g.line}번째 줄`;
    gh.addEventListener('click', () => {
      if (isCollapsed) collapsed.delete(key);
      else collapsed.add(key);
      renderReview(host, view, hooks);
    });
    list.append(gh);
    if (isCollapsed) continue;
    for (const it of items) {
      const row = el('div', 'rv-item rv-' + it.sev);
      row.append(el('span', 'rv-icon', SEV_ICON[it.sev]));
      const body = el('div', 'rv-body');
      body.append(el('div', 'rv-msg', it.text));
      const meta = el('div', 'rv-meta');
      if (it.id) meta.append(el('span', 'rv-id', it.id));
      meta.append(el('span', 'rv-line', `줄 ${it.line}`));
      body.append(meta);
      row.append(body);
      row.title = '클릭하면 해당 위치로 이동';
      row.addEventListener('click', () => jump(it.d));
      list.append(row);
    }
  }
  host.replaceChildren(head, list);
  host.scrollTop = scroll;
}

function notice(title: string, text: string, hooks: ReviewHooks): HTMLElement {
  const d = el('div', 'rv-notice');
  const b = el('button', 'btn small', '설정 열기');
  b.addEventListener('click', () => hooks.openSettings());
  d.append(el('h3', '', title), el('p', '', text), b);
  return d;
}

function markdown(groups: { title: string; line: number; items: Item[] }[]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = ['| 심각도 | 규칙 | 줄 | 대상 | 내용 |', '| --- | --- | --- | --- | --- |'];
  for (const g of groups.sort((a, b) => a.line - b.line))
    for (const it of g.items)
      lines.push(
        `| ${SEV_LABEL[it.sev]} | ${esc(it.id ?? '')} | ${it.line} | ${esc(g.title.slice(0, 60))} | ${esc(it.text)} |`,
      );
  return lines.join('\n') + '\n';
}
