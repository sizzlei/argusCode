// Execution plan parser. Turns the output of
//   MySQL      EXPLAIN FORMAT=JSON  (v1 "query_block" and v2 "operation/inputs")
//   MySQL      EXPLAIN FORMAT=TREE / EXPLAIN ANALYZE (text tree)
//   PostgreSQL EXPLAIN (FORMAT JSON) [ANALYZE]
//   PostgreSQL EXPLAIN [ANALYZE] (text)
// into one tree model with costs, row estimates, actual statistics and
// warnings. No dependencies — unit-tested with Node.

export type PlanFormat = 'mysql-json' | 'mysql-json2' | 'mysql-tree' | 'pg-json' | 'pg-text';

export type WarnKind = 'fullscan' | 'indexscan' | 'filesort' | 'temporary' | 'disksort' | 'misestimate' | 'hot';

export interface PlanWarning {
  kind: WarnKind;
  label: string;
}

export interface PlanNode {
  op: string; // operation, e.g. "Table scan", "Index Scan", "Nested loop inner join"
  table?: string;
  index?: string;
  access?: string; // MySQL access_type (ALL, ref, range …)
  details: string[]; // conditions, keys, sort keys …
  cost?: number; // inclusive estimated cost (as reported)
  rows?: number; // estimated rows
  actualRows?: number;
  actualTime?: number; // inclusive ms (time × loops)
  loops?: number;
  /** Cost or time spent in this node itself (children excluded). */
  self: number;
  /** self / max(self) over the plan, 0..1 */
  heat: number;
  warnings: PlanWarning[];
  children: PlanNode[];
  /** 0-based line in the source text (text formats) for click-to-source. */
  line?: number;
}

export interface Plan {
  format: PlanFormat;
  engine: 'MySQL' | 'PostgreSQL';
  root: PlanNode;
  totalCost?: number;
  planningTime?: number;
  executionTime?: number;
  analyzed: boolean; // has actual statistics
}

const FORMAT_LABEL: Record<PlanFormat, string> = {
  'mysql-json': 'MySQL · FORMAT=JSON',
  'mysql-json2': 'MySQL · FORMAT=JSON (v2)',
  'mysql-tree': 'MySQL · FORMAT=TREE',
  'pg-json': 'PostgreSQL · FORMAT JSON',
  'pg-text': 'PostgreSQL · TEXT',
};
export const formatLabel = (f: PlanFormat) => FORMAT_LABEL[f];

const num = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

function node(op: string, extra: Partial<PlanNode> = {}): PlanNode {
  return { op, details: [], self: 0, heat: 0, warnings: [], children: [], ...extra };
}

const warn = (n: PlanNode, kind: WarnKind, label: string) => {
  if (!n.warnings.some((w) => w.kind === kind)) n.warnings.push({ kind, label });
};

// ---- entry point ---------------------------------------------------------------------

/** Parses plan text in any supported format; returns null if not recognised. */
export function parsePlan(input: string): Plan | null {
  const text = cleanClientOutput(input);
  const trimmed = text.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first === '{' || first === '[') {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return null;
    }
    return fromJson(data);
  }
  if (/^\s*->\s/m.test(text) && !/\bwidth=\d+/.test(text)) return finish(parseMysqlTree(text), 'mysql-tree');
  if (/\(cost=[\d.]+\.\.[\d.]+ rows=\d+ width=\d+\)/.test(text)) return finish(parsePgText(text), 'pg-text');
  return null;
}

/**
 * Removes decorations added by the mysql / psql clients so plans can be
 * pasted straight from a terminal:
 *   +-----+   | EXPLAIN |   | -> Limit … |   EXPLAIN: -> …   QUERY PLAN / ------
 */
