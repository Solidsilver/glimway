import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommons, commonsRows, plotSlot, LANE, type CommonsWorld } from '../src/game/commons.ts';
import { buildRoom, ROOM_DOOR, ROOM_GRID } from '../src/game/cottage.ts';
import { buildArea } from '../src/game/worlds.ts';
import { HOMESTEAD_DATA, plotBounds } from '../src/lib/homestead.ts';
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

test('the Commons is deterministic and registered as an area', () => {
  assert.deepEqual(buildCommons(3).ground, buildCommons(3).ground);
  assert.equal(buildArea('commons').areaId, 'commons');
  assert.equal(buildArea('home').areaId, 'home');
});

test('plot slots sit exactly where the shared layout (and the server) put them', () => {
  for (let i = 0; i < 9; i++) {
    const slot = plotSlot(i);
    const b = plotBounds(i);
    assert.deepEqual({ x: slot.tx * TILE, y: slot.ty * TILE }, { x: b.x, y: b.y }, `plot ${i}`);
    assert.equal(b.width, HOMESTEAD_DATA.outdoor.width * TILE);
    // The lane runs between the columns; each plot opens onto it.
    assert.ok(slot.side === 'east' ? slot.tx + 16 <= LANE.x0 : slot.tx > LANE.x1);
  }
});

test('the map grows a row of plots at a time for bigger worlds', () => {
  assert.equal(commonsRows(0), 2);
  assert.equal(commonsRows(4), 2);
  assert.equal(commonsRows(5), 3);
  const w = buildCommons(7);
  assert.equal(w.plots.length, 8);
  for (const p of w.plots) assert.ok((p.ty + 12) * TILE <= w.heightPx - 2 * TILE, `plot ${p.index} fits on the map`);
});

for (const count of [0, 6]) {
  test(`every plot is open ground to furnish, and reachable from the gate (${count} plots)`, () => {
    const w = buildCommons(count);
    const b = blocked(w);
    const r = reach(w, w.spawn);
    for (const p of w.plots) {
      for (let y = p.ty; y < p.ty + 12; y++)
        for (let x = p.tx; x < p.tx + 16; x++) assert.ok(!b.has(key({ tx: x, ty: y })), `plot ${p.index} tile ${x},${y} is blocked by scenery`);
      assert.ok(r.has(key(p.doorstep)), `plot ${p.index} doorstep unreachable`);
      assert.ok(near(r, p.sign), `plot ${p.index} sign unreachable`);
      // The cottage's reserved strip ends at the doorstep row's top: the door is its bottom wall.
      const res = HOMESTEAD_DATA.outdoorReserved[0];
      assert.equal(p.doorstep.ty, p.ty + res.y + res.h - 1);
    }
    for (const [name, t] of Object.entries(w.features)) {
      if (name === 'lamps') continue;
      assert.ok(near(r, t as Tile), `${name} cannot be walked up to`);
    }
    for (const e of w.exits) assert.ok(r.has(key(e)), `exit to ${e.to} unreachable`);
  });
}

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

test('inside a cottage: the floor is the 12×10 grid, the door leads to the doorstep', () => {
  const doorstep = { tx: 11, ty: 9 };
  const room = buildRoom(doorstep);
  const r = reach(room, room.spawn);
  for (let y = 0; y < HOMESTEAD_DATA.indoor.height; y++)
    for (let x = 0; x < HOMESTEAD_DATA.indoor.width; x++) assert.ok(r.has(key({ tx: ROOM_GRID.tx + x, ty: ROOM_GRID.ty + y })), `floor ${x},${y}`);
  const door = room.exits[0];
  assert.equal(door.to, 'commons');
  assert.deepEqual(door.entry, doorstep);
  assert.equal(door.label, null);
  assert.ok(r.has(key(ROOM_DOOR)));
  // The doorway inside is reserved: nobody walls themselves in.
  const mat = HOMESTEAD_DATA.indoorReserved[0];
  assert.ok(ROOM_GRID.tx + mat.x <= ROOM_DOOR.tx && ROOM_GRID.tx + mat.x + mat.w >= ROOM_DOOR.tx + 2);
  assert.equal(ROOM_GRID.ty + mat.y + mat.h, ROOM_DOOR.ty);
});
