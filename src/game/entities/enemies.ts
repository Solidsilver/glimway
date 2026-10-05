/**
 * Enemies: wisps (telegraphed hops), beetles (telegraphed straight-line
 * charges that end dazed against walls), and the stone warden (quest-driven
 * encounter). Every real attack is telegraphed; bumping into an enemy that
 * isn't attacking only stings. Includes knockback, poses, and the floating
 * HP bars.
 *
 * The warden is not fought down. It is a lamp in a stone coat, homesick for
 * one pose: blows only clink off it. After each lunge it stops to find its
 * feet, and a hero within reach can hold up the closure-mark rubbing. Each
 * showing makes it falter; after WARDEN.showings it settles into its pose and
 * stays there (the quest event is still 'defeat-guardian', for saves).
 */
import Phaser from 'phaser'
import type { GameState } from '../../lib/state'
import { bus, EV } from '../events'
import { sfx } from '../sfx'
import type { Session } from '../session'
import { TILE } from '../textures'
import type { EnemyType, WorldData } from '../worlds'
import type { Effects } from './fx'

export interface Enemy {
  id: string
  type: EnemyType
  sprite: Phaser.Physics.Arcade.Sprite
  hp: number
  maxHp: number
  homeX: number
  homeY: number
  dirX: number
  dirY: number
  wanderTimer: number
  attackTimer: number
  state: 'chase' | 'telegraph' | 'lunge' | 'sweep' | 'recover' | 'stunned'
  stateTimer: number
  lungeX: number
  lungeY: number
  /** Remaining hurt-pose window (seconds); visual only. */
  hurtTimer: number
  /** Knockback in progress: physics velocity owned by the shove, AI paused. */
  knockTimer: number
  /** Sidestepping an obstacle on the way home (seconds left). */
  detourTimer: number
  knockX: number
  knockY: number
  /** Atlas art prefix for small enemies ('slime' | 'mushroom' | 'beetle'). */
  art: string
  dead: boolean
  /** Warden only: which attack the current telegraph leads into. */
  attack: 'lunge' | 'sweep'
  /** Warden only: recovering after a lunge, so the rubbing can be shown. */
  opening: boolean
  /** Warden only: how many times it has been shown the rubbing. */
  showings: number
}

/**
 * Cozy-demo combat tuning: every real attack is telegraphed (a windup pose,
 * a "!" and a rising tone) so it can be read and dodged; bumping into an
 * enemy that isn't attacking only stings.
 */
export const ENEMY_TUNING = {
  // lock: seconds before launch when the aim freezes (with a white flash) —
  // the moment to step aside.
  wisp: { hp: 10, contact: 1, chase: 38, aggro: 90, hopRange: 46, windup: 0.5, lock: 0.18, hopSpeed: 175, hopTime: 0.24, hop: 2, recover: 0.65, cooldown: 1.4 },
  beetle: { hp: 18, contact: 1, walk: 30, aggro: 130, keepAway: 64, chargeRange: 120, windup: 0.8, lock: 0.3, chargeSpeed: 220, chargeTime: 0.85, charge: 3, stun: 1.4, recover: 0.5, cooldown: 2.1, stunnedTakes: 1.5 },
  guardian: { hp: 44, contact: 1, lunge: 3, lungeSpeed: 250, telegraph: 0.65, cooldown: 3.2 }
} as const

/**
 * The warden encounter. Lunges come from range and leave an opening (it stops
 * to find its feet); hugging it draws a quicker arm sweep with no opening.
 * The dance: bait a lunge, sidestep, close in, hold up the rubbing.
 */
export const WARDEN = {
  /** Showings of the rubbing before it settles. */
  showings: 3,
  /** Seconds it stands open after a lunge (hero walks 110 px/s; a lunge runs ~85 px). */
  opening: 1.5,
  /** Hero-to-warden distance (px) at which the rubbing can be shown. */
  showReach: 36,
  /** Seconds it reels after a showing before it walks again. */
  falter: 0.9,
  /** It walks up to this distance and holds the path there. */
  holdAt: 60,
  /** Farther than this, it gives up on you and walks back to its post. */
  homesick: 170,
  /** Inside this distance it sweeps instead of lunging. */
  sweepRange: 34,
  sweepWindup: 0.55,
  sweepTime: 0.22,
  sweepReach: 30,
  sweep: 2,
  sweepRecover: 0.45,
  /** Re-arm after a sweep: crowding it gets swept often. */
  sweepCooldown: 1.5,
  /** Each showing slows its next attack a little: it is calming down. */
  calmPerShowing: 0.35
} as const

/** Read-only warden snapshot for playtests. */
export interface WardenView {
  state: 'absent' | 'dormant' | 'active' | 'settled'
  x: number
  y: number
  texture: string
  visible: boolean
  phase: string | null
  opening: boolean
  showings: number
  needed: number
}

/** Knockback impulses (px/s) applied over KNOCK.time through physics. */
export const KNOCK = { small: 170, guardian: 60, player: 150, time: 0.13 }

/** What the enemy AI needs from the hero (implemented by Hero). */
export interface HeroView {
  readonly sprite: Phaser.Physics.Arcade.Sprite
  readonly facing: Phaser.Math.Vector2
  damagePlayer(amount: number, fromX: number, fromY?: number): void
}

export interface EnemyDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  /** Collisions built by game/area/collision. */
  solidGroup: Phaser.Physics.Arcade.StaticGroup
  hero: () => HeroView
}

