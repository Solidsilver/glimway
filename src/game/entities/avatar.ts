/**
 * The imported hero's visual: a layered Habitica avatar that breathes when
 * still, steps when walking and faces the way it goes, the trailing pet
 * follower, and mount riding. The demo hero keeps its animated placeholder.
 * Fallbacks are labelled.
 *
 * Lifetime note: `riding` and the once-per-tab fallback/partial notices
 * deliberately outlive an area change (scene.restart reuses one world per
 * tab, and the pre-split scene kept these on its instance); the carried
 * store below reproduces that. The build token is per instance — scene
 * shutdown bumps it via invalidate().
 *
 * Composition: official Habitica layers are drawn on shared canvases —
 * walking layers on a 90px grid, mount layers on a larger 135px canvas with
 * the same art scale. Aligning every layer by CENTER with one uniform scale
 * reproduces the official stacking for the mixed-canvas case; anchoring by
 * the first layer's height would shrink the whole avatar whenever a mount
 * layer happened to come first.
 *
 * Motion (playtest 1: the old whole-body sine bob read as floating): every
 * walking layer is drawn as two crops of itself split across the chest, the
 * upper crop one art pixel taller than the split. Standing still, the upper
 * half lifts that one pixel on a slow in-breath (shoulders and head rise, the
 * feet stay planted; the extra row hides the seam). Walking, the whole body
 * lifts one pixel on every other step. Moving left or right mirrors it. With
 * reduced motion there is no breath. Seated (../seats), the lower crop ends
 * at the lap and the body sits on the seat, at the seat's depth.
 */
import type Phaser from 'phaser'
import { loadCompanion, loadWorldAvatar } from '../avatar-render'
import { bus, EV } from '../events'
import type { Session } from '../session'
import type { WorldData } from '../worlds'
import type { Hero } from './hero'
import { SEAT_CUT } from '../seats'
import { ART_PX, BREATH_SPLIT, avatarMotion } from '../hero-motion'

/** Habitica sprite grid (source px) and its on-screen height in the 16px world. */
const AVATAR_CANVAS = 90
const AVATAR_DISPLAY = 22

/** State carried across area changes and defeat recovery (per tab). */
const carried = { riding: false, fallbackNotified: false, partialNotified: false }

export interface AvatarDeps {
  session: Session
  world: WorldData
  hero: () => Hero
  reducedMotion: boolean
}

export class AvatarVisual {
  container: Phaser.GameObjects.Container | null = null
  pet: Phaser.GameObjects.Image | null = null
  riding = false
  /** Facing right (mirrored art); kept while moving straight up or down. */
  faceRight = false
  /** The walking layers' two crops (upper rises on a breath) and the mount's. */
  private uppers: Phaser.GameObjects.Image[] = []
  private lowers: Phaser.GameObjects.Image[] = []
  private mountLayers: Phaser.GameObjects.Image[] = []
  /** What the playtests read: the pose as last drawn. */
  pose = { breath: 0, step: 0, seated: false, mirrored: false }
  /** Stale-async guard: a token invalidates older rebuild completions. */
  private buildToken = 0
  private fallbackNotified = false
  private partialNotified = false

  constructor(private scene: Phaser.Scene, private deps: AvatarDeps) {
    this.riding = carried.riding
    this.fallbackNotified = carried.fallbackNotified
    this.partialNotified = carried.partialNotified
  }

