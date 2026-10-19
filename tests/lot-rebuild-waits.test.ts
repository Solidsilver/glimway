// A lot's queued rebuild (a fresh read of the home, a day or season turning)
// detaches its chunk, and detaching ends an open placement. While the tray is
// open on that lot the rebuild waits, and runs once the placement ends (A10).
import '../tests/helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
const { WildsWindow } = await import('../src/game/wilds/window.ts');
const { FixedLife } = await import('../src/game/wilds/fixed-life.ts');
const { LotHomes } = await import('../src/game/wilds/lot-chunk.ts');
const { lotOrigin } = await import('../src/lib/lots.ts');

/** Lot 0's chunk and lot 1's, as the window keys them. */
const keyOf = (gate: number) => { const o = lotOrigin(gate); return `${o.tx / 24},${o.ty / 24}` };

function rig() {
  const lots = Object.create(LotHomes.prototype) as InstanceType<typeof LotHomes>;
  const placing = { placement: null as object | null };
  const map = new Map<number, { child: { arranging: typeof placing } }>([[0, { child: { arranging: placing } }], [1, { child: { arranging: { placement: null } } }]]);
  Object.assign(lots, { lots: map });
  const homes = { attach: () => [], detach: () => {}, busy: (k: string) => lots.placingIn(k) };
  const life = Object.create(FixedLife.prototype) as InstanceType<typeof FixedLife>;
  Object.assign(life, { deps: { homes: () => homes }, homeKeys: new Set([keyOf(0), keyOf(1)]) });
  const w = Object.create(WildsWindow.prototype);
  Object.assign(w, { deps: { hooks: () => life }, seasonalPending: new Set<string>() });
  return { w, placing, next: () => w['nextRebuild']() as string | undefined, pending: () => [...w.seasonalPending as Set<string>] };
}

test('a lot mid-placement keeps its rebuild queued; others go ahead', () => {
  const { w, placing, next, pending } = rig();
  placing.placement = {};
  w.seasonalPending.add(keyOf(0));
  w.seasonalPending.add(keyOf(1));
  assert.equal(next(), keyOf(1), 'the lot with no placement rebuilds');
  assert.equal(next(), undefined, 'the placing lot waits');
  assert.deepEqual(pending(), [keyOf(0)], 'and is not dropped from the queue');
  assert.equal(next(), undefined, 'still waiting the next frame');
  placing.placement = null;
  assert.equal(next(), keyOf(0), 'the placement ended: its rebuild runs');
  assert.equal(next(), undefined, 'once');
  assert.deepEqual(pending(), []);
});

test('a rebuild asked again while it waits runs once', () => {
  const { w, placing, next } = rig();
  placing.placement = {};
  w.seasonalPending.add(keyOf(0));
  assert.equal(next(), undefined);
  w.seasonalPending.add(keyOf(0));
  placing.placement = null;
  assert.equal(next(), keyOf(0));
  assert.equal(next(), undefined);
});

test('a chunk with no home layer is never held', () => {
  const { w, next } = rig();
  w.seasonalPending.add('0,0');
  assert.equal(next(), '0,0');
});
