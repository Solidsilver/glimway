/**
 * Gathering (docs/items/crafting-and-repair.md, "Gathering"): the workable
 * pieces of a wilds chunk (the Tangle and the Whitequiet), the woods, and
 * your own homestead land — trees to chop with an axe, boulders to break
 * with a pick, stumps and patches to dig with a spade. A prompt/action
 * feature like the Wilds claims (./wilds/entities): the nearest piece within
 * reach proposes the prompt; the action key works it swing by swing, then
 * one /api/items/gather tells the server the tool, the action and the
 * target. The server wears the tool, caps the day and the area visit, and
 * rolls the yields — trees are client scenery, so no individual tree is
 * validated (home land excepted: that land is the server's own).
 *
 * Regrowth follows the drift (docs/items/overview.md): a worked piece
 * changes here and now (a felled tree leaves a stump you can dig, a broken
 * boulder leaves pebbles and open ground), and the map is rebuilt from its
 * data on the next visit — the Tangle, the woods and your unlit edge come
 * back whole; inside your lamplight the server kept the change, so the
 * stump is still there. Planting draws the new sapling where it went in.
 */
import type Phaser from 'phaser'
import { EMPTY_YIELD_LINE, GATHERING_DATA, gatheringTarget, gatheringToolWord, gatheringVerb, keepsStanding, leftBehind, swingPlan, visitIdFor, visitWork, wearLine, yieldLine, type ToolFeel, type VisitWork } from '../../lib/gathering'
import { parseHomeArea } from '../../lib/homestead'
import { itemDef } from '../../lib/items'
import { itemsFor } from '../items'
import { itemErrorText } from '../../content/errors'
import { heldNow } from '../held'
import { ITEM_ART_FALLBACK, itemIcon } from '../items-pass'
import { homesteadsFor } from '../homestead'
import { plantScenery } from '../homeland'
import { lookAtlasKey } from '../wilds/wilds-looks'
import { CHUNK_TILES, parseChunkArea, regionOfState, WILDS_AREA } from '../wilds/regions'
import { ensureSceneryArt } from '../area/props'
import { bus, EV } from '../events'
import { TILE, tileBottom, tileKey, tileMid } from '../../lib/tile'
import type { Session } from '../session'
import type { GatherSpot, WorldData } from '../worlds'
import type { Effects } from './fx'
import type { Hero } from './hero'
import type { Interactable, Interactables } from './interactables'
import type { HomePlantView, ItemsActionResponse } from '../../lib/api/types'

/** A piece's work: chop, break or dig (content/gathering.json). */
function actionOf(spot: GatherSpot): string {
  return gatheringTarget(spot.target)?.action ?? 'chop'
}

/** The everyday tool for each kind of work (the ghost hint's picture when none is carried). */
const BENCH_TOOL: Record<string, string> = { chop: 'bench-axe', break: 'bench-pick', dig: 'bench-spade' }

export interface GatheringDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  hero: () => Hero
  interactables: Interactables
  /** Write the hero's spot into the save now (the server measures reach from it). */
  notePosition: () => void
  /** A broken or dug piece leaves open ground: the scene opens the tile. */
  clearSolid: (tx: number, ty: number) => void
  /** The sprites standing for a tile (the piece's own art). */
  spritesAt: (tx: number, ty: number) => Phaser.GameObjects.Image[]
  /** Destroy the sprites standing for a tile (a felled piece). */
  fell: (tx: number, ty: number) => void
}

/** How close you must stand to work a piece; stepping further off stops the work. */
const REACH = 36
const LEAVE = REACH + 10
/** At the soft cap, pieces this near shuffle out of reach. */
const SHUFFLE_RADIUS = 6 * TILE

