import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDdl, looksLikeDdl } from '../src/ddlparse.ts';
import { compileRules, review, templateYaml, CHECKS } from '../src/ddlrules.ts';

const rules = (list: unknown[]) => {
  const rs = compileRules({ version: 1, rules: list });
  assert.deepEqual(rs.errors, []);
  return rs.rules;
};
const run = (sql: string, list: unknown[], db: 'mysql' | 'postgresql' | 'oracle' = 'mysql') =>
  review(parseDdl(sql, db), rules(list), db).map((f) => `${f.check}: ${sql.slice(f.from, f.to)} | ${f.message}`);

const mysql = `CREATE TABLE Orders (
  id int NOT NULL,
  member_id bigint NOT NULL COMMENT '회원',
  status enum('A','B') NOT NULL DEFAULT 'A' COMMENT '상태',
  memo varchar(2000) CHARACTER SET latin1 COMMENT '메모',
  PRIMARY KEY (id),
  KEY ix_member (member_id),
  KEY idx_member_status (member_id, status),
  UNIQUE KEY member_uk (member_id, memo),
  CONSTRAINT fk_member FOREIGN KEY (member_id) REFERENCES members (id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8;`;

test('table, column and index rules on MySQL CREATE TABLE', () => {
  const out = run(mysql, [
    { check: 'table.name.pattern', value: '^[a-z][a-z0-9_]*$', severity: 'error' },
    { check: 'table.comment.required' },
    { check: 'table.primaryKey.types', value: ['bigint'] },
    { check: 'table.primaryKey.autoIncrement' },
    { check: 'table.requiredColumns', value: [{ name: 'created_at', type: 'datetime' }] },
    { check: 'table.engine', value: ['InnoDB'] },
    { check: 'table.charset', value: 'utf8mb4' },
    { check: 'table.collate' },
    { check: 'table.foreignKey.forbidden' },
    { check: 'column.comment.required' },
    { check: 'column.type.forbidden', value: ['enum', 'set'] },
    { check: 'column.type.maxLength', value: { varchar: 1000 } },
    { check: 'column.charset.forbidden' },
    { check: 'index.name.pattern', value: '^idx_' },
    { check: 'index.unique.name.pattern', value: '^uk_', message: '유니크는 uk_ 접두어', id: 'IDX-2' },
    { check: 'index.redundant' },
  ]);
  assert.deepEqual(out, [
    'table.name.pattern: Orders | 테이블 이름이 규칙에 맞지 않습니다 — Orders',
    'table.comment.required: Orders | 테이블 코멘트가 없습니다 — Orders',
    'table.requiredColumns: Orders | 필수 컬럼이 없습니다 — created_at 없음',
    'table.engine: Orders | 스토리지 엔진이 규칙과 다릅니다 — MyISAM (허용: InnoDB)',
    'table.charset: Orders | 테이블 문자셋이 규칙과 다릅니다 — utf8 (허용: utf8mb4)',
    'table.collate: Orders | 테이블 콜레이션이 규칙과 다릅니다 — COLLATE 지정 없음',
    'table.primaryKey.types: id | PK 타입이 허용되지 않습니다 — id int',
    'table.primaryKey.autoIncrement: id | PK가 자동 증가가 아닙니다 — id',
    'column.comment.required: id | 컬럼 코멘트가 없습니다 — id',
    "column.type.forbidden: status | 사용하지 않는 타입입니다 — status enum('A','B')",
    'column.type.maxLength: memo | 컬럼 길이가 너무 깁니다 — varchar(2000) > 1000',
    'column.charset.forbidden: memo | 컬럼 단위 문자셋/콜레이션 지정은 하지 않습니다 — latin1',
    'index.redundant: ix_member | 중복 인덱스입니다 — ix_member ⊂ idx_member_status',
    'index.name.pattern: ix_member | 인덱스 이름이 규칙에 맞지 않습니다 — ix_member',
    'index.unique.name.pattern: member_uk | 유니크는 uk_ 접두어 — member_uk',
    'table.foreignKey.forbidden: fk_member | 외래 키는 사용하지 않습니다 — fk_member',
  ]);
});

