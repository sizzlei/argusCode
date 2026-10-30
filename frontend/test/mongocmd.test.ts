import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertCommands as convert, commandToShell, toShell } from '../src/mongocmd.ts';
import { wrapLongLines } from '../src/jswrap.ts';

const convertCommands = (t: string) => convert(t, (c) => wrapLongLines(c));

test('DocumentDB find command from the log', () => {
  const r = convertCommands(
    '{"find":"discount","filter":{"compositeKey":{"$in":["1000968896:CC02","1000463982:CC02","10044571:CC02","10048746:CC02","1002522010:CC02"]},"activationStatus":"ACTIVATED"},"$db":"discount","lsid":{"id":{"$binary":{"base64":"FX8vWVzuSFKiC4yw7IYMOg==","subType":"04"}}}}',
  );
  assert.equal(r.converted, 1);
  assert.equal(
    r.text,
    `use discount
db.discount.find({
  compositeKey: {
    $in: ['1000968896:CC02', '1000463982:CC02', '10044571:CC02', '10048746:CC02', '1002522010:CC02']
  },
  activationStatus: 'ACTIVATED'
});
`,
  );
});

test('find options become cursor methods', () => {
  const c = commandToShell({
    find: 'orders',
    filter: { memberId: 7 },
    projection: { _id: 0, amount: 1 },
    sort: { createdAt: -1 },
    skip: 20,
    limit: 10,
    hint: 'member_created',
    batchSize: 101,
    $db: 'shop',
  });
  assert.equal(
    c.code,
    "db.orders.find({ memberId: 7 }, { _id: 0, amount: 1 }).sort({ createdAt: -1 }).skip(20).limit(10).hint('member_created');",
  );
});

test('extended JSON values', () => {
  assert.equal(toShell({ $oid: '65f0c0ffee' }), "ObjectId('65f0c0ffee')");
  assert.equal(toShell({ $date: { $numberLong: '0' } }), "ISODate('1970-01-01T00:00:00.000Z')");
  assert.equal(toShell({ $date: '2026-10-01T00:00:00Z' }), "ISODate('2026-10-01T00:00:00Z')");
  assert.equal(toShell({ $numberLong: '42' }), '42');
  assert.equal(toShell({ $numberLong: '9223372036854775807' }), "Long('9223372036854775807')");
  assert.equal(toShell({ $numberDecimal: '1.10' }), "Decimal128('1.10')");
  assert.equal(
    toShell({ $binary: { base64: 'FX8vWVzuSFKiC4yw7IYMOg==', subType: '04' } }),
    "UUID('157f2f59-5cee-4852-a20b-8cb0ec860c3a')",
  );
  assert.equal(toShell({ $regularExpression: { pattern: '^ab/c', options: 'i' } }), '/^ab\\/c/i');
  assert.equal(toShell({ 'a.b': 1, $gt: 2, "it's": 'x' }), "{ 'a.b': 1, $gt: 2, 'it\\'s': 'x' }");
});

test('aggregate, count, distinct, writes', () => {
  assert.equal(
    commandToShell({ aggregate: 'orders', pipeline: [{ $match: { s: 1 } }], cursor: {}, allowDiskUse: true }).code,
    'db.orders.aggregate([{ $match: { s: 1 } }], { allowDiskUse: true });',
  );
  assert.equal(
    commandToShell({ aggregate: 1, pipeline: [{ $currentOp: {} }] }).code,
    'db.aggregate([{ $currentOp: {} }]);',
  );
  assert.equal(commandToShell({ count: 'orders', query: { a: 1 } }).code, 'db.orders.countDocuments({ a: 1 });');
  assert.equal(commandToShell({ distinct: 'orders', key: 'status' }).code, "db.orders.distinct('status');");
  assert.equal(
    commandToShell({
      update: 'orders',
      updates: [
        { q: { _id: 1 }, u: { $set: { a: 1 } }, upsert: true },
        { q: {}, u: { $inc: { n: 1 } }, multi: true },
        { q: { _id: 2 }, u: { a: 2 } },
      ],
    }).code,
    'db.orders.updateOne({ _id: 1 }, { $set: { a: 1 } }, { upsert: true });\ndb.orders.updateMany({}, { $inc: { n: 1 } });\ndb.orders.replaceOne({ _id: 2 }, { a: 2 });',
  );
  assert.equal(
    commandToShell({
      delete: 'orders',
      deletes: [
        { q: { a: 1 }, limit: 0 },
        { q: { b: 1 }, limit: 1 },
      ],
    }).code,
    'db.orders.deleteMany({ a: 1 });\ndb.orders.deleteOne({ b: 1 });',
  );
  assert.equal(commandToShell({ insert: 'orders', documents: [{ a: 1 }] }).code, 'db.orders.insertOne({ a: 1 });');
  assert.equal(
    commandToShell({ findAndModify: 'orders', query: { a: 1 }, update: { $set: { b: 2 } }, new: true, sort: { c: 1 } })
      .code,
    "db.orders.findOneAndUpdate({ a: 1 }, { $set: { b: 2 } }, { sort: { c: 1 }, returnDocument: 'after' });",
  );
  assert.equal(
    commandToShell({ findAndModify: 'orders', query: { a: 1 }, remove: true }).code,
    'db.orders.findOneAndDelete({ a: 1 });',
  );
  assert.equal(
    commandToShell({ createIndexes: 'orders', indexes: [{ key: { a: 1 }, name: 'a_1', v: 2 }] }).code,
    "db.orders.createIndex({ a: 1 }, { name: 'a_1' });",
  );
});

test('awkward collection names and unknown commands', () => {
  assert.equal(commandToShell({ find: 'order-items', filter: {} }).code, "db.getCollection('order-items').find({});");
  assert.equal(commandToShell({ find: 'stats' }).code, "db.getCollection('stats').find();");
  assert.equal(
    commandToShell({ listIndexes: 'orders', $db: 'shop', lsid: {} }).code,
    "db.runCommand({ listIndexes: 'orders' });",
  );
});

test('explain command wraps the inner command', () => {
  assert.equal(
    commandToShell({ explain: { find: 'orders', filter: { a: 1 } }, verbosity: 'executionStats', $db: 'shop' }).code,
    "db.orders.explain('executionStats').find({ a: 1 });",
  );
});

test('profiler / slow log entries, one per line, with notes', () => {
  const text = [
    '2026-10-30T01:02:03.000Z {"op":"query","ns":"discount.discount","command":{"find":"discount","filter":{"a":1}},"millis":120,"planSummary":"COLLSCAN","docsExamined":50000,"nreturned":3}',
    '{"t":{"$date":"2026-10-30T01:02:03Z"},"s":"I","c":"COMMAND","msg":"Slow query","attr":{"type":"command","ns":"shop.orders","command":{"aggregate":"orders","pipeline":[],"cursor":{},"$db":"shop"},"durationMillis":250,"planSummary":"IXSCAN { a: 1 }"}}',
    'garbage line',
    '{"find":"discount","filter":{},"$db":"discount"}',
  ].join('\n');
  const r = convertCommands(text);
  assert.equal(r.converted, 3);
  assert.equal(r.skipped, 1);
  assert.equal(
    r.text,
    `use discount
// 120 ms · COLLSCAN · 문서 50000 검사 · 3건 반환
db.discount.find({ a: 1 });

use shop
// 250 ms · IXSCAN { a: 1 }
db.orders.aggregate([]);

use discount
db.discount.find({});
`,
  );
});
