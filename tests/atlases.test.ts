import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ART_DENSITY,
  ATLAS_GENERATOR_VERSION,
  BACKDROPS,
  MAX_SCREEN_SCALE,
  SCALED_ATLASES,
  blitKey,
  commonsBlitPlan,
  GROUND_COLS,
  GROUND_TILES,
  HELD_TEXELS,
  PEOPLE,
  PLAYTEST1_DIR,
  PLAYTEST1_RECORDS,
  playtest1Records,
  playtest1Used,
  POND_SOURCE,
  BUILDINGS,
  type PackedManifest,
} from '../src/game/atlas-plan.ts'
import type { CommonsPassManifest } from '../src/game/commons-pass.ts'
import type { RuntimeArtManifest } from '../src/game/runtime-art.ts'
import type { ItemsPassManifest } from '../src/game/items-pass.ts'

/**
 * The packed atlases are committed build output (scripts/build-atlases.ts,
 * `npm run atlases`): these tests fail when they're stale — an input sheet
 * or manifest changed, the plan asks for something not baked, or the baking
 * changed — and check that public/ ships nothing else.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKED = join(ROOT, 'public/assets/fingersnap/packed')
const RERUN = 'stale packed atlases: run `npm run atlases`'

type Built = PackedManifest & { generatorVersion: number; plan: { density: number; maxScreenScale: number; blits: string[]; scaled: Record<string, Record<string, number>>; backdrops: unknown } }
const built = JSON.parse(readFileSync(join(PACKED, 'atlases.json'), 'utf8')) as Built
const commons = JSON.parse(readFileSync(join(ROOT, 'assets/generated/commons-pass/manifest.json'), 'utf8')) as CommonsPassManifest
const runtime = JSON.parse(readFileSync(join(ROOT, 'assets/generated/runtime-pass/manifest.json'), 'utf8')) as RuntimeArtManifest
const items = JSON.parse(readFileSync(join(ROOT, 'assets/generated/items-pass/manifest.json'), 'utf8')) as ItemsPassManifest
const indoors = JSON.parse(readFileSync(join(ROOT, 'assets/generated/indoors-pass/manifest.json'), 'utf8')) as { sources: { file: string }[]; frames: { key: string; canvasSize: { w: number; h: number } }[] }
const crafts = JSON.parse(readFileSync(join(ROOT, 'assets/generated/crafts-pass/manifest.json'), 'utf8')) as { frames: Record<string, { file: string; canvasSize: { w: number; h: number } }> }
const purse = JSON.parse(readFileSync(join(ROOT, 'assets/generated/purse-pass/manifest.json'), 'utf8')) as { frames: Record<string, { file: string; canvasSize: { w: number; h: number } }> }
const glims = JSON.parse(readFileSync(join(ROOT, 'assets/generated/glims-pass/manifest.json'), 'utf8')) as { frames: Record<string, { file: string; canvasSize: { w: number; h: number } }> }

type P1 = { frames: Record<string, { source: string }>; sources: Record<string, { file: string }> }
const p1 = JSON.parse(readFileSync(join(ROOT, PLAYTEST1_DIR, 'atlas.json'), 'utf8')) as P1
const p1Anims = JSON.parse(readFileSync(join(ROOT, PLAYTEST1_DIR, 'animations.json'), 'utf8')) as { animations: { frames: string[] }[] }
/** A frame's source sheet (atlas.json's own list). */
const p1File = (n: string) => p1.sources[p1.frames[n].source].file
/** The playtest-1 frames the build samples. */
const p1Used = playtest1Used(Object.keys(p1.frames))

const sha = (path: string) => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')

