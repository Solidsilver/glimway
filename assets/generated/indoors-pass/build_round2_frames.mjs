import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = new URL('.', import.meta.url).pathname
const dir = (p) => join(root, p)
const cropsDir = dir('sheets/round2-crops')
mkdirSync(cropsDir, { recursive: true })

const sourceSheets = {
  lib: 'library-round2-alpha.png',
  kit: 'shared-kit-round2-alpha.png',
  kitchen: 'kitchen-round2-alpha.png',
  mill: 'mill-loft-round2-alpha.png',
}

// x, y, w, h are measured on the 1536×1024 generated sheets. `fit` is the
// requested native texel canvas; images are contained without stretching.
const jobs = []
function add(key, source, crop, fit, detail) {
  jobs.push({ key, source, crop, fit, ...detail })
}

// Library: front-facing back-wall shelves, side-wall bookshelves, the alcove,
// Elara's two desk states and the four exact section plaques.
for (const [state, x] of [['sparse', 394], ['half', 670], ['full', 946]]) {
  add(`library-shelf-front-${state}`, 'lib', [x, 9, 225, 390], [128, 192], { id: 'library-shelf-tall', facing: 'front', state, artBox: [128, 128], artOffsetY: 64, footprint: [2, 1], base: [0, 0.75, 2, 0.25], size: 'large', mount: 'floor', offers: { shelves: 6 }, tags: ['books', `library-fill:${state}`] })
}
const tallSide = [
  ['sparse', 'left', 66, 90], ['sparse', 'right', 205, 85],
  ['half', 'left', 360, 93], ['half', 'right', 499, 94],
  ['full', 'left', 656, 96], ['full', 'right', 792, 95],
]
for (const [state, facing, x, w] of tallSide) add(`library-shelf-tall-${facing}-${state}`, 'lib', [x, 417, w, 213], [64, 192], { id: 'library-shelf-tall', facing, state, artBox: [64, 128], artOffsetY: 64, footprint: [1, 1], base: [0, 0.5, 1, 0.5], size: 'large', mount: 'floor', offers: { shelves: 4 }, tags: ['books', 'side-wall'] })
const shortSide = [['sparse', 'left', 953, 85, 178], ['sparse', 'right', 1079, 82, 179], ['half', 'left', 1242, 90, 182], ['half', 'right', 1378, 85, 178], ['full', 'left', 656, 96, 213], ['full', 'right', 792, 95, 213]]
for (const [state, facing, x, w, h] of shortSide) add(`library-shelf-short-${facing}-${state}`, 'lib', [x, state === 'full' ? 417 : 440, w, h], [64, 128], { id: 'library-shelf-short', facing, state, artBox: [64, 64], artOffsetY: 64, footprint: [1, 1], base: [0, 0.5, 1, 0.5], size: 'medium', mount: 'wall', offers: { shelves: 2 }, tags: ['books', 'side-wall'] })
add('library-reading-nook-front-default', 'lib', [64, 653, 485, 330], [192, 192], { id: 'library-reading-nook', facing: 'front', state: 'default', footprint: [3, 2], base: [0, 1.5, 3, 0.5], size: 'large', mount: 'wall', offers: { top: 2 }, tags: ['seat', 'light', 'library-signature'] })
add('library-elara-desk-front-empty', 'lib', [592, 713, 303, 279], [128, 128], { id: 'library-elara-desk', facing: 'front', state: 'empty', footprint: [2, 1], base: [0, 0.5, 2, 0.5], size: 'large', mount: 'floor', offers: { top: 3 }, tags: ['desk', 'library-signature'] })
add('library-elara-desk-front-seated', 'lib', [921, 649, 294, 343], [128, 128], { id: 'library-elara-desk', facing: 'front', state: 'elara-seated', footprint: [2, 1], base: [0, 0.5, 2, 0.5], size: 'large', mount: 'floor', offers: { top: 3 }, tags: ['desk', 'resident-state', 'library-signature'] })
for (const [label, y] of [['stories', 650], ['histories', 730], ['recipes', 810], ['field-notes', 890]]) add(`library-section-sign-front-${label}`, 'lib', [1240, y, 235, 76], [192, 64], { id: `library-section-sign-${label}`, facing: 'front', state: 'default', footprint: [3, 1], base: [0, 0.75, 3, 0.25], size: 'small', mount: 'wall', tags: [`section:${label}`] })

