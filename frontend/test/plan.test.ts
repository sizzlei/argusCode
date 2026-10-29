import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, type PlanNode } from '../src/plan.ts';

const flat = (n: PlanNode, d = 0, out: string[] = []) => {
  out.push(`${'  '.repeat(d)}${n.op}${n.table ? ' [' + n.table + ']' : ''}${n.index ? ' {' + n.index + '}' : ''}${n.warnings.length ? ' !' + n.warnings.map((w) => w.kind).join(',') : ''}`);
  n.children.forEach((c) => flat(c, d + 1, out));
  return out;
};

const mysqlJson = `{
  "query_block": {
    "select_id": 1,
    "cost_info": { "query_cost": "1043.75" },
    "ordering_operation": {
      "using_filesort": true,
      "grouping_operation": {
        "using_temporary_table": true,
        "using_filesort": false,
        "nested_loop": [
          { "table": { "table_name": "o", "access_type": "ALL", "possible_keys": ["idx_member"],
              "rows_examined_per_scan": 10000, "rows_produced_per_join": 3333, "filtered": "33.33",
              "cost_info": { "read_cost": "700.00", "eval_cost": "333.30", "prefix_cost": "1033.30" },
              "attached_condition": "(\`shop\`.\`o\`.\`created_at\` >= '2026-10-01')" } },
          { "table": { "table_name": "m", "access_type": "eq_ref", "possible_keys": ["PRIMARY"], "key": "PRIMARY",
              "used_key_parts": ["id"], "ref": ["shop.o.member_id"], "rows_examined_per_scan": 1,
              "rows_produced_per_join": 3333, "filtered": "100.00",
              "cost_info": { "read_cost": "3.33", "eval_cost": "7.12", "prefix_cost": "1043.75" } } }
        ]
      }
    }
  }
}`;

test('MySQL FORMAT=JSON (v1)', () => {
  const p = parsePlan(mysqlJson)!;
  assert.equal(p.format, 'mysql-json');
  assert.equal(p.totalCost, 1043.75);
  assert.deepEqual(flat(p.root), [
    'SELECT #1',
    '  정렬 (ORDER BY) !filesort',
    '    그룹화 (GROUP BY) !temporary',
    '      Nested loop 조인',
    '        전체 스캔 [o] !fullscan,hot',
    '        고유 인덱스 조회 [m] {PRIMARY}',
  ]);
  const o = p.root.children[0].children[0].children[0].children[0];
  assert.equal(o.heat, 1);
  assert.ok(o.details.some((d) => d.includes('idx_member') && d.includes('미사용')));
});

const mysqlTree = `+-------------------------------------------------------------------------------+
| EXPLAIN                                                                       |
+-------------------------------------------------------------------------------+
| -> Limit: 100 row(s)  (cost=2.6 rows=100) (actual time=5.2..5.3 rows=100 loops=1)
    -> Sort: total DESC, limit input to 100 row(s) per chunk  (actual time=5.2..5.2 rows=100 loops=1)
        -> Table scan on <temporary>  (actual time=4.8..4.9 rows=800 loops=1)
            -> Aggregate using temporary table  (actual time=4.8..4.8 rows=800 loops=1)
                -> Nested loop inner join  (cost=1450 rows=3333) (actual time=0.05..3.9 rows=3200 loops=1)
                    -> Filter: (o.created_at >= TIMESTAMP'2026-10-01 00:00:00')  (cost=1017 rows=3333) (actual time=0.04..2.1 rows=3200 loops=1)
                        -> Table scan on o  (cost=1017 rows=10000) (actual time=0.03..1.5 rows=10000 loops=1)
                    -> Single-row index lookup on m using PRIMARY (id=o.member_id)  (cost=0.25 rows=1) (actual time=0.0004..0.0004 rows=1 loops=3200)
 |
+-------------------------------------------------------------------------------+`;