export class EnemySystem {
  private _enemies: Enemy[] = []
  private guardianSpawned = false
  private hpBars!: Phaser.GameObjects.Graphics
  /** The warden at rest (before the clue it stands dormant; after, settled). */
  private restingWarden: Phaser.GameObjects.Image | null = null
  private restingState: 'dormant' | 'settled' | null = null
  /** The amber heart-lamp glowing in the warden's chest. */
  private heart: Phaser.GameObjects.Image | null = null
  /** The first clink of a blow off the warden explains itself once. */
  private clinkHinted = false

  constructor(private scene: Phaser.Scene, private deps: EnemyDeps, state: GameState) {
    const { world } = deps
    for (const spot of world.enemies) {
      if (spot.type === 'guardian') continue // guardian is quest-driven
      if (state.defeatedEnemies.includes(spot.id)) continue
      this.spawnEnemy(spot.id, spot.type, spot.tx, spot.ty)
    }
    if (world.areaId === 'ruin' && world.shrine) {
      // The warden is always on its path: standing in its pose before you
      // carry the mark, awake while you do, resting in its pose afterwards.
      if (state.quest === 'clue-found') this.spawnGuardian(false)
      else this.placeRestingWarden(state.quest === 'new' || state.quest === 'accepted' ? 'dormant' : 'settled')
    }
    this.hpBars = scene.add.graphics().setDepth(5000)
  }

  get enemies(): Enemy[] {
    return this._enemies
  }

  /**
   * Spawn the warden. Announces only when triggered by the clue dialogue —
   * respawns (re-entering mid-fight, reload) stay silent.
   */
  spawnGuardian(announce: boolean): void {
    if (this.guardianSpawned) return
    if (!this.deps.world.shrine) return
    if (this.deps.session.questStage !== 'clue-found') return
    this.guardianSpawned = true
    this.clearRestingWarden()
    const home = this.wardenHome()!
    this.spawnEnemy('stone-warden', 'guardian', home.tx, home.ty)
    this.heart = this.makeHeart()
    if (announce) {
      bus.emit(EV.toast, { text: 'Stone grinds on stone. The warden turns from its post, arms out, the lamp in its chest burning.' })
      if (!this.deps.reducedMotion) this.scene.cameras.main.shake(260, 0.005)
    }
  }

  /** The warden's post: a short way down the path from the shrine lantern. */
  private wardenHome(): { tx: number; ty: number } | null {
    const shrine = this.deps.world.shrine
    return shrine ? { tx: shrine.tx + 1, ty: shrine.ty + 3 } : null
  }

