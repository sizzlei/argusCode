// Run: npm test   (Node 22.6+; uses --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, SqlFormatError, toInList } from '../src/sqlformat.ts';

const f = (s: string, dialect: 'mysql' | 'postgresql' | 'plsql' | 'standard' = 'mysql') =>
  formatSql(s, { dialect, style: 'river' });
const left = (s: string) => formatSql(s, { style: 'left', indent: 2 });

test('left style (default): keyword at margin, items and AND/OR indented', () => {
  const want = [
    'Select',
    '  Max(Rev)',
    'From Revinfo',
    "Where Revtstmp < Unix_Timestamp(Date_Format(Now(), '%Y-%M-01')) * 1000",
    '  and a < b',
  ].join('\n');
  assert.equal(
    left(
      "Select Max(Rev) From Revinfo Where Revtstmp < Unix_Timestamp(Date_Format(Now(), '%Y-%M-01')) * 1000 and a < b",
    ),
    want,
  );
  assert.equal(left(want), want);
  assert.equal(formatSql('select a from t'), ['select', '  a', 'from t'].join('\n'));
  assert.equal(
    left('select a, b as bb from t join u on u.id = t.id and u.x = 1 where c = 1 or d = 2'),
    [
      'select',
      '  a,',
      '  b as bb',
      'from t',
      'join u',
      '  on u.id = t.id',
      '    and u.x = 1',
      'where c = 1',
      '  or d = 2',
    ].join('\n'),
  );
  assert.equal(
    left('update t set a = 1, bb = 2 where id = 3'),
    ['update t', 'set', '  a  = 1,', '  bb = 2', 'where id = 3'].join('\n'),
  );
});

test('river layout, trailing commas, AS and operator alignment, case preserved', () => {
  const out = f(
    "select o.member_id, count(*) as cnt, sum(o.amount) as total from orders o join members m on m.id = o.member_id where o.created_at >= '2026-10-01' and m.grade = 'VIP' group by o.member_id order by total desc limit 100;",
  );
  assert.equal(
    out,
    [
      'select o.member_id,',
      '       count(*)      as cnt,',
      '       sum(o.amount) as total',
      '  from orders o',
      '  join members m',
      '    on m.id = o.member_id',
      " where o.created_at >= '2026-10-01'",
      "   and m.grade       = 'VIP'",
      ' group by o.member_id',
      ' order by total desc',
      ' limit 100;',
    ].join('\n'),
  );
});

test('subquery gets its own river; BETWEEN ... AND is not split', () => {
  assert.equal(
    f('SELECT a FROM t WHERE x IN (SELECT id FROM u WHERE y = 1) AND z BETWEEN 1 AND 10 OR w IS NULL'),
    [
      'SELECT a',
      '  FROM t',
      ' WHERE x IN (SELECT id',
      '               FROM u',
      '              WHERE y = 1)',
      '   AND z BETWEEN 1 AND 10',
      '    OR w IS NULL',
    ].join('\n'),
  );
});

test('INSERT / UPDATE / DELETE', () => {
  assert.equal(
    f('insert into t (a, b) values (1, 2), (3, 4);'),
    ['insert into t (a, b)', 'values (1, 2),', '       (3, 4);'].join('\n'),
  );
  assert.equal(
    f("update t set a = 1, bbb = 'x' where id = 3"),
    ['update t', '   set a   = 1,', "       bbb = 'x'", ' where id = 3'].join('\n'),
  );
  assert.equal(f('delete from t where id in (1,2)'), ['delete from t', ' where id in (1, 2)'].join('\n'));
});

test('comments are kept and never swallow code', () => {
  const out = f('SELECT a -- first\n, b\nFROM t -- tbl\nWHERE a = 1 -- c\nAND b = 2');
  assert.equal(
    out,
    ['SELECT a, -- first', '       b', '  FROM t -- tbl', ' WHERE a = 1 -- c', '   AND b = 2'].join('\n'),
  );
});

test('CASE is broken into aligned WHEN lines when long', () => {
  const out = f(
    "select case when a = 1 then 'one' when a = 2 then 'two' when a = 3 then 'three' else 'many many many' end as label from t",
  );
  assert.match(out, /^select case when a = 1 then 'one'\n {12}when a = 2/);
  assert.match(out, /\n {8}end as label\n {2}from t$/);
});

