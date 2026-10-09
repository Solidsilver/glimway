/**
 * Fishing at the mill pond (docs/design/crafts.md 5): the banks, the line,
 * the float and the fish, on the interactions path like gathering.
 *
 * The banks come from the content (src/lib/fishing.ts), never from the map:
 * each bank tile is an interaction point, open while the rod is in hand, the
 * bank isn't iced over in today's mark and no line is out; its label is the
 * water's band line, the verb Cast. Once a line is out a second point at the
 * bank says Pull in (it cancels) and, after the dip, Reel. Reeling lands the
 * fish on screen; Keep and Let it go are two big context buttons (lane F's
 * row), and the action key keeps it too.
 *
 * The server owns everything that's shared (the pond's stock, the band, the
 * bite): a cast is predicted from the band the bank last read and corrected
 * by the answer's `ready_at`; a refusal takes the line back in and says why.
 * `PlayerState.fishing.cast` puts a line back after a reload, or one cast on
 * another device. Walking more than a tile off the bank pulls the line in.
 * Every operation needs a connection: the pond is shared.
 *
 * Reduced motion: the float stays still, and the bite is a ring and the word
 * Reel. Sound goes through the bus (src/game/sound.ts).
 */
import Phaser from 'phaser'
import { calendarAt } from '../../lib/calendar'
import { LET_GO_KEY } from '../../content/controls'
import {
  bandFrom,
  bandLine,
  bankDistance,
  bankFor,
  bankOpen,
  castPhase,
  floatTile,
  fishingRefusal,
  FISHING_VERBS,
  leaveReachPx,
  castReachPx,
  ON_THE_LINE,
  predictedCast,
  ROD_ART,
  rodPose,
  settleEnds,
  slippedOff,
  waterFor,
  watersForArea,
  type FishBank,
  type FishWater
} from '../../lib/fishing'
import { itemDef } from '../../lib/items'
import { TERRAIN } from '../../lib/tile'
import { gameNow, serverNow } from '../clock'
import { hideContextButtons, showContextButton } from '../context-buttons'
import { bus, EV } from '../events'
import { heldNow } from '../held'
import { itemsFor } from '../items'
import { crArt } from '../crafts-art'
import { registerFishingLoops } from '../fishing-art'
import { itemsArtKey } from '../items-pass'
import { sfx } from '../sfx'
import { tileMid, tileBottom } from '../../lib/tile'
import type { Session } from '../session'
import type { WorldData } from '../worlds'
import type { Effects } from './fx'
import type { Hero } from './hero'
import type { Interactable, Interactables } from './interactables'

export interface FishingDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  hero: () => Hero
  interactables: Interactables
  /** Write the hero's spot into the save now (the server measures the bank's reach from it). */
  notePosition: () => void
  /** The hero has control (no panel, move or beat holds the world): Q lets a fish go only then. */
  live?: () => boolean
}


/** A line out, as this screen holds it: the server's cast, or the prediction before its answer. */
interface Line {
  id: string
  water: string
  bank: string
  species: string
  readyAt: number
  holdUntil: number
  band: string
  /** Still the prediction: no answer yet. */
  predicted: boolean
}

/** Water terrain (the float lands only on water). */
const WATER = new Set<number>([TERRAIN.water_a, TERRAIN.water_b])

/** A crafts frame's texture key, when it loaded. */
const has = (scene: Phaser.Scene, frame: string): string | null => (scene.textures.exists(crArt(frame)) ? crArt(frame) : null)
/** The held rod's art is two tiles long at the hand: drawn at about a tile beside the hero. */
const ROD_SCALE = 0.55

/** The presence pose (crafts.md 5.5): 'fishing' while a line is out at the bank. */
let posing = false
export function fishingPose(): 'fishing' | null {
  return posing ? 'fishing' : null
}

