// Execution plan viewer (rendered into an editor group's side panel).
// Loaded on demand the first time a plan is shown.

import { countNodes, fmt, formatLabel, parsePlan, Plan, PlanNode, WarnKind } from './plan';

export interface PlanViewHooks {
  /** Jump to a 0-based line in the source document. */
  jump(line: number): void;
}

const INDENT = 14;
const collapsedByEl = new WeakMap<HTMLElement, Set<string>>();

const WARN_ORDER: WarnKind[] = ['hot', 'fullscan', 'disksort', 'filesort', 'temporary', 'misestimate', 'indexscan'];
const WARN_SUMMARY: Record<WarnKind, string> = {
  hot: '',
  fullscan: '풀스캔',
  indexscan: '인덱스 풀스캔',
  filesort: '정렬',
  temporary: '임시 테이블',
  disksort: '디스크 정렬',
  misestimate: '행 추정 오차',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function renderPlanView(host: HTMLElement, text: string, hooks: PlanViewHooks) {
  host.className = 'plan-view';
  const plan = parsePlan(text);
  if (!plan) {
    host.replaceChildren(help());
    return;
  }
  let collapsed = collapsedByEl.get(host);
  if (!collapsed) collapsedByEl.set(host, (collapsed = new Set()));
  const scroll = host.scrollTop;
  host.replaceChildren(
    header(plan),
    table(plan, collapsed, hooks, () => renderPlanView(host, text, hooks)),
  );
  host.scrollTop = scroll;
}

function header(p: Plan): HTMLElement {
  const h = el('div', 'plan-head');
  const title = el('div', 'plan-title');
  title.append(
    el('span', 'plan-engine', formatLabel(p.format)),
    el('span', 'plan-tag', p.analyzed ? 'ANALYZE (실제 실행값)' : '예상값'),
  );
  h.append(title);

  const stats = el('div', 'plan-stats');
  const stat = (label: string, value: string) => {
    const s = el('span', 'plan-stat');
    s.append(el('span', 'plan-stat-label', label), el('b', '', value));
    stats.append(s);
  };
  if (p.totalCost != null) stat('총 비용', fmt(p.totalCost));
  if (p.executionTime != null) stat('실행', fmt(p.executionTime) + ' ms');
  if (p.planningTime != null) stat('계획', fmt(p.planningTime) + ' ms');
  stat('노드', String(countNodes(p.root)));
  h.append(stats);

  // Warning summary
  const counts = new Map<WarnKind, number>();
  const walk = (n: PlanNode) => {
    for (const w of n.warnings) counts.set(w.kind, (counts.get(w.kind) ?? 0) + 1);
    n.children.forEach(walk);
  };
  walk(p.root);
  const chips = el('div', 'plan-summary');
  for (const k of WARN_ORDER) {
    const c = counts.get(k);
    if (!c || k === 'hot') continue;
    chips.append(el('span', 'plan-badge w-' + k, `${WARN_SUMMARY[k]} ${c}`));
  }
  if (!chips.childElementCount) chips.append(el('span', 'plan-ok', '눈에 띄는 경고 없음'));
  h.append(chips);
  return h;
}

function table(p: Plan, collapsed: Set<string>, hooks: PlanViewHooks, rerender: () => void): HTMLElement {
  const t = el('div', 'plan-table' + (p.analyzed ? ' analyzed' : ''));
  // Every row is its own grid, so size the operation column for the deepest
  // node: deep nodes keep a readable width and the panel scrolls sideways
  // instead of wrapping operation names one word per line.
  const depthOf = (n: PlanNode): number => (n.children.length ? 1 + Math.max(...n.children.map(depthOf)) : 0);
  const opMin = 170 + Math.min(depthOf(p.root), 14) * INDENT;
  t.style.setProperty('--plan-op-min', opMin + 'px');
  t.style.minWidth = opMin + (p.analyzed ? 360 : 210) + 'px';
  const head = el('div', 'plan-row plan-colhead');
  head.append(el('span', 'pc-op', '작업'), el('span', 'pc-num', '비용'), el('span', 'pc-num', '예상 행'));
  if (p.analyzed)
    head.append(el('span', 'pc-num', '실제 행'), el('span', 'pc-num', '시간 ms'), el('span', 'pc-num', '반복'));
  head.append(el('span', 'pc-heat', '자체'));
  t.append(head);

  const add = (n: PlanNode, depth: number, path: string) => {
    const isCollapsed = collapsed.has(path);
    const row = el('div', 'plan-row' + (n.warnings.some((w) => w.kind === 'hot') ? ' hot' : ''));
    const op = el('div', 'pc-op');
    op.style.paddingLeft = 6 + depth * INDENT + 'px';
    const tw = el('span', 'plan-twisty' + (n.children.length ? (isCollapsed ? '' : ' open') : ' leaf'));
    if (n.children.length) {
      tw.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isCollapsed) collapsed.delete(path);
        else collapsed.add(path);
        rerender();
      });
    }
    const main = el('div', 'plan-main');
    const line1 = el('div', 'plan-line1');
    line1.append(el('span', 'plan-op', n.op));
    if (n.table) line1.append(el('span', 'plan-chip t', n.table));
    if (n.index) line1.append(el('span', 'plan-chip i', n.index));
    for (const w of [...n.warnings].sort((a, b) => WARN_ORDER.indexOf(a.kind) - WARN_ORDER.indexOf(b.kind)))
      line1.append(el('span', 'plan-badge w-' + w.kind, w.label));
    main.append(line1);
    for (const d of n.details) main.append(el('div', 'plan-detail', d));
    op.append(tw, main);
    row.append(op, el('span', 'pc-num', fmt(n.cost)), el('span', 'pc-num', fmt(n.rows)));
    if (p.analyzed)
      row.append(
        el('span', 'pc-num', fmt(n.actualRows)),
        el('span', 'pc-num', fmt(n.actualTime)),
        el('span', 'pc-num', fmt(n.loops)),
      );
    const heat = el('span', 'pc-heat');
    const bar = el('span', 'plan-bar');
    bar.style.width = Math.round(n.heat * 100) + '%';
    bar.style.opacity = String(0.35 + n.heat * 0.65);
    heat.append(bar, el('span', 'plan-bar-label', n.self > 0 ? fmt(n.self) : ''));
    heat.title =
      n.self > 0 ? `자체 ${p.analyzed ? '시간' : '비용'} ${fmt(n.self)} (최대 대비 ${Math.round(n.heat * 100)}%)` : '';
    row.append(heat);
    if (n.line != null) {
      row.classList.add('jump');
      row.title = '클릭하면 원문 줄로 이동';
      row.addEventListener('click', () => hooks.jump(n.line!));
    }
    t.append(row);
    if (!isCollapsed) n.children.forEach((c, i) => add(c, depth + 1, path + '.' + i));
  };
  add(p.root, 0, '0');
  return t;
}

function help(): HTMLElement {
  const d = el('div', 'plan-help');
  d.append(
    el('h3', '', '실행계획을 인식할 수 없습니다'),
    el(
      'p',
      '',
      '이 문서에 아래 명령의 결과를 그대로 붙여 넣으세요. mysql / psql 클라이언트의 표 테두리는 자동으로 제거됩니다.',
    ),
  );
  const ul = el('ul');
  for (const s of [
    'MySQL — EXPLAIN FORMAT=JSON SELECT …',
    'MySQL — EXPLAIN FORMAT=TREE SELECT …  /  EXPLAIN ANALYZE SELECT …',
    'PostgreSQL — EXPLAIN (FORMAT JSON) SELECT …  /  EXPLAIN (ANALYZE, FORMAT JSON) …',
    'PostgreSQL — EXPLAIN SELECT …  /  EXPLAIN ANALYZE SELECT … (텍스트)',
  ])
    ul.append(el('li', '', s));
  d.append(ul);
  return d;
}
