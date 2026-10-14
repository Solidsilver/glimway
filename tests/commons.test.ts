import { commonsLane, fixedStand, fixedSolidAt } from '../src/game/wilds/fixed.ts';
import { homeDoorstep, lotOrigin } from '../src/lib/lots.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoom, ROOM_DOOR, ROOM_GRID } from '../src/game/cottage.ts';
import { buildArea, hasAreaKind } from '../src/game/worlds.ts';
import { buildLand, setLandSource } from '../src/game/homeland.ts';
import { HOMESTEAD_DATA, gateTile } from '../src/lib/homestead.ts';
import { LAND } from '../src/lib/homestead-land.ts';
import { serveFixtureLand } from './land-fixture.ts';
import { serveFixtureCommons, serveFixtureLots, servedCommonsFixture, type CommonsView } from './commons-fixture.ts';
import { anchorTile } from '../src/game/wilds/fixed.ts';

// Homestead land and the Commons are the server's: these tests stand on their served fixtures.
serveFixtureLand('guest');
const footprint = serveFixtureCommons();
const commons = servedCommonsFixture();
/** The plot lane between the two fences (content/homestead.json fenceX). */
import { TILE } from '../src/lib/tile.ts';

type Tile = { tx: number; ty: number };
const key = (t: Tile) => `${t.tx},${t.ty}`;

/** Static collision (solid tiles and every prop/tree/bush/rock tile). */
function blocked(w: CommonsView | ReturnType<typeof buildRoom>): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.solid[y][x]) out.add(key({ tx: x, ty: y }));
  for (const s of [...w.trees, ...w.bushes, ...w.rocks, ...w.props]) out.add(key(s));
  return out;
}

function reach(w: CommonsView | ReturnType<typeof buildRoom>, from: Tile): Set<string> {
  const b = blocked(w);
  const seen = new Set([key(from)]);
  const q = [from];
  while (q.length) {
    const t = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { tx: t.tx + dx, ty: t.ty + dy };
      if (n.tx < 0 || n.ty < 0 || n.tx >= w.width || n.ty >= w.height || seen.has(key(n)) || b.has(key(n))) continue;
      seen.add(key(n));
      q.push(n);
    }
  }
  return seen;
}

const near = (r: Set<string>, t: Tile) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => r.has(key({ tx: t.tx + dx, ty: t.ty + dy })));

test('the Commons is fixed ground on the open map, no area of its own; homestead lands resolve by gate', () => {
  assert.equal(hasAreaKind('commons'), false);
  assert.ok(hasAreaKind('outdoors'));
  assert.equal(buildArea('home:4').areaId, 'home:4');
  assert.ok(hasAreaKind('home:0') && hasAreaKind('home:9999'));
  assert.ok(!hasAreaKind('home:01') && !hasAreaKind('home') && !hasAreaKind('home:x'));
});

test('gate slots sit exactly where the served lots put their south fence gaps', () => {
  serveFixtureLots();
  const lane = commonsLane()!;
  assert.equal(lane.gates.length, 8);
  for (const slot of lane.gates) {
    const o = lotOrigin(slot.gate);
    assert.deepEqual({ tx: slot.tx, ty: slot.ty, side: slot.side }, gateTile(slot.gate));
    assert.deepEqual(slot.sign, { tx: o.tx + 9, ty: o.ty + 20 });
    assert.deepEqual(slot.shelf, { tx: o.tx + 14, ty: o.ty + 20 });
    assert.equal(slot.chunk, `${o.tx / 24},${o.ty / 24}`);
  }
});

test('west gate shelf and neighbouring gate sign have separate prompt positions', () => {
  serveFixtureLots();
  const gates = commonsLane()!.gates;
  for (const g of gates) assert.ok(Math.hypot(g.shelf.tx - g.sign.tx, g.shelf.ty - g.sign.ty) >= 5);
});

test('the lane holds exactly eight chunk lots, beyond the old spare count', () => {
  serveFixtureLots();
  assert.equal(commonsLane()!.gates.length, 8);
  assert.ok(commonsLane()!.gates.length > HOMESTEAD_DATA.commons.spareGates);
});

test('every lot doorstep and gate connects to the public lanes without a gate portal', () => {
  const fp = serveFixtureLots();
  for (const g of commonsLane()!.gates) {
    assert.deepEqual(fixedStand(g.entry.tx, g.entry.ty), g.entry);
    assert.deepEqual(fixedStand(homeDoorstep(g.gate).tx, homeDoorstep(g.gate).ty), homeDoorstep(g.gate));
    assert.ok(!fp.objects.get(g.chunk)!.some((o) => o.exit), 'lot entrance is a walk, not a portal');
    for (const tx of [g.tx, g.tx + 1]) assert.equal(fixedSolidAt(tx, g.ty), false);
  }
});

