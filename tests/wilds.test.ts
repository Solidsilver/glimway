import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Rng,
  buildExits,
  chunkEntities,
  chunkSeed,
  chunkTerrain,
  fnv1a32,
  genV1,
  generatorFor,
  hash,
  loadWilds,
  lootSeed,
  rollLoot,
  toWorldData,
  validateWildsData,
  type ChunkExit,
  type ChunkTerrain,
  type Epoch,
  type Tile,
  type WildsEntity,
} from '../src/lib/wilds/index.ts';
import { TERRAIN } from '../src/game/textures.ts';
import wildsJson from '../content/wilds.json' with { type: 'json' };

const SEEDS = ['oak-7', '灰烬之路', 'ember:glade', 'plain'];
const SEASONS = ['spring', 'summer', 'winter'];

function epochs(): Epoch[] {
  const out: Epoch[] = [];
  for (const worldSeed of SEEDS) for (const season of SEASONS) out.push({ worldSeed, regionId: 'inner-1', generatorVersion: 1, season });
  return out;
}

const tileKey = (t: Tile) => `${t.tx},${t.ty}`;

function inAnyExit(exits: readonly ChunkExit[], t: Tile): boolean {
  return exits.some((e) => t.tx >= e.tx && t.tx < e.tx + e.tw && t.ty >= e.ty && t.ty < e.ty + e.th);
}

/** Movement blockers: terrain solids plus every decoration with a body. */
function blockedTiles(w: ChunkTerrain): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.solid[y][x]) out.add(`${x},${y}`);
  for (const s of [...w.trees, ...w.bushes, ...w.rocks]) out.add(tileKey(s));
  return out;
}