// Shared interior furnishing kit; each piece has a stable kit id and a frame
// naming convention of <piece>-<facing>-<state>.
const kit = (key, id, crop, fit, extra = {}) => add(key, 'kit', crop, fit, { id, facing: 'front', state: 'default', footprint: [1, 1], base: [0, 0.75, 1, 0.25], size: 'small', mount: 'floor', ...extra })
kit('rug-woven-front-default', 'rug-woven', [94, 60, 383, 156], [192, 128], { footprint: [3, 2], base: [0, 1.75, 3, 0.25], size: 'large', layer: 'under' })
kit('rug-braided-front-default', 'rug-braided', [538, 55, 390, 169], [192, 128], { footprint: [3, 2], base: [0, 1.75, 3, 0.25], size: 'large', layer: 'under' })
kit('rug-patchwork-front-default', 'rug-patchwork', [966, 56, 509, 168], [256, 128], { footprint: [4, 2], base: [0, 1.75, 4, 0.25], size: 'large', layer: 'under' })
kit('shelf-generic-front-default', 'shelf-generic-front', [74, 257, 296, 204], [128, 192], { footprint: [2, 1], base: [0, 0.5, 2, 0.5], size: 'large', mount: 'wall', offers: { shelves: 6 } })
kit('shelf-generic-left-default', 'shelf-generic-side', [815, 273, 101, 193], [64, 128], { facing: 'left', footprint: [1, 1], base: [0, 0.5, 1, 0.5], size: 'medium', mount: 'wall', offers: { shelves: 3 } })
kit('shelf-generic-right-default', 'shelf-generic-side', [815, 273, 101, 193], [64, 128], { facing: 'right', footprint: [1, 1], base: [0, 0.5, 1, 0.5], size: 'medium', mount: 'wall', offers: { shelves: 3 }, flip: true })
kit('wall-pegs-front-tools', 'wall-pegs-tools', [978, 268, 325, 252], [192, 128], { footprint: [3, 1], base: [0, 0.8, 3, 0.2], size: 'medium', mount: 'wall' })
kit('crate-front-default', 'crate', [39, 535, 186, 173], [64, 64], { size: 'medium', offers: { top: 1 } })
kit('barrel-front-default', 'barrel', [248, 517, 161, 190], [64, 64], { size: 'medium', offers: { top: 1 } })
kit('sack-large-front-upright', 'sack-large', [414, 510, 151, 193], [64, 64], { size: 'medium', base: [0, 0.75, 1, 0.25] })
kit('sack-large-front-slumped', 'sack-large', [570, 549, 117, 154], [64, 64], { state: 'slumped', size: 'medium', base: [0, 0.75, 1, 0.25] })
kit('basket-front-default', 'basket', [713, 599, 155, 110], [64, 64], { size: 'small' })
kit('plant-leafy-front-default', 'plant-leafy', [883, 545, 151, 194], [64, 96], { size: 'small' })
kit('plant-flowering-front-default', 'plant-flowering', [1040, 550, 113, 160], [64, 96], { size: 'small' })
kit('lamp-oil-front-default', 'lamp-oil', [1174, 545, 102, 164], [64, 96], { size: 'small', tags: ['light'] })
kit('candle-holder-front-default', 'candle-holder', [1304, 545, 104, 165], [64, 96], { size: 'small', tags: ['light'] })
kit('candle-stick-front-default', 'candle-stick', [1420, 540, 116, 170], [64, 96], { size: 'small', tags: ['light'] })
kit('picture-frame-front-default', 'picture-frame', [26, 755, 183, 180], [64, 96], { size: 'small', mount: 'wall', footprint: [1, 1] })
kit('calendar-front-default', 'calendar', [232, 743, 119, 201], [64, 96], { size: 'small', mount: 'wall', footprint: [1, 1] })
kit('curtains-front-default', 'curtains', [371, 741, 231, 224], [128, 128], { size: 'medium', mount: 'wall', footprint: [2, 1] })
kit('side-table-front-default', 'side-table', [606, 798, 145, 165], [64, 64], { size: 'medium', offers: { top: 2 } })
kit('chair-front-default', 'chair-front', [764, 781, 112, 186], [64, 96], { size: 'large' })
kit('chair-left-default', 'chair-side', [905, 781, 109, 186], [64, 96], { facing: 'left', size: 'large' })
kit('chair-right-default', 'chair-side', [905, 781, 109, 186], [64, 96], { facing: 'right', size: 'large', flip: true })
kit('stool-front-default', 'stool', [1035, 833, 118, 132], [64, 64], { size: 'large' })
kit('chest-front-default', 'chest', [1177, 813, 190, 153], [64, 64], { size: 'large', offers: { top: 2 } })

