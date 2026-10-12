/**
 * Enemies: wisps (telegraphed hops), beetles (telegraphed straight-line
 * charges that end dazed against walls), and the stone warden (quest-driven
 * encounter). Every real attack is telegraphed; bumping into an enemy that
 * isn't attacking only stings. Includes knockback, poses, and the floating
 * HP bars.
 *
 * Every enemy has an owner (EnemyOwner, below): who runs its behaviour and
 * decides what a hit did. This screen owns all of them today, on Phaser
 * bodies. The rest of the game reads an enemy as its state (./fight-rules.ts
 * EnemyState: `x`, `y`, `hp`, `dead`), never its sprite, so an enemy the
 * server runs (docs/design/shared-fights.md 1.8) reads the same. A hit's
 * feedback shows at once whoever owns it (damageEnemy).
 *
 * The warden is not fought down. It is a lamp in a stone coat, homesick for
 * one pose: blows only clink off it. After each lunge it stops to find its
 * feet, and a hero within reach can speak the naming to its heart-lamp —
 * Wenna's closure naming turned around: the road is held again, rest. Each
 * speaking makes it falter; after WARDEN.speakings it settles into its pose and
 * stays there (the quest event is still 'defeat-guardian', for saves).
 */
import Phaser from 'phaser'
import { ServerEnemies } from './server-enemies'
import { FIGHT_OPTIONS } from '../../lib/fight-options'
import type { FightTargetRef } from '../../lib/presence'
import type { GameState } from '../../lib/state'
import { sfx } from '../sfx'
import type { Session } from '../session'
import { tileBottom, tileMid } from '../../lib/tile'
import type { EnemyType, WorldData } from '../worlds'
import type { Effects } from './fx'

import { WARDEN, WardenEncounter } from './warden'
import { curatedToRestore } from '../rollback'
import { Creatures } from './creatures'
import { roadStep } from '../../lib/quests'
import type { CombatField } from '../../lib/combat-moves'
import { ENEMY_TUNING, KNOCK, contactThreat, hitOutcome, knockFrom, knockInterrupts, touchOutcome, type EnemyPhase, type EnemyState } from './fight-rules'

/** An enemy on this screen: its state, the sprite that draws it (a local enemy's body too), and its owner's working. */
export interface Enemy extends EnemyState {
  sprite: Phaser.Physics.Arcade.Sprite
  fight?: FightTargetRef
  /** Who runs it and decides its hits. */
  owner: EnemyOwner
  hp: number
  homeX: number
  homeY: number
  dirX: number
  dirY: number
  wanderTimer: number
  attackTimer: number
  state: EnemyPhase
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
  /** Dev only: set aside off the map and frozen (playtests that need a quiet chunk). */
  parked?: boolean
  /** Warden only: which attack the current telegraph leads into. */
  attack: 'lunge' | 'sweep'
  /** Warden only: recovering after a lunge, so the naming can be spoken. */
  opening: boolean
  /** Warden only: how many times the naming has been spoken to it. */
  speakings: number
}

/** Where the hero stands and what the creatures aim at, measured for one enemy this frame. */
export interface EnemySight {
  /** From the enemy's middle to the hero's, and to what it aims at (an Echo's copy, else the hero). */
  dist: number
  aimDist: number
  px: number
  py: number
  aim: { x: number; y: number }
  field: CombatField | undefined
}

/**
 * Who owns an enemy's fight (shared-fights.md 1.3, 1.4; game F7). This
 * screen owns the curated fights (the woodland's, the Warden) and every camp
 * until the server runs them: behaviour on Phaser bodies, hits decided at
 * once. A server camp's owner draws the room's snapshots and waits for the
 * server's word on a hit; death plays on its event.
 */
export interface EnemyOwner {
  /** Every frame, even while this player's play is held (a menu open): what the world shows of it. */
  observe(enemy: Enemy, dt: number): void
  /** A frame of this player's play: its behaviour. */
  act(enemy: Enemy, dt: number, sight: EnemySight): void
  /** Stand contact: the owner decides a stagger, or predicts only its pose. */
  stopped(enemy: Enemy, seconds: number): void
  /** A hit seen to land here, its feedback already shown: shove it and decide what it did. */
  struck(enemy: Enemy, hit: { amount: number; crit: boolean }, fromX: number): void
}

