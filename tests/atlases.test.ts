import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATLAS_GENERATOR_VERSION,
  BACKDROPS,
  MAX_SCREEN_SCALE,
  SCALED_ATLASES,
  blitKey,
  commonsBlitPlan,
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

type Built = PackedManifest & { generatorVersion: number; plan: { maxScreenScale: number; blits: string[]; scaled: Record<string, Record<string, number>>; backdrops: unknown } }
const built = JSON.parse(readFileSync(join(PACKED, 'atlases.json'), 'utf8')) as Built
const commons = JSON.parse(readFileSync(join(ROOT, 'assets/generated/commons-pass/manifest.json'), 'utf8')) as CommonsPassManifest
const runtime = JSON.parse(readFileSync(join(ROOT, 'assets/generated/runtime-pass/manifest.json'), 'utf8')) as RuntimeArtManifest
const items = JSON.parse(readFileSync(join(ROOT, 'assets/generated/items-pass/manifest.json'), 'utf8')) as ItemsPassManifest

const sha = (path: string) => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')

function pngSize(path: string): [number, number, number] {
  const d = readFileSync(path)
  assert.equal(d.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`)
  return [d.readUInt32BE(16), d.readUInt32BE(20), d.readUInt8(25)]
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
    'assets/generated/expansion/manifest.json',
    'assets/generated/expansion/fingersnap-terrain.png',
    'assets/generated/expansion/fingersnap-terrain.atlas.json',
    ...SCALED_ATLASES.flatMap((a) => [a.source, a.json]),
    ...BACKDROPS.map((b) => b.source),
  ].sort()
  assert.deepEqual(Object.keys(built.inputs).sort(), expected, RERUN)
  for (const [path, hash] of Object.entries(built.inputs)) assert.equal(sha(path), hash, `${path} changed — ${RERUN}`)
})

test('the plan asks for nothing that wasn’t baked', () => {
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

test('canvas packs hold every native frame whole, inside their atlas', () => {
  for (const [pack, frames] of [
    [built.commons, commons.frames],
    [built.runtime, runtime.frames],
    [built.items, items.frames],
  ] as const) {
    const [w, h, color] = pngSize(join(PACKED, pack.image))
    assert.deepEqual([w, h], pack.size, `${pack.image} size`)
    assert.equal(color, 6, `${pack.image} keeps alpha`)
    for (const f of frames) {
      const r = pack.frames[f.key]
      assert.ok(r, `${pack.image}: ${f.key} missing`)
      assert.deepEqual([r[2], r[3]], [f.width, f.height], `${f.key} is its native canvas`)
      assert.ok(r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= w && r[1] + r[3] <= h, `${f.key} inside ${pack.image}`)
    }
    for (const [key, r] of Object.entries(pack.blits ?? {})) assert.ok(r[0] + r[2] <= w && r[1] + r[3] <= h, `${key} inside ${pack.image}`)
  }
  assert.deepEqual(pngSize(join(PACKED, built.terrain.image)).slice(0, 2), [128, 128], 'terrain is the 4×4 tileset of 32-px cells')
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

test('public/assets/fingersnap ships manifests and packed art only — no full-resolution sheets', () => {
  const dir = join(ROOT, 'public/assets/fingersnap')
  const walk = (d: string): string[] => readdirSync(d).flatMap((n: string) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(dir, join(d, n))]))
  const want = [
    'commons-pass/manifest.json',
    'runtime-pass/manifest.json',
    'expansion/manifest.json',
    'expansion/animations.json',
    'items-pass/manifest.json',
    'packed/atlases.json',
    `packed/${built.commons.image}`,
    `packed/${built.runtime.image}`,
    `packed/${built.items.image}`,
    `packed/${built.terrain.image}`,
    ...Object.values(built.atlases).flatMap((a) => [`packed/${a.image}`, `packed/${a.json}`]),
    ...Object.values(built.backdrops).map((f) => `packed/${f}`),
  ].sort()
  assert.deepEqual(walk(dir).sort(), want)
  for (const f of Object.values(built.backdrops)) {
    const d = readFileSync(join(PACKED, f))
    assert.equal(d.subarray(0, 4).toString('latin1') + d.subarray(8, 12).toString('latin1'), 'RIFFWEBP', `${f} is WebP`)
  }
  for (const m of ['expansion/manifest.json', 'expansion/animations.json', 'commons-pass/manifest.json', 'runtime-pass/manifest.json', 'items-pass/manifest.json']) {
    assert.ok(readFileSync(join(dir, m)).equals(readFileSync(join(ROOT, 'assets/generated', m))), `${m} is the delivered one`)
  }
})
