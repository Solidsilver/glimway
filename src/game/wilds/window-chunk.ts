/**
 * One chunk of the open map in the scene (docs/design/open-map.md 2.5,
 * 2.6): painted once, off the walking frame, then attached while it is in
 * the 3×3 around the hero and destroyed when it leaves.
 *
 * An attached chunk is its ground image (./ground-paint.ts, world pixels),
 * the open map's ground tile art standing on it (the Lantern Road's paving
 * and verges, laid stone and plank, fords' stepping stones), its collision
 * (merged runs of solid tiles), its decor as scenery (fading where it
 * overhangs a path), its workable pieces (gathering) and its entities and
 * story sites (./entities.ts). A drift chunk is a chunk past the frontier:
 * a dim glimpse of the land beyond, trees in fog, and the frontier veil
 * along the edge you can't cross.
 *
 * Attaching is cheap on the frame that does it: the ground image and the
 * collision go in whole and at once (nobody walks through anything), then
 * the window builds the rest a few milliseconds a frame (`build`): the tile
 * art (a new road edge bakes its pieces the first time it shows), the
 * scenery, the workable pieces, then the things and sites, in the order
 * they were always drawn in (pieces of equal depth that overlap keep which
 * is on top). A chunk is attached a chunk ahead of the hero, off screen. Images go onto the display list a batch at a time and
 * come off in one pass (../area/bulk.ts). Flat decals that stand for no
 * tile are one blitter a texture, not an image each.
 */
import type Phaser from 'phaser'
import { TILE, TERRAIN, tileKey } from '../../lib/tile.ts'
import { fnv1a32, hash01 } from '../../lib/hash.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { addAll, decalBlitter, decalBob, destroyAll, destroyStatics, enableStatics, looseImage } from '../area/bulk.ts'
import { staticBox } from '../area/collision.ts'
import { ensureSceneryArt } from '../area/props.ts'
import type { Occluder } from '../area/foreground.ts'
import { TILE_DATA, type TileArt } from '../area/tile-art.ts'
import type { Gathering } from '../entities/gathering.ts'
import type { GatherSpot, ScenerySpot } from '../worlds.ts'
import { CHUNK_PX, CHUNK_TILES, chunkKey } from './coords.ts'
import { fogDrift, paintDrift, type GroundSource } from './ground-paint.ts'
import { chunkOrigin, chunkScenery, DECAL_DEPTH, type ChunkTerrain } from './terrain.ts'
import { paintDriftTrees } from './tangle-art.ts'
import { lookAtlasKey, wildsLook } from './wilds-looks.ts'
import type { WildsEntities } from './entities.ts'
import { FORD_H, FORD_V, PATH_PLANK_H, PATH_PLANK_V, PATH_STONE, ROAD_PAVING, VEIL, VEIL_ANIM } from './open-map-art.ts'
import { fordLines, fordStone, openSides, softTile } from './soft-tiles.ts'
import type { FrontierRect, Glimpse } from './store.ts'
import { frontierDistance } from './window-plan.ts'
import { perfSpan, perfTime, perfWithout } from '../perf.ts'

/**
 * Ground under everything; the tile art just above it. Everything standing
 * sorts by its y, and north of the gate the world's y is negative, so the
 * open map's floor sits far below any y (./terrain.ts OPEN_DECAL_DEPTH too).
 */
export const GROUND_DEPTH = -10_000_000
const TILE_ART_DEPTH = GROUND_DEPTH + 1

export interface ChunkDeps {
  scene: Phaser.Scene
  solids: Phaser.Physics.Arcade.StaticGroup
  tileArt: TileArt<Phaser.GameObjects.Image>
  gathering: () => Gathering | null
  entities: WildsEntities
  occluders: { add(list: Occluder[]): void; remove(images: readonly Phaser.GameObjects.Image[]): void }
  reducedMotion: boolean
  /** The ground at any world tile (across chunk edges). */
  ground: GroundSource
  /** The workable pieces of a chunk, in world tiles (the calendar decides the seasons' pieces). */
  gather: (t: ChunkTerrain) => GatherSpot[]
  /** The window's chunks still being built, in attachment order (without one, a chunk builds itself). */
  builds?: BuildQueue
}

