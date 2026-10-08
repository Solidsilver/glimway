/**
 * The hero: player sprite build, movement and facing, the dodge roll,
 * attacks and class kits (melee slash, mage bolt, cleave/dash/heal
 * signatures), i-frame damage and knockback. The imported layered avatar and
 * its mount/pet are owned by AvatarVisual; the hero renders through
 * `deps.avatar()` (the container is the visible body when present).
 *
 * Lifetime note: attack/cast/dodge cooldowns, the shadowstep dash window,
 * i-frames and facing deliberately outlive an area change (scene.restart
 * builds a new Hero). The carried store below keeps them; the scene writes
 * it back on shutdown.
 */
import Phaser from 'phaser'
import { getCombatKit, type CombatKit } from '../../lib/combat'
import { withCharm } from '../../lib/embers'
import { passiveRegenAllowed } from '../../lib/habitica/sync'
import { bus, EV, type AbilityPayload } from '../events'
import { uiBlocked, uiState } from '../input'
import { sfx } from '../sfx'
import { tileAt, tileMid } from '../../lib/tile'
import type { Session } from '../session'
import type { WorldData } from '../worlds'
import { KNOCK } from './enemies'
import type { EnemySystem } from './enemies'
import type { Projectiles } from './projectiles'
import type { AvatarVisual } from './avatar'
import type { Effects } from './fx'
import { SEAT_CUT, type SeatPose } from '../seats'

const PLAYER_SPEED = 110
const ATTACK_RANGE = 26
/** A tool swung at a creature does this share of the weapon's damage. */
const TOOL_DAMAGE = 0.5
const CONTACT_IFRAMES = 1.1

/** Dodge roll: a short burst with invulnerability, on its own cooldown. */
const DODGE = { speed: 240, time: 0.2, iframes: 0.32, cooldown: 0.75 }

/** Extra mana a second while seated (a bench in the square, a lit lantern's rest). */
export const SEATED_MANA_BONUS = 5

/** State carried across area changes and defeat recovery (per tab). */
const carried = { attackCooldown: 0, castCooldown: 0, dashTime: 0, iframes: 0, facingX: 0, facingY: 1 }

export interface HeroDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  enemies: () => EnemySystem
  projectiles: () => Projectiles
  avatar: () => AvatarVisual
  /** Lit-lantern rest rate (see WorldScene.lanternRestRate). */
  restRate: () => number
  transitioning: () => boolean
  cinematic: () => boolean
  /** Defeat beat: collapse, fade, wake at the village well. */
  onDefeat: () => void
}

export class Hero {
  /** The physics-visible hero sprite (the avatar container renders on top). */
  sprite!: Phaser.Physics.Arcade.Sprite
  /** Soft ellipse under the hero's feet. */
  shadow!: Phaser.GameObjects.Image
  readonly facing = new Phaser.Math.Vector2(0, 1)
  attackCooldown = 0
  castCooldown = 0
  /** Remaining shadowstep-dash window (seconds) — movement defers to it. */
  dashTime = 0
  iframes = 0
  dodgeCooldown = 0
  /** The seat while seated (src/game/seats.ts), and where they stood before. */
  seat: (SeatPose & { fromX: number; fromY: number }) | null = null

  /** Seated (the visible body is the seated pose; see sit). */
  get isSeated(): boolean {
    return this.seat !== null
  }

  /** Gathering / working (chops, digs, breaks; tucks off-hand). */
  isGathering = false

  /** Mana a second added while seated (the scene's playtests read this). */
  get seatedBonus(): number {
    return this.seat ? SEATED_MANA_BONUS : 0
  }

  constructor(private scene: Phaser.Scene, private deps: HeroDeps, entry: { tx: number; ty: number } | null) {
    this.attackCooldown = carried.attackCooldown
    this.castCooldown = carried.castCooldown
    this.dashTime = carried.dashTime
    this.iframes = carried.iframes
    this.facing.set(carried.facingX, carried.facingY)
    this.dodgeCooldown = 0 // create() reset this every restart
    this.build(deps.session.state, entry)
  }

  /** Scene shutdown: carry combat timing and facing across the restart. */
  carry(): void {
    carried.attackCooldown = this.attackCooldown
    carried.castCooldown = this.castCooldown
    carried.dashTime = this.dashTime
    carried.iframes = this.iframes
    carried.facingX = this.facing.x
    carried.facingY = this.facing.y
  }

