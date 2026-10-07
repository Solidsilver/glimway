import { expect, test } from './fixtures'
import { ART_DENSITY, HELD_LEAN, MILL_WALL, PEOPLE, PERSON_CANVAS, PERSON_FACINGS, PERSON_FOOT, PERSON_HEIGHT } from '../src/game/atlas-plan'

/**
 * The packed people and mill wheel, read back from the shipped images (so
 * the guard is on the texels the game draws, not on the build's own notes):
 *
 *  - every resident frame stands on one foot point: its lowest texels on the
 *    canvas's foot row, its head and body centred over the foot (to a
 *    texel), breathing and walking alike — no jump between frames;
 *  - each person is PERSON_HEIGHT tall whichever way they face (adults the
 *    hero's height, the elderly shorter, Pip smaller);
 *  - every held tool leans out from its grip, art-left, and the grip is on
 *    the art;
 *  - the mill wheel's frames share one wall (height, edge and foot), on the
 *    west, against the house.
 *
 * The playtest-1 pass's measured crops broke all of this once (owner's
 * playtest, 2026-10-07): src/game/figures.ts and scripts/build-atlases.ts.
 */

type Rect = [number, number, number, number]
type People = { image: string; frames: Record<string, { frame: Rect; at: [number, number]; source: [number, number]; hand?: [number, number] }> }