function pngSize(path: string): [number, number, number] {
  const d = readFileSync(path)
  assert.equal(d.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`)
  return [d.readUInt32BE(16), d.readUInt32BE(20), d.readUInt8(25)]
}

/** A WebP's pixel size (a VP8X, VP8L or VP8 payload). */
function webpSize(path: string): [number, number] {
  const d = readFileSync(path)
  assert.equal(d.subarray(0, 4).toString('latin1') + d.subarray(8, 12).toString('latin1'), 'RIFFWEBP', `${path} is WebP`)
  const chunk = d.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8X') return [d.readUIntLE(24, 3) + 1, d.readUIntLE(27, 3) + 1]
  if (chunk === 'VP8L') {
    // After the 0x2f signature: 14 bits width-1, then 14 bits height-1 (LSB first).
    const bits = d.readUIntLE(21, 4)
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]
  }
  assert.equal(chunk, 'VP8 ', `${path}: unexpected WebP chunk`)
  return [d.readUInt16LE(26) & 0x3fff, d.readUInt16LE(28) & 0x3fff]
}

/** An image's pixel size, PNG or WebP (the dense packs ship as lossless WebP). */
function imageSize(path: string): [number, number] {
  return readFileSync(path).subarray(8, 12).toString('latin1') === 'WEBP' ? webpSize(path) : (pngSize(path).slice(0, 2) as [number, number])
}

test('every input the atlases were baked from is unchanged', () => {
  assert.equal(built.generatorVersion, ATLAS_GENERATOR_VERSION, RERUN)
  const expected = [
    'assets/generated/commons-pass/manifest.json',
    ...commons.sources.map((s) => `assets/generated/commons-pass/${s.file}`),
    'assets/generated/runtime-pass/manifest.json',
    ...runtime.sources.map((s) => `assets/generated/runtime-pass/${s.file}`),
    'assets/generated/items-pass/manifest.json',
    ...items.sources.map((s) => `assets/generated/items-pass/${s.file}`),
    'assets/generated/indoors-pass/manifest.json',
    ...indoors.sources.map((s) => `assets/generated/indoors-pass/sheets/${s.file}`),
    'assets/generated/crafts-pass/manifest.json',
    ...Object.values(crafts.frames).map((f) => `assets/generated/crafts-pass/${f.file}`),
    'assets/generated/purse-pass/manifest.json',
    ...Object.values(purse.frames).map((f) => `assets/generated/purse-pass/${f.file}`),
    'assets/generated/glims-pass/manifest.json',
    ...Object.values(glims.frames).map((f) => `assets/generated/glims-pass/${f.file}`),
    'assets/generated/expansion/manifest.json',
    'assets/generated/expansion/fingersnap-terrain.png',
    'assets/generated/expansion/fingersnap-terrain.atlas.json',
    ...SCALED_ATLASES.flatMap((a) => [a.source, a.json]),
    ...BACKDROPS.map((b) => b.source),
    PLAYTEST1_RECORDS,
    ...new Set(p1Used.map((n) => `${PLAYTEST1_DIR}/${p1File(n)}`)),
  ].sort()
  assert.deepEqual(Object.keys(built.inputs).sort(), expected, RERUN)
  for (const [path, hash] of Object.entries(built.inputs)) {
    const now = path === PLAYTEST1_RECORDS ? createHash('sha256').update(playtest1Records(p1, p1Anims)).digest('hex') : sha(path)
    assert.equal(now, hash, `${path} changed — ${RERUN}`)
  }
})

test('the plan asks for nothing that wasn’t baked', () => {
  assert.equal(built.plan.density, ART_DENSITY, RERUN)
  assert.equal(built.plan.maxScreenScale, MAX_SCREEN_SCALE, RERUN)
  const blits = commonsBlitPlan(commons.frames).map((b) => blitKey(b.frame, b.w, b.h, b.flipX)).sort()
  assert.deepEqual(built.plan.blits, blits, RERUN)
  assert.deepEqual(Object.keys(built.commons.blits ?? {}).sort(), blits)
  for (const plan of SCALED_ATLASES) {
    const atlas = JSON.parse(readFileSync(join(ROOT, plan.json), 'utf8')) as { frames: Record<string, { frame: { w: number; h: number } }> }
    const want: Record<string, number> = {}
    for (const name of Object.keys(atlas.frames)) {
      const g = plan.groups.find((gr) => gr.frames.test(name))
      assert.ok(g, `${plan.key}: ${name} has no display size in SCALED_ATLASES`)
      const ref = atlas.frames[g!.ref].frame
      const screen = g!.screen ?? MAX_SCREEN_SCALE
      want[name] = Number(Math.min(1, g!.height ? (screen * g!.height) / ref.h : (screen * g!.width!) / ref.w).toFixed(6))
    }
    assert.deepEqual(built.plan.scaled[plan.key], want, `${plan.key}: ${RERUN}`)
  }
  assert.deepEqual(built.plan.backdrops, JSON.parse(JSON.stringify(BACKDROPS)), RERUN)
})

test('canvas packs hold every native frame whole, at ART_DENSITY, inside their atlas', () => {
  for (const [pack, frames] of [
    [built.commons, commons.frames],
    [built.runtime, runtime.frames],
    [built.items, items.frames],
  ] as const) {
    // Lossless WebP, verified texel-exact against its PNG by the build (which
    // also keeps every frame's alpha: the read-back compares all four channels).
    const [w, h] = webpSize(join(PACKED, pack.image))
    assert.deepEqual([w, h], pack.size, `${pack.image} size`)
    assert.equal(pack.density, ART_DENSITY, `${pack.image} density`)
    for (const f of frames) {
      const r = pack.frames[f.key]
      assert.ok(r, `${pack.image}: ${f.key} missing`)
      assert.deepEqual([r[2], r[3]], [f.width * ART_DENSITY, f.height * ART_DENSITY], `${f.key} is its native canvas at ART_DENSITY`)
      assert.ok(r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= w && r[1] + r[3] <= h, `${f.key} inside ${pack.image}`)
    }
    for (const [key, r] of Object.entries(pack.blits ?? {})) {
      const m = /@(\d+)x(\d+)/.exec(key)!
      assert.deepEqual([r[2], r[3]], [+m[1] * ART_DENSITY, +m[2] * ART_DENSITY], `${key} at ART_DENSITY`)
      assert.ok(r[0] + r[2] <= w && r[1] + r[3] <= h, `${key} inside ${pack.image}`)
    }
  }
  // Every atlas fits a phone GPU's texture limit.
  for (const image of [built.commons.image, built.runtime.image, built.items.image, built.indoors.image, built.crafts.image, built.terrain.image, built.ground.image, built.people.image, built.buildings.image, ...Object.values(built.atlases).map((a) => a.image)]) {
    const [w, h] = imageSize(join(PACKED, image))
    assert.ok(w <= 4096 && h <= 4096, `${image} is ${w}×${h}, past 4096`)
  }
  const cell = 16 * ART_DENSITY
  assert.deepEqual([built.terrain.cell, built.terrain.density], [cell, ART_DENSITY])
  assert.deepEqual(imageSize(join(PACKED, built.terrain.image)), [cell * 4, cell * 4], `terrain is the 4×4 tileset of ${cell}-texel cells`)
})

test('the manifest names every packed image by its content hash (the ground paint caches key on them)', () => {
  const images = readdirSync(PACKED).filter((f: string) => /\.(webp|png)$/.test(f)).sort()
  assert.deepEqual(Object.keys(built.outputs ?? {}).sort(), images, RERUN)
  for (const f of images) assert.equal(built.outputs![f], createHash('sha256').update(readFileSync(join(PACKED, f))).digest('hex'), `${f} changed — ${RERUN}`)
})

test('the playtest-1 ground: every tile, one world tile each, healed', () => {
  const cell = 16 * ART_DENSITY
  assert.deepEqual([built.ground.cell, built.ground.density, built.ground.cols], [cell, ART_DENSITY, GROUND_COLS])
  assert.equal(built.ground.healed, true, 'a comparison bake (ATLAS_NO_HEAL) must not be committed')
  assert.deepEqual(Object.keys(built.ground.tiles), GROUND_TILES)
  assert.deepEqual(webpSize(join(PACKED, built.ground.image)), [GROUND_COLS * cell, Math.ceil(GROUND_TILES.length / GROUND_COLS) * cell])
})

test('the playtest-1 buildings: every house and bridge state, its whole canvas at ART_DENSITY', () => {
  const [w, h] = webpSize(join(PACKED, built.buildings.image))
  assert.deepEqual([w, h], built.buildings.size)
  assert.deepEqual(Object.keys(built.buildings.frames).sort(), [...BUILDINGS].sort())
  const atlas = JSON.parse(readFileSync(join(ROOT, PLAYTEST1_DIR, 'atlas.json'), 'utf8')) as { frames: Record<string, { canvasSize: { w: number; h: number } }> }
  for (const name of BUILDINGS) {
    const r = built.buildings.frames[name]
    const c = atlas.frames[name].canvasSize
    assert.deepEqual([r[2], r[3]], [(c.w / 4) * ART_DENSITY, (c.h / 4) * ART_DENSITY], `${name} canvas`)
    assert.ok(r[0] + r[2] <= w && r[1] + r[3] <= h, `${name} inside the atlas`)
  }
})

test('the indoors pass: every named 64-texel canvas is packed whole', () => {
  const [w, h] = webpSize(join(PACKED, built.indoors.image))
  assert.deepEqual([w, h], built.indoors.size)
  assert.equal(built.indoors.density, 64)
  assert.deepEqual(Object.keys(built.indoors.frames).sort(), indoors.frames.map((f) => f.key).sort())
  for (const f of indoors.frames) {
    const r = built.indoors.frames[f.key]
    assert.deepEqual([r[2], r[3]], [f.canvasSize.w, f.canvasSize.h], `${f.key} keeps its requested canvas`)
    assert.ok(r[0] + r[2] <= w && r[1] + r[3] <= h, `${f.key} inside the indoors atlas`)
  }
})

test('the crafts pass: every 64-texel frame is packed whole', () => {
  const [w, h] = webpSize(join(PACKED, built.crafts.image))
  assert.deepEqual([w, h], built.crafts.size)
  assert.equal(built.crafts.density, 64)
  assert.deepEqual(Object.keys(built.crafts.frames).sort(), Object.keys(crafts.frames).sort())
  for (const [key, f] of Object.entries(crafts.frames)) {
    const r = built.crafts.frames[key]
    assert.deepEqual([r[2], r[3]], [f.canvasSize.w, f.canvasSize.h], `${key} keeps its canvas`)
    assert.ok(r[0] + r[2] <= w && r[1] + r[3] <= h, `${key} inside the crafts atlas`)
  }
})

test('the purse pass: every 64-texel icon is packed whole', () => {
  const [w, h] = webpSize(join(PACKED, built.purse.image))
  assert.deepEqual([w, h], built.purse.size)
  assert.equal(built.purse.density, 64)
  assert.deepEqual(Object.keys(built.purse.frames).sort(), Object.keys(purse.frames).sort())
  for (const [key, f] of Object.entries(purse.frames)) {
    const r = built.purse.frames[key]
    assert.deepEqual([r[2], r[3]], [f.canvasSize.w, f.canvasSize.h], `${key} keeps its canvas`)
    assert.ok(r[0] + r[2] <= w && r[1] + r[3] <= h, `${key} inside the purse atlas`)
  }
})

test('the glims pass: a glim, its HUD size and a few glims, each packed whole', () => {
  const [w, h] = webpSize(join(PACKED, built.glims.image))
  assert.deepEqual([w, h], built.glims.size)
  assert.equal(built.glims.density, 64)
  assert.deepEqual(Object.keys(built.glims.frames).sort(), ['glim', 'glim-hud', 'glims-few'])
  assert.deepEqual(Object.keys(built.glims.frames).sort(), Object.keys(glims.frames).sort())
  for (const [key, f] of Object.entries(glims.frames)) {
    const r = built.glims.frames[key]
    assert.deepEqual([r[2], r[3]], [f.canvasSize.w, f.canvasSize.h], `${key} keeps its canvas`)
    assert.ok(r[0] + r[2] <= w && r[1] + r[3] <= h, `${key} inside the glims atlas`)
  }
})

test('the playtest-1 people: every resident and held frame, trimmed to 4-texel steps inside its canvas', () => {
  const [w, h] = webpSize(join(PACKED, built.people.image))
  assert.deepEqual([w, h], built.people.size)
  assert.equal(built.people.density, ART_DENSITY)
  assert.deepEqual(Object.keys(built.people.frames).sort(), p1Used.filter((n) => !GROUND_TILES.includes(n) && n !== POND_SOURCE && !(BUILDINGS as readonly string[]).includes(n)).sort())
  for (const [name, f] of Object.entries(built.people.frames)) {
    const held = name.startsWith('held-')
    assert.deepEqual(f.source, held ? [HELD_TEXELS, HELD_TEXELS] : [16 * ART_DENSITY, 32 * ART_DENSITY], `${name} canvas`)
    for (const v of [...f.frame, ...f.at]) assert.equal(v % 4, 0, `${name}: ${v} is not a multiple of 4`)
    assert.ok(f.at[0] + f.frame[2] <= f.source[0] && f.at[1] + f.frame[3] <= f.source[1], `${name} trim inside its canvas`)
    assert.ok(f.frame[0] + f.frame[2] <= w && f.frame[1] + f.frame[3] <= h, `${name} inside the atlas`)
    assert.equal(!!f.hand, held, `${name} hand anchor`)
  }
  for (const id of PEOPLE) {
    for (const dir of ['down', 'up', 'left', 'right']) {
      for (const a of ['breathing', 'walking']) assert.ok(built.people.animations.some((x) => x.key === `resident-${id}-${dir}-${a}`), `${id} ${dir} ${a}`)
    }
    assert.ok(built.people.frames[`resident-${id}-sit-down`], `${id} sits`)
  }
})

test('scaled atlases keep every frame name, at their baked size', () => {
  for (const plan of SCALED_ATLASES) {
    const files = built.atlases[plan.key]
    assert.ok(files, plan.key)
    const src = JSON.parse(readFileSync(join(ROOT, plan.json), 'utf8')) as { frames: Record<string, { frame: { w: number; h: number }; trimmed: boolean }> }
    const out = JSON.parse(readFileSync(join(PACKED, files.json), 'utf8')) as { frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; spriteSourceSize: { x: number; y: number; w: number; h: number }; sourceSize: { w: number; h: number }; trimmed: boolean }>; meta: { size: { w: number; h: number } } }
    const [w, h] = pngSize(join(PACKED, files.image))
    assert.deepEqual([out.meta.size.w, out.meta.size.h], [w, h])
    assert.deepEqual(Object.keys(out.frames).sort(), Object.keys(src.frames).sort(), `${plan.key} frame names`)
    for (const [name, f] of Object.entries(out.frames)) {
      const k = built.plan.scaled[plan.key][name]
      assert.ok(k > 0 && k <= 1, `${name} is never upsampled from its source`)
      assert.equal(f.frame.w, Math.max(1, Math.round(src.frames[name].frame.w * k)), `${name} width`)
      assert.equal(f.frame.h, Math.max(1, Math.round(src.frames[name].frame.h * k)), `${name} height`)
      assert.equal(f.trimmed, src.frames[name].trimmed)
      assert.ok(f.frame.x + f.frame.w <= w && f.frame.y + f.frame.h <= h, `${name} inside the atlas`)
      assert.ok(f.spriteSourceSize.x + f.spriteSourceSize.w <= f.sourceSize.w && f.spriteSourceSize.y + f.spriteSourceSize.h <= f.sourceSize.h, `${name} trim inside its source size`)
    }
  }
})

test('public/assets/fingersnap ships its licence, manifests and packed art only — no full-resolution sheets', () => {
  const dir = join(ROOT, 'public/assets/fingersnap')
  const walk = (d: string): string[] => readdirSync(d).flatMap((n: string) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(dir, join(d, n))]))
  const want = [
    'LICENSE',
    'commons-pass/manifest.json',
    'runtime-pass/manifest.json',
    'expansion/manifest.json',
    'expansion/animations.json',
    'items-pass/manifest.json',
    'indoors-pass/manifest.json',
    'packed/atlases.json',
    `packed/${built.commons.image}`,
    `packed/${built.runtime.image}`,
    `packed/${built.items.image}`,
    `packed/${built.indoors.image}`,
    `packed/${built.crafts.image}`,
    `packed/${built.purse.image}`,
    `packed/${built.glims.image}`,
    `packed/${built.terrain.image}`,
    `packed/${built.ground.image}`,
    `packed/${built.people.image}`,
    `packed/${built.buildings.image}`,
    ...Object.values(built.atlases).flatMap((a) => [`packed/${a.image}`, `packed/${a.json}`]),
    ...Object.values(built.backdrops).map((f) => `packed/${f}`),
  ].sort()
  assert.deepEqual(walk(dir).sort(), want)
  for (const f of Object.values(built.backdrops)) {
    const d = readFileSync(join(PACKED, f))
    assert.equal(d.subarray(0, 4).toString('latin1') + d.subarray(8, 12).toString('latin1'), 'RIFFWEBP', `${f} is WebP`)
  }
  for (const m of ['expansion/manifest.json', 'expansion/animations.json', 'commons-pass/manifest.json', 'runtime-pass/manifest.json', 'items-pass/manifest.json', 'indoors-pass/manifest.json']) {
    assert.ok(readFileSync(join(dir, m)).equals(readFileSync(join(ROOT, 'assets/generated', m))), `${m} is the delivered one`)
  }
})
