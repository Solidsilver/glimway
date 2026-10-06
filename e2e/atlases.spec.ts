import { expect, test } from './fixtures'
import { beginNewJourney } from './helpers'

/**
 * The packed atlases (scripts/build-atlases.ts) are dense: every canvas-pack
 * frame box-filtered to ART_DENSITY texels per world px. The loaders must
 * hand the game exactly those texels (each texture a 1:1 copy of its packed
 * rect) and draw each at its native world size (src/game/density.ts): every
 * Commons-pass, runtime-pass and items-pass texture, and the terrain sheet.
 */

type Rect = { x: number; y: number; w: number; h: number }
type Frame = { key: string; width: number; height: number; destinationRect: Rect }
type Pack = { image: string; density: number; frames: Record<string, [number, number, number, number]> }

test('the game holds the packed texels, drawn at native world size', async ({ page }) => {
  test.setTimeout(120_000)
  await beginNewJourney(page)
  const result = await page.evaluate(async () => {
    const w = window as unknown as {
      __fsDevTextureHash: (key: string) => string | null
      __fsDevTextureSize: (key: string) => { w: number; h: number; density: number } | null
    }
    const json = async <T,>(url: string) => (await (await fetch(url)).json()) as T
    const image = async (url: string) => {
      const img = new Image()
      img.src = url
      await img.decode()
      return img
    }
    const hash = (img: CanvasImageSource, r: [number, number, number, number]) => {
      const c = document.createElement('canvas')
      c.width = r[2]
      c.height = r[3]
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, r[0], r[1], r[2], r[3], 0, 0, r[2], r[3])
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let h = 2166136261
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619)
      return `${c.width}x${c.height}:${(h >>> 0).toString(16)}`
    }
    const bad: string[] = []
    let checked = 0
    const check = (what: string, want: unknown, got: unknown) => {
      checked++
      if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(`${what}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
    }

    const packed = await json<{ commons: Pack; runtime: Pack; items: Pack; terrain: { image: string; size: [number, number] } }>('/assets/fingersnap/packed/atlases.json')
    for (const [dir, prefix, pack] of [
      ['commons-pass', 'commons-art:', packed.commons],
      ['runtime-pass', '', packed.runtime],
      ['items-pass', 'items-art:', packed.items],
    ] as const) {
      const m = await json<{ frames: Frame[] }>(`/assets/fingersnap/${dir}/manifest.json`)
      const atlas = await image(`/assets/fingersnap/packed/${pack.image}`)
      for (const f of m.frames) {
        const key = prefix + f.key
        check(`${key} texels`, hash(atlas, pack.frames[f.key]), w.__fsDevTextureHash(key))
        check(`${key} size`, { w: f.width, h: f.height, density: pack.density }, w.__fsDevTextureSize(key))
      }
    }
    const terrain = await image(`/assets/fingersnap/packed/${packed.terrain.image}`)
    check('fingersnap-terrain-runtime', hash(terrain, [0, 0, ...packed.terrain.size]), w.__fsDevTextureHash('fingersnap-terrain-runtime'))
    return { bad, checked }
  })
  expect(result.bad).toEqual([])
  expect(result.checked).toBeGreaterThan(700)
})