test('people frames share one foot point and scale; held tools lean out; the mill wheel holds still', async ({ page }) => {
  await page.goto('/')
  const m = await page.evaluate(async () => {
    const packed = (await (await fetch('/assets/fingersnap/packed/atlases.json')).json()) as { people: People; items: { image: string; frames: Record<string, Rect> } }
    const image = async (url: string) => {
      const img = new Image()
      img.src = url
      await img.decode()
      return img
    }
    /** A frame's whole canvas: alpha by row, solid (≥128) or any. */
    const canvasOf = (img: HTMLImageElement, r: Rect, at: [number, number], size: [number, number]) => {
      const c = document.createElement('canvas')
      c.width = size[0]
      c.height = size[1]
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, r[0], r[1], r[2], r[3], at[0], at[1], r[2], r[3])
      const d = ctx.getImageData(0, 0, size[0], size[1]).data
      return { w: size[0], h: size[1], alpha: (x: number, y: number) => d[(y * size[0] + x) * 4 + 3] }
    }
    type C = ReturnType<typeof canvasOf>
    const measure = (c: C, upper = 0.55) => {
      let top = c.h, bottom = -1, left = c.w
      for (let y = 0; y < c.h; y++)
        for (let x = 0; x < c.w; x++) {
          if (c.alpha(x, y) === 0) continue
          bottom = Math.max(bottom, y)
          left = Math.min(left, x)
          if (c.alpha(x, y) >= 128) top = Math.min(top, y)
        }
      // The head and body's centre: the top `upper` of the figure.
      const limit = top + (bottom + 1 - top) * upper
      let sx = 0, sa = 0, all = 0, allA = 0
      for (let y = 0; y < c.h; y++)
        for (let x = 0; x < c.w; x++) {
          const a = c.alpha(x, y)
          all += (x + 0.5) * a
          allA += a
          if (y < limit) {
            sx += (x + 0.5) * a
            sa += a
          }
        }
      return { top, bottom, left, centre: sx / sa, mass: all / allA }
    }
    const people = await image(`/assets/fingersnap/packed/${packed.people.image}`)
    const frames: Record<string, ReturnType<typeof measure> & { hand?: [number, number]; handAlpha?: number }> = {}
    for (const [name, f] of Object.entries(packed.people.frames)) {
      const c = canvasOf(people, f.frame, f.at, f.source)
      frames[name] = { ...measure(c), ...(f.hand ? { hand: f.hand, handAlpha: c.alpha(Math.floor(f.hand[0]), Math.floor(f.hand[1])) } : {}) }
    }
    const items = await image(`/assets/fingersnap/packed/${packed.items.image}`)
    const mill: Record<string, { wallTop: number; bottom: number; left: number }> = {}
    for (const [name, r] of Object.entries(packed.items.frames)) {
      if (!name.startsWith('mill-wheel-')) continue
      const c = canvasOf(items, r, [0, 0], [r[2], r[3]])
      const f = measure(c)
      // The wall: the solid rows of the 2-world-px strip at the frame's west edge.
      let wallTop = c.h
      let bottom = -1
      for (let y = 0; y < c.h; y++)
        for (let x = f.left; x < f.left + 8; x++)
          if (c.alpha(x, y) >= 128) {
            wallTop = Math.min(wallTop, y)
            bottom = Math.max(bottom, y)
          }
      mill[name] = { wallTop, bottom, left: f.left }
    }
    return { frames, mill }
  })

  const k = ART_DENSITY
  const bad: string[] = []
  for (const id of PEOPLE) {
    const names = Object.keys(m.frames).filter((n) => n.startsWith(`resident-${id}-`))
    expect(names.length, id).toBe(25)
    for (const n of names) {
      const f = m.frames[n]
      if (f.bottom !== PERSON_FOOT[1] * k - 1) bad.push(`${n}: feet on row ${f.bottom}, not ${PERSON_FOOT[1] * k - 1}`)
      if (Math.abs(f.centre - PERSON_FOOT[0] * k) > 1) bad.push(`${n}: body centred at ${f.centre.toFixed(2)}, not ${PERSON_FOOT[0] * k}`)
    }
    // One height whichever way they face: each facing's frames stand the planned height (their
    // median, to two texels: solid texels only, and the art bobs), none more than 6% off.
    for (const d of PERSON_FACINGS) {
      const hs = names.filter((n) => n.startsWith(`resident-${id}-${d}-`)).map((n) => PERSON_CANVAS[1] * k - m.frames[n].top).sort((a, b) => a - b)
      const median = (hs[2] + hs[3]) / 2
      if (Math.abs(median - PERSON_HEIGHT[id] * k) > 2) bad.push(`${id} ${d}: stands ${median / k} px, not ${PERSON_HEIGHT[id]}`)
      for (const h of hs) if (Math.abs(h / (PERSON_HEIGHT[id] * k) - 1) > 0.06) bad.push(`${id} ${d}: a frame ${h / k} px tall, planned ${PERSON_HEIGHT[id]}`)
    }
    // Breathing changes the torso only: both frames' tops within a texel or two.
    for (const d of PERSON_FACINGS) {
      const [a, b] = [0, 1].map((i) => m.frames[`resident-${id}-${d}-idle-${i}`])
      if (Math.abs(a.top - b.top) > 2) bad.push(`${id} ${d}: breathing moves the head ${Math.abs(a.top - b.top)} texels`)
    }
  }
  // Adults stand the hero's height; the elderly are shorter, Pip shorter still.
  expect(PERSON_HEIGHT.mara).toBe(PERSON_HEIGHT.finn)
  expect(PERSON_HEIGHT.orrin).toBeLessThan(PERSON_HEIGHT.mara)
  expect(PERSON_HEIGHT.pip).toBeLessThan(PERSON_HEIGHT.orrin)

  const held = Object.keys(m.frames).filter((n) => n.startsWith('held-'))
  expect(held.length).toBe(32)
  for (const n of held) {
    const f = m.frames[n]
    if (!f.hand) bad.push(`${n}: no grip`)
    else {
      if (f.mass - f.hand[0] > HELD_LEAN) bad.push(`${n}: leans ${(f.mass - f.hand[0]).toFixed(1)} texels right of its grip`)
      if ((f.handAlpha ?? 0) < 128) bad.push(`${n}: the grip (${f.hand}) is off the art`)
    }
  }

  const wheels = Object.entries(m.mill)
  expect(wheels.length).toBe(8)
  const [, first] = wheels[0]
  for (const [n, w] of wheels) {
    if (w.left !== first.left || Math.abs(w.bottom - first.bottom) > 1) bad.push(`${n}: wall at ${w.left}, foot ${w.bottom}; frame 0 at ${first.left}, ${first.bottom}`)
    if (Math.abs(w.wallTop - first.wallTop) > 1) bad.push(`${n}: wall top ${w.wallTop}, frame 0 ${first.wallTop}`)
    if (Math.abs(w.bottom + 1 - w.wallTop - MILL_WALL * k) > 2) bad.push(`${n}: wall ${(w.bottom + 1 - w.wallTop) / k} px tall, planned ${MILL_WALL}`)
    if (w.left > 4) bad.push(`${n}: the wall isn't on the west edge (${w.left})`)
  }
  expect(bad).toEqual([])
})