test('ALTER TABLE rules (MySQL online DDL)', () => {
  const sql = `ALTER TABLE orders ADD COLUMN coupon_id bigint NOT NULL COMMENT '쿠폰' AFTER member_id;
ALTER TABLE orders ADD COLUMN memo2 varchar(10) DEFAULT '' COMMENT 'x', ALGORITHM=COPY, LOCK=SHARED;
ALTER TABLE orders DROP COLUMN memo, ALGORITHM=INPLACE, LOCK=NONE;`;
  assert.deepEqual(
    run(sql, [
      { check: 'alter.addColumn.notNullWithoutDefault', severity: 'error' },
      { check: 'alter.addColumn.position' },
      { check: 'alter.algorithmLock', value: ['INSTANT', 'INPLACE'] },
      { check: 'statement.forbidden', value: ['DROP COLUMN'] },
      { check: 'column.notNull.defaultRequired' },
    ]),
    [
      'alter.algorithmLock: orders | ALGORITHM / LOCK을 명시해야 합니다 — ALGORITHM, LOCK 없음',
      'alter.addColumn.notNullWithoutDefault: coupon_id | NOT NULL 컬럼을 DEFAULT 없이 추가합니다 — coupon_id',
      'alter.addColumn.position: coupon_id | AFTER / FIRST 위치 지정은 하지 않습니다 — coupon_id AFTER',
      'alter.algorithmLock: ALGORITHM=COPY | ALGORITHM / LOCK을 명시해야 합니다 — ALGORITHM=COPY (허용: INSTANT, INPLACE)',
      'statement.forbidden: DROP COLUMN memo | 허용되지 않는 구문입니다 — DROP COLUMN',
    ],
  );
});

test('PostgreSQL: COMMENT ON satisfies comment rules; CONCURRENTLY', () => {
  const sql = `CREATE TABLE shop.orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status varchar(20) NOT NULL
);
COMMENT ON TABLE shop.orders IS '주문';
COMMENT ON COLUMN shop.orders.id IS 'ID';
CREATE INDEX ix_orders_status ON shop.orders (status);
CREATE INDEX CONCURRENTLY ix_ok ON shop.orders (id, status);`;
  assert.deepEqual(
    run(
      sql,
      [
        { check: 'table.comment.required' },
        { check: 'column.comment.required' },
        { check: 'index.create.concurrently' },
        { check: 'table.engine', value: ['InnoDB'] }, // MySQL-only check: ignored
        { check: 'column.notNull.defaultRequired', db: ['mysql'] }, // filtered by db
      ],
      'postgresql',
    ),
    [
      'column.comment.required: status | 컬럼 코멘트가 없습니다 — status',
      'index.create.concurrently: ix_orders_status | CREATE INDEX CONCURRENTLY로 만들어야 합니다 (쓰기 잠금 방지) — ix_orders_status',
    ],
  );
});

test('Oracle: tablespace, ONLINE index, table/column filters, PL/SQL skipped', () => {
  const sql = `CREATE TABLE WMS.TB_ORDER (
  ORDER_NO NUMBER(12) GENERATED BY DEFAULT AS IDENTITY,
  NAME VARCHAR2(4000 CHAR),
  CONSTRAINT PK_TB_ORDER PRIMARY KEY (ORDER_NO)
);
CREATE TABLE TMP_X (A NUMBER) TABLESPACE TS_TEMP;
CREATE OR REPLACE PROCEDURE P AS BEGIN DELETE FROM TB_ORDER; END;
/
CREATE INDEX IX_TB_ORDER_01 ON WMS.TB_ORDER (NAME);
TRUNCATE TABLE TB_LOG;`;
  assert.deepEqual(
    run(
      sql,
      [
        { check: 'table.tablespace', value: ['TS_DATA'], tables: '^(?!TMP_)' },
        { check: 'index.create.online', severity: 'error' },
        { check: 'column.nullable.forbidden', columns: '^NAME$' },
        { check: 'column.type.maxLength', value: { varchar2: 2000 } },
        { check: 'statement.forbidden', value: ['TRUNCATE', 'DROP TABLE'] },
      ],
      'oracle',
    ),
    [
      'table.tablespace: TB_ORDER | 테이블스페이스가 규칙과 다릅니다 — TABLESPACE 지정 없음',
      'column.nullable.forbidden: NAME | NOT NULL이 아닙니다 — NAME',
      'column.type.maxLength: NAME | 컬럼 길이가 너무 깁니다 — VARCHAR2(4000 CHAR) > 2000',
      'index.create.online: IX_TB_ORDER_01 | CREATE INDEX … ONLINE으로 만들어야 합니다 (DML 잠금 방지) — IX_TB_ORDER_01',
      'statement.forbidden: TRUNCATE TABLE TB_LOG; | 허용되지 않는 구문입니다 — TRUNCATE TB_LOG',
    ],
  );
});