/** Something built a slice at a time: true once it is whole. */
export interface Buildable {
  build(deadline: number): boolean
}

/**
 * The attached chunks still being built, in the order they were attached:
 * the order their pieces were always drawn in, so pieces of equal depth
 * that overlap across a chunk edge keep which is on top (Phaser's depth
 * sort is stable: ties stay in display-list order). Every build goes
 * through here, a slice a frame (`step`) or whole at once (`finish`: a
 * patch or a relay that can't wait), and finishing a chunk early first
 * finishes every chunk attached before it.
 */
export class BuildQueue<T extends Buildable = Buildable> {
  private waiting: T[] = []

  add(c: T): void {
    this.waiting.push(c)
  }

  /** A chunk dropped before it was whole: never built further. */
  drop(c: T): void {
    const i = this.waiting.indexOf(c)
    if (i >= 0) this.waiting.splice(i, 1)
  }

  /** Build until the deadline (performance.now(), ms), first attached first. */
  step(deadline: number): void {
    while (this.waiting.length) {
      if (!this.waiting[0]!.build(deadline)) return
      this.waiting.shift()
    }
  }

  /** Make `c` whole now, after every chunk attached before it. */
  finish(c: T): void {
    const i = this.waiting.indexOf(c)
    if (i < 0) return
    for (const w of this.waiting.splice(0, i + 1)) w.build(Infinity)
  }
}

// ------------------------------------------------------------ painting

/** A painted texture, and how long the painting took (the 8 ms budget, open-map.md 4). */
export interface Painted {
  key: string
  ms: number
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** A chunk's painted ground (./paint-worker.ts) as its own canvas texture, `key`. */
export function groundTexture(scene: Phaser.Scene, key: string, rgba: Uint8ClampedArray): string {
  const canvas = document.createElement('canvas')
  canvas.width = CHUNK_PX
  canvas.height = CHUNK_PX
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, CHUNK_PX, CHUNK_PX), 0, 0)
  if (scene.textures.exists(key)) scene.textures.remove(key)
  scene.textures.addCanvas(key, canvas)
  return key
}

/**
 * Paint a chunk past the frontier: the glimpse's land (a meadow's colour,
 * the Wend's glint), trees standing in it where it's woods, all fogging into
 * the void with distance from the edge (decision 22).
 */
export function paintDriftChunk(scene: Phaser.Scene, cx: number, cy: number, glimpse: Glimpse | null, mark: string | null, frontier: FrontierRect, worldSeed: string, key: string): Painted {
  const start = now()
  const look = wildsLook('outer', mark)
  const seed = fnv1a32(worldSeed)
  const x0 = cx * CHUNK_PX
  const y0 = cy * CHUNK_PX
  const canvas = document.createElement('canvas')
  canvas.width = CHUNK_PX
  canvas.height = CHUNK_PX
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false
  const img = ctx.createImageData(CHUNK_PX, CHUNK_PX)
  paintDrift(img.data, x0, y0, CHUNK_PX, CHUNK_PX, look.ground, glimpse, seed)
  ctx.putImageData(img, 0, 0)
  const wooded = glimpse?.land !== 'meadow'
  paintDriftTrees(scene, ctx, x0, y0, CHUNK_PX, CHUNK_PX, lookAtlasKey('outer', mark), seed, (tx, ty) => (wooded ? true : hash01(tx, ty, seed ^ 0x77) < 0.08) && frontierDistance(frontier, tx * TILE + 8, ty * TILE + 8) > TILE)
  const fogged = ctx.getImageData(0, 0, CHUNK_PX, CHUNK_PX)
  fogDrift(fogged.data, x0, y0, CHUNK_PX, CHUNK_PX, (wx, wy) => frontierDistance(frontier, wx, wy))
  ctx.putImageData(fogged, 0, 0)
  if (scene.textures.exists(key)) scene.textures.remove(key)
  scene.textures.addCanvas(key, canvas)
  return { key, ms: now() - start }
}

