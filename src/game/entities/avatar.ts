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
import { heldNow } from '../held'
import { ITEM_ART_FALLBACK, itemIcon } from '../items-pass'
import { PEOPLE_KEY, facingOf, heldFrame, heldOrigin, peopleDensity, type Facing } from '../people'
import { PetFollower } from './pet-follower'
import { LedMount } from './led-mount'
import { followerKey } from '../../lib/companions'
import { hideContextButton, showContextButton } from '../context-buttons'
import { homesteadsFor } from '../homestead'
import { HOMESTEAD_DATA } from '../../lib/homestead'

/** Habitica sprite grid (source px) and its on-screen height in the 16px world. */
const AVATAR_CANVAS = 90
const AVATAR_DISPLAY = 22
/**
 * The Habitica figure's fists, on the skin layer: the weapon hand (the
 * figure's right, art-left) canvas px 42–44 across, the off hand (art-right)
 * 69–71, both rows 66–68. Every pose and facing is this one figure, mirrored
 * facing right. The fists sit below the breath's upper crop (BREATH_SPLIT
 * plus one art px), so what they hold stays put while the chest rises.
 */
const HAND_ART = { x: 43.5, y: 67.5 }
const OFF_HAND_ART = { x: 70.5, y: 67.5 }
/** Container px of a point on the Habitica canvas (unmirrored). */
const onFigure = (p: { x: number; y: number }) => ({
  x: (p.x - AVATAR_CANVAS / 2) * (AVATAR_DISPLAY / AVATAR_CANVAS),
  y: -AVATAR_DISPLAY / 2 + (p.y - AVATAR_CANVAS / 2) * (AVATAR_DISPLAY / AVATAR_CANVAS),
})
/** Where a held tool is gripped (container px, unmirrored), and an item icon's size there. */
const HAND = { ...onFigure(HAND_ART), size: 11 }
const OFF_HAND = onFigure(OFF_HAND_ART)

/**
 * State carried across area changes and defeat recovery (per tab): whether
 * the mount that's out is ridden or on the lead (crafts.md 3.1; the server
 * keeps only which one is out).
 */
const carried = { riding: false, fallbackNotified: false, partialNotified: false }

/** Saddle up was pressed for this mount: once it shows as out, you're on it (not on the lead). */
let saddleWanted = ''

/** The stable's Saddle up (./homestead-stable.ts): the next time this mount comes out, ride it. */
export function wantSaddle(mount: string): void {
  saddleWanted = mount
}

/** The lines riding says (crafts.md 3.1). */
export const RIDE_WORDS = {
  noStable: 'Your mount needs somewhere to stand at home first. A stable, maybe.',
  inStall: 'Your mount is in its stall at home. Saddle up there.',
  noMounts: 'No mount to ride yet. Raise one on Habitica, sync, and stall it in your stable.',
  village: 'Orrin would never forgive hoofprints in the square. Lead it through on foot.',
  gate: 'You lead your mount through the gate on foot.',
  indoors: 'Your mount waits outside the door.',
  up: 'You swing up into the saddle.',
  down: 'You hop down and take the lead.',
  noArt: 'Your mount’s art couldn’t be fetched just now. On foot it is, with it on the lead.',
  home: 'Off it goes, home to its stall.'
} as const

export interface AvatarDeps {
  session: Session
  world: WorldData
  hero: () => Hero
  reducedMotion: boolean
  /** The world is playing (no panel, talk or cinematic holds it): keys act. */
  live?: () => boolean
}

