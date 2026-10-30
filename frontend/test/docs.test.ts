import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ddlChecksMarkdown } from '../scripts/ddldocs.ts';

// Windows checkouts may convert LF to CRLF (core.autocrlf).
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('docs/ddl-checks.md is up to date (run `npm run docs`)', () => {
  const file = read('../../docs/ddl-checks.md');
  assert.equal(file, ddlChecksMarkdown());
});

test('every YAML example in docs/ddl-rules.md is a valid rule', async () => {
  const { parse } = await import('yaml');
  const { compileRules } = await import('../src/ddlrules.ts');
  const md = read('../../docs/ddl-rules.md');
  const blocks = [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => /check:/.test(b));
  assert.ok(blocks.length >= 10, 'examples found');
  let rules = 0;
  for (const b of blocks) {
    const doc = /^version:/m.test(b) ? parse(b) : { rules: parse(b) };
    const rs = compileRules(doc);
    assert.deepEqual(rs.errors, [], b);
    rules += rs.rules.length;
  }
  assert.ok(rules >= 30, `${rules} rules`);
});