function cleanClientOutput(s: string): string {
  // Keep the number of lines unchanged (removed lines become empty) so node
  // line numbers still point at the text in the editor.
  let lines = s.replace(/\r\n?/g, '\n').split('\n');
  const drop = (re: RegExp) => (lines = lines.map((l) => (re.test(l) ? '' : l)));
  drop(/^\s*\+[-+]+\+\s*$/); // mysql table borders
  drop(/^\s*\|\s*$/);
  lines = lines.map((l) => {
    // "| cell |" rows, and multi-line cells that only start (or only end) with "|"
    const m = /^\s*\|\s?(.*?)\s*\|\s*$/.exec(l) ?? /^\s*\|\s?(.*)$/.exec(l);
    return m ? m[1].replace(/\s*\|\s*$/, '') : l.replace(/\s+\|\s*$/, '');
  });
  lines = lines.map((l) => l.replace(/^\s*EXPLAIN:\s*/, '')); // vertical output
  drop(/^\s*(EXPLAIN|QUERY PLAN)\s*$/i);
  drop(/^\s*-{5,}\s*$/);
  drop(/^\s*\(\d+ rows?\)\s*$/); // psql footer
  drop(/^\s*\d+ rows? in set/); // mysql footer
  lines = lines.map((l) => l.replace(/\s+\+$/, '')); // psql wrap markers
  let out = lines.join('\n');
  // JSON pasted from mysql may contain literal \n escapes inside one cell
  const t = out.trim();
  if (/^[{[]/.test(t) && !t.includes('\n') && t.includes('\\n')) out = t.replace(/\\n/g, '\n');
  return out;
}

function fromJson(data: unknown): Plan | null {
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object' && 'Plan' in (data[0] as object)) {
    return pgJson(data[0] as Record<string, unknown>);
  }
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if ('Plan' in o) return pgJson(o);
    if ('query_block' in o)
      return finish(
        mysqlJson(o.query_block as Record<string, unknown>),
        'mysql-json',
        num((o.query_block as any)?.cost_info?.query_cost),
      );
    if ('operation' in o || 'inputs' in o) return finish(mysqlJson2(o), 'mysql-json2');
  }
  return null;
}

// ---- MySQL FORMAT=JSON (v1) ----------------------------------------------------------

const MYSQL_ACCESS: Record<string, string> = {
  ALL: '전체 스캔',
  index: '인덱스 전체 스캔',
  range: '인덱스 범위 스캔',
  ref: '인덱스 조회',
  eq_ref: '고유 인덱스 조회',
  const: '상수 조회',
  system: '시스템 테이블',
  ref_or_null: '인덱스 조회(NULL 포함)',
  index_merge: '인덱스 병합',
  fulltext: '전문 검색',
  unique_subquery: '고유 서브쿼리',
  index_subquery: '인덱스 서브쿼리',
};

function mysqlJson(qb: Record<string, unknown>, label = ''): PlanNode {
  const id = qb.select_id != null ? ` #${qb.select_id}` : '';
  const root = node((label || 'SELECT') + id, { cost: num((qb.cost_info as any)?.query_cost) });
  if (qb.message) root.details.push(String(qb.message));
  walkMysqlBlock(qb, root);
  return root;
}

