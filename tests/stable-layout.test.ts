import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bayFrontPiece, stableFootprint, stableLayout } from '../src/lib/stable-layout.ts'

const manifest = JSON.parse(readFileSync(new URL('../assets/generated/crafts-pass/manifest.json', import.meta.url), 'utf8')) as {
  frames: Record<string, { canvasSize: { w: number; h: number }; footprint: [number, number] | null }>
}
/** A frame's world size: 64 texels per 16-px tile. */
const world = (frame: string) => {
  const f = manifest.frames[frame]
  assert.ok(f, `${frame} is in the crafts pass`)
  return [f.canvasSize.w / 4, f.canvasSize.h / 4]
}

test('stable layout: the footprint grows east by two tiles a stall, 4 × 3 to 14 × 3', () => {
  assert.deepEqual(stableFootprint(1), [4, 3])
  assert.deepEqual(stableFootprint(2), [6, 3])
  assert.deepEqual(stableFootprint(6), [14, 3])
  // Out of range clamps: never a stable of 0 or 7 stalls.
  assert.deepEqual(stableFootprint(0), [4, 3])
  assert.deepEqual(stableFootprint(9), [14, 3])
})

test('stable layout: the west end, a bay per extra stall, the gable at the east edge', () => {
  for (let n = 1; n <= 6; n++) {
    const L = stableLayout(n)
    const width = L.footprint[0] * 16
    assert.equal(L.stalls, n)
    assert.equal(L.bays.length, n)
    assert.deepEqual(L.back.map((p) => p.frame), ['stable-west-back', ...Array(n - 1).fill('stable-bay-back')])
    // Back pieces tile the footprint edge to edge.
    let x = 0
    for (const p of L.back) {
      assert.equal(p.x, x)
      x += p.w
    }
    assert.equal(x, width)
    assert.deepEqual(L.over.map((p) => [p.frame, p.x]), [['stable-east-gable', width]])
    // Bays are numbered from the west and sit side by side, stall 1 in the west end's east half.
    assert.deepEqual(L.bays.map((b) => b.stall), Array.from({ length: n }, (_, i) => i + 1))
    assert.equal(L.bays[0].x, 32)
    for (const b of L.bays) assert.equal(b.w, 32)
    assert.equal(L.bays.at(-1)!.x + 32, width)
  }
})

test('stable layout: every piece is a delivered frame drawn at its canvas size', () => {
  const L = stableLayout(3)
  const pieces = [...L.back, ...L.over, ...L.bays.flatMap((b) => [bayFrontPiece(b, true), bayFrontPiece(b, false)])]
  for (const p of pieces) assert.deepEqual([p.w, p.h], world(p.frame), p.frame)
  // Stall 1's front is the whole west end (its tack-room wall too); later stalls' fronts are their bay.
  assert.deepEqual(bayFrontPiece(L.bays[0], true), { frame: 'stable-west-front-shut', x: 0, w: 64, h: 80 })
  assert.deepEqual(bayFrontPiece(L.bays[1], false), { frame: 'stable-bay-front-open', x: 64, w: 32, h: 80 })
  // The delivered footprints agree with the layout's.
  assert.deepEqual(manifest.frames['stable-west-back'].footprint, [4, 3])
  assert.deepEqual(manifest.frames['stable-bay-back'].footprint, [2, 3])
})