  async build(): Promise<void> {
    const session = this.deps.session
    const hero = this.deps.hero()
    const profile = session.importedProfile
    if (!profile) return
    const token = ++this.buildToken
    const loaded = await loadWorldAvatar(this.scene, profile, this.riding)
    if (token !== this.buildToken) return // a newer rebuild superseded this one
    if (this.container) {
      this.container.destroy()
      this.container = null
    }
    this.clearPet()
    if (loaded.fallback) {
      // Restore the visible demo hero — a previous build may have hidden it.
      hero.sprite.setAlpha(1)
      if (!this.fallbackNotified) {
        this.fallbackNotified = true
        bus.emit(EV.toast, { text: 'Your Habitica look couldn\u2019t be fetched just now — Wren stands in for you.' })
      }
      return
    }
    if (loaded.unavailable.length > 0 || loaded.failedKeys.length > 0) {
      // Honest notice: pieces the bundled cache lacks come through the sprite
      // proxy; only ones that couldn't be had (no server, or none upstream)
      // or failed to load are left off, never invented or fetched cross-origin.
      if (!this.partialNotified) {
        this.partialNotified = true
        bus.emit(EV.toast, {
          text: 'A few pieces of your Habitica outfit couldn\u2019t be fetched just now, so they\u2019re left off.',
          kind: 'info'
        })
      }
    }
    const scale = AVATAR_DISPLAY / AVATAR_CANVAS
    // All layers share one center, half a display-height above the feet.
    const centerY = -AVATAR_DISPLAY / 2
    // Official composition (avatar.vue + sprites.css @789bbe4a): every layer
    // canvas stacks at a SHARED TOP-LEFT origin; mount canvases are shifted
    // +18 grid px DOWN (margin-top) with X unchanged (their extra width
    // extends right only). For this center-anchored stack that places a mount
    // layer's center at (+22.5, +40.5) grid px from the shared center — the
    // rider sits on the wolf's back instead of standing beside it.
    const isMountLayer = (key: string) => {
      const name = key.startsWith('fs-asset-') ? key.slice('fs-asset-'.length) : key
      return name.startsWith('Mount_Body_') || name.startsWith('Mount_Head_')
    }
    this.uppers = []
    this.lowers = []
    this.mountLayers = []
    const images: Phaser.GameObjects.Image[] = []
    for (const k of loaded.layerKeys) {
      if (isMountLayer(k)) {
        const img = this.scene.add.image(22.5 * scale, centerY + 40.5 * scale, k).setOrigin(0.5, 0.5).setScale(scale)
        this.mountLayers.push(img)
        images.push(img)
        continue
      }
      // Two crops of one layer, in stacking order (lower then upper), so the
      // next layer still draws over both.
      const lower = this.scene.add.image(0, centerY, k).setOrigin(0.5, 0.5).setScale(scale)
      const upper = this.scene.add.image(0, centerY, k).setOrigin(0.5, 0.5).setScale(scale)
      this.lowers.push(lower)
      this.uppers.push(upper)
      images.push(lower, upper)
    }
    this.cropLayers(null)
    this.pose = { ...this.pose, seated: false }
    this.container = this.scene.add.container(hero.sprite.x, hero.sprite.y, images)
    hero.sprite.setAlpha(0) // physics anchor invisible; the container is the body
    hero.shadow.setAlpha(0.25)
    void this.buildPetFollower(token)
  }

  /** Mount riding: outdoor toggle; the village is a no-ride zone. Riding is
   * only granted when BOTH mount layers (body + head) actually load — an
   * uncached mount never becomes an invisible speed boost. */
  async toggleRide(): Promise<void> {
    const { session, world } = this.deps
    const mountKey = (session.importedProfile as { selectedMount?: string | null } | null)?.selectedMount
    if (!mountKey) {
      bus.emit(EV.toast, { text: 'No mount chosen on Habitica — pick one there to ride here.' })
      return
    }
    if (this.riding) {
      this.riding = false
      void this.build()
      bus.emit(EV.toast, { text: 'You hop down.', kind: 'thought' })
      return
    }
    if (world.areaId === 'village') {
      bus.emit(EV.toast, { text: 'Orrin would never forgive hoofprints in the square. Ride outside the gate.' })
      return
    }
    const mountKeys = await loadCompanion(this.scene, mountKey, 'mount')
    if (!mountKeys || mountKeys.length < 2) {
      bus.emit(EV.toast, { text: 'Your mount stayed home this time (its art couldn\u2019t be fetched). On foot it is.' })
      return
    }
    this.riding = true
    void this.build()
    bus.emit(EV.toast, { text: 'You saddle up. Faster on the open road!', kind: 'thought' })
  }

  /** A sync committed a new profile: riding rules re-checked, layers rebuilt. */
  onProfileChanged(): void {
    this.riding = this.riding && this.deps.world.areaId !== 'village'
    void this.build()
  }

