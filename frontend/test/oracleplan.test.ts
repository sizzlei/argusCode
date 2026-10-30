import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, type PlanNode } from '../src/plan.ts';

const flat = (n: PlanNode, d = 0, out: string[] = []) => {
  out.push(
    `${'  '.repeat(d)}${n.op}${n.table ? ' [' + n.table + ']' : ''}${n.index ? ' {' + n.index + '}' : ''}${
      n.warnings.length ? ' !' + n.warnings.map((w) => w.kind).join(',') : ''
    }`,
  );
  n.children.forEach((c) => flat(c, d + 1, out));
  return out;
};

// EXPLAIN PLAN FOR …; SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
const display = `PLAN_TABLE_OUTPUT
--------------------------------------------------------------------------------
Plan hash value: 2231215893

-------------------------------------------------------------------------------------------
| Id  | Operation                     | Name      | Rows  | Bytes | Cost (%CPU)| Time     |
-------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT              |           |    10 |   650 |  1532   (2)| 00:00:01 |
|   1 |  SORT ORDER BY                |           |    10 |   650 |  1532   (2)| 00:00:01 |
|*  2 |   HASH JOIN                   |           |    10 |   650 |  1531   (2)| 00:00:01 |
|*  3 |    TABLE ACCESS FULL          | MEMBERS   |   100 |  2000 |    12   (0)| 00:00:01 |
|   4 |    TABLE ACCESS BY INDEX ROWID| ORDERS    |  1000K|    43M|  1500   (1)| 00:00:01 |
|*  5 |     INDEX RANGE SCAN          | IDX_ORD_DT|  1000K|       |    30   (0)| 00:00:01 |
-------------------------------------------------------------------------------------------

Predicate Information (identified by operation id):
---------------------------------------------------

   2 - access("M"."ID"="O"."MEMBER_ID")
   3 - filter("M"."GRADE"='VIP')
   5 - access("O"."CREATED_AT">=TO_DATE(' 2026-10-01 00:00:00',
              'syyyy-mm-dd hh24:mi:ss'))

Note
-----
   - dynamic statistics used: dynamic sampling (level=2)
`;

test('Oracle DBMS_XPLAN.DISPLAY', () => {
  const p = parsePlan(display)!;
  assert.equal(p.format, 'oracle');
  assert.equal(p.engine, 'Oracle');
  assert.equal(p.analyzed, false);
  assert.deepEqual(flat(p.root), [
    'SELECT STATEMENT',
    '  SORT ORDER BY !filesort',
    '    HASH JOIN',
    '      TABLE ACCESS FULL [MEMBERS] !fullscan',
    '      TABLE ACCESS BY INDEX ROWID [ORDERS] !hot',
    '        INDEX RANGE SCAN {IDX_ORD_DT}',
  ]);
  const hj = p.root.children[0].children[0];
  assert.equal(hj.cost, 1531);
  assert.deepEqual(hj.details, ['access("M"."ID"="O"."MEMBER_ID")']);
  const idx = hj.children[1].children[0];
  assert.equal(idx.rows, 1e6);
  assert.equal(idx.details.length, 1); // wrapped predicate joined into one line
  assert.ok(idx.details[0].endsWith("'syyyy-mm-dd hh24:mi:ss'))"));
  assert.equal(p.root.children[0].children[0].children[1].self, 1470); // 1500 - 30
  assert.ok(p.root.details.some((d) => d.includes('dynamic statistics')));
  assert.deepEqual(p.stats, [
    ['Plan hash', '2231215893'],
    ['예상 시간', '00:00:01'],
  ]);
  assert.equal(p.root.line, 7); // click-to-source line
});

// SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));
const allstats = `SQL_ID  9babjv8yq8ru3, child number 0
-------------------------------------
select /*+ gather_plan_statistics */ * from orders o join members m on m.id = o.member_id

Plan hash value: 1615217539

-----------------------------------------------------------------------------------------------------------------------------
| Id  | Operation           | Name    | Starts | E-Rows | A-Rows |   A-Time   | Buffers | Reads  |  OMem |  1Mem | Used-Mem |
-----------------------------------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT    |         |      1 |        |  48000 |00:00:02.50 |   35210 |  12000 |       |       |          |
|*  1 |  HASH JOIN          |         |      1 |    120 |  48000 |00:00:02.50 |   35210 |  12000 |  2120K|  2120K| 2010K (0)|
|   2 |   TABLE ACCESS FULL | MEMBERS |      1 |    100 |    100 |00:00:00.01 |      10 |      0 |       |       |          |
|   3 |   NESTED LOOPS      |         |      1 |    120 |  48000 |00:00:02.30 |   35200 |  12000 |       |       |          |
|*  4 |    INDEX RANGE SCAN | IX_O_M  |    100 |      1 |  48000 |00:00:01.00 |    5200 |   2000 |       |       |          |
-----------------------------------------------------------------------------------------------------------------------------

Predicate Information (identified by operation id):
---------------------------------------------------

   1 - access("M"."ID"="O"."MEMBER_ID")
   4 - access("O"."MEMBER_ID"="M"."ID")
`;

test('Oracle DISPLAY_CURSOR ALLSTATS LAST (actual statistics)', () => {
  const p = parsePlan(allstats)!;
  assert.equal(p.analyzed, true);
  assert.equal(p.executionTime, 2500);
  assert.deepEqual(flat(p.root), [
    'SELECT STATEMENT',
    '  HASH JOIN !misestimate',
    '    TABLE ACCESS FULL [MEMBERS] !fullscan',
    '    NESTED LOOPS !misestimate,hot',
    '      INDEX RANGE SCAN {IX_O_M} !misestimate',
  ]);
  const idx = p.root.children[0].children[1].children[0];
  assert.equal(idx.loops, 100);
  assert.equal(idx.actualRows, 480); // per start
  assert.equal(idx.actualTime, 1000);
  assert.equal(idx.buffers, 5200);
  assert.equal(p.selfMetric, 'buffers');
  assert.equal(p.root.children[0].children[1].self, 30000); // NESTED LOOPS: 35200 - 5200
  assert.deepEqual(p.stats, [
    ['SQL_ID', '9babjv8yq8ru3 #0'],
    ['Plan hash', '1615217539'],
    ['Buffers', '35.2K'],
  ]);
});

test('Oracle: temp space, cartesian, partitions, adaptive inactive rows', () => {
  const p = parsePlan(`
------------------------------------------------------------------------------------------------------------
| Id  | Operation                   | Name | Rows  | Bytes |TempSpc| Cost (%CPU)| Time     | Pstart| Pstop |
------------------------------------------------------------------------------------------------------------
|   0 | SELECT STATEMENT            |      |  100M |  5G   |       |  900K  (1)| 00:00:36 |       |       |
|   1 |  SORT ORDER BY              |      |  100M |  5G   |  6200M|  900K  (1)| 00:00:36 |       |       |
|   2 |   MERGE JOIN CARTESIAN      |      |  100M |  5G   |       |  1000  (1)| 00:00:01 |       |       |
|   3 |    PARTITION RANGE ALL      |      |  10K  |  100K |       |   500  (1)| 00:00:01 |     1 |    12 |
|-  4 |     TABLE ACCESS FULL       | SALES|  10K  |  100K |       |   500  (1)| 00:00:01 |     1 |    12 |
|   5 |    BUFFER SORT              |      |  10K  |  100K |       |   500  (1)| 00:00:01 |       |       |
|   6 |     INDEX FAST FULL SCAN    | PK_X |  10K  |  100K |       |    10  (0)| 00:00:01 |       |       |
------------------------------------------------------------------------------------------------------------`)!;
  assert.deepEqual(flat(p.root), [
    'SELECT STATEMENT',
    '  SORT ORDER BY !filesort,disksort,hot',
    '    MERGE JOIN CARTESIAN !fullscan',
    '      PARTITION RANGE ALL',
    '        TABLE ACCESS FULL [SALES] !fullscan',
    '      BUFFER SORT',
    '        INDEX FAST FULL SCAN {PK_X} !indexscan',
  ]);
  const sales = p.root.children[0].children[0].children[0].children[0];
  assert.ok(sales.details.includes('적응형 계획에서 사용 안 된 단계'));
  assert.ok(sales.details.includes('파티션 1 ~ 12'));
});