function reachable(w: ChunkTerrain, from: Tile): Set<string> {
  const blocked = blockedTiles(w);
  const seen = new Set<string>([tileKey(from)]);
  const queue: Tile[] = [from];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { tx: t.tx + dx, ty: t.ty + dy };
      if (n.tx < 0 || n.ty < 0 || n.tx >= w.width || n.ty >= w.height) continue;
      const k = tileKey(n);
      if (seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}

// ---------------------------------------------------------------- data

test('shared wilds data loads with the complete typed shape', () => {
  const d = loadWilds();
  assert.equal(d.generatorVersion, 1);
  assert.ok(d.chunkSize >= 16 && d.chunkSize % 2 === 0);
  assert.deepEqual(d.regions.map((r) => r.id), ['inner-1']);
  assert.equal(d.regions[0].kind, 'inner');
  assert.deepEqual(d.entityKinds.map((k) => k.kind), ['camp', 'node', 'chest', 'poi']);
  assert.deepEqual(d.materials, ['timber', 'stone', 'fiber', 'amber']);
  assert.deepEqual(d.enemyKinds, ['wisp', 'beetle']);
  for (const mix of d.campMixes) assert.ok(d.enemyKinds.includes(mix[0]));
  for (const n of [d.trinketChancePermille, d.timers.campRespawnSeconds, d.timers.nodeRegrowSeconds, ...d.entityKinds.flatMap((k) => [k.min, k.max])]) {
    assert.ok(Number.isSafeInteger(n) && n >= 0);
  }
  assert.ok(d.timers.campRespawnSeconds > 0 && d.timers.nodeRegrowSeconds > 0);
  assert.doesNotThrow(() => validateWildsData(wildsJson));
});

// ---------------------------------------------------------------- hash spec

test('hash and PRNG golden values lock the cross-language spec', () => {
  assert.equal(fnv1a32(''), 2166136261);
  assert.equal(fnv1a32('a'), 3826002220);
  assert.equal(fnv1a32('灰烬'), 1086804951);
  assert.equal(fnv1a32('The quick brown fox'), 2924308450);
  assert.equal(hash(['oak-7', 'inner-1', 1, 'spring', 0, 0]), 2595774026);
  assert.equal(hash(['oak-7', 'inner-1', 1, 'spring', -1, -2]), 2607182495);
  assert.equal(chunkSeed({ worldSeed: 'oak-7', regionId: 'inner-1', generatorVersion: 1, season: 'spring' }, 1, 1), 3659775552);
  assert.equal(lootSeed({ worldSeed: 'oak-7', regionId: 'inner-1', generatorVersion: 1, season: 'spring' }, 'camp:1:1:0', 3), 2481498229);
  const r = new Rng(0);
  assert.deepEqual([r.next(), r.next(), r.next()], [1144304738, 1416247, 958946056]);
  const r2 = new Rng(2166136261);
  assert.equal(r2.next(), 2625274932);
  assert.equal(r2.nextInt(1000), 693);
  assert.equal(r2.nextInt(3), 0);
  const r3 = new Rng(123456789);
  assert.deepEqual([r3.next(), r3.next(), r3.nextInt(10), r3.nextInt(24)], [1107202814, 4169434471, 8, 16]);
});

// ---------------------------------------------------------------- determinism

test('same input produces identical output, season and version change it', () => {
  const epoch = { worldSeed: 'oak-7', regionId: 'inner-1', generatorVersion: 1, season: 'spring' };
  for (const [cx, cy] of [[0, 0], [1, 1], [2, 2]]) {
    assert.deepEqual(chunkEntities(epoch, cx, cy), chunkEntities(epoch, cx, cy), `entities ${cx},${cy} not deterministic`);
    assert.deepEqual(chunkTerrain(epoch, cx, cy), chunkTerrain(epoch, cx, cy), `terrain ${cx},${cy} not deterministic`);
    const id = chunkEntities(epoch, cx, cy)[0].id;
    assert.deepEqual(rollLoot(epoch, id, 2), rollLoot(epoch, id, 2), `loot ${id} not deterministic`);
  }
  for (const season of ['summer', 'winter']) {
    const other = { ...epoch, season };
    const differs = [[0, 0], [1, 1], [2, 0]].some(([cx, cy]) => JSON.stringify(chunkEntities(epoch, cx, cy)) !== JSON.stringify(chunkEntities(other, cx, cy)));
    assert.ok(differs, `season ${season} produced the same entities as spring`);
  }
  const v7 = { ...epoch, generatorVersion: 7 };
  const versionDiffers = [[0, 0], [1, 1], [2, 0]].some(([cx, cy]) => JSON.stringify(genV1.chunkEntities(epoch, cx, cy)) !== JSON.stringify(genV1.chunkEntities(v7, cx, cy)));
  assert.ok(versionDiffers, 'generatorVersion is not part of the chunk seed');
  assert.throws(() => generatorFor(2), /unknown generator version/);
  assert.throws(() => chunkEntities({ ...epoch, regionId: 'nope' }, 0, 0), /unknown region/);
});

test('entity ids are stable, well-formed and unique per chunk', () => {
  for (const epoch of epochs()) {
    for (let cy = 0; cy < 3; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        const entities = chunkEntities(epoch, cx, cy);
        const seen = new Set<string>();
        const perKind: Record<string, number> = {};
        for (const e of entities) {
          assert.ok(!seen.has(e.id), `duplicate id ${e.id}`);
          seen.add(e.id);
          const index = perKind[e.kind] ?? 0;
          perKind[e.kind] = index + 1;
          assert.equal(e.id, `${e.kind}:${cx}:${cy}:${index}`);
          if (e.kind === 'camp') {
            assert.ok(e.enemies.length > 0 && e.enemies.every((x) => loadWilds().enemyKinds.includes(x)));
            assert.equal(e.material + e.poi, '');
            assert.equal(e.tier, 0);
          } else if (e.kind === 'node') {
            assert.ok(loadWilds().materials.includes(e.material));
            assert.deepEqual(e.enemies, []);
            assert.equal(e.tier + (e.poi ? 1 : 0), 0);
          } else if (e.kind === 'chest') {
            assert.ok(e.tier >= 1 && e.tier <= 3);
            assert.deepEqual(e.enemies, []);
            assert.equal(e.material + e.poi, '');
          } else {
            assert.ok(loadWilds().poiIds.includes(e.poi));
            assert.deepEqual(e.enemies, []);
            assert.equal(e.material, '');
            assert.equal(e.tier, 0);
          }
        }
        assert.ok(entities.length >= 1);
      }
    }
  }
});

// ---------------------------------------------------------------- terrain

