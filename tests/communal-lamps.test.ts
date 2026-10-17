import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '@bufbuild/protobuf';
import { CommunalLampViewSchema, LampNamingSchema } from '../src/lib/gen/glimway/v1/lamps_pb.js';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';
import { COMMUNAL_LAMP_LABEL, canLift, canRelight, communalLampLines, communalLampName, darkStoneLines, lampTiles, lampsNear, litStone, relightCost } from '../src/lib/communal-lamps.ts';

const lamp = (o: Partial<{ id: string; kind: string; cx: number; cy: number; x: number; y: number; setterId: string; setterName: string; visited: boolean }> = {}) =>
  create(CommunalLampViewSchema, { id: 'lamp-stone:2:-1', kind: 'stone', cx: 2, cy: -1, x: 49, y: -16, setterId: 'alice', setterName: 'Alice', visited: true, ...o });

test('communal lamp rules: a lamp wick relights a stone, no oil, from three tiles', () => {
  const r = HOMESTEAD_DATA.communalLamp;
  assert.equal(r.relight, 'lamp-wick');
  assert.equal(r.relightQty, 1);
  assert.equal(r.reach, 3);
  assert.equal(relightCost(), 'a lamp wick');
  assert.equal(canRelight(0), false);
  assert.equal(canRelight(1), true);
});

test('a lamp goes by the neutral label until a Keeper names it', () => {
  assert.equal(communalLampName(lamp()), COMMUNAL_LAMP_LABEL);
  const named = lamp();
  named.naming = create(LampNamingSchema, { parts: ['first', 'past', 'whitequiet', 'hold-fast'], text: 'You are the first lamp past the Whitequiet. Hold fast.', shortName: 'First past the Whitequiet' });
  assert.equal(communalLampName(named), 'First past the Whitequiet');
  assert.equal(communalLampLines(named, null)[0], '“You are the first lamp past the Whitequiet. Hold fast.”');
});

test('a stone site is lit only by a stone lamp of that id', () => {
  const post = lamp({ id: 'lamp-stone:2:-1', kind: 'post' });
  assert.equal(litStone([post], 'lamp-stone:2:-1'), null, 'a post never stands for a stone');
  const stone = lamp();
  assert.equal(litStone([post, stone], 'lamp-stone:2:-1'), stone);
  assert.equal(litStone([stone], 'lamp-stone:4:-1'), null);
});

test('lamps near the hero: the chunk and its eight neighbours, negative chunks included', () => {
  const near = [lamp({ id: 'a', cx: 1, cy: -2 }), lamp({ id: 'b', cx: 3, cy: 0 })];
  const far = [lamp({ id: 'c', cx: 4, cy: -1 }), lamp({ id: 'd', cx: 2, cy: -3 })];
  assert.deepEqual(lampsNear([...near, ...far], 2, -1).map((l) => l.id), ['a', 'b']);
  assert.ok(lampTiles(near).has('49,-16'));
});

test('only a post’s setter takes it down; nobody lifts a stone', () => {
  assert.equal(canLift(lamp({ kind: 'post' }), 'alice'), true);
  assert.equal(canLift(lamp({ kind: 'post' }), 'bob'), false);
  assert.equal(canLift(lamp({ kind: 'post' }), null), false);
  assert.equal(canLift(lamp({ kind: 'stone' }), 'alice'), false);
});

test('the readout says who lit it and what the turning brings, never a countdown', () => {
  const [, mine] = communalLampLines(lamp(), 'alice');
  assert.match(mine, /^You lit it\. Someone’s been by this wick/);
  const [, theirs] = communalLampLines(lamp({ visited: false }), 'bob');
  assert.match(theirs, /^Alice lit it\. .*goes dark at the turning/);
  const [, post] = communalLampLines(lamp({ kind: 'post', visited: false }), 'bob');
  assert.match(post, /^Alice set it\. .*Pell’s/);
  for (const l of [mine, theirs, post]) assert.doesNotMatch(l, /\d/, 'no numbers to watch');
  assert.equal(darkStoneLines('A lamp stone.')[0], 'A lamp stone.');
  assert.match(darkStoneLines('A lamp stone.')[1]!, /a lamp wick/);
});

test('the map and the world agree: a common-lamp mark reads as the neutral label, and its chunk says what the turning brings', async () => {
  const { lampLedger, turningLabel } = await import('../src/lib/wilds/map-lamps.ts');
  const { ChunkLandStatusSchema, MapLampSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
  const mark = create(MapLampSchema, { id: 'lamp-stone:2:-1', kind: 'common-lamp', x: 49, y: -16 });
  assert.equal(lampLedger([mark])[0]!.name, COMMUNAL_LAMP_LABEL);
  assert.match(turningLabel(create(ChunkLandStatusSchema, { tier: 'common', nextTurning: 'lamps-carry' })), /stay lit/);
  assert.match(turningLabel(create(ChunkLandStatusSchema, { tier: 'common', nextTurning: 'lamps-turn' })), /dark unless someone visits/);
});

test('road stones resolve the open-map pass frames by state, and the quest stone is the route stone', async () => {
  const { roadStoneArt, ROUTE_STONE_ORIGIN_X } = await import('../src/lib/communal-lamps.ts');
  const { readFileSync } = await import('node:fs');
  const atlas = JSON.parse(readFileSync('assets/generated/open-map-pass/atlas.json', 'utf8')) as { frames: Record<string, { canvas: { w: number } }> };
  const loops = JSON.parse(readFileSync('assets/generated/open-map-pass/animations.json', 'utf8')) as { key: string; frames: string[] }[];
  const site = 'lamp-stone:2:-1', cut = 'lamp-stone:0:-3';
  assert.deepEqual(roadStoneArt(site, cut, false), { frame: 'lamp-stone-dark', loop: null, route: false });
  assert.deepEqual(roadStoneArt(site, cut, true), { frame: 'lamp-stone-relit-0', loop: 'lamp-stone-relit', route: false });
  assert.deepEqual(roadStoneArt(cut, cut, false), { frame: 'route-stone-dark', loop: null, route: true });
  assert.deepEqual(roadStoneArt(cut, cut, true), { frame: 'route-stone-relit-0', loop: 'route-stone-relit', route: true });
  // No quest stone read yet: never a route stone.
  assert.equal(roadStoneArt('', '', false).route, false);
  for (const [s, c, lit] of [[site, cut, false], [site, cut, true], [cut, cut, false], [cut, cut, true]] as const) {
    const a = roadStoneArt(s, c, lit);
    assert.ok(atlas.frames[a.frame], `${a.frame} is delivered`);
    if (a.loop) assert.deepEqual(loops.find((l) => l.key === a.loop)?.frames, [0, 1, 2].map((i) => a.frame.replace(/-0$/, `-${i}`)));
  }
  // The route stone's lamp fills the left half of its 2-tile canvas, the stone's own canvas.
  assert.equal(atlas.frames['route-stone-dark']!.canvas.w * ROUTE_STONE_ORIGIN_X * 2, atlas.frames['lamp-stone-dark']!.canvas.w);
});
