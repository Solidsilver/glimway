/**
 * Exports the Commons layout (content/layouts/commons.json; docs/design/
 * location-seam.md 1.2, 6 lane S2) from the client's old builder at the
 * frozen capacity, eight gates (scripts/lib/commons-builder.ts), over the
 * Commons' whole fixed footprint in content/places.json:
 *
 *   - the builder's ground, solid grid and everything it placed, as layout
 *     objects with stable ids (its foreground canopies ride on their trees);
 *   - the Bloom wick's flower spots, tagged with the wick;
 *   - the verge: the footprint's margins around the old 62×42 map, woods
 *     like the map's own border (west 3 tiles, east 7, south 6);
 *   - the arch row closed at world x = 4 (layout x 25): the north edge is
 *     solid except over the Tangle's gate, world x = 1..3 (section 2), and
 *     the arch's exit narrowed to those three tiles.
 *
 * It ran once; the layout is edited as data from then on. Running it again
 * overwrites those edits.
 *
 *   node scripts/export-commons.ts
 */
import { writeFileSync } from 'node:fs'
import { buildCommons, commonsForeground } from './lib/commons-builder.ts'
import { PLACES, gateCapacity } from '../src/lib/places.ts'
import { TERRAIN } from '../src/lib/tile.ts'
import { layoutHash01 } from '../src/lib/hash.ts'
import type { ScenerySpot } from '../src/game/worlds.ts'

const place = PLACES.fixed.find((f) => f.id === 'commons')!
const S = 24
const GATES = gateCapacity(place)
const world = buildCommons(GATES, true)
const foreground = commonsForeground(world)

// The grid: the footprint in layout tiles.
const gx0 = place.cx * S - place.origin.tx
const gy0 = place.cy * S - place.origin.ty
const W = place.width * S
const H = place.height * S

const NAMES = Object.fromEntries(Object.entries(TERRAIN).map(([k, v]) => [v, k])) as Record<number, string>
const PALETTE: Record<string, string> = { '.': 'grass_a', ';': 'grass_b', ',': 'grass_c', '*': 'flowers', o: 'cobble', m: 'cobble_moss', d: 'dirt' }
const CHAR = Object.fromEntries(Object.entries(PALETTE).map(([c, t]) => [t, c])) as Record<string, string>

const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < world.width && y < world.height
const ground: string[] = []
const solid: string[] = []
for (let y = gy0; y < gy0 + H; y++) {
  let g = ''
  let s = ''
  for (let x = gx0; x < gx0 + W; x++) {
    if (inMap(x, y)) {
      const name = NAMES[world.ground[y]![x]!]!
      if (!CHAR[name]) throw new Error(`no palette character for ${name}`)
      g += CHAR[name]
      s += world.solid[y]![x] || (x === 25 && y === 0) ? '#' : '.'
    } else {
      // The verge: the woods' floor, all of it standing wood.
      g += layoutHash01(x, y, 71) < 0.3 ? ',' : ';'
      s += '#'
    }
  }
  ground.push(g)
  solid.push(s)
}
// The north edge: open only over the Tangle's gate (world x 1..3).
const openTop = [...solid[0]!].flatMap((c, i) => (c === '.' ? [i + gx0 + place.origin.tx] : []))
if (openTop.join() !== '1,2,3') throw new Error(`north edge open at world x ${openTop}`)

type Obj = Record<string, unknown> & { id: string; kind: string; tx: number; ty: number }
const objects: Obj[] = []
const ids = new Set<string>()
const add = (o: Obj) => {
  if (ids.has(o.id)) throw new Error(`duplicate object ${o.id}`)
  ids.add(o.id)
  objects.push(o)
}
const at = (t: { tx: number; ty: number }) => `${t.tx},${t.ty}`
const key = (t: { tx: number; ty: number }) => `${t.tx},${t.ty}`

