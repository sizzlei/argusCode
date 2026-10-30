import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beforeFile, buildRollback } from '../src/rollback.ts';
import { parseDdl } from '../src/ddlparse.ts';
import type { Table } from '../src/ddlparse.ts';
import { analyzeImpact } from '../src/ddlimpact.ts';

const MY_BEFORE = beforeFile(
  'sql/ddl.sql',
  `CREATE TABLE orders (
  id bigint NOT NULL AUTO_INCREMENT,
  member_id bigint NOT NULL COMMENT '회원',
  memo varchar(50) DEFAULT NULL COMMENT '메모',
  status varchar(10) NOT NULL DEFAULT 'NEW',
  amount int,
  PRIMARY KEY (id),
  KEY idx_orders_member (member_id)
) ENGINE=InnoDB COMMENT='주문';
CREATE TABLE old_log (id int, msg text);
`,
  'mysql',
);

const rb = (src: string, dialect: 'mysql' | 'postgresql' | 'oracle' = 'mysql', before = [MY_BEFORE]) =>
  buildRollback({ src, dialect, source: 't.sql', before, now: 'T' });

test('rollback: statements in reverse order, simple inverses', () => {
  const r = rb(`CREATE TABLE coupon (id bigint, PRIMARY KEY (id));
CREATE INDEX idx_coupon_x ON coupon (id);
ALTER TABLE orders RENAME COLUMN memo TO note;
RENAME TABLE old_log TO old_log_2026, a TO b;
UPDATE orders SET memo = '' WHERE id = 1;`);
  const body = r.text;
  assert.ok(body.indexOf('RENAME TABLE b TO a, old_log_2026 TO old_log;') < body.indexOf('DROP TABLE coupon;'));
  assert.match(body, /ALTER TABLE orders RENAME COLUMN note TO memo;/);
  assert.match(body, /DROP INDEX idx_coupon_x ON coupon;/);
  assert.match(body, /DDL이 아닌 문장 1개는 제외/);
  assert.equal(r.statements, 4);
  assert.equal(r.skipped, 1);
});

test('rollback: MODIFY / CHANGE / DROP use the folder definition, inline notes', () => {
  const r = rb(`ALTER TABLE orders
  ADD COLUMN coupon_id bigint NULL AFTER member_id,
  MODIFY COLUMN memo varchar(500) NOT NULL DEFAULT '',
  CHANGE COLUMN status order_status varchar(20) NOT NULL,
  DROP INDEX idx_orders_member,
  ADD INDEX idx_orders_coupon (coupon_id),
  DROP COLUMN amount,
  ALGORITHM=INPLACE, LOCK=NONE;`);
  const want = [
    'ALTER TABLE orders',
    '    ADD COLUMN amount int AFTER status, -- 원래 정의 sql/ddl.sql:6 · ⚠ 데이터는 복구되지 않음',
    '    DROP INDEX idx_orders_coupon,',
    '    ADD KEY idx_orders_member (member_id), -- 원래 정의 sql/ddl.sql:8',
    "    CHANGE COLUMN order_status status varchar(10) NOT NULL DEFAULT 'NEW', -- 변경 전 정의 sql/ddl.sql:5",
    "    MODIFY COLUMN memo varchar(50) DEFAULT NULL COMMENT '메모', -- 변경 전 정의 sql/ddl.sql:4",
    '    DROP COLUMN coupon_id;',
  ].join('\n');
  assert.ok(r.text.includes(want), r.text);
  assert.match(r.text, /ALGORITHM \/ LOCK 옵션은 넣지 않았습니다/);
});

test('rollback: unknown definitions and irreversible statements are flagged, not guessed', () => {
  const r = rb(`ALTER TABLE ghost MODIFY COLUMN x int;
DROP TABLE old_log;
DROP TABLE missing;
TRUNCATE TABLE orders;
CREATE OR REPLACE VIEW v AS SELECT 1;`);
  assert.match(r.text, /-- MODIFY COLUMN x <원래 정의>/);
  assert.match(r.text, /CREATE TABLE old_log \(id int, msg text\);/);
  assert.match(r.text, /✕ 자동으로 되돌릴 수 없음: DROP TABLE missing/);
  assert.match(r.text, /✕ 자동으로 되돌릴 수 없음: TRUNCATE orders/);
  assert.match(r.text, /✕ 자동으로 되돌릴 수 없음: CREATE OR REPLACE VIEW v/);
  assert.equal(r.impossible, 3);
  assert.ok(r.warnings >= 2);
});