export class AvatarVisual {
  container: Phaser.GameObjects.Container | null = null
  /** The pet that walks with you (./pet-follower.ts). */
  follower: PetFollower | null = null
  /** The follower drawn now ('' none), so a new choice rebuilds it. */
  private followerShown = ''
  /** The mount that's out on the lead (./led-mount.ts), drawn while not ridden. */
  led: LedMount | null = null
  /** The mount key on the lead or under you ('' none): `companions.mountOut`. */
  private mountShown = ''
  riding = false
  /** Facing right (mirrored art); kept while moving straight up or down. */
  faceRight = false
  /** The walking layers' two crops (upper rises on a breath) and the mount's. */
  private uppers: Phaser.GameObjects.Image[] = []
  private lowers: Phaser.GameObjects.Image[] = []
  private mountLayers: Phaser.GameObjects.Image[] = []
  /**
   * The weapon's layers (both crops): put away while a tool is in hand, and
   * the tool drawn at the weapon hand instead (src/game/held.ts). The demo
   * stand-in has its blade drawn into the frames; it waits for the art pass
   * (docs/art-request-playtest1.md, hand items).
   */
  private weaponLayers: Phaser.GameObjects.Image[] = []
  private handTool: Phaser.GameObjects.Image | null = null
  /** The held item drawn now ('' = none built yet). */
  private handShown = ''
  /** The facing the held art was last set for. */
  private handFacing: string | null = null
  /** The way the hero faces, as last drawn. */
  private facing: Facing = 'down'
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
    // Never ridden indoors, nor in the village: the mount waits at the door, or comes on the lead.
    if (this.indoors || deps.world.areaId === 'village') this.riding = false
    this.mountShown = this.mountOut
    if (!this.mountShown) this.riding = false
    const onCompanions = () => this.onCompanions()
    bus.on(EV.companions, onCompanions)
    // H sends the mount home while you're off it (crafts.md 8); M is the scene's (./world-controls.ts).
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyH' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (this.deps.live && !this.deps.live()) return
      this.sendHome()
    }
    scene.input.keyboard?.on('keydown', onKey)
    scene.events.once('shutdown', () => {
      bus.off(EV.companions, onCompanions)
      scene.input.keyboard?.off('keydown', onKey)
      hideContextButton('saddle')
      hideContextButton('go-home')
    })
    this.showButtons()
  }

  /** Inside a room or a cottage: the mount waits on the doorstep. */
  private get indoors(): boolean {
    return this.deps.world.areaId.startsWith('in:')
  }

  /** The mount that's out, as the game shows it ('' none). */
  get mountOut(): string {
    return this.deps.session.link?.companions.mountOut ?? ''
  }

  /** The pet that walks with you: the chosen one, or Habitica's current pet. */
  private get followKey(): string {
    const profile = this.deps.session.importedProfile
    return followerKey(profile, this.deps.session.link?.companions) ?? ''
  }

  /** Read-only, for playtests and the dev hooks: the follower image. */
  get pet(): Phaser.GameObjects.Image | null {
    return this.follower?.image ?? null
  }

  async build(): Promise<void> {
    const session = this.deps.session
    const hero = this.deps.hero()
    const profile = session.importedProfile
    if (!profile) return
    const token = ++this.buildToken
    // Ridden, the mount that's out is drawn under you (never Habitica's current mount).
    const loaded = await loadWorldAvatar(this.scene, { ...profile, selectedMount: this.riding ? this.mountOut : null }, this.riding && !!this.mountOut)
    if (token !== this.buildToken) return // a newer rebuild superseded this one
    if (this.container) {
      this.container.destroy()
      this.container = null
    }
    if (loaded.fallback) {
      this.clearPet()
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
    this.weaponLayers = []
    this.handTool = null
    this.handShown = ''
    const isWeaponLayer = (key: string) => (key.startsWith('fs-asset-') ? key.slice('fs-asset-'.length) : key).startsWith('weapon_')
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
      if (isWeaponLayer(k)) this.weaponLayers.push(lower, upper)
      images.push(lower, upper)
    }
    this.cropLayers(null)
    this.pose = { ...this.pose, seated: false }
    this.container = this.scene.add.container(hero.sprite.x, hero.sprite.y, images)
    hero.sprite.setAlpha(0) // physics anchor invisible; the container is the body
    hero.shadow.setAlpha(0.25)
    // The follower outlives a rebuild (getting on or off a mount): only a new choice replaces it.
    if (!this.follower || this.followKey !== this.followerShown) void this.buildPetFollower(token)
  }

  /**
   * M (crafts.md 3.1): ridden ↔ on the lead, for the mount that's out of the
   * stable. With none out, it says where riding starts now. Riding needs
   * both mount layers to load: an uncached mount never becomes an invisible
   * speed boost (it stays on the lead).
   */
  async toggleRide(): Promise<void> {
    const mountKey = this.mountOut
    if (!mountKey) {
      const mine = this.deps.session.link ? homesteadsFor(this.deps.session).mine : null
      const stable = mine?.items.some((i) => i.itemDef === HOMESTEAD_DATA.stable.item && i.scene === 'outdoor')
      const mounts = this.deps.session.importedProfile?.mounts.length ?? 0
      bus.emit(EV.toast, { text: !stable ? RIDE_WORDS.noStable : mounts === 0 ? RIDE_WORDS.noMounts : RIDE_WORDS.inStall })
      return
    }
    if (this.riding) {
      this.riding = false
      this.dismountAt = { x: this.deps.hero().sprite.x, y: this.deps.hero().sprite.y }
      void this.build()
      bus.emit(EV.toast, { text: RIDE_WORDS.down, kind: 'thought' })
      this.showButtons()
      return
    }
    if (this.indoors) {
      bus.emit(EV.toast, { text: RIDE_WORDS.indoors })
      return
    }
    if (this.deps.world.areaId === 'village') {
      bus.emit(EV.toast, { text: RIDE_WORDS.village })
      return
    }
    await this.mountUp(mountKey)
  }

  /** Into the saddle on `mountKey` (Saddle up at the stall, or M on the lead). */
  async mountUp(mountKey: string): Promise<boolean> {
    const mountKeys = await loadCompanion(this.scene, mountKey, 'mount')
    if (!mountKeys || mountKeys.length < 2) {
      bus.emit(EV.toast, { text: RIDE_WORDS.noArt })
      return false
    }
    this.riding = true
    this.mountShown = mountKey
    void this.build()
    bus.emit(EV.toast, { text: RIDE_WORDS.up, kind: 'thought' })
    this.showButtons()
    return true
  }

  /**
   * Go home (H, or the button) while you're off it: the mount walks off the
   * edge of the screen (drawing only) and is back in its stall; the server
   * hears it at once (`mount-home`, which queues offline).
   */
  sendHome(): void {
    if (!this.mountOut || this.riding || this.indoors) return
    this.led?.walkOff()
    this.led = null
    this.deps.session.link?.mountHome()
    bus.emit(EV.toast, { text: RIDE_WORDS.home, kind: 'thought' })
  }

  /** The server (or a prediction) changed the companions: a new follower, a mount out or home. */
  private onCompanions(): void {
    if (this.followKey !== this.followerShown && this.container) void this.buildPetFollower(this.buildToken)
    const out = this.mountOut
    if (out !== this.mountShown) {
      const wasRiding = this.riding
      this.mountShown = out
      if (!out) this.riding = false
      if (out && out === saddleWanted && !this.indoors) {
        saddleWanted = ''
        void this.mountUp(out)
        return
      }
      if (wasRiding !== this.riding || wasRiding) void this.build()
      this.showButtons()
    }
  }

  /** The saddle and Go home buttons (lane F's row), while a mount is out and you're outdoors. */
  private showButtons(): void {
    const out = !!this.mountOut && !this.indoors
    if (!out) {
      hideContextButton('saddle')
      hideContextButton('go-home')
      bus.emit(EV.mount, this.mountOut ? { key: this.mountOut, riding: false, led: false } : null)
      return
    }
    showContextButton({
      id: 'saddle',
      label: this.riding ? 'Get down' : 'Ride',
      art: 'hud-saddle',
      icon: 'star',
      key: 'M',
      order: 1,
      ariaLabel: this.riding ? 'Get down from your mount' : 'Ride your mount',
      press: () => void this.toggleRide()
    })
    if (this.riding) hideContextButton('go-home')
    else
      showContextButton({ id: 'go-home', label: 'Go home', art: 'hud-go-home', icon: 'home', key: 'H', order: 2, ariaLabel: 'Send your mount home', press: () => this.sendHome() })
    bus.emit(EV.mount, { key: this.mountOut, riding: this.riding, led: !this.riding })
  }

  /** Where you got down: the mount stands there, on the lead. */
  private dismountAt: { x: number; y: number } | null = null

  /** A sync committed a new profile: riding rules re-checked, layers rebuilt. */
  onProfileChanged(): void {
    this.riding = this.riding && this.deps.world.areaId !== 'village' && !!this.mountOut
    void this.build()
    this.showButtons()
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
      this.facing = facingOf(hero.facing.x, hero.facing.y, right ? 'right' : 'left')
      this.drawHand(!!seat, this.facing)
    }
    const dt = this.lastTime === null ? 16 : Math.min(100, Math.max(0, time - this.lastTime))
    this.lastTime = time
    const body = hero.sprite.body as Phaser.Physics.Arcade.Body | null
    const walking = !seat && !!body && body.enable && Math.hypot(body.velocity.x, body.velocity.y) > 1
    const cam = this.scene.cameras.main
    if (this.follower) {
      this.follower.update({
        x: hero.sprite.x,
        y: hero.sprite.y,
        walking,
        faceRight: this.faceRight,
        seat: seat ? { x: seat.x, y: seat.y, facing: seat.facing } : null,
        viewMidX: cam.worldView.centerX,
        time,
        dt
      })
    }
    // The mount that's out, on the lead: drawn while you're off it and outdoors.
    const wantLed = !!this.mountOut && !this.riding && !this.indoors && !!this.container
    if (wantLed && (!this.led || this.led.key !== this.mountOut)) this.makeLed()
    else if (!wantLed && this.led) {
      this.led.destroy()
      this.led = null
    }
    if (this.led && this.container) {
      const hand = this.handPoint()
      this.led.update({ x: hero.sprite.x, y: hero.sprite.y, hand, faceRight: this.faceRight, seated: !!seat, dt, time })
    }
    // Auto-dismount entering the village: you lead it through the gate.
    if (this.riding && world.areaId === 'village') {
      this.riding = false
      void this.build()
      bus.emit(EV.toast, { text: RIDE_WORDS.gate, kind: 'thought' })
      this.showButtons()
    }
  }

  private lastTime: number | null = null

  /** The weapon hand, in world px (where the lead rope starts). */
  private handPoint(): { x: number; y: number } {
    const c = this.container!
    const mirrored = c.scaleX < 0
    return { x: c.x + (mirrored ? -HAND.x : HAND.x), y: c.y + HAND.y }
  }

  /** Put the led mount down: where you got off it, or beside you (coming out of a door, a new area). */
  private makeLed(): void {
    this.led?.destroy()
    const hero = this.deps.hero()
    const at = this.dismountAt ?? { x: hero.sprite.x + (this.faceRight ? -26 : 26), y: hero.sprite.y }
    this.dismountAt = null
    this.led = new LedMount(this.scene, this.mountOut, at, this.deps.reducedMotion)
  }

  /**
   * What's in hand, on the hero: the Habitica weapon while the weapon is
   * held; otherwise the tool's held art (../people.ts) facing with the hero,
   * gripped at the weapon hand — behind the body walking away — or its item
   * icon when it has no held art. Tucked away seated. Every held frame is
   * baked leaning out from the hand, art-left (HELD_LEAN in
   * ../atlas-plan.ts), so the container's mirroring alone turns it round:
   * the blade is always out, in the right hand, whichever way the hero faces.
   */
  private drawHand(seated: boolean, facing: Facing): void {
    const slot = heldNow()
    const want = slot.kind === 'weapon' || !slot.itemDef ? '' : slot.itemDef
    if (want !== this.handShown) {
      this.handShown = want
      for (const w of this.weaponLayers) w.setVisible(!want)
      this.handTool?.destroy()
      this.handTool = null
      this.handFacing = null
      if (want && this.container) {
        const k = peopleDensity(this.scene)
        if (k && heldFrame(this.scene, want, facing)) {
          const img = this.scene.add.image(HAND.x, HAND.y, PEOPLE_KEY, heldFrame(this.scene, want, facing)!).setScale(1 / k)
          this.container.add(img)
          this.handTool = img
        } else {
          let key = itemIcon(want)
          if (!this.scene.textures.exists(key)) key = ITEM_ART_FALLBACK
          if (this.scene.textures.exists(key)) {
            // Item icons point their head up and right; the unmirrored figure faces
            // left with the weapon hand on the left, so flip the icon to point out
            // ahead of the hero (the container's own mirroring turns it round).
            const img = this.scene.add.image(HAND.x, HAND.y, key).setOrigin(0.5, 0.85).setFlipX(true)
            img.setScale(HAND.size / Math.max(img.width, img.height))
            this.container.add(img)
            this.handTool = img
          }
        }
      }
    }
    const tool = this.handTool
    if (!tool) return
    if (tool.texture.key === PEOPLE_KEY && this.handFacing !== facing) {
      this.handFacing = facing
      const frame = heldFrame(this.scene, want, facing)
      if (frame) {
        tool.setFrame(frame)
        const [ox, oy] = heldOrigin(this.scene, frame)
        tool.setOrigin(ox, oy)
        // Walking away, the tool is held out in front: from here, behind the body.
        if (facing === 'up') this.container?.sendToBack(tool)
        else this.container?.bringToTop(tool)
      }
    }
    tool.setVisible(!seated)
  }

  /**
   * The off hand in the world (../entities/off-hand.ts draws what it holds
   * there): its grip, which side of the figure it's on (`right`: the hand
   * is on the hero's screen-right), the way the hero faces, and the body's
   * depth. Null without the Habitica figure.
   */
  offHand(): { x: number; y: number; right: boolean; facing: Facing; depth: number } | null {
    const c = this.container
    if (!c) return null
    const mirrored = c.scaleX < 0
    return { x: c.x + (mirrored ? -OFF_HAND.x : OFF_HAND.x), y: c.y + OFF_HAND.y, right: !mirrored, facing: this.facing, depth: c.depth }
  }

  /** Read-only, for playtests: which held frame is drawn ('' none or an icon). */
  get holdingFrame(): string {
    return this.handTool?.visible && this.handTool.texture.key === PEOPLE_KEY ? String(this.handTool.frame.name) : ''
  }

  /** Read-only, for playtests: what the hero is drawn holding ('' = the weapon). */
  get holding(): string {
    return this.handTool?.visible ? this.handShown : ''
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
    this.follower = null
    this.followerShown = ''
    this.led = null
    carried.riding = this.riding
    carried.fallbackNotified = this.fallbackNotified
    carried.partialNotified = this.partialNotified
  }

  private clearPet(): void {
    this.follower?.destroy()
    this.follower = null
    this.followerShown = ''
  }

  /**
   * The pet that walks with you trails the hero (never baked into the layer
   * stack): the chosen follower, or Habitica's current pet (crafts.md 2.2).
   * No pet is no pet: nothing is invented.
   */
  private async buildPetFollower(token: number): Promise<void> {
    const key = this.followKey
    this.followerShown = key
    const keys = await loadCompanion(this.scene, key, 'pet')
    if (token !== this.buildToken || key !== this.followerShown) return
    const was = this.follower ? { x: this.follower.x, y: this.follower.y } : null
    this.follower?.destroy()
    this.follower = null
    if (!keys || keys.length === 0) return // unknown/empty keys: no invented visuals
    const hero = this.deps.hero()
    this.follower = new PetFollower(this.scene, keys[0], was ? { x: was.x + 14, y: was.y + 2 } : { x: hero.sprite.x, y: hero.sprite.y }, this.deps.reducedMotion)
  }
}
