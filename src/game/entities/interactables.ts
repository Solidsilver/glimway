/**
 * Interactables: everything the action button can be used on, in one list.
 *
 * Each feature registers its own points (`register`) and each point carries
 * what it is: where it stands, how near you must be, what the prompt and the
 * touch button say, its "!" / "…" marker, and what pressing does. One loop
 * picks the target every frame (the highest rank in reach, then the
 * nearest), and drives the prompt, the markers and the keycap hint.
 *
 * Adding something you can use (a door, a stair, a pet, a fishing bank) is
 * one `register` call with its points; nothing here changes.
 */
import type Phaser from 'phaser'
import { bus, EV, type PromptAlt, type PromptPayload } from '../events.ts'
import { isTouchFirst } from '../../ui/device.ts'
import type { InteractId } from '../worlds.ts'
import type { BeltKind } from '../../lib/belt.ts'

export type MarkerKind = 'quest' | 'talk' | null

/** A value fixed when the point is made, or worked out when it's read. */
type Live<T> = T | (() => T)

export interface Interactable {
  id: InteractId
  /** Where it stands (world px): the hero's feet are measured to this. */
  readonly x: number
  readonly y: number
  /** What the prompt says pressing will do (null: say nothing). */
  label: Live<string | null>
  /** Short word for the touch action button (default: the label's first word). */
  verb?: Live<string | null>
  /** The belt kind whose work this is (the rod's cast): a click anywhere uses it while that tool is in hand. */
  tool?: BeltKind
  /** A second choice on its own key (the owning lane handles the key): the desktop prompt names both. */
  alt?: Live<PromptAlt | null>
  /** The "!" or "…" over it, read when markers refresh. Never marked without one. */
  marker?: () => MarkerKind
  /** Height above (x, y) where its marker and the keycap hint float (default 25). */
  markerOffset?: number
  /** How near the hero's feet must be (default 34). */
  reach?: number
  /**
   * How near the hero's feet must be for a click on it to use it (default
   * 40, a little more than `reach`). A point the server measures (a piece to
   * work, a Wilds claim) uses its working reach, so a click never asks for
   * what the server would refuse as too far.
   */
  clickReach?: number
  /** A higher rank wins over anything of a lower rank in reach, however near (default 0). */
  rank?: number
  /** Whether it can be used right now (default: always). Checked only in reach. */
  available?: () => boolean
  /** Use it. True: it's used up, and its point goes. */
  activate: () => boolean | void
}

export const DEFAULT_REACH = 34
export const DEFAULT_CLICK_REACH = 40
const DEFAULT_MARKER_OFFSET = 25

const read = <T>(v: Live<T>): T => (typeof v === 'function' ? (v as () => T)() : v)

/** What the target is chosen by: the hero's feet to the point. */
const distance = (player: { x: number; y: number }, it: Interactable) => Math.hypot(player.x - it.x, player.y - it.y)

export class Interactables {
  /** Every registered point, in registration order. */
  readonly list: Interactable[] = []
  currentTarget: Interactable | null = null
  /** undefined until the first frame, so a new area always clears a stale prompt. */
  private lastPrompt: string | null | undefined = undefined
  /** Floating "!" / "…" markers, for the points that can carry one. */
  private markers = new Map<Interactable, Phaser.GameObjects.Image>()
  /** Keycap hint floating above the current interaction target. */
  private keyHint: Phaser.GameObjects.Image | null = null
  /** Each owner's points; registering again replaces them. */
  private byOwner = new Map<object, readonly Interactable[]>()
  private markersBuilt = false
  /** Residents away from their spot (their markers wait there, hidden: ./npcs.ts `away`). */
  private awayCheck: ((id: string) => boolean) | null = null
  /** Residents not here at all (their cycle is elsewhere: ./npcs.ts `gone`): not usable. */
  private goneCheck: ((id: string) => boolean) | null = null
  private awayNow = ''

  private readonly scene: Phaser.Scene
  private readonly deps: { reducedMotion: boolean }

  constructor(scene: Phaser.Scene, deps: { reducedMotion: boolean }) {
    this.scene = scene
    this.deps = deps
  }

  /** Replace an owner's points (and their markers). */
  register(owner: object, points: readonly Interactable[]): void {
    for (const it of this.byOwner.get(owner) ?? []) this.drop(it)
    this.byOwner.set(owner, points)
    this.list.push(...points)
    if (this.markersBuilt) {
      for (const it of points) this.addMarker(it)
      this.refreshMarkers()
    }
    this.lastPrompt = undefined
  }

  /** Say who is away from their spot right now (checked every frame). */
  setAway(check: (id: string) => boolean): void {
    this.awayCheck = check
  }

  /** Say who isn't here at all right now (checked every frame; their points can't be used). */
  setGone(check: (id: string) => boolean): void {
    this.goneCheck = check
  }

  /** Markers for every point so far (later points get theirs as they come), and the keycap hint. */
  buildMarkers(): void {
    this.markersBuilt = true
    for (const it of this.list) this.addMarker(it)
    this.keyHint = this.scene.add.image(0, 0, isTouchFirst() ? 'key-tap' : 'key-e').setOrigin(0.5, 1).setDepth(6001).setVisible(false)
    this.refreshMarkers()
    // A new day, project or plot can give someone something new to say.
    const refresh = () => {
      if (this.scene.sys?.isActive()) this.refreshMarkers()
    }
    bus.on(EV.villageChanged, refresh)
    bus.on(EV.homeChanged, refresh)
    const off = () => {
      bus.off(EV.villageChanged, refresh)
      bus.off(EV.homeChanged, refresh)
    }
    this.scene.events.once('shutdown', off)
    this.scene.events.once('destroy', off)
  }

