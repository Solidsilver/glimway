/**
 * Bake the delivered art into game-size packed atlases:
 *
 *   node scripts/build-atlases.ts        (npm run atlases)
 *
 * Reads the source sheets and manifests under assets/generated/ (never
 * modified) and writes public/assets/fingersnap/packed/, swapping the whole
 * folder in only once the bake has succeeded: see src/game/atlas-plan.ts for
 * what each atlas holds and why.
 *
 * The baking runs in headless Chromium (Playwright's, already a dev
 * dependency). The canvas packs (the Commons, runtime and items passes, the
 * terrain) are dense: each native frame canvas is ART_DENSITY texels per
 * world px, its measured source rect box-filtered (area-averaged) into its
 * destination rect, so the game keeps the paintings' detail and draws them
 * nearest-neighbour at the same world size (src/game/density.ts). The
 * residents, the held tools and the mill wheel are cut out of their sheets
 * figure by figure (src/game/figures.ts) rather than by the delivered crops,
 * and fitted to one scale and anchor per group (src/game/atlas-plan.ts
 * PERSON_HEIGHT, HELD_LEAN, MILL_WALL). The GPU-scaled
 * atlases keep their nearest-neighbour blit at their largest
 * on-screen size. After writing, every frame is read back from the encoded
 * PNG and compared with the canvas it came from; any difference fails the
 * build. The dense packs then ship as lossless WebP (cwebp, dev machine
 * only): the build verifies the WebP decodes to exactly the PNG's texels
 * before writing it. The output is committed (deploy builds don't need a
 * browser), and tests/atlases.test.ts fails when an input changed without a
 * re-run.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import {
  ART_DENSITY,
  ATLAS_GENERATOR_VERSION,
  BACKDROPS,
  BUILDINGS,
  MAX_SCREEN_SCALE,
  SCALED_ATLASES,
  blitKey,
  commonsBlitPlan,
  GROUND_COLS,
  GROUND_FAMILIES,
  GROUND_TILES,
  HELD_SOURCE,
  POND_SIZE,
  POND_SOURCE,
  POND_TILES,
  HELD_LEAN,
  HELD_TEXELS,
  heldSheetRows,
  MILL_SHEET_ROWS,
  MILL_WALL,
  MILL_WALL_FOOT,
  MILL_WALL_STRIP,
  PEOPLE,
  PERSON_CANVAS,
  PERSON_FACINGS,
  PERSON_FOOT,
  PERSON_HEIGHT,
  personSheetRows,
  PLAYTEST1_DIR,
  PLAYTEST1_RECORDS,
  playtest1Records,
  type PackedManifest,
  type PackedPeople,
  type PackedRect,
} from '../src/game/atlas-plan.ts'
import { cellOf, flattenFamily, healFamily, setCell, type Rgba } from '../src/game/ground-heal.ts'
import type { CommonsPassManifest } from '../src/game/commons-pass.ts'
import type { RuntimeArtManifest } from '../src/game/runtime-art.ts'
import type { ItemsPassManifest } from '../src/game/items-pass.ts'
import { installDirs, installStaged } from './atlas-install.ts'
import { decodePng } from './png-decode.ts'
import { extractFigure, footPoint, grow, layoutFigures, overlap, placeAt, type Box, type Figure, type Rgba as SheetRgba } from '../src/game/figures.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKED = join(ROOT, 'public/assets/fingersnap/packed')
// Everything is written to a staging folder beside PACKED and swapped in whole
// once the bake has succeeded (./atlas-install.ts), so a failed run leaves the
// committed atlases as they were.
const DIRS = installDirs(PACKED)
const OUT = DIRS.staged
const ORIGIN = 'http://bake.local/'

const inputs: Record<string, string> = {}
function read(path: string): Buffer {
  const data = readFileSync(join(ROOT, path))
  inputs[path] = createHash('sha256').update(data).digest('hex')
  return data
}
const readJson = <T>(path: string): T => JSON.parse(read(path).toString('utf8')) as T

/**
 * One canvas to bake: a source crop sampled into a `w`×`h` canvas. `box`
 * area-averages the source into each texel (the dense canvas packs);
 * otherwise it's the old nearest-neighbour blit (the GPU-scaled atlases).
 */
interface Job {
  id: string
  src: string
  s: [number, number, number, number]
  w: number
  h: number
  d: [number, number, number, number]
  flipX?: boolean
  box?: boolean
  /** `src` is a figure cut out of its sheet in Node (`raw/<id>`, straight RGBA this size), not an image file. */
  raw?: [number, number]
}

/**
 * Figures cut out of their sheets (src/game/figures.ts), served to the bake
 * page as raw RGBA: a frame then samples its own figure's pixels and nothing
 * of a neighbouring cell.
 */
const rawSources = new Map<string, Buffer>()
function rawFigure(id: string, img: SheetRgba, f: Figure, region: Box): { src: string; raw: [number, number]; at: [number, number] } {
  const cut = extractFigure(img, f, region)
  const src = `raw/${id}`
  rawSources.set(src, Buffer.from(cut.data))
  return { src, raw: [cut.w, cut.h], at: [cut.x, cut.y] }
}

/** The union of two boxes. */
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/**
 * A figure named by a sheet's layout must be the one the delivered crop for
 * that name covers most of.
 */
function named(img: SheetRgba, figures: Map<string, Figure>, name: string, crop: Box): Figure {
  const f = figures.get(name)
  if (!f) throw new Error(`${name}: not on its sheet's layout`)
  const most = Math.max(...[...figures.values()].map((g) => overlap(img, g, crop)))
  if (overlap(img, f, crop) < most || most === 0) throw new Error(`${name}: the sheet's layout and its delivered crop disagree about which figure it is`)
  return f
}

/** A sheet's decoded texels, by path (each read once, and hashed as an input). */
const sheets = new Map<string, SheetRgba>()
function sheet(path: string): SheetRgba {
  if (!sheets.has(path)) sheets.set(path, decodePng(read(path)))
  return sheets.get(path)!
}

/** A pack job at ART_DENSITY: a native `w`×`h` world-px canvas, `d` in world px. */
function dense(id: string, src: string, s: [number, number, number, number], w: number, h: number, d: [number, number, number, number], flipX?: boolean): Job {
  const k = ART_DENSITY
  return { id, src, s, w: w * k, h: h * k, d: [d[0] * k, d[1] * k, d[2] * k, d[3] * k], flipX, box: true }
}

