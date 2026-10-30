import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMMANDS,
  comboOf,
  DEFAULT_KEYS,
  diffFromDefaults,
  effectiveKeys,
  isAssignable,
  keyLabel,
  keymapOf,
  menuBindings,
  normalizeCombo,
} from '../src/keybindings.ts';

test('menu defaults match internal/keymap/keymap.go', () => {
  const go = readFileSync(new URL('../../internal/keymap/keymap.go', import.meta.url), 'utf8');
  const block = go.slice(go.indexOf('var Defaults'), go.indexOf('\n}\n', go.indexOf('var Defaults')));
  const goMap: Record<string, string> = {};
  for (const m of block.matchAll(/"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)) goMap[m[1]] = m[2].replace(/\\\\/g, '\\');
  assert.deepEqual(goMap, menuBindings(DEFAULT_KEYS));
});

test('defaults have no duplicates and are assignable', () => {
  const used = COMMANDS.map((c) => c.key).filter(Boolean);
  assert.equal(new Set(used).size, used.length);
  for (const k of used) assert.ok(isAssignable(k), k);
  for (const k of used) assert.equal(normalizeCombo(k), k);
});

const ev = (key: string, code: string, m: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {}) => ({
  key,
  code,
  metaKey: !!m.meta,
  ctrlKey: !!m.ctrl,
  shiftKey: !!m.shift,
  altKey: !!m.alt,
});

test('key events → combos', () => {
  assert.equal(comboOf(ev('M', 'KeyM', { meta: true, shift: true }), true), 'mod+shift+m');
  assert.equal(comboOf(ev('ㅡ', 'KeyM', { ctrl: true, shift: true }), false), 'mod+shift+m'); // Korean IME
  assert.equal(comboOf(ev('Ï', 'KeyF', { shift: true, alt: true }), true), 'shift+alt+f');
  assert.equal(comboOf(ev('Tab', 'Tab', { ctrl: true }), false), 'ctrl+tab');
  assert.equal(comboOf(ev('Tab', 'Tab', { ctrl: true }), true), 'ctrl+tab');
  assert.equal(comboOf(ev('«', 'Backslash', { meta: true, alt: true }), true), 'mod+alt+\\');
  assert.equal(comboOf(ev('<', 'Comma', { meta: true, shift: true }), true), 'mod+shift+,');
  assert.equal(comboOf(ev('F8', 'F8'), true), 'f8');
  assert.equal(comboOf(ev('Shift', 'ShiftLeft', { shift: true }), true), null);
});

test('labels', () => {
  assert.equal(keyLabel('mod+shift+m', true), '⇧⌘M');
  assert.equal(keyLabel('mod+shift+m', false), 'Ctrl+Shift+M');
  assert.equal(keyLabel('shift+alt+f', true), '⌥⇧F');
  assert.equal(keyLabel('ctrl+tab', true), '⌃⇥');
  assert.equal(keyLabel('ctrl+tab', false), 'Ctrl+Tab');
  assert.equal(keyLabel('mod++', false), 'Ctrl++');
  assert.equal(keyLabel('mod+arrowup', true), '⌘↑');
  assert.equal(keyLabel('f8', false), 'F8');
  assert.equal(keyLabel('', true), '');
});

test('assignable combos', () => {
  assert.ok(isAssignable('mod+e'));
  assert.ok(isAssignable('alt+e'));
  assert.ok(isAssignable('f9'));
  assert.ok(isAssignable('shift+f9'));
  assert.ok(!isAssignable('e'));
  assert.ok(!isAssignable('shift+e'));
  assert.ok(!isAssignable(''));
});

test('overrides', () => {
  const keys = effectiveKeys({ 'plan.toggle': 'shift+mod+p', quickOpen: '', unknown: 'mod+u' });
  assert.equal(keys['plan.toggle'], 'mod+shift+p');
  assert.equal(keys.quickOpen, '');
  assert.ok(!('unknown' in keys));
  assert.deepEqual(diffFromDefaults(keys), { 'plan.toggle': 'mod+shift+p', quickOpen: '' });
  const map = keymapOf(keys);
  assert.equal(map.get('mod+shift+p'), 'plan.toggle');
  assert.equal(map.get('mod+p'), undefined);
  assert.equal(map.get('mod++'), 'zoom.in');
});
