// Hand-overs the server measures from a resident's post (Sol's H2 review,
// finding 2): Hazel stops for you anywhere on her route, but offers the
// whistle's return and her kitchen's goods only within the server's reach
// of the post her cycle has her at; elsewhere she says where to find her.
import './helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
const { newWalker, tickWalker, ROUTINES } = await import('../src/game/npc-routines.ts');
const { tileFeet } = await import('../src/lib/tile.ts');
const { keepsakeAsk } = await import('../src/game/keepsakes.ts');
const { residentAt } = await import('../src/lib/residents.ts');
const { contentPosition } = await import('../src/lib/location.ts');
const { elsewhereLine, returnReaches, sellsHere } = await import('../src/game/resident-reach.ts');

/** A moment Hazel's cycle has her at the given post's area. */
function whenAt(area: string): number {
  for (let t = 1_767_225_600; t < 1_767_225_600 + 86_400 * 7; t += 300) if (residentAt('hazel', t)?.area === area) return t;
  throw new Error(`hazel never at ${area}`);
}

/** The world pixel (save coordinates) of a hearthwick tile's feet. */
function outdoors(tx: number, ty: number): { area: string; x: number; y: number } {
  const p = contentPosition('hearthwick', tx, ty);
  const f = tileFeet(p.tx, p.ty);
  return { area: p.space, x: f.x, y: f.y };
}

const session = (h: { area: string; x: number; y: number }) => ({ state: { area: h.area, position: { x: h.x, y: h.y }, flags: [] } }) as never;

test('Hazel stopped at the bakery end of her route spots the whistle but does not offer its return', () => {
  const home = tileFeet(9, 63), bakery = tileFeet(6, 54);
  const w = newWalker(home);
  const routine = ROUTINES.hearthwick!.hazel!;
  let found = false;
  for (let i = 0; i < 4000 && !found; i++) {
    tickWalker(w, routine, home, null, 0.1, false);
    found = w.x === bakery.x && w.y === bakery.y;
  }
  assert.ok(found, 'her routine reaches the bakery');
  tickWalker(w, routine, home, { x: w.x + 10, y: w.y }, 0.1, false);
  assert.ok(w.paused, 'she stops for you there');

  const now = whenAt('hearthwick');
  const byBakery = session(outdoors(7, 54));
  assert.equal(returnReaches(byBakery, 'hazel', now), false);
  const ask = keepsakeAsk('hazel', [], ['tin-whistle'], returnReaches(byBakery, 'hazel', now))!;
  assert.match(ask.line, /whistle/);
  assert.deepEqual(ask.choices, [], 'no "Give it back" where the server would refuse it');
  assert.match(elsewhereLine('hazel', now), /square/);
  assert.equal(sellsHere(byBakery, 'hazels-kitchen', now), false, 'nor her kitchen goods');

  const bySquare = session(outdoors(9, 64));
  assert.equal(returnReaches(bySquare, 'hazel', now), true);
  assert.ok(keepsakeAsk('hazel', [], ['tin-whistle'], true)!.choices.some((c) => c.action === 'keep:return:tin-whistle:hazel'));
  assert.equal(sellsHere(bySquare, 'hazels-kitchen', now), true);
});

test('indoors, Hazel at the oven sends you to the worktable; residents without a post rule always offer', () => {
  const now = whenAt('in:village:bakery');
  const post = residentAt('hazel', now)!;
  // Beside her at the oven (7,3), on its far side: about 4.7 tiles from her post.
  const atOven = session({ area: 'in:village:bakery', x: 8 * 16 + 8, y: 3 * 16 + 16 });
  const atTable = session({ area: 'in:village:bakery', x: post.tx * 16 + 8, y: post.ty * 16 + 24 });
  assert.equal(returnReaches(atOven, 'hazel', now), false);
  assert.equal(returnReaches(atTable, 'hazel', now), true);
  assert.match(elsewhereLine('hazel', now), /worktable/);
  // Silas's fox goes back by his mender's reach (the yard's own talk).
  assert.equal(returnReaches(atOven, 'silas', now), true);
});
