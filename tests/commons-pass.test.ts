import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  COMMONS_ART_PREFIX,
  COMMONS_PASS_BASE,
  COMMONS_PASS_MANIFEST_KEY,
  COMMONS_RESIDENT_PORTRAITS,
  artKey,
  createCommonsPass,
  fitRect,
  preloadCommonsPass,
  type CommonsPassManifest,
} from '../src/game/commons-pass.ts'
import { COMMONS_PLACEHOLDER_FRAMES, PROP_DECORATIONS, decorationLayout, floorTileOrientation } from '../src/game/commons-pass-install.ts'
import { COMMONS_DECORATION_IDS } from '../src/game/atlas-plan.ts'
import { pathEdgeOverlays } from '../src/game/area/terrain.ts'
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts'
import { TERRAIN } from '../src/lib/tile.ts'

const PUBLIC_DIR = fileURLToPath(new URL('../public/assets/fingersnap/commons-pass/', import.meta.url))
const SOURCE_DIR = fileURLToPath(new URL('../assets/generated/commons-pass/', import.meta.url))

const manifest = JSON.parse(readFileSync(`${PUBLIC_DIR}manifest.json`, 'utf8')) as CommonsPassManifest
const frameByKey = new Map(manifest.frames.map((f) => [f.key, f]))

const EXPECTED_ANIMATIONS: Record<string, { frames: string[]; frameRate: number }> = {
  'silas-breathing': { frames: ['silas-idle-0', 'silas-idle-1'], frameRate: 1.5 },
  'elara-breathing': { frames: ['elara-idle-0', 'elara-idle-1'], frameRate: 1.5 },
  'finn-breathing': { frames: ['finn-idle-0', 'finn-idle-1'], frameRate: 1.5 },
  'hazel-breathing': { frames: ['hazel-idle-0', 'hazel-idle-1'], frameRate: 1.5 },
  'ada-breathing': { frames: ['ada-idle-0', 'ada-idle-1'], frameRate: 1.5 },
  'hearth-fire-animation': { frames: ['hearth-fire-0', 'hearth-fire-1', 'hearth-fire-2', 'hearth-fire-3'], frameRate: 6 },
  'camp-flame-animation': { frames: ['camp-flame-0', 'camp-flame-1', 'camp-flame-2'], frameRate: 6 },
  'campsite-animation': { frames: ['campsite-0', 'campsite-1', 'campsite-2'], frameRate: 5 },
  'paper-folded-animation': { frames: ['paper-folded-0', 'paper-folded-1', 'paper-folded-2'], frameRate: 2 },
  'paper-scroll-animation': { frames: ['paper-scroll-0', 'paper-scroll-1', 'paper-scroll-2'], frameRate: 2 },
  'paper-slate-animation': { frames: ['paper-slate-0', 'paper-slate-1', 'paper-slate-2'], frameRate: 2 },
}

function pngHeader(path: string): { width: number; height: number; colorType: number } {
  const data = readFileSync(path)
  assert.equal(data.subarray(0, 8).toString('binary'), '\x89PNG\r\n\x1a\n', `${path} is not a PNG`)
  assert.equal(data.subarray(12, 16).toString('binary'), 'IHDR', 'missing IHDR')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colorType: data.readUInt8(25) }
}

test('commons-pass exposes its loader and load keys', () => {
  assert.equal(typeof preloadCommonsPass, 'function')
  assert.equal(typeof createCommonsPass, 'function')
  assert.equal(COMMONS_PASS_MANIFEST_KEY, 'glimway-commons-pass')
  assert.equal(COMMONS_PASS_BASE, '/assets/fingersnap/commons-pass/')
  assert.equal(manifest.baseUrl, COMMONS_PASS_BASE)
  assert.equal(artKey('cottage'), `${COMMONS_ART_PREFIX}cottage`)
  assert.equal(manifest.specSource, 'docs/art-requests.md')
  assert.deepEqual(manifest.pendingSheets, [])
})

test('the manifest’s 21 source sheets are delivered as transparent RGBA PNGs of the stated size', () => {
  assert.equal(manifest.sources.length, 21)
  for (const s of manifest.sources) {
    const h = pngHeader(`${SOURCE_DIR}${s.file}`)
    assert.deepEqual([h.width, h.height], [s.width, s.height], s.file)
    assert.equal(h.colorType, 6, `${s.file} is RGBA`)
  }
})

