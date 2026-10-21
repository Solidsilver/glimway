import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECTIONS, RECENT_MAX, parseDevPrefs, withRecent } from '../src/ui/dev/dev-prefs.ts';
import { grantables, grantGroups } from '../src/ui/dev/grantables.ts';

/** Dev mode's panel keeps its open state, its folds and the last gives on this device. */

test('a missing or damaged record is the defaults: closed, every section but the timings open', () => {
  for (const raw of [null, 'x', 7, [], { open: 'yes', sections: 'no', recent: 'timber' }]) {
    assert.deepEqual(parseDevPrefs(raw), { open: false, sections: DEFAULT_SECTIONS, recent: [] });
  }
});

test('a stored record keeps its known sections and drops the rest', () => {
  const p = parseDevPrefs({ open: true, sections: { give: false, timings: true, gone: true, clock: 'x' }, recent: ['timber', 3, 'glims'] });
  assert.equal(p.open, true);
  assert.equal(p.sections.give, false);
  assert.equal(p.sections.timings, true);
  assert.equal(p.sections.clock, true);
  assert.ok(!('gone' in p.sections));
  assert.deepEqual(p.recent, ['timber', 'glims']);
});

test('the recent list: newest first, no repeats, bounded', () => {
  assert.deepEqual(withRecent(['a', 'b', 'c'], ['b']), ['b', 'a', 'c']);
  assert.deepEqual(withRecent([], ['x', 'x']), ['x']);
  const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
  assert.equal(withRecent(many, ['new']).length, RECENT_MAX);
});

test('the kind filter offers each group once, glims first', () => {
  const groups = grantGroups(grantables());
  assert.equal(groups[0], 'Glims');
  assert.equal(new Set(groups).size, groups.length);
  for (const g of ['Material', 'Tool', 'Recipe page', 'Home good']) assert.ok(groups.includes(g), g);
});