export class Gathering {
  /** The build of the area that's up now (an answer may outlive the build that asked). */
  private static live: Gathering | null = null
  private spots: GatherSpot[]
  private busy = false
  /** The registered point for each piece (./interactables). */
  private points = new Map<Interactable, GatherSpot>()
  /** Stumps and pebbles this visit's work has drawn, by tile. */
  private drawn = new Map<string, Phaser.GameObjects.Image[]>()
  /** The last gather's outcome, as words for the playtest hooks. */
  private last = '-'
  /** This stay (the server's visit cap counts per stay) and what it has worked. */
  private visit: string
  private done: VisitWork

  constructor(private scene: Phaser.Scene, private deps: GatheringDeps) {
    this.spots = [...(deps.world.gathering ?? [])]
    // Every area build is a stay: arriving somewhere else ends the last one,
    // so coming back is a new visit and the woods have regrown.
    const st = deps.session.state
    this.visit = visitIdFor(st.area, st.wildsRegion ?? null)
    this.done = visitWork(this.visit)
    // A rebuild within the same stay keeps what this stay has worked.
    for (const spot of [...this.spots]) {
      const was = this.done.worked.get(this.key(spot))
      if (was) this.change(spot, was)
    }
    this.spots = this.spots.filter((s) => !this.done.enough.has(gatheringTarget(s.target)?.action ?? 'chop'))
    this.publish()
    // What's carried, for the tool (a world; guests carry no tools).
    const items = itemsFor(deps.session)
    if (deps.session.link && !items.view) void items.load()
    Gathering.live = this
    bus.on(EV.planted, this.onPlanted, this)
    scene.events.once('shutdown', () => {
      this.ghost?.destroy()
      this.ghost = null
      if (Gathering.live === this) Gathering.live = null
      bus.off(EV.planted, this.onPlanted, this)
      this.spots = []
      this.points.clear()
      this.drawn.clear()
    })
  }

  /**
   * Whether this area offers work now: connected (guests carry no tools),
   * and on home land only your own (visiting is look-don't-touch).
   */
  private live(): boolean {
    if (!this.deps.session.link || this.spots.length === 0) return false
    const gate = parseHomeArea(this.deps.world.areaId)
    return gate === null || homesteadsFor(this.deps.session).mine?.gate === gate
  }

  /**
   * Each piece as an interaction point. A piece answers only to the tool in
   * hand (the blade out: the woods keep quiet), and only while work is open
   * here; something nearer (a fallen bucket, someone to talk to) wins.
   */
  private publish(): void {
    this.points.clear()
    const points = this.spots.map((spot): Interactable => {
      const target = gatheringTarget(spot.target)
      const point: Interactable = {
        id: `gather:${tileKey(spot.tx, spot.ty)}`,
        x: tileMid(spot.tx),
        y: tileBottom(spot.ty) + 8,
        reach: REACH,
        clickReach: REACH,
        markerOffset: 14,
        label: spot.label,
        verb: gatheringVerb(target?.action ?? 'chop', target?.verb),
        available: () => !this.busy && actionOf(spot) === heldNow().kind && this.live(),
        activate: () => void this.work(spot)
      }
      this.points.set(point, spot)
      return point
    })
    this.deps.interactables.register(this, points)
  }

  /** The piece the prompt is on right now. */
  private current(): GatherSpot | null {
    const t = this.deps.interactables.currentTarget
    return t ? this.points.get(t) ?? null : null
  }

  /** Read-only: what can be worked this visit (playtests). */
  spotsView(): { target: string; tx: number; ty: number }[] {
    return this.spots.map((s) => ({ target: s.target, tx: s.tx, ty: s.ty }))
  }

  /** The spot the prompt is on right now (null: no prompt). */
  prompted(): { target: string; tx: number; ty: number; label: string } | null {
    const spot = this.current()
    return spot ? { target: spot.target, tx: spot.tx, ty: spot.ty, label: spot.label } : null
  }