  /** A small amber glow for the heart-lamp (follows the warden each frame). */
  private makeHeart(): Phaser.GameObjects.Image {
    return this.scene.add.image(0, 0, 'glow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xffb054)
      .setScale(0.16)
      .setAlpha(0.6)
  }

  /** Where the heart-lamp sits on a warden sprite (chest, a little forward). */
  private placeHeart(sprite: Phaser.GameObjects.Image, settled: boolean): void {
    if (!this.heart) return
    const forward = sprite.flipX ? -1 : 1
    this.heart.setPosition(sprite.x + forward * (settled ? 2 : 1), sprite.y - (settled ? 6 : 10)).setDepth(sprite.depth + 1)
  }

  /**
   * The warden at rest on its post: standing in its pose (dormant, before the
   * rubbing is taken) or settled, arms down and heart-lamp low. It isn't an
   * enemy either way: no AI, no contact, no bar.
   */
  private placeRestingWarden(kind: 'dormant' | 'settled'): void {
    const home = this.wardenHome()
    if (!home) return
    const tex = kind === 'settled' ? this.guardianPoseTexture('defeat', 'guardian0') : this.guardianPoseTexture('idle', 'guardian0')
    const sprite = this.scene.add.image(home.tx * TILE + 8, home.ty * TILE + TILE, tex).setOrigin(0.5, 1)
    sprite.setDepth(sprite.y)
    this.restingWarden = sprite
    this.restingState = kind
    this.heart = this.makeHeart()
    this.placeHeart(sprite, kind === 'settled')
    if (kind === 'settled') this.gutterHeart(true)
  }

  private clearRestingWarden(): void {
    this.restingWarden?.destroy()
    this.restingWarden = null
    this.restingState = null
    this.heart?.destroy()
    this.heart = null
  }

  /** The heart-lamp burned down to a coal: low, slow, still alive. */
  private gutterHeart(instant: boolean): void {
    const heart = this.heart
    if (!heart) return
    this.scene.tweens.killTweensOf(heart)
    const rest = () => {
      if (!heart.active) return
      heart.setAlpha(0.42).setScale(0.12)
      if (!this.deps.reducedMotion) {
        this.scene.tweens.add({ targets: heart, alpha: 0.24, duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
    }
    if (instant || this.deps.reducedMotion) {
      rest()
      return
    }
    // Gutter: two bright catches, then down to a coal.
    this.scene.tweens.chain({
      targets: heart,
      tweens: [
        { alpha: 0.9, scale: 0.2, duration: 120 },
        { alpha: 0.3, scale: 0.12, duration: 160 },
        { alpha: 0.75, scale: 0.17, duration: 140 },
        { alpha: 0.42, scale: 0.12, duration: 700, ease: 'Quad.easeOut' }
      ],
      onComplete: rest
    })
  }

  /** The live warden, if it is up and unsettled in this area. */
  private activeWarden(): Enemy | undefined {
    return this.enemies.find((e) => e.type === 'guardian' && !e.dead)
  }

  /**
   * Where to show the "Hold up the rubbing" prompt, or null: only while the
   * warden stands open after a lunge and the hero is within reach.
   */
  showTarget(): { x: number; y: number } | null {
    const w = this.activeWarden()
    if (!w || w.state !== 'recover' || !w.opening || w.knockTimer > 0) return null
    const hero = this.deps.hero().sprite
    const dist = Math.hypot(hero.x - w.sprite.x, hero.y - 8 - (w.sprite.y - 6))
    return dist < WARDEN.showReach ? { x: w.sprite.x, y: w.sprite.y - 36 } : null
  }

  /**
   * Hold up the closure-mark rubbing. Returns true when it was shown (the
   * interact press is used up). `force` skips the opening and reach checks
   * (dev playtest lever only).
   */
  showRubbing(force = false): boolean {
    const w = this.activeWarden()
    if (!w) return false
    if (!force && !this.showTarget()) return false
    w.showings += 1
    w.opening = false
    const hero = this.deps.hero()
    // The hero raises the rubbing: a small paper flash above their head.
    this.deps.fx.floatText(hero.sprite.x, hero.sprite.y - 22, 'two weaves and a break', '#fff3c4', false)
    if (w.showings >= WARDEN.showings) {
      this.settleWarden(w)
      return true
    }
    // Falter: it rocks back, the heart-lamp flickers, then it gathers itself.
    sfx('falter')
    w.state = 'recover'
    w.stateTimer = WARDEN.falter
    w.hurtTimer = 0.4
    const away = new Phaser.Math.Vector2(w.sprite.x - hero.sprite.x, w.sprite.y - hero.sprite.y)
    if (away.lengthSq() < 0.01) away.set(hero.facing.x, hero.facing.y)
    away.normalize()
    w.knockX = away.x * 90
    w.knockY = away.y * 90
    w.knockTimer = KNOCK.time
    this.deps.fx.floatText(w.sprite.x, w.sprite.y - 28, 'falters', '#ffd27a', false)
    if (!this.deps.reducedMotion) this.scene.cameras.main.shake(120, 0.003)
    if (this.heart && !this.deps.reducedMotion) {
      this.scene.tweens.add({ targets: this.heart, alpha: 0.15, duration: 90, yoyo: true, repeat: 2 })
    }
    return true
  }

  /**
   * Settled: arms down, the heart-lamp gutters, and it rests in its pose.
   * No dissolve — the sprite stays where it stopped. (Come back later and
   * it will be on its post: drift-stone walks home when nobody watches.)
   */
  private settleWarden(w: Enemy): void {
    w.dead = true
    this._enemies = this.enemies.filter((e) => e !== w)
    const body = w.sprite.body as Phaser.Physics.Arcade.Body
    body.setVelocity(0, 0)
    body.enable = false
    w.sprite.clearTint()
    sfx('settle')
    this.deps.fx.floatText(w.sprite.x, w.sprite.y - 28, 'settles', '#ffd27a', true)
    // Arms lower (the crouch), then down into its resting heap.
    w.sprite.setTexture(this.guardianPoseTexture('windup', 'guardian1'))
    this.scene.time.delayedCall(this.deps.reducedMotion ? 0 : 420, () => {
      if (w.sprite.active) w.sprite.setTexture(this.guardianPoseTexture('defeat', 'guardian0'))
    })
    this.placeHeart(w.sprite, true)
    this.gutterHeart(false)
    this.restingWarden = w.sprite
    this.restingState = 'settled'
    // Same save effects as ever: the quest event and the defeated-enemy entry.
    this.deps.session.recordDefeat(w.id)
    this.deps.session.applyQuestEvent('defeat-guardian')
  }

  /** Read-only snapshot for playtests (window.__fsWarden). */
  wardenView(): WardenView {
    const w = this.activeWarden()
    const sprite = w?.sprite ?? this.restingWarden
    const state: WardenView['state'] = w ? 'active' : this.restingState ?? 'absent'
    return {
      state,
      x: sprite?.x ?? 0,
      y: sprite?.y ?? 0,
      texture: sprite?.texture.key ?? '',
      visible: !!sprite && sprite.active && sprite.visible && sprite.alpha > 0.5,
      phase: w ? w.state : null,
      opening: !!w && w.state === 'recover' && w.opening,
      showings: w?.showings ?? (this.restingState === 'settled' ? WARDEN.showings : 0),
      needed: WARDEN.showings
    }
  }

  /**
   * A blow (or bolt) on the warden: it rings off the stone and changes
   * nothing but a small rock on its feet. The first one says why.
   */
  private clinkWarden(enemy: Enemy, fromX: number): void {
    this.deps.fx.floatText(enemy.sprite.x, enemy.sprite.y - 26, 'clink', '#c9c2d6', false)
    sfx('clink')
    this.knockEnemy(enemy, fromX)
    if (!this.clinkHinted) {
      this.clinkHinted = true
      bus.emit(EV.toast, { text: 'Your blow rings off the stone. It isn\u2019t fighting you; it\u2019s keeping a pose. Show it the mark.' })
    }
  }

  damageEnemy(enemy: Enemy, amount: number, fromX: number, crit = false): void {
    if (enemy.type === 'guardian') {
      this.clinkWarden(enemy, fromX)
      return
    }
    // A dazed beetle (charged into something) is wide open.
    if (enemy.type === 'beetle' && enemy.state === 'stunned') {
      amount *= ENEMY_TUNING.beetle.stunnedTakes
      crit = true
    }
    enemy.hp -= amount
    this.deps.fx.floatText(enemy.sprite.x, enemy.sprite.y - 16, crit ? `${Math.round(amount)}!` : `${Math.round(amount)}`, crit ? '#ffd24a' : '#fffbef', crit)
    sfx(crit ? 'crit' : 'hit')
    this.deps.fx.hitStop(crit ? 70 : 45)
    enemy.sprite.setTint(0xffe0d0)
    this.scene.time.delayedCall(90, () => {
      if (!enemy.dead && enemy.sprite.active) enemy.sprite.clearTint()
    })
    this.knockEnemy(enemy, fromX)
    if (enemy.hp <= 0) this.killEnemy(enemy)
  }

  /** Per-frame AI + contact damage. */
  update(dt: number): void {
    const hero = this.deps.hero()
    const px = hero.sprite.x
    const py = hero.sprite.y - 8
    for (const enemy of [...this.enemies]) {
      if (enemy.dead) continue
      const ex = enemy.sprite.x
      const ey = enemy.sprite.y - 6
      const dist = Math.hypot(px - ex, py - ey)
      const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
      if (enemy.knockTimer > 0) {
        // Shoved: physics owns the body for a beat, the AI waits.
        enemy.knockTimer -= dt
        body.setVelocity(enemy.knockX, enemy.knockY)
        enemy.stateTimer -= dt
        if (enemy.knockTimer <= 0) {
          body.setVelocity(0, 0)
          if (enemy.type !== 'guardian' && enemy.state !== 'telegraph' && enemy.state !== 'stunned') this.setEnemyPose(enemy, 'idle')
        }
      } else if (enemy.type === 'wisp') {
        this.updateHopper(enemy, dt, dist, px, py)
      } else if (enemy.type === 'beetle') {
        this.updateBeetle(enemy, dt, dist, px, py)
      } else {
        this.updateGuardian(enemy, dt, dist, px, py)
      }
      // Contact damage: attacks hit hard; a bump only stings.
      let reach = 12
      let dmg: number = ENEMY_TUNING[enemy.type].contact
      if (enemy.type === 'guardian' && enemy.state === 'lunge') {
        reach = 18
        dmg = ENEMY_TUNING.guardian.lunge
      } else if (enemy.type === 'guardian' && enemy.state === 'sweep') {
        reach = WARDEN.sweepReach
        dmg = WARDEN.sweep
      } else if (enemy.type === 'guardian' && enemy.state === 'recover') {
        dmg = 0 // standing still to find its feet: walking up to it is safe
      } else if (enemy.type === 'wisp' && enemy.state === 'lunge') {
        reach = 14
        dmg = ENEMY_TUNING.wisp.hop
      } else if (enemy.type === 'beetle' && enemy.state === 'lunge') {
        reach = 15
        dmg = ENEMY_TUNING.beetle.charge
      } else if (enemy.type === 'beetle' && enemy.state === 'stunned') {
        dmg = 0
      }
      if (dmg > 0 && dist < reach) hero.damagePlayer(dmg, ex, enemy.sprite.y)
      enemy.sprite.setDepth(enemy.sprite.y)
      if (enemy.type === 'guardian') this.updateHeart(enemy)
    }
  }

  /** The heart-lamp follows the warden and flares while it stands open. */
  private updateHeart(w: Enemy): void {
    if (!this.heart) return
    this.placeHeart(w.sprite, false)
    if (this.scene.tweens.isTweening(this.heart)) return
    const open = w.state === 'recover' && w.opening
    const t = this.scene.time.now
    const pulse = this.deps.reducedMotion ? 0 : Math.sin(t * (open ? 0.018 : 0.006))
    this.heart.setAlpha(open ? 0.85 + pulse * 0.12 : 0.55 + pulse * 0.08).setScale(open ? 0.2 : 0.16)
  }

  updateEnemyBars(): void {
    this.hpBars.clear()
    for (const enemy of this.enemies) {
      if (enemy.type === 'guardian') {
        this.drawWardenPips(enemy)
        continue
      }
      // Small creatures only show a bar once hurt — less clutter, and no
      // bars floating over foliage for enemies the player hasn't met.
      if (enemy.hp >= enemy.maxHp) continue
      const w = 16
      const h = 3
      const x = Math.round(enemy.sprite.x - w / 2)
      const y = Math.round(enemy.sprite.y - 19)
      const pct = Math.max(0, enemy.hp / enemy.maxHp)
      this.hpBars.fillStyle(0x2b1d1a, 0.9)
      this.hpBars.fillRect(x - 1, y - 1, w + 2, h + 2)
      this.hpBars.fillStyle(0x5a3a32, 1)
      this.hpBars.fillRect(x, y, w, h)
      this.hpBars.fillStyle(0xf2c14e, 1)
      this.hpBars.fillRect(x, y, Math.max(0, Math.round(pct * w)), h)
      this.hpBars.fillStyle(0xffffff, 0.35)
      this.hpBars.fillRect(x, y, Math.max(0, Math.round(pct * w)), 1)
    }
  }

  /**
   * The warden has no health to lose. Instead: one pip per showing still
   * needed, lit amber as the rubbing lands — how close it is to settling.
   */
  private drawWardenPips(w: Enemy): void {
    const n = WARDEN.showings
    const gap = 7
    const x0 = Math.round(w.sprite.x - ((n - 1) * gap) / 2)
    const y = Math.round(w.sprite.y - 30)
    for (let i = 0; i < n; i++) {
      const x = x0 + i * gap
      this.hpBars.fillStyle(0x2b1d1a, 0.9)
      this.hpBars.fillRect(x - 3, y - 3, 6, 6)
      this.hpBars.fillStyle(i < w.showings ? 0xffc86a : 0x5a4a52, 1)
      this.hpBars.fillRect(x - 2, y - 2, 4, 4)
      if (i < w.showings) {
        this.hpBars.fillStyle(0xffffff, 0.45)
        this.hpBars.fillRect(x - 2, y - 2, 4, 1)
      }
    }
  }

  private spawnEnemy(id: string, type: EnemyType, tx: number, ty: number): Enemy {
    // Woodland enemies use the delivered slime/mushroom art; the guardian
    // uses the delivered native 24x24 pose textures when present (procedural
    // placeholder otherwise). Every pose shares the same 24x24 texture size
    // and (0.5, 1) origin, so the intended world size and the authored
    // 20x10 foot body are identical across poses.
    const art = type === 'beetle' ? 'beetle' : id === 'wisp-c' ? 'mushroom' : 'slime'
    const frame = type === 'guardian' ? 'guardian0' : `${art}-idle`
    const texKey = type === 'guardian' ? this.guardianPoseTexture('idle', 'guardian0') : 'fingersnap-enemies'
    const displayH = type === 'guardian' ? 24 : type === 'beetle' ? 13 : 14
    const sprite = this.scene.physics.add.sprite(tx * TILE + 8, ty * TILE + TILE, texKey, type === 'guardian' ? undefined : frame)
      .setOrigin(0.5, 1)
    if (type !== 'guardian') {
      const f = this.scene.textures.get('fingersnap-enemies').get(frame)!
      const s = displayH / f.height
      sprite.setScale(s)
      // Source-unit foot box for the scaled sprite (10x4 world px at feet).
      const ebody = sprite.body as Phaser.Physics.Arcade.Body
      ebody.setSize(10 / s, 4 / s)
      ebody.setOffset(f.width / 2 - 5 / s, f.height - 4 / s)
      const anim = `${art}-idle`
      if (this.scene.anims.exists(anim)) sprite.play(anim)
    } else {
      const gbody = sprite.body as Phaser.Physics.Arcade.Body
      // Authored guardian foot body: 20x10 anchored at the texture feet
      // (24x24 texture, offset 2,14 -> rows 14..24). Never inferred from art.
      gbody.setSize(20, 10)
      gbody.setOffset(2, 14)
    }
    const enemy: Enemy = {
      id,
      type,
      sprite,
      hp: ENEMY_TUNING[type].hp,
      maxHp: ENEMY_TUNING[type].hp,
      homeX: tx * TILE + 8,
      homeY: ty * TILE + TILE,
      dirX: 0,
      dirY: 0,
      wanderTimer: Math.random() * 2,
      attackTimer: 2.5,
      state: 'chase',
      stateTimer: 0,
      lungeX: 0,
      lungeY: 0,
      hurtTimer: 0,
      knockTimer: 0,
      detourTimer: 0,
      knockX: 0,
      knockY: 0,
      art,
      dead: false,
      attack: 'lunge',
      opening: false,
      showings: 0
    }
    // Enemies respect walls, trees and water: a charge can end in a tree.
    // They also stay on the map: an exit gap in the treeline is a way out
    // for the hero, never for a beetle mid-charge.
    this.scene.physics.add.collider(sprite, this.deps.solidGroup)
    ;(sprite.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true)
    this.enemies.push(enemy)
    return enemy
  }

  private killEnemy(enemy: Enemy): void {
    enemy.dead = true
    sfx('pop')
    this.deps.session.recordDefeat(enemy.id)
    // Spark burst
    const bx = enemy.sprite.x
    const by = enemy.sprite.y - 6
    const particles = this.scene.add.particles(bx, by, 'spark', {
      speed: { min: 30, max: 90 },
      lifespan: 420,
      quantity: 10,
      scale: { start: 1, end: 0 },
      emitting: false
    })
    particles.explode(10)
    this.scene.time.delayedCall(700, () => particles.destroy())
    // Freeze the body so the dissolve tween owns the sprite fully.
    const corpseBody = enemy.sprite.body as Phaser.Physics.Arcade.Body
    corpseBody.setVelocity(0, 0)
    corpseBody.enable = false
    this.scene.tweens.add({
      targets: enemy.sprite,
      alpha: 0,
      y: '+=4',
      scaleY: 0.6,
      duration: 320,
      onComplete: () => enemy.sprite.destroy()
    })
    this._enemies = this.enemies.filter((e) => e !== enemy)
  }

  /**
   * Shove an enemy away from the hit through physics (walls still apply).
   * Hopping slimes are knocked out of their hop; a charging beetle is too
   * heavy to stop, and the warden only rocks back between lunges.
   */
  private knockEnemy(enemy: Enemy, fromX: number): void {
    if (enemy.type === 'beetle' && enemy.state === 'lunge') return
    if (enemy.type === 'guardian' && enemy.state === 'lunge') return
    const hero = this.deps.hero()
    const dir = new Phaser.Math.Vector2(enemy.sprite.x - fromX, (enemy.sprite.y - hero.sprite.y) * 0.5)
    if (dir.lengthSq() < 0.01) dir.set(hero.facing.x, hero.facing.y)
    dir.normalize()
    const speed = enemy.type === 'guardian' ? KNOCK.guardian : KNOCK.small
    enemy.knockX = dir.x * speed
    enemy.knockY = dir.y * speed
    enemy.knockTimer = KNOCK.time
    if (enemy.type === 'wisp' && (enemy.state === 'telegraph' || enemy.state === 'lunge')) {
      // Interrupted: the windup is lost, so a quick hit is a real answer.
      enemy.state = 'recover'
      enemy.stateTimer = ENEMY_TUNING.wisp.recover
      enemy.sprite.clearTint()
    }
    if (enemy.type !== 'guardian') this.setEnemyPose(enemy, 'hurt')
    // A clink mid-windup must not hide the warden's telegraph pose.
    if (!(enemy.type === 'guardian' && enemy.state === 'telegraph')) enemy.hurtTimer = 0.22
  }

  /** Small-enemy pose: the idle loop, or a held atlas frame. */
  private setEnemyPose(enemy: Enemy, pose: 'idle' | 'windup' | 'squash' | 'hurt'): void {
    if (enemy.type === 'guardian' || enemy.dead || !enemy.sprite.active) return
    if (pose === 'idle') {
      const anim = `${enemy.art}-idle`
      if (enemy.sprite.anims.currentAnim?.key !== anim || !enemy.sprite.anims.isPlaying) {
        if (this.scene.anims.exists(anim)) enemy.sprite.play(anim)
      }
      return
    }
    enemy.sprite.anims.stop()
    enemy.sprite.setFrame(`${enemy.art}-${pose}`)
  }

  /**
   * Freeze the attack's aim at the player's position now, with a white flash
   * so the lock reads. Returns true the first frame it locks.
   */
  private lockAim(enemy: Enemy, lockAt: number, speed: number, px: number, py: number): boolean {
    if (enemy.stateTimer > lockAt || enemy.lungeX !== 0 || enemy.lungeY !== 0) return false
    const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y)
    if (dir.lengthSq() < 0.01) dir.set(enemy.sprite.flipX ? -1 : 1, 0)
    dir.normalize()
    enemy.lungeX = dir.x * speed
    enemy.lungeY = dir.y * speed
    enemy.sprite.setTintFill(0xffffff)
    this.scene.time.delayedCall(70, () => {
      if (!enemy.dead && enemy.sprite.active && enemy.state === 'telegraph') enemy.sprite.setTint(0xffd0c0)
    })
    return true
  }

  /** The tell before a real attack: windup pose, a "!" and a rising tone. */
  private telegraph(enemy: Enemy, seconds: number): void {
    this.setEnemyPose(enemy, 'windup')
    enemy.sprite.setTint(0xffd0c0)
    sfx('windup')
    const bang = this.scene.add.text(enemy.sprite.x, enemy.sprite.y - (enemy.type === 'beetle' ? 18 : 20), '!', {
      fontFamily: '"Pixelify Sans", monospace',
      fontSize: '14px',
      color: '#ffcf4a',
      stroke: '#3a1a10',
      strokeThickness: 4,
      resolution: 3
    }).setOrigin(0.5, 1).setDepth(6100)
    this.scene.tweens.add({ targets: bang, y: bang.y - 4, scale: { from: 0.4, to: 1 }, duration: 140, ease: 'Back.easeOut' })
    this.scene.time.delayedCall(seconds * 1000, () => bang.destroy())
    if (enemy.type === 'beetle' && !this.deps.reducedMotion) {
      // Pawing the ground: a small shiver while it winds up.
      // Rocks on its feet (angle only: position stays owned by physics).
      this.scene.tweens.add({ targets: enemy.sprite, angle: 5, duration: 45, yoyo: true, repeat: Math.floor(seconds * 1000 / 90) - 1, onComplete: () => enemy.sprite.setAngle(0) })
    }
  }

  /** Idle wandering near home, used by small enemies out of aggro range. */
  private wander(enemy: Enemy, dt: number, speed: number): void {
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.wanderTimer -= dt
    if (enemy.wanderTimer <= 0) {
      enemy.wanderTimer = 1 + Math.random() * 1.6
      const angle = Math.random() * Math.PI * 2
      enemy.dirX = Math.cos(angle)
      enemy.dirY = Math.sin(angle)
    }
    const blocked = body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down
    const home = new Phaser.Math.Vector2(enemy.homeX - enemy.sprite.x, enemy.homeY - enemy.sprite.y)
    if (blocked && enemy.detourTimer <= 0) {
      // Walking into a tree (now that enemies collide): slide sideways for a
      // moment instead of pushing into it forever.
      const side = home.lengthSq() > 0.01 ? home.clone().normalize() : new Phaser.Math.Vector2(enemy.dirX, enemy.dirY)
      const sign = Math.random() < 0.5 ? 1 : -1
      enemy.dirX = -side.y * sign
      enemy.dirY = side.x * sign
      enemy.detourTimer = 0.6
    }
    enemy.detourTimer = Math.max(0, enemy.detourTimer - dt)
    body.setVelocity(enemy.dirX * speed, enemy.dirY * speed)
    if (home.length() > 90 && enemy.detourTimer <= 0) body.setVelocity(home.x * 0.5, home.y * 0.5)
    if (Math.abs(enemy.dirX) > 0.2) enemy.sprite.setFlipX(enemy.dirX < 0)
  }

  /**
   * Slimes and mushrooms: shuffle closer, then a telegraphed hop at where
   * you stood when the windup ended. Step aside (or roll) and it lands short.
   */
  private updateHopper(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const t = ENEMY_TUNING.wisp
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.attackTimer -= dt
    enemy.stateTimer -= dt
    switch (enemy.state) {
      case 'chase': {
        if (dist >= t.aggro) {
          this.wander(enemy, dt, 26)
          break
        }
        const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
        if (dist > t.hopRange * 0.7) body.setVelocity(dir.x * t.chase, dir.y * t.chase)
        else body.setVelocity(0, 0)
        if (Math.abs(dir.x) > 0.2) enemy.sprite.setFlipX(dir.x < 0)
        if (enemy.attackTimer <= 0 && dist < t.hopRange) {
          enemy.state = 'telegraph'
          enemy.stateTimer = t.windup
          enemy.lungeX = 0
          enemy.lungeY = 0
          body.setVelocity(0, 0)
          this.telegraph(enemy, t.windup)
        }
        break
      }
      case 'telegraph': {
        body.setVelocity(0, 0)
        this.lockAim(enemy, t.lock, t.hopSpeed, px, py)
        if (enemy.stateTimer <= 0) {
          // A shove can skip the lock frame; never launch without an aim.
          this.lockAim(enemy, Infinity, t.hopSpeed, px, py)
          enemy.state = 'lunge'
          enemy.stateTimer = t.hopTime
          enemy.sprite.clearTint()
          this.setEnemyPose(enemy, 'idle')
          if (!this.deps.reducedMotion) {
            this.scene.tweens.add({ targets: enemy.sprite, scaleY: enemy.sprite.scaleY * 1.25, scaleX: enemy.sprite.scaleX * 0.85, duration: t.hopTime * 500, yoyo: true })
          }
        }
        break
      }
      case 'lunge': {
        body.setVelocity(enemy.lungeX, enemy.lungeY)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'recover'
          enemy.stateTimer = t.recover
          body.setVelocity(0, 0)
          this.setEnemyPose(enemy, 'squash')
        }
        break
      }
      default: {
        // recover: squashed and open for a moment after landing.
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown * (0.8 + Math.random() * 0.5)
          this.setEnemyPose(enemy, 'idle')
        }
      }
    }
  }

  /**
   * Beetles: plod toward you, paw the ground, then charge in a straight line
   * locked at the end of the windup. A charge that hits a tree or wall leaves
   * the beetle dazed and taking extra damage.
   */
  private updateBeetle(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const t = ENEMY_TUNING.beetle
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.attackTimer -= dt
    enemy.stateTimer -= dt
    switch (enemy.state) {
      case 'chase': {
        if (dist >= t.aggro) {
          this.wander(enemy, dt, 18)
          break
        }
        const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
        // Keep a charging distance: approach from afar, back off up close.
        if (dist > t.keepAway + 16) body.setVelocity(dir.x * t.walk, dir.y * t.walk)
        else if (dist < t.keepAway - 16) body.setVelocity(-dir.x * t.walk * 0.7, -dir.y * t.walk * 0.7)
        else body.setVelocity(0, 0)
        if (Math.abs(dir.x) > 0.2) enemy.sprite.setFlipX(dir.x < 0)
        if (enemy.attackTimer <= 0 && dist < t.chargeRange) {
          enemy.state = 'telegraph'
          enemy.stateTimer = t.windup
          enemy.lungeX = 0
          enemy.lungeY = 0
          body.setVelocity(0, 0)
          this.telegraph(enemy, t.windup)
        }
        break
      }
      case 'telegraph': {
        body.setVelocity(0, 0)
        if (enemy.lungeX === 0 && enemy.lungeY === 0) {
          const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y)
          if (Math.abs(dir.x) > 4) enemy.sprite.setFlipX(dir.x < 0)
        }
        this.lockAim(enemy, t.lock, t.chargeSpeed, px, py)
        if (enemy.stateTimer <= 0) {
          this.lockAim(enemy, Infinity, t.chargeSpeed, px, py)
          enemy.state = 'lunge'
          enemy.stateTimer = t.chargeTime
          enemy.sprite.clearTint()
          this.setEnemyPose(enemy, 'squash')
          sfx('swing')
        }
        break
      }
      case 'lunge': {
        body.setVelocity(enemy.lungeX, enemy.lungeY)
        const crashed = body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down
        if (crashed) {
          enemy.state = 'stunned'
          enemy.stateTimer = t.stun
          body.setVelocity(0, 0)
          this.setEnemyPose(enemy, 'hurt')
          sfx('hit')
          if (!this.deps.reducedMotion) this.scene.cameras.main.shake(90, 0.004)
          this.deps.fx.floatText(enemy.sprite.x, enemy.sprite.y - 18, 'Dazed!', '#ffe08a', false)
          this.deps.fx.sparkBurst(enemy.sprite.x, enemy.sprite.y - 8, 6)
        } else if (enemy.stateTimer <= 0) {
          enemy.state = 'recover'
          enemy.stateTimer = t.recover
          body.setVelocity(0, 0)
          this.setEnemyPose(enemy, 'idle')
        }
        break
      }
      case 'stunned': {
        body.setVelocity(0, 0)
        if (!this.deps.reducedMotion) enemy.sprite.setAngle(Math.sin(enemy.stateTimer * 30) * 6)
        if (enemy.stateTimer <= 0) {
          enemy.sprite.setAngle(0)
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown
          this.setEnemyPose(enemy, 'idle')
        }
        break
      }
      default: {
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown * (0.8 + Math.random() * 0.4)
        }
      }
    }
  }

  /**
   * The warden: walks at you, lunges from range (then stops, open, to find its
   * feet — the moment to show the rubbing), and sweeps its arms at anyone
   * crowding it (no opening after a sweep). Showings slow it down.
   */
  private updateGuardian(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.attackTimer -= dt
    enemy.stateTimer -= dt
    enemy.hurtTimer = Math.max(0, enemy.hurtTimer - dt)
    const tune = ENEMY_TUNING.guardian
    switch (enemy.state) {
      case 'chase': {
        if (dist > WARDEN.homesick) {
          // Nobody to hold back: it walks home to its post, and its pose.
          const home = new Phaser.Math.Vector2(enemy.homeX - enemy.sprite.x, enemy.homeY - enemy.sprite.y)
          if (home.length() > 4) {
            home.normalize()
            body.setVelocity(home.x * 30, home.y * 30)
            if (Math.abs(home.x) > 0.2) enemy.sprite.setFlipX(home.x < 0)
          } else {
            body.setVelocity(0, 0)
          }
        } else if (dist > WARDEN.holdAt) {
          // It closes to arm's-length-and-a-lunge and holds the path there.
          const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
          body.setVelocity(dir.x * 50, dir.y * 50)
          enemy.sprite.setFlipX(dir.x < 0)
        } else {
          body.setVelocity(0, 0)
          if (Math.abs(px - enemy.sprite.x) > 4) enemy.sprite.setFlipX(px < enemy.sprite.x)
        }
        if (enemy.attackTimer <= 0 && dist < 150) {
          enemy.attack = dist < WARDEN.sweepRange ? 'sweep' : 'lunge'
          enemy.state = 'telegraph'
          enemy.lungeX = 0
          enemy.lungeY = 0
          enemy.stateTimer = enemy.attack === 'sweep' ? WARDEN.sweepWindup : tune.telegraph
          body.setVelocity(0, 0)
          this.telegraph(enemy, enemy.stateTimer)
          enemy.sprite.setTint(enemy.attack === 'sweep' ? 0xffd0c0 : 0xd0e8ff)
        }
        break
      }
      case 'telegraph': {
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.sprite.clearTint()
          if (enemy.attack === 'sweep') {
            enemy.state = 'sweep'
            enemy.stateTimer = WARDEN.sweepTime
            if (Math.abs(px - enemy.sprite.x) > 2) enemy.sprite.setFlipX(px < enemy.sprite.x)
            sfx('swing')
            this.sweepArc(enemy)
            break
          }
          const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
          enemy.lungeX = dir.x * tune.lungeSpeed
          enemy.lungeY = dir.y * tune.lungeSpeed
          enemy.state = 'lunge'
          enemy.stateTimer = 0.34
          if (dir.x !== 0) enemy.sprite.setFlipX(dir.x < 0)
        }
        break
      }
      case 'lunge': {
        body.setVelocity(enemy.lungeX, enemy.lungeY)
        if (enemy.stateTimer <= 0) {
          // Overreached: it stops to find its feet, and stands open.
          enemy.state = 'recover'
          enemy.opening = true
          enemy.stateTimer = WARDEN.opening
          body.setVelocity(0, 0)
        }
        break
      }
      case 'sweep': {
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'recover'
          enemy.opening = false
          enemy.stateTimer = WARDEN.sweepRecover
        }
        break
      }
      case 'recover': {
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          const swept = !enemy.opening && enemy.attack === 'sweep'
          enemy.state = 'chase'
          enemy.opening = false
          const calm = enemy.showings * WARDEN.calmPerShowing
          enemy.attackTimer = (swept ? WARDEN.sweepCooldown : tune.cooldown) + calm
          enemy.attack = 'lunge'
        }
        break
      }
    }
    // Pose is selected ONCE, after the state update, so the hurt pose is
    // never stomped by per-frame state writes and the lunge pose survives
    // until the state actually changes.
    this.applyGuardianPose(enemy)
  }

  /**
   * Single guardian pose selector: hurt wins while its timer is running, then
   * the pose of the current state-machine state. setTexture fires only on
   * change, so the 24x24 texture, the (0.5, 1) foot anchor, and the authored
   * foot body stay stable across pose switches. A settled warden is skipped —
   * settleWarden owns its resting pose from then on.
   */
  private applyGuardianPose(enemy: Enemy): void {
    if (enemy.dead || !enemy.sprite.active) return
    const pose = enemy.hurtTimer > 0
      ? this.guardianPoseTexture('hurt', 'guardian0')
      : this.guardianStateTexture(enemy)
    if (enemy.sprite.texture.key !== pose) enemy.sprite.setTexture(pose)
  }

  /**
   * Delivered guardian pose textures (idle/windup/lunge/hurt/defeat), falling
   * back to the procedural placeholders when the runtime pass is absent.
   * Poses are discrete states selected by the combat state machine — never
   * one looping animation. Source art faces right; flipX mirrors it. All
   * frames share the 24x24 texture and (0.5, 1) foot anchor, so switching
   * poses keeps the body and baseline stable.
   */
  private guardianPoseTexture(pose: 'idle' | 'windup' | 'lunge' | 'hurt' | 'defeat', fallback: string): string {
    const key = `guardian-${pose}`
    return this.scene.textures.exists(key) ? key : fallback
  }

  /** The pose matching the guardian's current state-machine state. */
  private guardianStateTexture(enemy: Enemy): string {
    if (enemy.state === 'telegraph') return this.guardianPoseTexture('windup', 'guardian1')
    if (enemy.state === 'lunge') return this.guardianPoseTexture('lunge', 'guardian1')
    if (enemy.state === 'sweep') return this.guardianPoseTexture('hurt', 'guardian1')
    return this.guardianPoseTexture('idle', 'guardian0')
  }

  /** The arm sweep's reach, drawn as a quick fading ring. */
  private sweepArc(enemy: Enemy): void {
    const g = this.scene.add.graphics().setDepth(enemy.sprite.depth + 2)
    g.lineStyle(2, 0xffe2b0, 0.8)
    g.strokeCircle(enemy.sprite.x, enemy.sprite.y - 6, WARDEN.sweepReach)
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 260, onComplete: () => g.destroy() })
  }
}