test('CREATE TABLE aligns names and types and keeps table options', () => {
  const out = f(
    "CREATE TABLE t (id bigint NOT NULL, member_name varchar(50) COMMENT '이름', PRIMARY KEY (id)) ENGINE=InnoDB;",
  );
  assert.equal(
    out,
    [
      'CREATE TABLE t (',
      '    id          bigint      NOT NULL,',
      "    member_name varchar(50) COMMENT '이름',",
      '    PRIMARY KEY (id)',
      ') ENGINE=InnoDB;',
    ].join('\n'),
  );
});

test('ALTER TABLE: one action per line, column names and types aligned', () => {
  const src = [
    'alter table orders',
    "  add column coupon_id bigint unsigned null comment '쿠폰' after member_id,",
    '  add column discount_amt decimal(12,2) not null default 0,  -- 할인',
    "  modify column memo varchar(500) not null default '',",
    '  add index idx_orders_coupon (coupon_id), algorithm=inplace, lock=none;',
  ].join('\n');
  const want = [
    'alter table orders',
    "    add column    coupon_id    bigint unsigned null comment '쿠폰' after member_id,",
    '    add column    discount_amt decimal(12, 2)  not null default 0, -- 할인',
    "    modify column memo         varchar(500)    not null default '',",
    '    add index idx_orders_coupon (coupon_id),',
    '    algorithm=inplace,',
    '    lock=none;',
  ].join('\n');
  assert.equal(f(src), want);
  assert.equal(f(want), want);
  // A single short action stays on one line; spacing is normalised.
  assert.equal(f('ALTER TABLE  t\n  ADD COLUMN c INT;'), 'ALTER TABLE t ADD COLUMN c INT;');
  // PostgreSQL
  assert.equal(
    f('ALTER TABLE ONLY public.t ALTER COLUMN memo TYPE varchar(500), ALTER COLUMN memo SET NOT NULL;', 'postgresql'),
    [
      'ALTER TABLE ONLY public.t',
      '    ALTER COLUMN memo TYPE varchar(500),',
      '    ALTER COLUMN memo SET NOT NULL;',
    ].join('\n'),
  );
  // Oracle ADD (…) list laid out like CREATE TABLE
  assert.equal(
    f("alter table t add (a number(19) null, bb varchar2(10) default 'x' not null);", 'plsql'),
    ['alter table t add (', '    a  number(19)   null,', "    bb varchar2(10) default 'x' not null", ');'].join('\n'),
  );
});

test('CREATE … AS SELECT, CREATE INDEX and other DDL', () => {
  assert.equal(
    left('CREATE OR REPLACE VIEW v_orders AS select o.id, m.name from orders o join members m on m.id=o.member_id'),
    [
      'CREATE OR REPLACE VIEW v_orders AS',
      'select',
      '  o.id,',
      '  m.name',
      'from orders o',
      'join members m',
      '  on m.id = o.member_id',
    ].join('\n'),
  );
  assert.equal(
    formatSql('CREATE MATERIALIZED VIEW mv AS SELECT a, count(*) c FROM t GROUP BY a WITH NO DATA;', {
      dialect: 'postgresql',
    }),
    ['CREATE MATERIALIZED VIEW mv AS', 'SELECT', '  a,', '  count(*) c', 'FROM t', 'GROUP BY a', 'WITH NO DATA;'].join(
      '\n',
    ),
  );
  assert.equal(
    left('create table t2 as select * from t where id>10'),
    ['create table t2 as', 'select', '  *', 'from t', 'where id > 10'].join('\n'),
  );
  assert.equal(
    f('CREATE  INDEX  CONCURRENTLY idx_a\n  ON t USING btree (a, lower(b)) WHERE c IS NULL;', 'postgresql'),
    'CREATE INDEX CONCURRENTLY idx_a ON t USING btree (a, lower(b)) WHERE c IS NULL;',
  );
  assert.equal(f('create unique index uk_a on t(a,b);'), 'create unique index uk_a on t(a, b);');
  assert.equal(f("comment on column t.a  is '메모';", 'postgresql'), "comment on column t.a is '메모';");
  assert.equal(f('DROP TABLE  IF EXISTS tmp;'), 'DROP TABLE IF EXISTS tmp;');
  // Statements with comments inside are left as written.
  assert.equal(f('CREATE INDEX i /* note */ ON t (a);'), 'CREATE INDEX i /* note */ ON t (a);');
});