interface AtlasFrameJson {
  frame: { x: number; y: number; w: number; h: number }
  rotated: boolean
  trimmed: boolean
  spriteSourceSize: { x: number; y: number; w: number; h: number }
  sourceSize: { w: number; h: number }
  pivot?: { x: number; y: number }
}

/** Shelf-pack `w`×`h` boxes, tallest first, `pad` px apart. */
function pack(boxes: { id: string; w: number; h: number }[], pad: number): { size: [number, number]; at: Map<string, [number, number]> } {
  const area = boxes.reduce((a, b) => a + (b.w + pad) * (b.h + pad), 0)
  const width = Math.max(Math.ceil(Math.sqrt(area) * 1.15), ...boxes.map((b) => b.w + pad * 2))
  const at = new Map<string, [number, number]>()
  let x = pad
  let y = pad
  let row = 0
  for (const b of [...boxes].sort((a, b) => b.h - a.h || b.w - a.w || a.id.localeCompare(b.id))) {
    if (x + b.w + pad > width) {
      x = pad
      y += row + pad
      row = 0
    }
    at.set(b.id, [x, y])
    x += b.w + pad
    row = Math.max(row, b.h)
  }
  return { size: [width, y + row + pad], at }
}

async function main(): Promise<void> {
  // The dense packs ship as lossless WebP, so cwebp (and dwebp, which checks
  // the encodes) must be installed (the art build only runs on the dev
  // machine; the server never runs it).
  for (const tool of ['cwebp', 'dwebp']) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' })
    } catch {
      throw new Error(`${tool} not found: the atlas build encodes the dense packs as lossless WebP and verifies them — \`brew install webp\``)
    }
  }

  // ---- plan every canvas
  const commons = readJson<CommonsPassManifest>('assets/generated/commons-pass/manifest.json')
  const commonsSrc = new Map(commons.sources.map((s) => [s.key, `assets/generated/commons-pass/${s.file}`]))
  for (const path of commonsSrc.values()) read(path)
  const commonsJobs: Job[] = commons.frames.map((f) =>
    dense(f.key, commonsSrc.get(f.source)!, [f.sourceRect.x, f.sourceRect.y, f.sourceRect.w, f.sourceRect.h], f.width, f.height, [f.destinationRect.x, f.destinationRect.y, f.destinationRect.w, f.destinationRect.h]),
  )
  const byKey = new Map(commons.frames.map((f) => [f.key, f]))
  const blits = commonsBlitPlan(commons.frames)
  const blitJobs: Job[] = blits.map((b) => {
    const f = byKey.get(b.frame)!
    return dense(blitKey(b.frame, b.w, b.h, b.flipX), commonsSrc.get(f.source)!, [f.sourceRect.x, f.sourceRect.y, f.sourceRect.w, f.sourceRect.h], b.w, b.h, [0, 0, b.w, b.h], b.flipX)
  })

  const runtime = readJson<RuntimeArtManifest>('assets/generated/runtime-pass/manifest.json')
  const runtimeSrc = new Map(runtime.sources.map((s) => [s.key, `assets/generated/runtime-pass/${s.file}`]))
  for (const path of runtimeSrc.values()) read(path)
  const runtimeJobs: Job[] = runtime.frames.map((f) =>
    dense(f.key, runtimeSrc.get(f.source)!, [f.sourceRect.x, f.sourceRect.y, f.sourceRect.w, f.sourceRect.h], f.width, f.height, [f.destinationRect.x, f.destinationRect.y, f.destinationRect.w, f.destinationRect.h]),
  )

  const items = readJson<ItemsPassManifest>('assets/generated/items-pass/manifest.json')
  const itemsSrc = new Map(items.sources.map((s) => [s.key, `assets/generated/items-pass/${s.file}`]))
  for (const path of itemsSrc.values()) read(path)
  // The mill wheel's frames: one wall height and pivot, mirrored (MILL_WALL).
  const millFrame = items.frames.find((f) => f.key === 'mill-wheel-0')
  const millPath = millFrame && itemsSrc.get(millFrame.source)!
  const millFigures = millPath ? layoutFigures(sheet(millPath), MILL_SHEET_ROWS, 'items-pass Tolley mill sheet') : new Map<string, Figure>()
  const itemsJobs: Job[] = items.frames.map((f) => {
    const fig = f.key.startsWith('mill-wheel-') ? millFigures.get(f.key) : undefined
    if (!fig) return dense(f.key, itemsSrc.get(f.source)!, [f.sourceRect.x, f.sourceRect.y, f.sourceRect.w, f.sourceRect.h], f.width, f.height, [f.destinationRect.x, f.destinationRect.y, f.destinationRect.w, f.destinationRect.h])
    const img = sheet(millPath!)
    named(img, millFigures, f.key, f.sourceRect)
    // The wall: the solid rows of the figure's outer strip.
    let top = Infinity
    let bottom = -1
    for (const p of fig.pixels) {
      const x = p % img.w
      const y = (p - x) / img.w
      if (x < fig.x + fig.w - MILL_WALL_STRIP || img.data[p * 4 + 3] < 128) continue
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
    const k = ART_DENSITY
    const scale = (MILL_WALL * k) / (bottom + 1 - top)
    const [W, H] = [f.width * k, f.height * k]
    // Placed unmirrored at the mirror image of the pivot, then mirrored about the canvas.
    const { s, d } = placeAt(fig, { x: fig.x + fig.w, y: bottom + 1 }, [W - MILL_WALL_FOOT[0] * k, MILL_WALL_FOOT[1] * k], scale)
    const cut = rawFigure(f.key, img, fig, grow(fig, 2 / scale + 2))
    if (d[0] < 0 || d[1] < 0 || d[0] + d[2] > W || d[1] + d[3] > H) throw new Error(`${f.key}: the wheel (${d.join(', ')}) overflows its ${W}×${H} canvas`)
    return { id: f.key, src: cut.src, raw: cut.raw, s: [s[0] - cut.at[0], s[1] - cut.at[1], s[2], s[3]], w: W, h: H, d: [W - d[0] - d[2], d[1], d[2], d[3]], flipX: true, box: true }
  })

  // The 0.4 indoors pass is authored at 64 texels per 16px world tile. Keep
  // its requested native canvases whole in a separate source-density pack.
  // A piece is never stretched: props, effects, overlays and icons keep
  // their painted aspect, scaled to fit inside the destination rectangle the
  // manifest gives them and standing on its bottom centre (the first pass
  // gave the whole canvas; round 2b places each piece, e.g. a shelf under
  // the wall line). Only the tiling pieces (floors, walls) fill their cell,
  // since they must meet their neighbours.
  type IndoorsFrame = { key: string; source: string; role?: string; sourceRect: { x: number; y: number; w: number; h: number }; canvasSize: { w: number; h: number }; destinationRect: { x: number; y: number; w: number; h: number } }
  type IndoorsManifest = { sources: { key: string; file: string }[]; frames: IndoorsFrame[] }
  const indoors = readJson<IndoorsManifest>('assets/generated/indoors-pass/manifest.json')
  const indoorsSrc = new Map(indoors.sources.map((s) => [s.key, `assets/generated/indoors-pass/sheets/${s.file}`]))
  for (const path of indoorsSrc.values()) read(path)
  const indoorsJobs: Job[] = indoors.frames.map((f) => {
    const src = indoorsSrc.get(f.source)
    if (!src) throw new Error(`indoors-pass: ${f.key} has no source sheet ${f.source}`)
    const { w: sw, h: sh } = f.sourceRect
    const { w: cw, h: ch } = f.canvasSize
    const tiling = f.role === 'tile' || f.role === 'wall'
    const r = f.destinationRect
    const k = Math.min(r.w / sw, r.h / sh)
    const [dw, dh] = [Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k))]
    const d: Job['d'] = tiling ? [r.x, r.y, r.w, r.h] : [r.x + Math.floor((r.w - dw) / 2), r.y + r.h - dh, dw, dh]
    return { id: f.key, src, s: [f.sourceRect.x, f.sourceRect.y, sw, sh], w: cw, h: ch, d, box: true }
  })

  // The 0.5 crafts pass (ability icons and effects, the stable, fishing, HUD
  // icons) is delivered as normalized frames, each on its exact canvas at 64
  // texels per 16px world tile: packed whole, texel for texel, like the
  // indoors pass (src/game/crafts-art.ts makes the textures).
  type CraftsFrame = { file: string; canvasSize: { w: number; h: number } }
  const crafts = readJson<{ frames: Record<string, CraftsFrame> }>('assets/generated/crafts-pass/manifest.json')
  const craftsJobs: Job[] = Object.entries(crafts.frames).map(([id, f]) => {
    const src = `assets/generated/crafts-pass/${f.file}`
    read(src)
    const { w, h } = f.canvasSize
    return { id, src, s: [0, 0, w, h], w, h, d: [0, 0, w, h], box: true }
  })

  // The terrain tileset: 16 named cells → 4×4, one 16-px world tile each at
  // ART_DENSITY (64 texels at 4×). A cell delivered at that size is copied
  // texel for texel; larger paintings are box-filtered down.
  const expansion = readJson<{ terrain: { tiles: Record<string, string> } }>('assets/generated/expansion/manifest.json')
  const terrainAtlas = readJson<{ frames: Record<string, AtlasFrameJson> }>('assets/generated/expansion/fingersnap-terrain.atlas.json')
  read('assets/generated/expansion/fingersnap-terrain.png')
  const TILE = 16 * ART_DENSITY
  const terrainJobs: Job[] = Array.from({ length: 16 }, (_, i) => {
    const c = terrainAtlas.frames[expansion.terrain.tiles[i]].frame
    return dense(`cell-${i}`, 'assets/generated/expansion/fingersnap-terrain.png', [c.x, c.y, c.w, c.h], 16, 16, [0, 0, 16, 16])
  })

  // The playtest-1 pass: its measured frames (atlas.json; manifest.json only
  // counts them) and animations. Only the frames named there are sampled.
  type P1Frame = { source: string; x: number; y: number; w: number; h: number; destinationRect: { x: number; y: number; w: number; h: number }; handAnchor?: { x: number; y: number } }
  // Shared manifests: only the records of the frames in use count as inputs.
  const p1 = JSON.parse(readFileSync(join(ROOT, PLAYTEST1_DIR, 'atlas.json'), 'utf8')) as { frames: Record<string, P1Frame>; sources: Record<string, { file: string }> }
  const p1Anims = JSON.parse(readFileSync(join(ROOT, PLAYTEST1_DIR, 'animations.json'), 'utf8')) as { animations: PackedPeople['animations'] }
  inputs[PLAYTEST1_RECORDS] = createHash('sha256').update(playtest1Records(p1, p1Anims)).digest('hex')
  const p1Src = (key: string) => {
    const file = p1.sources[key]?.file
    if (!file) throw new Error(`playtest1-pass: atlas.json lists no source sheet ${key}`)
    return `${PLAYTEST1_DIR}/${file}`
  }
  const p1Frame = (name: string) => {
    const f = p1.frames[name]
    if (!f) throw new Error(`playtest1-pass: no frame ${name}`)
    return f
  }
  // Ground: each tile box-filtered to one world tile at ART_DENSITY, healed after baking.
  const pond = p1Frame(POND_SOURCE)
  const groundJobs: Job[] = GROUND_TILES.map((name) => {
    // The pond's tiles: one 64-texel quarter of the seamless bed each.
    const at = POND_TILES.indexOf(name)
    if (at >= 0) {
      read(p1Src(pond.source))
      const t = pond.w / POND_SIZE
      return dense(name, p1Src(pond.source), [pond.x + (at % POND_SIZE) * t, pond.y + Math.floor(at / POND_SIZE) * t, t, t], 16, 16, [0, 0, 16, 16])
    }
    const f = p1Frame(name)
    read(p1Src(f.source))
    return dense(name, p1Src(f.source), [f.x, f.y, f.w, f.h], 16, 16, [0, 0, 16, 16])
  })
  // People: each resident's frames are their figures on the sheet, found
  // afresh (src/game/figures.ts; the pass's measured crops cut figures in
  // half and span cells), drawn at one scale per person and facing
  // (PERSON_HEIGHT over the median height of that facing's frames) with
  // every figure's foot point on the canvas's (PERSON_FOOT), and only its
  // own pixels.
  const residentFrames = Object.keys(p1.frames).filter((n) => PEOPLE.some((id) => n.startsWith(`resident-${id}-`)))
  const heldFrames = Object.keys(p1.frames).filter((n) => n.startsWith('held-'))
  const fits: PackedPeople['fits'] = {}
  const [canvasW, canvasH] = [PERSON_CANVAS[0] * ART_DENSITY, PERSON_CANVAS[1] * ART_DENSITY]
  const residentJobs: Job[] = PEOPLE.flatMap((id) => {
    const rows = personSheetRows(id)
    const names = rows.flat()
    const missing = residentFrames.filter((n) => n.startsWith(`resident-${id}-`) && !names.includes(n))
    if (missing.length) throw new Error(`${id}: frames outside the sheet layout: ${missing.join(', ')}`)
    const img = sheet(p1Src(p1Frame(names[0]).source))
    const figures = layoutFigures(img, rows, `resident-${id} sheet`)
    // (No check against the delivered crops here: some of them cover more of a neighbour than of their own figure.)
    const facings = Object.fromEntries(
      PERSON_FACINGS.map((dir) => {
        const hs = names.filter((n) => n.startsWith(`resident-${id}-${dir}-`)).map((n) => figures.get(n)!.h).sort((x, y) => x - y)
        const measured = (hs[(hs.length - 1) >> 1] + hs[hs.length >> 1]) / 2
        return [dir, { measured, scale: (PERSON_HEIGHT[id] * ART_DENSITY) / measured }]
      }),
    )
    fits[id] = { height: PERSON_HEIGHT[id], facings: Object.fromEntries(Object.entries(facings).map(([dir, f]) => [dir, { measured: f.measured, scale: Number(f.scale.toFixed(6)) }])) }
    return names.map((name) => {
      const fig = figures.get(name)!
      const { scale } = facings[PERSON_FACINGS.find((dir) => name.startsWith(`resident-${id}-${dir}-`)) ?? 'down']
      const { s, d } = placeAt(fig, footPoint(img, fig), [PERSON_FOOT[0] * ART_DENSITY, PERSON_FOOT[1] * ART_DENSITY], scale)
      if (d[0] < 0 || d[1] < 0 || d[0] + d[2] > canvasW || d[1] + d[3] > canvasH) throw new Error(`${name}: the figure (${d.join(', ')}) overflows its ${canvasW}×${canvasH} canvas`)
      const cut = rawFigure(name, img, fig, grow(fig, 2 / scale + 2))
      return { id: name, src: cut.src, raw: cut.raw, s: [s[0] - cut.at[0], s[1] - cut.at[1], s[2], s[3]], w: canvasW, h: canvasH, d, box: true }
    })
  })
  // The held tools: the delivered crops and destination rects, sampling only
  // their own figure (the sheet's layout, heldSheetRows); grips are measured
  // on the baked art below.
  const heldImg = heldFrames.length ? sheet(p1Src(p1Frame(heldFrames[0]).source)) : null
  const heldFigures = heldImg ? layoutFigures(heldImg, heldSheetRows(), 'held-tools sheet') : new Map<string, Figure>()
  const heldJobs: (Job & { anchor: [number, number] })[] = heldFrames.map((name) => {
    const f = p1Frame(name)
    const fig = named(heldImg!, heldFigures, name, f)
    const cut = rawFigure(name, heldImg!, fig, grow(union(fig, f), 1))
    const s = HELD_TEXELS / HELD_SOURCE
    const r = f.destinationRect
    const x0 = Math.round(r.x * s)
    const y0 = Math.round(r.y * s)
    const d: [number, number, number, number] = [x0, y0, Math.round((r.x + r.w) * s) - x0, Math.round((r.y + r.h) * s) - y0]
    return { id: name, src: cut.src, raw: cut.raw, s: [f.x - cut.at[0], f.y - cut.at[1], f.w, f.h], w: HELD_TEXELS, h: HELD_TEXELS, d, box: true, anchor: [f.handAnchor!.x * s, f.handAnchor!.y * s] }
  })
  const peopleJobs: Job[] = [...residentJobs, ...heldJobs]
  // Buildings: each frame's whole canvas (texels at the pass's density),
  // its measured source box-filtered into its destination rect.
  type P1Building = P1Frame & { canvasSize: { w: number; h: number } }
  const buildingJobs: Job[] = BUILDINGS.map((name) => {
    const f = p1Frame(name) as P1Building
    read(p1Src(f.source))
    const r = f.destinationRect
    // The pass draws 4 texels a world px: world px = texels / 4.
    return dense(name, p1Src(f.source), [f.x, f.y, f.w, f.h], f.canvasSize.w / 4, f.canvasSize.h / 4, [r.x / 4, r.y / 4, r.w / 4, r.h / 4])
  })
  const animations = p1Anims.animations.filter((a) => a.frames.every((f) => residentFrames.includes(f)))

  // GPU-scaled atlases: each group at its largest on-screen size (never above source).
  const scaled = SCALED_ATLASES.map((plan) => {
    const atlas = readJson<{ frames: Record<string, AtlasFrameJson> }>(plan.json)
    read(plan.source)
    const frames: { name: string; k: number; f: AtlasFrameJson }[] = []
    for (const [name, f] of Object.entries(atlas.frames)) {
      const g = plan.groups.find((gr) => gr.frames.test(name))
      if (!g) throw new Error(`${plan.key}: no display size for frame ${name}`)
      const ref = atlas.frames[g.ref].frame
      const screen = g.screen ?? MAX_SCREEN_SCALE
      const k = Math.min(1, g.height ? (screen * g.height) / ref.h : (screen * g.width!) / ref.w)
      frames.push({ name, k, f })
    }
    const jobs: Job[] = frames.map(({ name, k, f }) => {
      const w = Math.max(1, Math.round(f.frame.w * k))
      const h = Math.max(1, Math.round(f.frame.h * k))
      return { id: name, src: plan.source, s: [f.frame.x, f.frame.y, f.frame.w, f.frame.h], w, h, d: [0, 0, w, h] }
    })
    return { plan, frames, jobs }
  })

  for (const b of BACKDROPS) read(b.source)

  // ---- bake in Chromium
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.route(`${ORIGIN}**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(1))
    if (path === '') return route.fulfill({ body: '<!doctype html><title>bake</title>', contentType: 'text/html' })
    if (rawSources.has(path)) return route.fulfill({ body: rawSources.get(path)!, contentType: 'application/octet-stream' })
    route.fulfill({ body: readFileSync(join(ROOT, path)), contentType: path.endsWith('.png') ? 'image/png' : 'application/octet-stream' })
  })
  await page.goto(ORIGIN)

  /**
   * Bake jobs, pack them, encode, read back and verify. Returns the PNG
   * data URL, and optionally the atlas canvas's raw texels (base64 RGBA) —
   * canvas-drawn content read back exactly, the same pixels the loaders'
   * PNG decode provably holds (the read-back check compares them).
   */
  const bake = async (jobs: Job[], positions: Map<string, [number, number]>, size: [number, number], wantRaw = false): Promise<{ url: string; raw?: string }> => {
    const placed = jobs.map((j) => ({ ...j, at: positions.get(j.id)! }))
    const result = await page.evaluate(
      async ({ placed, size, origin, wantRaw }) => {
        const images = new Map<string, HTMLImageElement>()
        const load = (url: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image()
            img.onload = () => resolve(img)
            img.onerror = () => reject(new Error(`cannot load ${url}`))
            img.src = url
          })
        // Source pixels, read once per sheet (box filtering); figures cut out in Node come as raw RGBA.
        const pixels = new Map<string, ImageData>()
        for (const j of placed) {
          if (j.raw) {
            if (!pixels.has(j.src)) pixels.set(j.src, new ImageData(new Uint8ClampedArray(await (await fetch(origin + j.src)).arrayBuffer()), j.raw[0], j.raw[1]))
          } else if (!images.has(j.src)) images.set(j.src, await load(origin + j.src))
        }
        const sourcePixels = (src: string) => {
          if (!pixels.has(src)) {
            const img = images.get(src)!
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const ctx = c.getContext('2d', { willReadFrequently: true })!
            ctx.drawImage(img, 0, 0)
            pixels.set(src, ctx.getImageData(0, 0, c.width, c.height))
          }
          return pixels.get(src)!
        }
        /** Each output texel's source span on one axis: [source index, overlap] pairs. */
        const spans = (s0: number, sn: number, n: number) =>
          Array.from({ length: n }, (_, i) => {
            const a = s0 + (i * sn) / n
            const b = s0 + ((i + 1) * sn) / n
            const out: [number, number][] = []
            for (let p = Math.floor(a); p < b; p++) out.push([p, Math.min(b, p + 1) - Math.max(a, p)])
            return out
          })
        /**
         * Area-average the source rect into a `dw`×`dh` ImageData: each texel
         * is the mean of the source it covers, colour weighted by alpha so a
         * transparent neighbour never darkens an edge.
         */
        const boxFilter = (src: ImageData, s: number[], dw: number, dh: number, flipX: boolean) => {
          const out = new ImageData(dw, dh)
          const xs = spans(s[0], s[2], dw)
          const ys = spans(s[1], s[3], dh)
          const d = src.data
          for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
              let r = 0, g = 0, b = 0, a = 0, t = 0
              for (const [sy, wy] of ys[y]) {
                for (const [sx, wx] of xs[x]) {
                  const w = wx * wy
                  const i = (sy * src.width + sx) * 4
                  const al = d[i + 3] * w
                  r += d[i] * al
                  g += d[i + 1] * al
                  b += d[i + 2] * al
                  a += al
                  t += w
                }
              }
              const o = (y * dw + (flipX ? dw - 1 - x : x)) * 4
              if (a > 0) {
                out.data[o] = Math.round(r / a)
                out.data[o + 1] = Math.round(g / a)
                out.data[o + 2] = Math.round(b / a)
                out.data[o + 3] = Math.round(a / t)
              }
            }
          }
          return out
        }
        const atlas = document.createElement('canvas')
        atlas.width = size[0]
        atlas.height = size[1]
        const actx = atlas.getContext('2d')!
        actx.imageSmoothingEnabled = false
        const canvases: HTMLCanvasElement[] = []
        for (const j of placed) {
          const c = document.createElement('canvas')
          c.width = j.w
          c.height = j.h
          const ctx = c.getContext('2d')!
          ctx.imageSmoothingEnabled = false
          if (j.box) {
            // The source crop box-filtered into the destination rect (mirrored in place).
            ctx.putImageData(boxFilter(sourcePixels(j.src), j.s, j.d[2], j.d[3], !!j.flipX), j.d[0], j.d[1])
          } else {
            // Nearest neighbour, the loaders' old blit.
            if (j.flipX) {
              ctx.translate(j.d[0] * 2 + j.d[2], 0)
              ctx.scale(-1, 1)
            }
            ctx.drawImage(images.get(j.src)!, j.s[0], j.s[1], j.s[2], j.s[3], j.d[0], j.d[1], j.d[2], j.d[3])
          }
          actx.drawImage(c, j.at[0], j.at[1])
          canvases.push(c)
        }
        const url = atlas.toDataURL('image/png')
        // Read the encoded atlas back the way the loaders do (copy a rect into
        // a fresh canvas) and compare with the canvas each frame came from.
        const back = await load(url)
        const bad: string[] = []
        placed.forEach((j, i) => {
          const c = document.createElement('canvas')
          c.width = j.w
          c.height = j.h
          const ctx = c.getContext('2d', { willReadFrequently: true })!
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(back, j.at[0], j.at[1], j.w, j.h, 0, 0, j.w, j.h)
          const a = ctx.getImageData(0, 0, j.w, j.h).data
          const b = canvases[i].getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, j.w, j.h).data
          for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { bad.push(j.id); break }
        })
        // The atlas canvas's raw texels, for the WebP decode check (base64 RGBA).
        let raw: string | undefined
        if (wantRaw) {
          const data = actx.getImageData(0, 0, size[0], size[1]).data
          let bin = ''
          for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
          raw = btoa(bin)
        }
        return { url, bad, raw }
      },
      { placed, size, origin: ORIGIN, wantRaw },
    )
    if (result.bad.length) throw new Error(`encoded atlas differs from its canvases: ${result.bad.join(', ')}`)
    return result
  }

  /**
   * cwebp's lossless encoding of a pack PNG (`-exact` keeps transparent
   * texels' RGB), with its exact decoded texels: dwebp's PAM dump is the
   * untouched decode (2D-canvas reads premultiply WebP, which rounds
   * low-alpha RGB, so the check can't go through one).
   */
  const encodeWebp = (png: Buffer): { webp: Buffer; w: number; h: number; rgba: Buffer } => {
    const dir = mkdtempSync(join(tmpdir(), 'glimway-cwebp-'))
    try {
      const src = join(dir, 'pack.png')
      writeFileSync(src, png)
      execFileSync('cwebp', ['-lossless', '-z', '9', '-exact', '-quiet', src, '-o', join(dir, 'pack.webp')])
      const webp = readFileSync(join(dir, 'pack.webp'))
      execFileSync('dwebp', [join(dir, 'pack.webp'), '-pam', '-quiet', '-o', join(dir, 'pack.pam')])
      const pam = readFileSync(join(dir, 'pack.pam'))
      const mark = 'ENDHDR\n'
      const end = pam.indexOf(mark) + mark.length
      const field = (k: string): number => {
        const m = new RegExp(`^${k} (\\d+)$`, 'm').exec(pam.subarray(0, end).toString('latin1'))
        if (!m) throw new Error(`unexpected PAM header from dwebp (no ${k})`)
        return Number(m[1])
      }
      const depth = field('DEPTH')
      if (depth !== 4) throw new Error(`dwebp decoded ${depth} channels, expected RGBA`)
      return { webp, w: field('WIDTH'), h: field('HEIGHT'), rgba: pam.subarray(end) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * Bake a dense pack and ship it as lossless WebP only: the WebP must
   * decode to exactly the same texels as the PNG (which the read-back check
   * above already holds to the baked canvases), or the build fails.
   */
  const bakeDenseWebp = async (name: string, jobs: Job[], positions: Map<string, [number, number]>, size: [number, number]): Promise<string> => {
    const { url, raw } = await bake(jobs, positions, size, true)
    const { webp, w, h, rgba } = encodeWebp(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    const expect = Buffer.from(raw!, 'base64')
    if (w !== size[0] || h !== size[1] || !rgba.equals(expect)) {
      let at = 0
      while (at < rgba.length && rgba[at] === expect[at]) at++
      const p = Math.floor(at / 4)
      throw new Error(
        `${name}.webp does not decode to the PNG's texels: ${w}×${h} vs ${size[0]}×${size[1]}, texel (${p % size[0]}, ${Math.floor(p / size[0])}) channel ${at % 4}: ${expect[at]} → ${rgba[at]}`,
      )
    }
    writeFileSync(join(OUT, `${name}.webp`), webp)
    return `${name}.webp`
  }

  /**
   * Ship opaque texels worked on in Node (the healed ground) as lossless
   * WebP: a PNG drawn from them in the page, encoded, and the WebP's decode
   * checked against the texels.
   */
  const encodeRawWebp = async (name: string, raw: Buffer, size: [number, number], allowAlpha = false): Promise<string> => {
    if (!allowAlpha) for (let i = 3; i < raw.length; i += 4) if (raw[i] !== 255) throw new Error(`${name}: texels must be opaque`)
    const url = await page.evaluate(
      ({ b64, w, h }) => {
        const bin = atob(b64)
        const data = new Uint8ClampedArray(bin.length)
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0)
        return c.toDataURL('image/png')
      },
      { b64: raw.toString('base64'), w: size[0], h: size[1] },
    )
    const { webp, w, h, rgba } = encodeWebp(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    if (w !== size[0] || h !== size[1] || !rgba.equals(raw)) throw new Error(`${name}.webp does not decode to its texels`)
    writeFileSync(join(OUT, `${name}.webp`), webp)
    return `${name}.webp`
  }

  const rects = (jobs: Job[], at: Map<string, [number, number]>): Record<string, PackedRect> =>
    Object.fromEntries(jobs.map((j) => [j.id, [...at.get(j.id)!, j.w, j.h] as PackedRect]))

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  // Canvas packs: frames are copied out whole, so no padding is needed.
  const cAll = [...commonsJobs, ...blitJobs]
  const cPack = pack(cAll.map((j) => ({ id: j.id, w: j.w, h: j.h })), 0)
  const commonsImage = await bakeDenseWebp('commons', cAll, cPack.at, cPack.size)
  const rPack = pack(runtimeJobs.map((j) => ({ id: j.id, w: j.w, h: j.h })), 0)
  const runtimeImage = await bakeDenseWebp('runtime', runtimeJobs, rPack.at, rPack.size)
  const iPack = pack(itemsJobs.map((j) => ({ id: j.id, w: j.w, h: j.h })), 0)
  const itemsImage = await bakeDenseWebp('items', itemsJobs, iPack.at, iPack.size)
  const indoorPack = pack(indoorsJobs.map((j) => ({ id: j.id, w: j.w, h: j.h })), 0)
  const indoorsBaked = await bake(indoorsJobs, indoorPack.at, indoorPack.size, true)
  const indoorsRaw = Buffer.from(indoorsBaked.raw!, 'base64')
  const indoorsPixels: Rgba = { w: indoorPack.size[0], h: indoorPack.size[1], data: new Uint8Array(indoorsRaw) }
  const extractIndoor = (id: string): Rgba => {
    const [x, y, w, h] = [...indoorPack.at.get(id)!, indoorsJobs.find((j) => j.id === id)!.w, indoorsJobs.find((j) => j.id === id)!.h]
    const data = new Uint8Array(w * h * 4)
    for (let row = 0; row < h; row++) data.set(indoorsPixels.data.subarray(((y + row) * indoorsPixels.w + x) * 4, ((y + row) * indoorsPixels.w + x + w) * 4), row * w * 4)
    return { w, h, data }
  }
  const putIndoor = (id: string, tile: Rgba): void => {
    const [x, y] = indoorPack.at.get(id)!
    for (let row = 0; row < tile.h; row++) indoorsPixels.data.set(tile.data.subarray(row * tile.w * 4, (row + 1) * tile.w * 4), ((y + row) * indoorsPixels.w + x) * 4)
  }
  for (const family of [['plank-floor-0', 'plank-floor-1', 'plank-floor-2', 'plank-floor-3'], ['flagstone-floor-0', 'flagstone-floor-1', 'flagstone-floor-2', 'flagstone-floor-3']]) {
    const healed = healFamily(family.map(extractIndoor))
    family.forEach((id, i) => putIndoor(id, healed[i]))
  }
  const indoorsImage = await encodeRawWebp('indoors', Buffer.from(indoorsPixels.data), indoorPack.size, true)
  const crPack = pack(craftsJobs.map((j) => ({ id: j.id, w: j.w, h: j.h })), 0)
  const craftsBaked = await bake(craftsJobs, crPack.at, crPack.size, true)
  const craftsImage = await encodeRawWebp('crafts', Buffer.from(craftsBaked.raw!, 'base64'), crPack.size, true)
  const bPack = pack(buildingJobs.map((j) => ({ id: j.id, w: j.w, h: j.h })), 0)
  const buildingsImage = await bakeDenseWebp('buildings', buildingJobs, bPack.at, bPack.size)
  const tAt = new Map(terrainJobs.map((j, i) => [j.id, [(i % 4) * TILE, Math.floor(i / 4) * TILE] as [number, number]]))
  const terrainImage = await bakeDenseWebp('terrain', terrainJobs, tAt, [TILE * 4, TILE * 4])

  // The playtest-1 ground: baked, then each family healed (src/game/ground-heal.ts)
  // in Node, then encoded from those texels. ATLAS_NO_HEAL=1 skips the
  // healing (a comparison build; never commit one).
  const heal = process.env.ATLAS_NO_HEAL !== '1'
  const gRows = Math.ceil(GROUND_TILES.length / GROUND_COLS)
  const gSize: [number, number] = [GROUND_COLS * TILE, gRows * TILE]
  const gAt = new Map(groundJobs.map((j, i) => [j.id, [(i % GROUND_COLS) * TILE, Math.floor(i / GROUND_COLS) * TILE] as [number, number]]))
  const gRaw = Buffer.from((await bake(groundJobs, gAt, gSize, true)).raw!, 'base64')
  const gAtlas: Rgba = { w: gSize[0], h: gSize[1], data: gRaw }
  if (heal) {
    for (const fam of GROUND_FAMILIES) {
      if (fam.heal === false) continue
      const idx = fam.tiles.map((t) => GROUND_TILES.indexOf(t))
      const healed = healFamily(flattenFamily(idx.map((i) => cellOf(gAtlas, i, TILE, GROUND_COLS)), fam.flatten ?? 0))
      idx.forEach((i, n) => setCell(gAtlas, i, TILE, GROUND_COLS, healed[n]))
    }
  }
  // Spare cells past the last tile: opaque black (the pack is opaque).
  for (let i = GROUND_TILES.length; i < gRows * GROUND_COLS; i++) setCell(gAtlas, i, TILE, GROUND_COLS, { w: TILE, h: TILE, data: new Uint8Array(TILE * TILE * 4).map((_, j) => (j % 4 === 3 ? 255 : 0)) })
  const groundImage = await encodeRawWebp('ground', gRaw, gSize)

  // The playtest-1 people: baked whole once to find each frame's opaque box
  // (rounded out to 4 texels, so 2× and 1× copies stay exact), then baked
  // trimmed and shelf-packed (2 texels apart, rounded to 4). The held tools'
  // grips and leaning are measured on the whole bake; a tool leaning right is
  // mirrored (HELD_LEAN) and the whole bake done again.
  const untrimmedCols = 16
  const pW = Math.max(...peopleJobs.map((j) => j.w))
  const pH = Math.max(...peopleJobs.map((j) => j.h))
  const uAt = new Map(peopleJobs.map((j, i) => [j.id, [(i % untrimmedCols) * pW, Math.floor(i / untrimmedCols) * pH] as [number, number]]))
  const uSize: [number, number] = [untrimmedCols * pW, Math.ceil(peopleJobs.length / untrimmedCols) * pH]
  const bakeWhole = async () => {
    const raw = Buffer.from((await bake(peopleJobs, uAt, uSize, true)).raw!, 'base64')
    return (j: Job, x: number, y: number): number => {
      const [ax, ay] = uAt.get(j.id)!
      return raw[((ay + y) * uSize[0] + ax + x) * 4 + 3]
    }
  }
  /**
   * A held frame's grip (canvas texels): the solid texel nearest the
   * delivered hand anchor, centred across the solid run (the handle) it's in;
   * and how far the art's centre leans from it.
   */
  const gripOf = (alpha: (j: Job, x: number, y: number) => number, j: Job, anchor: [number, number]): { hand: [number, number]; lean: number } => {
    let best: [number, number] | null = null
    let bd = Infinity
    let sx = 0
    let sa = 0
    for (let y = 0; y < j.h; y++)
      for (let x = 0; x < j.w; x++) {
        const a = alpha(j, x, y)
        sx += (x + 0.5) * a
        sa += a
        if (a < 128) continue
        const dist = (x + 0.5 - anchor[0]) ** 2 + (y + 0.5 - anchor[1]) ** 2
        if (dist < bd) {
          bd = dist
          best = [x, y]
        }
      }
    if (!best) throw new Error(`${j.id}: no solid texel to grip`)
    let [x0, x1] = [best[0], best[0]]
    while (x0 > 0 && alpha(j, x0 - 1, best[1]) >= 128) x0--
    while (x1 < j.w - 1 && alpha(j, x1 + 1, best[1]) >= 128) x1++
    const hand: [number, number] = [(x0 + x1 + 1) / 2, best[1] + 0.5]
    return { hand, lean: sx / sa - hand[0] }
  }
  let alphaAt = await bakeWhole()
  for (const j of heldJobs) {
    if (gripOf(alphaAt, j, j.anchor).lean <= HELD_LEAN) continue
    j.flipX = true
    j.d = [j.w - j.d[0] - j.d[2], j.d[1], j.d[2], j.d[3]]
    j.anchor = [j.w - j.anchor[0], j.anchor[1]]
  }
  if (heldJobs.some((j) => j.flipX)) alphaAt = await bakeWhole()
  const hands = new Map(heldJobs.map((j) => {
    const g = gripOf(alphaAt, j, j.anchor)
    if (g.lean > HELD_LEAN) throw new Error(`${j.id}: still leans right of its grip after mirroring`)
    return [j.id, g.hand]
  }))
  const trim = new Map<string, [number, number, number, number]>()
  for (const j of peopleJobs) {
    let x0 = j.w, y0 = j.h, x1 = -1, y1 = -1
    for (let y = 0; y < j.h; y++)
      for (let x = 0; x < j.w; x++)
        if (alphaAt(j, x, y) > 0) {
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x)
          y1 = Math.max(y1, y)
        }
    if (x1 < 0) throw new Error(`${j.id}: empty frame`)
    const tx = Math.floor(x0 / 4) * 4
    const ty = Math.floor(y0 / 4) * 4
    trim.set(j.id, [tx, ty, Math.ceil((x1 + 1) / 4) * 4 - tx, Math.ceil((y1 + 1) / 4) * 4 - ty])
  }
  const trimmedJobs: Job[] = peopleJobs.map((j) => {
    const [tx, ty, tw, th] = trim.get(j.id)!
    return { ...j, w: tw, h: th, d: [j.d[0] - tx, j.d[1] - ty, j.d[2], j.d[3]] }
  })
  const pPack = pack(trimmedJobs.map((j) => ({ id: j.id, w: j.w + 2, h: j.h + 2 })), 2)
  const pAt = new Map([...pPack.at].map(([id, [x, y]]) => [id, [Math.ceil(x / 4) * 4, Math.ceil(y / 4) * 4] as [number, number]]))
  const pSize: [number, number] = [Math.ceil((Math.max(...trimmedJobs.map((j) => pAt.get(j.id)![0] + j.w)) + 2) / 4) * 4, Math.ceil((Math.max(...trimmedJobs.map((j) => pAt.get(j.id)![1] + j.h)) + 2) / 4) * 4]
  for (const a of trimmedJobs) for (const b of trimmedJobs) {
    if (a === b) continue
    const [ax, ay] = pAt.get(a.id)!
    const [bx, by] = pAt.get(b.id)!
    if (ax < bx + b.w && bx < ax + a.w && ay < by + b.h && by < ay + a.h) throw new Error(`people pack: ${a.id} overlaps ${b.id}`)
  }
  const peopleImage = await bakeDenseWebp('people', trimmedJobs, pAt, pSize)
  const people: PackedPeople = {
    image: peopleImage,
    size: pSize,
    density: ART_DENSITY,
    frames: Object.fromEntries(
      peopleJobs.map((j) => {
        const [tx, ty, tw, th] = trim.get(j.id)!
        const [x, y] = pAt.get(j.id)!
        const hand = hands.get(j.id)
        return [j.id, { frame: [x, y, tw, th], at: [tx, ty], source: [j.w, j.h], ...(hand ? { hand } : {}) }]
      }),
    ),
    fits,
    animations,
  }

  // GPU-scaled atlases: 2 px apart so scaled sampling never reaches a neighbour.
  const atlases: PackedManifest['atlases'] = {}
  for (const { plan, frames, jobs } of scaled) {
    const p = pack(jobs.map((j) => ({ id: j.id, w: j.w, h: j.h })), 2)
    const baked = await bake(jobs, p.at, p.size)
    writeFileSync(join(OUT, `${plan.key}.png`), Buffer.from(baked.url.slice(baked.url.indexOf(',') + 1), 'base64'))
    const out: Record<string, AtlasFrameJson> = {}
    for (const { name, k, f } of frames) {
      const j = jobs.find((x) => x.id === name)!
      const [x, y] = p.at.get(name)!
      const sx = Math.round(f.spriteSourceSize.x * k)
      const sy = Math.round(f.spriteSourceSize.y * k)
      out[name] = {
        frame: { x, y, w: j.w, h: j.h },
        rotated: false,
        trimmed: f.trimmed,
        spriteSourceSize: { x: sx, y: sy, w: j.w, h: j.h },
        sourceSize: { w: Math.max(Math.round(f.sourceSize.w * k), sx + j.w), h: Math.max(Math.round(f.sourceSize.h * k), sy + j.h) },
        ...(f.pivot ? { pivot: f.pivot } : {}),
      }
    }
    writeFileSync(
      join(OUT, `${plan.key}.json`),
      JSON.stringify({ frames: out, meta: { app: 'Glimway build-atlases', image: `${plan.key}.png`, format: 'RGBA8888', size: { w: p.size[0], h: p.size[1] }, scale: '1' } }, null, 1) + '\n',
    )
    atlases[plan.key] = { image: `${plan.key}.png`, json: `${plan.key}.json` }
  }

  // Illustrations: the largest size they're shown at, as WebP (they're
  // painted scenes drawn smoothed, never pixel art).
  const backdrops: Record<string, string> = {}
  for (const b of BACKDROPS) {
    const url = await page.evaluate(
      async ({ src, width, origin }) => {
        const img = new Image()
        img.src = origin + src
        await img.decode()
        const w = Math.min(width, img.naturalWidth)
        const h = Math.round((img.naturalHeight * w) / img.naturalWidth)
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d')!
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, w, h)
        return c.toDataURL('image/webp', 0.9)
      },
      { src: b.source, width: b.width, origin: ORIGIN },
    )
    if (!url.startsWith('data:image/webp')) throw new Error('this Chromium cannot encode WebP')
    const file = `${b.key}.webp`
    writeFileSync(join(OUT, file), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    backdrops[b.key] = file
  }
  await browser.close()

  const manifest: PackedManifest & { generatorVersion: number; plan: unknown } = {
    version: 1,
    generator: 'scripts/build-atlases.ts',
    generatorVersion: ATLAS_GENERATOR_VERSION,
    inputs: Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))),
    // The images written, by content: the game's ground paint caches key on these.
    outputs: Object.fromEntries(
      readdirSync(OUT)
        .filter((f) => /\.(webp|png)$/.test(f))
        .sort()
        .map((f) => [f, createHash('sha256').update(readFileSync(join(OUT, f))).digest('hex')]),
    ),
    // What the plan asked for (the staleness test re-derives it).
    plan: {
      density: ART_DENSITY,
      maxScreenScale: MAX_SCREEN_SCALE,
      blits: blits.map((b) => blitKey(b.frame, b.w, b.h, b.flipX)).sort(),
      scaled: Object.fromEntries(scaled.map(({ plan, frames }) => [plan.key, Object.fromEntries(frames.map(({ name, k }) => [name, Number(k.toFixed(6))]))])),
      backdrops: BACKDROPS,
    },
    commons: { image: commonsImage, size: cPack.size, density: ART_DENSITY, frames: rects(commonsJobs, cPack.at), blits: rects(blitJobs, cPack.at) },
    runtime: { image: runtimeImage, size: rPack.size, density: ART_DENSITY, frames: rects(runtimeJobs, rPack.at) },
    items: { image: itemsImage, size: iPack.size, density: ART_DENSITY, frames: rects(itemsJobs, iPack.at) },
    indoors: { image: indoorsImage, size: indoorPack.size, density: 64, frames: rects(indoorsJobs, indoorPack.at) },
    crafts: { image: craftsImage, size: crPack.size, density: 64, frames: rects(craftsJobs, crPack.at) },
    terrain: { image: terrainImage, size: [TILE * 4, TILE * 4], cell: TILE, density: ART_DENSITY },
    ground: { image: groundImage, size: gSize, cell: TILE, density: ART_DENSITY, cols: GROUND_COLS, tiles: Object.fromEntries(GROUND_TILES.map((t, i) => [t, i])), healed: heal },
    people,
    buildings: { image: buildingsImage, size: bPack.size, density: ART_DENSITY, frames: rects(buildingJobs, bPack.at) },
    atlases,
    backdrops,
  }
  writeFileSync(join(OUT, 'atlases.json'), JSON.stringify(manifest, null, 1) + '\n')
  installStaged(PACKED, DIRS)
  console.log(`packed ${commonsJobs.length} + ${blitJobs.length} commons, ${runtimeJobs.length} runtime, ${itemsJobs.length} items, 16 terrain cells, ${groundJobs.length} ground tiles (${heal ? "healed" : "NOT healed"}), ${peopleJobs.length} people frames, ${buildingJobs.length} buildings, ${craftsJobs.length} crafts, ${scaled.length} scaled atlases, ${BACKDROPS.length} backdrops → ${PACKED}`)
}

try {
  await main()
} finally {
  rmSync(OUT, { recursive: true, force: true })
}
