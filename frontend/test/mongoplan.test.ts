import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoose, parsePlan, type PlanNode } from '../src/plan.ts';

const flat = (n: PlanNode, d = 0, out: string[] = []) => {
  out.push(
    `${'  '.repeat(d)}${n.op}${n.table ? ' [' + n.table + ']' : ''}${n.index ? ' {' + n.index + '}' : ''}${
      n.warnings.length ? ' !' + n.warnings.map((w) => w.kind).join(',') : ''
    }`,
  );
  n.children.forEach((c) => flat(c, d + 1, out));
  return out;
};

// find().sort().explain("executionStats") — strict JSON (e.g. Compass / EJSON)
const findStats = `{
  "explainVersion": "1",
  "queryPlanner": {
    "namespace": "shop.orders",
    "winningPlan": { "stage": "SORT", "sortPattern": { "createdAt": -1 },
      "inputStage": { "stage": "FETCH", "inputStage": { "stage": "IXSCAN", "keyPattern": { "status": 1 }, "indexName": "status_1" } } }
  },
  "executionStats": {
    "executionSuccess": true, "nReturned": 12, "executionTimeMillis": 48,
    "totalKeysExamined": 52000, "totalDocsExamined": 52000,
    "executionStages": {
      "stage": "SORT", "nReturned": 12, "executionTimeMillisEstimate": 47, "sortPattern": { "createdAt": -1 }, "usedDisk": false,
      "inputStage": {
        "stage": "FETCH", "filter": { "memberId": { "$eq": 7 } }, "nReturned": 12, "executionTimeMillisEstimate": 40, "docsExamined": 52000,
        "inputStage": { "stage": "IXSCAN", "nReturned": 52000, "executionTimeMillisEstimate": 9, "keyPattern": { "status": 1 },
          "indexName": "status_1", "keysExamined": 52000, "indexBounds": { "status": ["[\\"PAID\\", \\"PAID\\"]"] } }
      }
    }
  }
}`;

test('mongo find executionStats', () => {
  const p = parsePlan(findStats)!;
  assert.equal(p.format, 'mongo');
  assert.equal(p.engine, 'MongoDB');
  assert.equal(p.analyzed, true);
  assert.equal(p.executionTime, 48);
  assert.deepEqual(flat(p.root), ['SORT !filesort', '  FETCH !examined,hot', '    IXSCAN [orders] {status_1}']);
  assert.equal(p.root.children[0].self, 31); // 40 - 9
  assert.deepEqual(p.stats, [
    ['컬렉션', 'shop.orders'],
    ['반환', '12'],
    ['검사 키', '52.0K'],
    ['검사 문서', '52.0K'],
  ]);
});

// mongosh output: unquoted keys, single quotes, Long(), prompt prefix
const mongosh = `rs0 [primary] shop> {
  explainVersion: '2',
  queryPlanner: {
    namespace: 'shop.members',
    winningPlan: {
      queryPlan: { stage: 'COLLSCAN', filter: { grade: { '$eq': 'VIP' } }, direction: 'forward' },
      slotBasedPlan: { slots: '$$RESULT=s5', stages: '[1] scan s5 …' }
    },
    rejectedPlans: [],
  },
  executionStats: {
    nReturned: 320, executionTimeMillis: 210, totalKeysExamined: 0, totalDocsExamined: Long('1200000'),
    executionStages: { stage: 'filter', nReturned: 320, executionTimeMillisEstimate: Long('205'),
      inputStage: { stage: 'scan', nReturned: Long('1200000'), numReads: Long('1200000') } }
  },
  serverInfo: { host: 'db1', port: 27017, version: '7.0.12' },
  operationTime: Timestamp({ t: 1730000000, i: 1 }),
  '$clusterTime': { clusterTime: Timestamp({ t: 1730000000, i: 1 }), signature: { hash: Binary.createFromBase64('AAAA', 0), keyId: Long('0') } }
}`;

