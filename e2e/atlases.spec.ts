import { expect, test } from './fixtures'
import { beginNewJourney } from './helpers'

/**
 * The packed atlases (scripts/build-atlases.ts) must give the canvas-blit
 * loaders exactly the pixels they made from the full-resolution sheets.
 * Here the browser redoes the old blits from assets/generated/ (the dev
 * server serves it) and compares them with what the game loaded: every
 * Commons-pass and runtime-pass native texture, the terrain tileset, every
 * decoration built from refitted samples, and every baked off-size sample.
 */

type Rect = { x: number; y: number; w: number; h: number }
type Frame = { key: string; source: string; width: number; height: number; sourceRect: Rect; destinationRect: Rect }
type Manifest = { sources: { key: string; file: string }[]; frames: Frame[] }

test('packed atlases hold exactly what the loaders blitted from the source sheets', async ({ page }) => {
  test.setTimeout(120_000)
  await beginNewJourney(page)
  const result = await page.evaluate(async () => {
    const w = window as unknown as { __fsDevTextureHash: (key: string) => string | null }
    const json = async <T,>(url: string) => (await (await fetch(url)).json()) as T
    const images = new Map<string, HTMLImageElement>()
    const image = async (url: string) => {
      if (!images.has(url)) {
        const img = new Image()
        img.src = url
        await img.decode()
        images.set(url, img)
      }
      return images.get(url)!
    }
    const hash = (c: HTMLCanvasElement) => {
      const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data
      let h = 2166136261
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619)
      return `${c.width}x${c.height}:${(h >>> 0).toString(16)}`
    }
    /** The old loaders' blit: a w×h canvas, smoothing off, measured rect → dest. */
    const blit = (img: CanvasImageSource, s: Rect, w: number, h: number, d: Rect, flipX = false) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.imageSmoothingEnabled = false
      if (flipX) {
        ctx.translate(d.x * 2 + d.w, 0)
        ctx.scale(-1, 1)
      }
      ctx.drawImage(img, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h)
      return c
    }
    const bad: string[] = []
    let checked = 0
    const check = (what: string, want: string, got: string | null) => {
      checked++
      if (want !== got) bad.push(`${what}: want ${want}, got ${got}`)
    }

    for (const [dir, prefix] of [
      ['commons-pass', 'commons-art:'],
      ['runtime-pass', ''],
      ['items-pass', 'items-art:'],
    ] as const) {
      const m = await json<Manifest>(`/assets/generated/${dir}/manifest.json`)
      const files = new Map(m.sources.map((s) => [s.key, `/assets/generated/${dir}/${s.file}`]))
      for (const f of m.frames) {
        const img = await image(files.get(f.source)!)
        check(prefix + f.key, hash(blit(img, f.sourceRect, f.width, f.height, f.destinationRect)), w.__fsDevTextureHash(prefix + f.key))
      }
    }

    // Terrain: createFingersnapTerrain's 4×4 tileset of 32-px cells.
    const em = await json<{ terrain: { tiles: Record<string, string> } }>('/assets/generated/expansion/manifest.json')
    const ta = await json<{ frames: Record<string, { frame: Rect }> }>('/assets/generated/expansion/fingersnap-terrain.atlas.json')
    const timg = await image('/assets/generated/expansion/fingersnap-terrain.png')
    const tc = document.createElement('canvas')
    tc.width = tc.height = 128
    const tctx = tc.getContext('2d')!
    tctx.imageSmoothingEnabled = false
    for (let i = 0; i < 16; i++) {
      const r = ta.frames[em.terrain.tiles[i]].frame
      tctx.drawImage(timg, r.x, r.y, r.w, r.h, (i % 4) * 32, Math.floor(i / 4) * 32, 32, 32)
    }
    check('fingersnap-terrain-runtime', hash(tc), w.__fsDevTextureHash('fingersnap-terrain-runtime'))

    // Every baked off-size sample, straight from the packed atlas.
    const commons = await json<Manifest>('/assets/generated/commons-pass/manifest.json')
    const byKey = new Map(commons.frames.map((f) => [f.key, f]))
    const files = new Map(commons.sources.map((s) => [s.key, `/assets/generated/commons-pass/${s.file}`]))
    const packed = await json<{ commons: { image: string; blits: Record<string, [number, number, number, number]> } }>('/assets/fingersnap/packed/atlases.json')
    const atlas = await image(`/assets/fingersnap/packed/${packed.commons.image}`)
    for (const [key, r] of Object.entries(packed.commons.blits)) {
      const m = /^(.+)@(\d+)x(\d+)(~f)?$/.exec(key)!
      const f = byKey.get(m[1])!
      const want = blit(await image(files.get(f.source)!), f.sourceRect, +m[2], +m[3], { x: 0, y: 0, w: +m[2], h: +m[3] }, !!m[4])
      const got = blit(atlas, { x: r[0], y: r[1], w: r[2], h: r[3] }, r[2], r[3], { x: 0, y: 0, w: r[2], h: r[3] })
      check(`blit ${key}`, hash(want), hash(got))
    }
    return { bad, checked }
  })
  expect(result.bad).toEqual([])
  expect(result.checked).toBeGreaterThan(380)
})