function walkMysqlBlock(o: Record<string, unknown>, parent: PlanNode) {
  for (const [k, v] of Object.entries(o)) {
    if (v == null || typeof v !== 'object') continue;
    const obj = v as Record<string, unknown>;
    switch (k) {
      case 'ordering_operation': {
        const n = node('정렬 (ORDER BY)');
        if (obj.using_filesort) warn(n, 'filesort', 'filesort');
        if (obj.using_temporary_table) warn(n, 'temporary', '임시 테이블');
        parent.children.push(n);
        walkMysqlBlock(obj, n);
        break;
      }
      case 'grouping_operation': {
        const n = node('그룹화 (GROUP BY)');
        if (obj.using_filesort) warn(n, 'filesort', 'filesort');
        if (obj.using_temporary_table) warn(n, 'temporary', '임시 테이블');
        parent.children.push(n);
        walkMysqlBlock(obj, n);
        break;
      }
      case 'duplicates_removal': {
        const n = node('중복 제거 (DISTINCT)');
        if (obj.using_temporary_table) warn(n, 'temporary', '임시 테이블');
        if (obj.using_filesort) warn(n, 'filesort', 'filesort');
        parent.children.push(n);
        walkMysqlBlock(obj, n);
        break;
      }
      case 'windowing': {
        const n = node('윈도우 함수');
        if (obj.using_temporary_table) warn(n, 'temporary', '임시 테이블');
        parent.children.push(n);
        walkMysqlBlock(obj, n);
        break;
      }
      case 'nested_loop': {
        const n = node('Nested loop 조인');
        for (const item of v as Record<string, unknown>[]) walkMysqlBlock(item, n);
        parent.children.push(n);
        break;
      }
      case 'table':
        parent.children.push(mysqlTable(obj));
        break;
      case 'union_result': {
        const n = node('UNION 결과');
        if (obj.using_temporary_table) warn(n, 'temporary', '임시 테이블');
        for (const spec of (obj.query_specifications as Record<string, unknown>[]) ?? [])
          n.children.push(mysqlJson(spec.query_block as Record<string, unknown>));
        parent.children.push(n);
        break;
      }
      case 'attached_subqueries':
      case 'optimized_away_subqueries':
      case 'order_by_subqueries':
      case 'group_by_subqueries':
      case 'having_subqueries':
      case 'select_list_subqueries':
        for (const sq of v as Record<string, unknown>[]) {
          if (sq.query_block) parent.children.push(mysqlJson(sq.query_block as Record<string, unknown>, '서브쿼리'));
        }
        break;
      case 'query_block':
        parent.children.push(mysqlJson(obj));
        break;
    }
  }
}

function mysqlTable(t: Record<string, unknown>): PlanNode {
  const access = t.access_type ? String(t.access_type) : undefined;
  const ci = (t.cost_info ?? {}) as Record<string, unknown>;
  const n = node(access ? (MYSQL_ACCESS[access] ?? access) : '테이블', {
    table: t.table_name ? String(t.table_name) : undefined,
    index: t.key ? String(t.key) : undefined,
    access,
    rows: num(t.rows_examined_per_scan),
    cost: num(ci.prefix_cost),
  });
  n.self = (num(ci.read_cost) ?? 0) + (num(ci.eval_cost) ?? 0);
  if (access === 'ALL') warn(n, 'fullscan', '풀스캔');
  if (access === 'index') warn(n, 'indexscan', '인덱스 풀스캔');
  if (t.using_filesort) warn(n, 'filesort', 'filesort');
  if (t.using_temporary_table) warn(n, 'temporary', '임시 테이블');
  if (t.possible_keys && !t.key)
    n.details.push('사용 가능 인덱스: ' + (t.possible_keys as string[]).join(', ') + ' (미사용)');
  if (t.used_key_parts) n.details.push('사용 키: ' + (t.used_key_parts as string[]).join(', '));
  if (t.ref) n.details.push('ref: ' + (t.ref as string[]).join(', '));
  if (t.filtered != null) n.details.push(`filtered: ${t.filtered}%`);
  if (t.rows_produced_per_join != null) n.details.push(`조인 후 행: ${t.rows_produced_per_join}`);
  if (t.attached_condition) n.details.push('조건: ' + t.attached_condition);
  if (t.using_index) n.details.push('커버링 인덱스 (Using index)');
  if (t.materialized_from_subquery) {
    const m = t.materialized_from_subquery as Record<string, unknown>;
    if (m.query_block) n.children.push(mysqlJson(m.query_block as Record<string, unknown>, '파생 테이블'));
  }
  walkMysqlBlock(Object.fromEntries(Object.entries(t).filter(([k]) => k.endsWith('_subqueries'))), n);
  return n;
}

// ---- MySQL FORMAT=JSON v2 (8.3+ explain_json_format_version=2) -----------------------

