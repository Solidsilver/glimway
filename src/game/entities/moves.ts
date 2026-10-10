/**
 * How the moves look (docs/design/crafts.md 4.3, 4.5, 9.1): Stand's ring of
 * pressed earth, Kindle's patch of hollow light, Ward-light's still circle
 * and its pulses, and Echo's faded copy — the hero's own, and a friend's
 * from the presence relay. Calm on purpose: slow loops, low to the ground,
 * no screen shake; reduced motion holds still frames.
 *
 * A friend's Ward-light is the one cast that changes this screen: its
 * pulses mend the local hero standing inside the circle, at the same
 * moments the friend's screen pulses (the hub credits the server the same
 * heal, 4.5). Everything else a friend casts is only drawn.
 *
 * Purely cosmetic otherwise: the rules live in src/lib/combat-moves.ts.
 */
import Phaser from 'phaser'
import { bus, EV, type AbilityCastPayload } from '../events'
import { abilityFor } from '../../lib/abilities'
import { friendPulseHeal, inCircle, kindleSpot, wardPulseTimes } from '../../lib/combat-moves'
import type { KitMove } from '../../lib/combat'
import { TILE } from '../../lib/tile'
import { crArt, hasCrArt } from '../crafts-art'
import { sfx } from '../sfx'
import type { Session } from '../session'
import type { Effects } from './fx'

export interface MoveFxDeps {
  session: Session
  fx: Effects
  reducedMotion: boolean
  /** The hero's feet (world px) and facing, now. */
  hero: () => { sprite: Phaser.GameObjects.Sprite; facing: { x: number; y: number } }
  /** The hero's visible body: the layered avatar container, when there is one. */
  body: () => Phaser.GameObjects.Container | null
}

type Fadeable = Phaser.GameObjects.GameObject & { alpha: number; setAlpha(value: number): unknown }

/** Each move's effect on screen is tagged with its move and spot, for playtests (`shown`). */
const tag = <T extends Phaser.GameObjects.GameObject>(o: T, move: string, x: number, y: number): T => o.setData('move', { move, x: Math.round(x), y: Math.round(y) })

/** Ground effects sit under anyone standing on them: below the lowest depth-by-y inside their footprint. */
const groundDepth = (y: number, halfH: number) => y - halfH - 2

/**
 * A heal lands on this screen's hero (a Mend, a Ward-light pulse): their HP
 * rises, to its max, and the rise floats up from them. Returns the rise.
 */
export function healHero(session: Session, fx: Effects, at: { x: number; y: number }, amount: number): number {
  const before = session.state.hp
  session.setVitals(before + amount, session.state.mana)
  const rise = session.state.hp - before
  if (rise >= 0.5) fx.floatText(at.x, at.y - 24, `+${Math.round(rise)}`, '#b9f0a0', false)
  return rise
}

