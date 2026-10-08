import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOMS as ROOM_DATA, knownRoom, roomFor, roomParent, rootArea } from '../src/lib/rooms.ts';
import { RESIDENTS, residentById } from '../src/lib/residents.ts';
import { cycleAt, cycleSpotsNear } from '../src/lib/clock.ts';
import { buildArea, hasAreaKind } from '../src/game/worlds.ts';
import { facingFor, groupsOf, residentSpotsIn, roomArrival } from '../src/game/room-kind.ts';
import { doorFor, residentPlace, residentIn, twoLegs } from '../src/game/resident-cycle.ts';
import { ROOM_ENTRY, homeRoomArea, parseHomeRoom } from '../src/game/cottage.ts';
import { landDoor } from '../src/game/homeland.ts';
import { roomZoomFor, zoomFor } from '../src/game/viewport.ts';
import { isPresenceArea, presenceAreaFor } from '../src/lib/presence-client.ts';
import { isSafeArea } from '../src/lib/habitica/sync.ts';
import { createNewGame, validateSave } from '../src/lib/state.ts';
import { TILE, tileFeet } from '../src/lib/tile.ts';

const ROOMS = ROOM_DATA.rooms;
const GRACE = RESIDENTS.graceSeconds;

/** Unix seconds at `minute` past some UTC hour. */
const at = (minute: number, second = 0) => Date.parse('2026-10-08T14:00:00Z') / 1000 + minute * 60 + second;

// ------------------------------------------------------------ the builder

test('every room builds as an area: walls solid, the floor open, you arrive on its @', () => {
  for (const def of ROOMS) {
    assert.ok(hasAreaKind(def.id), def.id);
    const w = buildArea(def.id);
    assert.equal(w.areaId, def.id);
    assert.equal(w.width, def.map[0].length);
    assert.equal(w.height, def.map.length);
    for (let y = 0; y < w.height; y++)
      for (let x = 0; x < w.width; x++) {
        const c = def.map[y][x];
        if (c === '#' || c === '=' || c === 'w') assert.equal(w.solid[y][x], true, `${def.id} ${x},${y} is wall`);
        if (c === '.' || c === ':' || c === '@' || c === 'D' || c === '^' || c === 'v') assert.equal(w.solid[y][x], false, `${def.id} ${x},${y} is floor`);
      }
    assert.ok(w.room, 'the room scene rides along');
    assert.equal(w.solid[w.spawn.ty][w.spawn.tx], false);
    // Nobody arrives standing in a way out.
    for (const e of w.exits) assert.ok(!(w.spawn.tx >= e.tx && w.spawn.tx < e.tx + e.tw && w.spawn.ty >= e.ty && w.spawn.ty < e.ty + e.th), `${def.id}: the arrival isn't in an exit`);
  }
});

test('props stand on their footprints: one rectangle per group of their letter, solid when they say', () => {
  const kitchen = buildArea('in:village:bakery');
  const table = kitchen.room!.props.find((p) => p.art === 'kitchen-worktable')!;
  assert.deepEqual({ tx: table.tx, ty: table.ty, tw: table.tw, th: table.th }, { tx: 3, ty: 4, tw: 4, th: 2 });
  for (let y = table.ty; y < table.ty + table.th; y++) for (let x = table.tx; x < table.tx + table.tw; x++) assert.equal(kitchen.solid[y][x], true);
  // The library's three tall shelves are three props.
  assert.equal(buildArea('in:village:library').room!.props.filter((p) => p.art === 'library-shelves').length, 3);
  // A letter that isn't a rectangle is refused.
  assert.throws(() => groupsOf({ ...roomFor('in:village:bakery')!, map: ['#####', '#aa.#', '#.a.#', '#####'] }, 'a'), /isn't a rectangle/);
  assert.throws(() => buildArea('in:village:nowhere'));
});

test('spots sit on or beside open floor, and their ids are unique across the rooms', () => {
  const seen = new Set<string>();
  for (const def of ROOMS) {
    const w = buildArea(def.id);
    for (const [id, s] of Object.entries(def.spots)) {
      assert.ok(!seen.has(id), `${id} is named once`);
      seen.add(id);
      const open = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => w.solid[s.ty + dy]?.[s.tx + dx] === false);
      assert.ok(open, `${def.id}: ${id} can be reached`);
    }
  }
});

// ------------------------------------------------------------ doors and stairs

test('a doorway leads out to the doorstep on the parent, facing away from the door', () => {
  for (const def of ROOMS.filter((r) => r.doors.some((d) => d.kind === 'door'))) {
    const w = buildArea(def.id);
    const out = w.exits.find((e) => e.kind === 'door')!;
    assert.equal(out.side, 'south');
    assert.equal(out.ty, w.height - 1, 'the gap is in the near wall');
    assert.equal(out.tw, 2);
    assert.deepEqual(facingFor({ side: out.side!, kind: out.kind }), { x: 0, y: 1 });
    // The parent: the door tile is solid (you press it), the doorstep is open.
    const door = def.doors.find((d) => d.kind === 'door')!;
    const parent = buildArea(def.parent);
    assert.equal(parent.solid[door.outside!.ty][door.outside!.tx], true, `${def.id}: the door tile is the house's`);
    assert.equal(parent.solid[out.entry.ty][out.entry.tx], false, `${def.id}: the doorstep is open`);
    assert.equal(out.entry.ty, door.outside!.ty + 1, 'the doorstep is just below the door');
    // Coming in, you arrive on the @.
    assert.deepEqual(roomArrival(def.id), w.room!.arrive);
  }
});

