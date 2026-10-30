import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapLine, wrapLongLines } from '../src/jswrap.ts';

test('short lines are untouched', () => {
  assert.deepEqual(wrapLine('db.orders.find({ a: 1 }).limit(5)'), ['db.orders.find({ a: 1 }).limit(5)']);
});

test('aggregate pipeline: one stage per line, call hugs the array', () => {
  const line =
    "db.orders.aggregate([{ $match: { status: 'PAID', createdAt: { $gte: ISODate(\"2026-10-01\") } } }, { $group: { _id: '$memberId', total: { $sum: '$amount' } } }, { $sort: { total: -1 } }, { $limit: 10 }]);";
  assert.deepEqual(wrapLine(line), [
    'db.orders.aggregate([',
    '  { $match: { status: \'PAID\', createdAt: { $gte: ISODate("2026-10-01") } } },',
    "  { $group: { _id: '$memberId', total: { $sum: '$amount' } } },",
    '  { $sort: { total: -1 } },',
    '  { $limit: 10 }',
    ']);',
  ]);
});

test('nested breaking when an element is still too long, indentation kept', () => {
  const out = wrapLine(
    "    db.orders.updateMany({ status: 'PENDING', createdAt: { $lt: ISODate('2026-01-01') } }, { $set: { status: 'EXPIRED', expiredAt: new Date(), reason: 'timeout' } });",
    60,
  );
  assert.deepEqual(out, [
    '    db.orders.updateMany(',
    '      {',
    "        status: 'PENDING',",
    "        createdAt: { $lt: ISODate('2026-01-01') }",
    '      },',
    '      {',
    '        $set: {',
    "          status: 'EXPIRED',",
    '          expiredAt: new Date(),',
    "          reason: 'timeout'",
    '        }',
    '      }',
    '    );',
  ]);
});

test('strings, regex and comments with brackets are not split', () => {
  const s =
    "db.users.find({ name: { $regex: /^[a-z(]+$/i }, note: 'a, b [c] {d}', tag: `x,${'y'}` }).sort({ name: 1 }) // a, [b]";
  const out = wrapLine(s, 50);
  assert.equal(out[0], 'db.users.find({');
  assert.equal(out[1], '  name: { $regex: /^[a-z(]+$/i },');
  assert.equal(out[2], "  note: 'a, b [c] {d}',");
  assert.ok(out[out.length - 1].endsWith('// a, [b]'));
});

test('unbalanced or continued lines are left alone; block comments skipped', () => {
  const long = 'x'.repeat(120);
  assert.deepEqual(wrapLine(`foo(${long}, [1, 2`), [`foo(${long}, [1, 2`]);
  const text = `/*\n  ${'[a, b] '.repeat(30)}\n*/\nconst a = 1;`;
  assert.equal(wrapLongLines(text), text);
});
