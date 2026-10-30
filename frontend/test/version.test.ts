import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/version.ts';

test('version comparison', () => {
  assert.ok(isNewer('0.9.1', '0.9.0'));
  assert.ok(isNewer('v0.10.0', '0.9.9'));
  assert.ok(isNewer('1.0.0', '0.99.99'));
  assert.ok(isNewer('0.9.2-beta', '0.9.1'));
  assert.ok(!isNewer('0.9.0', '0.9.0'));
  assert.ok(!isNewer('0.9.0', '0.9.1'));
  assert.ok(!isNewer('0.9', '0.9.0'));
});