test('ruleset validation errors are reported and skipped', () => {
  const rs = compileRules({
    rules: [
      { check: 'table.nope' },
      { check: 'table.name.pattern', value: '([' },
      { check: 'table.name.maxLength', value: 'x' },
      { check: 'column.type.forbidden', value: 'enum' },
      { check: 'table.comment.required', db: ['sqlserver'] },
      { check: 'table.comment.required', enabled: false },
      { check: 'table.comment.required', severity: 'ERROR' },
    ],
  });
  assert.equal(rs.errors.length, 5);
  assert.equal(rs.rules.length, 1);
  assert.equal(rs.rules[0].severity, 'error');
  assert.deepEqual(compileRules(null), { rules: [], errors: [] });
  assert.deepEqual(compileRules({ version: 1, rules: null }), { rules: [], errors: [] });
});

test('template mentions every check and is all comments', () => {
  const t = templateYaml();
  for (const c of Object.keys(CHECKS)) assert.ok(t.includes(`check: ${c}`), c);
  const active = t.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.deepEqual(active, ['version: 1', 'rules:']);
});

test('looksLikeDdl', () => {
  assert.ok(looksLikeDdl('create table a (b int)'));
  assert.ok(looksLikeDdl('ALTER TABLE x ADD y int'));
  assert.ok(!looksLikeDdl('select * from orders where created_at > now()'));
});

test('reserved words, ON UPDATE, suffix ↔ type, comment pattern, explicit NULL', () => {
  const sql = `CREATE TABLE t_demo (
  id bigint NOT NULL COMMENT 'ID',
  \`order\` int NOT NULL COMMENT '순서',
  use_yn char(1) NOT NULL COMMENT '사용',
  reg_dt datetime NOT NULL COMMENT '등록',
  mobile varchar(20) NOT NULL COMMENT '휴대폰 [PII-ENC]',
  email varchar(50) NOT NULL COMMENT '메일',
  memo varchar(10) COMMENT '메모',
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '수정',
  PRIMARY KEY (id)
) COMMENT='데모';`;
  assert.deepEqual(
    run(sql, [
      { check: 'name.reserved' },
      { check: 'column.onUpdate.forbidden' },
      { check: 'column.suffix.types', value: { _yn: ['bool', 'tinyint'], _at: ['datetime'] } },
      { check: 'column.type.suffixes', value: { datetime: ['_at'] } },
      { check: 'column.comment.pattern', value: '\\[PII(-ENC|-HASH|-MSK)?\\]', columns: '(mobile|email)' },
      { check: 'column.nullable.explicit' },
    ]),
    [
      'name.reserved: `order` | 예약어를 이름으로 단독 사용했습니다 — order',
      'column.suffix.types: use_yn | 접미사에 맞지 않는 타입입니다 — use_yn char(1) — _yn는 bool / tinyint',
      'column.type.suffixes: reg_dt | 이 타입의 컬럼은 정해진 접미사로 끝나야 합니다 — reg_dt datetime — 접미사 _at',
      "column.comment.pattern: email | 컬럼 코멘트 형식이 규칙에 맞지 않습니다 — email '메일'",
      'column.nullable.explicit: memo | NULL / NOT NULL을 명시하지 않았습니다 — memo',
      'column.onUpdate.forbidden: updated_at | ON UPDATE 절은 사용하지 않습니다 — updated_at ON UPDATE CURRENT_TIMESTAMP',
    ],
  );
});