  /** Read-only: what this build has drawn where pieces were worked (playtests). */
  leftView(): { tx: number; ty: number; frame: string }[] {
    return [...this.drawn.entries()].map(([k, imgs]) => {
      const [tx, ty] = k.split(',').map(Number)
      return { tx, ty, frame: String(imgs[0]?.frame.name ?? '') }
    })
  }

  /** The last gather's outcome (playtests: what the server said). */
  lastOutcome(): string {
    return this.last
  }

  // ------------------------------------------------------------ the work

  private distance(hero: { x: number; y: number }, spot: GatherSpot): number {
    return Math.hypot(hero.x - tileMid(spot.tx), hero.y - 8 - tileBottom(spot.ty))
  }

  private async work(spot: GatherSpot): Promise<void> {
    if (this.busy) return
    const { session } = this.deps
    const target = gatheringTarget(spot.target)
    if (!target) return
    this.busy = true
    const hero = this.deps.hero()
    try {
      // The tool in hand does the work. The pack may have changed since it
      // was read (a tool from the post, or still loading): read it again
      // before saying there's no tool.
      let tool = this.heldTool(target.action)
      if (!tool) {
        await itemsFor(session).load()
        if (!this.scene.sys.isActive()) return
        tool = this.heldTool(target.action)
      }
      if (!tool) {
        this.last = 'no-tool'
        bus.emit(EV.toast, { text: `You’d want your ${gatheringToolWord(target.action)} for this.`, icon: 'bag' })
        return
      }
      if (tool.refuses) {
        // A blunt or cracked tool in hand: say so, as its wear would.
        this.last = 'no-tool'
        bus.emit(EV.toast, { text: wearLine({ broke: false, state: tool.state, wornOut: [], returned: [], itemDef: tool.itemDef, usesLeft: 0 }) ?? `You’d want your ${gatheringToolWord(target.action)} for this.`, icon: 'bag' })
        return
      }
      this.last = 'working'
      hero.isGathering = true
      const plan = swingPlan(target.action, tool.feel)
      for (let i = 0; i < plan.swings; i++) {
        this.swing(spot)
        await this.pause(plan.ms)
        if (!this.scene.sys.isActive()) return
        // Walked off mid-swing: the piece is as it was.
        if (this.distance(hero.sprite, spot) > LEAVE) {
          this.last = 'stepped-away'
          return
        }
      }
      const home = parseHomeArea(session.state.area) !== null
      this.deps.notePosition()
      const wilds = session.state.area === WILDS_AREA
      const chunk = wilds ? parseChunkArea(this.deps.world.areaId) : null
      const region = wilds ? (chunk?.region ?? regionOfState(session.state)) : undefined
      // The server checks the piece against its own land or chunk: home tiles
      // as they are, Wilds tiles region-wide (the chunk's offset added).
      const tile: [number, number] | undefined = home ? [spot.tx, spot.ty] : chunk ? [chunk.cx * CHUNK_TILES + spot.tx, chunk.cy * CHUNK_TILES + spot.ty] : undefined
      const r = await itemsFor(session).gather(tool.id, target.action, spot.target, this.visit, { tile, region })
      // The answer can outlive this build of the area (a snap-back rebuilt
      // it mid-request): it goes to whichever build is up now.
      const live = Gathering.live?.deps.world.areaId === this.deps.world.areaId ? Gathering.live : null
      if (!r.ok) {
        if (r.code === 'gathered-enough') this.done.enough.add(target.action)
        if (live) {
          live.last = `refused:${r.code}`
          live.refused(r.code, target.action)
        }
        return
      }
      const now = target.action === 'chop' ? 'stump' : 'open'
      this.done.worked.set(this.key(spot), now)
      this.paid(r.value)
      if (!live) return
      live.last = 'landed'
      live.deps.fx.sparkBurst(tileMid(spot.tx), tileBottom(spot.ty) - 8, (r.value.gathered ?? []).length > 0 ? 10 : 4)
      const there = live.spots.find((s) => s.tx === spot.tx && s.ty === spot.ty)
      if (there) live.change(there, now)
    } finally {
      this.busy = false
      hero.isGathering = false
    }
  }

