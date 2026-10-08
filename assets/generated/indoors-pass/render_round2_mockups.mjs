import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('.', import.meta.url).pathname
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))
const manifest = read('manifest.json')
const srcs = new Map(manifest.sources.map((s) => [s.key, join(root, 'sheets', s.file)]))
const tmpDir = join(root, 'sheets/mockup-frames')
const outDir = join(root, '../../../.agent/screens')
mkdirSync(tmpDir, { recursive: true })
mkdirSync(outDir, { recursive: true })
const frames = new Map(manifest.frames.map((f) => [f.key, f]))
const run = (args) => execFileSync('magick', args)
const geom = (x, y) => `${x >= 0 ? '+' : ''}${x}${y >= 0 ? '+' : ''}${y}`

function exportFrame(key) {
  const f = frames.get(key)
  if (!f) throw new Error(`missing mock-up frame: ${key}`)
  const out = join(tmpDir, `${key}.png`)
  const raw = join(tmpDir, `${key}-raw.png`)
  const cw = f.canvasSize.w, ch = f.canvasSize.h
  const d = f.destinationRect
  const image = srcs.get(f.source)
  const r = f.sourceRect
  run([image, '-crop', `${r.w}x${r.h}+${r.x}+${r.y}`, '+repage', raw])
  run(['-size', `${cw}x${ch}`, 'xc:none', '(', raw, '-resize', `${d.w}x${d.h}`, ')', '-geometry', geom(d.x, d.y), '-composite', out])
  return out
}

const texture = (key) => exportFrame(key)
const floor = texture('plank-floor-0')
const wall = texture('back-wall-0')
const winWall = texture('back-wall-window')
const rooms = [
  { id: 'library', title: 'Revised library · 14 × 10', size: [14, 10], wallWindows: [7, 10], pieces: [
    ['rug-woven-front-default', 4, 6], ['library-shelf-front-sparse', 0, -1], ['library-shelf-front-half', 3, -1], ['library-shelf-front-full', 6, -1],
    ['library-section-sign-front-stories', 0, 1], ['library-section-sign-front-histories', 3, 1], ['library-section-sign-front-recipes', 6, 1], ['library-section-sign-front-field-notes', 9, 1],
    ['library-reading-nook-front-default', 10, 4], ['library-elara-desk-front-seated', 7, 3], ['library-shelf-tall-left-half', 0, 2], ['library-shelf-tall-right-half', 13, 2],
    ['plant-leafy-front-default', 12, 1], ['lamp-oil-front-default', 9, 5], ['side-table-front-default', 8, 6],
  ] },
  { id: 'kitchen', title: "Hazel's kitchen · 14 × 10", size: [14, 10], wallWindows: [4, 10], pieces: [
    ['rug-patchwork-front-default', 4, 6], ['kitchen-oven-front-fire', 1, 0], ['kitchen-jar-shelf-front-default', 4, -1], ['wall-pegs-front-tools', 9, 0],
    ['kitchen-worktable-front-default', 5, 4], ['kitchen-washtub-front-default', 10, 5], ['kitchen-cauldron-front-steaming-0', 9, 6], ['kitchen-bread-rack-front-default', 0, 6],
    ['kitchen-flour-handprint-wall-default', 2, 0], ['kitchen-oven-peel-wall-default', 7, 0], ['crate-front-default', 0, 8], ['barrel-front-default', 12, 8],
    ['plant-flowering-front-default', 12, 1], ['lamp-oil-front-default', 3, 5], ['candle-holder-front-default', 11, 4],
  ] },
  { id: 'mill', title: "Finn's mill · 14 × 11", size: [14, 11], wallWindows: [2, 10], pieces: [
    ['rug-woven-front-default', 4, 7], ['millstone-hopper-front-turn-0', 5, 0], ['mill-sifter-front-default', 1, -1], ['mill-gear-wheel-left-turn-0', 11, -1],
    ['mill-stairs-diag-default', 9, 4], ['mill-sack-front-upright', 0, 7], ['mill-sack-front-slumped', 2, 7], ['wall-pegs-front-tools', 5, 0],
    ['shelf-generic-front-default', 0, 1], ['mill-tally-board-wall-default', 10, 1], ['barrel-front-default', 12, 8], ['lamp-oil-front-default', 8, 6],
  ] },
  { id: 'loft', title: 'Sack loft · 12 × 8', size: [12, 8], wallWindows: [], pieces: [
    ['rug-braided-front-default', 4, 5], ['loft-hoist-front-default', 8, -1], ['loft-stair-opening-front-default', 4, 2], ['mill-sack-front-upright', 0, 2], ['mill-sack-front-slumped', 2, 2],
    ['shelf-generic-front-default', 0, -1], ['wall-pegs-front-tools', 4, -1], ['crate-front-default', 9, 5], ['basket-front-default', 10, 5], ['lamp-oil-front-default', 1, 5],
  ] },
  { id: 'cottage', title: 'Cottage · shared furnishing kit', size: [12, 8], wallWindows: [3, 9], pieces: [
    ['rug-braided-front-default', 4, 5], ['curtains-front-default', 3, -1], ['shelf-generic-front-default', 0, -1], ['picture-frame-front-default', 7, 0], ['calendar-front-default', 9, 0],
    ['wall-pegs-front-tools', 0, 1], ['side-table-front-default', 2, 3], ['chair-front-default', 4, 3], ['stool-front-default', 6, 4], ['chest-front-default', 9, 5],
    ['plant-leafy-front-default', 10, 1], ['lamp-oil-front-default', 3, 5], ['crate-front-default', 0, 6], ['barrel-front-default', 10, 6], ['basket-front-default', 8, 5],
  ] },
]

