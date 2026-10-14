/**
 * One fixed chunk of the open map in the scene (docs/design/location-seam.md
 * 4, lane S5): an authored layout's chunk (the Commons'), attached while it
 * is in the 3×3 around the hero and destroyed when it leaves, as the
 * generated chunks are (./window-chunk.ts).
 *
 * Its ground is a rectangle of the footprint's painted tileset (one per
 * footprint and scene: ../area/terrain.ts groundTiles), laid as tilemap
 * layers; its collision the merged runs of its solid tiles and the bases of
 * what stands on open ground. Both go in at once; the rest is built a few
 * milliseconds a frame through the window's queue: trees and their
 * canopies, the drawn pieces, props and lamps, then its workable pieces,
 * front doors and the homestead fixtures it owns (the gates' signs and
 * shelves, the hame). Every object belongs to this chunk alone (the one it
 * is served in), and everything the chunk put in the scene goes with it.
 */
import type Phaser from 'phaser'
import { TILE, tileBottom, tileKey, tileMid } from '../../lib/tile.ts'
import { contentPosition } from '../../lib/location.ts'
import { addAll, destroyAll, destroyStatics, enableStatics, looseImage } from '../area/bulk.ts'
import { staticBox } from '../area/collision.ts'
import { ensureSceneryArt } from '../area/props.ts'
import { exitSign } from '../area/exits.ts'
import { layGround, type GroundTiles } from '../area/terrain.ts'
import type { Occluder } from '../area/foreground.ts'
import type { LightProp } from '../area/lanterns.ts'
import { TILE_DATA, type TileArt } from '../area/tile-art.ts'
import { placeGlimwayOccluder } from '../expansion.ts'
import { doorPoints } from '../entities/doors.ts'
import type { Gathering } from '../entities/gathering.ts'
import type { Interactables } from '../entities/interactables.ts'
import type { ExitDef, GatherSpot } from '../worlds.ts'
import { CHUNK_TILES, chunkKey } from './coords.ts'
import { exitOf, objectOut, sceneryOf, type FixedDay, type FixedFootprint, type FixedObject } from './fixed.ts'
import type { Buildable, BuildQueue } from './window-chunk.ts'
import { GROUND_DEPTH } from './window-chunk.ts'
import { perfSpan, perfTime } from '../perf.ts'

/**
 * What another layer (the homestead layer: the gates' signs and shelves, the
 * hame) draws and clears per fixed chunk. `attach` hands back its drawing in
 * small steps, which the chunk spreads over frames like the rest of its build.
 */
export interface FixedHooks {
  attach(key: string): (() => void)[]
  detach(key: string): void
}

export interface FixedChunkDeps {
  scene: Phaser.Scene
  solids: Phaser.Physics.Arcade.StaticGroup
  tileArt: TileArt<Phaser.GameObjects.Image>
  gathering: () => Gathering | null
  occluders: { add(list: Occluder[]): void; remove(images: readonly Phaser.GameObjects.Image[]): void }
  interactables: Interactables
  /** The footprint's painted ground (its tileset and cells). */
  ground: GroundTiles
  /** What the calendar has out (festival-tagged pieces). */
  day: () => FixedDay
  /** Light the chunk's lamps (../area/lanterns.ts refreshLanternVisuals). */
  light: (lamps: LightProp[]) => void
  reducedMotion: boolean
  /** Walk in at a front door. */
  enter: (room: string) => void
  /** Per-chunk fixtures owned by other layers (null: none). */
  hooks: () => FixedHooks | null
  builds?: BuildQueue
}

/** Collision bases of the pieces that stand on open ground (as ../area/collision.ts makes them). */
const BASE: Record<string, [number, number]> = { tree: [12, 6], bush: [12, 8], rock: [12, 8] }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Layer names must be unique on the footprint's tilemap, across attaches. */
let laid = 0