// Room signatures. These are deliberately not part of the reusable kit.
add('kitchen-oven-front-fire', 'kitchen', [24, 24, 770, 600], [192, 192], { id: 'kitchen-oven-hearth', facing: 'front', state: 'fire', footprint: [3, 2], base: [0, 1.5, 3, 0.5], size: 'large', mount: 'floor', offers: { top: 2 }, tags: ['light', 'hazel-signature'] })
add('kitchen-worktable-front-default', 'kitchen', [798, 357, 707, 303], [256, 128], { id: 'kitchen-worktable', facing: 'front', state: 'default', footprint: [4, 2], base: [0, 1.5, 4, 0.5], size: 'large', mount: 'floor', offers: { top: 4 }, tags: ['hazel-signature'] })
add('kitchen-washtub-front-default', 'kitchen', [48, 745, 276, 220], [64, 128], { id: 'kitchen-washtub', facing: 'front', state: 'default', footprint: [1, 1], base: [0, 0.5, 1, 0.5], size: 'medium', mount: 'floor', tags: ['hazel-signature'] })
for (const [i, x, y, w, h] of [[0, 805, 89, 152, 228], [1, 974, 88, 151, 229], [2, 1144, 88, 148, 229], [3, 1310, 90, 147, 227]]) add(`kitchen-cauldron-front-steaming-${i}`, 'kitchen', [x, y, w, h], [64, 128], { id: 'kitchen-cauldron', facing: 'front', state: 'steaming', frame: i, footprint: [1, 1], base: [0, 0.5, 1, 0.5], size: 'medium', mount: 'floor', tags: ['hazel-signature'], loop: { frameRate: 2 } })
add('kitchen-bread-rack-front-default', 'kitchen', [564, 685, 349, 286], [64, 128], { id: 'kitchen-bread-rack', facing: 'front', state: 'default', footprint: [1, 1], base: [0, 0.5, 1, 0.5], size: 'medium', mount: 'floor', offers: { shelves: 2 }, tags: ['hazel-signature'] })
add('kitchen-jar-shelf-front-default', 'kitchen', [953, 694, 382, 298], [128, 128], { id: 'kitchen-jar-shelf', facing: 'front', state: 'default', footprint: [2, 1], base: [0, 0.5, 2, 0.5], size: 'large', mount: 'wall', offers: { shelves: 4 }, tags: ['hazel-signature'] })
add('kitchen-flour-handprint-wall-default', 'kitchen', [1384, 675, 94, 121], [64, 64], { id: 'kitchen-flour-handprint', facing: 'front', state: 'default', footprint: [1, 1], base: [0.4, 0.4, 0.2, 0.2], size: 'small', mount: 'wall', tags: ['hazel-signature'] })
add('kitchen-oven-peel-wall-default', 'kitchen', [1384, 805, 100, 195], [64, 96], { id: 'kitchen-oven-peel', facing: 'front', state: 'default', footprint: [1, 1], base: [0.4, 0.4, 0.2, 0.2], size: 'small', mount: 'wall', tags: ['hazel-signature'] })