/** What the enemy AI needs from the hero (implemented by Hero). */
export interface HeroView {
  readonly sprite: Phaser.Physics.Arcade.Sprite
  readonly facing: Phaser.Math.Vector2
  damagePlayer(amount: number, fromX: number, fromY?: number): void
  /** The level-20 moves' effects on a fight (crafts.md 4.3): Stand, Kindle's patches, Echo's decoy. */
  readonly field?: CombatField
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
  /** The ruin's warden (./warden.ts) and the creatures' behaviour (./creatures.ts). */
  readonly warden: WardenEncounter
  readonly creatures: Creatures
  /** This screen as an owner: every enemy today (see EnemyOwner). */
  private server: ServerEnemies | null = null
  private readonly local: EnemyOwner = {
    stopped: (enemy, seconds) => this.stagger(enemy, seconds),
    // Held play holds a local enemy still: its behaviour is all in act.
    observe: () => {},
    act: (enemy, dt, sight) => this.actLocally(enemy, dt, sight),
    struck: (enemy, hit, fromX) => {
      this.knockEnemy(enemy, fromX)
      enemy.hp -= hit.amount
      if (enemy.hp <= 0) this.killEnemy(enemy)
    }
  }
  private _enemies: Enemy[] = []
  private hpBars!: Phaser.GameObjects.Graphics

  constructor(
    readonly scene: Phaser.Scene,
    readonly deps: EnemyDeps,
    state: GameState
  ) {
    this.warden = new WardenEncounter(this)
    this.creatures = new Creatures(this)
    const { world } = deps
    for (const spot of world.enemies) {
      if (spot.type === 'guardian') continue // guardian is quest-driven
      if (state.defeatedEnemies.includes(spot.id)) continue
      this.spawnEnemy(spot.id, spot.type, spot.tx, spot.ty, spot.hp)
    }
    if (world.areaId === 'ruin' && world.shrine) {
      // The warden is always on its path: standing in its pose before you
      // carry the mark, awake while you do, resting in its pose afterwards.
      if (roadStep(state) === 'clue-found') this.warden.spawnGuardian(false)
      else this.warden.placeRestingWarden(roadStep(state) === 'new' || roadStep(state) === 'accepted' ? 'dormant' : 'settled')
    }
    this.hpBars = scene.add.graphics().setDepth(5000)
    if (world.areaId === 'wilds' && FIGHT_OPTIONS.enabled) this.server = new ServerEnemies(this)
  }

  get enemies(): Enemy[] {
    return this._enemies
  }

  /**
   * Connected: the state the game shows changed. A curated defeat the world
   * refused brings its enemy back to its spot, and a refused settling stands
   * the warden up again; enemies still fighting are left alone.
   */
  reconcile(state: GameState): void {
    const standing = new Set(this._enemies.filter((e) => !e.dead).map((e) => e.id))
    for (const spot of curatedToRestore(this.deps.world.enemies, state.defeatedEnemies, standing)) this.spawnEnemy(spot.id, spot.type, spot.tx, spot.ty, spot.hp)
    if (this.deps.world.areaId === 'ruin' && this.deps.world.shrine) this.warden.reconcile(roadStep(state), state.defeatedEnemies.includes('stone-warden'))
  }

  /** Take an enemy off the list (killed, or the warden settled). */
  forget(enemy: Enemy): void {
    this._enemies = this._enemies.filter((e) => e !== enemy)
  }

  /**
   * Dev only: set every live creature aside, off the map and frozen, so a
   * playtest can work a chunk without a wisp wandering into the hero. Not
   * a defeat: nothing is claimed, and the next build of the area brings
   * them back.
   */
  parkAll(): number {
    let n = 0
    for (const e of this._enemies) {
      if (e.dead || e.parked || e.type === 'guardian') continue
      e.parked = true
      e.sprite.setVelocity(0, 0).setPosition(-2000, -2000).setVisible(false)
      ;(e.sprite.body as Phaser.Physics.Arcade.Body).enable = false
      n++
    }
    return n
  }

  /**
   * A hit landed on this screen (a swing, a bolt, a signature). Its feedback
   * shows at once, whoever owns the enemy: the number, the sound, the
   * hit-stop and the flash. Its owner shoves it and decides what it did. A
   * blow on the warden only clinks.
   */
  damageEnemy(enemy: Enemy, amount: number, fromX: number, crit = false): void {
    const hit = hitOutcome(enemy, amount, crit)
    if (!hit) {
      this.warden.clinkWarden(enemy, fromX)
      return
    }
    this.deps.fx.floatText(enemy.x, enemy.y - 16, hit.crit ? `${Math.round(hit.amount)}!` : `${Math.round(hit.amount)}`, hit.crit ? '#ffd24a' : '#fffbef', hit.crit)
    sfx(hit.crit ? 'crit' : 'hit')
    this.deps.fx.hitStop(hit.crit ? 70 : 45)
    enemy.sprite.setTint(0xffe0d0)
    this.scene.time.delayedCall(90, () => {
      if (!enemy.dead && enemy.sprite.active) enemy.sprite.clearTint()
    })
    enemy.owner.struck(enemy, hit, fromX)
  }

