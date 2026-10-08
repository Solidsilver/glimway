import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOMS as ROOM_DATA, knownRoom, roomFor, roomParent, rootArea } from '../src/lib/rooms.ts';
import { RESIDENTS, residentById } from '../src/lib/residents.ts';
import { cycleAt, cycleSpotsNear } from '../src/lib/clock.ts';
import { buildArea, hasAreaKind } from '../src/game/worlds.ts';
import { baseBox, facingFor, groupsOf, residentSpotsIn, roomArrival, wallFacing, warmAt } from '../src/game/room-kind.ts';
import { ROOM_DRESSING, canPlace, furnishing, FURNISHINGS } from '../src/lib/furnishings-stand-in.ts';
import { pieceFoot, pieceFrame } from '../src/game/area/furnishings-art.ts';
import { SEATED_MANA_BONUS, manaRegenRate } from '../src/game/seats.ts';
import { residentAt } from '../src/lib/residents.ts';
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
  // It blocks by its base (below), not its footprint's tiles.
  assert.ok(kitchen.bodies!.some((b) => b.y + b.h === (table.ty + table.th) * TILE && b.x >= table.tx * TILE && b.x + b.w <= (table.tx + table.tw) * TILE));
  // The library's four back-wall shelf units (one per section) are four props.
  assert.equal(buildArea('in:village:library').room!.props.filter((p) => p.art === 'library-shelves').length, 4);
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

test('the mill’s stairs run along its west wall; the loft’s opening is right above them; arrivals face on', () => {
  const mill = buildArea('in:village:mill');
  const loft = buildArea('in:village:mill:2');
  const up = mill.exits.find((e) => e.kind === 'stair')!;
  const down = loft.exits.find((e) => e.kind === 'stair')!;
  assert.equal(up.to, 'in:village:mill:2');
  assert.equal(down.to, 'in:village:mill');
  assert.equal(up.label, 'The sack loft');
  // Along a wall (7.0 rule 5), and the opening directly over them.
  assert.ok(up.tx === 1 || up.tx + up.tw === mill.width - 1, 'against a side wall');
  assert.deepEqual([down.tx, down.ty, down.tw, down.th], [up.tx, up.ty, up.tw, up.th], 'the loft’s opening is over the stairs');
  const inside = (e: typeof up, t: { tx: number; ty: number }) => t.tx >= e.tx && t.tx < e.tx + e.tw && t.ty >= e.ty && t.ty < e.ty + e.th;
  // Up: stepped onto from the south, you come out north of the opening, facing on (north).
  assert.equal(up.side, 'south');
  assert.equal(loft.solid[up.entry.ty][up.entry.tx], false);
  assert.ok(!inside(down, up.entry));
  assert.equal(up.entry.ty, down.ty - 1, 'just north of the opening');
  assert.deepEqual(facingFor({ side: up.side!, kind: up.kind }), { x: 0, y: -1 });
  // Down: stepped onto from the north, you come out south of the stairs, facing on (south).
  assert.equal(down.side, 'north');
  assert.equal(mill.solid[down.entry.ty][down.entry.tx], false);
  assert.ok(!inside(up, down.entry));
  assert.equal(down.entry.ty, up.ty + up.th, 'just south of the stairs');
  assert.deepEqual(facingFor({ side: down.side!, kind: down.kind }), { x: 0, y: 1 });
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
  // Finn going up to the loft: onto the stairs from their foot (their `side`).
  assert.deepEqual(doorFor('finn', 'in:village:mill', 'in:village:mill:2'), { step: { tx: 1, ty: 6 }, door: { tx: 1, ty: 5 } });
  // ...and from the loft out to his door: down through the opening, from its north side.
  assert.deepEqual(doorFor('finn', 'in:village:mill:2', 'village'), { step: { tx: 1, ty: 3 }, door: { tx: 1, ty: 4 } });
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
  // A phone shows the whole room, all four walls, in what the interface leaves open
  // (zoomed out a little from its outdoor 2×: 14 tiles are 448 px at 2×).
  for (const [w, h, insets] of [[390, 844, none], [390, 844, { top: 150, right: 0, bottom: 170, left: 0 }], [844, 390, { top: 0, right: 120, bottom: 0, left: 0 }], [360, 640, none]] as const) {
    for (const room of ROOMS.map((d) => buildArea(d.id))) {
      const z = roomZoomFor(w, h, room, insets, 1);
      assert.ok(z * room.widthPx <= w - insets.left - insets.right, `${room.areaId} fits ${w}×${h} across (${z})`);
      assert.ok(z * room.heightPx <= h - insets.top - insets.bottom, `${room.areaId} fits ${w}×${h} down (${z})`);
    }
  }
  assert.equal(roomZoomFor(390, 844, kitchen, none, 1), 1.5);
  // Never past the top zoom.
  assert.ok(roomZoomFor(4000, 3000, kitchen, none, 1) <= 5);
});

// ------------------------------------------------------------ the hearth