test('the mill’s stairs: up onto the loft beside its stairs down, and back down beside the stairs up', () => {
  const mill = buildArea('in:village:mill');
  const loft = buildArea('in:village:mill:2');
  const up = mill.exits.find((e) => e.kind === 'stair')!;
  const down = loft.exits.find((e) => e.kind === 'stair')!;
  assert.equal(up.to, 'in:village:mill:2');
  assert.equal(down.to, 'in:village:mill');
  assert.equal(up.label, 'The sack loft');
  const inside = (e: typeof up, t: { tx: number; ty: number }) => t.tx >= e.tx && t.tx < e.tx + e.tw && t.ty >= e.ty && t.ty < e.ty + e.th;
  // Each arrival is open floor, beside (not on) the stair going back.
  assert.equal(loft.solid[up.entry.ty][up.entry.tx], false);
  assert.ok(!inside(down, up.entry), 'arriving in the loft is off its stairs');
  assert.equal(up.entry.tx, down.tx + down.tw, 'just east of the stairs down');
  assert.deepEqual(facingFor({ side: up.side!, kind: up.kind }), { x: 1, y: 0 }, 'facing east, off the stairs');
  assert.deepEqual(facingFor({ side: down.side!, kind: down.kind }), { x: -1, y: 0 }, 'facing west on the mill floor');
  assert.equal(mill.solid[down.entry.ty][down.entry.tx], false);
  assert.ok(!inside(up, down.entry), 'arriving on the mill floor is off its stairs');
  assert.ok(Math.abs(down.entry.tx - up.tx) <= 1 && down.entry.ty >= up.ty && down.entry.ty < up.ty + up.th, 'beside the stairs up');
});

test('room ids: parents, roots, and what counts as a room', () => {
  assert.equal(roomParent('in:village:mill:2'), 'in:village:mill');
  assert.equal(roomParent('in:village:mill'), 'village');
  assert.equal(roomParent('in:home:12'), 'home:12');
  assert.equal(roomParent('village'), 'village');
  assert.equal(rootArea('in:village:mill:2'), 'village');
  assert.equal(rootArea('in:home:12'), 'home:12');
  assert.equal(rootArea('commons'), 'commons');
  assert.ok(knownRoom('in:village:library'));
  assert.ok(knownRoom('in:home:0'));
  assert.ok(!knownRoom('in:home:012'));
  assert.ok(!knownRoom('in:village:nowhere'));
  assert.equal(roomFor('in:village:nowhere'), null);
});

// ------------------------------------------------------------ the cottage

test('the cottage is the place in:home:<gate>: in by its door, out onto the land’s doorstep', () => {
  assert.equal(homeRoomArea(7), 'in:home:7');
  assert.equal(parseHomeRoom('in:home:7'), 7);
  assert.equal(parseHomeRoom('home:7'), null);
  const w = buildArea('in:home:7');
  assert.equal(w.areaId, 'in:home:7');
  assert.deepEqual(w.spawn, ROOM_ENTRY);
  const out = w.exits[0];
  assert.equal(out.to, 'home:7');
  assert.deepEqual(out.entry, landDoor().doorstep);
  assert.equal(out.side, 'south');
  assert.equal(out.kind, 'door');
});

test('rooms are save places, safe places and presence rooms of their own', () => {
  for (const area of ['in:village:bakery', 'in:village:mill:2', 'in:home:3']) {
    assert.equal(validateSave({ ...createNewGame(), area }).area, area, `${area} saves`);
    assert.ok(isSafeArea(area), `${area} is safe (its root is)`);
    assert.ok(isPresenceArea(area), `${area} is a presence room`);
    assert.equal(presenceAreaFor(area), area, 'passed through unchanged');
  }
  assert.throws(() => validateSave({ ...createNewGame(), area: 'in:village:nowhere' }));
  assert.equal(presenceAreaFor('in:village:nowhere'), null);
});

// ------------------------------------------------------------ residents on the cycle