// ------------------------------------------------------------ an attached chunk

const T = (id: string): number => (TERRAIN as Record<string, number>)[loadWilds().grounds.find((g) => g.id === id)!.terrain]!
const PAVING = T('paving')
const LAID_STONE = T('laid-stone')
const LAID_PLANK = T('laid-plank')
const FORD = T('ford')
const WATER = T('water')

/** A solid run: its tiles (world) and its body. */
interface Run {
  ty: number
  x0: number
  x1: number
  body: Phaser.Physics.Arcade.Image
}

export class AttachedChunk implements Buildable {
  readonly key: string
  /** What it put on the display list (the art a tile keeps is the tile's: ../area/tile-art.ts). */
  private images: Phaser.GameObjects.GameObject[] = []
  /** Flat decals, one blitter a texture. */
  private decals = new Map<string, Phaser.GameObjects.Blitter>()
  /** Images made off the display list while a batch is open (`batch`): added together when it closes. */
  private fresh: Phaser.GameObjects.GameObject[] | null = null
  /** What is left to build, in order; each step builds until the deadline and says whether it finished. */
  private todo: ((deadline: number) => boolean)[] = []
  private fading: Phaser.GameObjects.Image[] = []
  private runs: Run[] = []
  private artTiles: { tx: number; ty: number }[] = []
  /** Laid stone and plank art, by world tile (a lay or a lift redraws only its tiles). */
  private laid = new Map<string, Phaser.GameObjects.Image>()
  private ground: Phaser.GameObjects.Image
  /** The chunk as attached: its own grids (a worked piece opens a tile for this stay; a path is patched in). */
  terrain: ChunkTerrain
  /** The ground changes it shows (the window's signature; a patch moves it). */
  sig = ''
  /** The chunk with its ground changes as last attached or patched (gathering's own openings aren't in it). */
  private applied: ChunkTerrain

  /** The ground, its tile art and the collision, at once; the rest is left to `build`. */
  constructor(private deps: ChunkDeps, terrain: ChunkTerrain, groundKey: string) {
    const { scene } = deps
    this.applied = terrain
    this.terrain = { ...terrain, solid: terrain.solid.map((row) => [...row]) }
    this.key = chunkKey(terrain.cx, terrain.cy)
    const o = chunkOrigin(terrain)
    this.ground = scene.add.image(o.tx * TILE, o.ty * TILE, groundKey).setOrigin(0, 0).setDepth(GROUND_DEPTH)
    this.images.push(this.ground)
    perfTime('attach:collision', () => this.collide())
    const spots = chunkScenery(this.terrain, (key) => scene.textures.exists(key))
    let next = 0
    let row = 0
    const fords: { tx: number; ty: number }[] = []
    this.todo = [
      (deadline) => perfTime('attach:tile-art', () => {
        row = this.tileArt(row, fords, deadline)
        return row >= this.terrain.size
      }),
      (deadline) => perfTime('attach:scenery', () => {
        next = this.scenery(spots, next, deadline)
        return next >= spots.length
      }),
      () => perfTime('attach:gathering', () => {
        deps.gathering()?.addChunk(this.key, deps.gather(this.terrain))
        return true
      }),
      () => perfTime('attach:things', () => {
        deps.entities.attach(this.terrain)
        return true
      }),
    ]
    deps.builds?.add(this)
  }

  /** Whole now, through the window's queue: every chunk attached before it is finished first. */
  private finish(): void {
    if (this.deps.builds) this.deps.builds.finish(this)
    else this.build(Infinity)
  }

  /** Build what is left until `deadline` (performance.now(), ms): true once the chunk is whole. */
  build(deadline: number): boolean {
    while (this.todo.length) {
      if (!this.todo[0]!(deadline)) return false
      this.todo.shift()
    }
    return true
  }