export class MoveFx {
  private readonly onCast = (p: AbilityCastPayload) => this.remote(p)

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly deps: MoveFxDeps
  ) {
    bus.on(EV.abilityCast, this.onCast)
    scene.events.once('shutdown', () => bus.off(EV.abilityCast, this.onCast))
  }

  /** Stand: a ring of pressed earth at the feet, planting then held, for `seconds`. */
  stand(x: number, y: number, seconds: number): void {
    const until = seconds * 1000
    if (hasCrArt(this.scene, 'stand-ground-ring-0')) {
      const ring = this.scene.add.sprite(x, y, crArt(this.deps.reducedMotion ? 'stand-ground-ring-3' : 'stand-ground-ring-0')).setDepth(groundDepth(y, 8))
      if (!this.deps.reducedMotion && this.scene.anims.exists(crArt('stand-ring'))) ring.play(crArt('stand-ring'))
      this.fadeOut(tag(ring, 'stand', x, y), until)
    } else {
      const g = this.scene.add.graphics().setDepth(groundDepth(y, 8))
      g.lineStyle(2, 0x8a6a44, 0.85).strokeEllipse(x, y, 22, 10)
      this.fadeOut(tag(g, 'stand', x, y), until)
    }
  }

  /** Kindle: a patch of hollow light `r` px round at (x, y), looping low, for `seconds`. */
  kindle(x: number, y: number, r: number, seconds: number): void {
    const until = seconds * 1000
    if (hasCrArt(this.scene, 'kindle-hollow-light-0')) {
      const patch = this.scene.add.sprite(x, y, crArt('kindle-hollow-light-0')).setDepth(groundDepth(y, r))
      // The art is about 3 tiles across; the table's radius sets the size.
      patch.setScale((2 * r) / patch.width)
      if (!this.deps.reducedMotion && this.scene.anims.exists(crArt('kindle-patch'))) patch.play(crArt('kindle-patch'))
      this.fadeIn(tag(patch, 'kindle', x, y))
      this.fadeOut(patch, until)
    } else {
      const g = this.scene.add.graphics().setDepth(groundDepth(y, r))
      g.fillStyle(0xf3e3a0, 0.22).fillEllipse(x, y, r * 2, r * 1.3)
      g.lineStyle(1, 0xf7eec0, 0.6).strokeEllipse(x, y, r * 2, r * 1.3)
      this.fadeIn(tag(g, 'kindle', x, y))
      this.fadeOut(g, until)
    }
  }

  /**
   * Ward-light: a still circle `r` px round at (x, y) for `seconds`, and a
   * brighter ring at each pulse; `onPulse` runs at each pulse's moment.
   */
  ward(x: number, y: number, r: number, seconds: number, pulses: number, onPulse: () => void): void {
    const until = seconds * 1000
    const art = hasCrArt(this.scene, 'ward-light-circle-0')
    const base = art
      ? this.scene.add.sprite(x, y, crArt('ward-light-circle-0')).setDepth(groundDepth(y, r))
      : this.scene.add.graphics().setDepth(groundDepth(y, r))
    if (base instanceof Phaser.GameObjects.Sprite) base.setScale((2 * r) / base.width)
    else base.lineStyle(2, 0xcfe6a0, 0.8).strokeEllipse(x, y, r * 2, r * 1.2)
    this.fadeIn(tag(base, 'ward-light', x, y))
    this.fadeOut(base, until)
    for (const t of wardPulseTimes(seconds, pulses)) {
      this.scene.time.delayedCall(t * 1000, () => {
        if (!base.active) return
        onPulse()
        if (this.deps.reducedMotion) return
        if (art && this.scene.anims.exists(crArt('ward-pulse'))) {
          const pulse = this.scene.add.sprite(x, y, crArt('ward-light-circle-1')).setDepth(groundDepth(y, r) + 0.5)
          pulse.setScale((2 * r) / pulse.width).play(crArt('ward-pulse'))
          pulse.once('animationcomplete', () => pulse.destroy())
        } else {
          const ring = this.scene.add.graphics().setDepth(groundDepth(y, r) + 0.5)
          ring.lineStyle(1.5, 0xeaf7c0, 0.9).strokeEllipse(x, y, r * 1.2, r * 0.7)
          this.scene.tweens.add({ targets: ring, scale: { from: 0.9, to: 1.15 }, alpha: 0, duration: 380, onComplete: () => ring.destroy() })
        }
      })
    }
  }

  /**
   * Echo: a faded copy of the hero, made in code from the hero's own layers
   * (the avatar container's images, tinted and half transparent), standing
   * where they were for `seconds`. A friend's Echo copies the plain walk
   * figure, since their layers are theirs to draw.
   */
  echo(x: number, y: number, seconds: number, from: Phaser.GameObjects.Container | Phaser.GameObjects.Sprite | null): void {
    const copy = this.scene.add.container(x, y).setDepth(y - 0.5)
    if (from instanceof Phaser.GameObjects.Container) {
      copy.setPosition(from.x, from.y).setScale(from.scaleX, from.scaleY)
      for (const child of from.list) {
        if (!(child instanceof Phaser.GameObjects.Image) && !(child instanceof Phaser.GameObjects.Sprite)) continue
        if (!child.visible) continue
        const layer = this.scene.add.image(child.x, child.y, child.texture.key, child.frame.name)
          .setOrigin(child.originX, child.originY)
          .setScale(child.scaleX, child.scaleY)
          .setFlip(child.flipX, child.flipY)
        copy.add(layer)
      }
    } else if (from) {
      const layer = this.scene.add.image(0, 0, from.texture.key, from.frame.name).setOrigin(from.originX, from.originY).setScale(from.scaleX, from.scaleY).setFlipX(from.flipX)
      copy.add(layer)
    } else if (this.scene.textures.get('fingersnap-demo-walk').has('walk-down-0')) {
      const layer = this.scene.add.image(0, 0, 'fingersnap-demo-walk', 'walk-down-0').setOrigin(0.5, 1)
      layer.setScale(20 / layer.height)
      copy.add(layer)
    }
    for (const layer of copy.list as Phaser.GameObjects.Image[]) layer.setTint(0xa9c4ff)
    copy.setAlpha(0.5)
    tag(copy, 'echo', x, y)
    this.fadeOut(copy, seconds * 1000)
  }

  /** A move this hero cast: drawn here (the rules are the hero's). */
  local(m: KitMove, at: { x: number; y: number }, onPulse?: () => void): void {
    const x = m.numbers
    switch (m.id) {
      case 'stand':
        return this.stand(at.x, at.y, x.durationSeconds)
      case 'kindle':
        return this.kindle(at.x, at.y, x.radiusTiles * TILE, x.durationSeconds)
      case 'ward-light':
        return this.ward(at.x, at.y, x.radiusTiles * TILE, x.durationSeconds, x.pulses, onPulse ?? (() => {}))
      case 'echo':
        return this.echo(at.x, at.y, x.durationSeconds, this.deps.body() ?? this.deps.hero().sprite)
    }
  }

  /** Someone else in the room cast (EV.abilityCast): draw it at their feet. */
  remote(p: AbilityCastPayload): void {
    if (!this.scene.sys.isActive()) return
    const a = abilityFor(p.ability)
    if (!a) return
    const n = a.numbers
    switch (a.id) {
      case 'stand':
        return this.stand(p.x, p.y, n?.durationSeconds ?? 1.5)
      case 'kindle': {
        // Their facing isn't sent: the relay names where the patch is (the caster sends its spot).
        return this.kindle(p.x, p.y, (n?.radiusTiles ?? 1.5) * TILE, n?.durationSeconds ?? 6)
      }
      case 'echo':
        return this.echo(p.x, p.y, n?.durationSeconds ?? 3, null)
      case 'ward-light': {
        const r = (n?.radiusTiles ?? 1.25) * TILE
        // The hub's own number for this caster's pulse; a cast without one mends the base share.
        const heal = friendPulseHeal(p.pulseHeal, n?.pulseHealFraction ?? 0)
        return this.ward(p.x, p.y, r, n?.durationSeconds ?? 5, n?.pulses ?? 3, () => this.mendHere(p.x, p.y, r, heal))
      }
      // A friend's signature: the same small effect yours makes, at their side.
      case 'fingersnap':
        return this.deps.fx.sparkBurst(p.x, p.y - 8, 5)
      case 'cleave':
        if (!this.deps.fx.playEffect('effect-cleave', 'cleave-0', p.x, p.y - 8, p.y + 2)) this.deps.fx.sparkBurst(p.x, p.y - 8, 5)
        return
      case 'shadowstep':
        if (!this.deps.fx.playEffect('effect-dash-trail', 'dash-trail-0', p.x, p.y - 6, p.y + 2)) this.deps.fx.sparkBurst(p.x, p.y - 6, 4)
        return
      case 'mend':
        if (!this.deps.fx.playEffect('effect-healing-pulse', 'healing-pulse-0', p.x, p.y - 8, p.y + 2)) this.deps.fx.sparkBurst(p.x, p.y - 8, 5)
        return
    }
  }

  /** A pulse at (cx, cy): the local hero inside it, and not resting at 0 HP, is mended. */
  mendHere(cx: number, cy: number, r: number, heal: number): boolean {
    const s = this.deps.session
    const hero = this.deps.hero().sprite
    if (heal <= 0 || s.state.hp <= 0 || !inCircle(hero.x, hero.y, cx, cy, r)) return false
    healHero(s, this.deps.fx, hero, heal)
    sfx('calm')
    return true
  }

  /** Read-only, for playtests: the moves on screen now (anyone's), and where. */
  shown(): { move: string; x: number; y: number }[] {
    // `data` is read, not getData(): that would give every object on the screen a data store.
    return this.scene.children.list.filter((o) => o.active && o.data?.get('move')).map((o) => o.data.get('move') as { move: string; x: number; y: number })
  }

  /** Where Kindle's patch lands for the hero now (the presence event names this spot). */
  kindleAt(m: KitMove): { x: number; y: number } {
    const h = this.deps.hero()
    return kindleSpot(h.sprite.x, h.sprite.y, h.facing, m.numbers.reachTiles)
  }

  private fadeIn(o: Fadeable): void {
    if (this.deps.reducedMotion) return
    const to = o.alpha
    o.setAlpha(0)
    this.scene.tweens.add({ targets: o, alpha: to, duration: 220 })
  }

  private fadeOut(o: Fadeable, afterMs: number): void {
    const fade = this.deps.reducedMotion ? 0 : 300
    this.scene.time.delayedCall(Math.max(0, afterMs - fade), () => {
      if (!o.active) return
      if (!fade) return o.destroy()
      this.scene.tweens.add({ targets: o, alpha: 0, duration: fade, onComplete: () => o.destroy() })
    })
  }
}