// Trees, each with its canopy (the foreground over it), then the other occluders.
const canopies = new Map<string, { frame: string; w: number }>()
const overhangs: typeof foreground = []
const treeAt = new Set(world.trees.map(key))
for (const f of foreground) {
  if (treeAt.has(key(f)) && !canopies.has(key(f))) canopies.set(key(f), { frame: f.frame, w: f.w })
  else overhangs.push(f)
}
for (const t of world.trees) {
  const c = canopies.get(key(t))
  add({ id: `tree:${at(t)}`, kind: 'tree', tx: t.tx, ty: t.ty, ...(c ? { variant: c.frame, width: c.w } : {}) })
}
for (const b of world.bushes) add({ id: `bush:${at(b)}`, kind: 'bush', tx: b.tx, ty: b.ty })
for (const r of world.rocks) add({ id: `rock:${at(r)}`, kind: 'rock', tx: r.tx, ty: r.ty })
for (const o of overhangs) add({ id: `overhang:${o.frame}:${at(o)}`, kind: 'overhang', tx: o.tx, ty: o.ty, variant: o.frame, width: o.w })

// Props: lamps carry their light; the tool crate is Silas's toolbox.
const f = world.features
for (const p of world.props) {
  const prop = { h: p.h, bodyW: p.body[0], bodyH: p.body[1], ...(p.light ? { light: p.light } : {}) }
  const id = p.light ? `lamp:${at(p)}` : p.tx === f.toolbox.tx && p.ty === f.toolbox.ty ? 'toolbox' : `prop:${p.frame}:${at(p)}`
  add({ id, kind: p.light ? 'lamp' : 'prop', tx: p.tx, ty: p.ty, variant: p.frame, prop })
}

// Drawn scenery: its picture's anchor from its object's tile. Named pieces
// are the features the homestead layer and the village life talk about.
const named: Record<string, { id: string; kind: string; tile: { tx: number; ty: number } }> = {
  'commons-well': { id: 'well', kind: 'well', tile: f.well },
  'notice-board': { id: 'board', kind: 'board', tile: f.board },
  firebox: { id: 'firebox', kind: 'scenery', tile: f.firebox },
  skids: { id: 'skids', kind: 'scenery', tile: f.skids }
}
const bloom = new Map(world.gathering!.map((g) => [key(g), g]))
function art(s: ScenerySpot, tx: number, ty: number): Record<string, unknown> {
  return {
    ox: s.x - tx * 16,
    oy: s.y - ty * 16,
    ...(s.originX === 0 ? { originLeft: true } : {}),
    ...(typeof s.depth === 'number' ? { depth: s.depth } : {}),
    ...(s.depth === 'y' ? { depthY: true } : {}),
    ...(s.tx !== undefined ? { tile: true } : {})
  }
}
for (const s of world.scenery!) {
  if (s.flipX !== undefined || s.tint !== undefined || s.frame !== undefined || (s.originX !== undefined && s.originX !== 0)) throw new Error(`scenery ${s.key}: a field the export doesn't carry`)
  if (s.tx !== undefined && s.ty !== undefined) {
    // A flower spot the Bloom wick puts out: the tuft and the gathering together.
    const g = bloom.get(key({ tx: s.tx, ty: s.ty }))
    if (!g || s.key !== g.art?.key) throw new Error(`scenery ${s.key} at ${s.tx},${s.ty}: a tile piece that isn't a flower spot`)
    add({ id: `gather:${g.target}:${at(g)}`, kind: 'gather', tx: g.tx, ty: g.ty, variant: s.key, festival: 'Bloom', target: g.target, label: g.label, art: art(s, g.tx, g.ty) })
    bloom.delete(key(g))
    continue
  }
  const n = named[s.key]
  // The Commons gate: the north gatepost, where the hame hangs.
  const gatepost = s.key === 'gatepost' && Math.floor(s.x / 16) === f.gate.tx && Math.floor((s.y - 1) / 16) === f.gate.ty
  const tile = n ? n.tile : { tx: Math.floor(s.x / 16), ty: Math.floor((s.y - 1) / 16) }
  const id = n ? n.id : gatepost ? 'commons-gate' : `scenery:${s.key}:${at(tile)}`
  add({ id, kind: n ? n.kind : 'scenery', tx: tile.tx, ty: tile.ty, variant: s.key, art: art(s, tile.tx, tile.ty) })
}
if (bloom.size) throw new Error('a flower spot without its tuft')