  /** Everything built: its scenery, pieces, things and sites are all in. */
  get whole(): boolean {
    return !this.todo.length
  }

  /** Run `draw` with images made off the display list, then put them on it together. */
  private batch(draw: () => void): void {
    const outer = this.fresh
    this.fresh = []
    try {
      draw()
    } finally {
      addAll(this.deps.scene, this.fresh)
      this.fresh = outer
    }
  }

  /** An image: made off the list inside a batch, else added now. */
  private image(x: number, y: number, key: string, frame?: string): Phaser.GameObjects.Image {
    if (!this.fresh) return this.deps.scene.add.image(x, y, key, frame)
    const img = looseImage(this.deps.scene, x, y, key, frame)
    this.fresh.push(img)
    return img
  }

  /** Paving, laid paths and fords' stones: delivered art standing on the painted ground. */
  private tileArt(from: number, fords: { tx: number; ty: number }[], deadline: number): number {
    const t = this.terrain
    const o = chunkOrigin(t)
    let ly = from
    this.batch(() => {
      for (; ly < t.size; ly++) {
        if (ly > from && now() > deadline) break
        for (let lx = 0; lx < t.size; lx++) {
          const tx = o.tx + lx
          const ty = o.ty + ly
          const g = t.ground[ly]![lx]!
          if (g === PAVING) this.paving(tx, ty)
          else if (g === LAID_STONE || g === LAID_PLANK) this.laidArt(tx, ty, g)
          else if (g === FORD) fords.push({ tx, ty })
        }
      }
      if (ly >= t.size) this.fordStones(fords)
    })
    return ly
  }

  /** One laid tile's art: stone by world hash, plank across or along as its neighbours run. */
  private laidArt(tx: number, ty: number, g: number): void {
    const { scene, ground } = this.deps
    const pick = (list: readonly string[]) => list[Math.floor(hash01(tx, ty, 41) * list.length)]!
    const across = g === LAID_PLANK && (ground.ground(tx - 1, ty) === LAID_PLANK || ground.ground(tx + 1, ty) === LAID_PLANK)
    const key = g === LAID_STONE ? pick(PATH_STONE) : pick(across ? PATH_PLANK_H : PATH_PLANK_V)
    if (!scene.textures.exists(key)) return
    const img = this.image(tx * TILE, ty * TILE, key).setOrigin(0, 0).setDepth(TILE_ART_DEPTH)
    this.laid.set(tileKey(tx, ty), img)
  }