function mysqlJson2(o: Record<string, unknown>): PlanNode {
  const op = String(o.operation ?? o.access_type ?? '?');
  const loops = num(o.actual_loops);
  const n = node(op, {
    table: o.table_name ? String(o.table_name) : undefined,
    index: o.index_name ? String(o.index_name) : undefined,
    access: o.access_type ? String(o.access_type) : undefined,
    cost: num(o.estimated_total_cost),
    rows: num(o.estimated_rows),
    actualRows: num(o.actual_rows),
    loops,
    actualTime: num(o.actual_last_row_ms) != null ? num(o.actual_last_row_ms)! * (loops ?? 1) : undefined,
  });
  if (o.condition) n.details.push('조건: ' + o.condition);
  if (o.ranges) n.details.push('범위: ' + (o.ranges as string[]).join(', '));
  mysqlTextWarnings(n);
  for (const c of (o.inputs as Record<string, unknown>[]) ?? []) n.children.push(mysqlJson2(c));
  return n;
}

// ---- MySQL FORMAT=TREE / EXPLAIN ANALYZE ----------------------------------------------

function parseMysqlTree(text: string): PlanNode {
  const lines = text.split('\n');
  const root = node('(root)');
  const stack: { depth: number; n: PlanNode }[] = [{ depth: -1, n: root }];
  lines.forEach((raw, i) => {
    const m = /^(\s*)->\s+(.*)$/.exec(raw);
    if (!m) {
      const top = stack[stack.length - 1].n;
      if (raw.trim() && top !== root) top.details.push(raw.trim());
      return;
    }
    const depth = m[1].length;
    const n = mysqlTreeNode(m[2]);
    n.line = i;
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].n.children.push(n);
    stack.push({ depth, n });
  });
  return root.children.length === 1 ? root.children[0] : Object.assign(root, { op: 'Query' });
}

function mysqlTreeNode(s: string): PlanNode {
  // "Filter: (o.a > 1)  (cost=1.2 rows=10) (actual time=0.01..0.02 rows=5 loops=1)"
  let op = s;
  const est = /\(cost=([\d.e+-]+)(?:\.\.([\d.e+-]+))? rows=([\d.e+-]+)\)/.exec(s);
  const act = /\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+-]+) loops=(\d+)\)/.exec(s);
  const cut = Math.min(
    ...[est?.index, act?.index, s.indexOf('(never executed)')].filter((x): x is number => x != null && x >= 0),
    s.length,
  );
  op = s.slice(0, cut).trim();
  const n = node(op, {
    cost: est ? num(est[2] ?? est[1]) : undefined,
    rows: est ? num(est[3]) : undefined,
  });
  if (act) {
    n.loops = num(act[4]);
    n.actualRows = num(act[3]);
    n.actualTime = num(act[2])! * (n.loops ?? 1);
  }
  // Split "Op on table using index" / "Op: details"
  const on = /^(.*?)\bon (\S+)(?: using (\S+))?(.*)$/.exec(op);
  if (on && /scan|lookup|search|Index range|Covering/i.test(on[1])) {
    n.op = on[1].trim() + (on[4] ? on[4] : '');
    n.table = on[2];
    if (on[3]) n.index = on[3];
  } else {
    const colon = op.indexOf(': ');
    if (colon > 0 && colon < 40) {
      n.op = op.slice(0, colon);
      n.details.push(op.slice(colon + 2));
    }
  }
  mysqlTextWarnings(n);
  if (s.includes('(never executed)')) n.details.push('실행되지 않음');
  return n;
}

function mysqlTextWarnings(n: PlanNode) {
  const op = n.op;
  if (/^Table scan/i.test(op) && n.table !== '<temporary>' && !/^<.*>$/.test(n.table ?? ''))
    warn(n, 'fullscan', '풀스캔');
  if (/^Index scan/i.test(op)) warn(n, 'indexscan', '인덱스 풀스캔');
  if (/^Sort\b/i.test(op) || n.access === 'sort') warn(n, 'filesort', '정렬(filesort)');
  if (/temporary/i.test(op) || n.table === '<temporary>' || /^<temporary>/.test(n.table ?? ''))
    warn(n, 'temporary', '임시 테이블');
}

// ---- PostgreSQL JSON ------------------------------------------------------------------