  /** Every frame, play held or not: each enemy as its owner shows it (nothing moves for a local one). */
  observe(dt: number): void {
    this.server?.observe()
    for (const enemy of [...this._enemies]) if (!enemy.dead && !enemy.parked) enemy.owner.observe(enemy, dt)
  }

  /**
   * A frame of this player's play: each enemy's behaviour (its owner's), then
   * touching it, judged here. The level-20 moves (the hero's `field`) bend
   * it for the creatures, never the Warden: an Echo's copy is what they
   * chase and aim at, a Kindle patch slows them, and a lunge that would
   * reach a planted hero (Stand) stops short and staggers.
   */
  update(dt: number): void {
    const hero = this.deps.hero()
    const field = hero.field
    field?.tick(dt)
    const px = hero.sprite.x
    const py = hero.sprite.y - 8
    // Where the creatures aim (the hero, or an Echo's copy standing where they were).
    const aim = field?.decoy ? { x: field.decoy.x, y: field.decoy.y - 8 } : { x: px, y: py }
    for (const enemy of [...this.enemies]) {
      if (enemy.dead || enemy.parked) continue
      const ex = enemy.x
      const ey = enemy.y - 6
      const dist = Math.hypot(px - ex, py - ey)
      const aimDist = Math.hypot(aim.x - ex, aim.y - ey)
      if (enemy.type === 'guardian' && this.warden.witnessResting()) {
        // Resting for someone else's naming: no AI, no contact, until it remembers its pose.
        ;(enemy.sprite.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0)
        enemy.sprite.setDepth(enemy.sprite.y)
        continue
      }
      enemy.owner.act(enemy, dt, { dist, aimDist, px, py, aim, field })
      this.touch(enemy, hero, dist, ex)
      enemy.sprite.setDepth(enemy.sprite.y)
      if (enemy.type === 'guardian') this.warden.updateHeart(enemy)
    }
  }

  /** Touching an enemy, judged on this screen (./fight-rules.ts touchOutcome): a planted hero staggers a lunge, else it hurts. */
  private touch(enemy: Enemy, hero: HeroView, dist: number, fromX: number): void {
    const stand = hero.field?.stand
    const threat = contactThreat(enemy, { reach: WARDEN.sweepReach, damage: WARDEN.sweep })
    const touched = touchOutcome(enemy, threat, dist, !!stand)
    if (touched === 'stagger') enemy.owner.stopped(enemy, stand!.stagger)
    else if (touched === 'hurt') hero.damagePlayer(threat.damage, fromX, enemy.y)
  }

  /** A local enemy's frame of play: a shove in progress, else its kind's behaviour on its body. */
  private actLocally(enemy: Enemy, dt: number, { dist, aimDist, px, py, aim, field }: EnemySight): void {
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    if (enemy.knockTimer > 0) {
      // Shoved: physics owns the body for a beat, the AI waits.
      enemy.knockTimer -= dt
      body.setVelocity(enemy.knockX, enemy.knockY)
      // A shove through a Kindle patch is slowed like any other movement.
      this.creatures.slowIn(enemy, field)
      enemy.stateTimer -= dt
      if (enemy.knockTimer <= 0) {
        body.setVelocity(0, 0)
        if (enemy.type !== 'guardian' && enemy.state !== 'telegraph' && enemy.state !== 'stunned') this.setEnemyPose(enemy, 'idle')
      }
    } else if (enemy.type === 'wisp') {
      this.creatures.updateHopper(enemy, dt, aimDist, aim.x, aim.y)
      this.creatures.slowIn(enemy, field)
    } else if (enemy.type === 'beetle') {
      this.creatures.updateBeetle(enemy, dt, aimDist, aim.x, aim.y)
      this.creatures.slowIn(enemy, field)
    } else {
      this.warden.updateGuardian(enemy, dt, dist, px, py)
    }
  }

  /**
   * A lunge stopped short against a planted hero (Stand): beetles go into
   * their dazed state (which takes 1.5× damage), hoppers stand still,
   * squashed, for `seconds`.
   */
  stagger(enemy: Enemy, seconds: number): void {
    if (enemy.type === 'guardian') return
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    body.setVelocity(0, 0)
    enemy.lungeX = 0
    enemy.lungeY = 0
    enemy.sprite.clearTint()
    if (enemy.type === 'beetle') {
      enemy.state = 'stunned'
      this.setEnemyPose(enemy, 'hurt')
    } else {
      enemy.state = 'recover'
      this.setEnemyPose(enemy, 'squash')
    }
    enemy.stateTimer = seconds
    this.deps.fx.floatText(enemy.sprite.x, enemy.sprite.y - 18, 'Staggered', '#e8d8b0', false)
  }