  /**
   * The chunk's ground changes moved (a clear, a lay or a lift, yours
   * predicted or anyone's read): patch it in place, so its creatures, sites
   * and pieces stay as they are. Opened tiles lose their collision and the
   * piece standing there; laid tiles get their art. False when the change
   * can't be patched (a tile closed again: a refused clear): the window
   * then builds the chunk again.
   */
  patch(next: ChunkTerrain, beyond: (tx: number, ty: number) => void = () => {}): boolean {
    // Built whole first: an opened tile's piece must be there to fell.
    this.finish()
    const t = this.terrain
    const was = this.applied
    const o = chunkOrigin(t)
    for (let ly = 0; ly < t.size; ly++) for (let lx = 0; lx < t.size; lx++) if (!was.solid[ly]![lx] && next.solid[ly]![lx]) return false
    const opened: { tx: number; ty: number }[] = []
    const relaid = new Set<string>()
    for (let ly = 0; ly < t.size; ly++)
      for (let lx = 0; lx < t.size; lx++) {
        const tx = o.tx + lx
        const ty = o.ty + ly
        if (was.solid[ly]![lx] && !next.solid[ly]![lx]) opened.push({ tx, ty })
        if (was.ground[ly]![lx] !== next.ground[ly]![lx]) for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) relaid.add(tileKey(tx + dx, ty + dy))
      }
    this.applied = next
    this.terrain = { ...next, solid: t.solid }
    for (const { tx, ty } of opened) {
      this.clearSolid(tx, ty)
      const gone = this.deps.tileArt.fell(tx, ty)
      if (gone.length) {
        this.deps.occluders.remove(gone)
        this.fading = this.fading.filter((img) => !gone.includes(img))
      }
    }
    for (const k of relaid) {
      const [tx, ty] = k.split(',').map(Number) as [number, number]
      // A neighbour across the chunk's edge: its own chunk redraws it (a plank turns to meet the new one).
      if (!this.relay(tx, ty)) beyond(tx, ty)
    }
    if (opened.length) this.deps.gathering()?.addChunk(this.key, this.deps.gather(this.terrain))
    return true
  }

  /**
   * Draw a laid tile's art again (its neighbours moved: a plank's direction
   * follows them). False when the tile isn't in this chunk.
   */
  relay(tx: number, ty: number): boolean {
    // Built whole first: the tile's art drawn now must not be drawn again by the build.
    this.finish()
    const t = this.terrain
    const o = chunkOrigin(t)
    const lx = tx - o.tx
    const ly = ty - o.ty
    if (lx < 0 || ly < 0 || lx >= t.size || ly >= t.size) return false
    const k = tileKey(tx, ty)
    this.laid.get(k)?.destroy()
    this.laid.delete(k)
    const g = t.ground[ly]![lx]!
    if (g === LAID_STONE || g === LAID_PLANK) this.laidArt(tx, ty, g)
    return true
  }

  /** The laid art drawn, by world tile (tests). */
  laidArtKeys(): Map<string, string> {
    this.finish()
    return new Map([...this.laid].map(([k, img]) => [k, img.texture.key]))
  }

  /** A repainted ground image (after a patch) takes the old one's place. */
  setGround(key: string): void {
    this.ground.setTexture(key)
  }

  /**
   * A ford: stepping stones cut from the ford art, one a tile along the
   * ford's middle line, across the river's whole width, on the painter's
   * own water (./soft-tiles.ts fordStone and fordLines).
   */
  private fordStones(fords: readonly { tx: number; ty: number }[]): void {
    if (!fords.length) return
    const { scene, ground } = this.deps
    const o = chunkOrigin(this.terrain)
    const S = this.terrain.size
    const inside = (tx: number, ty: number) => tx >= o.tx && ty >= o.ty && tx < o.tx + S && ty < o.ty + S
    const isFord = (tx: number, ty: number) => ground.ground(tx, ty) === FORD
    const wet = (tx: number, ty: number) => isFord(tx, ty) || ground.ground(tx, ty) === WATER
    for (const t of fordLines(fords, isFord, wet, inside)) {
      const key = fordStone(scene, t.across ? FORD_H : FORD_V, Math.floor(hash01(t.tx, t.ty, 49) * 3))
      if (!key) continue
      const jx = Math.round((hash01(t.tx, t.ty, 51) - 0.5) * 3)
      const jy = Math.round((hash01(t.tx, t.ty, 53) - 0.5) * 3)
      const img = this.image(t.tx * TILE + TILE / 2 + jx, t.ty * TILE + TILE / 2 + jy, key).setOrigin(0.5, 0.5).setDepth(TILE_ART_DEPTH)
      this.images.push(img)
    }
  }

  /**
   * One tile of the Lantern Road: a paving variant by world hash, turned and
   * mirrored, its edge broken toward the grass (and a few worn through), so
   * the road reads as one worn band with a loose edge, not a grid.
   */
  private paving(tx: number, ty: number): void {
    const { scene, ground } = this.deps
    const h = (salt: number) => hash01(tx, ty, salt)
    const frame = ROAD_PAVING[Math.floor(h(41) * ROAD_PAVING.length)]!
    if (!scene.textures.exists(frame)) return
    const orient = Math.floor(h(43) * 8)
    const open = openSides(tx, ty, (x, y) => ground.ground(x, y) === PAVING)
    const wear = !open && h(45) < 0.16
    // Worn pieces are baked once each and shared: an edge piece is only ever
    // mirrored (its open sides already vary it), so few are ever made.
    const key = open || wear ? softTile(scene, frame, open ? orient & 4 : orient, open, wear, Math.floor(h(47) * 2)) : null
    const img = this.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, key ?? frame).setOrigin(0.5, 0.5).setDepth(TILE_ART_DEPTH)
    if (!key) {
      img.setAngle((orient & 3) * 90)
      if (orient & 4) img.setFlipX(true)
    }
    this.images.push(img)
  }

  /** Solid tiles, merged into horizontal runs, into the scene's one static group (all of a chunk's at once). */
  private collide(): void {
    const t = this.terrain
    const o = chunkOrigin(t)
    const runs: Run[] = []
    for (let ly = 0; ly < t.size; ly++) runs.push(...this.collideRow(o.ty + ly, o.tx, o.tx + t.size - 1))
    this.solidify(runs)
  }

  /** New runs' bodies into the world and the group, in one go. */
  private solidify(runs: readonly Run[]): void {
    if (!runs.length) return
    enableStatics(this.deps.scene.physics.world as never, this.deps.solids as never, runs.map((r) => r.body) as never)
    this.runs.push(...runs)
  }

  /** A row's solid tiles from `from` to `to`, merged into runs (bodies made, not yet in the world). */
  private collideRow(ty: number, from: number, to: number): Run[] {
    const t = this.terrain
    const o = chunkOrigin(t)
    const row = t.solid[ty - o.ty]!
    const runs: Run[] = []
    let x = from
    while (x <= to) {
      if (!row[x - o.tx]) {
        x++
        continue
      }
      let x2 = x
      while (x2 + 1 <= to && row[x2 + 1 - o.tx]) x2++
      const body = staticBox(this.deps.scene, (x + (x2 - x + 1) / 2) * TILE, ty * TILE + TILE / 2, (x2 - x + 1) * TILE, TILE)
      runs.push({ ty, x0: x, x1: x2, body })
      x = x2 + 1
    }
    return runs
  }

  /** A worked piece leaves open ground (gathering): the tile opens and its run splits. */
  clearSolid(tx: number, ty: number): void {
    const t = this.terrain
    const o = chunkOrigin(t)
    const lx = tx - o.tx
    const ly = ty - o.ty
    if (lx < 0 || ly < 0 || lx >= t.size || ly >= t.size || !t.solid[ly]![lx]) return
    t.solid[ly]![lx] = false
    const i = this.runs.findIndex((r) => r.ty === ty && tx >= r.x0 && tx <= r.x1)
    if (i < 0) return
    const run = this.runs.splice(i, 1)[0]!
    this.deps.solids.remove(run.body)
    run.body.destroy()
    this.solidify([...(run.x0 <= tx - 1 ? this.collideRow(ty, run.x0, tx - 1) : []), ...(tx + 1 <= run.x1 ? this.collideRow(ty, tx + 1, run.x1) : [])])
  }

  /**
   * Decor as scenery, from `from` on until the deadline (checked every few
   * pieces); returns where it stopped. Pieces standing for a tile are kept
   * by it, so felling takes them; flat decals that stand for none are
   * blitted.
   */
  private scenery(spots: readonly ScenerySpot[], from: number, deadline: number): number {
    const { scene, tileArt } = this.deps
    const fading: Occluder[] = []
    let i = from
    this.batch(() => {
      for (; i < spots.length; i++) {
        if ((i - from) % 8 === 7 && now() > deadline) break
        const s = spots[i]!
        if (!ensureSceneryArt(scene, s.key)) continue
        if (s.decal && !perfWithout('bake')) {
          decalBob(this.decalsOf(s.key), s.frame, s.x, s.y, s.originX ?? 0.5, s.flipX ?? false, s.tint)
          continue
        }
        const img = this.image(s.x, s.y, s.key, s.frame).setOrigin(s.originX ?? 0.5, 1).setFlipX(s.flipX ?? false)
        img.setDepth(typeof s.depth === 'number' ? s.depth : s.y)
        if (s.tint !== undefined) img.setTint(s.tint)
        if (s.tx !== undefined && s.ty !== undefined && !s.decal) {
          img.setData(TILE_DATA, tileKey(s.tx, s.ty))
          tileArt.keep(s.tx, s.ty, img)
          this.artTiles.push({ tx: s.tx, ty: s.ty })
        } else this.images.push(img)
        if (s.fade) {
          fading.push({ image: img, bounds: img.getBounds(), footY: s.y })
          this.fading.push(img)
        }
      }
    })
    if (fading.length) this.deps.occluders.add(fading)
    return i
  }

  /** The chunk's decal blitter for a texture (made, and put on the display list, on first use). */
  private decalsOf(key: string): Phaser.GameObjects.Blitter {
    let b = this.decals.get(key)
    if (!b) {
      b = decalBlitter(this.deps.scene, key, DECAL_DEPTH)
      this.decals.set(key, b)
      this.images.push(b)
      if (this.fresh) this.fresh.push(b)
      else addAll(this.deps.scene, [b])
    }
    return b
  }

  /** The chunk left the window: everything it put in the scene goes (what was never built, never was). */
  destroy(): void {
    const done = perfSpan('detach')
    this.deps.builds?.drop(this)
    this.todo = []
    perfTime('detach:things', () => this.deps.entities.detach(this.key))
    perfTime('detach:gathering', () => this.deps.gathering()?.removeChunk(this.key))
    perfTime('detach:occluders', () => this.fading.length && this.deps.occluders.remove(this.fading))
    perfTime('detach:images', () => {
      const kept = this.artTiles.flatMap(({ tx, ty }) => this.deps.tileArt.take(tx, ty))
      destroyAll(this.deps.scene, [...this.images, ...kept, ...this.laid.values()])
    })
    this.laid.clear()
    this.decals.clear()
    perfTime('detach:collision', () => destroyStatics(this.deps.scene.physics.world as never, this.deps.solids as never, this.runs.map((r) => r.body) as never))
    this.images = []
    this.runs = []
    this.artTiles = []
    this.fading = []
    done()
  }
}