export class Fishing {
  /** The build of the area that's up now (an answer may outlive the build that asked). */
  private static live: Fishing | null = null
  private readonly waters: FishWater[]
  /** Each water's band, as the server last said (absent: not read yet). */
  private bands = new Map<string, string>()
  private line: Line | null = null
  /** A fish on the bank: Keep or Let it go. */
  private landed: Line | null = null
  private busy = false
  /** The hero has stood within reach of the line's bank this build (leaving it then pulls the line in). */
  private atBank = false
  private bitten = false
  /** The last outcome, as words for the playtest hooks. */
  private last = '-'

  // ---- drawing
  private rod: Phaser.GameObjects.Image | null = null
  private cord: Phaser.GameObjects.Graphics | null = null
  private float: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc | null = null
  private rings: Phaser.GameObjects.Sprite | null = null
  private word: Phaser.GameObjects.Text | null = null
  private floatAt: { x: number; y: number } | null = null

  constructor(private scene: Phaser.Scene, private deps: FishingDeps) {
    this.waters = watersForArea(deps.world.areaId)
    if (this.waters.length === 0) return
    registerFishingLoops(scene)
    Fishing.live = this
    this.publish()
    // A line out already (a reload at the bank, or another device): it's the account's.
    this.adoptServerLine()
    if (deps.session.link) void this.readBands()
    const onState = () => {
      if (!this.busy && !this.landed) this.adoptServerLine()
    }
    bus.on(EV.link, onState)
    // Q lets a landed fish go, as the Let it go button does (Keep is E, the action key).
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== `Key${LET_GO_KEY}` || e.repeat || e.ctrlKey || e.metaKey || e.altKey || !this.landed) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (deps.live && !deps.live()) return
      void this.settle(false)
    }
    scene.input.keyboard?.on('keydown', onKey)
    scene.events.once('shutdown', () => {
      bus.off(EV.link, onState)
      scene.input.keyboard?.off('keydown', onKey)
      this.leaving()
      this.clearDrawing()
      hideContextButtons('fish-')
      posing = false
      if (Fishing.live === this) Fishing.live = null
    })
  }

  // ------------------------------------------------------------ the points

  /** Connected (the pond is the world's), in this area. */
  private live(): boolean {
    return !!this.deps.session.link && this.deps.session.state.area === this.deps.world.areaId
  }

  private mark(): string {
    return calendarAt(gameNow()).mark
  }

  /** The bank tiles (Cast), and the line's own point at its bank (Pull in, then Reel). */
  private publish(): void {
    const points: Interactable[] = []
    for (const water of this.waters) {
      for (const bank of water.banks) {
        for (const t of bank.tiles) {
          points.push({
            id: `fish:${water.id}:${bank.id}:${t.tx},${t.ty}`,
            x: tileMid(t.tx),
            y: tileBottom(t.ty) - 2,
            reach: castReachPx(),
            clickReach: castReachPx(),
            markerOffset: 18,
            label: () => this.bankLabel(water),
            verb: FISHING_VERBS.cast,
            tool: 'fish',
            // The point's marker sits under the tile; the offer follows the server's measure (where to the tile's middle).
            available: () => !this.busy && !this.line && !this.landed && heldNow().kind === 'fish' && bankOpen(bank, this.mark()) && this.live() && this.heroWithin(bank, castReachPx()),
            activate: () => void this.cast(water, bank)
          })
          // While a line is out from this bank: pull it in, or reel once the float dips.
          points.push({
            id: `fish:line:${water.id}:${bank.id}:${t.tx},${t.ty}`,
            x: tileMid(t.tx),
            y: tileBottom(t.ty) - 2,
            reach: leaveReachPx() + 4,
            clickReach: leaveReachPx() + 4,
            rank: 1,
            markerOffset: 18,
            tool: 'fish',
            label: () => (this.landed ? this.landedLabel() : this.phase() === 'ready' ? ON_THE_LINE : 'Pull the line in'),
            verb: () => (this.landed ? FISHING_VERBS.keep : this.phase() === 'ready' ? FISHING_VERBS.reel : FISHING_VERBS.pull),
            // Landed: the prompt names both choices and their keys (Keep on E, Let it go on Q).
            alt: () => (this.landed ? { key: LET_GO_KEY, label: FISHING_VERBS.release } : null),
            available: () => !this.busy && this.lineFrom(water, bank) && this.heroWithin(bank, leaveReachPx()),
            activate: () => {
              if (this.landed) void this.settle(true)
              else if (this.phase() === 'ready') this.reel()
              else void this.pullIn('pulled')
            }
          })
        }
      }
    }
    this.deps.interactables.register(this, points)
  }

  /** The hero's feet within `px` of the bank, measured as the server measures `where` (to a bank tile's middle). */
  private heroWithin(bank: FishBank, px: number): boolean {
    const hero = this.deps.hero().sprite
    return bankDistance(bank, hero.x, hero.y) <= px
  }

  private lineFrom(water: FishWater, bank: FishBank): boolean {
    const l = this.landed ?? this.line
    return !!l && l.water === water.id && l.bank === bank.id
  }

  /** What a bank reads: the water's band line (5.1), or its name before the first read. */
  private bankLabel(water: FishWater): string {
    return bandLine(this.bands.get(water.id)) ?? 'The mill pond'
  }

  private landedLabel(): string {
    const name = itemDef(this.landed?.species ?? '')?.name ?? 'A fish'
    return `${name}! Keep it`
  }

  private phase(): 'waiting' | 'ready' | 'lapsed' | null {
    return this.line ? castPhase(this.line, serverNow()) : null
  }

  // ------------------------------------------------------------ the server's line

  /** Each water's band (GET /api/fishing/waters): on arriving, and after a settle or a cancel. */
  private async readBands(): Promise<void> {
    const link = this.deps.session.link
    if (!link) return
    const r = await link.readWaters(this.deps.world.areaId)
    if (!r.ok) return
    for (const w of r.value) this.bands.set(w.id, bandFrom(w.band))
    this.deps.interactables.invalidatePrompt()
  }

  /** Put back the line `PlayerState.fishing.cast` holds (a reload, another device), or take ours in when it's gone. */
  private adoptServerLine(): void {
    const cast = this.deps.session.link?.server.fishing?.cast
    if (!cast) {
      // The world says no line is out (a settle elsewhere, a lapse): ours goes, unless it's still being asked.
      if (this.line && !this.line.predicted && !this.busy) this.dropLine()
      return
    }
    if (!waterFor(cast.water) || !this.waters.some((w) => w.id === cast.water)) return
    if (this.line?.id === cast.id) return
    if (castPhase(cast, serverNow()) === 'lapsed') return
    this.line = { id: cast.id, water: cast.water, bank: cast.bank, species: cast.species, readyAt: cast.readyAt, holdUntil: cast.holdUntil, band: cast.band, predicted: false }
    this.bitten = false
    this.atBank = false
    this.drawLine()
    if (castPhase(cast, serverNow()) === 'ready') bus.emit(EV.toast, { text: `${ON_THE_LINE}.`, icon: 'sparkle', kind: 'thought' })
  }

  // ------------------------------------------------------------ cast, pull in, reel, keep

  /** The rod in hand (the belt's best rod), or null with the reason said. */
  private rodInHand(): string | null {
    const slot = heldNow()
    if (slot.kind !== 'fish' || !slot.instance) {
      bus.emit(EV.toast, { text: fishingRefusal('wrong-tool'), kind: 'error' })
      return null
    }
    if (!slot.usable) {
      bus.emit(EV.toast, { text: fishingRefusal('worn-out'), kind: 'error' })
      return null
    }
    return slot.instance
  }

  private async cast(water: FishWater, bank: FishBank): Promise<void> {
    const link = this.deps.session.link
    if (this.busy || this.line || !link) return
    if (!link.online) {
      this.last = 'refused:offline'
      bus.emit(EV.toast, { text: fishingRefusal('offline'), kind: 'error' })
      return
    }
    const rod = this.rodInHand()
    if (!rod) return
    this.busy = true
    this.deps.notePosition()
    // Predicted at once (5.5): the band the bank last read, its wait from now.
    const band = this.bands.get(water.id) ?? 'healthy'
    const guess = predictedCast(band, serverNow())
    this.line = { id: '', water: water.id, bank: bank.id, species: water.species[0]?.item ?? '', ...guess, band, predicted: true }
    this.bitten = false
    this.atBank = true
    sfx('fish-cast')
    this.drawLine(true)
    try {
      const r = await link.fishCast({ water: water.id, bank: bank.id, rod })
      const live = Fishing.live === this ? this : null
      if (!r.ok) {
        if (r.code === 'water-still') this.bands.set(water.id, 'still')
        if (live) {
          live.last = `refused:${r.code}`
          live.dropLine()
        }
        bus.emit(EV.toast, { text: fishingRefusal(r.code), kind: 'error' })
        return
      }
      const c = r.result.cast!
      this.bands.set(water.id, bandFrom(r.result.band || c.band))
      if (!live) return
      live.last = 'cast'
      live.line = { id: c.id, water: c.water, bank: c.bank, species: c.species, readyAt: c.readyAt, holdUntil: c.holdUntil, band: c.band, predicted: false }
    } finally {
      this.busy = false
      this.deps.interactables.invalidatePrompt()
    }
  }

  /** Take the line in: the cast closes and the fish stays in the water. */
  private async pullIn(why: 'pulled' | 'left'): Promise<void> {
    const line = this.line
    const link = this.deps.session.link
    if (!line || this.busy) return
    this.dropLine()
    this.last = why
    if (why === 'left') bus.emit(EV.toast, { text: 'You step off the bank and the line comes in.', icon: 'sparkle', kind: 'thought' })
    if (!link || !line.id) return
    this.busy = true
    try {
      const r = await link.fishCancel(line.id)
      if (r.ok) this.bands.set(line.water, bandFrom(r.result.band))
      // Already closed (it lapsed, or another device settled it): nothing to take back.
      else if (r.code !== 'no-cast') bus.emit(EV.toast, { text: fishingRefusal(r.code), kind: 'error' })
    } finally {
      this.busy = false
      this.deps.interactables.invalidatePrompt()
    }
  }

  /** One press: a short landing, the fish arcs out, and Keep or Let it go (no server call yet). */
  private reel(): void {
    const line = this.line
    if (!line || line.predicted) return
    this.line = null
    this.landed = line
    this.last = 'landed'
    sfx('fish-splash')
    const at = this.floatAt
    this.clearFloat()
    if (at) this.landing(at, line.species)
    this.drawRod('raised')
    this.showButtons(line)
    this.deps.interactables.invalidatePrompt()
  }

  /** Keep and Let it go, the two big buttons over the action corner (lane F's context row). */
  private showButtons(line: Line): void {
    // Mid-sentence, as the toasts say it ("Let mill roach go").
    const name = (itemDef(line.species)?.name ?? 'the fish').toLowerCase()
    showContextButton({ id: 'fish-keep', label: FISHING_VERBS.keep, art: line.species, icon: 'bag', size: 'big', order: 1, key: 'E', ariaLabel: `Keep ${name}`, press: () => void this.settle(true) })
    showContextButton({ id: 'fish-release', label: FISHING_VERBS.release, icon: 'heart', size: 'big', order: 2, key: LET_GO_KEY, ariaLabel: `Let ${name} go`, press: () => void this.settle(false) })
  }

  /** Keep it (into the pack, the rod wears by one) or let it go (back in the pond, nothing paid). */
  private async settle(keep: boolean): Promise<void> {
    const line = this.landed
    const link = this.deps.session.link
    if (!line || this.busy || !link) return
    if (!link.online) {
      bus.emit(EV.toast, { text: fishingRefusal('offline'), kind: 'error' })
      return
    }
    this.busy = true
    hideContextButtons('fish-')
    const at = this.deps.hero().sprite
    try {
      const r = await link.fishSettle({ cast: line.id, keep })
      const live = Fishing.live === this
      if (!r.ok) {
        this.last = `refused:${r.code}`
        bus.emit(EV.toast, { text: fishingRefusal(r.code), kind: 'error' })
        if (settleEnds(r.code)) {
          // The cast is over (or the world says it isn't there yet): the fish goes from the bank.
          this.landed = null
          this.clearDrawing()
        } else if (live && this.landed === line) this.showButtons(line) // busy, pending…: still on the bank, press again
        return
      }
      this.landed = null
      this.clearDrawing()
      this.bands.set(line.water, bandFrom(r.result.band))
      if (r.result.kept) {
        this.last = 'kept'
        const def = r.result.item || line.species
        const name = itemDef(def)?.name ?? def
        bus.emit(EV.toast, { text: `Kept: ${name.toLowerCase()}.`, icon: 'bag', art: def, kind: 'gain', gain: { to: 'bag', itemDef: def, qty: 1 } })
        // The pack as the world holds it now (the fish, the rod's wear; a carry step may move on).
        void itemsFor(this.deps.session).load()
      } else {
        this.last = 'released'
        bus.emit(EV.toast, { text: 'Back it goes. The water closes over it.', icon: 'sparkle', kind: 'thought' })
        if (!this.deps.reducedMotion) this.deps.fx.sparkBurst(at.x, at.y - 10, 4)
      }
    } finally {
      this.busy = false
      this.deps.interactables.invalidatePrompt()
    }
  }

  /**
   * The area goes (a warp, a fall, the turning, a door) with a line out: take
   * it in, or let a landed fish go, so the account's one open cast and its
   * reserved fish don't wait for the lazy lapse. Fire and forget: the answer
   * comes to an area that's gone, and the lapse is the fallback if it's lost.
   */
  private leaving(): void {
    const link = this.deps.session.link
    // An answer already on its way (a walk-away settle, a pull-in) closes it itself.
    if (!link || this.busy) return
    if (this.landed?.id) void link.fishSettle({ cast: this.landed.id, keep: false })
    else if (this.line && !this.line.predicted && this.line.id) void link.fishCancel(this.line.id)
  }

  /** The line comes in on this screen (the drawing and the buttons go). */
  private dropLine(): void {
    this.line = null
    this.landed = null
    this.bitten = false
    this.atBank = false
    this.clearDrawing()
    hideContextButtons('fish-')
    this.deps.interactables.invalidatePrompt()
  }

  // ------------------------------------------------------------ every frame

  update(): void {
    if (Fishing.live !== this) return
    const hero = this.deps.hero().sprite
    const l = this.landed ?? this.line
    const bank = l ? bankFor(waterFor(l.water)!, l.bank) : undefined
    posing = !!l && !!bank && bankDistance(bank, hero.x, hero.y) <= leaveReachPx()
    if (!l || !bank) return
    // Walking more than a tile from the bank pulls the line in (5.1).
    const d = bankDistance(bank, hero.x, hero.y)
    if (d <= leaveReachPx()) this.atBank = true
    else if (this.atBank && !this.busy) {
      if (this.landed) {
        // A landed fish you walk away from goes back: let it go.
        void this.settle(false)
      } else void this.pullIn('left')
      return
    }
    // Past the hold, a fish on the line or on the bank slips back to the water (the server refuses a settle then).
    if (!this.busy && slippedOff(this.line, this.landed, serverNow())) {
      this.dropLine()
      this.last = 'lapsed'
      bus.emit(EV.toast, { text: 'It slipped off the hook and went back to the water.', icon: 'sparkle', kind: 'thought' })
      return
    }
    if (!this.line) {
      this.drawRod('raised')
      return
    }
    const phase = this.phase()
    if (phase === 'ready' && !this.bitten && !this.line.predicted) {
      this.bitten = true
      sfx('fish-bite')
      this.deps.interactables.invalidatePrompt()
    }
    this.animate()
  }

  // ------------------------------------------------------------ drawing

  /** The float's spot on the water, from the line's bank and where the hero stands. */
  private floatSpot(): { x: number; y: number } | null {
    const l = this.line
    const bank = l ? bankFor(waterFor(l.water)!, l.bank) : undefined
    if (!bank) return null
    const hero = this.deps.hero().sprite
    const w = this.deps.world
    const isWater = (tx: number, ty: number) => ty >= 0 && ty < w.height && tx >= 0 && tx < w.width && WATER.has(w.ground[ty][tx])
    const t = floatTile(bank, hero.x, hero.y, isWater)
    return t ? { x: tileMid(t.tx), y: tileBottom(t.ty) - 5 } : null
  }

  private drawLine(fresh = false): void {
    this.floatAt = this.floatSpot()
    if (!this.floatAt) return
    const { x, y } = this.floatAt
    const hero = this.deps.hero()
    hero.facing.set(x - hero.sprite.x, y - hero.sprite.y).normalize()
    this.drawRod('out')
    this.clearFloat()
    // The float and rings on the crafts pack; without it, a dot for the float (design 10, "Order").
    const key = has(this.scene, 'float-0')
    this.float = key ? this.scene.add.sprite(x, y, key).setOrigin(0.5, 28 / 32).setDepth(y - 6) : this.scene.add.circle(x, y - 2, 1.5, 0xd94a3a).setDepth(y - 6)
    const rings = has(this.scene, 'water-rings-0')
    if (rings) this.rings = this.scene.add.sprite(x, y + 1, rings).setOrigin(0.5, 28 / 32).setDepth(y - 7).setAlpha(0.8).setVisible(!this.deps.reducedMotion)
    this.cord = this.scene.add.graphics().setDepth(Math.max(y, hero.sprite.y) + 2)
    if (fresh && !this.deps.reducedMotion && this.float) {
      // The float flies out from the rod tip and lands.
      const tip = this.rodTip()
      const toY = this.float.y
      this.float.setPosition(tip.x, tip.y)
      // The scene holds still while the cast is asked: the tween redraws the line itself.
      this.scene.tweens.add({ targets: this.float, x, duration: 260, ease: 'Sine.easeOut', onUpdate: () => this.animate() })
      this.scene.tweens.add({ targets: this.float, y: toY, duration: 260, ease: 'Back.easeIn' })
    }
    this.animate()
  }

  /** Where the hero's hand is (the rod's grip). */
  private hand(): { x: number; y: number } {
    const hero = this.deps.hero().sprite
    const left = this.floatAt ? this.floatAt.x < hero.x - 2 : hero.flipX
    return { x: hero.x + (left ? -3 : 3), y: hero.y - 7 }
  }

  /** The rod at the hero's hand: raised (a fish landed), or held out toward the float. */
  private drawRod(pose: 'raised' | 'out'): void {
    const hero = this.deps.hero().sprite
    const key = has(this.scene, `rod-held-${pose}`)
    if (!key) return
    const hand = this.hand()
    const aim = pose === 'out' && this.floatAt ? rodPose(hand, this.floatAt, ROD_SCALE) : { flipX: hero.flipX, rotation: 0 }
    if (!this.rod) this.rod = this.scene.add.image(0, 0, key).setScale(ROD_SCALE)
    if (this.rod.texture.key !== key) this.rod.setTexture(key)
    const gx = ROD_ART.grip.x / 128
    this.rod
      .setFlipX(aim.flipX)
      .setOrigin(aim.flipX ? 1 - gx : gx, ROD_ART.grip.y / 128)
      .setRotation(aim.rotation)
      .setPosition(hand.x, hand.y)
      .setDepth(hero.y + 1)
  }

  /** Where the line leaves the rod (world px). */
  private rodTip(): { x: number; y: number } {
    const hand = this.hand()
    return this.floatAt ? rodPose(hand, this.floatAt, ROD_SCALE).tip : { x: hand.x, y: hand.y - 8 }
  }

  /** The bob, the rings, the bite's dip, the line itself. */
  private animate(): void {
    if (!this.line || !this.floatAt) return
    this.drawRod('out')
    const ready = this.phase() === 'ready' && !this.line.predicted
    const still = this.deps.reducedMotion
    if (this.float instanceof Phaser.GameObjects.Sprite) {
      // Bobbing, then the dip; with reduced motion one still frame for each.
      if (still) {
        const key = has(this.scene, ready ? 'float-4' : 'float-0')
        if (key && this.float.texture.key !== key) this.float.stop().setTexture(key)
      } else this.loop(this.float, ready ? 'fish-bite' : 'fish-bob')
    }
    if (this.rings) {
      // Reduced motion: no rings while waiting; one still ring is the bite.
      this.rings.setVisible(!still || ready)
      if (still) {
        const key = has(this.scene, 'water-rings-2')
        if (key && this.rings.texture.key !== key) this.rings.stop().setTexture(key)
      } else this.loop(this.rings, 'fish-rings')
    }
    // Reduced motion says the bite in a word too.
    if (still && ready && !this.word) {
      this.word = this.scene.add
        .text(this.floatAt.x, this.floatAt.y - 10, FISHING_VERBS.reel, { fontFamily: 'Pixelify Sans, monospace', fontSize: '8px', color: '#fff4d6', stroke: '#2b1d14', strokeThickness: 2, resolution: 4 })
        .setOrigin(0.5, 1)
        .setDepth(this.floatAt.y + 40)
    } else if (!(still && ready) && this.word) {
      this.word.destroy()
      this.word = null
    }
    if (this.cord && this.float) {
      const tip = this.rodTip()
      const fx = this.float.x
      const fy = this.float.y - 4
      // A slack line: sagging between the tip and the float, taut on a bite.
      const sag = ready ? 1 : 6
      this.cord.clear()
      this.cord.lineStyle(0.5, 0xf2ead8, 0.85)
      const curve = new Phaser.Curves.QuadraticBezier(
        new Phaser.Math.Vector2(tip.x, tip.y),
        new Phaser.Math.Vector2((tip.x + fx) / 2, Math.max(tip.y, fy) + sag),
        new Phaser.Math.Vector2(fx, fy)
      )
      curve.draw(this.cord, 12)
    }
  }

  /** Play a fishing loop on a sprite, unless it's playing already (or didn't register: the frame stays). */
  private loop(sprite: Phaser.GameObjects.Sprite, key: string): void {
    const anim = crArt(key)
    if (sprite.anims.currentAnim?.key === anim || !this.scene.anims.exists(anim)) return
    sprite.play(anim)
  }

  /** The landing: a splash where the float was, and the fish arcing out to the hero. */
  private landing(at: { x: number; y: number }, species: string): void {
    const hero = this.deps.hero().sprite
    const splash = has(this.scene, 'landing-splash-0')
    if (splash) {
      const img = this.scene.add.sprite(at.x, at.y + 2, splash).setOrigin(0.5, 60 / 64).setDepth(at.y)
      if (this.deps.reducedMotion || !this.scene.anims.exists(crArt('fish-splash'))) this.scene.time.delayedCall(400, () => img.destroy())
      else img.play(crArt('fish-splash')).once('animationcomplete', () => img.destroy())
    }
    // The fish as the crafts pass draws it (its frame is the item's id), else its inventory icon.
    const fishKey = has(this.scene, species) ?? itemsArtKey(`item-${species}`)
    if (!this.scene.textures.exists(fishKey)) return
    const fish = this.scene.add.image(at.x, at.y - 4, fishKey).setOrigin(0.5, 0.5).setDepth(hero.y + 30).setScale(0.75)
    const to = { x: hero.x + (at.x < hero.x ? -6 : 6), y: hero.y - 22 }
    if (this.deps.reducedMotion) {
      fish.setPosition(to.x, to.y)
    } else {
      this.scene.tweens.add({ targets: fish, x: to.x, duration: 380, ease: 'Sine.easeOut' })
      this.scene.tweens.add({ targets: fish, y: Math.min(at.y, to.y) - 14, duration: 190, ease: 'Sine.easeOut', yoyo: false, onComplete: () => fish.active && this.scene.tweens.add({ targets: fish, y: to.y, duration: 190, ease: 'Sine.easeIn' }) })
      this.scene.tweens.add({ targets: fish, angle: at.x < hero.x ? -300 : 300, duration: 380 })
    }
    this.scene.time.delayedCall(this.deps.reducedMotion ? 900 : 1200, () => {
      if (!fish.active) return
      if (this.deps.reducedMotion) fish.destroy()
      else this.scene.tweens.add({ targets: fish, alpha: 0, duration: 200, onComplete: () => fish.destroy() })
    })
  }

  private clearFloat(): void {
    this.float?.destroy()
    this.rings?.destroy()
    this.cord?.destroy()
    this.word?.destroy()
    this.float = null
    this.rings = null
    this.cord = null
    this.word = null
  }

  private clearDrawing(): void {
    this.clearFloat()
    this.rod?.destroy()
    this.rod = null
    this.floatAt = null
  }

  // ------------------------------------------------------------ playtests

  /** Read-only: what fishing is doing here (playtest hooks). */
  view(): { line: { id: string; bank: string; phase: string; predicted: boolean } | null; landed: string | null; bands: Record<string, string>; last: string; pose: string | null } {
    return {
      line: this.line ? { id: this.line.id, bank: this.line.bank, phase: this.phase() ?? '-', predicted: this.line.predicted } : null,
      landed: this.landed?.species ?? null,
      bands: Object.fromEntries(this.bands),
      last: this.last,
      pose: fishingPose()
    }
  }
}