  update(time: number): void {
    const hero = this.deps.hero()
    const { world } = this.deps
    const seat = hero.seat
    if (this.container) {
      const scale = AVATAR_DISPLAY / AVATAR_CANVAS
      const centerY = -AVATAR_DISPLAY / 2
      const body = hero.sprite.body as Phaser.Physics.Arcade.Body | null
      const walking = !seat && !!body && body.enable && Math.hypot(body.velocity.x, body.velocity.y) > 1
      if (!seat && Math.abs(hero.facing.x) > 0.3) this.faceRight = hero.facing.x > 0
      const right = seat ? seat.facing === 'right' : this.faceRight
      const motion = avatarMotion(time, walking, this.deps.reducedMotion)
      if (this.pose.seated !== !!seat) {
        this.cropLayers(seat ? SEAT_CUT.habitica[seat.facing] : null)
        for (const m of this.mountLayers) m.setVisible(!seat)
      }
      for (const u of this.uppers) u.y = centerY + motion.breath * scale
      // The Habitica art leads with its left (weapon hand forward, hair
      // trailing right): mirrored, it faces right.
      this.container.scaleX = right ? -Math.abs(this.container.scaleX) : Math.abs(this.container.scaleX)
      if (seat) {
        // The lap's cut row lands on the seat's front edge.
        const cut = SEAT_CUT.habitica[seat.facing]
        this.container.setPosition(seat.x, seat.y - (centerY + (cut - AVATAR_CANVAS / 2) * scale))
        this.container.depth = seat.depth
      } else {
        this.container.setPosition(hero.sprite.x, hero.sprite.y - 1 + motion.step * scale)
        this.container.depth = hero.sprite.y + 1
      }
      this.pose = { ...motion, seated: !!seat, mirrored: right }
    }
    if (this.pet) {
      // The pet trails behind, on the side away from where you face.
      const behind = this.faceRight ? -1 : 1
      const targetX = hero.sprite.x + 14 * behind
      const t = 0.08
      this.pet.x += (targetX - this.pet.x) * t
      this.pet.y += (hero.sprite.y - 2 - this.pet.y) * t
      this.pet.setDepth(this.pet.y)
    }
    // Auto-dismount entering the village.
    if (this.riding && world.areaId === 'village') {
      this.riding = false
      void this.build()
      bus.emit(EV.toast, { text: 'You lead your mount through the gate on foot.', kind: 'thought' })
    }
  }

  /**
   * Crop each walking layer into its breath halves: the upper from the top
   * to one art pixel past the split, the lower from the split down to the
   * feet, or (seated) to the lap.
   */
  private cropLayers(lap: number | null): void {
    for (const u of this.uppers) u.setCrop(0, 0, u.frame.realWidth, BREATH_SPLIT + ART_PX)
    for (const l of this.lowers) l.setCrop(0, BREATH_SPLIT, l.frame.realWidth, (lap ?? l.frame.realHeight) - BREATH_SPLIT)
  }

  /** Scene shutdown: in-flight avatar/pet loads must never land in a dead scene. */
  invalidate(): void {
    this.buildToken++
    this.container = null
    this.pet = null
    carried.riding = this.riding
    carried.fallbackNotified = this.fallbackNotified
    carried.partialNotified = this.partialNotified
  }

  private clearPet(): void {
    if (this.pet) {
      this.pet.destroy()
      this.pet = null
    }
  }

  /** Selected pet trails the hero (never baked into the layer stack). A
   * petless sync leaves no duplicate or stale follower behind. */
  private async buildPetFollower(token: number): Promise<void> {
    const key = (this.deps.session.importedProfile as { selectedPet?: string | null } | null)?.selectedPet
    const keys = await loadCompanion(this.scene, key, 'pet')
    if (token !== this.buildToken) return
    if (!keys || keys.length === 0) return // unknown/empty keys: no invented visuals
    this.clearPet()
    this.pet = this.scene.add.image(this.deps.hero().sprite.x - 14, this.deps.hero().sprite.y - 2, keys[0])
      .setOrigin(0.5, 1)
      .setScale(AVATAR_DISPLAY / AVATAR_CANVAS) // companion grid matches the avatar grid
  }
}