test('{table} placeholder in names, unnamed constraints, PK names, objects', () => {
  const my = `CREATE TABLE orders (
  id bigint NOT NULL,
  member_id bigint NOT NULL,
  a int, b int,
  PRIMARY KEY (id),
  KEY idx_orders_01 (member_id),
  KEY idx_order_02 (a),
  UNIQUE KEY (b),
  CONSTRAINT fk_orders_1 FOREIGN KEY (member_id) REFERENCES m (id),
  CONSTRAINT CHECK (a > 0)
);
CREATE INDEX IDX_ORDERS_03 ON orders (b);
CREATE VIEW vw_orders AS SELECT 1;
CREATE VIEW orders_v AS SELECT 1;
CREATE DEFINER=\`app\`@\`%\` PROCEDURE sp_x() BEGIN SELECT 1; END;
CREATE TRIGGER trg_orders_01 BEFORE INSERT ON orders FOR EACH ROW SET NEW.a = 1;
CREATE TRIGGER trg_members_01 BEFORE INSERT ON orders FOR EACH ROW SET NEW.a = 1;`;
  assert.deepEqual(
    run(my, [
      { check: 'index.name.pattern', value: '^idx_{table}_[0-9]{2}$', ignoreCase: true },
      { check: 'index.unique.name.pattern', value: '^udx_{table}_[0-9]{2}$' },
      { check: 'foreignKey.name.pattern', value: '^fk_{table}_[0-9]{2}$' },
      { check: 'check.name.pattern', value: '^chk_{table}_[0-9]{2}$' },
      { check: 'primaryKey.name.pattern', value: '^PK_{table}$' }, // MySQL: always PRIMARY → skipped
      { check: 'object.name.pattern', value: { VIEW: '^vw_', PROCEDURE: '^sp_', TRIGGER: '^trg_{table}_[0-9]{2}$' } },
    ]),
    [
      'index.name.pattern: idx_order_02 | 인덱스 이름이 규칙에 맞지 않습니다 — idx_order_02',
      'index.unique.name.pattern: UNIQUE | 유니크 인덱스 이름이 규칙에 맞지 않습니다 — 이름 미지정 (자동 생성 이름)',
      'foreignKey.name.pattern: fk_orders_1 | 외래 키 제약명이 규칙에 맞지 않습니다 — fk_orders_1',
      'check.name.pattern: CONSTRAINT CHECK | CHECK 제약명이 규칙에 맞지 않습니다 — 이름 미지정 (자동 생성 이름)',
      'object.name.pattern: orders_v | 오브젝트 이름이 규칙에 맞지 않습니다 — VIEW orders_v',
      'object.name.pattern: trg_members_01 | 오브젝트 이름이 규칙에 맞지 않습니다 — TRIGGER trg_members_01',
    ],
  );
  const pg = `CREATE TABLE items (id bigint PRIMARY KEY);
CREATE TABLE lines (id bigint, CONSTRAINT lines_pk PRIMARY KEY (id));
CREATE SEQUENCE items_id_seq;
CREATE SEQUENCE item_numbers;`;
  assert.deepEqual(
    run(
      pg,
      [
        { check: 'primaryKey.name.pattern', value: '^{table}_pkey$', allowMissing: true },
        { check: 'object.name.pattern', value: { SEQUENCE: '_seq$' } },
      ],
      'postgresql',
    ),
    [
      'primaryKey.name.pattern: lines_pk | PK 제약명이 규칙에 맞지 않습니다 — lines_pk',
      'object.name.pattern: item_numbers | 오브젝트 이름이 규칙에 맞지 않습니다 — SEQUENCE item_numbers',
    ],
  );
});

test('allowMissing on table options; requiredColumns with type list', () => {
  const sql = `CREATE TABLE a (id int, created_at timestamp(6)) ;
CREATE TABLE b (id int, created_at varchar(10)) DEFAULT CHARSET=utf8mb3;`;
  assert.deepEqual(
    run(sql, [
      { check: 'table.charset', value: ['utf8mb4'], allowMissing: true },
      { check: 'table.requiredColumns', value: [{ name: 'created_at', type: ['datetime', 'timestamp'] }] },
    ]),
    [
      'table.charset: b | 테이블 문자셋이 규칙과 다릅니다 — utf8mb3 (허용: utf8mb4)',
      'table.requiredColumns: created_at | 필수 컬럼이 없습니다 — created_at은(는) datetime / timestamp 타입이어야 합니다 (현재 varchar(10))',
    ],
  );
});

test('MySQL DELIMITER blocks keep statement boundaries', () => {
  const sql = `DELIMITER $$
CREATE PROCEDURE get_x()
BEGIN
  SELECT 1;
  SELECT 2;
END$$
CREATE FUNCTION fn_y() RETURNS int DETERMINISTIC
BEGIN
  RETURN 1;
END$$
DELIMITER ;
CREATE VIEW v_z AS SELECT 1;`;
  assert.deepEqual(
    run(sql, [{ check: 'object.name.pattern', value: { PROCEDURE: '^sp_', FUNCTION: '^fn_', VIEW: '^vw_' } }]).map(
      (l) => l.replace(/ \|.*/, ''),
    ),
    ['object.name.pattern: get_x', 'object.name.pattern: v_z'],
  );
});
