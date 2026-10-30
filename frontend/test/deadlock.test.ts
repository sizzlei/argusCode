import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeField, looksLikeDeadlock, parseDeadlocks } from '../src/deadlock.ts';

const fx = (name: string) =>
  readFileSync(new URL('./fixtures/deadlock/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n'); // CRLF on Windows checkouts

test('MySQL 8: transactions, record keys, edges, victim, hints', () => {
  const [d, ...rest] = parseDeadlocks(fx('mysql8.txt'));
  assert.equal(rest.length, 0);
  assert.equal(d.db, 'mysql');
  assert.equal(d.time, '2026-10-30 10:12:01');
  assert.deepEqual(
    d.txns.map((t) => [t.name, t.victim]),
    [
      ['(1)', false],
      ['(2)', true],
    ],
  );
  const [t1, t2] = d.txns;
  assert.equal(t1.sql, "UPDATE orders SET status = 'PAID' WHERE id = 20");
  assert.equal(t1.sqlLine, 9);
  assert.deepEqual(
    t1.meta.find(([k]) => k === '스레드 ID'),
    ['스레드 ID', '101'],
  );
  assert.equal(t1.holds[0].mode, 'X 레코드');
  assert.equal(t1.holds[0].target, 'shop.orders · PRIMARY');
  assert.deepEqual(t1.holds[0].details, ['PK = 10']);
  assert.deepEqual(t1.waits[0].details, ['PK = 20']);
  assert.equal(t1.waits[0].line, 22);
  assert.deepEqual(t2.holds[0].details, ['PK = 20']);
  assert.deepEqual(
    d.edges.map((e) => [e.from, e.to]),
    [
      [0, 1],
      [1, 0],
    ],
  );
  assert.match(d.victimNote!, /\(2\).*1213/);
  assert.ok(d.hints.some((h) => /다른 순서로 잠갔습니다/.test(h)));
  assert.ok(d.hints.some((h) => /같은 형태의 문장/.test(h)));
});

test('MySQL error log: prefixes stripped, missing HOLDS inferred, gap + insert intention', () => {
  const [d] = parseDeadlocks(fx('mysql57-gap.txt'));
  assert.equal(d.time, '2026-10-30 01:20:11');
  const [t1, t2] = d.txns;
  assert.equal(t1.sql, "INSERT INTO coupon_issue (member_id, coupon_code) VALUES (77, '가을할인')");
  assert.equal(t1.holds[0].inferred, true);
  assert.equal(t1.waits[0].mode, 'X INSERT 의도');
  assert.equal(t2.holds[0].mode, 'X 넥스트키');
  assert.match(t2.holds[0].details[0], /supremum/);
  assert.ok(t2.victim);
  assert.ok(d.hints.some((h) => /갭 락과 INSERT 의도 락/.test(h)));
  assert.ok(d.hints.some((h) => /supremum/.test(h)));
  assert.ok(d.hints.some((h) => /\(1\) 12초/.test(h)));
});

test('MySQL: escaped single-line output, several deadlocks, secondary index keys', () => {
  const one = fx('mysql8.txt');
  const escaped = '| InnoDB |  | ' + one.replace(/\n/g, '\\n') + ' |';
  const [e] = parseDeadlocks(escaped);
  assert.equal(e.txns.length, 2);
  assert.equal(e.line, -1); // no jump targets in a re-flowed text
  const two = parseDeadlocks(one + '\n' + one.replace(/2026-10-30 10:12:01/, '2026-10-30 11:00:00'));
  assert.deepEqual(
    two.map((d) => d.time),
    ['2026-10-30 10:12:01', '2026-10-30 11:00:00'],
  );
  const sec = parseDeadlocks(
    [
      '*** (1) TRANSACTION:',
      'TRANSACTION 10, ACTIVE 0 sec fetching rows',
      'DELETE FROM coupon_issue WHERE member_id = 77',
      '*** (1) WAITING FOR THIS LOCK TO BE GRANTED:',
      'RECORD LOCKS space id 70 page no 6 n bits 72 index idx_member of table `shop`.`coupon_issue` trx id 10 lock mode S waiting',
      'Record lock, heap no 4 PHYSICAL RECORD: n_fields 2; compact format; info bits 0',
      ' 0: len 4; hex 8000004d; asc    M;;',
      ' 1: len 8; hex 00000000000003e9; asc         ;;',
      '*** (2) TRANSACTION:',
      'TRANSACTION 11, ACTIVE 0 sec',
      '*** WE ROLL BACK TRANSACTION (1)',
    ].join('\n'),
  );
  assert.deepEqual(sec[0].txns[0].waits[0].details, ['키 = (77, 1001)  (인덱스 컬럼 + PK)']);
  assert.equal(sec[0].txns[0].waits[0].mode, 'S 넥스트키');
});

test('InnoDB key field decoding', () => {
  assert.equal(decodeField('8000000000000014', 8, ''), '20');
  assert.equal(decodeField('00000000000003e9', 8, ''), '1001'); // BIGINT UNSIGNED
  assert.equal(decodeField('7fffffff', 4, ''), '2147483647');
  assert.equal(decodeField('50414944', 4, 'PAID'), "'PAID'");
  assert.equal(decodeField('eab080ec9d84', 6, ''), "'가을'");
  assert.equal(decodeField('99bb3caa01', 5, ''), "'2026-10-30 10:40:01'");
});

test('PostgreSQL server log', () => {
  const [d] = parseDeadlocks(fx('postgres.log'));
  assert.equal(d.db, 'postgresql');
  assert.equal(d.time, '2026-10-30 10:30:06');
  assert.deepEqual(
    d.txns.map((t) => [t.name, t.victim]),
    [
      ['PID 41002', true],
      ['PID 41001', false],
    ],
  );
  assert.equal(d.txns[1].sql, "UPDATE orders SET status = 'PAID'\n  WHERE id = 20");
  assert.equal(d.txns[0].waits[0].target, '트랜잭션 90011');
  assert.equal(d.txns[1].holds[0].target, '자기 트랜잭션 90011');
  assert.deepEqual(
    d.edges.map((e) => [e.from, e.to]),
    [
      [0, 1],
      [1, 0],
    ],
  );
  assert.ok(d.txns[0].meta.some(([k, v]) => k === 'CONTEXT' && /tuple \(0,5\)/.test(v)));
  assert.ok(d.hints.some((h) => /행 락 교착/.test(h)));
  // psql client message (no queries, no prefixes)
  const [c] = parseDeadlocks(
    [
      'ERROR:  deadlock detected',
      'DETAIL:  Process 7 waits for AccessExclusiveLock on relation 16390 of database 16384; blocked by process 8.',
      'Process 8 waits for ShareLock on transaction 501; blocked by process 7.',
      'HINT:  See server log for query details.',
    ].join('\n'),
  );
  assert.equal(c.txns.length, 2);
  assert.ok(c.hints.some((h) => /테이블 수준 락/.test(h)));
  assert.ok(c.hints.some((h) => /16390::regclass/.test(h)));
  assert.ok(c.hints.some((h) => /서버 로그/.test(h)));
});

test('Oracle ORA-00060 trace', () => {
  const [d] = parseDeadlocks(fx('oracle.trc'));
  assert.equal(d.db, 'oracle');
  assert.equal(d.time, '2026-10-30 10:40:12');
  assert.deepEqual(
    d.txns.map((t) => [t.name, t.victim]),
    [
      ['SID 123', false],
      ['SID 256', true],
    ],
  );
  const [s123, s256] = d.txns;
  assert.equal(s123.sql, 'UPDATE ORDERS SET STATUS = :B1 WHERE ID = :B2');
  assert.ok(s256.meta.some(([k, v]) => k === '머신' && v === 'app02'));
  assert.equal(s123.holds[0].mode, 'X (배타)');
  assert.match(s123.waits[0].details[0], /AAASNaAAEAAAAJXAAB/);
  assert.deepEqual(
    d.edges.map((e) => [e.from, e.to]),
    [
      [1, 0],
      [0, 1],
    ],
  );
  assert.ok(d.hints.some((h) => /TX 행 락\(X\)/.test(h)));
  // TM (unindexed foreign key) graph, 11g layout without serial columns
  const [tm] = parseDeadlocks(
    [
      'DEADLOCK DETECTED ( ORA-00060 )',
      'Deadlock graph:',
      '                       ---------Blocker(s)--------  ---------Waiter(s)---------',
      'Resource Name          process session holds waits  process session holds waits',
      'TM-00012345-00000000        23     136    SX   SSX       22     201    SX   SSX',
      'TM-00012345-00000000        22     201    SX   SSX       23     136    SX   SSX',
      '',
    ].join('\n'),
  );
  assert.equal(tm.txns.length, 2);
  assert.match(tm.txns[0].holds[0].target, /object_id 74565/);
  assert.ok(tm.hints.some((h) => /외래키 컬럼에 인덱스/.test(h)));
});

test('plans and ordinary text are not deadlocks', () => {
  assert.equal(looksLikeDeadlock('-> Table scan on o  (cost=3350 rows=99000)'), false);
  assert.deepEqual(parseDeadlocks('select 1'), []);
});
