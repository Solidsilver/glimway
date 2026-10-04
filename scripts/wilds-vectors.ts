/**
 * Writes content/vectors/wilds.json: expected outputs of the Wilds generator
 * functions that the Go port (server/internal/wilds) must reproduce. Compact
 * JSON (no pretty-printing) to keep the file well under 300 KB.
 *
 * Run: npm run vectors:wilds
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  chunkEntities,
  chunkSeed,
  loadWilds,
  lootSeed,
  rollLoot,
  type Epoch,
} from '../src/lib/wilds/index.ts';

const WORLD_SEEDS = ['oak-7', '灰烬之路', 'ember:glade'];
const REGION_IDS = ['inner-1', 'outer-7'];
const VERSIONS = [1, 2, 7];
const SEASONS = ['spring', 'summer', 'winter'];
const CHUNKS: [number, number][] = [[-1, -2], [0, 0], [1, 1], [2, 0], [3, 3]];

export function wildsVectors() {
  const data = loadWilds();
  const chunkSeeds = [];
  for (const worldSeed of WORLD_SEEDS) {
    for (const regionId of REGION_IDS) {
      for (const generatorVersion of VERSIONS) {
        for (const season of SEASONS) {
          for (const [cx, cy] of CHUNKS) {
            const epoch = { worldSeed, regionId, generatorVersion, season };
            chunkSeeds.push({ ...epoch, cx, cy, result: chunkSeed(epoch, cx, cy) });
          }
        }
      }
    }
  }
  const lootSeeds = [];
  for (const worldSeed of WORLD_SEEDS) {
    for (const regionId of REGION_IDS) {
      for (const generatorVersion of [1, 7]) {
        for (const season of SEASONS.slice(0, 2)) {
          for (const entityId of ['camp:3:-2:1', 'node:0:0:0', 'chest:2:2:1']) {
            for (const cycle of [0, 1, 1000]) {
              const epoch = { worldSeed, regionId, generatorVersion, season };
              lootSeeds.push({ ...epoch, entityId, cycle, result: lootSeed(epoch, entityId, cycle) });
            }
          }
        }
      }
    }
  }
  const grid = data.regions.find((r) => r.id === 'inner-1')!;
  const entityEpochs: Epoch[] = [];
  for (const worldSeed of WORLD_SEEDS.slice(0, 2)) {
    for (const season of SEASONS.slice(0, 2)) {
      entityEpochs.push({ worldSeed, regionId: 'inner-1', generatorVersion: 1, season });
    }
  }
  const entities = entityEpochs.map((epoch) => ({
    epoch,
    chunks: Array.from({ length: grid.gridWidth * grid.gridHeight }, (_, i) => {
      const cx = i % grid.gridWidth;
      const cy = Math.floor(i / grid.gridWidth);
      return { cx, cy, entities: chunkEntities(epoch, cx, cy) };
    }),
  }));
  const loot = [];
  for (const epoch of entityEpochs.slice(0, 2)) {
    for (let i = 0; i < grid.gridWidth * grid.gridHeight; i++) {
      const cx = i % grid.gridWidth;
      const cy = Math.floor(i / grid.gridWidth);
      const chunk = chunkEntities(epoch, cx, cy).slice(0, 3);
      for (const entity of chunk) {
        for (const cycle of [0, 1, 3]) {
          loot.push({ epoch, entityId: entity.id, cycle, drop: rollLoot(epoch, entity.id, cycle) });
        }
      }
    }
  }
  return { chunkSeeds, lootSeeds, entities, loot };
}

export const serializeWildsVectors = () => JSON.stringify(wildsVectors()) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../content/vectors/wilds.json', import.meta.url), serializeWildsVectors());
  console.log('Wrote content/vectors/wilds.json');
}
