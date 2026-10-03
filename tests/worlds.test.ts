import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArea, type ExitDef, type WorldData } from '../src/game/worlds.ts';
import { AREAS, type AreaId } from '../src/lib/state.ts';

/**
 * Map-layout rules the runtime relies on. These catch the class of bug where
 * a map looks fine in code review but plays wrong: an unblocked border tile
 * lets the hero walk off the map, an exit that comes back on the "wrong" side
 * disorients the player, or a quest target ends up walled in.
 */

type Tile = { tx: number; ty: number };
type Edge = 'west' | 'east' | 'north' | 'south';

const worlds = Object.fromEntries(AREAS.map((a) => [a, buildArea(a)])) as Record<AreaId, WorldData>;

const key = (t: Tile) => `${t.tx},${t.ty}`;

function inExit(w: WorldData, t: Tile): ExitDef | undefined {
  return w.exits.find((e) => t.tx >= e.tx && t.tx < e.tx + e.tw && t.ty >= e.ty && t.ty < e.ty + e.th);
}

function edgeOf(w: WorldData, e: ExitDef): Edge {
  if (e.tx === 0) return 'west';
  if (e.tx + e.tw === w.width) return 'east';
  if (e.ty === 0) return 'north';
  if (e.ty + e.th === w.height) return 'south';
  throw new Error(`${w.areaId} exit to ${e.to} is not on a map edge`);
}

function edgeNearest(w: WorldData, t: Tile): Edge {
  const d: Record<Edge, number> = { west: t.tx, east: w.width - 1 - t.tx, north: t.ty, south: w.height - 1 - t.ty };
  return (Object.keys(d) as Edge[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

const OPPOSITE: Record<Edge, Edge> = { west: 'east', east: 'west', north: 'south', south: 'north' };

/** Tiles the hero cannot stand on: terrain solids plus every collision body
 *  the scene adds (conservatively, a body anywhere in a tile blocks it). */
function blockedTiles(w: WorldData): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.solid[y][x]) out.add(key({ tx: x, ty: y }));
  const spots: Tile[] = [...w.trees, ...w.bushes, ...w.rocks, ...w.npcs, ...w.props];
  if (w.well) spots.push(w.well);
  if (w.mural) spots.push(w.mural);
  for (const s of spots) out.add(key(s));
  return out;
}

/** Flood fill from the spawn across walkable tiles. */
function reachable(w: WorldData, from: Tile): Set<string> {
  const blocked = blockedTiles(w);
  const seen = new Set<string>([key(from)]);
  const queue: Tile[] = [from];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { tx: t.tx + dx, ty: t.ty + dy };
      if (n.tx < 0 || n.ty < 0 || n.tx >= w.width || n.ty >= w.height) continue;
      const k = key(n);
      if (seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}

/** Something you walk up to: reachable if any neighbouring tile is. */
function touchable(reach: Set<string>, t: Tile): boolean {
  return [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reach.has(key({ tx: t.tx + dx, ty: t.ty + dy })));
}

for (const area of AREAS) {
  const w = worlds[area];

  test(`${area}: every border tile is blocked except the exits`, () => {
    const blocked = blockedTiles(w);
    const gaps: string[] = [];
    for (let x = 0; x < w.width; x++) {
      for (const y of [0, w.height - 1]) {
        const t = { tx: x, ty: y };
        if (!blocked.has(key(t)) && !inExit(w, t)) gaps.push(key(t));
      }
    }
    for (let y = 0; y < w.height; y++) {
      for (const x of [0, w.width - 1]) {
        const t = { tx: x, ty: y };
        if (!blocked.has(key(t)) && !inExit(w, t)) gaps.push(key(t));
      }
    }
    assert.deepEqual(gaps, [], `open border tiles (hero could leave the map): ${gaps.join(' ')}`);
  });

  test(`${area}: exit mouths are open and lead to a real area`, () => {
    const blocked = blockedTiles(w);
    for (const e of w.exits) {
      assert.ok((AREAS as readonly string[]).includes(e.to), `exit to unknown area ${e.to}`);
      assert.notEqual(e.to, area, 'exit loops back into the same area');
      for (let y = e.ty; y < e.ty + e.th; y++)
        for (let x = e.tx; x < e.tx + e.tw; x++)
          assert.ok(!blocked.has(key({ tx: x, ty: y })), `exit to ${e.to} blocked at ${x},${y}`);
    }
  });

  test(`${area}: spawn and every exit, enemy and interactable are reachable`, () => {
    const blocked = blockedTiles(w);
    assert.ok(!blocked.has(key(w.spawn)), `spawn ${key(w.spawn)} is blocked`);
    assert.ok(!inExit(w, w.spawn), 'spawn sits inside an exit');
    const reach = reachable(w, w.spawn);
    for (const e of w.exits) assert.ok(reach.has(key(e)), `exit to ${e.to} unreachable from spawn`);
    for (const en of w.enemies) assert.ok(reach.has(key(en)), `enemy ${en.id} unreachable`);
    for (const n of w.npcs) assert.ok(touchable(reach, n), `${n.id} cannot be walked up to`);
    for (const d of w.discoverySpots) assert.ok(touchable(reach, d), `${d.id} cannot be walked up to`);
    for (const [name, spot] of [['mural', w.mural], ['shrine', w.shrine], ['lantern', w.villageLantern]] as const)
      if (spot) assert.ok(touchable(reach, spot), `${name} cannot be walked up to`);
  });
}

test('every exit has a way back, and you arrive beside it', () => {
  for (const area of AREAS) {
    for (const e of worlds[area].exits) {
      const dest = worlds[e.to];
      const back = dest.exits.find((x) => x.to === area);
      if (!back) assert.fail(`${e.to} has no exit back to ${area}`);
      const blocked = blockedTiles(dest);
      assert.ok(!blocked.has(key(e.entry)), `${area}→${e.to} entry ${key(e.entry)} is blocked`);
      assert.ok(!inExit(dest, e.entry), `${area}→${e.to} entry lands inside an exit (instant bounce)`);
      const dist = Math.abs(e.entry.tx - back.tx) + Math.abs(e.entry.ty - (back.ty + 1));
      assert.ok(dist <= 6, `${area}→${e.to} entry is ${dist} tiles from the way back`);
      assert.ok(reachable(dest, e.entry).has(key(back)), `${area}→${e.to}: way back unreachable from the entry`);
    }
  }
});

test('leaving through an edge brings you in from the opposite edge', () => {
  for (const area of AREAS) {
    const w = worlds[area];
    for (const e of w.exits) {
      const out = edgeOf(w, e);
      const arrive = edgeNearest(worlds[e.to], e.entry);
      assert.equal(arrive, OPPOSITE[out], `${area} exits ${out} to ${e.to}, but you arrive on its ${arrive} side`);
    }
  }
});

test('the journey reads in one direction: village → woodland → ruin', () => {
  const edgeTo = (from: AreaId, to: AreaId) => edgeOf(worlds[from], worlds[from].exits.find((e) => e.to === to)!);
  assert.equal(edgeTo('village', 'woodland'), 'east');
  assert.equal(edgeTo('woodland', 'ruin'), 'east');
  assert.equal(edgeTo('woodland', 'village'), 'west');
  assert.equal(edgeTo('ruin', 'woodland'), 'west');
});
