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
import { GATHERING_DATA, gatheringTarget, gatheringToolWord, gatheringVerb, swingPlan, visitIdFor, visitWork, yieldLine, type ToolFeel, type VisitWork } from '../../lib/gathering'
import { parseHomeArea } from '../../lib/homestead'
import { itemDef } from '../../lib/items'
import { itemErrorText, itemsFor } from '../items'
import { homesteadsFor } from '../homestead'
import { plantScenery } from '../homeland'
import { lookAtlasKey } from '../wilds/wilds-looks'
import { ensureSceneryArt } from '../area/props'
import { bus, EV } from '../events'
import { sfx } from '../sfx'
import { TILE } from '../textures'
import type { Session } from '../session'
import type { GatherSpot, WorldData } from '../worlds'
import type { Effects } from './fx'
import type { Hero } from './hero'
import type { PromptAction } from './interactables'
import type { HomePlantView, ItemsActionResponse } from '../../lib/api/types'

export interface GatherAction extends PromptAction {
  spot: GatherSpot
  work: () => void
}

export interface GatheringDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  hero: () => Hero
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

/** What a worked piece leaves behind, in the Tangle's atlas. */
const LEFT_AT: Partial<Record<string, string>> = { chop: 'stump-0', break: 'pebbles-0' }

export class Gathering {
  /** The build of the area that's up now (an answer may outlive the build that asked). */
  private static live: Gathering | null = null
  private spots: GatherSpot[]
  private busy = false
  private current: GatherAction | null = null
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
    // What's carried, for the tool (a world; guests carry no tools).
    const items = itemsFor(deps.session)
    if (deps.session.link && !items.view) void items.load()
    Gathering.live = this
    bus.on(EV.planted, this.onPlanted, this)
    scene.events.once('shutdown', () => {
      if (Gathering.live === this) Gathering.live = null
      bus.off(EV.planted, this.onPlanted, this)
      this.spots = []
      this.current = null
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
   * The nearest workable piece within reach, for the scene's prompt. A piece
   * closer than `closerThan` (the nearest thing you could otherwise press E
   * at — a fallen bucket, someone to talk to) outranks it; one further away
   * keeps quiet.
   */
  promptAction(hero: { x: number; y: number }, closerThan = Infinity): GatherAction | null {
    this.current = null
    if (this.busy || !this.live()) return null
    let best: { d: number; spot: GatherSpot } | null = null
    for (const spot of this.spots) {
      const d = this.distance(hero, spot)
      if (d <= REACH && d < closerThan && (!best || d < best.d)) best = { d, spot }
    }
    if (!best) return null
    const spot = best.spot
    this.current = {
      spot,
      label: spot.label,
      verb: gatheringVerb(gatheringTarget(spot.target)?.action ?? 'chop'),
      x: spot.tx * TILE + 8,
      y: (spot.ty + 1) * TILE - 6,
      work: () => void this.work(spot)
    }
    return this.current
  }

  /** The action key while a gather prompt is up. True when it was used. */
  handleAction(): boolean {
    if (!this.current) return false
    this.current.work()
    return true
  }

  /** Read-only: what can be worked this visit (playtests). */
  spotsView(): { target: string; tx: number; ty: number }[] {
    return this.spots.map((s) => ({ target: s.target, tx: s.tx, ty: s.ty }))
  }

  /** The spot the prompt is on right now (null: no prompt). */
  prompted(): { target: string; tx: number; ty: number; label: string } | null {
    if (!this.current) return null
    return { target: this.current.spot.target, tx: this.current.spot.tx, ty: this.current.spot.ty, label: this.current.label }
  }

  /** The last gather's outcome (playtests: what the server said). */
  lastOutcome(): string {
    return this.last
  }

  // ------------------------------------------------------------ the work

  private distance(hero: { x: number; y: number }, spot: GatherSpot): number {
    return Math.hypot(hero.x - (spot.tx * TILE + 8), hero.y - 8 - (spot.ty + 1) * TILE)
  }

  private async work(spot: GatherSpot): Promise<void> {
    if (this.busy) return
    const { session } = this.deps
    const target = gatheringTarget(spot.target)
    if (!target) return
    this.busy = true
    const hero = this.deps.hero()
    try {
      // The pack may have changed since it was read (a tool from the post,
      // or still loading): read it again before saying there's no tool.
      let tool = this.toolFor(target.action)
      if (!tool) {
        await itemsFor(session).load()
        if (!this.scene.sys.isActive()) return
        tool = this.toolFor(target.action)
      }
      if (!tool) {
        this.last = 'no-tool'
        bus.emit(EV.toast, { text: `You’d want your ${gatheringToolWord(target.action)} for this.`, icon: 'bag' })
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
      const r = await itemsFor(session).gather(tool.id, target.action, spot.target, this.visit, home ? [spot.tx, spot.ty] : undefined)
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
      live.deps.fx.sparkBurst(spot.tx * TILE + 8, (spot.ty + 1) * TILE - 8, (r.value.gathered ?? []).length > 0 ? 10 : 4)
      const there = live.spots.find((s) => s.tx === spot.tx && s.ty === spot.ty)
      if (there) live.change(there, now)
    } finally {
      this.busy = false
      hero.isGathering = false
    }
  }

  /**
   * The carried tool for an action: one still working (blunt and cracked
   * ones refuse), sharpest first, so a dull warden-set tool waits while a
   * keen one is to hand.
   */
  private toolFor(action: string): { id: string; feel: ToolFeel } | null {
    const view = itemsFor(this.deps.session).view
    if (!view) return null
    const usable = view.instances.filter((i) => {
      const d = itemDef(i.itemDef)
      return d?.kind === 'tool' && d.actions?.includes(action) && i.state !== 'blunt' && i.state !== 'cracked'
    })
    usable.sort((a, b) => Number(a.state === 'dull') - Number(b.state === 'dull'))
    const i = usable[0]
    if (!i) return null
    const has = (kind: string) => i.fittings.some((f) => f.fitting === kind)
    return { id: i.id, feel: { bite: has('bite'), heft: has('heft'), dull: i.state === 'dull' } }
  }

  /** One swing: the arc, the sound, the piece shivering. */
  private swing(spot: GatherSpot): void {
    const hero = this.deps.hero()
    const hx = hero.sprite.x
    const hy = hero.sprite.y
    const x = spot.tx * TILE + 8
    const y = (spot.ty + 1) * TILE
    hero.facing.set(x - hx, y - 8 - hy).normalize()
    sfx('swing')
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
    return [...this.deps.spritesAt(spot.tx, spot.ty), ...(this.drawn.get(`${spot.tx},${spot.ty}`) ?? [])]
  }

  /** What the wood gave, said and shown; a change kept at home is read again. */
  private paid(result: ItemsActionResponse['result']): void {
    const gathered = result.gathered ?? []
    if (gathered.length > 0) {
      bus.emit(EV.toast, { text: `Found: ${yieldLine(gathered)}.`, icon: 'sparkle', art: `icon-${gathered[0].itemDef}` })
    }
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
   * way, and diggable); a broken boulder or a dug stump is open ground.
   */
  private change(spot: GatherSpot, now: 'stump' | 'open'): void {
    if (spot.target === 'stump' && now === 'stump') return // the map already has it
    const x = spot.tx * TILE + 8
    const y = (spot.ty + 1) * TILE
    for (const img of this.drawn.get(`${spot.tx},${spot.ty}`) ?? []) img.destroy()
    this.drawn.delete(`${spot.tx},${spot.ty}`)
    this.deps.fell(spot.tx, spot.ty)
    const atlas = spot.art?.key ?? lookAtlasKey('tangle', null)
    const action = gatheringTarget(spot.target)?.action ?? 'chop'
    const leftFrame = LEFT_AT[now === 'stump' ? 'chop' : action]
    if (leftFrame && ensureSceneryArt(this.scene, atlas) && this.scene.textures.get(atlas).has(leftFrame)) {
      const flat = leftFrame.startsWith('pebbles')
      const left = this.scene.add.image(x, y, atlas, leftFrame).setOrigin(0.5, 1).setDepth(flat ? -5 : y)
      this.drawn.set(`${spot.tx},${spot.ty}`, [left])
    }
    const i = this.spots.indexOf(spot)
    if (now === 'stump') {
      this.spots.splice(i, 1, { target: 'stump', label: 'Dig the stump', tx: spot.tx, ty: spot.ty, art: spot.art })
      return
    }
    this.deps.clearSolid(spot.tx, spot.ty)
    if (i >= 0) this.spots.splice(i, 1)
  }

  /** The soft line, and the pieces nearby shuffling out of reach. */
  private refused(code: string, action: string): void {
    if (code !== 'gathered-enough') {
      bus.emit(EV.toast, { text: itemErrorText(code), kind: 'error' })
      return
    }
    bus.emit(EV.toast, { text: GATHERING_DATA.softCapLine, icon: 'sparkle' })
    const hero = this.deps.hero().sprite
    const same = (s: GatherSpot) => (gatheringTarget(s.target)?.action ?? 'chop') === action
    if (!this.deps.reducedMotion) {
      for (const s of this.spots) {
        if (!same(s) || this.distance(hero, s) > SHUFFLE_RADIUS) continue
        const away = Math.sign(s.tx * TILE + 8 - hero.x) || 1
        for (const p of this.spritesFor(s)) {
          this.scene.tweens.add({ targets: p, x: p.x + away * 2, duration: 400, delay: Math.random() * 300, ease: 'Sine.easeOut' })
        }
      }
    }
    // Nothing of that kind answers the prompt again this visit.
    this.done.enough.add(action)
    this.spots = this.spots.filter((s) => !same(s))
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
