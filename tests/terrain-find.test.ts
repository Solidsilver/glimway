import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureLabel, nearestFeatures, type TerrainFeature } from '../src/game/terrain/find.ts'
import { HEIGHT_BATCH, HEIGHT_CACHE, HeightMap, heightChunks, heightColour, type HeightChunk } from '../src/game/terrain/map.ts'

const feature: TerrainFeature = { kind: 'pass', target: [240, -240], stand: [240, -239], level: 6, owner: [0, -1] }
test('terrain destinations describe target distance and direction and the stand height', () => {
  assert.equal(featureLabel(feature, 0, 0), 'Pass, 14 chunks NE, level 6.0')
  assert.match(featureLabel({ ...feature, kind: 'spire', target: [-24, 0] }, 0, 0), /^Spire view, 1 chunks W/)
  assert.match(featureLabel({ ...feature, target: [0, 24] }, 0, 0), /chunks S/)
})

test('feature requests use live world tiles and handle an unavailable dev server', async () => {
  let url = '', credentials = ''
  const fetcher: typeof fetch = async (input, init) => {
    url = String(input); credentials = String(init?.credentials)
    return Response.json({ recipe: 'slopes-gen@2', owners: 9, features: [feature] })
  }
  const got = await nearestFeatures(-0.1, 30.9, undefined, fetcher)
  assert.equal(url, '/api/dev/terrain/features?x=-1&y=30')
  assert.equal(credentials, 'same-origin')
  assert.deepEqual(got.features, [feature])
  await assert.rejects(nearestFeatures(0, 0, undefined, async () => new Response('', { status: 404 })), /404/)
})

function chunk(cx: number, cy: number): HeightChunk {
  return { cx, cy, height: Array(36).fill(256), kind: Array(36).fill(0), dx: Array(36).fill(20), dy: Array(36).fill(-20) }
}

test('height map covers negative coordinates and stays bounded at extreme zooms', () => {
  const near = heightChunks({ cx: -1, cy: -1, scale: 3 }, { w: 1200, h: 700 })
  assert(near.some(([x, y]) => x === -1 && y === -1))
  assert(near.length > 100 && near.length < HEIGHT_CACHE)
  const wide = heightChunks({ cx: 0, cy: 0, scale: 0.00001 }, { w: 2000, h: 1500 })
  assert.equal(wide.length, HEIGHT_CACHE)
})

test('height reads are coarse, bounded, reused, and cancellation cannot install stale results', async () => {
  const map = new HeightMap()
  const wanted: [number, number][] = Array.from({ length: 600 }, (_, n) => [n, -1])
  const batches: number[] = []
  const controller = new AbortController()
  let changes = 0
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.credentials, 'same-origin')
    const q = new URL(String(input), 'http://localhost').searchParams.getAll('c')
    batches.push(q.length)
    const chunks = q.map((v) => { const [x, y] = v.split(',').map(Number); return chunk(x!, y!) })
    return Response.json({ recipe: 'slopes-gen@2', step: 4, chunks, marks: [{ kind: 'pass', x: 288, y: 288 }] })
  }
  await map.load(wanted, controller.signal, () => changes++, fetcher)
  assert.equal(map.chunks.size, 600)
  assert.equal(changes, 3)
  assert(batches.every((n) => n <= HEIGHT_BATCH))
  await map.load(wanted, controller.signal, () => changes++, fetcher)
  assert.equal(batches.length, 3)
  const stale = new HeightMap()
  await stale.load([[0, 0]], controller.signal, () => assert.fail('stale draw'), async () => {
    controller.abort()
    return Response.json({ chunks: [chunk(0, 0)], marks: [] })
  })
  assert.equal(stale.chunks.size, 0)
})

test('height tint shows levels, facing, crags and cliffs distinctly', () => {
  assert.notEqual(heightColour(256, 0, 0, 0), heightColour(12 * 256, 0, 0, 0))
  assert.notEqual(heightColour(256, 0, 64, 0), heightColour(256, 0, -64, 0))
  assert.notEqual(heightColour(256, 2, 0, 0), heightColour(256, 3, 0, 0))
})