export class FixedChunk implements Buildable {
  readonly key: string
  /** Its ways out, in world tiles (the scene checks them as the hero walks). */
  readonly exits: ExitDef[]
  /** Its lamps (always lit: the Commons' are named and tended). */
  readonly lights: LightProp[] = []
  /** Its exits' chevrons, labels and posts (their pulses die with them). */
  private signs: Phaser.GameObjects.GameObject[] = []
  private images: Phaser.GameObjects.GameObject[] = []
  private layers: Phaser.Tilemaps.TilemapLayer[] = []
  private bodies: Phaser.Physics.Arcade.Image[] = []
  private artTiles: { tx: number; ty: number }[] = []
  private fading: Phaser.GameObjects.Image[] = []
  private todo: ((deadline: number) => boolean)[] = []
  private gathered = false
  private hooked = false
  private doors = false
  private readonly objects: FixedObject[]

  constructor(private deps: FixedChunkDeps, readonly fp: FixedFootprint, readonly cx: number, readonly cy: number) {
    this.key = chunkKey(cx, cy)
    const day = deps.day()
    this.objects = (fp.objects.get(this.key) ?? []).filter((o) => objectOut(o, day))
    this.exits = this.objects.map((o) => exitOf(o, fp)).filter((e): e is ExitDef => e !== null)
    const lx = cx * CHUNK_TILES - fp.tx
    const ly = cy * CHUNK_TILES - fp.ty
    perfTime('attach:fixed:ground', () => {
      this.layers = layGround(deps.ground, { tx: lx, ty: ly, tw: CHUNK_TILES, th: CHUNK_TILES }, { x: cx * CHUNK_TILES * TILE, y: cy * CHUNK_TILES * TILE }, GROUND_DEPTH, `fixed-${this.key}-${++laid}`)
    })
    perfTime('attach:fixed:collision', () => this.collide(lx, ly))
    let next = 0
    let fixtures: (() => void)[] | null = null
    const standing = this.objects.filter((o) => o.kind === 'tree' || o.kind === 'bush' || o.kind === 'rock')
    const drawn = this.objects.filter((o) => o.kind !== 'tree' && o.kind !== 'bush' && o.kind !== 'rock')
    this.todo = [
      (deadline) => perfTime('attach:fixed:trees', () => {
        next = this.standing(standing, next, deadline)
        if (next < standing.length) return false
        next = 0
        return true
      }),
      (deadline) => perfTime('attach:fixed:pieces', () => {
        next = this.pieces(drawn, next, deadline)
        if (next < drawn.length) return false
        next = 0
        return true
      }),
      () => perfTime('attach:fixed:lights', () => {
        if (this.lights.length) this.deps.light(this.lights)
        return true
      }),
      (deadline) => perfTime('attach:fixed:signs', () => {
        while (next < this.exits.length) {
          if (now() >= deadline) return false
          this.signs.push(...exitSign(deps.scene, { height: fp.ty + fp.h }, this.exits[next++]!, deps.reducedMotion))
        }
        next = 0
        return true
      }),
      () => perfTime('attach:fixed:gathering', () => {
        this.gather()
        return true
      }),
      () => perfTime('attach:fixed:doors', () => {
        this.frontDoors()
        return true
      }),
      (deadline) => perfTime('attach:fixed:fixtures', () => {
        if (!fixtures) {
          const hooks = deps.hooks()
          fixtures = hooks ? hooks.attach(this.key) : []
          this.hooked = !!hooks
        }
        while (fixtures.length) {
          if (now() >= deadline) break
          fixtures.shift()!()
          if (now() > deadline) break
        }
        return !fixtures.length
      })
    ]
    deps.builds?.add(this)
  }

  /** Build what is left until `deadline` (performance.now(), ms): true once the chunk is whole. */
  build(deadline: number): boolean {
    while (this.todo.length) {
      if (now() >= deadline) return false
      try {
        if (!this.todo[0]!(deadline)) return false
      } catch (error) {
        console.error(`Could not build chunk stage: ${this.key}`, error)
      }
      this.todo.shift()
    }
    return true
  }