test('every frame has a measured source rect inside its sheet and a destination inside its native canvas', () => {
  assert.equal(manifest.frames.length, 173)
  assert.equal(frameByKey.size, manifest.frames.length, 'frame keys are unique')
  const sources = new Map(manifest.sources.map((s) => [s.key, s]))
  const rects = new Set<string>()
  for (const f of manifest.frames) {
    const src = sources.get(f.source)!
    assert.ok(src, `${f.key}: unknown source ${f.source}`)
    const s = f.sourceRect
    assert.ok(s.x >= 0 && s.y >= 0 && s.w > 0 && s.h > 0 && s.x + s.w <= src.width && s.y + s.h <= src.height, `${f.key}: sourceRect inside ${src.file}`)
    const d = f.destinationRect
    assert.ok(d.x >= 0 && d.y >= 0 && d.w > 0 && d.h > 0 && d.x + d.w <= f.width && d.y + d.h <= f.height, `${f.key}: destinationRect inside ${f.width}x${f.height}`)
    assert.ok(f.origin.every((o) => o >= 0 && o <= 1), `${f.key}: origin`)
    rects.add(`${f.source}:${s.x},${s.y}`)
  }
  // Measured per frame, not cut on a grid: no two frames share a corner.
  assert.equal(rects.size, manifest.frames.length)
})

test('standing art is foot-anchored at native sizes; portraits, icons and tiles have their slots', () => {
  for (const id of ['silas', 'elara', 'finn', 'hazel', 'ada']) {
    for (const n of [0, 1]) {
      const f = frameByKey.get(`${id}-idle-${n}`)!
      assert.deepEqual([f.width, f.height, ...f.origin], [16, 16, 0.5, 1], `${id}-idle-${n}`)
      assert.equal(f.destinationRect.y + f.destinationRect.h, 16, `${id}-idle-${n} stands on the baseline`)
      assert.equal(f.scaleGroup, 'residents')
    }
    const p = frameByKey.get(`portrait-${id}`)!
    assert.deepEqual([p.width, p.height, p.role], [64, 64, 'portrait'])
  }
  const settled = frameByKey.get('guardian-settled')!
  assert.deepEqual([settled.width, settled.height, ...settled.origin], [24, 24, 0.5, 1], 'the resting warden matches the runtime guardian slot')
  for (const f of manifest.frames) {
    if (f.key.startsWith('icon-')) assert.deepEqual([f.width, f.height], [16, 16], f.key)
    if (f.key.startsWith('path-')) assert.deepEqual([f.width, f.height, f.role], [16, 16, 'transition'], f.key)
    if (f.origin[1] === 1 && !f.key.startsWith('path-') && !f.key.startsWith('hedge-') && !f.key.startsWith('fence-')) {
      assert.equal(f.destinationRect.y + f.destinationRect.h, f.height, `${f.key} stands on its canvas base`)
    }
  }
  const floor = frameByKey.get('interior-floor')!
  assert.deepEqual([floor.width, floor.height, floor.role, ...floor.origin], [16, 16, 'tile', 0, 0])
  const wall = frameByKey.get('interior-back-wall')!
  assert.deepEqual([wall.width, wall.height], [224, 48])
  for (const k of ['cottage', 'cottage-silas', 'cottage-workshop']) {
    const f = frameByKey.get(k)!
    assert.deepEqual([f.width, f.height, f.scaleGroup], [96, 92, 'cottages'], `${k} shares the cottage slot and scale`)
  }
})

test('the 11 looping animations and the aliases name real frames', () => {
  assert.equal(manifest.animations.length, 11)
  for (const a of manifest.animations) {
    const want = EXPECTED_ANIMATIONS[a.key]
    assert.ok(want, `unexpected animation ${a.key}`)
    assert.deepEqual(a.frames, want.frames, a.key)
    assert.equal(a.frameRate, want.frameRate, a.key)
    assert.equal(a.repeat, -1, `${a.key} loops`)
    for (const f of a.frames) assert.ok(frameByKey.has(f), `${a.key}: ${f}`)
  }
  for (const [alias, f] of Object.entries(manifest.aliases) as [string, string][]) assert.ok(frameByKey.has(f), `alias ${alias} → ${f}`)
})

