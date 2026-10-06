import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommons, commonsRows, gateSlot, LANE, type CommonsWorld } from '../src/game/commons.ts';
import { buildRoom, ROOM_DOOR, ROOM_GRID } from '../src/game/cottage.ts';
import { buildArea, hasAreaKind } from '../src/game/worlds.ts';
import { buildLand, setLandSource } from '../src/game/homeland.ts';
import { HOMESTEAD_DATA, gateTile } from '../src/lib/homestead.ts';
import { LAND } from '../src/lib/homestead-land.ts';
import { TILE } from '../src/game/textures.ts';

type Tile = { tx: number; ty: number };
const key = (t: Tile) => `${t.tx},${t.ty}`;

/** Static collision (solid tiles and every prop/tree/bush/rock tile). */
function blocked(w: CommonsWorld | ReturnType<typeof buildRoom>): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.solid[y][x]) out.add(key({ tx: x, ty: y }));
  for (const s of [...w.trees, ...w.bushes, ...w.rocks, ...w.props]) out.add(key(s));
  return out;
}

function reach(w: CommonsWorld | ReturnType<typeof buildRoom>, from: Tile): Set<string> {
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

test('the Commons is deterministic and registered as an area; homestead lands resolve by gate', () => {
  assert.deepEqual(buildCommons(3).ground, buildCommons(3).ground);
  assert.equal(buildArea('commons').areaId, 'commons');
  assert.equal(buildArea('home:4').areaId, 'home:4');
  assert.ok(hasAreaKind('home:0') && hasAreaKind('home:9999'));
  assert.ok(!hasAreaKind('home:01') && !hasAreaKind('home') && !hasAreaKind('home:x'));
});

test('gate slots sit exactly where the shared layout (and the server) put them, in the fences', () => {
  for (let g = 0; g < 12; g++) {
    const slot = gateSlot(g);
    const t = gateTile(g);
    assert.deepEqual({ tx: slot.tx, ty: slot.ty }, { tx: t.tx, ty: t.ty }, `gate ${g}`);
    assert.equal(slot.tx, HOMESTEAD_DATA.commons.fenceX[g % 2]);
    // The sign and the way back out stand on the lane side of the fence.
    assert.ok(slot.side === 'west' ? slot.entry.tx > slot.tx && slot.entry.tx >= LANE.x0 : slot.entry.tx < slot.tx && slot.entry.tx <= LANE.x1);
  }
});

test('west gate shelf and neighbouring gate sign have separate prompt positions', () => {
  const shelf = gateSlot(0).shelf;
  const sign = gateSlot(2).sign;
  assert.ok(Math.hypot(shelf.tx - sign.tx, shelf.ty - sign.ty) > 1);
});

test('the lane grows a row of gates at a time and always shows spares', () => {
  const rows = HOMESTEAD_DATA.commons.gateRows.length;
  assert.equal(commonsRows(0), rows);
  assert.equal(commonsRows(rows * 2), rows);
  assert.equal(commonsRows(rows * 2 + 1), rows + 1);
  assert.equal(buildCommons(0).gates.length, HOMESTEAD_DATA.commons.spareGates);
  const w = buildCommons(13);
  assert.equal(w.gates.length, 13);
  for (const g of w.gates) assert.ok((g.ty + 3) * TILE <= w.heightPx - 2 * TILE, `gate ${g.gate} fits on the map`);
});

for (const count of [0, 6, 11]) {
  test(`every gate opens onto its homestead, and can be walked up to from the village gate (${count} gates)`, () => {
    const w = buildCommons(count);
    const r = reach(w, w.spawn);
    for (const g of w.gates) {
      const exit = w.exits.find((e) => e.to === `home:${g.gate}`);
      assert.ok(exit, `gate ${g.gate} has an exit`);
      assert.deepEqual({ tx: exit!.tx, ty: exit!.ty, tw: exit!.tw, th: exit!.th }, { tx: g.tx, ty: g.ty, tw: 1, th: 2 });
      assert.equal(exit!.label, null, 'the homestead layer draws the gate’s own sign');
      assert.ok(r.has(key(g.entry)), `gate ${g.gate}: the lane in front of it is unreachable`);
      assert.ok(near(r, g.sign), `gate ${g.gate} sign unreachable`);
      for (let y = g.ty; y <= g.ty + 1; y++) assert.ok(!w.solid[y][g.tx], `gate ${g.gate} gap is open`);
      // Coming back out of the land puts you on the lane in front of the gate.
      const land = buildArea(`home:${g.gate}`);
      assert.deepEqual(land.exits[0].entry, g.entry);
      assert.equal(land.exits[0].to, 'commons');
    }
    for (const [name, t] of Object.entries(w.features)) {
      if (name === 'lamps') continue;
      assert.ok(near(r, t as Tile), `${name} cannot be walked up to`);
    }
    for (const e of w.exits) assert.ok(r.has(key(e)), `exit to ${e.to} unreachable`);
  });
}

test('a homestead’s land: the site, the path to the gate mouth and the mailbox are reachable; the way back is the gate', () => {
  for (const gate of [0, 1, 5, 17]) {
    const land = buildLand(gate);
    const r = reach(land as unknown as CommonsWorld, land.spawn);
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

test('the Commons gate leads back to Hearthwick and the north lane to the Wilds', () => {
  const w = buildCommons();
  const village = w.exits.find((e) => e.to === 'village')!;
  const wilds = w.exits.find((e) => e.to === 'wilds')!;
  assert.equal(village.tx, 0);
  assert.equal(wilds.ty, 0);
  const v = buildArea('village');
  const gate = v.exits.find((e) => e.to === 'commons')!;
  assert.equal(gate.tx + gate.tw, v.width, 'the Commons gate is on the village’s east edge');
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
  assert.equal(door.to, 'home:7');
  assert.deepEqual(door.entry, doorstep);
  assert.equal(door.label, null);
  assert.ok(r.has(key(ROOM_DOOR)));
  // The doorway inside is reserved: nobody walls themselves in.
  const mat = HOMESTEAD_DATA.indoorReserved[0];
  assert.ok(ROOM_GRID.tx + mat.x <= ROOM_DOOR.tx && ROOM_GRID.tx + mat.x + mat.w >= ROOM_DOOR.tx + 2);
  assert.equal(ROOM_GRID.ty + mat.y + mat.h, ROOM_DOOR.ty);
});

test('a huge Commons is drawn in ground chunks no texture limit can refuse', async () => {
  const { groundChunks, GROUND_CHUNK_TILES } = await import('../src/game/area/terrain.ts');
  const w = buildCommons(320); // 320 gates: a lane well past the 8192 px texture limit
  assert.ok(w.heightPx > 8192);
  const chunks = groundChunks(w.width, w.height);
  for (const c of chunks) assert.ok(c.tw * TILE <= 1024 && c.th * TILE <= 1024 && c.tw <= GROUND_CHUNK_TILES);
  // Every tile is covered exactly once.
  const covered = chunks.reduce((n, c) => n + c.tw * c.th, 0);
  assert.equal(covered, w.width * w.height);
});