  /** Everything built. */
  get whole(): boolean {
    return !this.todo.length
  }

  /** Solid tiles merged into horizontal runs, and the bases of what stands on open ground, in one go. */
  private collide(lx: number, ly: number): void {
    const { scene, solids } = this.deps
    const fp = this.fp
    const bodies: Phaser.Physics.Arcade.Image[] = []
    const x0 = fp.tx + lx
    const y0 = fp.ty + ly
    for (let y = 0; y < CHUNK_TILES; y++) {
      const row = fp.solid[ly + y]!
      let x = 0
      while (x < CHUNK_TILES) {
        if (!row[lx + x]) {
          x++
          continue
        }
        let x2 = x
        while (x2 + 1 < CHUNK_TILES && row[lx + x2 + 1]) x2++
        bodies.push(staticBox(scene, (x0 + x + (x2 - x + 1) / 2) * TILE, (y0 + y) * TILE + TILE / 2, (x2 - x + 1) * TILE, TILE))
        x = x2 + 1
      }
    }
    for (const o of this.objects) {
      const base = BASE[o.kind] ?? (o.prop ? ([o.prop.bodyW, o.prop.bodyH] as [number, number]) : null)
      if (!base) continue
      // On a solid tile its run already covers the base (every verge tree stands on one).
      if (!o.prop && fp.solid[o.ty - fp.ty]?.[o.tx - fp.tx]) continue
      bodies.push(staticBox(scene, tileMid(o.tx), tileBottom(o.ty) - base[1] / 2, base[0], base[1]))
    }
    if (!bodies.length) return
    enableStatics(scene.physics.world as never, solids as never, bodies as never)
    this.bodies = bodies
  }

  /** Trees (and their canopies), bushes and rocks, from `from` on until the deadline; returns where it stopped. */
  private standing(list: readonly FixedObject[], from: number, deadline: number): number {
    const { scene } = this.deps
    const fresh: Phaser.GameObjects.Image[] = []
    const fading: Occluder[] = []
    let i = from
    for (; i < list.length; i++) {
      if (i > from && now() >= deadline) break
      const o = list[i]!
      const x = tileMid(o.tx)
      const y = tileBottom(o.ty)
      const img = looseImage(scene, x, y, o.kind).setOrigin(0.5, 1)
      if (o.kind !== 'tree') img.setDepth(y)
      fresh.push(img)
      if (o.kind === 'bush') this.images.push(img)
      else this.keep(o.tx, o.ty, img)
      if (o.kind === 'tree' && o.variant) {
        const canopy = placeGlimwayOccluder(scene, o.variant, x, y, o.width, false)
        fresh.push(canopy)
        this.keep(o.tx, o.ty, canopy)
        fading.push({ image: canopy, bounds: canopy.getBounds(), footY: y })
        this.fading.push(canopy)
      }
    }
    addAll(scene, fresh)
    if (fading.length) this.deps.occluders.add(fading)
    return i
  }

  /** A piece standing for a tile is the tile's (felling takes it); kept by the tile art. */
  private keep(tx: number, ty: number, img: Phaser.GameObjects.Image): void {
    img.setData(TILE_DATA, tileKey(tx, ty))
    this.deps.tileArt.keep(tx, ty, img)
    this.artTiles.push({ tx, ty })
  }