// Finn's mill and loft. The stone, gears, old sacks, hoist and stairs replace
// the old over-large and free-standing art in the 0.4 pass.
for (const [i, x] of [29, 254, 477, 701].entries()) add(`millstone-hopper-front-turn-${i}`, 'mill', [x, 55, 193, 341], [128, 192], { id: 'millstone-hopper', facing: 'front', state: 'turn', frame: i, footprint: [2, 2], base: [0, 1.5, 2, 0.5], size: 'large', mount: 'floor', tags: ['finn-signature'], loop: { frameRate: 2 } })
add('mill-sifter-front-default', 'mill', [975, 41, 194, 346], [64, 128], { id: 'mill-sifter', facing: 'front', state: 'default', footprint: [1, 1], base: [0, 0.5, 1, 0.5], size: 'medium', mount: 'wall', offers: { shelves: 1 }, tags: ['finn-signature'] })
for (const [i, x, w] of [[0, 530, 144], [1, 695, 130], [2, 854, 132], [3, 998, 131]]) add(`mill-gear-wheel-left-turn-${i}`, 'mill', [x, 421, w, 193], [128, 128], { id: 'mill-gear-wheel', facing: 'left', state: 'turn', frame: i, footprint: [2, 1], base: [0, 0.5, 2, 0.5], size: 'large', mount: 'wall', tags: ['finn-signature'], loop: { frameRate: 2 } })
add('mill-sack-front-upright', 'mill', [82, 435, 143, 166], [64, 64], { id: 'mill-sack', facing: 'front', state: 'upright', footprint: [1, 1], base: [0, 0.75, 1, 0.25], size: 'medium', mount: 'floor', tags: ['finn-signature'] })
add('mill-sack-front-slumped', 'mill', [245, 502, 193, 120], [64, 64], { id: 'mill-sack', facing: 'front', state: 'slumped', footprint: [1, 1], base: [0, 0.75, 1, 0.25], size: 'medium', mount: 'floor', tags: ['finn-signature'] })
add('mill-stairs-diag-default', 'mill', [44, 619, 350, 368], [128, 128], { id: 'mill-wall-stairs', facing: 'diag', state: 'default', footprint: [2, 2], base: [0, 1.5, 2, 0.5], size: 'large', mount: 'floor', tags: ['finn-signature', 'exit'] })
add('loft-stair-opening-front-default', 'mill', [492, 695, 445, 230], [128, 128], { id: 'loft-stair-opening', facing: 'front', state: 'default', footprint: [2, 2], base: [0, 1.5, 2, 0.5], size: 'large', mount: 'floor', tags: ['finn-signature', 'exit'] })
add('loft-hoist-front-default', 'mill', [984, 636, 272, 316], [128, 192], { id: 'loft-hoist', facing: 'front', state: 'default', footprint: [2, 2], base: [0, 1.5, 2, 0.5], size: 'large', mount: 'wall', tags: ['finn-signature', 'quest:stuck-hoist'] })
add('mill-tally-board-wall-default', 'mill', [1337, 793, 83, 145], [64, 96], { id: 'mill-tally-board', facing: 'front', state: 'default', footprint: [1, 1], base: [0.4, 0.4, 0.2, 0.2], size: 'small', mount: 'wall', tags: ['finn-signature'] })
add('mill-gear-wall-small-default', 'mill', [1390, 40, 103, 331], [64, 128], { id: 'mill-gear-small', facing: 'left', state: 'default', footprint: [1, 1], base: [0.4, 0.4, 0.2, 0.2], size: 'medium', mount: 'wall', tags: ['finn-signature'] })

