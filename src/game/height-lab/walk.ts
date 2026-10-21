/**
 * Height lab (dev only): the generated area, "Near home". A real window of
 * world near home (chunks -3..11 by -9..3 on the `map` seed), its heights
 * from the lasting fields under both access strategies (the region plan and
 * per-chunk repair), dressed with the biomes' grounds and cover. The server
 * solves it in a world lab worker (server/internal/worldlab/walk.go, POST
 * /api/dev/worldlab/terrain-walk); this turns the answer into a lab area.
 * Pure, but for the fetch, so node tests build it.
 */
import { CONTRACT_NUMBER } from '../../lib/contract.ts'
import { G, GROUNDS, SURFACE, hash, lightArea, type AreaOptions, type GroundId, type LabArea, type PropSpot } from './area.ts'
import { DX, DY, KIND, newLayer, setClosed, step, type Dir, type Node, type Stack } from './levels.ts'

export type Strategy = 'region' | 'chunk'
export const STRATEGIES: Strategy[] = ['region', 'chunk']
export const WALK_RECIPE = 'terrain-walk@1'
export const WALK_SEED = 'map'
const URL = '/api/dev/worldlab/terrain-walk'

/** The server's kinds (wilds.TerrainFlat…TerrainRock). */
const SERVER_KIND = [KIND.flat, KIND.face, KIND.slope, KIND.rock] as const

export interface WalkCertificate {
  components: number
  strandedComponents: number
  strandedTiles: number
  walkableTiles: number
  heldExits: number
  heldExitsKept: number
  anchors: number
  anchorsReached: number
}

export interface WalkSpot {
  name: string
  x: number
  y: number
  note?: string
}

/** One strategy as the server sends it: planes as base64 bytes (server/internal/worldlab/walk.go WalkStrategy). */
export interface WalkStrategyWire {
  kind: string
  top: string
  edges: string
  face: string
  flags: string
  ramps: number
  rejectedOptionalFloorTiles: number
  certificate: WalkCertificate
  stranded: { tiles: number; tileBounds: [number, number, number, number] }[] | null
  solveMs: number
}

export interface WalkWire {
  recipe: string
  seed: string
  epoch: string
  x0: number
  y0: number
  w: number
  h: number
  chunks: [number, number, number, number]
  tops: string
  grounds: string[]
  ground: string
  propKinds: string[]
  prop: string
  water: string
  biomes: string[]
  biome: string
  regions: string[]
  region: string
  strategies: Record<Strategy, WalkStrategyWire>
  anchors: WalkSpot[]
  spots: WalkSpot[]
  timingsMs: Record<string, number>
  note: string
}

export interface WalkStrategyData {
  kind: Uint8Array
  top: Uint8Array
  edges: Int16Array
  face: Uint8Array
  flags: Uint8Array
  ramps: number
  certificate: WalkCertificate
  solveMs: number
}

/** The window, decoded. */
export interface WalkData extends Omit<WalkWire, 'tops' | 'ground' | 'prop' | 'water' | 'biome' | 'region' | 'strategies'> {
  tops: Uint8Array
  ground: Uint8Array
  prop: Uint8Array
  water: Uint8Array
  biome: Uint8Array
  region: Uint8Array
  strategies: Record<Strategy, WalkStrategyData>
}

/** What the walk area knows beyond a hand-made one: where it is in the world, each tile's biome and region, what's stranded. */
export interface WalkInfo {
  seed: string
  strategy: Strategy
  /** World tile of the area's first tile, and its chunks (cx0, cy0, width, height). */
  x0: number
  y0: number
  chunks: [number, number, number, number]
  /** 1: floor this strategy leaves cut off from home (its certificate). */
  stranded: Uint8Array
  biome: Uint8Array
  biomes: string[]
  region: Uint8Array
  regions: string[]
  spots: WalkSpot[]
  /** Both strategies' numbers, for the HUD and the spec. */
  summary: Record<Strategy, { ramps: number; strandedTiles: number; strandedComponents: number; anchors: string; heldExits: string; solveMs: number }>
}

