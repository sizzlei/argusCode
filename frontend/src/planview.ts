// Execution plan viewer (rendered into an editor group's side panel).
// Loaded on demand the first time a plan is shown.

import { countNodes, fmt, formatLabel, parsePlan, Plan, PlanNode, WarnKind } from './plan';

export interface PlanViewHooks {
  /** Jump to a 0-based line in the source document. */
  jump(line: number): void;
}

const INDENT = 14;
const collapsedByEl = new WeakMap<HTMLElement, Set<string>>();

const WARN_ORDER: WarnKind[] = [
  'hot',
  'fullscan',
  'disksort',
  'filesort',
  'temporary',
  'examined',
  'conversion',
  'misestimate',
  'indexscan',
];
const WARN_SUMMARY: Record<WarnKind, string> = {
  hot: '',
  fullscan: '풀스캔',
  indexscan: '인덱스 풀스캔',
  filesort: '정렬',
  temporary: '임시 테이블',
  disksort: '디스크 정렬',
  misestimate: '행 추정 오차',
  examined: '과다 검사',
  conversion: '암시적 형변환',
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
    host.replaceChildren(help(text));
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
    el(
      'span',
      'plan-tag',
      p.format === 'mongo'
        ? p.analyzed
          ? 'executionStats (실제 실행값)'
          : 'queryPlanner (실행 안 함)'
        : p.format === 'oracle'
          ? p.analyzed
            ? 'ALLSTATS (실제 실행값)'
            : '예상값'
          : p.analyzed
            ? 'ANALYZE (실제 실행값)'
            : '예상값',
    ),
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
  for (const [k, v] of p.stats ?? []) stat(k, v);
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
  // Numeric columns: only those with at least one value in this plan (e.g.
  // Oracle ALLSTATS has no cost, MongoDB has no estimates).
  type Col = { label: string; width: number; get: (n: PlanNode) => number | undefined };
  const all: Col[] = [
    { label: '비용', width: 52, get: (n) => n.cost },
    { label: '예상 행', width: 52, get: (n) => n.rows },
    { label: p.format === 'mongo' ? '반환' : '실제 행', width: 56, get: (n) => n.actualRows },
    { label: '시간 ms', width: 56, get: (n) => n.actualTime },
    { label: '반복', width: 40, get: (n) => n.loops },
  ];
  const has = (c: Col) => {
    let found = false;
    const walk = (n: PlanNode) => {
      if (found) return;
      if (c.get(n) != null) found = true;
      else n.children.forEach(walk);
    };
    walk(p.root);
    return found;
  };
  const cols = all.filter(has);
  const t = el('div', 'plan-table');
  // Every row is its own grid, so size the operation column for the deepest
  // node: deep nodes keep a readable width and the panel scrolls sideways
  // instead of wrapping operation names one word per line.
  const depthOf = (n: PlanNode): number => (n.children.length ? 1 + Math.max(...n.children.map(depthOf)) : 0);
  const opMin = 170 + Math.min(depthOf(p.root), 14) * INDENT;
  const heatW = p.selfMetric === 'buffers' ? 84 : 70;
  t.style.setProperty('--plan-cols', `minmax(${opMin}px, 1fr) ${cols.map((c) => c.width + 'px').join(' ')} ${heatW}px`);
  t.style.minWidth = opMin + cols.reduce((s, c) => s + c.width + 6, 0) + heatW + 16 + 'px';
  const head = el('div', 'plan-row plan-colhead');
  head.append(el('span', 'pc-op', '작업'));
  for (const c of cols) head.append(el('span', 'pc-num', c.label));
  head.append(el('span', 'pc-heat', p.selfMetric === 'buffers' ? '자체 Buffers' : '자체'));
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
    for (const d of n.details) {
      const det = el('div', 'plan-detail', d);
      // Long predicates (Oracle filters can run to dozens of lines) are clamped
      // to two lines; click to expand / collapse.
      if (d.length > 180) {
        det.classList.add('clamp');
        det.title = '클릭해서 펼치기/접기';
        det.addEventListener('click', (e) => {
          e.stopPropagation();
          det.classList.toggle('open');
        });
      }
      main.append(det);
    }
    op.append(tw, main);
    row.append(op);
    for (const c of cols) row.append(el('span', 'pc-num', fmt(c.get(n))));
    const heat = el('span', 'pc-heat');
    const bar = el('span', 'plan-bar');
    bar.style.width = Math.round(n.heat * 100) + '%';
    bar.style.opacity = String(0.35 + n.heat * 0.65);
    heat.append(bar, el('span', 'plan-bar-label', n.self > 0 ? fmt(n.self) : ''));
    heat.title =
      n.self > 0
        ? `자체 ${{ buffers: 'Buffers', time: '시간', cost: '비용' }[p.selfMetric]} ${fmt(n.self)} (최대 대비 ${Math.round(
            n.heat * 100,
          )}%)`
        : '';
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

function help(text = ''): HTMLElement {
  const d = el('div', 'plan-help');
  if (/Predicate Information/i.test(text))
    d.append(
      el('h3', '', '실행계획 표가 없습니다'),
      el(
        'p',
        '',
        "Predicate Information만으로는 트리를 만들 수 없습니다. DBMS_XPLAN 결과의 'Plan hash value'부터 '| Id | Operation | …' 표까지 함께 붙여 넣으세요.",
      ),
    );
  d.append(
    el('h3', '', '실행계획을 인식할 수 없습니다'),
    el(
      'p',
      '',
      '이 문서에 아래 명령의 결과를 그대로 붙여 넣으세요. mysql / psql 클라이언트의 표 테두리와 mongosh 표기(Long(…) 등)는 자동으로 처리됩니다.',
    ),
  );
  const ul = el('ul');
  for (const s of [
    'MySQL — EXPLAIN FORMAT=JSON SELECT …',
    'MySQL — EXPLAIN FORMAT=TREE SELECT …  /  EXPLAIN ANALYZE SELECT …',
    'PostgreSQL — EXPLAIN (FORMAT JSON) SELECT …  /  EXPLAIN (ANALYZE, FORMAT JSON) …',
    'PostgreSQL — EXPLAIN SELECT …  /  EXPLAIN ANALYZE SELECT … (텍스트)',
    'Oracle — EXPLAIN PLAN FOR …; SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);',
    "Oracle — SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));  (실제 실행값, /*+ gather_plan_statistics */ 필요)",
    'MongoDB / DocumentDB — db.col.find(…).explain("executionStats")  /  db.col.explain("executionStats").aggregate([…])',
  ])
    ul.append(el('li', '', s));
  d.append(ul);
  return d;
}