/**
 * A friend fishing, as this screen draws them (crafts.md 5.5): the rod at
 * their side and a float out in the way they face, from presence's
 * `pose: 'fishing'`. No bite on their screen: the float just bobs (still
 * with reduced motion). Lane E's remote players own when to call it.
 */
export class RemoteFishingLine {
  private rod: Phaser.GameObjects.Image | null = null
  private float: Phaser.GameObjects.Sprite | null = null
  private cord: Phaser.GameObjects.Graphics | null = null

  constructor(private scene: Phaser.Scene, private reducedMotion: boolean) {
    registerFishingLoops(scene)
  }

  /** Draw (or take down) the line for a player at (x, y) facing (fx, fy). */
  update(at: { x: number; y: number }, facing: { x: number; y: number }, fishing: boolean): void {
    if (!fishing) {
      this.destroy()
      return
    }
    const rodKey = has(this.scene, 'rod-held-out')
    const floatKey = has(this.scene, 'float-0')
    if (!rodKey || !floatKey) return
    const len = Math.hypot(facing.x, facing.y) || 1
    const fx = at.x + (facing.x / len) * 36
    const fy = at.y + (facing.y / len) * 36
    const hand = { x: at.x + (facing.x < -0.3 ? -3 : 3), y: at.y - 7 }
    const aim = rodPose(hand, { x: fx, y: fy }, ROD_SCALE)
    if (!this.rod) this.rod = this.scene.add.image(0, 0, rodKey).setScale(ROD_SCALE)
    const gx = ROD_ART.grip.x / 128
    this.rod.setFlipX(aim.flipX).setOrigin(aim.flipX ? 1 - gx : gx, ROD_ART.grip.y / 128).setRotation(aim.rotation).setPosition(hand.x, hand.y).setDepth(at.y + 1)
    if (!this.float) {
      this.float = this.scene.add.sprite(fx, fy, floatKey).setOrigin(0.5, 28 / 32)
      if (!this.reducedMotion && this.scene.anims.exists(crArt('fish-bob'))) this.float.play(crArt('fish-bob'))
    }
    this.float.setPosition(fx, fy).setDepth(fy - 6)
    if (!this.cord) this.cord = this.scene.add.graphics()
    const tip = aim.tip
    this.cord.setDepth(Math.max(fy, at.y) + 2).clear().lineStyle(0.5, 0xf2ead8, 0.85)
    new Phaser.Curves.QuadraticBezier(new Phaser.Math.Vector2(tip.x, tip.y), new Phaser.Math.Vector2((tip.x + fx) / 2, Math.max(tip.y, fy - 4) + 6), new Phaser.Math.Vector2(fx, fy - 4)).draw(this.cord, 12)
  }

  destroy(): void {
    this.rod?.destroy()
    this.float?.destroy()
    this.cord?.destroy()
    this.rod = null
    this.float = null
    this.cord = null
  }
}
