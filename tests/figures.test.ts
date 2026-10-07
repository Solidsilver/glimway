import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFigures, footPoint, layoutFigures, placeAt, type Rgba } from '../src/game/figures.ts'
import { ART_DENSITY, heldSheetRows, MILL_SHEET_ROWS, PEOPLE, PERSON_CANVAS, PERSON_FACINGS, PERSON_FOOT, PERSON_HEIGHT, PLAYTEST1_DIR, personSheetRows, type PackedManifest } from '../src/game/atlas-plan.ts'
import { readPng } from '../scripts/png-decode.ts'

/**
 * Figures on the delivered sheets (src/game/figures.ts), which the atlas
 * build draws each resident, held tool and mill-wheel frame from: every
 * sheet splits into exactly its layout, and each person's frames share one
 * scale per facing and one foot point, so nothing jumps between frames
 * (e2e/sprite-anchors.spec.ts checks the shipped texels).
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const built = JSON.parse(readFileSync(join(ROOT, 'public/assets/fingersnap/packed/atlases.json'), 'utf8')) as PackedManifest

/** A w×h transparent image with solid (or `alpha`) rects painted in. */
function paint(w: number, h: number, rects: [number, number, number, number, number?][]): Rgba {
  const data = new Uint8Array(w * h * 4)
  for (const [x0, y0, rw, rh, a = 255] of rects)
    for (let y = y0; y < y0 + rh; y++)
      for (let x = x0; x < x0 + rw; x++) data.set([200, 100, 50, a], (y * w + x) * 4)
  return { w, h, data }
}

test('figures: solid regions, specks joined or dropped, a faint haze never bridges two', () => {
  const img = paint(100, 40, [
    [5, 5, 20, 30],
    [60, 5, 20, 30],
    // a faint bridge between them (the generator's haze)
    [25, 20, 35, 1, 20],
    // a loose speck beside the first (a stray hair): joins it
    [27, 4, 2, 2],
    // a lone speck far from both: dropped
    [92, 36, 2, 2],
  ])
  const figs = findFigures(img)
  assert.equal(figs.length, 2)
  const [a, b] = figs.sort((p, q) => p.x - q.x)
  // The speck joined the first; the soft edge reaches 2 px out at most.
  assert.deepEqual([a.x, a.y, a.x + a.w], [5, 4, 29])
  assert.ok(b.x >= 58 && b.x + b.w <= 80, `second figure ${b.x}..${b.x + b.w}`)
  assert.ok(!a.pixels.some((p) => p % 100 === 92), 'the far speck is nobody’s')
})

test('placeAt: the anchor lands on the canvas point at the given scale, to whole texels', () => {
  const box = { x: 10, y: 20, w: 30, h: 60 }
  const anchor = { x: 25.3, y: 80 }
  const { s, d } = placeAt(box, anchor, [32, 128], 0.27)
  assert.equal(d[1] + d[3], 128, 'feet on the canvas’s bottom row')
  assert.ok(Math.abs(s[2] * 0.27 - d[2]) < 1e-9 && Math.abs(s[3] * 0.27 - d[3]) < 1e-9, 'one scale on both axes')
  assert.ok(Math.abs(d[0] + (anchor.x - s[0]) * 0.27 - 32) < 1e-9, 'the anchor maps onto x 32')
  assert.ok(s[0] <= box.x && s[0] + s[2] >= box.x + box.w && s[1] <= box.y, 'the whole figure is sampled')
})

test('every resident sheet splits into its 25 figures, and the build drew each at its facing’s one scale', () => {
  const atlas = JSON.parse(readFileSync(join(ROOT, PLAYTEST1_DIR, 'atlas.json'), 'utf8')) as { frames: Record<string, { source: string }>; sources: Record<string, { file: string }> }
  for (const id of PEOPLE) {
    const rows = personSheetRows(id)
    const src = atlas.sources[atlas.frames[rows[0][0]].source].file
    const img = readPng(join(ROOT, PLAYTEST1_DIR, src))
    const figs = layoutFigures(img, rows, id)
    assert.equal(figs.size, 25, id)
    const fit = built.people.fits[id]
    assert.ok(fit, `${id}: the packed manifest records the fit`)
    assert.equal(fit.height, PERSON_HEIGHT[id])
    for (const dir of PERSON_FACINGS) {
      const hs = [...figs].filter(([n]) => n.startsWith(`resident-${id}-${dir}-`)).map(([, f]) => f.h).sort((a, b) => a - b)
      const measured = (hs[2] + hs[3]) / 2
      assert.equal(fit.facings[dir].measured, measured, `${id} ${dir}: stale fit (npm run atlases)`)
      const scale = fit.facings[dir].scale
      assert.ok(Math.abs(measured * scale - PERSON_HEIGHT[id] * ART_DENSITY) < 0.01, `${id} ${dir}: stands ${(measured * scale) / ART_DENSITY} px, planned ${PERSON_HEIGHT[id]}`)
      // Every frame stays within a few percent of that (same scale; the stride bobs).
      for (const [n, f] of figs) {
        if (!n.startsWith(`resident-${id}-${dir}-`)) continue
        const h = f.h * scale
        assert.ok(Math.abs(h / (PERSON_HEIGHT[id] * ART_DENSITY) - 1) < 0.06, `${n}: ${h / ART_DENSITY} px tall`)
      }
    }
    // Each frame, drawn at its foot point, fits its canvas.
    for (const [name, f] of figs) {
      const dir = PERSON_FACINGS.find((d) => name.startsWith(`resident-${id}-${d}-`)) ?? 'down'
      const { d } = placeAt(f, footPoint(img, f), [PERSON_FOOT[0] * ART_DENSITY, PERSON_FOOT[1] * ART_DENSITY], fit.facings[dir].scale)
      assert.ok(d[0] >= 0 && d[1] >= 0 && d[0] + d[2] <= PERSON_CANVAS[0] * ART_DENSITY && d[1] + d[3] === PERSON_CANVAS[1] * ART_DENSITY, `${name}: ${d}`)
    }
  }
})

test('the held-tool and mill sheets split into their layouts', () => {
  const held = readPng(join(ROOT, PLAYTEST1_DIR, 'hand-items/fingersnap-held-tools.png'))
  assert.equal(layoutFigures(held, heldSheetRows(), 'held tools').size, 32)
  const mill = readPng(join(ROOT, 'assets/generated/items-pass/fingersnap-tolley-mill-1.png'))
  assert.equal(layoutFigures(mill, MILL_SHEET_ROWS, 'mill').size, 12)
})

test('adults stand the hero’s height, the elderly a touch shorter, Pip smaller', () => {
  const adults = ['mara', 'elara', 'finn', 'hazel'] as const
  const elders = ['orrin', 'silas', 'ada'] as const
  for (const a of adults) assert.equal(PERSON_HEIGHT[a], PERSON_HEIGHT.mara)
  for (const e of elders) assert.ok(PERSON_HEIGHT[e] < PERSON_HEIGHT.mara && PERSON_HEIGHT[e] > PERSON_HEIGHT.mara * 0.85, e)
  assert.ok(PERSON_HEIGHT.pip < Math.min(...elders.map((e) => PERSON_HEIGHT[e])))
})