function pgJson(o: Record<string, unknown>): Plan | null {
  const p = o.Plan as Record<string, unknown> | undefined;
  if (!p) return null;
  const plan = finish(pgJsonNode(p), 'pg-json');
  plan.planningTime = num(o['Planning Time']);
  plan.executionTime = num(o['Execution Time']);
  return plan;
}

const PG_DETAIL_KEYS = [
  'Index Cond',
  'Recheck Cond',
  'Filter',
  'Join Filter',
  'Hash Cond',
  'Merge Cond',
  'Rows Removed by Filter',
  'Rows Removed by Index Recheck',
  'Rows Removed by Join Filter',
  'Sort Key',
  'Sort Method',
  'Sort Space Used',
  'Sort Space Type',
  'Group Key',
  'Presorted Key',
  'Strategy',
  'Join Type',
  'Scan Direction',
  'Heap Fetches',
  'Workers Planned',
  'Workers Launched',
  'Subplan Name',
  'Parent Relationship',
  'CTE Name',
  'Function Name',
];

function pgJsonNode(p: Record<string, unknown>): PlanNode {
  const loops = num(p['Actual Loops']);
  const n = node(String(p['Node Type'] ?? '?'), {
    table: p['Relation Name']
      ? String(p['Relation Name']) + (p.Alias && p.Alias !== p['Relation Name'] ? ' ' + p.Alias : '')
      : undefined,
    index: p['Index Name'] ? String(p['Index Name']) : undefined,
    cost: num(p['Total Cost']),
    rows: num(p['Plan Rows']),
    actualRows: num(p['Actual Rows']),
    loops,
    actualTime: num(p['Actual Total Time']) != null ? num(p['Actual Total Time'])! * (loops ?? 1) : undefined,
  });
  for (const k of PG_DETAIL_KEYS) {
    const v = p[k];
    if (v == null || k === 'Parent Relationship') continue;
    n.details.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  pgWarnings(n, p['Sort Space Type'] === 'Disk' || /external/i.test(String(p['Sort Method'] ?? '')));
  for (const c of (p.Plans as Record<string, unknown>[]) ?? []) n.children.push(pgJsonNode(c));
  return n;
}

function pgWarnings(n: PlanNode, diskSort: boolean) {
  if (/^Seq Scan|^Parallel Seq Scan/.test(n.op)) warn(n, 'fullscan', '풀스캔');
  if (diskSort) warn(n, 'disksort', '디스크 정렬');
}

// ---- PostgreSQL text ------------------------------------------------------------------

function parsePgText(text: string): { root: PlanNode; planningTime?: number; executionTime?: number } | PlanNode {
  const lines = text.split('\n');
  let root: PlanNode | null = null;
  const stack: { indent: number; n: PlanNode }[] = [];
  let planningTime: number | undefined;
  let executionTime: number | undefined;
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const pt = /^\s*Planning [Tt]ime:\s*([\d.]+)/.exec(raw);
    if (pt) return void (planningTime = num(pt[1]));
    const et = /^\s*Execution [Tt]ime:\s*([\d.]+)/.exec(raw);
    if (et) return void (executionTime = num(et[1]));
    const arrow = /^(\s*)->\s+(.*)$/.exec(raw);
    const isNode = /\(cost=/.test(raw) && (arrow || !root);
    if (isNode) {
      const indent = arrow ? arrow[1].length : 0;
      const body = arrow ? arrow[2] : raw.trim();
      const n = pgTextNode(body);
      n.line = i;
      if (!root) {
        root = n;
        stack.push({ indent: -1, n });
        return;
      }
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      stack[stack.length - 1].n.children.push(n);
      stack.push({ indent, n });
      return;
    }
    // Detail line (Filter:, Index Cond:, Sort Method: …) belongs to the last node.
    const top = stack[stack.length - 1]?.n;
    if (top) {
      const d = raw.trim();
      top.details.push(d);
      if (/Sort Method:.*(external|Disk)/i.test(d)) warn(top, 'disksort', '디스크 정렬');
    }
  });
  if (!root) return node('(empty)');
  return { root, planningTime, executionTime };
}