test('MySQL FORMAT=TREE / EXPLAIN ANALYZE pasted from the mysql client', () => {
  const p = parsePlan(mysqlTree)!;
  assert.equal(p.format, 'mysql-tree');
  assert.ok(p.analyzed);
  assert.deepEqual(flat(p.root), [
    'Limit',
    '  Sort !filesort',
    '    Table scan [<temporary>] !temporary',
    '      Aggregate using temporary table !temporary',
    '        Nested loop inner join',
    '          Filter',
    '            Table scan [o] !fullscan,hot',
    '          Single-row index lookup (id=o.member_id) [m] {PRIMARY}',
  ]);
  const lookup = p.root.children[0].children[0].children[0].children[0].children[1];
  assert.equal(lookup.loops, 3200);
  assert.ok(Math.abs(lookup.actualTime! - 1.28) < 1e-6);
  assert.equal(lookup.line, 10);
});

test('MySQL FORMAT=JSON v2', () => {
  const p = parsePlan(JSON.stringify({
    query: 'select * from t where a > 1',
    operation: 'Filter: (t.a > 1)',
    access_type: 'filter',
    estimated_rows: 33,
    estimated_total_cost: 10.25,
    condition: '(t.a > 1)',
    inputs: [{ operation: 'Table scan on t', access_type: 'table', table_name: 't', estimated_rows: 100, estimated_total_cost: 10.25 }],
  }))!;
  assert.equal(p.format, 'mysql-json2');
  assert.deepEqual(flat(p.root), ['Filter: (t.a > 1)', '  Table scan on t [t] !fullscan,hot']);
});

const pgText = `                                   QUERY PLAN
------------------------------------------------------------------------------------
 Limit  (cost=850.10..850.35 rows=100 width=16) (actual time=9.1..9.2 rows=100 loops=1)
   ->  Sort  (cost=850.10..852.60 rows=1000 width=16) (actual time=9.1..9.1 rows=100 loops=1)
         Sort Key: (sum(o.amount)) DESC
         Sort Method: external merge  Disk: 1024kB
         ->  HashAggregate  (cost=800.00..810.00 rows=1000 width=16) (actual time=8.0..8.5 rows=800 loops=1)
               Group Key: o.member_id
               ->  Seq Scan on orders o  (cost=0.00..750.00 rows=10 width=16) (actual time=0.01..5.0 rows=9800 loops=1)
                     Filter: (created_at >= '2026-10-01'::date)
                     Rows Removed by Filter: 200
 Planning Time: 0.120 ms
 Execution Time: 9.400 ms
(11 rows)`;

test('PostgreSQL text with ANALYZE', () => {
  const p = parsePlan(pgText)!;
  assert.equal(p.format, 'pg-text');
  assert.equal(p.executionTime, 9.4);
  assert.equal(p.planningTime, 0.12);
  assert.deepEqual(flat(p.root), [
    'Limit',
    '  Sort !disksort',
    '    HashAggregate',
    '      Seq Scan [orders o] !fullscan,misestimate,hot',
  ]);
  const seq = p.root.children[0].children[0].children[0];
  assert.deepEqual(seq.details, ["Filter: (created_at >= '2026-10-01'::date)", 'Rows Removed by Filter: 200']);
});

test('PostgreSQL JSON', () => {
  const p = parsePlan(JSON.stringify([
    {
      Plan: {
        'Node Type': 'Nested Loop', 'Join Type': 'Inner', 'Total Cost': 120.5, 'Plan Rows': 10,
        Plans: [
          { 'Node Type': 'Index Scan', 'Relation Name': 'orders', Alias: 'o', 'Index Name': 'orders_pkey', 'Total Cost': 8.3, 'Plan Rows': 1, 'Index Cond': '(id = 1)' },
          { 'Node Type': 'Seq Scan', 'Relation Name': 'members', Alias: 'members', 'Total Cost': 100.0, 'Plan Rows': 10, Filter: '(grade = 1)' },
        ],
      },
      'Planning Time': 0.2,
    },
  ]))!;
  assert.equal(p.format, 'pg-json');
  assert.equal(p.analyzed, false);
  assert.deepEqual(flat(p.root), ['Nested Loop', '  Index Scan [orders o] {orders_pkey}', '  Seq Scan [members] !fullscan,hot']);
  assert.ok(p.root.details.includes('Join Type: Inner'));
});

test('unrecognised input', () => {
  assert.equal(parsePlan('select 1'), null);
  assert.equal(parsePlan('{"a": 1}'), null);
  assert.equal(parsePlan(''), null);
});