  /**
   * The drawn pieces (code-drawn scenery, the well, the board), props and
   * lamps, and the overhangs, from `from` on until the deadline (checked
   * every few pieces); returns where it stopped.
   */
  private pieces(list: readonly FixedObject[], from: number, deadline: number): number {
    const { scene } = this.deps
    const fading: Occluder[] = []
    const props = scene.textures.exists('fingersnap-props') ? scene.textures.get('fingersnap-props') : null
    let i = from
    for (; i < list.length; i++) {
      if (i > from && now() >= deadline) break
      const o = list[i]!
      const s = sceneryOf(o)
      if (s && ensureSceneryArt(scene, s.key)) {
        const img = scene.add.image(s.x, s.y, s.key, s.frame).setOrigin(s.originX ?? 0.5, 1).setFlipX(s.flipX ?? false)
        img.setDepth(typeof s.depth === 'number' ? s.depth : s.y)
        if (s.tint !== undefined) img.setTint(s.tint)
        if (s.tx !== undefined && s.ty !== undefined) this.keep(s.tx, s.ty, img)
        else this.images.push(img)
      }
      if (o.prop && props?.has(o.variant)) {
        const frame = props.get(o.variant)!
        const x = tileMid(o.tx)
        const y = tileBottom(o.ty)
        const img = scene.add.image(x, y, 'fingersnap-props', o.variant).setOrigin(0.5, 1).setScale(o.prop.h / frame.height).setDepth(y)
        this.images.push(img)
        if (o.prop.light) this.lights.push({ id: o.prop.light, sprite: img, gx: x, gy: y - o.prop.h * 0.72, glow: null })
      }
      if (o.kind === 'overhang') {
        const footY = tileBottom(o.ty)
        const image = placeGlimwayOccluder(scene, o.variant, tileMid(o.tx), footY, o.width)
        this.images.push(image)
        fading.push({ image, bounds: image.getBounds(), footY })
        this.fading.push(image)
      }
    }
    if (fading.length) this.deps.occluders.add(fading)
    return i
  }

  /** Its workable pieces (the Bloom patches, on their day). */
  private gather(): void {
    const spots: GatherSpot[] = this.objects
      .filter((o) => o.kind === 'gather')
      .map((o) => ({ target: o.target, label: o.label, tx: o.tx, ty: o.ty, art: { key: o.variant, ...(o.frame ? { frame: o.frame } : {}) } }))
    if (!spots.length) return
    this.deps.gathering()?.addChunk(this.key, spots)
    this.gathered = true
  }

  /** The front doors out onto it (content names them in the place's own tiles: resolved onto the grid). */
  private frontDoors(): void {
    const place = this.fp.place.id
    const points = doorPoints(place, this.deps.enter, (t) => {
      const r = contentPosition(place, t.tx, t.ty)
      return Math.floor(r.tx / CHUNK_TILES) === this.cx && Math.floor(r.ty / CHUNK_TILES) === this.cy ? { tx: r.tx, ty: r.ty } : null
    })
    if (!points.length) return
    this.deps.interactables.register(this, points)
    this.doors = true
  }

  /** The chunk left the window: everything it put in the scene goes (what was never built, never was). */
  destroy(): void {
    const done = perfSpan('detach')
    const { scene } = this.deps
    this.deps.builds?.drop(this)
    this.todo = []
    if (this.hooked) this.deps.hooks()?.detach(this.key)
    if (this.doors) this.deps.interactables.register(this, [])
    if (this.gathered) this.deps.gathering()?.removeChunk(this.key)
    if (this.fading.length) this.deps.occluders.remove(this.fading)
    for (const lp of this.lights) {
      if (!lp.glow) continue
      scene.tweens.killTweensOf(lp.glow)
      lp.glow.destroy()
      lp.glow = null
    }
    for (const o of this.signs) scene.tweens.killTweensOf(o)
    destroyAll(scene, this.signs)
    this.signs = []
    const kept = this.artTiles.flatMap(({ tx, ty }) => this.deps.tileArt.take(tx, ty))
    destroyAll(scene, [...this.images, ...kept])
    for (const l of this.layers) l.destroy()
    destroyStatics(scene.physics.world as never, this.deps.solids as never, this.bodies as never)
    this.images = []
    this.layers = []
    this.bodies = []
    this.artTiles = []
    this.fading = []
    this.lights.length = 0
    this.hooked = this.doors = this.gathered = false
    done()
  }
}