  updateEnemyBars(): void {
    this.hpBars.clear()
    for (const enemy of this.enemies) {
      if (enemy.parked) continue
      if (enemy.type === 'guardian') {
        this.warden.drawWardenPips(this.hpBars, enemy)
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
   * A Wilds camp enemy, spawned by the region's entity layer (not WorldData).
   * Their deaths are the camp's own lifecycle — never recorded in
   * defeatedEnemies (camps respawn on their cycle, unlike curated enemies).
   */
  spawnWilds(id: string, type: EnemyType, tx: number, ty: number): Enemy {
    return this.spawnEnemy(id, type, tx, ty)
  }

  /** Replace the prototype's local copies when a server join advertises it. */
  removeLocalCamp(camp: string): void {
    for (const enemy of [...this._enemies]) if (!enemy.fight && enemy.id.startsWith(`wilds:${camp}:`)) {
      if (enemy.sprite.active) enemy.sprite.destroy()
      this.forget(enemy)
    }
  }

  /**
   * Camps are leashed to their chunk (open-map.md 2.5): when the open map's
   * window lets a chunk go, its camps' creatures go with it (they come back,
   * at full health, if the camp is still lived in when the chunk returns).
   */
  removeWilds(prefix: string): void {
    for (const e of this._enemies) if (!e.fight && e.id.startsWith(prefix) && e.sprite.active) e.sprite.destroy()
    this._enemies = this._enemies.filter((e) => !!e.fight || !e.id.startsWith(prefix))
  }

  /** `hp`: a curated spot's own health (the opening's finger-wisp), else the type's. */
  spawnEnemy(id: string, type: EnemyType, tx: number, ty: number, hp?: number): Enemy {
    // Woodland enemies use the delivered slime/mushroom art; the guardian
    // uses the delivered native 24x24 pose textures when present (procedural
    // placeholder otherwise). Every pose shares the same 24x24 texture size
    // and (0.5, 1) origin, so the intended world size and the authored
    // 20x10 foot body are identical across poses.
    const art = type === 'beetle' ? 'beetle' : id === 'wisp-c' ? 'mushroom' : 'slime'
    const frame = type === 'guardian' ? 'guardian0' : `${art}-idle`
    const texKey = type === 'guardian' ? this.warden.guardianPoseTexture('idle', 'guardian0') : 'fingersnap-enemies'
    const displayH = type === 'guardian' ? 24 : type === 'beetle' ? 13 : 14
    const sprite = this.scene.physics.add.sprite(tileMid(tx), tileBottom(ty), texKey, type === 'guardian' ? undefined : frame)
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
      owner: this.local,
      // A local enemy stands where its body does.
      get x() {
        return sprite.x
      },
      get y() {
        return sprite.y
      },
      hp: hp ?? ENEMY_TUNING[type].hp,
      maxHp: hp ?? ENEMY_TUNING[type].hp,
      homeX: tileMid(tx),
      homeY: tileBottom(ty),
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
      speakings: 0
    }
    // Enemies respect walls, trees and water: a charge can end in a tree.
    // They also stay on the map: an exit gap in the treeline is a way out
    // for the hero, never for a beetle mid-charge.
    this.scene.physics.add.collider(sprite, this.deps.solidGroup)
    ;(sprite.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true)
    this.enemies.push(enemy)
    return enemy
  }

  /** Down, decided here: a curated enemy is recorded defeated, then its death plays. */
  private killEnemy(enemy: Enemy): void {
    enemy.dead = true
    // Wilds camp enemies belong to their camp's respawn cycle, not to the
    // permanent defeated list (wilds:*, see src/game/wilds/entities.ts).
    if (!enemy.id.startsWith('wilds:')) this.deps.session.recordDefeat(enemy.id)
    this.showDeath(enemy)
  }

  /**
   * A death on screen, once it's decided (a server enemy's on the room's
   * death event, so nothing dies and comes back): a calm note, a burst of
   * sparks, the body dissolving, and the enemy off the list.
   */
  showDeath(enemy: Enemy): void {
    sfx('calm')
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
    this.forget(enemy)
  }

  /**
   * Shove an enemy away from the hit through physics (walls still apply).
   * Hopping slimes are knocked out of their hop; a charging beetle is too
   * heavy to stop, and the warden only rocks back between lunges.
   */
  knockEnemy(enemy: Enemy, fromX: number): void {
    const hero = this.deps.hero()
    const shove = knockFrom(enemy, fromX, { y: hero.sprite.y, facing: hero.facing })
    if (!shove) return
    enemy.knockX = shove.x
    enemy.knockY = shove.y
    enemy.knockTimer = KNOCK.time
    if (knockInterrupts(enemy)) {
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
  setEnemyPose(enemy: Enemy, pose: 'idle' | 'windup' | 'squash' | 'hurt'): void {
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
  lockAim(enemy: Enemy, lockAt: number, speed: number, px: number, py: number): boolean {
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
  telegraph(enemy: Enemy, seconds: number): void {
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

}