test('the cycle: Hazel 40 in and 20 out, Finn at the stones, the loft and his door, offset 20', () => {
  const where = (id: string, minute: number) => residentPlace(id, at(minute))!.spot;
  assert.equal(where('hazel', 0), 'kitchen');
  assert.equal(where('hazel', 39), 'kitchen');
  assert.equal(where('hazel', 40), 'square');
  assert.equal(where('hazel', 59), 'square');
  assert.equal(where('finn', 10), 'door');
  assert.equal(where('finn', 20), 'stones');
  assert.equal(where('finn', 44), 'stones');
  assert.equal(where('finn', 45), 'loft');
  assert.equal(where('finn', 55), 'door');
  assert.equal(where('ada', 33), 'window');
  // Both are out at once for five minutes an hour.
  const bothOut = Array.from({ length: 60 }, (_, m) => m).filter((m) => where('hazel', m) === 'square' && where('finn', m) === 'door');
  assert.deepEqual(bothOut, [55, 56, 57, 58, 59]);
  // A phase's edges.
  const c = cycleAt(residentById('hazel')!, at(12));
  assert.equal(c.since, at(0));
  assert.equal(c.until, at(40));
  // The grace window: the next spot shortly before a change, the last shortly after.
  assert.deepEqual(cycleSpotsNear(residentById('hazel')!, at(39, 30), GRACE), ['kitchen', 'square']);
  assert.deepEqual(cycleSpotsNear(residentById('hazel')!, at(41), GRACE), ['square', 'kitchen']);
  assert.deepEqual(cycleSpotsNear(residentById('hazel')!, at(20), GRACE), ['kitchen']);
});

test('who’s home: a room’s resident is in while their spot is in it (the loft counts as the mill)', () => {
  assert.ok(residentIn('in:village:bakery', at(10)));
  assert.ok(!residentIn('in:village:bakery', at(50)));
  assert.ok(residentIn('in:village:mill', at(30)), 'at the stones');
  assert.ok(residentIn('in:village:mill', at(50)), 'up in the loft');
  assert.ok(!residentIn('in:village:mill', at(10)), 'out at his door');
  assert.ok(residentIn('in:village:library', at(10)), 'Elara arrives at her desk');
  assert.ok(residentIn('in:village:library', at(39)), 'Elara is still at her desk');
  assert.ok(!residentIn('in:village:library', at(40)), 'Elara leaves for her camp');
  assert.ok(!residentIn('in:village:library', at(0)), 'Elara is at camp before opening');
});

test('residents are placed at every spot they have in an area; the cycle says which one they stand at', () => {
  assert.deepEqual(residentSpotsIn('in:village:bakery'), [{ id: 'hazel', tx: 4, ty: 6, spot: 'kitchen' }]);
  assert.deepEqual(residentSpotsIn('in:village:mill:2'), [{ id: 'finn', tx: 7, ty: 5, spot: 'loft' }]);
  const village = buildArea('village').npcs.filter((n) => n.spot);
  assert.deepEqual(village.map((n) => `${n.id}:${n.spot}`).sort(), ['ada:window', 'finn:door', 'hazel:square']);
  // Every spot is open floor.
  for (const def of ROOMS) for (const n of residentSpotsIn(def.id)) assert.equal(buildArea(def.id).solid[n.ty][n.tx], false, `${n.id} at ${def.id}`);
});

test('the walk at a change: to the doorway, the stairs, or the front door outside', () => {
  // Hazel leaving the kitchen for the square: out through the doorway.
  assert.deepEqual(doorFor('hazel', 'in:village:bakery', 'village'), { step: { tx: 6, ty: 8 }, door: { tx: 6, ty: 9 } });
  // Finn going up to the loft: onto the stairs from the floor below them.
  assert.deepEqual(doorFor('finn', 'in:village:mill', 'in:village:mill:2'), { step: { tx: 10, ty: 7 }, door: { tx: 10, ty: 6 } });
  // ...and from the loft out to his door: down the stairs.
  assert.deepEqual(doorFor('finn', 'in:village:mill:2', 'village')?.door, { tx: 2, ty: 5 });
  // Outside, Hazel comes and goes by her front door.
  assert.deepEqual(doorFor('hazel', 'village', 'in:village:bakery'), { step: { tx: 7, ty: 8 }, door: { tx: 7, ty: 7 } });
  // Two legs, across then up or down, ending on the target's feet.
  const legs = twoLegs({ tx: 12, ty: 15 }, { tx: 7, ty: 8 });
  assert.deepEqual(legs, [tileFeet(7, 15), tileFeet(7, 8)]);
});

// ------------------------------------------------------------ the camera

test('a room is framed closer: its height fills most of the open screen, never below the outdoor zoom', () => {
  const kitchen = { widthPx: 14 * TILE, heightPx: 10 * TILE };
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  // A laptop: 3 outdoors, 4 in the kitchen.
  assert.equal(zoomFor(1280, 800), 3);
  assert.equal(roomZoomFor(1280, 800, kitchen, none, 1), 4);
  // The canvas ratio scales it like the outdoor zoom.
  assert.equal(roomZoomFor(2560, 1600, kitchen, none, 2), 8);
  // A phone keeps its outdoor framing (the room scrolls if it must).
  assert.equal(roomZoomFor(390, 844, kitchen, none, 1), zoomFor(390, 844));
  // Never past the top zoom.
  assert.ok(roomZoomFor(4000, 3000, kitchen, none, 1) <= 5);
});
