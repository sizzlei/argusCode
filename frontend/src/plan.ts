// Execution plan parser. Turns the output of
//   MySQL      EXPLAIN FORMAT=JSON  (v1 "query_block" and v2 "operation/inputs")
//   MySQL      EXPLAIN FORMAT=TREE / EXPLAIN ANALYZE (text tree)
//   PostgreSQL EXPLAIN (FORMAT JSON) [ANALYZE]
//   PostgreSQL EXPLAIN [ANALYZE] (text)
//   Oracle     DBMS_XPLAN.DISPLAY / DISPLAY_CURSOR (incl. ALLSTATS LAST)
//   MongoDB / DocumentDB explain() — queryPlanner / executionStats, find and
//              aggregate, sharded; strict JSON or mongosh output (Long('1'), …)
// into one tree model with costs, row estimates, actual statistics and
// warnings. No dependencies — unit-tested with Node.

export type PlanFormat = 'mysql-json' | 'mysql-json2' | 'mysql-tree' | 'pg-json' | 'pg-text' | 'oracle' | 'mongo';

export type WarnKind =
  'fullscan' | 'indexscan' | 'filesort' | 'temporary' | 'disksort' | 'misestimate' | 'examined' | 'conversion' | 'hot';

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
  /** Oracle logical reads (Buffers), inclusive. */
  buffers?: number;
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
  engine: 'MySQL' | 'PostgreSQL' | 'Oracle' | 'MongoDB';
  /** Extra header figures (label, value), e.g. MongoDB examined/returned. */
  stats?: [string, string][];
  root: PlanNode;
  totalCost?: number;
  planningTime?: number;
  executionTime?: number;
  analyzed: boolean; // has actual statistics
  /** What `self` / `heat` measure. */
  selfMetric: 'cost' | 'time' | 'buffers';
}