test('every chunk keeps entities and exits walkable and reachable', () => {
  for (const epoch of epochs()) {
    for (let cy = 0; cy < 3; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        const where = `${epoch.worldSeed}/${epoch.season} chunk ${cx},${cy}`;
        const w = chunkTerrain(epoch, cx, cy);
        const entities = chunkEntities(epoch, cx, cy);
        const blocked = blockedTiles(w);
        assert.ok(!blocked.has(tileKey(w.spawn)), `${where}: spawn blocked`);
        assert.ok(!inAnyExit(w.exits, w.spawn), `${where}: spawn sits in an exit`);
        const reach = reachable(w, w.spawn);
        for (const e of w.exits) {
          for (let y = e.ty; y < e.ty + e.th; y++) {
            for (let x = e.tx; x < e.tx + e.tw; x++) {
              const k = `${x},${y}`;
              assert.ok(!blocked.has(k), `${where}: exit to ${e.to} blocked at ${k}`);
              assert.ok(reach.has(k), `${where}: exit to ${e.to} unreachable at ${k}`);
            }
          }
        }
        for (const en of entities) {
          const k = tileKey(en);
          assert.ok(!blocked.has(k), `${where}: entity ${en.id} on a blocked tile`);
          assert.ok(!inAnyExit(w.exits, en), `${where}: entity ${en.id} sits in an exit`);
          assert.ok(reach.has(k), `${where}: entity ${en.id} unreachable`);
        }
      }
    }
  }
});

test('terrain never opens the border except at exits', () => {
  for (const epoch of epochs()) {
    for (let cy = 0; cy < 3; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        const where = `${epoch.worldSeed}/${epoch.season} chunk ${cx},${cy}`;
        const w = chunkTerrain(epoch, cx, cy);
        const blocked = blockedTiles(w);
        const gaps: string[] = [];
        for (let x = 0; x < w.width; x++) {
          for (const y of [0, w.height - 1]) {
            const t = { tx: x, ty: y };
            if (!blocked.has(tileKey(t)) && !inAnyExit(w.exits, t)) gaps.push(tileKey(t));
          }
        }
        for (let y = 0; y < w.height; y++) {
          for (const x of [0, w.width - 1]) {
            const t = { tx: x, ty: y };
            if (!blocked.has(tileKey(t)) && !inAnyExit(w.exits, t)) gaps.push(tileKey(t));
          }
        }
        assert.deepEqual(gaps, [], `${where}: open border tiles ${gaps.join(' ')}`);
      }
    }
  }
});

test('chunk exits mirror their neighbors and land beside the way back', () => {
  const epoch: Epoch = { worldSeed: 'oak-7', regionId: 'inner-1', generatorVersion: 1, season: 'spring' };
  const region = loadWilds().regions[0];
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      const w = chunkTerrain(epoch, cx, cy);
      const dirs = w.exits.map((e) => e.dir).sort();
      const expect: string[] = [];
      if (cy > 0) expect.push('north');
      if (cx < region.gridWidth - 1) expect.push('east');
      if (cy < region.gridHeight - 1) expect.push('south');
      if (cx > 0) expect.push('west');
      const isEntry = cx === region.entryX && cy === region.entryY;
      if (isEntry) expect.push('south');
      assert.deepEqual(dirs, expect.sort(), `chunk ${cx},${cy} exit set`);
      assert.equal(w.exits.some((e) => e.to === 'commons'), isEntry, `chunk ${cx},${cy} commons exit`);
      for (const e of w.exits) {
        if (e.to === 'commons') continue;
        assert.equal(e.to, `chunk:inner-1:${e.toChunk!.cx}:${e.toChunk!.cy}`);
        const back = chunkTerrain(epoch, e.toChunk!.cx, e.toChunk!.cy);
        const mirror = back.exits.find((x) => x.to === `chunk:inner-1:${cx}:${cy}`);
        assert.ok(mirror, `chunk ${cx},${cy} → ${e.to} has no way back`);
        const opposite = { north: 'south', south: 'north', west: 'east', east: 'west' } as const;
        assert.equal(mirror.dir, opposite[e.dir], `chunk ${cx},${cy} → ${e.to} edge mismatch`);
        const S = back.width;
        const inward =
          mirror.dir === 'north' ? { tx: mirror.tx + 1, ty: 1 } :
          mirror.dir === 'south' ? { tx: mirror.tx + 1, ty: S - 2 } :
          mirror.dir === 'west' ? { tx: 1, ty: mirror.ty + 1 } :
          { tx: S - 2, ty: mirror.ty + 1 };
        assert.deepEqual(e.entry, inward, `chunk ${cx},${cy} → ${e.to}: entry is not beside the way back`);
        const blocked = blockedTiles(back);
        assert.ok(!blocked.has(tileKey(e.entry)), `${e.to}: entry ${tileKey(e.entry)} blocked`);
        assert.ok(!inAnyExit(back.exits, e.entry), `${e.to}: entry ${tileKey(e.entry)} lands in an exit`);
        assert.ok(reachable(back, e.entry).has(`${mirror.tx},${mirror.ty}`), `${e.to}: way back unreachable from entry`);
      }
    }
  }
});