test('Oracle: wrapped predicates are joined; INTERNAL_FUNCTION flagged', () => {
  const p = parsePlan(`Plan hash value: 1
--------------------------------------------------------------------
| Id  | Operation                    | Name     | Rows  | Cost (%CPU)|
--------------------------------------------------------------------
|   0 | SELECT STATEMENT             |          |     1 |    10   (0)|
|*  1 |  TABLE ACCESS BY INDEX ROWID | ITEM     |     1 |    10   (0)|
|* 11 |   INDEX RANGE SCAN           | IX_ITEM   |     5 |     2   (0)|
--------------------------------------------------------------------

Predicate Information (identified by operation id):
---------------------------------------------------

   1 - filter("F"."CMD_NO" IS NULL)
  11 - access("A"."ITEM_ID"="ITEM_ID")
       filter(((SUBSTR("ITEM_ID",4,2)='11' OR
              SUBSTR("ITEM_ID",4,2)='12') OR INTERNAL_FUNCTION("ITEM_ID") OR
              SUBSTR("ITEM_ID",7,3)>='500'))
`)!;
  const ix = p.root.children[0].children[0];
  assert.deepEqual(ix.details, [
    'access("A"."ITEM_ID"="ITEM_ID")',
    `filter(((SUBSTR("ITEM_ID",4,2)='11' OR SUBSTR("ITEM_ID",4,2)='12') OR INTERNAL_FUNCTION("ITEM_ID") OR SUBSTR("ITEM_ID",7,3)>='500'))`,
  ]);
  assert.ok(ix.warnings.some((w) => w.kind === 'conversion'));
  assert.deepEqual(p.root.children[0].details, ['filter("F"."CMD_NO" IS NULL)']);
});

test('predicate section alone is not a plan', () => {
  assert.equal(parsePlan('Predicate Information (identified by operation id):\n   1 - filter(1=1)\n'), null);
});

test('Oracle: rows without cost (FILTER) do not inflate the parent', () => {
  const p = parsePlan(`Plan hash value: 7
-------------------------------------------------------------------
| Id  | Operation                    | Name    | Rows  | Cost (%CPU)|
-------------------------------------------------------------------
|   0 | SELECT STATEMENT             |         |     1 |    48   (3)|
|*  1 |  FILTER                      |         |       |            |
|   2 |   NESTED LOOPS OUTER         |         |     1 |    46   (3)|
|*  3 |    FILTER                    |         |       |            |
|*  4 |     TABLE ACCESS FULL        | T_ITEM  |    12 |    36   (3)|
|   5 |     SORT AGGREGATE           |         |     1 |            |
|*  6 |      INDEX RANGE SCAN        | IX_HIST |     1 |     2   (0)|
|*  7 |    INDEX UNIQUE SCAN         | PK_CMD  |     1 |     1   (0)|
-------------------------------------------------------------------
`)!;
  assert.equal(p.root.self, 2); // 48 - 46
  assert.ok(!p.root.warnings.some((w) => w.kind === 'hot'));
  const hot: string[] = [];
  const walk = (n: PlanNode) => {
    if (n.warnings.some((w) => w.kind === 'hot')) hot.push(n.op + ' ' + (n.table ?? ''));
    n.children.forEach(walk);
  };
  walk(p.root);
  assert.deepEqual(hot, ['TABLE ACCESS FULL T_ITEM']);
});