const FORMAT_LABEL: Record<PlanFormat, string> = {
  'mysql-json': 'MySQL · FORMAT=JSON',
  'mysql-json2': 'MySQL · FORMAT=JSON (v2)',
  'mysql-tree': 'MySQL · FORMAT=TREE',
  'pg-json': 'PostgreSQL · FORMAT JSON',
  'pg-text': 'PostgreSQL · TEXT',
  oracle: 'Oracle · DBMS_XPLAN',
  mongo: 'MongoDB · explain',
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
  // Oracle's plan table uses the same "| … |" borders the mysql cleanup strips.
  if (/\|\s*Id\s*\|\s*Operation\s*\|/i.test(input)) return parseOracle(input);
  const text = cleanClientOutput(input);
  const trimmed = text.trim();
  if (!trimmed) return null;
  // mongosh prompt before the result: "rs0 [primary] shop> {"
  const body = trimmed.replace(/^[^\n{]*?>\s*(?=[{[])/, '');
  const first = body[0];
  if (first === '{' || first === '[') {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      try {
        data = parseLoose(body); // mongosh / EJSON shell syntax
      } catch {
        return null;
      }
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
    if ('queryPlanner' in o || 'executionStats' in o || Array.isArray(o.stages) || 'shards' in o) return mongo(o);
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
  // Oracle A-Time has 10 ms resolution; Buffers (logical reads) pinpoint the
  // expensive step far better, so they drive the heat bar when present.
  let metric: Plan['selfMetric'] = analyzed ? 'time' : 'cost';
  if (format === 'oracle' && root.buffers != null) metric = 'buffers';
  computeSelf(root, metric, format);
  let max = 0;
  forEach(root, (n) => (max = Math.max(max, n.self)));
  forEach(root, (n) => {
    n.heat = max > 0 ? n.self / max : 0;
    // Big gap between estimated and actual rows → stale statistics.
    // Only scans and joins: Limit/Sort legitimately stop early.
    const relevant = !!n.table || !!n.index || /join|nested loop|hash|merge/i.test(n.op);
    if (relevant && n.rows != null && n.actualRows != null && n.loops != null) {
      const est = Math.max(1, n.rows);
      const act = Math.max(1, n.actualRows);
      // ≥ 10× off, and by enough rows in total to matter (not "1 → 18").
      const gap = Math.abs(n.rows - n.actualRows) * Math.max(1, n.loops);
      if ((act / est >= 10 || est / act >= 10) && gap >= 100)
        warn(n, 'misestimate', `행 추정 ${fmt(n.rows)} → 실제 ${fmt(n.actualRows)}`);
    }
  });
  // The heaviest node gets a "hot" badge.
  const hot = findMax(root);
  if (hot && max > 0)
    warn(hot, 'hot', metric === 'buffers' ? 'Buffers 최대' : metric === 'time' ? '가장 오래 걸림' : '비용 최대');
  return {
    format,
    engine:
      format === 'mongo'
        ? 'MongoDB'
        : format === 'oracle'
          ? 'Oracle'
          : format.startsWith('pg')
            ? 'PostgreSQL'
            : 'MySQL',
    root,
    totalCost: totalCost ?? root.cost,
    planningTime: 'root' in r ? r.planningTime : undefined,
    executionTime: 'root' in r ? r.executionTime : undefined,
    analyzed,
    selfMetric: metric,
  };
}

function hasActual(n: PlanNode): boolean {
  return n.actualTime != null || n.children.some(hasActual);
}

/** Self cost/time = inclusive minus children (tree formats report inclusive values). */
function computeSelf(n: PlanNode, metric: Plan['selfMetric'], format: PlanFormat) {
  for (const c of n.children) computeSelf(c, metric, format);
  if (format === 'mysql-json') return; // table nodes already carry read+eval cost
  // Nodes without a figure of their own (Oracle FILTER, SORT AGGREGATE …)
  // count as the sum of their children, so they don't make the parent look
  // as if it did all the work.
  const incl = (x: PlanNode): number => {
    const v = metric === 'buffers' ? x.buffers : metric === 'time' ? x.actualTime : x.cost;
    return v ?? x.children.reduce((s, c) => s + incl(c), 0);
  };
  const childSum = n.children.reduce((s, c) => s + incl(c), 0);
  n.self = Math.max(0, incl(n) - childSum);
}

// ---- Oracle DBMS_XPLAN ---------------------------------------------------------------
//
// Plan hash value: 2231215893
// ---------------------------------------------------------------------------
// | Id  | Operation           | Name    | Rows  | Bytes | Cost (%CPU)| Time     |
// ---------------------------------------------------------------------------
// |   0 | SELECT STATEMENT    |         |    10 |   500 |    25   (4)| 00:00:01 |
// |*  1 |  HASH JOIN          |         |    10 |   500 |    24   (0)| 00:00:01 |
// …
// Predicate Information (identified by operation id):
//    1 - access("M"."ID"="O"."MEMBER_ID")
//
// DISPLAY_CURSOR(format => 'ALLSTATS LAST') adds Starts, E-Rows, A-Rows,
// A-Time, Buffers, Reads, OMem/1Mem/Used-Mem, Used-Tmp.

/** "1000", "12K", "3M", "1G" → number */
const oraNum = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const m = /^\s*([\d.]+)\s*([KMGTP]?)\s*$/i.exec(v);
  if (!m) return undefined;
  const mult = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[m[2].toUpperCase()] ?? 1;
  return parseFloat(m[1]) * mult;
};

/** "00:00:01.23" / "00:00:01" → ms */
const oraTime = (v: string | undefined): number | undefined => {
  const m = v && /^\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(v);
  if (!m) return undefined;
  return ((+(m[1] ?? 0) * 60 + +m[2]) * 60 + +m[3]) * 1000;
};

const ORA_FULL = /^TABLE ACCESS (STORAGE )?FULL|^MAT_VIEW ACCESS (STORAGE )?FULL/;
const ORA_INDEX_FULL = /^INDEX (FAST )?FULL SCAN/;

function parseOracle(input: string): Plan | null {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const headAt = lines.findIndex((l) => /\|\s*Id\s*\|\s*Operation\s*\|/i.test(l));
  if (headAt < 0) return null;
  const cells = (l: string) =>
    l
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|');
  const head = cells(lines[headAt]).map((c) => c.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ci = {
    id: col('id'),
    op: col('operation'),
    name: col('name'),
    rows: col('rows', 'e-rows'),
    bytes: col('bytes', 'e-bytes'),
    cost: col('cost (%cpu)', 'cost', 'e-cost'),
    time: col('time', 'e-time'),
    starts: col('starts'),
    arows: col('a-rows'),
    atime: col('a-time'),
    buffers: col('buffers'),
    reads: col('reads'),
    writes: col('writes'),
    usedMem: col('used-mem'),
    usedTmp: col('used-tmp'),
    tempSpc: col('tempspc'),
    pstart: col('pstart'),
    pstop: col('pstop'),
  };

  interface Row {
    node: PlanNode;
    id: number;
    depth: number;
  }
  const rows: Row[] = [];
  for (let i = headAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*-{5,}\s*$/.test(l)) {
      if (rows.length) break; // closing border
      continue;
    }
    if (!/^\s*\|/.test(l)) {
      if (rows.length) break;
      continue;
    }
    const c = cells(l);
    const idm = /^\s*([*-]?)\s*(\d+)\s*$/.exec(c[ci.id] ?? '');
    if (!idm) continue;
    const opCell = c[ci.op] ?? '';
    const opText = opCell.trim();
    // Depth = indentation inside the Operation column (one space per level).
    const depth = Math.max(0, opCell.length - opCell.trimStart().length - 1);
    const n = node(opText.replace(/\s+/g, ' '), { line: i });
    const name = ci.name >= 0 ? c[ci.name]?.trim() : '';
    if (name) {
      if (/INDEX|DOMAIN/.test(n.op) && !/^TABLE ACCESS/.test(n.op)) n.index = name;
      else n.table = name;
    }
    n.cost = oraNum((c[ci.cost] ?? '').replace(/\(.*\)/, ''));
    n.rows = oraNum(c[ci.rows]);
    const starts = oraNum(c[ci.starts]);
    const arows = oraNum(c[ci.arows]);
    if (starts != null) n.loops = starts;
    // A-Rows is the total over all starts; keep it per start like E-Rows.
    if (arows != null) n.actualRows = starts ? arows / starts : arows;
    n.actualTime = oraTime(c[ci.atime]);
    if (ci.buffers >= 0) n.buffers = oraNum(c[ci.buffers]);
    if (idm[1] === '-') n.details.push('적응형 계획에서 사용 안 된 단계');
    const io: string[] = [];
    const add = (label: string, k: number) => {
      const v = c[k]?.trim();
      if (k >= 0 && v) io.push(`${label} ${v}`);
    };
    add('Reads', ci.reads);
    add('Writes', ci.writes);
    add('메모리', ci.usedMem);
    if (io.length) n.details.push(io.join(' · '));
    if (ci.pstart >= 0 && c[ci.pstart]?.trim())
      n.details.push(`파티션 ${c[ci.pstart].trim()} ~ ${c[ci.pstop]?.trim() ?? ''}`);

    if (ORA_FULL.test(n.op)) warn(n, 'fullscan', '테이블 풀스캔');
    if (ORA_INDEX_FULL.test(n.op)) warn(n, 'indexscan', '인덱스 풀스캔');
    if (/^SORT (ORDER BY|GROUP BY|UNIQUE|JOIN)|^WINDOW SORT/.test(n.op)) warn(n, 'filesort', '정렬');
    if (/CARTESIAN/.test(n.op)) warn(n, 'fullscan', '카티션 조인');
    if (/^TEMP TABLE TRANSFORMATION|^LOAD AS SELECT.*TEMP/.test(n.op)) warn(n, 'temporary', '임시 테이블');
    const tmp = (ci.usedTmp >= 0 ? c[ci.usedTmp] : ci.tempSpc >= 0 ? c[ci.tempSpc] : '')?.trim();
    if (tmp && oraNum(tmp)) warn(n, 'disksort', `임시 공간 ${tmp}`);
    rows.push({ node: n, id: +idm[2], depth });
  }
  if (!rows.length) return null;

  // Predicates and notes after the table.
  const byId = new Map(rows.map((r) => [r.id, r.node]));
  let section = '';
  let cur: PlanNode | undefined;
  const notes: string[] = [];
  for (let i = headAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*Predicate Information/i.test(l)) {
      section = 'pred';
      continue;
    }
    if (/^\s*Note\s*$/i.test(l)) {
      section = 'note';
      continue;
    }
    if (/^\s*(Column Projection|Query Block Name|Outline Data|Hint Report|Remote SQL)/i.test(l)) {
      section = '';
      continue;
    }
    if (/^\s*-{3,}\s*$/.test(l) || !l.trim()) continue;
    if (section === 'pred') {
      // "  11 - access(…)", then "       filter(…" for the same id, and long
      // expressions wrapped over several lines (joined back into one).
      const m = /^\s*(\d+)\s+-\s+(.*)$/.exec(l);
      const t = (m ? m[2] : l).trim();
      if (m) cur = byId.get(+m[1]);
      if (!cur) continue;
      if (m || /^(access|filter|storage)\(/i.test(t)) {
        cur.details.push(t);
        if (/INTERNAL_FUNCTION\(/i.test(t)) warn(cur, 'conversion', '암시적 형변환');
      } else {
        cur.details[cur.details.length - 1] += ' ' + t;
        if (/INTERNAL_FUNCTION\(/i.test(t)) warn(cur, 'conversion', '암시적 형변환');
      }
    } else if (section === 'note') {
      const t = l.replace(/^\s*-\s*/, '').trim();
      if (t) notes.push(t);
    }
  }

  // Build the tree from the indentation depth.
  const stack: Row[] = [];
  let root: PlanNode | null = null;
  for (const r of rows) {
    while (stack.length && stack[stack.length - 1].depth >= r.depth) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(r.node);
    else if (!root) root = r.node;
    else {
      // more than one top-level row: wrap them
      const wrap: PlanNode = node('계획');
      wrap.children.push(root, r.node);
      root = wrap;
    }
    stack.push(r);
  }
  if (!root) return null;
  for (const n of notes) root.details.push('참고: ' + n);

  const plan = finish({ root }, 'oracle');
  const stats: [string, string][] = [];
  const hash = /Plan hash value:\s*(\d+)/i.exec(input);
  const sqlId = /SQL_ID\s+([0-9a-z]{13})(?:,\s*child number\s*(\d+))?/i.exec(input);
  if (sqlId) stats.push(['SQL_ID', sqlId[1] + (sqlId[2] != null ? ` #${sqlId[2]}` : '')]);
  if (hash) stats.push(['Plan hash', hash[1]]);
  const estTime = ci.time >= 0 ? cells(lines[rows[0].node.line!])[ci.time]?.trim() : '';
  if (!plan.analyzed && estTime) stats.push(['예상 시간', estTime]);
  const top = rows[0].node;
  if (plan.analyzed && top.actualTime != null) plan.executionTime = top.actualTime;
  if (top.buffers != null) stats.push(['Buffers', fmt(top.buffers)]);
  plan.stats = stats;
  return plan;
}

// ---- MongoDB / DocumentDB explain ----------------------------------------------------

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const MONGO_STAGE: Record<string, string> = {
  COLLSCAN: '컬렉션 전체 스캔',
  IXSCAN: '인덱스 스캔',
  FETCH: '문서 읽기',
  SORT: '메모리 정렬',
  SORT_KEY_GENERATOR: '정렬 키 생성',
  PROJECTION_SIMPLE: '필드 선택',
  PROJECTION_DEFAULT: '필드 선택',
  PROJECTION_COVERED: '커버링 인덱스',
  LIMIT: '개수 제한',
  SKIP: '건너뛰기',
  COUNT_SCAN: '인덱스로 개수 세기',
  IDHACK: '_id 조회',
  EXPRESS_IXSCAN: '단건 인덱스 조회',
  OR: 'OR 결합',
  SORT_MERGE: '정렬 병합',
  SHARD_MERGE: '샤드 결과 병합',
  SHARDING_FILTER: '샤드 소유 필터',
  EOF: '결과 없음',
  GROUP: '그룹',
  // DocumentDB
  SUBSCAN: '하위 스캔',
  HASH_AGGREGATE: '해시 집계',
};

function mongo(o: Obj): Plan {
  const stats: [string, string][] = [];
  const es = isObj(o.executionStats) ? o.executionStats : undefined;
  const qp = isObj(o.queryPlanner) ? o.queryPlanner : undefined;
  let root: PlanNode;
  if (Array.isArray(o.stages)) root = mongoPipeline(o.stages);
  else if (isObj(o.shards) && !qp) root = mongoShardsMap(o.shards);
  else root = mongoQuery(qp, es);
  const top = es ?? (Array.isArray(o.stages) ? o.stages[0]?.$cursor?.executionStats : undefined);
  if (isObj(top)) {
    const ret = num(top.nReturned);
    const docs = num(top.totalDocsExamined);
    const keys = num(top.totalKeysExamined);
    if (ret != null) stats.push(['반환', fmt(ret)]);
    if (keys != null) stats.push(['검사 키', fmt(keys)]);
    if (docs != null) stats.push(['검사 문서', fmt(docs)]);
  }
  const ns = qp?.namespace ?? (Array.isArray(o.stages) ? o.stages[0]?.$cursor?.queryPlanner?.namespace : undefined);
  if (ns) stats.unshift(['컬렉션', String(ns)]);
  const plan = finish({ root, executionTime: num(top?.executionTimeMillis) }, 'mongo');
  plan.stats = stats;
  return plan;
}

/** A find/count/… explain: executionStages when available, else the winning plan. */
function mongoQuery(qp: Obj | undefined, es: Obj | undefined): PlanNode {
  const ns = qp?.namespace ? String(qp.namespace) : undefined;
  const stages = es?.executionStages;
  // Slot-based engine (MongoDB 7+, explainVersion 2) reports internal stages
  // in lower case (scan, nlj, ixseek …). Show the readable queryPlan instead
  // and attach the overall execution totals to its root.
  const sbe = isObj(stages) && /^[a-z]/.test(String(stages.stage ?? ''));
  if (isObj(stages) && !sbe) return mongoStage(stages, ns);
  let wp = qp?.winningPlan;
  if (isObj(wp?.queryPlan)) wp = wp.queryPlan;
  if (!isObj(wp)) return node('실행계획 없음');
  const root = mongoStage(wp, ns);
  if (es) {
    root.actualRows = num(es.nReturned);
    root.actualTime = num(es.executionTimeMillis);
    const examined = Math.max(num(es.totalDocsExamined) ?? 0, num(es.totalKeysExamined) ?? 0);
    root.details.push('SBE 실행 — 반환·시간·검사 수는 쿼리 전체 합계');
    if (root.actualRows != null && examined >= 1000 && examined / Math.max(1, root.actualRows) >= 10) {
      // Blame the scan that did the reading.
      let leaf = root;
      while (leaf.children.length) leaf = leaf.children[0];
      warn(leaf, 'examined', `${fmt(examined)}건 검사 → ${fmt(root.actualRows)}건 반환`);
    }
  }
  return root;
}

function mongoShardsMap(shards: Obj): PlanNode {
  const root = node('샤드');
  for (const [name, v] of Object.entries(shards)) {
    if (!isObj(v)) continue;
    const c = mongoQuery(v.queryPlanner, v.executionStats);
    c.details.unshift('샤드 ' + name);
    root.children.push(c);
  }
  return root;
}

function mongoStage(st: Obj, ns?: string): PlanNode {
  const stage = String(st.stage ?? '?');
  const n = node(stage);
  const ko = MONGO_STAGE[stage];
  if (ko) n.details.push(ko);
  if ((stage === 'COLLSCAN' || stage === 'IXSCAN' || stage === 'COUNT_SCAN' || stage === 'IDHACK') && ns)
    n.table = ns.replace(/^[^.]*\./, '');
  if (st.indexName) n.index = String(st.indexName);
  if (st.shardName) n.details.push('샤드 ' + st.shardName);
  if (isObj(st.keyPattern))
    n.details.push('키 ' + compact(st.keyPattern) + (st.direction === 'backward' ? ' (역순)' : ''));
  if (isObj(st.filter) && Object.keys(st.filter).length) n.details.push('필터 ' + compact(st.filter));
  if (isObj(st.indexBounds)) n.details.push('범위 ' + compact(st.indexBounds));
  if (isObj(st.sortPattern)) n.details.push('정렬 ' + compact(st.sortPattern));
  if (st.limitAmount != null) n.details.push('limit ' + st.limitAmount);
  if (st.skipAmount != null) n.details.push('skip ' + st.skipAmount);
  if (isObj(st.transformBy)) n.details.push('투영 ' + compact(st.transformBy));

  n.actualRows = num(st.nReturned);
  n.actualTime = num(st.executionTimeMillisEstimate ?? st.executionTimeMillis);
  const docs = num(st.docsExamined ?? st.totalDocsExamined);
  const keys = num(st.keysExamined ?? st.totalKeysExamined);
  const seen: string[] = [];
  if (keys) seen.push('키 ' + fmt(keys));
  if (docs) seen.push('문서 ' + fmt(docs));
  if (seen.length) n.details.push('검사 ' + seen.join(' · '));

  if (stage === 'COLLSCAN') warn(n, 'fullscan', '컬렉션 풀스캔');
  if (stage === 'SORT') warn(n, 'filesort', '메모리 정렬');
  if (st.usedDisk === true || st.spills > 0) warn(n, 'disksort', '디스크 사용');
  const examined = Math.max(docs ?? 0, keys ?? 0);
  if (n.actualRows != null && examined >= 1000 && examined / Math.max(1, n.actualRows) >= 10)
    warn(n, 'examined', `${fmt(examined)}건 검사 → ${fmt(n.actualRows)}건 반환`);

  const kids: Obj[] = [];
  if (isObj(st.inputStage)) kids.push(st.inputStage);
  if (Array.isArray(st.inputStages)) kids.push(...st.inputStages.filter(isObj));
  for (const k of kids) n.children.push(mongoStage(k, ns));
  if (Array.isArray(st.shards))
    for (const sh of st.shards.filter(isObj)) {
      const inner = sh.executionStages ?? sh.winningPlan?.queryPlan ?? sh.winningPlan;
      const c = isObj(inner) ? mongoStage(inner, ns) : node('샤드');
      if (sh.shardName) c.details.unshift('샤드 ' + sh.shardName);
      n.children.push(c);
    }
  return n;
}

/** aggregate() explain: stages[0] is $cursor (the query), later stages run on top of it. */
function mongoPipeline(stages: unknown[]): PlanNode {
  let below: PlanNode | null = null;
  for (const s of stages) {
    if (!isObj(s)) continue;
    let n: PlanNode;
    if (isObj(s.$cursor)) n = mongoQuery(s.$cursor.queryPlanner, s.$cursor.executionStats);
    else {
      const name = Object.keys(s).find((k) => k.startsWith('$')) ?? '?';
      n = node(name);
      const spec = s[name];
      if (spec != null) n.details.push(compact(spec));
      n.actualRows = num(s.nReturned);
      n.actualTime = num(s.executionTimeMillisEstimate);
      if (name === '$sort') warn(n, 'filesort', '메모리 정렬');
      if (s.usedDisk === true) warn(n, 'disksort', '디스크 사용');
      if (name === '$lookup' && num(s.collectionScans) && num(s.collectionScans)! > 0)
        warn(n, 'fullscan', `조인 대상 풀스캔 ${fmt(num(s.collectionScans))}회`);
    }
    if (below) n.children.push(below);
    below = n;
  }
  return below ?? node('aggregate');
}

function compact(v: unknown): string {
  const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x));
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

/**
 * Parses mongosh / shell-style output: unquoted keys, single quotes, trailing
 * commas, and wrappers like Long('5'), ObjectId("…"), ISODate(…),
 * Timestamp({ t: 1, i: 2 }), MinKey(), new Date(…). Wrappers become their
 * (first) argument. Throws on malformed input.
 */
export function parseLoose(src: string): unknown {
  let i = 0;
  const err = (m: string): never => {
    throw new Error(`${m} at ${i}`);
  };
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) while (i < src.length && src[i] !== '\n') i++;
      else break;
    }
  };
  const ident = () => {
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200));
    if (!m) err('identifier expected');
    i += m![0].length;
    return m![0];
  };
  const str = (): string => {
    const q = src[i++];
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const c = src[++i];
        if (c === 'u') {
          out += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
          i += 5;
          continue;
        }
        out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[c] ?? c;
        i++;
      } else out += src[i++];
    }
    if (src[i] !== q) err('unterminated string');
    i++;
    return out;
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === '}') {
          i++;
          return o;
        }
        const k = src[i] === '"' || src[i] === "'" ? str() : ident();
        ws();
        if (src[i++] !== ':') err("':' expected");
        o[k] = value();
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') err("',' or '}' expected");
      }
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === ']') {
          i++;
          return a;
        }
        a.push(value());
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') err("',' or ']' expected");
      }
    }
    if (c === '"' || c === "'") return str();
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    let id = ident();
    if (id === 'new') {
      ws();
      id = ident();
    }
    switch (id) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
      case 'undefined':
        return null;
      case 'Infinity':
        return Infinity;
      case 'NaN':
        return NaN;
    }
    while (src[i] === '.' && /[A-Za-z_$]/.test(src[i + 1] ?? '')) {
      i++;
      id += '.' + ident(); // Binary.createFromBase64(…)
    }
    ws();
    if (src[i] !== '(') return id; // bare word, e.g. MinKey inside bounds
    i++;
    ws();
    let arg: unknown = id;
    if (src[i] !== ')') {
      arg = value();
      ws();
      while (src[i] === ',') {
        i++;
        value();
        ws();
      }
    }
    if (src[i++] !== ')') err("')' expected");
    if (typeof arg === 'string' && /^(Long|NumberLong|NumberInt|Int32|Double|Decimal128|NumberDecimal)$/.test(id)) {
      const n = Number(arg);
      return Number.isFinite(n) ? n : arg;
    }
    return arg;
  };
  const v = value();
  ws();
  if (i < src.length) err('trailing text');
  return v;
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