  /**
   * The tool in hand for an action (the belt's slot for that kind: its best,
   * src/lib/belt.ts), with how it works: null when nothing of that kind is
   * held or carried; `refuses` when it's blunt or cracked.
   */
  private heldTool(action: string): { id: string; itemDef: string; state: string; refuses: boolean; feel: ToolFeel } | null {
    const slot = heldNow()
    if (slot.kind !== action || !slot.instance) return null
    const i = itemsFor(this.deps.session).view?.instances.find((x) => x.id === slot.instance)
    if (!i) return null
    const has = (kind: string) => i.fittings.some((f) => f.fitting === kind)
    return { id: i.id, itemDef: i.itemDef, state: i.state, refuses: !slot.usable, feel: { bite: has('bite'), heft: has('heft'), dull: i.state === 'dull' } }
  }

  // ------------------------------------------------------------ the ghost hint

  /**
   * Standing still by a piece the held item can't work, a faint icon of the
   * right tool appears over it after a moment (never an E, and never with a
   * creature near). It teaches the belt without an E-press that does nothing.
   */
  private ghost: Phaser.GameObjects.Image | null = null
  private ghostFor: GatherSpot | null = null
  private still = 0
  private lastHero = { x: 0, y: 0 }

  updateHint(dt: number, hero: { x: number; y: number }, creatureNear: boolean, live: boolean): void {
    const moved = Math.hypot(hero.x - this.lastHero.x, hero.y - this.lastHero.y) > 0.5
    this.lastHero = { x: hero.x, y: hero.y }
    this.still = moved ? 0 : this.still + dt
    const spot = live && !creatureNear && !this.busy && this.current() === null && this.still >= 0.8 && this.live() ? this.wrongToolSpot(hero) : null
    if (!spot) {
      if (this.ghost) this.ghost.setVisible(false)
      this.ghostFor = null
      return
    }
    if (spot !== this.ghostFor) {
      const action = actionOf(spot)
      // The belt's own tool of that kind if carried, else the bench one (it shows what's wanted).
      const def = this.carriedDef(action) ?? BENCH_TOOL[action] ?? 'bench-axe'
      let key = itemIcon(def)
      if (!this.scene.textures.exists(key)) key = ITEM_ART_FALLBACK
      // No art for it at all: no hint (and the old piece's icon mustn't linger over this one).
      this.ghost?.destroy()
      this.ghost = null
      this.ghostFor = null
      if (!this.scene.textures.exists(key)) return
      this.ghostFor = spot
      this.ghost = this.scene.add.image(0, 0, key).setOrigin(0.5, 1).setAlpha(0).setDepth(5000)
      if (this.ghost.height > 12) this.ghost.setScale(12 / this.ghost.height)
      this.scene.tweens.add({ targets: this.ghost, alpha: 0.5, duration: this.deps.reducedMotion ? 0 : 300 })
    }
    this.ghost?.setPosition(tileMid(spot.tx), spot.ty * TILE - 2).setVisible(true)
  }

  /** Read-only: the piece the ghost hint shows over (playtests). */
  hinted(): { tx: number; ty: number } | null {
    return this.ghostFor && this.ghost?.visible ? { tx: this.ghostFor.tx, ty: this.ghostFor.ty } : null
  }

  /** The nearest piece in reach that the held item can't work. */
  private wrongToolSpot(hero: { x: number; y: number }): GatherSpot | null {
    const kind = heldNow().kind
    let best: { d: number; spot: GatherSpot } | null = null
    for (const spot of this.spots) {
      if (actionOf(spot) === kind) continue
      const d = this.distance(hero, spot)
      if (d <= REACH && (!best || d < best.d)) best = { d, spot }
    }
    return best?.spot ?? null
  }