function pgTextNode(s: string): PlanNode {
  const est = /\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+) width=\d+\)/.exec(s);
  const act = /\(actual time=([\d.]+)\.\.([\d.]+) rows=(\d+) loops=(\d+)\)/.exec(s);
  const head = s.slice(0, est ? est.index : s.length).trim();
  const n = node(head, { cost: est ? num(est[2]) : undefined, rows: est ? num(est[3]) : undefined });
  if (act) {
    n.loops = num(act[4]);
    n.actualRows = num(act[3]);
    n.actualTime = num(act[2])! * (n.loops ?? 1);
  }
  if (/never executed/.test(s)) n.details.push('실행되지 않음');
  // "Index Scan using idx on orders o" / "Seq Scan on orders o"
  const m = /^(.*?)(?: using (\S+))? on (\S+(?: \S+)?)$/.exec(head);
  if (m) {
    n.op = m[1];
    n.index = m[2];
    n.table = m[3];
  }
  pgWarnings(n, false);
  return n;
}

// ---- post-processing -------------------------------------------------------------------

function finish(
  r: PlanNode | { root: PlanNode; planningTime?: number; executionTime?: number },
  format: PlanFormat,
  totalCost?: number,
): Plan {
  const root = 'root' in r ? r.root : r;
  const analyzed = hasActual(root);
  computeSelf(root, analyzed, format);
  let max = 0;
  forEach(root, (n) => (max = Math.max(max, n.self)));
  forEach(root, (n) => {
    n.heat = max > 0 ? n.self / max : 0;
    // Big gap between estimated and actual rows → stale statistics.
    // Only scans and joins: Limit/Sort legitimately stop early.
    const relevant = !!n.table || /join|nested loop|hash|merge/i.test(n.op);
    if (relevant && n.rows != null && n.actualRows != null && n.loops != null) {
      const est = Math.max(1, n.rows);
      const act = Math.max(1, n.actualRows);
      if (act / est >= 10 || est / act >= 10)
        warn(n, 'misestimate', `행 추정 ${fmt(n.rows)} → 실제 ${fmt(n.actualRows)}`);
    }
  });
  // The heaviest node gets a "hot" badge.
  const hot = findMax(root);
  if (hot && max > 0) warn(hot, 'hot', analyzed ? '가장 오래 걸림' : '비용 최대');
  return {
    format,
    engine: format.startsWith('pg') ? 'PostgreSQL' : 'MySQL',
    root,
    totalCost: totalCost ?? root.cost,
    planningTime: 'root' in r ? r.planningTime : undefined,
    executionTime: 'root' in r ? r.executionTime : undefined,
    analyzed,
  };
}

function hasActual(n: PlanNode): boolean {
  return n.actualTime != null || n.children.some(hasActual);
}

/** Self cost/time = inclusive minus children (tree formats report inclusive values). */
function computeSelf(n: PlanNode, analyzed: boolean, format: PlanFormat) {
  for (const c of n.children) computeSelf(c, analyzed, format);
  if (format === 'mysql-json') return; // table nodes already carry read+eval cost
  const incl = (x: PlanNode) => (analyzed ? x.actualTime : x.cost) ?? 0;
  const childSum = n.children.reduce((s, c) => s + incl(c), 0);
  n.self = Math.max(0, incl(n) - childSum);
}

function forEach(n: PlanNode, fn: (n: PlanNode) => void) {
  fn(n);
  for (const c of n.children) forEach(c, fn);
}

function findMax(n: PlanNode): PlanNode | null {
  let best: PlanNode | null = null;
  forEach(n, (x) => {
    if (x.self > 0 && (!best || x.self > best.self)) best = x;
  });
  return best;
}

export function fmt(v: number | undefined): string {
  if (v == null) return '';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'K';
  if (Number.isInteger(v)) return String(v);
  return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
}

export function countNodes(n: PlanNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}