test('a homestead’s land: the site, the path to the gate mouth and the mailbox are reachable; the way back is the gate', () => {
  for (const gate of [0, 1, 5, 17]) {
    const land = buildLand(gate);
    const r = reach(land as unknown as CommonsView, land.spawn);
    assert.equal(land.exits.length, 1);
    const exit = land.exits[0];
    assert.equal(exit.ty, land.height - 1);
    assert.ok(r.has(key(exit)), 'the gate mouth can be walked to');
    assert.ok(r.has(key(land.doorstep)), 'the doorstep can be walked to');
    assert.ok(near(r, land.mailbox), 'the mailbox can be walked up to');
    // The home site is open ground (the camp or cottage stands there).
    for (let y = land.site.y; y < land.site.y + land.site.h; y++) for (let x = land.site.x; x < land.site.x + land.site.w; x++) assert.ok(!land.solid[y][x], `site ${x},${y}`);
    // The mailbox and the path are reserved: nobody builds over them.
    const rect = (x: number, y: number) => HOMESTEAD_DATA.outdoorReserved.some((rr) => x >= rr.x && x < rr.x + rr.w && y >= rr.y && y < rr.y + rr.h);
    assert.ok(rect(land.mailbox.tx, land.mailbox.ty));
    for (let y = land.site.y + land.site.h; y < land.height; y++) for (let x = HOMESTEAD_DATA.land.gate.x; x < HOMESTEAD_DATA.land.gate.x + HOMESTEAD_DATA.land.gate.w; x++) assert.ok(rect(x, y), `path ${x},${y}`);
  }
});

test('cleared tiles open up the land map; desolation grows over it', () => {
  const gate = 3;
  const plain = buildLand(gate);
  let tree: [number, number] | null = null;
  for (let y = 1; y < plain.height - 1 && !tree; y++) for (let x = 1; x < plain.width - 1 && !tree; x++) if (plain.land.tiles[y * plain.width + x] === LAND.TREE) tree = [x, y];
  assert.ok(tree);
  assert.ok(plain.solid[tree![1]][tree![0]]);
  setLandSource({ worldId: () => 'guest', state: (g) => (g === gate ? { cleared: [tree!], desolate: true } : null) });
  try {
    const cleared = buildLand(gate);
    assert.ok(!cleared.solid[tree![1]][tree![0]]);
    assert.ok(cleared.desolate);
    assert.ok((cleared.scenery?.length ?? 0) > (plain.scenery?.length ?? 0) - 1);
  } finally {
    setLandSource({ worldId: () => 'guest', state: () => null });
  }
});

test('the Commons gate leads back to Hearthwick; the north lane is walked into the Wilds, through the mouth alone', { skip: "T5: remove the old village portal" }, () => {
  const w = commons;
  const village = w.exits.find((e) => e.to === 'village')!;
  assert.equal(village.tx, 0);
  assert.equal(w.exits.some((e) => e.to === 'outdoors'), false, 'no portal at the arch');
  // The footprint's north edge is solid but for the mouth, under the Tangle's gate (world x 1..3).
  const open = footprint.solid[0]!.flatMap((s, x) => (s ? [] : [footprint.tx + x]));
  assert.deepEqual(open, [1, 2, 3]);
  const v = buildArea('village');
  const gate = v.exits.find((e) => e.to === 'outdoors')!;
  assert.equal(gate.tx + gate.tw, v.width, 'the Commons gate is on the village’s east edge');
  assert.deepEqual(gate.entry, anchorTile('commons:west-path'));
  // The Lantern Road exit (the quest's) is untouched.
  assert.deepEqual(v.exits.find((e) => e.to === 'woodland'), { tx: v.width - 1, ty: 9, tw: 1, th: 3, to: 'woodland', entry: { tx: 2, ty: 15 } });
});

test('inside a cottage: the floor is the 12×10 grid, the door leads to the doorstep on its land', () => {
  const doorstep = { tx: 19, ty: 11 };
  const room = buildRoom(7, doorstep);
  const r = reach(room, room.spawn);
  for (let y = 0; y < HOMESTEAD_DATA.indoor.height; y++)
    for (let x = 0; x < HOMESTEAD_DATA.indoor.width; x++) assert.ok(r.has(key({ tx: ROOM_GRID.tx + x, ty: ROOM_GRID.ty + y })), `floor ${x},${y}`);
  const door = room.exits[0];
  assert.equal(door.to, 'outdoors');
  assert.deepEqual(door.entry, homeDoorstep(7));
  assert.equal(door.label, null);
  assert.ok(r.has(key(ROOM_DOOR)));
  // The doorway inside is reserved: nobody walls themselves in.
  const mat = HOMESTEAD_DATA.indoorReserved[0];
  assert.ok(ROOM_GRID.tx + mat.x <= ROOM_DOOR.tx && ROOM_GRID.tx + mat.x + mat.w >= ROOM_DOOR.tx + 2);
  assert.equal(ROOM_GRID.ty + mat.y + mat.h, ROOM_DOOR.ty);
});

test('a huge area is drawn in ground chunks no texture limit can refuse', async () => {
  const { groundChunks, GROUND_CHUNK_TILES } = await import('../src/game/area/terrain.ts');
  const w = { width: 62, height: 820 }; // a map well past the 8192 px texture limit
  assert.ok(w.height * TILE > 8192);
  const chunks = groundChunks(w.width, w.height);
  for (const c of chunks) assert.ok(c.tw * TILE <= 1024 && c.th * TILE <= 1024 && c.tw <= GROUND_CHUNK_TILES);
  // Every tile is covered exactly once.
  const covered = chunks.reduce((n, c) => n + c.tw * c.th, 0);
  assert.equal(covered, w.width * w.height);
});
