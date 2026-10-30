import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonMinify, jsonSortKeys, jsonToYaml, yamlSortKeys, yamlToJson } from '../src/datatools.ts';

test('JSON minify / sort keys', () => {
  assert.equal(jsonMinify('{ "b": 1, "a": [1, 2] }'), '{"b":1,"a":[1,2]}');
  assert.equal(
    jsonSortKeys('{"b":1,"a":{"d":1,"c":2}}', 2),
    '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n',
  );
  assert.throws(() => jsonMinify('{a:1}'), /JSON 형식 오류/);
});

test('JSON <-> YAML', async () => {
  assert.equal(await jsonToYaml('{"b":1,"a":{"c":"x","d":[1,2]}}', 2), 'b: 1\na:\n  c: x\n  d:\n    - 1\n    - 2\n');
  assert.equal(await yamlToJson('b: 1 # c\na:\n  - x\n', 2), '{\n  "b": 1,\n  "a": [\n    "x"\n  ]\n}\n');
  await assert.rejects(yamlToJson('a: [1\n', 2), /YAML 형식 오류/);
});

test('YAML sort keys keeps the header comment at the top', async () => {
  const out = await yamlSortKeys('# head\nzeta: 1\nalpha:\n  y: 2\n  x: 1\n', 2);
  assert.equal(out, '# head\n\nalpha:\n  x: 1\n  y: 2\nzeta: 1\n');
});
