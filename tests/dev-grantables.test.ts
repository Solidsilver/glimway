import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GRANT_MAX, clampCount, everyMaterial, grantables, searchGrantables } from '../src/ui/dev/grantables.ts';
import { ITEMS } from '../src/lib/items.ts';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';

/** Dev mode's list (src/ui/dev): Glimway's own content tables, nothing else. */

test('every item and home good is grantable once, with embers first', () => {
  const list = grantables();
  assert.equal(list[0]!.id, 'embers');
  const ids = list.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'no doubles');
  for (const d of ITEMS.items) if (d.kind !== 'home-good') assert.ok(ids.includes(d.id), d.id);
  for (const h of HOMESTEAD_DATA.items) assert.ok(ids.includes(h.id), h.id);
  // Nothing but those: no Habitica gear, gold or gems.
  const own = new Set(['embers', ...ITEMS.items.map((d) => d.id), ...HOMESTEAD_DATA.items.map((h) => h.id)]);
  for (const id of ids) assert.ok(own.has(id), id);
  assert.ok(!ids.some((id) => /gold|gem|habitica|weapon_|armor_|head_|shield_/i.test(id)));
  // Kinds as the server takes them.
  const kind = (id: string) => list.find((g) => g.id === id)!.kind;
  assert.deepEqual([kind('timber'), kind('recipe-page-tea'), kind('bench-axe'), kind('wooden-stool')], ['material', 'item', 'instance', 'decoration']);
});

test('the caps are the server’s', () => {
  const go = readFileSync(new URL('../server/internal/api/dev_grant.go', import.meta.url), 'utf8');
  const cap = (name: string) => Number(/\s(\d+)/.exec(go.slice(go.indexOf(name)))![1]);
  assert.equal(GRANT_MAX.material, cap('devMaxStack'));
  assert.equal(GRANT_MAX.item, cap('devMaxStack'));
  assert.equal(GRANT_MAX.embers, cap('devMaxEmbers'));
  assert.equal(GRANT_MAX.instance, cap('devMaxOneByOne'));
  assert.equal(GRANT_MAX.decoration, cap('devMaxOneByOne'));
  assert.equal(clampCount({ max: 20 }, 50), 20);
  assert.equal(clampCount({ max: 20 }, 0), 1);
  assert.equal(clampCount({ max: 20 }, Number.NaN), 1);
});

test('search matches every word against the name, id and kind', () => {
  const list = grantables();
  assert.deepEqual(searchGrantables(list, 'bench axe').map((g) => g.id), ['bench-axe']);
  assert.ok(searchGrantables(list, 'recipe').every((g) => g.group === 'Recipe page' || /recipe/i.test(g.name + g.id)));
  assert.equal(searchGrantables(list, '').length, list.length);
  assert.deepEqual(searchGrantables(list, 'no such thing'), []);
});

test('a stack of every material: each material once, within the cap', () => {
  const stacks = everyMaterial(99);
  const materials = ITEMS.items.filter((d) => d.kind === 'material').map((d) => d.id);
  assert.deepEqual(stacks.map((s) => s.id).sort(), [...materials].sort());
  assert.ok(stacks.every((s) => s.qty === 99));
  assert.ok(stacks.length <= 64, 'one request (the server takes 64 grants at most)');
});