for (const room of rooms) {
  const [cols, rows] = room.size
  const width = cols * 64
  const height = rows * 64
  const base = join(tmpDir, `${room.id}-base.png`)
  run(['-size', `${width}x${height}`, `tile:${floor}`, base])
  // Repeat a timber back wall across the first two tile rows and short returns
  // down the sides. Door gap remains clear along the near wall.
  let scene = base
  const sideWall = join(tmpDir, 'side-wall-tile.png')
  run([wall, '-crop', '64x64+0+64', '+repage', sideWall])
  for (let x = 0; x < cols; x++) {
    const tile = room.wallWindows.includes(x) ? winWall : wall
    const next = join(tmpDir, `${room.id}-wall-${x}.png`)
    run([scene, tile, '-geometry', `+${x * 64}+0`, '-composite', next])
    scene = next
  }
  for (const x of [0, cols - 1]) for (let y = 2; y < rows - 1; y++) {
    const next = join(tmpDir, `${room.id}-side-${x}-${y}.png`)
    run([scene, sideWall, '-geometry', `+${x * 64}+${y * 64}`, '-composite', next])
    scene = next
  }
  // Rug underlays are placed first. All other art keeps its native aspect and
  // canvas; only the room preview scales to the same 64px-per-tile view.
  const ordered = [...room.pieces.filter(([key]) => key.startsWith('rug-')), ...room.pieces.filter(([key]) => !key.startsWith('rug-'))]
  for (const [key, tx, ty] of ordered) {
    const f = frames.get(key)
    const sprite = texture(key)
    const next = join(tmpDir, `${room.id}-placed-${key}-${tx}-${ty}.png`)
    run([scene, sprite, '-geometry', geom(tx * 64, ty * 64), '-composite', next])
    scene = next
  }
  const titled = join(tmpDir, `${room.id}-titled.png`)
  run([scene, '-background', '#2c1d17', '-gravity', 'south', '-splice', '0x52', '-fill', '#f8e6b5', '-stroke', '#402819', '-strokewidth', '1', '-font', '/System/Library/Fonts/Supplemental/Arial.ttf', '-pointsize', '22', '-gravity', 'south', '-annotate', '+0+14', room.title, titled])
  run([titled, '-background', '#2c1d17', '-bordercolor', '#2c1d17', '-border', '14', join(outDir, `${room.id}-in-room.png`)])
}