test('procedural code is refused', () => {
  assert.throws(() => f('DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$'), SqlFormatError);
  assert.throws(
    () => f('CREATE FUNCTION f() RETURNS int AS $$ select 1; $$ LANGUAGE sql;', 'postgresql'),
    SqlFormatError,
  );
});

test('dialect details: PostgreSQL casts, arrays, dollar quotes; Korean width', () => {
  assert.equal(
    f("select x::int, tags @> array['a'], $$a;b$$ from t", 'postgresql'),
    ['select x::int,', "       tags @> array['a'],", '       $$a;b$$', '  from t'].join('\n'),
  );
  assert.equal(f('select 한글 as a, bb as b from t'), ['select 한글 as a,', '       bb   as b', '  from t'].join('\n'));
});

test('formatting is idempotent', () => {
  const samples = [
    "select a, b as c from t join u on u.id = t.id where x = 1 and y in (select z from w where q = 'r') order by a",
    'with r as (select * from t), s as (select a from r) select * from s union all select * from r',
    'insert into t (a) select a from u where b > 1 on duplicate key update a = values(a)',
  ];
  for (const s of samples) {
    const once = f(s);
    assert.equal(f(once), once);
  }
});

test('formatting never changes the token sequence', () => {
  const samples = [
    "SELECT DISTINCT a.x, (SELECT MAX(y) FROM b WHERE b.id = a.id) AS m, CASE WHEN a.z > 0 THEN 'p' ELSE 'n' END z FROM a LEFT OUTER JOIN c ON c.k = a.k AND c.d BETWEEN 1 AND 5 WHERE NOT EXISTS (SELECT 1 FROM d WHERE d.k = a.k) AND a.q LIKE '%x%' ORDER BY 1 DESC, 2 LIMIT 5 OFFSET 10 FOR UPDATE",
    'INSERT INTO t SELECT * FROM u WHERE u.a IN (1, 2, 3); UPDATE t SET a = a + 1 WHERE b = -1; DELETE t FROM t JOIN u USING (id)',
    "select /*+ INDEX(t idx) */ t.* , -1 + 2 * (3 - 4) / 5 % 6, 'it''s', \"dq\", `bt` from t # mysql comment\nwhere a <=> b",
    'SELECT a FROM t GROUP BY a WITH ROLLUP HAVING COUNT(*) > 1',
    "select row_number() over (partition by a order by b) rn, json_extract(c, '$.x') from t window w as (partition by a)",
    'SELECT * FROM t1 UNION SELECT * FROM t2 INTERSECT SELECT * FROM t3',
    "CREATE TABLE x (a int, b varchar(10) NOT NULL DEFAULT '', c enum('a','b'), PRIMARY KEY (a), UNIQUE KEY uk (b)) PARTITION BY HASH(a) PARTITIONS 4",
    'select a from',
    'select (a',
    ')))',
  ];
  // Re-tokenise and compare non-whitespace token texts.
  const words = (s: string) =>
    s
      .replace(/--[^\n]*|#[^\n]*/g, (m) => m.trim())
      .split(/\s+/)
      .join('')
      .replace(/\s/g, '');
  for (const s of samples) {
    for (const fmt of [f, left]) {
      const out = fmt(s);
      assert.equal(words(out), words(s), 'content changed for: ' + s);
      assert.equal(fmt(out), out, 'not idempotent for: ' + s);
    }
  }
});

test('toInList: quotes strings, keeps numbers, drops duplicates and blanks', () => {
  assert.equal(toInList("a\nb\n\nb\nO'Neil\n"), "('a', 'b', 'O''Neil')");
  assert.equal(toInList('1\n2\n3'), '(1, 2, 3)');
  assert.equal(toInList("'x', 'y'"), "('x', 'y')");
  const many = Array.from({ length: 40 }, (_, i) => 'id_' + i).join('\n');
  assert.ok(toInList(many).includes(',\n '), 'long lists wrap');
});