  /** Per-frame cooldown/i-frame decay (ticked even while the world is frozen). */
  tick(dt: number): void {
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)
    this.castCooldown = Math.max(0, this.castCooldown - dt)
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt)
    this.iframes = Math.max(0, this.iframes - dt)
  }

  /** A panel/cinematic owns the screen: hold still, drop the walk pose. */
  halt(): void {
    this.sprite.setVelocity(0, 0)
    this.sprite.anims.stop()
  }

  /**
   * Sit down on a seat (a bench, a placed stool or chair): on the seat, not
   * in front of it, facing the way the seat does, drawn just in front of the
   * seat (its backrest behind you). The body is cut at the lap and the cut
   * laid on the seat's front edge; never squashed. The physics body rests
   * while seated (you sit inside the seat's footprint). Mana returns a little
   * faster while seated (see move). Any movement input stands the hero back up.
   */
  sit(pose: SeatPose): void {
    if (this.seat) return
    this.seat = { ...pose, fromX: this.sprite.x, fromY: this.sprite.y }
    this.sprite.setVelocity(0, 0)
    ;(this.sprite.body as Phaser.Physics.Arcade.Body).enable = false
    this.sprite.anims.stop()
    this.facing.set(pose.facing === 'left' ? -1 : pose.facing === 'right' ? 1 : 0, pose.facing === 'down' ? 1 : 0)
    const frame = `walk-${pose.facing}-0`
    if (this.scene.textures.get('fingersnap-demo-walk').has(frame)) {
      this.sprite.setTexture('fingersnap-demo-walk', frame)
      // Crop rows are the untrimmed frame's; the sprite's origin is its foot row.
      const f = this.sprite.frame
      const cut = SEAT_CUT.demo[pose.facing]
      this.sprite.setCrop(0, 0, f.realWidth, cut)
      this.sprite.setPosition(pose.x, pose.y + (f.realHeight - cut) * this.sprite.scaleY)
    } else {
      this.sprite.setPosition(pose.x, pose.y)
    }
    this.updateDepth()
  }

  /** Stand up from a seat: back to the spot you sat down from. */
  standUp(): void {
    const seat = this.seat
    if (!seat) return
    this.seat = null
    this.sprite.setCrop()
    this.sprite.setPosition(seat.fromX, seat.fromY)
    ;(this.sprite.body as Phaser.Physics.Arcade.Body).enable = true
    ;(this.sprite.body as Phaser.Physics.Arcade.Body).reset(seat.fromX, seat.fromY)
    this.updateDepth()
  }

  /**
   * Dodge roll: a quick burst the way you're heading (or facing), with a
   * short window of invulnerability. Physics-driven, so walls still stop it.
   */
  tryDodge(towards: Phaser.Math.Vector2): void {
    if (uiBlocked() || this.deps.cinematic() || this.deps.transitioning() || this.deps.session.persistenceInFlight) return
    if (this.seat) return // no rolling out of a bench; move to stand up
    if (this.dodgeCooldown > 0 || this.dashTime > 0) return
    const dir = towards
    if (dir.lengthSq() < 0.01) dir.set(this.facing.x, this.facing.y)
    dir.normalize()
    const speed = this.deps.avatar().riding ? DODGE.speed * 1.2 : DODGE.speed
    this.sprite.setVelocity(dir.x * speed, dir.y * speed)
    this.dashTime = DODGE.time
    this.iframes = Math.max(this.iframes, DODGE.iframes)
    this.dodgeCooldown = DODGE.cooldown
    bus.emit(EV.rolled, { cooldown: DODGE.cooldown })
    const body = this.deps.avatar().container ?? this.sprite
    if (!this.deps.reducedMotion) {
      const sy = body.scaleY
      this.scene.tweens.add({ targets: body, scaleY: sy * 0.75, duration: DODGE.time * 500, yoyo: true, onComplete: () => body.setScale(body.scaleX, sy) })
      body.setAlpha(0.65)
      this.scene.time.delayedCall(DODGE.iframes * 1000, () => body.setAlpha(1))
    }
    // A puff of dust where you left.
    const dust = this.scene.add.particles(this.sprite.x, this.sprite.y - 2, 'spark', {
      speed: { min: 10, max: 35 },
      lifespan: 300,
      quantity: 5,
      scale: { start: 0.7, end: 0 },
      tint: 0xc8b28a,
      emitting: false
    }).setDepth(this.sprite.y - 1)
    dust.explode(5)
    this.scene.time.delayedCall(400, () => dust.destroy())
  }

  /** Movement (input is the un-normalized key/joystick vector) + regen. */
  move(dt: number, input: Phaser.Math.Vector2): void {
    let dx = input.x
    let dy = input.y
    const len = Math.hypot(dx, dy)
    if (len > 1) {
      dx /= len
      dy /= len
    }
    // Seated: hold the pose, regen a little mana, and stand on any movement.
    if (this.seat) {
      if (len > 0.1) {
        this.standUp()
      } else {
        this.sprite.setVelocity(0, 0)
        this.sprite.anims.stop()
        const state = this.deps.session.state
        const rest = this.deps.restRate()
        const mana = Math.min(state.maxMana, state.mana + (5 + this.seatedBonus + 6 * rest) * dt)
        this.deps.session.setVitals(state.hp, mana)
        return
      }
    }
    // During the shadowstep dash window the dash velocity owns the body —
    // ordinary movement (including the idle 0,0) must not cancel it.
    this.dashTime = Math.max(0, this.dashTime - dt)
    if (this.dashTime <= 0) {
      const speed = this.deps.avatar().riding ? 155 : PLAYER_SPEED
      this.sprite.setVelocity(dx * speed, dy * speed)
    }
    if (len > 0.1) {
      this.facing.set(dx, dy).normalize()
      // Delivered 4-direction walk animations; keep facing when idle.
      const anim = Math.abs(dx) >= Math.abs(dy)
        ? dx < 0 ? 'demo-walk-left' : 'demo-walk-right'
        : dy < 0 ? 'demo-walk-up' : 'demo-walk-down'
      if (this.sprite.anims.currentAnim?.key !== anim) this.sprite.play(anim, true)
    } else {
      this.sprite.anims.stop()
    }
    // Local stamina + rest regeneration, by provenance:
    // - Mana is local and bounded: it returns slowly everywhere and is never
    //   reset by sync or reload (explicitly described in the panel).
    // - HP regen only when the shared policy allows it (demo vitals, in the
    //   village). Imported vitals get NO passive refill anywhere.
    const state = this.deps.session.state
    // Lit road lanterns are ember-bought rest spots: mana for everyone, HP
    // for demo heroes (still local only — Habitica is never touched).
    const rest = this.deps.restRate()
    const mana = Math.min(state.maxMana, state.mana + (5 + 6 * rest) * dt)
    let hp = state.hp
    // HP only for demo vitals: imported health mirrors Habitica (approved
    // policy: no passive HP refill for imported heroes, lanterns included).
    if (rest > 0 && state.hp > 0 && passiveRegenAllowed(this.deps.session.vitalsSource)) hp = Math.min(state.maxHp, hp + 2 * dt)
    if (
      passiveRegenAllowed(this.deps.session.vitalsSource) &&
      this.deps.world.areaId === 'village' &&
      state.hp > 0
    ) {
      hp = Math.min(state.maxHp, state.hp + 1.2 * dt)
    }
    this.deps.session.setVitals(hp, mana)
  }

  /**
   * Melee (or the mage's ranged basic) on the action button. With a tool in
   * hand it's a tool's swing instead: melee whatever the class, at half the
   * weapon's damage (src/game/held.ts). `toward` turns to face a point first
   * (a mouse click).
   */
  tryAttack(opts: { tool?: boolean; toward?: { x: number; y: number } } = {}): void {
    if (this.seat) return // no fighting from a bench; move to stand up
    const kit = this.kit()
    if (this.attackCooldown > 0 || this.deps.transitioning()) return
    if (opts.toward) {
      const fx = opts.toward.x - this.sprite.x
      const fy = opts.toward.y - (this.sprite.y - 8)
      if (Math.hypot(fx, fy) > 1) this.facing.set(fx, fy).normalize()
    }
    this.attackCooldown = kit.basicAttackCooldown
    const dir = this.facing.clone().normalize()
    const tool = !!opts.tool
    // Mage basic is a ranged bolt (the classless starter keeps its melee
    // slash); every other class strikes in melee reach.
    if (kit.class === 'mage' && !tool) {
      this.deps.projectiles().spawn(this.sprite.x + dir.x * 10, this.sprite.y - 7, dir, kit.meleeDamage)
      return
    }
    const sx = this.sprite.x + dir.x * 14
    const sy = this.sprite.y - 7 + dir.y * 12
    // The aliased slash is a directional crescent (native art faces right):
    // rotate it to the facing like the other FX, instead of the old
    // flip/45-degree heuristic that turned cardinal attacks into diagonals.
    sfx('swing')
    const slash = this.scene.add.image(sx, sy, 'slash')
      .setDepth(this.sprite.y + 2)
      .setRotation(Math.atan2(dir.y, dir.x))
    // A tool's swing: a shorter, duller arc than the blade's.
    if (tool) slash.setScale(0.75).setTint(0xd8c79c)
    this.scene.tweens.add({ targets: slash, alpha: 0, duration: 150, onComplete: () => slash.destroy() })
    this.scene.time.delayedCall(60, () => {
      for (const enemy of [...this.deps.enemies().enemies]) {
        const dx = enemy.sprite.x - sx
        const dy = enemy.sprite.y - 6 - sy
        if (dx * dx + dy * dy < ATTACK_RANGE * ATTACK_RANGE) {
          const crit = Math.random() < kit.critChance
          const base = tool ? Math.max(1, Math.round(kit.meleeDamage * TOOL_DAMAGE)) : kit.meleeDamage
          const dmg = crit ? base * 2 : base
          if (crit) this.deps.fx.sparkBurst(enemy.sprite.x, enemy.sprite.y - 8, 8)
          this.deps.enemies().damageEnemy(enemy, dmg, this.sprite.x, crit)
        }
      }
    })
  }

  /** The signature ability (F / the ability button). */
  handleCast(): void {
    const kit = this.kit()
    if (uiBlocked() || performance.now() < uiState.blockedUntil || this.deps.transitioning() || this.deps.cinematic()) return
    if (this.seat) return // no casting from a bench; move to stand up
    if (this.deps.session.zeroHpLocked) return
    if (this.castCooldown > 0 || this.attackCooldown > kit.basicAttackCooldown) {
      bus.emit(EV.ability, { status: 'cooldown' } satisfies AbilityPayload)
      return
    }
    if (this.deps.session.state.mana < kit.manaCost) {
      this.deps.fx.floatText(this.sprite.x, this.sprite.y - 24, 'no mana', '#9cc4ff', false)
      bus.emit(EV.ability, { status: 'no-mana' } satisfies AbilityPayload)
      return
    }
    this.castCooldown = kit.signatureCooldown
    bus.emit(EV.ability, { status: 'cast', cooldown: this.castCooldown } satisfies AbilityPayload)
    this.deps.session.setVitals(this.deps.session.state.hp, this.deps.session.state.mana - kit.manaCost)
    const dir = this.facing.clone().normalize()
    switch (kit.signature) {
      case 'bolt': {
        this.deps.projectiles().spawn(this.sprite.x + dir.x * 10, this.sprite.y - 7, dir, kit.signatureDamage)
        break
      }
      case 'cleave': {
        // Wide sweeping arc in front: hits every creature in reach. Per the
        // pack README the delivered cleave canvas is centered on the
        // ATTACKER (visual only); the hit check keeps its own attacker-front
        // cast point, reach, and timing — unchanged.
        const cx = this.sprite.x + dir.x * 22
        const cy = this.sprite.y - 6 + dir.y * 18
        if (!this.deps.fx.playEffect('effect-cleave', 'cleave-0', this.sprite.x, this.sprite.y - 8, this.sprite.y + 2, Math.atan2(dir.y, dir.x))) {
          const sweep = this.scene.add.image(cx, cy, 'slash').setScale(2.2).setDepth(this.sprite.y + 2)
          this.scene.tweens.add({ targets: sweep, alpha: 0, scale: 3, duration: 220, onComplete: () => sweep.destroy() })
        }
        this.scene.cameras.main.shake(90, 0.004)
        this.scene.time.delayedCall(50, () => {
          for (const enemy of [...this.deps.enemies().enemies]) {
            const dx = enemy.sprite.x - cx
            const dy = enemy.sprite.y - 6 - cy
            if (dx * dx + dy * dy < 40 * 40) {
              this.deps.enemies().damageEnemy(enemy, kit.signatureDamage, this.sprite.x)
            }
          }
        })
        break
      }
      case 'dash': {
        // Snapstrike: physics-driven dash (colliders apply — never through
        // walls), striking everything along the path at the end. The dash
        // window (dashTime) keeps ordinary movement from cancelling velocity.
        const start = this.sprite.x
        this.dashTime = 0.15
        this.sprite.setVelocity(dir.x * 430, dir.y * 430)
        this.scene.time.delayedCall(150, () => {
          this.sprite.setVelocity(0, 0)
          const travelled = Math.abs(this.sprite.x - start) > 4
          const sx = this.sprite.x + dir.x * 10
          const sy = this.sprite.y - 6
          // Delivered dash-trail animation at the emission point, oriented
          // along the dash (the art trails left behind rightward motion).
          if (!this.deps.fx.playEffect('effect-dash-trail', 'dash-trail-0', sx, sy, this.sprite.y + 2, Math.atan2(dir.y, dir.x))) {
            const trail = this.scene.add.image(sx, sy, 'slash').setAlpha(0.7).setDepth(this.sprite.y + 2)
            this.scene.tweens.add({ targets: trail, alpha: 0, duration: 140, onComplete: () => trail.destroy() })
          }
          this.scene.time.delayedCall(30, () => {
            for (const enemy of [...this.deps.enemies().enemies]) {
              const dx = enemy.sprite.x - this.sprite.x
              const dy = enemy.sprite.y - 6 - (this.sprite.y - 6)
              const reach = travelled ? 34 : 22
              if (dx * dx + dy * dy < reach * reach) {
                const crit = Math.random() < kit.critChance * 2
                this.deps.enemies().damageEnemy(enemy, crit ? kit.signatureDamage * 2 : kit.signatureDamage, this.sprite.x - dir.x * 10, crit)
              }
            }
          })
        })
        break
      }
      case 'heal': {
        // Soothing Snap: damaging pulse around the hero + local self-heal.
        // The delivered pulse animation is centered on the caster; the glow
        // fallback stays for the no-pack path.
        if (!this.deps.fx.playEffect('effect-healing-pulse', 'healing-pulse-0', this.sprite.x, this.sprite.y - 8, this.sprite.y + 2)) {
          const pulse = this.scene.add.image(this.sprite.x, this.sprite.y - 8, 'glow')
            .setBlendMode(Phaser.BlendModes.ADD)
            .setScale(0.4)
            .setDepth(this.sprite.y + 2)
          this.scene.tweens.add({ targets: pulse, scale: 1.6, alpha: 0, duration: 320, onComplete: () => pulse.destroy() })
        }
        for (const enemy of [...this.deps.enemies().enemies]) {
          const dx = enemy.sprite.x - this.sprite.x
          const dy = enemy.sprite.y - 6 - (this.sprite.y - 8)
          if (dx * dx + dy * dy < 70 * 70) {
            this.deps.enemies().damageEnemy(enemy, kit.signatureDamage, this.sprite.x)
          }
        }
        if (kit.healAmount > 0) {
          this.deps.fx.sparkBurst(this.sprite.x, this.sprite.y - 12, 6)
          this.deps.session.setVitals(this.deps.session.state.hp + kit.healAmount, this.deps.session.state.mana)
        }
        break
      }
    }
  }

  damagePlayer(amount: number, fromX: number, fromY: number = this.sprite.y): void {
    if (this.iframes > 0 || this.deps.transitioning()) return
    const state = this.deps.session.state
    // kit.mitigation is a FRACTION (0..0.45, shared combat contract), not a
    // flat subtraction: damage scales down multiplicatively, always >= 1.
    const mitigated = Math.max(1, Math.round(amount * (1 - this.kit().mitigation)))
    this.deps.session.setVitals(state.hp - mitigated, state.mana)
    this.iframes = CONTACT_IFRAMES
    this.sprite.setTint(0xff9080)
    this.scene.time.delayedCall(160, () => this.sprite.clearTint())
    this.deps.fx.floatText(this.sprite.x, this.sprite.y - 24, `-${mitigated}`, '#ff8a70', false)
    sfx('hurt')
    if (!this.deps.reducedMotion) this.scene.cameras.main.shake(120, 0.006)
    // A brief blink while invulnerable shows the grace window. The imported
    // avatar container is the visible body when present (player alpha 0).
    const body = this.deps.avatar().container ?? this.sprite
    if (!this.deps.reducedMotion) {
      this.scene.tweens.add({
        targets: body,
        alpha: { from: 0.35, to: 1 },
        duration: 110,
        repeat: 3,
        yoyo: true,
        onComplete: () => body.setAlpha(1)
      })
    }
    // Knocked back through physics (never into a wall); the dash window
    // stops ordinary movement from cancelling the shove.
    const away = new Phaser.Math.Vector2(this.sprite.x - fromX, this.sprite.y - fromY)
    if (away.lengthSq() < 0.01) away.set(-this.facing.x, -this.facing.y)
    away.normalize()
    this.sprite.setVelocity(away.x * KNOCK.player, away.y * KNOCK.player)
    this.dashTime = Math.max(this.dashTime, KNOCK.time)
    if (this.deps.session.state.hp <= 0) this.deps.onDefeat()
  }

  /** Depth-by-y for the hero sprite + its shadow (seated: the seat's depth, no shadow). */
  updateDepth(): void {
    if (this.seat) {
      this.sprite.setDepth(this.seat.depth)
      this.shadow.setVisible(false)
      return
    }
    this.sprite.setDepth(this.sprite.y)
    this.shadow.setVisible(true).setPosition(this.sprite.x, this.sprite.y - 1)
  }

  private kit(): CombatKit {
    return withCharm(getCombatKit(this.deps.session.importedProfile), this.deps.session.state.inventory)
  }

  private build(state: { position: { x: number; y: number } }, entry: { tx: number; ty: number } | null): void {
    let px: number
    let py: number
    if (entry) {
      px = tileMid(entry.tx)
      py = tileMid(entry.ty)
    } else {
      const saved = state.position
      px = saved.x
      py = saved.y
      // Fall back to spawn if the saved spot is out of bounds or solid.
      const tx = tileAt(px)
      const ty = tileAt(py)
      const inBounds = tx >= 0 && ty >= 0 && tx < this.deps.world.width && ty < this.deps.world.height
      if (!inBounds || this.deps.world.solid[ty][tx]) {
        px = tileMid(this.deps.world.spawn.tx)
        py = tileMid(this.deps.world.spawn.ty)
      }
    }
    this.shadow = this.scene.add.image(px, py - 1, 'shadow').setDepth(-1)
    // Delivered 4-direction walk hero, normalized to the 16px world
    // (source frames are ~133x228; displayed ~20px tall).
    const tex = this.scene.textures.get('fingersnap-demo-walk')
    const heroFrame = tex.has('walk-down-0') ? tex.get('walk-down-0')! : null
    const heroH = 20
    let heroScale = 1
    if (heroFrame) heroScale = heroH / heroFrame.height
    this.sprite = this.scene.physics.add.sprite(px, py, heroFrame ? 'fingersnap-demo-walk' : 'hero0', heroFrame ? 'walk-down-0' : undefined)
    this.sprite.setOrigin(0.5, 1)
    this.sprite.setScale(heroScale)
    const body = this.sprite.body as Phaser.Physics.Arcade.Body
    // Body sizes/offsets are in SOURCE pixels (scaled by the sprite's scale),
    // so express the 10x4 world foot-box in source units at the feet.
    body.setSize(10 / heroScale, 4 / heroScale)
    body.setOffset((heroFrame ? heroFrame.width : 16) / 2 - 5 / heroScale, (heroFrame ? heroFrame.height : 16) - 4 / heroScale)
    // Never wander off the rendered map (e.g. a zero-HP gate blocking the exit
    // tile must stop at the boundary, hero visible, no softlock); area exits
    // still trigger inside the bounds.
    body.setCollideWorldBounds(true)
    this.sprite.setDepth(py)
    // A footstep on every other walk frame (two per cycle), on the ground underfoot.
    this.sprite.on(Phaser.Animations.Events.ANIMATION_UPDATE, (_a: Phaser.Animations.Animation, frame: Phaser.Animations.AnimationFrame) => {
      if (frame.index % 2 !== 0 || this.dashTime > 0 || body.velocity.lengthSq() < 1) return
      const terrain = this.deps.world.ground[tileAt(this.sprite.y)]?.[tileAt(this.sprite.x)]
      if (terrain !== undefined) bus.emit(EV.footstep, { terrain })
    })
  }
}