const assets = JSON.parse(readFileSync(dir('manifest.json'), 'utf8'))
// Rebuild the Round 2 layer cleanly when crop coordinates or art are refined.
const priorRound2 = new Set((assets.furnishings ?? []).map((f) => f.frame))
const priorRound2Sources = new Set(assets.frames.filter((f) => priorRound2.has(f.key)).map((f) => f.source))
assets.sources = assets.sources.filter((s) => !s.key.startsWith('round2-') && !priorRound2Sources.has(s.key))
assets.frames = assets.frames.filter((f) => !priorRound2.has(f.key) && !f.source.startsWith('round2-'))
assets.animations = assets.animations.filter((a) => !['kitchen-cauldron-steaming', 'millstone-hopper-turn', 'mill-gear-wheel-turn'].includes(a.key))
const existing = new Set(assets.frames.map((f) => f.key))
for (const job of jobs) {
  if (existing.has(job.key)) throw new Error(`duplicate frame key ${job.key}`)
  const [x, y, w, h] = job.crop
  const out = dir(`sheets/round2-crops/${job.key}.png`)
  const src = dir(`sheets/${sourceSheets[job.source]}`)
  // trim only transparent sheet margin from the manually measured crop.
  execFileSync('magick', [src, '-crop', `${w}x${h}+${x}+${y}`, '+repage', ...(job.flip ? ['-flop'] : []), '-trim', '+repage', '-bordercolor', 'none', '-border', '4', out])
  const dims = execFileSync('magick', [out, '-format', '%w %h', 'info:'], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
  const [cw, ch] = job.fit
  const [bw, bh] = job.artBox ?? job.fit
  const scale = Math.min(bw / dims[0], bh / dims[1])
  const dw = Math.max(1, Math.round(dims[0] * scale))
  const dh = Math.max(1, Math.round(dims[1] * scale))
  const dx = Math.round((cw - dw) / 2)
  const dy = job.artOffsetY ?? (job.mount === 'wall' ? Math.round((ch - dh) / 2) : ch - dh)
  const frame = {
    key: job.key,
    source: `round2-${job.key}`,
    sourceRect: { x: 0, y: 0, w: dims[0], h: dims[1] },
    canvasSize: { w: cw, h: ch },
    destinationRect: { x: dx, y: dy, w: dw, h: dh },
    footprint: job.footprint,
    footPoint: { x: Math.round(cw / 2), y: ch },
    origin: [0.5, 1],
    role: 'prop',
    furnishing: {
      id: job.id, facing: job.facing, state: job.state,
      footprint: job.footprint, base: job.base, size: job.size,
      mount: job.mount, ...(job.offers ? { offers: job.offers } : {}),
      ...(job.layer ? { layer: job.layer } : {}),
      ...(job.tags ? { tags: job.tags } : {}),
      ...(job.loop ? { loop: job.loop } : {}),
    },
  }
  assets.sources.push({ key: frame.source, file: `round2-crops/${job.key}.png` })
  assets.frames.push(frame)
}

assets.animations.push(
  { key: 'kitchen-cauldron-steaming', frames: [0, 1, 2, 3].map((i) => `kitchen-cauldron-front-steaming-${i}`), frameRate: 2, loop: true },
  { key: 'millstone-hopper-turn', frames: [0, 1, 2, 3].map((i) => `millstone-hopper-front-turn-${i}`), frameRate: 2, loop: true },
  { key: 'mill-gear-wheel-turn', frames: [0, 1, 2, 3].map((i) => `mill-gear-wheel-left-turn-${i}`), frameRate: 2, loop: true },
)
assets.furnishings = jobs.map(({ key, id, facing, state, footprint, base, size, mount, offers, layer, tags, loop }) => ({
  frame: key, id, facing, state, footprint, base, size, mount,
  ...(offers ? { offers } : {}), ...(layer ? { layer } : {}),
  ...(tags ? { tags } : {}), ...(loop ? { loop } : {}),
}))
writeFileSync(dir('manifest.json'), `${JSON.stringify(assets, null, 2)}\n`)
const catalogue = new Map()
for (const f of assets.furnishings) {
  let item = catalogue.get(f.id)
  if (!item) {
    item = { id: f.id, footprint: f.footprint, base: f.base, size: f.size, mount: f.mount, facings: {}, states: {}, tags: [] }
    if (f.offers) item.offers = f.offers
    if (f.layer) item.layer = f.layer
    catalogue.set(f.id, item)
  }
  const facing = item.facings[f.facing] ??= {}
  facing[f.state] ??= []
  facing[f.state].push(f.frame)
  const state = item.states[f.state] ??= { frames: [] }
  state.frames.push(f.frame)
  if (f.loop) state.loop = f.loop
  for (const tag of f.tags ?? []) if (!item.tags.includes(tag)) item.tags.push(tag)
}
writeFileSync(dir('furnishings.json'), `${JSON.stringify({ id: 'glimway-interior-kit-round-2', density: 64, pieces: [...catalogue.values()] }, null, 2)}\n`)
const atlas = JSON.parse(readFileSync(dir('atlas.json'), 'utf8'))
for (const f of assets.frames.filter((f) => f.source.startsWith('round2-'))) {
  atlas.frames[f.key] = {
    filename: f.source,
    frame: f.sourceRect,
    rotated: false,
    trimmed: true,
    spriteSourceSize: { x: 0, y: 0, w: f.sourceRect.w, h: f.sourceRect.h },
    sourceSize: f.sourceRect,
  }
}
writeFileSync(dir('atlas.json'), `${JSON.stringify(atlas, null, 2)}\n`)
writeFileSync(dir('round2-jobs.json'), `${JSON.stringify({
  date: '2026-10-08', tool: 'built-in image_gen', sources: sourceSheets,
  imageHandling: 'Edge-connected generated neutral checkerboard pixels converted to alpha; measured crops are trimmed and kept as independent source sprites; source pixels are not painted over.',
  prompts: {
    library: 'Straight-on library bookcases in three fill states; side-on shelves, built-in window alcove, Elara desk empty/seated states, four exact section plaque texts and icons. Coarse resident-scale pixels, true transparency.',
    sharedKit: 'Generic reusable furnishings: three rugs, shelves, wall pegs/tools, crate, barrel, sacks, basket, plants, lamps, candles, picture, calendar, curtains, side table, chair, stool, chest. Neutral owner-free details, resident-scale pixels.',
    kitchen: 'Hazel signature kitchen sprites: face-on oven/hearth fire states, worktable, wash tub, cauldron, bread rack, jar shelf, flour handprint and oven peel. Resident-scale pixels.',
    mill: 'Finn signature mill and loft sprites: hopper millstone slow turn, sifter, side-on gears, correctly sized sacks, wall-aligned stairs and matching loft opening, hoist, tally board. Resident-scale pixels.',
  },
  cropJobs: jobs,
}, null, 2)}\n`)