export function bytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function decodeWalk(wire: WalkWire): WalkData {
  if (wire.recipe !== WALK_RECIPE) throw new Error(`height lab: walk recipe ${wire.recipe}, want ${WALK_RECIPE}`)
  const n = wire.w * wire.h
  const plane = (b64: string, per = 1) => {
    const b = bytes(b64)
    if (b.length !== n * per) throw new Error(`height lab: walk plane ${b.length} bytes, want ${n * per}`)
    return b
  }
  const strategies = {} as Record<Strategy, WalkStrategyData>
  for (const s of STRATEGIES) {
    const w = wire.strategies[s]
    if (!w) throw new Error(`height lab: walk has no ${s} strategy`)
    const e = plane(w.edges, 8)
    strategies[s] = {
      kind: plane(w.kind),
      top: plane(w.top),
      edges: new Int16Array(e.buffer, e.byteOffset, n * 4),
      face: plane(w.face, 3),
      flags: plane(w.flags),
      ramps: w.ramps,
      certificate: w.certificate,
      solveMs: w.solveMs
    }
  }
  return { ...wire, tops: plane(wire.tops), ground: plane(wire.ground), prop: plane(wire.prop), water: plane(wire.water), biome: plane(wire.biome), region: plane(wire.region), strategies }
}

let cached: { seed: string; data: Promise<WalkData> } | null = null

/** The window for a seed, fetched once a page (the server caches it too). */
export function loadWalk(seed = WALK_SEED, fetcher: typeof fetch = fetch): Promise<WalkData> {
  if (cached?.seed === seed) return cached.data
  const data = (async () => {
    const res = await fetcher(URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Glimway-Contract': String(CONTRACT_NUMBER) },
      body: JSON.stringify({ seed })
    })
    if (!res.ok) {
      let msg = `${res.status}`
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg
      } catch {
        /* not JSON */
      }
      throw new Error(res.status === 404 ? 'this server has no world lab for you (a dev build, with the World lab tool)' : msg)
    }
    return decodeWalk((await res.json()) as WalkWire)
  })()
  cached = { seed, data }
  data.catch(() => {
    if (cached?.data === data) cached = null
  })
  return data
}

/** The window if it's here already (no wait). */
export function walkLoaded(seed = WALK_SEED): Promise<WalkData> | null {
  return cached?.seed === seed ? cached.data : null
}

const groundIndex = (id: string): number => (GROUNDS as readonly string[]).includes(id) ? G[id as GroundId] : G.meadow

/** The prop kinds the server may send, as the lab's. */
const PROP_KINDS = new Set<PropSpot['kind']>(['oak', 'pine', 'birch', 'boulder', 'thicket', 'fern', 'snag'])

/**
 * Build the area for one strategy. Tops, faces, ramps and edges are the
 * server's, exactly (1/256 level → levels); ground and cover the biomes';
 * water shut. No cave: the cave layer stays empty.
 */
export function buildWalkArea(data: WalkData, strategy: Strategy, opts: AreaOptions): LabArea {
  const { w, h } = data
  const s = data.strategies[strategy]
  const surface = newLayer('surface', w, h)
  const cave = newLayer('cave', w, h)
  const stack: Stack = { w, h, layers: [surface, cave], portals: new Map() }
  const top = new Int8Array(w * h)
  const grounds = data.grounds.map(groundIndex)
  for (let i = 0; i < w * h; i++) {
    const k = SERVER_KIND[s.kind[i]!] ?? KIND.rock
    surface.kind[i] = k
    for (let d = 0; d < 4; d++) {
      const q = s.edges[i * 4 + d]!
      surface.edge[i * 4 + d] = q < 0 ? Number.NaN : q / 256
    }
    surface.ground[i] = grounds[data.ground[i]!] ?? G.meadow
    top[i] = s.top[i]!
    if (k === KIND.face) {
      surface.faceTop[i] = s.face[i * 3]!
      surface.faceRow[i] = s.face[i * 3 + 1]!
      surface.faceRows[i] = s.face[i * 3 + 2]!
    }
    if (data.water[i] && k === KIND.flat) {
      setClosed(surface, i % w, Math.floor(i / w), KIND.water)
      surface.ground[i] = G.water
    }
  }
  // Cover: the server's, as the lab's props, never at a cliff's foot or lip (trees there hide the edge).
  const props: PropSpot[] = []
  const flatAt = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || surface.kind[y * w + x] === KIND.flat || surface.kind[y * w + x] === KIND.water
  for (let i = 0; i < w * h; i++) {
    const p = data.prop[i]!
    if (!p || surface.kind[i] !== KIND.flat) continue
    const kind = data.propKinds[p - 1] as PropSpot['kind']
    if (!PROP_KINDS.has(kind)) continue
    const tx = i % w
    const ty = Math.floor(i / w)
    if (!([0, 1, 2, 3] as Dir[]).every((d) => flatAt(tx + DX[d], ty + DY[d]))) continue
    const blocks = kind !== 'fern'
    if (blocks) setClosed(surface, tx, ty, KIND.prop)
    props.push({ kind, tx, ty, variant: Math.floor(hash(tx, ty, 2) * 8), blocks })
  }
  const anchor = (name: string) => data.anchors.find((a) => a.name === name) ?? data.anchors[0]!
  const home = anchor('home')
  const spawn: Node = { layer: SURFACE, tx: home.x, ty: home.y }
  const near = (dx: number, dy: number): Node => nearestOpen(stack, home.x + dx, home.y + dy)
  const tangle = anchor('tangle')
  const stranded = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) stranded[i] = s.flags[i]! & 4 ? 1 : 0
  const summary = {} as WalkInfo['summary']
  for (const k of STRATEGIES) {
    const c = data.strategies[k].certificate
    summary[k] = { ramps: data.strategies[k].ramps, strandedTiles: c.strandedTiles, strandedComponents: c.strandedComponents, anchors: `${c.anchorsReached}/${c.anchors}`, heldExits: `${c.heldExitsKept}/${c.heldExits}`, solveMs: data.strategies[k].solveMs }
  }
  const generated: WalkInfo = {
    seed: data.seed,
    strategy,
    x0: data.x0,
    y0: data.y0,
    chunks: data.chunks,
    stranded,
    biome: data.biome,
    biomes: data.biomes,
    region: data.region,
    regions: data.regions,
    spots: data.spots,
    summary
  }
  return {
    ...lightArea(
      {
        name: 'walk',
        stack,
        top,
        props,
        mouths: [],
        glows: [],
        spawn,
        // Wren strolls round the north edge of Town.
        route: [near(6, -2), near(-8, -6), near(10, -10), near(-4, 2)],
        homes: [{ ...nearestOpen(stack, tangle.x + 6, tangle.y + 4), art: 'slime' }]
      },
      opts
    ),
    generated
  }
}