test('mongosh output with wrappers', () => {
  const p = parsePlan(mongosh)!;
  assert.ok(p, 'parsed');
  // SBE stages are replaced by the readable queryPlan with totals on the root.
  assert.deepEqual(flat(p.root), ['COLLSCAN [members] !fullscan,examined,hot']);
  assert.equal(p.root.actualTime, 210);
  assert.equal(p.root.actualRows, 320);
  assert.ok(p.root.details.some((d) => d.includes('"grade"')));
});

test('queryPlanner only (no execution) uses the winning plan', () => {
  const p = parsePlan(`{ queryPlanner: { namespace: 'a.b', winningPlan: { queryPlan: { stage: 'FETCH',
     inputStage: { stage: 'IXSCAN', indexName: 'x_1', keyPattern: { x: 1 } } } } } }`)!;
  assert.equal(p.analyzed, false);
  assert.deepEqual(flat(p.root), ['FETCH', '  IXSCAN [b] {x_1}']);
});

test('aggregate explain: pipeline stages on top of $cursor', () => {
  const p = parsePlan(`{
    stages: [
      { '$cursor': { queryPlanner: { namespace: 'shop.orders', winningPlan: { stage: 'COLLSCAN' } },
                     executionStats: { nReturned: 5000, executionTimeMillis: 30, totalDocsExamined: 5000,
                       executionStages: { stage: 'COLLSCAN', nReturned: 5000, executionTimeMillisEstimate: 20, docsExamined: 5000 } } },
        nReturned: Long('5000'), executionTimeMillisEstimate: Long('20') },
      { '$group': { _id: '$memberId', total: { '$sum': '$amount' } }, nReturned: 800, executionTimeMillisEstimate: 26 },
      { '$sort': { sortKey: { total: -1 } }, nReturned: 800, executionTimeMillisEstimate: 27, usedDisk: true }
    ]
  }`)!;
  assert.deepEqual(flat(p.root), ['$sort !filesort,disksort', '  $group', '    COLLSCAN [orders] !fullscan,hot']);
  assert.equal(p.stats?.[0][1], 'shop.orders');
});

test('sharded executionStats', () => {
  const p = parsePlan(`{ queryPlanner: { winningPlan: { stage: 'SHARD_MERGE', shards: [] } },
    executionStats: { nReturned: 2, executionStages: { stage: 'SHARD_MERGE', nReturned: 2, executionTimeMillisEstimate: 3,
      shards: [ { shardName: 'sh1', executionStages: { stage: 'IXSCAN', indexName: 'a_1', nReturned: 1, executionTimeMillisEstimate: 1 } },
                { shardName: 'sh2', executionStages: { stage: 'COLLSCAN', nReturned: 1, executionTimeMillisEstimate: 2 } } ] } } }`)!;
  assert.deepEqual(
    flat(p.root).map((l) => l.replace(/ !.*/, '')),
    ['SHARD_MERGE', '  IXSCAN {a_1}', '  COLLSCAN'],
  );
  assert.ok(p.root.children[0].details.includes('샤드 sh1'));
});

test('parseLoose handles shell syntax', () => {
  assert.deepEqual(
    parseLoose(`{ a: 1, 'b': "x", c: [1, 2,], d: ObjectId('65f0'), e: ISODate("2026-01-01T00:00:00Z"),
    f: NumberLong(7), g: new Date(0), h: MinKey(), i: true, j: null, }`),
    {
      a: 1,
      b: 'x',
      c: [1, 2],
      d: '65f0',
      e: '2026-01-01T00:00:00Z',
      f: 7,
      g: 0,
      h: 'MinKey',
      i: true,
      j: null,
    },
  );
  assert.throws(() => parseLoose('{ a: '));
});

test('mysql / pg detection still wins for their formats', () => {
  assert.equal(
    parsePlan('{"query_block": {"select_id": 1, "table": {"table_name": "t", "access_type": "ALL"}}}')?.format,
    'mysql-json',
  );
});