test('every placeholder the scenes draw has a delivered frame of a sane size', () => {
  for (const [key, f] of Object.entries(COMMONS_PLACEHOLDER_FRAMES)) assert.ok(frameByKey.has(f), `${key} → ${f}`)
  for (const it of HOMESTEAD_DATA.items.filter((i) => COMMONS_DECORATION_IDS.has(i.id))) assert.ok(frameByKey.has(it.id) || it.id in PROP_DECORATIONS, `decoration ${it.id}`)
  for (const id of ['whittled-fox', 'beeswax-candle', 'river-glass-bead', 'spare-bootlace', 'tin-whistle', 'timber', 'stone', 'fiber', 'amber', 'lamp-wick', 'oilcloth-wrap', 'wooden-peg']) {
    assert.ok(frameByKey.has(`icon-${id}`), `icon-${id}`)
  }
  for (const id of ['wave', 'nod', 'cheer', 'thanks', 'lantern']) assert.ok(frameByKey.has(`icon-emote-${id}`), `icon-emote-${id}`)
  for (const m of ['hollis', 'tam', 'bett', 'dorrit', 'joss', 'nan']) for (const v of ['solid', 'faint']) assert.ok(frameByKey.has(`echo-${m}-${v}`))
  for (const r of ['timber', 'stone', 'fiber', 'amber']) for (const v of ['available', 'depleted']) assert.ok(frameByKey.has(`resource-${r}-${v}`))
  for (const frame of Object.values(COMMONS_RESIDENT_PORTRAITS)) assert.ok(frameByKey.has(frame), frame)
})

test('decorations fill their footprints: two-tile pieces are refitted, never squeezed into one tile', () => {
  for (const it of HOMESTEAD_DATA.items.filter((i) => COMMONS_DECORATION_IDS.has(i.id))) {
    // Lantern posts come from the props atlas (the Commons lane's own posts).
    if (it.id in PROP_DECORATIONS) continue
    const f = frameByKey.get(it.id)!
    for (const quarter of [false, true]) {
      const { width, height, dest } = decorationLayout(it.id, f, it.footprint, quarter)
      const [fw, fh] = quarter ? [it.footprint[1], it.footprint[0]] : it.footprint
      assert.equal(width, fw * 16, `${it.id} width`)
      assert.ok(height >= fh * 16, `${it.id} covers its footprint`)
      assert.ok(dest.x >= 0 && dest.x + dest.w <= width && dest.y >= 0, `${it.id} inside its canvas`)
      assert.equal(dest.y + dest.h, height, `${it.id} stands on the footprint base`)
      if (!quarter && fw === 2 && fh === 1) assert.ok(dest.w >= 28, `${it.id} spans its two tiles (${dest.w}px)`)
    }
  }
  assert.deepEqual(fitRect({ w: 200, h: 100 }, 32, 32), { x: 0, y: 16, w: 32, h: 16 })
})

test('the plank floor alternates flips in a 2x2 arrangement', () => {
  assert.deepEqual(floorTileOrientation(0, 0), { flipX: false, flipY: false })
  assert.deepEqual(floorTileOrientation(1, 0), { flipX: true, flipY: false })
  assert.deepEqual(floorTileOrientation(0, 1), { flipX: false, flipY: true })
  assert.deepEqual(floorTileOrientation(3, 5), { flipX: true, flipY: true })
})

test('path edges: grass beside a path takes the overlay with material on that side', () => {
  const G = TERRAIN.grass_a
  const D = TERRAIN.dirt
  const C = TERRAIN.cobble_moss
  const world = {
    width: 3,
    height: 3,
    ground: [
      [D, G, G],
      [G, G, C],
      [G, G, G],
    ],
  }
  assert.deepEqual(pathEdgeOverlays(world, 1, 1), ['path-cobble-edge-e', 'path-dirt-corner-nw'])
  assert.deepEqual(pathEdgeOverlays(world, 1, 0), ['path-cobble-corner-se', 'path-dirt-edge-w'])
  assert.deepEqual(pathEdgeOverlays(world, 0, 0), [], 'paths themselves take none')
  for (const k of ['edge-n', 'edge-e', 'edge-s', 'edge-w', 'corner-ne', 'corner-nw', 'corner-se', 'corner-sw']) {
    for (const m of ['dirt', 'cobble']) assert.ok(frameByKey.has(`path-${m}-${k}`), `path-${m}-${k}`)
  }
})

test('the public copy ships only the manifest (the frames come packed)', () => {
  assert.deepEqual(readdirSync(PUBLIC_DIR), ['manifest.json'])
  assert.ok(readFileSync(`${PUBLIC_DIR}manifest.json`).equals(readFileSync(`${SOURCE_DIR}manifest.json`)), 'public manifest is the delivered one')
})