/** The nearest open floor tile to (tx, ty), by rings (the tile itself first). */
export function nearestOpen(stack: Stack, tx: number, ty: number, ok: (i: number) => boolean = () => true): Node {
  const l = stack.layers[SURFACE]!
  const open = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= l.w || y >= l.h) return false
    const k = l.kind[y * l.w + x]
    return (k === KIND.flat || k === KIND.slope) && ok(y * l.w + x)
  }
  for (let r = 0; r < Math.max(l.w, l.h); r++)
    for (let y = ty - r; y <= ty + r; y++)
      for (let x = tx - r; x <= tx + r; x++) {
        if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) !== r) continue
        if (open(x, y)) return { layer: SURFACE, tx: x, ty: y }
      }
  return { layer: SURFACE, tx, ty }
}

/** Every surface tile you can walk to from a node (1), by the steps the hero takes. */
export function reachFrom(stack: Stack, from: Node): Uint8Array {
  const { w, h } = stack
  const seen = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let n = 0
  seen[from.ty * w + from.tx] = 1
  queue[n++] = from.ty * w + from.tx
  for (let q = 0; q < n; q++) {
    const i = queue[q]!
    const tx = i % w
    const ty = (i - tx) / w
    for (let d = 0; d < 4; d++) {
      if (step(stack, SURFACE, tx, ty, d as Dir) !== SURFACE) continue
      const j = (ty + DY[d]) * w + tx + DX[d]
      if (seen[j]) continue
      seen[j] = 1
      queue[n++] = j
    }
  }
  return seen
}

/**
 * Where the hero stands after switching strategy: where they were if it's
 * still floor, else the nearest floor that reaches home (else any floor).
 */
export function resumeAt(area: LabArea, tx: number, ty: number): Node {
  const l = area.stack.layers[SURFACE]!
  const k = l.kind[ty * l.w + tx]
  if (tx >= 0 && ty >= 0 && tx < l.w && ty < l.h && (k === KIND.flat || k === KIND.slope)) return { layer: SURFACE, tx, ty }
  const home = reachFrom(area.stack, area.spawn)
  const best = nearestOpen(area.stack, tx, ty, (i) => home[i] === 1)
  return best
}

/** What the HUD says about where the hero stands (window tile). */
export function walkHere(area: LabArea, tx: number, ty: number): { biome: string; region: string; chunk: [number, number]; world: [number, number]; stranded: boolean } | null {
  const wk = area.generated
  if (!wk || tx < 0 || ty < 0 || tx >= area.stack.w || ty >= area.stack.h) return null
  const i = ty * area.stack.w + tx
  const world: [number, number] = [wk.x0 + tx, wk.y0 + ty]
  return {
    biome: wk.biomes[wk.biome[i]!] ?? '?',
    region: wk.regions[wk.region[i]!] ?? '?',
    chunk: [Math.floor(world[0] / 24), Math.floor(world[1] / 24)],
    world,
    stranded: wk.stranded[i] === 1
  }
}