// ------------------------------------------------------------ a drift chunk

export class DriftChunk {
  private images: Phaser.GameObjects.GameObject[] = []

  constructor(private scene: Phaser.Scene, readonly cx: number, readonly cy: number, groundKey: string, edges: readonly ('north' | 'south' | 'east' | 'west')[], reducedMotion: boolean) {
    const x0 = cx * CHUNK_PX
    const y0 = cy * CHUNK_PX
    this.images.push(scene.add.image(x0, y0, groundKey).setOrigin(0, 0).setDepth(GROUND_DEPTH))
    if (!scene.textures.exists(VEIL)) return
    // The veil: pale threads along the edge, 3 tiles a piece, rippling slowly.
    const pieces = CHUNK_TILES / 3
    for (const edge of edges) {
      for (let i = 0; i < pieces; i++) {
        const along = (i * 3 + 1.5) * TILE
        const [x, y, angle] =
          edge === 'north' ? [x0 + along, y0, 0] : edge === 'south' ? [x0 + along, y0 + CHUNK_PX, 180] : edge === 'east' ? [x0 + CHUNK_PX, y0 + along, 90] : [x0, y0 + along, 270]
        const veil = scene.add.sprite(x, y, VEIL).setOrigin(0.5, 0.5).setAngle(angle).setDepth(y + 8)
        if (!reducedMotion && scene.anims.exists(VEIL_ANIM)) veil.play({ key: VEIL_ANIM, startFrame: (i + cx + cy) & 3 })
        this.images.push(veil)
      }
    }
  }

  destroy(): void {
    destroyAll(this.scene, this.images)
    this.images = []
  }
}