test('rollback: PostgreSQL and Oracle forms', () => {
  const pg = beforeFile(
    'ddl/pg.sql',
    `CREATE TABLE orders (id bigint, memo varchar(100), status varchar(10) NOT NULL, CONSTRAINT orders_pk PRIMARY KEY (id));
COMMENT ON COLUMN orders.memo IS '메모';
CREATE INDEX idx_orders_status ON orders (status);`,
    'postgresql',
  );
  const r = rb(
    `ALTER TABLE orders ALTER COLUMN memo TYPE varchar(500), ALTER COLUMN status DROP NOT NULL;
ALTER TABLE orders ADD COLUMN note text, ADD CONSTRAINT uk_orders_note UNIQUE (note);
COMMENT ON COLUMN orders.memo IS '새 메모';
CREATE INDEX CONCURRENTLY idx_orders_note ON orders (note);
DROP INDEX idx_orders_status;
ALTER TABLE orders RENAME TO orders_v2;`,
    'postgresql',
    [pg],
  );
  assert.match(r.text, /ALTER TABLE orders_v2 RENAME TO orders;/);
  assert.match(r.text, /CREATE INDEX idx_orders_status ON orders \(status\);/);
  assert.match(r.text, /DROP INDEX CONCURRENTLY idx_orders_note;/);
  assert.match(r.text, /COMMENT ON COLUMN orders\.memo IS '메모';/);
  assert.match(r.text, /DROP CONSTRAINT uk_orders_note,\n {4}DROP COLUMN note;/);
  assert.match(r.text, /ALTER COLUMN status SET NOT NULL,\n {4}ALTER COLUMN memo TYPE varchar\(100\);/);

  const ora = beforeFile('ddl/ora.sql', `CREATE TABLE ORDERS (ID NUMBER(19) NOT NULL, MEMO VARCHAR2(100));`, 'oracle');
  const o = rb(
    `ALTER TABLE ORDERS ADD (COUPON_ID NUMBER(19), NOTE VARCHAR2(200));
ALTER TABLE ORDERS MODIFY (MEMO VARCHAR2(500) NOT NULL);
CREATE INDEX IX_ORDERS_COUPON ON ORDERS (COUPON_ID) ONLINE;`,
    'oracle',
    [ora],
  );
  assert.match(o.text, /ALTER TABLE ORDERS DROP COLUMN NOTE;\nALTER TABLE ORDERS DROP COLUMN COUPON_ID;/);
  assert.match(o.text, /ALTER TABLE ORDERS MODIFY \(MEMO VARCHAR2\(100\) NULL\);/);
  assert.match(o.text, /DROP INDEX IX_ORDERS_COUPON ONLINE;/);
});

// ---- online DDL impact -----------------------------------------------------------------

const ORDERS = parseDdl(
  `CREATE TABLE orders (id bigint NOT NULL, memo varchar(50), title varchar(100), amount int, status varchar(10) NOT NULL, PRIMARY KEY (id));`,
  'mysql',
)[0] as Table;
const impact = (src: string, dialect: 'mysql' | 'postgresql' | 'oracle' = 'mysql') =>
  analyzeImpact(src, parseDdl(src, dialect), dialect, (n) => (n.toLowerCase() === 'orders' ? ORDERS : null));
const summary = (src: string, d?: 'mysql' | 'postgresql' | 'oracle') => impact(src, d)[0];

test('impact: MySQL INSTANT / INPLACE / COPY', () => {
  assert.equal(summary('ALTER TABLE orders ADD COLUMN c int;').level, 'instant');
  assert.equal(summary("ALTER TABLE orders MODIFY COLUMN status varchar(10) NOT NULL COMMENT 'x';").level, 'instant');
  assert.equal(summary('ALTER TABLE orders ADD INDEX i (memo);').level, 'inplace');
  assert.equal(summary('ALTER TABLE orders MODIFY COLUMN title varchar(200);').level, 'inplace'); // 400 → 800 bytes
  const s = impact('ALTER TABLE orders MODIFY COLUMN memo varchar(100);'); // 200 → 400 bytes: crosses 255
  assert.equal(s[0].level, 'blocking');
  assert.equal(s[0].severity, 'warning');
  assert.match(s[1].message, /255바이트 경계/);
  assert.equal(summary('ALTER TABLE orders MODIFY COLUMN amount bigint;').level, 'blocking');
  assert.equal(summary('ALTER TABLE orders DROP COLUMN amount;').level, 'rebuild');
  assert.match(
    summary('ALTER TABLE orders ADD COLUMN c int, ALGORITHM=INSTANT, ADD INDEX i (c);').message,
    /INSTANT로 할 수 없는/,
  );
  assert.match(summary('ALTER TABLE ghost MODIFY COLUMN x int;').message, /확인 필요/);
  // Created in the same script: nothing to report.
  assert.equal(impact('CREATE TABLE n (id int); ALTER TABLE n MODIFY COLUMN id bigint;').length, 0);
  // Never recommends external tools.
  for (const f of impact('ALTER TABLE orders MODIFY COLUMN amount bigint; CREATE FULLTEXT INDEX f ON orders (memo);'))
    assert.doesNotMatch(f.message, /gh-ost|pt-osc|pt-online/);
});

test('impact: PostgreSQL and Oracle', () => {
  assert.equal(summary('CREATE INDEX i ON orders (memo);', 'postgresql').level, 'blocking');
  assert.equal(summary('CREATE INDEX CONCURRENTLY i ON orders (memo);', 'postgresql').level, 'inplace');
  assert.equal(summary('ALTER TABLE orders ALTER COLUMN amount TYPE bigint;', 'postgresql').level, 'blocking');
  assert.equal(summary('ALTER TABLE orders ADD COLUMN c int DEFAULT 0;', 'postgresql').level, 'instant');
  assert.equal(
    summary('ALTER TABLE orders ADD COLUMN u uuid DEFAULT gen_random_uuid();', 'postgresql').level,
    'blocking',
  );
  assert.match(summary('ALTER TABLE orders ADD COLUMN c int;', 'postgresql').message, /lock_timeout/);
  assert.equal(summary('CREATE INDEX IX ON ORDERS (MEMO);', 'oracle').level, 'blocking');
  assert.equal(summary('CREATE INDEX IX ON ORDERS (MEMO) ONLINE;', 'oracle').level, 'inplace');
  assert.equal(summary('ALTER TABLE ORDERS DROP COLUMN MEMO;', 'oracle').level, 'blocking');
});
