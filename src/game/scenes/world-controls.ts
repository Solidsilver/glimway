/**
 * The world's controls: movement keys, the action keys (E/Space, F to cast,
 * M to ride, Shift to roll) and their touch buttons on the bus, the belt
 * (number keys and the wheel pick what's in hand), and the mouse on the
 * world. Each acts only while the hero has control (`live`).
 */
import Phaser from 'phaser'
import { kindForKey, stepKind } from '../../lib/belt'
import { ui } from '../../ui/store.svelte'
import { bus, EV } from '../events'
import { held, heldNow, setHeld, trackBelt, type HeldPayload } from '../held'
import { touchVec } from '../input'
import { ITEM_ART_FALLBACK, itemIcon } from '../items-pass'
import type { Session } from '../session'
import { sfx } from '../sfx'
import type { AvatarVisual } from '../entities/avatar'
import type { Gathering } from '../entities/gathering'
import type { Hero } from '../entities/hero'
import type { Interactables } from '../entities/interactables'

export interface WorldControlsDeps {
  session: Session
  hero: () => Hero
  avatar: () => AvatarVisual
  interactables: Interactables
  gathering: () => Gathering | null
  reducedMotion: boolean
  /** The hero has control (no panel, move or beat holds the world). */
  live: () => boolean
  /** The action button: use what the prompt is on, or swing. */
  act: () => void
}

export class WorldControls {
  readonly cursors: Phaser.Types.Input.Keyboard.CursorKeys
  readonly keys: Record<string, Phaser.Input.Keyboard.Key>
  private readonly wasd: Record<string, Phaser.Input.Keyboard.Key>
  /** Where the current prompt's thing stands (null: no prompt); a click there does what E would. */
  private promptAt: { x: number; y: number } | null = null
  private wheelAcc = 0
  private wheelAt = 0
  private lastHeld = heldNow().kind

  constructor(
    private scene: Phaser.Scene,
    private deps: WorldControlsDeps
  ) {
    const kb = scene.input.keyboard!
    kb.addCapture('SPACE,UP,DOWN,LEFT,RIGHT,W,A,S,D,E,F,M,SHIFT')
    this.cursors = kb.createCursorKeys()
    this.wasd = kb.addKeys('W,A,S,D') as Record<string, Phaser.Input.Keyboard.Key>
    this.keys = kb.addKeys('E,SPACE,F,M,SHIFT') as Record<string, Phaser.Input.Keyboard.Key>
    // Event-driven, not polled: Key.onUp clears _justDown, so polling
    // JustDown once per frame silently drops taps shorter than a frame
    // (common on slower devices). DOWN fires once per press, never on repeat.
    const onAction = () => this.whenLive(() => deps.act())
    const onCast = () => this.whenLive(() => deps.hero().handleCast())
    const onRide = () => this.whenLive(() => void deps.avatar().toggleRide())
    const onDodge = () => this.whenLive(() => deps.hero().tryDodge(this.vector()))
    this.keys.E.on('down', onAction)
    this.keys.SPACE.on('down', onAction)
    this.keys.F.on('down', onCast)
    this.keys.M.on('down', onRide)
    this.keys.SHIFT.on('down', onDodge)
    // What's in hand (src/game/held.ts): number keys and the wheel pick from
    // the belt; the mouse uses it where you point.
    const stopBelt = trackBelt(deps.session)
    kb.on('keydown', this.onBeltKey, this)
    scene.input.on('wheel', this.onBeltWheel, this)
    scene.input.on('pointerdown', this.onPointer, this)
    scene.input.mouse?.disableContextMenu()
    // The touch buttons (the action button checks the world itself).
    const onBusAction = () => deps.act()
    bus.on(EV.held, this.onHeldChanged, this)
    bus.on(EV.action, onBusAction)
    bus.on(EV.cast, onCast)
    bus.on(EV.dodge, onDodge)
    scene.events.once('shutdown', () => {
      stopBelt()
      for (const key of Object.values(this.keys)) key.removeAllListeners('down')
      kb.off('keydown', this.onBeltKey, this)
      scene.input.off('wheel', this.onBeltWheel, this)
      scene.input.off('pointerdown', this.onPointer, this)
      bus.off(EV.held, this.onHeldChanged, this)
      bus.off(EV.action, onBusAction)
      bus.off(EV.cast, onCast)
      bus.off(EV.dodge, onDodge)
    })
  }