// The hame on the gatepost: the gate-hame repair's site.
add({ id: 'hame', kind: 'repair', tx: f.hame.tx, ty: f.hame.ty, target: 'gate-hame' })

// Residents' posts.
for (const n of world.npcs) add({ id: `npc-post:${n.id}`, kind: 'npc-post', tx: n.tx, ty: n.ty, npc: n.id, ...(n.spot ? { spot: n.spot } : {}) })

// The ways out: the village gate, the arch, and a homestead gate in the fence for every gate.
const exitOf = (e: (typeof world.exits)[number]) => ({ to: e.to, entryTx: e.entry.tx, entryTy: e.entry.ty, ...(e.label === null ? { unlabelled: true } : {}) })
for (const e of world.exits) {
  if (e.side !== undefined || e.kind !== undefined || (e.label !== undefined && e.label !== null)) throw new Error(`exit to ${e.to}: a field the export doesn't carry`)
  if (e.to.startsWith('home:')) continue
  // The arch: only over the Tangle's gate (the tile east of it is closed above).
  const tw = e.to === 'wilds' ? openTop.length : e.tw
  add({ id: e.to === 'wilds' ? 'exit:arch' : `exit:${e.to}`, kind: 'exit', tx: e.tx, ty: e.ty, tw, th: e.th, exit: exitOf(e) })
}
for (const g of world.gates) {
  const e = world.exits.find((e) => e.to === `home:${g.gate}`)!
  if (e.tx !== g.tx || e.ty !== g.ty || e.tw !== 1 || e.th !== 2) throw new Error(`gate ${g.gate}: its exit isn't its gap`)
  add({ id: `gate:${g.gate}`, kind: 'gate', tx: g.tx, ty: g.ty, tw: 1, th: 2, gate: g.gate, side: g.side, exit: exitOf(e) })
  add({ id: `sign:${g.gate}`, kind: 'sign', tx: g.sign.tx, ty: g.sign.ty, gate: g.gate })
  add({ id: `shelf:${g.gate}`, kind: 'shelf', tx: g.shelf.tx, ty: g.shelf.ty, gate: g.gate })
  const a = place.anchors.find((a) => a.id === `gate:${g.gate}`)
  if (!a || a.tx !== g.entry.tx || a.ty !== g.entry.ty) throw new Error(`gate ${g.gate}: its anchor isn't its lane tile`)
}
const spawn = place.anchors.find((a) => a.id === 'west-path')
if (!spawn || spawn.tx !== world.spawn.tx || spawn.ty !== world.spawn.ty) throw new Error('the spawn is not the west-path anchor')

// The verge's trees: most of the margin's tiles, canopied like the border's.
for (let y = gy0; y < gy0 + H; y++) {
  for (let x = gx0; x < gx0 + W; x++) {
    if (inMap(x, y) || layoutHash01(x, y, 72) >= 0.6) continue
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inMap(x + dx!, y + dy!))
    const canopy = edge || layoutHash01(x, y, 73) < 0.45
    add({ id: `tree:${x},${y}`, kind: 'tree', tx: x, ty: y, ...(canopy ? { variant: layoutHash01(x, y, 74) < 0.5 ? 'oak-canopy' : 'pine-canopy', width: 48 + Math.floor(layoutHash01(x, y, 14) * 16) } : {}) })
  }
}

// One object a line, so a diff reads as the objects that changed.
const doc = { id: place.layout, revision: place.revision, tx: gx0, ty: gy0, width: W, height: H, palette: PALETTE, ground, solid }
const head = JSON.stringify(doc, null, 2).replace(/\n}$/, '')
const body = objects.map((o) => `    ${JSON.stringify(o)}`).join(',\n')
writeFileSync(new URL('../content/layouts/commons.json', import.meta.url), `${head},\n  "objects": [\n${body}\n  ]\n}\n`)
console.log(`content/layouts/commons.json: ${W}x${H} from ${gx0},${gy0}, ${objects.length} objects`)