  private carriedDef(action: string): string | null {
    const i = (itemsFor(this.deps.session).view?.instances ?? []).find((x) => itemDef(x.itemDef)?.actions?.includes(action))
    return i?.itemDef ?? null
  }

  /**
   * Work the piece under a point (a mouse click), when the held tool works
   * it and it's in reach. True when work started.
   */
  workAt(point: { x: number; y: number }, hero: { x: number; y: number }): boolean {
    if (this.busy || !this.live()) return false
    const kind = heldNow().kind
    const spot = this.spots.find((s) => {
      if (actionOf(s) !== kind) return false
      const dx = point.x - tileMid(s.tx)
      const dy = point.y - tileBottom(s.ty)
      return Math.abs(dx) <= 12 && dy >= -28 && dy <= 6 && this.distance(hero, s) <= REACH
    })
    if (!spot) return false
    void this.work(spot)
    return true
  }

  /** One swing: the arc, the sound, the piece shivering. */
  private swing(spot: GatherSpot): void {
    const hero = this.deps.hero()
    const hx = hero.sprite.x
    const hy = hero.sprite.y
    const x = tileMid(spot.tx)
    const y = tileBottom(spot.ty)
    hero.facing.set(x - hx, y - 8 - hy).normalize()
    bus.emit(EV.work, { action: actionOf(spot) })
    const slash = this.scene.add.image(hx + (x - hx) * 0.4, hy - 8 + (y - hy) * 0.3, 'slash')
      .setDepth(hy + 2)
      .setRotation(Math.atan2(y - hy, x - hx))
    this.scene.tweens.add({ targets: slash, alpha: 0, duration: 160, onComplete: () => slash.destroy() })
    if (this.deps.reducedMotion) return
    for (const p of this.spritesFor(spot)) {
      this.scene.tweens.add({ targets: p, angle: p.flipX ? -2 : 2, duration: 90, yoyo: true, ease: 'Sine.easeInOut' })
    }
  }

  /** Everything drawn for a spot: the map's own sprites, plus drawn leavings. */
  private spritesFor(spot: GatherSpot): Phaser.GameObjects.Image[] {
    return [...this.deps.spritesAt(spot.tx, spot.ty), ...(this.drawn.get(tileKey(spot.tx, spot.ty)) ?? [])]
  }

  /** What the wood gave, said and shown; a change kept at home is read again. */
  private paid(result: ItemsActionResponse['result']): void {
    const gathered = result.gathered ?? []
    if (gathered.length > 0) {
      const gain = { to: 'bag' as const, itemDef: gathered[0].itemDef, ...(gathered.length === 1 ? { qty: gathered[0].qty } : { label: yieldLine(gathered) }) }
      bus.emit(EV.toast, { text: `Found: ${yieldLine(gathered)}.`, icon: 'sparkle', art: `icon-${gathered[0].itemDef}`, kind: 'gain', gain })
    } else bus.emit(EV.toast, { text: EMPTY_YIELD_LINE, icon: 'sparkle', kind: 'thought' })
    // What the work did to the tool, when it's worth a word.
    const worn = wearLine(result.wear)
    if (worn) bus.emit(EV.toast, { text: worn, icon: 'bag' })
    // Inside your lamplight the server kept the change: read the home again
    // so the next build of the land (a reload, a later visit) shows it.
    const gate = parseHomeArea(this.deps.session.state.area)
    if (gate !== null && result.land) void homesteadsFor(this.deps.session).fetchHome(gate)
  }

  private key(spot: { tx: number; ty: number }): string {
    return `${this.deps.world.areaId}:${spot.tx},${spot.ty}`
  }