test('chunkTerrain is WorldData-shaped', () => {
  const w = chunkTerrain({ worldSeed: 'oak-7', regionId: 'inner-1', generatorVersion: 1, season: 'spring' }, 1, 1);
  const world = toWorldData(w, 'village');
  assert.equal(world.width, w.width);
  assert.equal(world.height, w.height);
  assert.equal(world.widthPx, w.width * 16);
  assert.equal(world.ground.length, w.height);
  assert.equal(world.ground[0].length, w.width);
  assert.deepEqual(world.trees, w.trees);
  assert.deepEqual(world.spawn, w.spawn);
  assert.deepEqual(world.exits.map((e) => e.to), w.exits.map((e) => e.to));
  assert.deepEqual(world.npcs, []);
  assert.ok(w.exits.every((e) => e.to === 'commons' || /^chunk:inner-1:\d+:\d+$/.test(e.to)));
});

// ---------------------------------------------------------------- loot

test('loot is deterministic, cycle-scoped and stays in the tables', () => {
  const data = loadWilds();
  const epoch: Epoch = { worldSeed: '灰烬之路', regionId: 'inner-1', generatorVersion: 1, season: 'autumn' };
  let cycleChanges = 0;
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      for (const e of chunkEntities(epoch, cx, cy)) {
        const a = rollLoot(epoch, e.id, 0);
        assert.deepEqual(a, rollLoot(epoch, e.id, 0), `${e.id} loot not deterministic`);
        const b = rollLoot(epoch, e.id, 1);
        if (JSON.stringify(a) !== JSON.stringify(b)) cycleChanges++;
        const tableId =
          e.kind === 'camp' ? 'camp' :
          e.kind === 'node' ? `node:${e.material}` :
          e.kind === 'chest' ? `chest:${e.tier}` : 'poi';
        const table = data.lootTables[tableId];
        for (const drop of [a, b]) {
          for (const line of drop.materials) {
            const entry = table.find((t) => t.material === line.id)!;
            assert.ok(entry, `${e.id}: ${line.id} not in ${tableId}`);
            assert.ok(line.qty >= entry.min && line.qty <= entry.max, `${e.id}: qty ${line.qty} outside ${entry.min}..${entry.max}`);
          }
          if (drop.trinket !== null) assert.ok(data.trinkets.includes(drop.trinket));
        }
      }
    }
  }
  assert.ok(cycleChanges > 0, 'no loot roll changed across cycles');
  assert.throws(() => rollLoot(epoch, 'camp:1:1:9', 0), /unknown entity/);
  assert.throws(() => rollLoot(epoch, 'nope:1:1:0', 0), /bad entity id/);
  assert.throws(() => rollLoot(epoch, 'camp:1:1:0', -1), /cycle/);
});

test('generated kinds cover every spawn rule across the region', () => {
  const epoch: Epoch = { worldSeed: 'oak-7', regionId: 'inner-1', generatorVersion: 1, season: 'spring' };
  const kinds = new Set<string>();
  const materials = new Set<string>();
  const pois = new Set<string>();
  const tiers = new Set<number>();
  const mixes: string[] = [];
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      for (const e of chunkEntities(epoch, cx, cy)) {
        kinds.add(e.kind);
        if (e.material) materials.add(e.material);
        if (e.poi) pois.add(e.poi);
        if (e.tier) tiers.add(e.tier);
        if (e.enemies.length) mixes.push(e.enemies.join('+'));
      }
    }
  }
  assert.deepEqual([...kinds].sort(), ['camp', 'chest', 'node', 'poi']);
  assert.ok(materials.size >= 3, `only materials ${[...materials]}`);
  assert.ok(pois.size >= 2, `only pois ${[...pois]}`);
  assert.ok(tiers.size >= 2, `only tiers ${[...tiers]}`);
  assert.ok(mixes.length >= 3);
});