  /** Current movement input (keys + joystick), not normalized. */
  vector(): Phaser.Math.Vector2 {
    let dx = touchVec.x
    let dy = touchVec.y
    if (this.cursors.left.isDown || this.wasd.A.isDown) dx -= 1
    if (this.cursors.right.isDown || this.wasd.D.isDown) dx += 1
    if (this.cursors.up.isDown || this.wasd.W.isDown) dy -= 1
    if (this.cursors.down.isDown || this.wasd.S.isDown) dy += 1
    return new Phaser.Math.Vector2(dx, dy)
  }

  /** Follow the prompt's target (each live frame). */
  update(): void {
    const it = this.deps.interactables.currentTarget
    this.promptAt = it ? { x: it.x, y: it.y - 8 } : null
  }

  private whenLive(fn: () => void): void {
    if (this.deps.live()) fn()
  }

  /** Keys 1…9 take the belt's slot in hand (not while the emote picker, a panel or a talk has the keys). */
  private onBeltKey(e: KeyboardEvent): void {
    const m = /^Digit([1-9])$/.exec(e.code)
    // A digit the UI already used (an emote picked from the picker) isn't for the belt.
    if (!m || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e as KeyboardEvent & { fsConsumed?: boolean }).fsConsumed) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (ui.emoteOpen || !this.deps.live()) return
    const kind = kindForKey(held.belt, Number(m[1]))
    if (kind) setHeld(kind)
  }

  /** The wheel steps along the belt (one step per notch; a trackpad's flick counts once). */
  private onBeltWheel(_p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number): void {
    if (!this.deps.live() || held.belt.length < 2) return
    const now = performance.now()
    if (now - this.wheelAt > 300) this.wheelAcc = 0
    this.wheelAcc += dy
    if (Math.abs(this.wheelAcc) < 40 || now - this.wheelAt < 120) return
    this.wheelAt = now
    setHeld(stepKind(held.belt, heldNow().kind, this.wheelAcc > 0 ? 1 : -1))
    this.wheelAcc = 0
  }

  /**
   * The mouse on the world (desktop; touches go to the touch controls). Left:
   * what the prompt's thing would do when you click it, or the held tool on
   * the piece under the cursor, or talk to the person or sign there, or a
   * swing toward the cursor. Right: talk to or use what's under the cursor.
   */
  private onPointer(p: Phaser.Input.Pointer): void {
    const ev = p.event as PointerEvent | MouseEvent | TouchEvent
    if ('pointerType' in ev && ev.pointerType && ev.pointerType !== 'mouse') return
    if (typeof TouchEvent !== 'undefined' && ev instanceof TouchEvent) return
    if (!this.deps.live()) return
    const { interactables } = this.deps
    const at = { x: p.worldX, y: p.worldY }
    const hero = this.deps.hero()
    const onPrompt = !!this.promptAt && Math.hypot(at.x - this.promptAt.x, at.y - this.promptAt.y) <= 18
    // A person, sign or pickup under the cursor and within reach.
    const thing = interactables.pointAt(at, hero.sprite)
    if (p.button === 2) {
      if (onPrompt) this.deps.act()
      else if (thing) interactables.use(thing)
      return
    }
    if (p.button !== 0) return
    if (onPrompt) return this.deps.act()
    if (this.deps.gathering()?.workAt(at, hero.sprite)) return
    if (thing) return interactables.use(thing)
    if (this.deps.session.zeroHpLocked) return
    hero.tryAttack({ tool: heldNow().kind !== 'weapon', toward: at })
  }

  /** Something else in hand: the prompt follows at once, and the tool shows over the hero for a moment. */
  private onHeldChanged(p: HeldPayload): void {
    this.deps.interactables.invalidatePrompt()
    if (p.kind === this.lastHeld) return
    this.lastHeld = p.kind
    const scene = this.scene
    if (!scene.sys.isActive()) return
    sfx('click')
    const slot = p.belt.find((s) => s.kind === p.kind)
    if (!slot?.itemDef) return
    let key = itemIcon(slot.itemDef)
    if (!scene.textures.exists(key)) key = ITEM_ART_FALLBACK
    if (!scene.textures.exists(key)) return
    const hero = this.deps.hero().sprite
    const img = scene.add.image(hero.x, hero.y - 30, key).setOrigin(0.5, 1).setDepth(5000)
    if (img.height > 12) img.setScale(12 / img.height)
    scene.tweens.add({ targets: img, y: img.y - (this.deps.reducedMotion ? 0 : 6), alpha: 0, delay: 350, duration: 450, onComplete: () => img.destroy() })
  }
}
