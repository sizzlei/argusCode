import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, lintSql } from '../src/sqllint.ts';

const msgs = (src: string, d: 'mysql' | 'postgresql' | 'plsql' = 'mysql') =>
  lintSql(src, d).map((p) => `${p.severity}:${src.slice(p.from, p.to)}`);

test('valid SQL in each dialect is not flagged', () => {
  const ok: [string, 'mysql' | 'postgresql' | 'plsql'][] = [
    [
      "SELECT o.id, COUNT(*) AS cnt FROM orders o JOIN members m ON m.id = o.member_id WHERE o.created_at >= '2026-10-01' AND m.grade = 'VIP' GROUP BY o.id ORDER BY cnt DESC LIMIT 10;",
      'mysql',
    ],
    [
      "INSERT INTO t (a, b) VALUES (1, 'it''s'), (2, NULL) ON DUPLICATE KEY UPDATE b = VALUES(b);\nUPDATE t SET a = NULL WHERE id = 1;",
      'mysql',
    ],
    [
      "CREATE TABLE c (id bigint, code varchar(20) CHECK (length(code) > 0 AND code <> ''), PRIMARY KEY (id)) ENGINE=InnoDB;\nALTER TABLE c ADD COLUMN x int, ALGORITHM=INPLACE, LOCK=NONE;",
      'mysql',
    ],
    ['DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;', 'mysql'],
    ['select form, name from forms where here = 1;\nSELECT a FROM t WHERE b = "x\\"y";', 'mysql'],
    [
      'INSERT INTO t (a, b)\nSELECT a, b FROM u;\nCREATE TABLE x AS\nSELECT * FROM y;\nSELECT 1 UNION ALL\nSELECT 2;',
      'mysql',
    ],
    [
      'WITH a AS (SELECT 1 AS x) SELECT * FROM a CROSS JOIN b NATURAL JOIN c, LATERAL (SELECT 1) z WHERE x BETWEEN 1 AND 2;\nSELECT $1, $$a;b$$, x::int FROM t;',
      'postgresql',
    ],
    [
      'SELECT * FROM emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr ORDER SIBLINGS BY name;\nBEGIN\n  UPDATE t SET a = 1;\nEND;\n/',
      'plsql',
    ],
  ];
  for (const [sql, d] of ok) assert.deepEqual(msgs(sql, d), [], sql);
});

test('syntax errors', () => {
  assert.deepEqual(msgs('SELCET * FORM orders WHER id = 1 GRUOP BY a ODER BY b;'), [
    'error:SELCET',
    'error:FORM',
    'error:WHER',
    'error:GRUOP BY',
    'error:ODER BY',
  ]);
  assert.deepEqual(msgs('SELECT a, b, FROM t WHERE ORDER BY a;'), ['error:,', 'error:WHERE']);
  assert.deepEqual(msgs('SELECT (a + b FROM t;\nSELECT a) FROM t;'), ['error:(', 'error:)']);
  assert.deepEqual(msgs("SELECT * FROM t WHERE name = 'abc;\nSELECT 1;"), ["error:'abc;"]);
  assert.deepEqual(msgs('SELECT a,, b FROM t /* open'), ['error:,,', 'error:/*']);
  assert.deepEqual(msgs('CREATE TABLE t (a int, b int,);'), ['error:,']);
  assert.deepEqual(msgs('SELECT * FROM t WHERE a = 1 AND;'), ['error:AND']);
});

test('warnings: UPDATE/DELETE without WHERE, JOIN without ON, = NULL, missing ;', () => {
  assert.deepEqual(msgs("UPDATE orders SET status = 'X';\nDELETE FROM orders;"), ['warning:UPDATE', 'warning:DELETE']);
  assert.deepEqual(msgs('SELECT * FROM a JOIN b WHERE a.id = 1;'), ['warning:JOIN']);
  assert.deepEqual(msgs('SELECT * FROM t WHERE a = NULL OR b <> NULL;'), ['warning:= NULL', 'warning:<> NULL']);
  assert.deepEqual(msgs('SELECT 1 FROM a\nSELECT 2 FROM b;'), ['warning:SELECT']);
});

test('edit distance', () => {
  assert.equal(editDistance('SELCET', 'SELECT'), 1);
  assert.equal(editDistance('FORM', 'FROM'), 1);
  assert.ok(editDistance('ORDERS', 'GROUP') > 2);
});