  /**
   * A worked piece as it is now: a felled tree is a stump (still in the
   * way, and diggable); a broken boulder or a dug stump is open ground. A
   * seasonal piece stays standing however often it's worked — the caps
   * hold you, not the map.
   */
  private change(spot: GatherSpot, now: 'stump' | 'open'): void {
    if (spot.target === 'stump' && now === 'stump') return // the map already has it
    if (keepsStanding(spot.target)) return // the freshet shore, the bloom patches, the pond ice
    const x = tileMid(spot.tx)
    const y = tileBottom(spot.ty)
    for (const img of this.drawn.get(tileKey(spot.tx, spot.ty)) ?? []) img.destroy()
    this.drawn.delete(tileKey(spot.tx, spot.ty))
    this.deps.fell(spot.tx, spot.ty)
    const atlas = spot.art?.key ?? lookAtlasKey('tangle', null)
    const action = gatheringTarget(spot.target)?.action ?? 'chop'
    const left = leftBehind(action, now)
    const leftFrame = left ? `${left}-0` : null
    if (leftFrame && ensureSceneryArt(this.scene, atlas) && this.scene.textures.get(atlas).has(leftFrame)) {
      const flat = left === 'pebbles'
      const img = this.scene.add.image(x, y, atlas, leftFrame).setOrigin(0.5, 1).setDepth(flat ? -5 : y)
      this.drawn.set(tileKey(spot.tx, spot.ty), [img])
    }
    const i = this.spots.indexOf(spot)
    if (now === 'stump') {
      this.spots.splice(i, 1, { target: 'stump', label: 'Dig the stump', tx: spot.tx, ty: spot.ty, art: spot.art })
      this.publish()
      return
    }
    this.deps.clearSolid(spot.tx, spot.ty)
    if (i >= 0) this.spots.splice(i, 1)
    this.publish()
  }

  /** The soft line, and the pieces nearby shuffling out of reach. */
  private refused(code: string, action: string): void {
    if (code !== 'gathered-enough') {
      bus.emit(EV.toast, { text: itemErrorText(code), kind: 'error' })
      return
    }
    bus.emit(EV.toast, { text: GATHERING_DATA.softCapLine, icon: 'sparkle', kind: 'thought' })
    const hero = this.deps.hero().sprite
    const same = (s: GatherSpot) => (gatheringTarget(s.target)?.action ?? 'chop') === action
    if (!this.deps.reducedMotion) {
      for (const s of this.spots) {
        if (!same(s) || this.distance(hero, s) > SHUFFLE_RADIUS) continue
        const away = Math.sign(tileMid(s.tx) - hero.x) || 1
        for (const p of this.spritesFor(s)) {
          this.scene.tweens.add({ targets: p, x: p.x + away * 2, duration: 400, delay: Math.random() * 300, ease: 'Sine.easeOut' })
        }
      }
    }
    // Nothing of that kind answers the prompt again this visit.
    this.done.enough.add(action)
    this.spots = this.spots.filter((s) => !same(s))
    this.publish()
  }

  /** Something planted on this land: draw it where it went in. */
  private onPlanted(p: { plant: HomePlantView }): void {
    const gate = parseHomeArea(this.deps.world.areaId)
    if (gate === null || this.deps.session.state.area !== this.deps.world.areaId) return
    const s = plantScenery(p.plant, lookAtlasKey('tangle', null))
    if (!ensureSceneryArt(this.scene, s.key)) return
    const img = this.scene.add.image(s.x, s.y, s.key, s.frame).setOrigin(0.5, 1).setFlipX(s.flipX ?? false).setDepth(s.y)
    if (img.height > TILE) img.setScale(TILE / img.height)
    if (!this.deps.reducedMotion) {
      img.setScale(img.scale * 0.4)
      this.scene.tweens.add({ targets: img, scale: img.scale / 0.4, duration: 260, ease: 'Back.easeOut' })
    }
    this.deps.fx.sparkBurst(s.x, s.y - 6, 6)
  }

  private pause(ms: number): Promise<void> {
    return new Promise((res) => this.scene.time.delayedCall(ms, res))
  }
}
