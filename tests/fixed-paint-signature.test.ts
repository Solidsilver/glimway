// A fixed chunk's kept paint (window.ts sigOf/keptPaints) is reused only while
// every input the painter reads is the same: the world seed, and the ground
// four tiles into each neighbour (Sol's H2 review, finding 1).
import '../tests/helpers/scene-modules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson } from '@bufbuild/protobuf';
const { WildsWindow } = await import('../src/game/wilds/window.ts');
const { serveFixtureCommons } = await import('../tests/commons-fixture.ts');
const { paintSource } = await import('../src/game/wilds/fixed-ground.ts');
const { paintHere } = await import('../src/game/wilds/paint-worker.ts');
const { paintTable } = await import('../src/game/wilds/ground-table.ts');
const store = await import('../src/game/wilds/store.ts');
const { WildsNearResultSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
const { fnv1a32 } = await import('../src/lib/hash.ts');

test('fixed paint signature changes when the world seed changes its pixels', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8'));
  const near = fixtures.find((f: { case: string }) => f.case === 'valid-near').json;
  store.resetWilds({ quiet: true });
  store.applyNear(fromJson(WildsNearResultSchema, near));
  serveFixtureCommons();
  const w = Object.create(WildsWindow.prototype);
  const a = w['sigOf'](0, 2);
  const view = store.wildsView()!;
  const job = { x0: 0, y0: 768, w: 384, h: 384, look: 'outer' as const, mark: 'Carting', seed: fnv1a32(view.still.worldSeed), table: paintTable() };
  const before = paintHere(job, paintSource).rgba;
  view.still.worldSeed = 'a-different-world-seed';
  const b = w['sigOf'](0, 2);
  const after = paintHere({ ...job, seed: fnv1a32(view.still.worldSeed) }, paintSource).rgba;
  assert.notDeepEqual(before, after, 'the painter actually depends on the omitted input');
  assert.notEqual(a, b, 'keptPaints must not reuse those old pixels in another world');
});

test('a neighbouring lot clearing invalidates the town chunk whose edge pixels change', async () => {
  const { footprint, applyLotHome } = await import('../src/game/wilds/fixed.ts');
  const { lotOrigin } = await import('../src/lib/lots.ts');
  serveFixtureCommons();
  const w = Object.create(WildsWindow.prototype);
  const fp = footprint('lots-west')!;
  const worldId = fp.epoch.slice(5, fp.epoch.lastIndexOf('@'));
  const gate = 2;
  const origin = lotOrigin(gate);
  const cleared = (fp.objects.get('-2,2') ?? []).filter((o) => o.id.startsWith('land:') && o.tx - origin.tx >= 20).map((o) => [o.tx-origin.tx,o.ty-origin.ty]);
  assert.ok(cleared.length, 'fixture has obstacles within the painter context');
  const beforeSig = w['sigOf'](-1, 2);
  const job = { x0: -384, y0: 768, w: 384, h: 384, look: 'outer' as const, mark: 'Carting', seed: 1, table: paintTable() };
  const before = paintHere(job, paintSource).rgba;
  applyLotHome(gate, { worldId, cleared, stumps: [], plants: [] } as never);
  const after = paintHere(job, paintSource).rgba;
  assert.notDeepEqual(before, after, 'clearing beside the town changes the pixels on its edge');
  assert.notEqual(w['sigOf'](-1, 2), beforeSig, 'the neighbour mask alone is insufficient');
});