test('standing at the kitchen’s hearth warms you like a seat: the seated mana bonus, no seat, no HP', () => {
  const kitchen = buildArea('in:village:bakery');
  const spot = kitchen.room!.def.spots['kitchen-hearth']!;
  // On the apron in front of it, where the action button reaches.
  assert.ok(warmAt(kitchen, (spot.tx + 0.5) * TILE, (spot.ty + 1.5) * TILE));
  // Across the room, or out in the village: no.
  assert.ok(!warmAt(kitchen, 2 * TILE, 8 * TILE));
  assert.ok(!warmAt(buildArea('village'), 7 * TILE, 3 * TILE));
  const plain = manaRegenRate({ seated: false, warm: false, rest: 0 });
  assert.equal(manaRegenRate({ seated: false, warm: true, rest: 0 }), plain + SEATED_MANA_BONUS);
  assert.equal(manaRegenRate({ seated: false, warm: true, rest: 0 }), manaRegenRate({ seated: true, warm: false, rest: 0 }), 'the same as sitting');
  assert.equal(manaRegenRate({ seated: true, warm: true, rest: 0 }), plain + SEATED_MANA_BONUS, 'never twice');
});

test('residentPlace is the shared loader’s place, with the phase’s spot and end', () => {
  for (const id of ['hazel', 'finn', 'ada']) for (const m of [0, 21, 44, 50, 59]) {
    const p = residentPlace(id, at(m))!;
    assert.deepEqual({ area: p.area, tx: p.tx, ty: p.ty }, residentAt(id, at(m)));
  }
  assert.equal(residentPlace('nobody', at(0)), null);
});

// ------------------------------------------------------------ furnishings: bases, dressing, drawing

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The hero's foot box (px; the body that collides). */
const HERO = { w: 10, h: 4 };

test('pieces block by their base, never their picture: their footprints are open floor, and you walk behind tall ones', () => {
  for (const def of ROOMS) {
    const w = buildArea(def.id);
    const bodies = w.bodies ?? [];
    const solidTile = (b: Box) => {
      for (let y = Math.floor(b.y / TILE); y <= Math.floor((b.y + b.h - 0.01) / TILE); y++)
        for (let x = Math.floor(b.x / TILE); x <= Math.floor((b.x + b.w - 0.01) / TILE); x++) if (w.solid[y]?.[x] !== false) return true;
      return false;
    };
    const solidProps = w.room!.props.filter((p) => p.solid);
    assert.equal(bodies.length, solidProps.length, `${def.id}: one body per piece; the dressing never blocks`);
    for (const f of solidProps) {
      const base = baseBox(f);
      // The base lies inside the footprint, on its bottom edge.
      assert.ok(base.x >= f.tx * TILE && base.x + base.w <= (f.tx + f.tw) * TILE, `${def.id} ${f.art}: base within the footprint across`);
      assert.equal(base.y + base.h, (f.ty + f.th) * TILE, `${def.id} ${f.art}: base on the footprint's bottom edge`);
      // Footprint tiles below the back wall aren't solid tiles: only the base blocks.
      for (let y = Math.max(2, f.ty); y < f.ty + f.th; y++) for (let x = f.tx; x < f.tx + f.tw; x++) assert.equal(w.solid[y][x], false, `${def.id} ${f.art}: ${x},${y} is open`);
      // Right up to its sides: the hero's feet beside the base touch nothing of it.
      for (const x of [base.x - HERO.w, base.x + base.w]) assert.ok(!overlaps({ x, y: base.y + base.h - HERO.h, ...HERO }, base));
      // Behind a tall piece (its footprint rises above its base, onto floor): free to stand there.
      const behind = { x: base.x + base.w / 2 - HERO.w / 2, y: base.y - HERO.h - 0.5, ...HERO };
      if (behind.y >= 2 * TILE && behind.y >= f.ty * TILE) {
        assert.ok(!bodies.some((b) => overlaps(behind, b)) && !solidTile(behind), `${def.id} ${f.art}: you can stand behind it`);
      }
    }
  }
  // The millstones: a 2×2 footprint, but you can walk up into its back row.
  const mill = buildArea('in:village:mill');
  const stones = mill.room!.props.find((p) => p.art === 'millstones')!;
  assert.ok(baseBox(stones).h < stones.th * TILE);
});