  /** "!" over whoever moves the story on, "…" over anyone with news. */
  refreshMarkers(): void {
    for (const [it, img] of this.markers) {
      if (!img.active) continue
      const kind = it.marker?.() ?? null
      if (kind) img.setTexture(kind === 'quest' ? 'mark-quest' : 'mark-talk')
      img.setVisible(kind !== null && this.currentTarget !== it && !this.awayCheck?.(it.id) && !this.goneCheck?.(it.id))
    }
  }

  /**
   * Choose the target (the highest rank in reach, then the nearest) and
   * drive the prompt, the markers and the keycap hint from it.
   */
  update(player: { x: number; y: number }, now: number): void {
    let best: Interactable | null = null
    let bestRank = -Infinity
    let bestDist = Infinity
    for (const it of this.list) {
      const d = distance(player, it)
      if (d >= (it.reach ?? DEFAULT_REACH)) continue
      const rank = it.rank ?? 0
      if (rank < bestRank || (rank === bestRank && d >= bestDist)) continue
      if (!this.usable(it)) continue
      best = it
      bestRank = rank
      bestDist = d
    }
    const away = this.awayCheck || this.goneCheck ? this.list.filter((it) => this.awayCheck?.(it.id) || this.goneCheck?.(it.id)).map((it) => it.id).join(',') : ''
    if (best !== this.currentTarget || away !== this.awayNow) {
      this.currentTarget = best
      this.awayNow = away
      this.refreshMarkers()
    }
    // Recomputed every frame: the wording follows quest progress even while
    // the hero stands still next to the target.
    const label = best ? read(best.label) : null
    const alt = label && best?.alt ? read(best.alt) : null
    const said = alt ? `${label}\u0000${alt.key}\u0000${alt.label}` : label
    if (said !== this.lastPrompt) {
      this.lastPrompt = said
      const verb = best?.verb !== undefined ? read(best.verb) : null
      const payload: PromptPayload = verb && label ? { label, verb } : { label }
      if (alt) payload.alt = alt
      bus.emit(EV.prompt, payload)
    }
    if (this.keyHint) {
      if (best) {
        const bob = this.deps.reducedMotion ? 0 : Math.round(Math.sin(now * 0.008) * 1)
        this.keyHint.setPosition(best.x, best.y - (best.markerOffset ?? DEFAULT_MARKER_OFFSET) + bob).setVisible(true)
      } else {
        this.keyHint.setVisible(false)
      }
    }
  }

  /** Use the current target (the action key). False when there is none. */
  activate(): boolean {
    const it = this.currentTarget
    if (!it || !this.usable(it)) return false
    this.use(it)
    return true
  }

  /** Use a point (the target, or one clicked); a used-up point goes. */
  use(it: Interactable): void {
    if (it.activate() === true) this.remove(it)
  }

  /** A usable point under the cursor, within the hero's reach of it (a click). */
  pointAt(at: { x: number; y: number }, hero: { x: number; y: number }): Interactable | null {
    return (
      this.list.find(
        (it) =>
          Math.hypot(at.x - it.x, at.y - (it.y - 8)) <= 14 &&
          distance(hero, it) <= (it.clickReach ?? DEFAULT_CLICK_REACH) &&
          this.usable(it)
      ) ?? null
    )
  }

  /** Can it be used now (its own check, and nobody who isn't here). */
  private usable(it: Interactable): boolean {
    return (!it.available || it.available()) && !this.goneCheck?.(it.id)
  }

  /** Hide the keycap hint while the world is frozen (a panel owns input). */
  hideKeyHint(): void {
    this.keyHint?.setVisible(false)
  }

  /** Force the next update to re-emit the prompt (a spend changed the wording). */
  invalidatePrompt(): void {
    this.lastPrompt = undefined
  }

  /** Drop a used-up point (a picked-up paper) and clear its prompt. */
  private remove(it: Interactable): void {
    this.drop(it)
    for (const [owner, points] of this.byOwner) if (points.includes(it)) this.byOwner.set(owner, points.filter((p) => p !== it))
    this.keyHint?.setVisible(false)
    this.lastPrompt = null
    const payload: PromptPayload = { label: null }
    bus.emit(EV.prompt, payload)
  }

  private drop(it: Interactable): void {
    const i = this.list.indexOf(it)
    if (i >= 0) this.list.splice(i, 1)
    const marker = this.markers.get(it)
    if (marker) {
      this.scene.tweens.killTweensOf(marker)
      marker.destroy()
      this.markers.delete(it)
    }
    if (this.currentTarget === it) this.currentTarget = null
  }

  private addMarker(it: Interactable): void {
    if (!it.marker || this.markers.has(it)) return
    const img = this.scene.add
      .image(it.x, it.y - (it.markerOffset ?? DEFAULT_MARKER_OFFSET), 'mark-quest')
      .setOrigin(0.5, 1)
      .setDepth(6000)
      .setVisible(false)
    if (!this.deps.reducedMotion) {
      this.scene.tweens.add({ targets: img, y: img.y - 2, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    this.markers.set(it, img)
  }
}