test('the dressing: kit pieces by id, each where 2.8’s rule lets it go, on open ground or the back wall', () => {
  for (const def of ROOMS) {
    const list = ROOM_DRESSING[def.id] ?? [];
    const propChars = new Set(def.props.map((p) => p.char));
    list.forEach((p, i) => {
      const piece = furnishing(p.piece);
      assert.ok(piece, `${def.id}: ${p.piece} is in the catalogue`);
      if (p.parent !== undefined) {
        assert.ok(p.parent < i, `${def.id}: ${p.piece} comes after the piece it stands on`);
        const parent = furnishing(list[p.parent]!.piece)!;
        assert.ok(canPlace(piece!, parent), `${def.id}: ${p.piece} may stand on ${parent.id}`);
        return;
      }
      const [tw, th] = piece!.footprint;
      for (let y = p.ty; y < p.ty + th; y++)
        for (let x = p.tx; x < p.tx + tw; x++) {
          const c = def.map[y]![x]!;
          if (piece!.mount === 'wall') assert.ok(y === 1 && (c === '=' || c === 'w'), `${def.id}: ${p.piece} hangs on the back wall (${x},${y} "${c}")`);
          else assert.ok('.:@'.includes(c) && !propChars.has(c), `${def.id}: ${p.piece} stands on open floor (${x},${y} "${c}")`);
        }
      assert.ok(canPlace(piece!, piece!.mount === 'wall' ? 'wall' : 'floor'));
    });
  }
  // The rule's table: small on any surface, medium on a big enough top, large only on the floor, rugs and wall pieces in their places.
  const table = furnishing('small-table')!;
  assert.ok(canPlace(furnishing('candle')!, table));
  assert.ok(canPlace(furnishing('lamp')!, table));
  assert.ok(!canPlace(furnishing('lamp')!, furnishing('crate')!), 'a crate’s top is one slot: too small for a lamp');
  assert.ok(!canPlace(furnishing('chest')!, table));
  assert.ok(!canPlace(furnishing('rug-rag')!, table));
  assert.ok(!canPlace(furnishing('picture')!, 'floor') && canPlace(furnishing('picture')!, 'wall'));
  // Every catalogue piece's base fits its footprint.
  for (const piece of FURNISHINGS) assert.ok(piece.base[0] <= piece.footprint[0] * TILE && piece.base[1] <= piece.footprint[1] * TILE, piece.id);
});

test('drawing furnishings: a piece on another stands on its surface, in its slot, just in front; side-on art mirrors', () => {
  const table = furnishing('small-table')!;
  const drawnTable = { piece: table, foot: { x: 104, y: 80 }, depth: 80, facing: 'front' as const, state: null, sprite: null as never };
  const left = pieceFoot(furnishing('candle')!, { tx: 0, ty: 0, parent: drawnTable, slot: 0 });
  const right = pieceFoot(furnishing('candle')!, { tx: 0, ty: 0, parent: drawnTable, slot: 1 });
  assert.equal(left.y, 80 - table.offers!.top!.height, 'on the top');
  assert.ok(left.x < 104 && right.x > 104, 'two slots, left and right of the middle');
  assert.ok(left.depth > 80 && left.depth < 81, 'just in front of the table');
  // A rug lies under everything; a wall piece hangs on the back wall.
  assert.ok(pieceFoot(furnishing('rug-rag')!, { tx: 5, ty: 6 }).depth < 0);
  assert.equal(pieceFoot(furnishing('picture')!, { tx: 3, ty: 1 }).y, 2 * TILE - 3);
  // Facing: the art for it, the other side mirrored, else the front.
  const sideOn = { ...table, art: { front: 'f', left: 'l' } };
  assert.deepEqual(pieceFrame(sideOn, 'left', null, 0), { frame: 'l', flipX: false });
  assert.deepEqual(pieceFrame(sideOn, 'right', null, 0), { frame: 'l', flipX: true });
  assert.deepEqual(pieceFrame(sideOn, 'diag', null, 0), { frame: 'f', flipX: false });
  // A state picks its frames; with none asked, the default state's.
  const oven = furnishing('kitchen-hearth')!;
  assert.equal(pieceFrame(oven, 'front', 'banked', 0).frame, 'oven-hearth-fire-0');
});

test('the library as revised: shelves on the back and both side walls (side-on), a section each, the nook a seat, no donation shelf', () => {
  const lib = buildArea('in:village:library');
  const sides = lib.room!.props.filter((p) => p.art === 'library-side-shelves');
  assert.deepEqual(sides.map((f) => wallFacing(lib, f)).sort(), ['left', 'right'], 'each faces into the room');
  assert.equal(lib.room!.props.filter((p) => p.art === 'library-shelves').length, 4, 'four back-wall units, one per section');
  assert.ok(!lib.room!.props.some((p) => p.art === 'donation-shelf' || p.art === 'window-seat'));
  const spots = Object.keys(lib.room!.def.spots);
  for (const id of ['library-shelf', 'shelf-histories', 'shelf-recipes', 'shelf-field-notes', 'reading-table', 'reading-lamp', 'reading-nook']) assert.ok(spots.includes(id), id);
  // The nook sits in its corner alcove against the east wall.
  const nook = lib.room!.props.find((p) => p.art === 'reading-nook')!;
  assert.equal(nook.tx + nook.tw, lib.width - 1);
  assert.ok(furnishing('reading-nook')!.tags!.includes('seat'));
  // Back-wall pieces face front.
  for (const f of lib.room!.props.filter((p) => p.art === 'library-shelves')) assert.equal(wallFacing(lib, f), 'front');
});
