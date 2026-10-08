/**
 * The warden of Ashwatch Ruin: a stone guardian keeping the pose Wenna set
 * it ("the road is closed here"). It lunges and sweeps, stands open after a
 * lunge, and three spoken namings settle it; its heart-lamp gutters as it
 * calms. Between visits it rests at its post (dormant or settled), and it
 * rests a moment when someone nearby speaks the naming (witnessRest).
 */
import Phaser from 'phaser'
import { bus, EV } from '../events'
import { sfx } from '../sfx'
import { commonsArt } from '../commons-pass'
import { witnessCopy } from '../../content/witness'
import { tileBottom, tileMid } from '../../lib/tile'
import { wardenToRestore } from '../rollback'
import type { QuestStage } from '../../lib/state'
import type { Interactable } from './interactables'
import { ENEMY_TUNING, KNOCK, type Enemy, type EnemyDeps, type EnemySystem } from './enemies'

/**
 * What the hero says to the heart-lamp, one line per speaking: Wenna cut
 * "the road is closed here" into it; the new naming tells it the road is
 * held again. The last line settles it.
 */
const WARDEN_WORDS = ['the road is held again', 'two weaves, and the break mended', 'rest now: the road is kept'] as const

/**
 * The warden encounter. Lunges come from range and leave an opening (it stops
 * to find its feet); hugging it draws a quicker arm sweep with no opening.
 * The dance: bait a lunge, sidestep, close in, speak the naming.
 */
export const WARDEN = {
  /** Speakings of the naming before it settles. */
  speakings: 3,
  /** Seconds it stands open after a lunge (hero walks 110 px/s; a lunge runs ~85 px). */
  opening: 1.5,
  /** Hero-to-warden distance (px) at which the naming can be spoken. */
  speakReach: 36,
  /** Seconds it reels after a speaking before it walks again. */
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
  /** Each speaking slows its next attack a little: it is calming down. */
  calmPerSpeaking: 0.35
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
  speakings: number
  needed: number
  /** Resting for a moment for a naming someone else spoke nearby (witness). */
  witnessRest: boolean
}

export class WardenEncounter {
  private readonly scene: Phaser.Scene
  private readonly deps: EnemyDeps

  constructor(private readonly sys: EnemySystem) {
    this.scene = sys.scene
    this.deps = sys.deps
  }

  private guardianSpawned = false
  /** The warden at rest (before the clue it stands dormant; after, settled). */
  private restingWarden: Phaser.GameObjects.Image | null = null
  private restingState: 'dormant' | 'settled' | null = null
  /** The amber heart-lamp glowing in the warden's chest. */
  private heart: Phaser.GameObjects.Image | null = null
  /** The first clink of a blow off the warden explains itself once. */
  private clinkHinted = false
  /** Scene time (ms) until which the warden rests for someone else's naming. */
  private witnessUntil = 0

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
    this.sys.spawnEnemy('stone-warden', 'guardian', home.tx, home.ty)
    this.heart = this.makeHeart()
    if (announce) {
      bus.emit(EV.toast, { text: 'Stone grinds on stone. The warden turns from its post, arms out, the lamp in its chest burning.' })
      if (!this.deps.reducedMotion) this.scene.cameras.main.shake(260, 0.005)
    }
  }

  /**
   * The state the game shows changed. If it says the warden still waits
   * (its settling step was refused) while it rests settled here, it stands
   * again on its post.
   */
  reconcile(quest: QuestStage): void {
    if (!wardenToRestore(quest, this.restingState, !!this.activeWarden())) return
    this.clearRestingWarden()
    this.guardianSpawned = false
    this.spawnGuardian(false)
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
    // The delivered resting pose carries its heart-lamp lower and further forward.
    const [hx, hy] = settled ? (sprite.texture.key === commonsArt(this.scene, 'guardian-settled') ? [3, 9] : [2, 6]) : [1, 10]
    this.heart.setPosition(sprite.x + forward * hx, sprite.y - hy).setDepth(sprite.depth + 1)
  }

  /**
   * The warden at rest on its post: standing in its pose (dormant, before the
   * naming is copied) or settled, arms down and heart-lamp low. It isn't an
   * enemy either way: no AI, no contact, no bar.
   */
  placeRestingWarden(kind: 'dormant' | 'settled'): void {
    const home = this.wardenHome()
    if (!home) return
    const tex = kind === 'settled' ? this.settledTexture() : this.guardianPoseTexture('idle', 'guardian0')
    const sprite = this.scene.add.image(tileMid(home.tx), tileBottom(home.ty), tex).setOrigin(0.5, 1)
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

  /** The warden resting for someone else's naming right now. */
  witnessResting(): boolean {
    return this.witnessUntil > this.scene.time.now
  }

  /**
   * Someone standing near spoke the naming in their own story (witness,
   * src/content/witness.ts): the warden here rests in its pose for a moment,
   * then the stone remembers its pose and waits again for yours. Nothing is
   * saved and your quest doesn't move. False when there is nothing to show:
   * no warden here, or yours already rests.
   */
  witnessRest(ms: number, onRise?: () => void): boolean {
    if (this.restingState === 'settled') return false
    const active = this.activeWarden()
    const sprite = active?.sprite ?? (this.restingState === 'dormant' ? this.restingWarden : null)
    if (!sprite?.active) return false
    const already = this.witnessResting()
    this.witnessUntil = this.scene.time.now + ms
    if (active) {
      ;(active.sprite.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0)
      active.opening = false
    }
    if (!already) {
      sprite.setTexture(this.settledTexture())
      this.placeHeart(sprite, true)
      this.gutterHeart(false)
    }
    this.scene.time.delayedCall(ms, () => {
      if (this.witnessResting()) return // a later naming nearby kept it resting
      this.witnessRise()
      onRise?.()
    })
    return true
  }

  /** The rest ends: arms up again, the heart-lamp burning, the pose remembered. */
  private witnessRise(): void {
    this.witnessUntil = 0
    if (this.restingState === 'settled') return
    const active = this.activeWarden()
    const sprite = active?.sprite ?? (this.restingState === 'dormant' ? this.restingWarden : null)
    if (!sprite?.active) return
    if (active) {
      active.state = 'chase'
      active.stateTimer = 0
      this.applyGuardianPose(active)
    } else {
      sprite.setTexture(this.guardianPoseTexture('idle', 'guardian0'))
    }
    if (this.heart) {
      this.scene.tweens.killTweensOf(this.heart)
      this.heart.setAlpha(0.6).setScale(0.16)
    }
    this.placeHeart(sprite, false)
    this.deps.fx.floatText(sprite.x, sprite.y - 28, witnessCopy.wardenFloat, '#ffd27a', false)
  }

  /** The live warden, if it is up and unsettled in this area. */
  private activeWarden(): Enemy | undefined {
    return this.sys.enemies.find((e) => e.type === 'guardian' && !e.dead)
  }

  /**
   * Where to show the "Speak the naming" prompt, or null: only while the
   * warden stands open after a lunge and the hero is within reach.
   */
  /**
   * Speaking the naming, as an interaction point that follows the warden:
   * offered while it stands open after a lunge, and it outranks anything
   * nearer (the fight is why you're here).
   */
  speakPoint(): Interactable {
    const at = () => this.activeWarden()?.sprite
    return {
      id: 'warden',
      get x() {
        return at()?.x ?? -1e6
      },
      // The hero's feet to the warden's middle (the heart-lamp's height).
      get y() {
        return (at()?.y ?? -1e6) + 2
      },
      reach: WARDEN.speakReach,
      clickReach: WARDEN.speakReach,
      rank: 1,
      markerOffset: 38,
      label: 'Speak the naming',
      verb: 'Speak',
      available: () => this.speakTarget() !== null,
      activate: () => void this.speakNaming()
    }
  }

  speakTarget(): { x: number; y: number } | null {
    const w = this.activeWarden()
    if (!w || w.state !== 'recover' || !w.opening || w.knockTimer > 0 || this.witnessResting()) return null
    const hero = this.deps.hero().sprite
    const dist = Math.hypot(hero.x - w.sprite.x, hero.y - 8 - (w.sprite.y - 6))
    return dist < WARDEN.speakReach ? { x: w.sprite.x, y: w.sprite.y - 36 } : null
  }

  /**
   * Speak the naming to the heart-lamp. Returns true when it was spoken (the
   * interact press is used up). `force` skips the opening and reach checks
   * (dev playtest lever only).
   */
  speakNaming(force = false): boolean {
    const w = this.activeWarden()
    if (!w) return false
    if (!force && !this.speakTarget()) return false
    w.speakings += 1
    w.opening = false
    const hero = this.deps.hero()
    // The hero speaks the naming: the words float up toward the lamp.
    const words = WARDEN_WORDS[Math.min(w.speakings, WARDEN_WORDS.length) - 1]
    this.deps.fx.floatText(hero.sprite.x, hero.sprite.y - 22, words, '#fff3c4', false)
    if (w.speakings >= WARDEN.speakings) {
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
    this.deps.fx.floatText(w.sprite.x, w.sprite.y - 28, 'the flame listens', '#ffd27a', false)
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
    this.sys.forget(w)
    const body = w.sprite.body as Phaser.Physics.Arcade.Body
    body.setVelocity(0, 0)
    body.enable = false
    w.sprite.clearTint()
    sfx('settle')
    this.deps.fx.floatText(w.sprite.x, w.sprite.y - 28, 'it rests', '#ffd27a', true)
    // Arms lower (the crouch), then down into its resting heap.
    w.sprite.setTexture(this.guardianPoseTexture('windup', 'guardian1'))
    this.scene.time.delayedCall(this.deps.reducedMotion ? 0 : 420, () => {
      if (!w.sprite.active) return
      w.sprite.setTexture(this.settledTexture())
      this.placeHeart(w.sprite, true)
    })
    this.placeHeart(w.sprite, true)
    this.gutterHeart(false)
    this.restingWarden = w.sprite
    this.restingState = 'settled'
    // The quest event, then the defeated-enemy entry. In this order: each
    // queues a predicted operation, and a refresh that saw the defeat before
    // the step would read a settled warden at 'clue-found' as a refused
    // settling and stand it up again (reconcile).
    this.deps.session.applyQuestEvent('defeat-guardian')
    this.deps.session.recordDefeat(w.id)
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
      speakings: w?.speakings ?? (this.restingState === 'settled' ? WARDEN.speakings : 0),
      needed: WARDEN.speakings,
      witnessRest: this.witnessResting()
    }
  }

  /**
   * A blow (or bolt) on the warden: it rings off the stone and changes
   * nothing but a small rock on its feet. The first one says why.
   */
  clinkWarden(enemy: Enemy, fromX: number): void {
    this.deps.fx.floatText(enemy.sprite.x, enemy.sprite.y - 26, 'clink', '#c9c2d6', false)
    sfx('clink')
    this.sys.knockEnemy(enemy, fromX)
    if (!this.clinkHinted) {
      this.clinkHinted = true
      bus.emit(EV.toast, { text: 'Your blow rings off the stone. It isn\u2019t fighting you; it\u2019s keeping a pose. Speak it the naming.' })
    }
  }

  /** The heart-lamp follows the warden and flares while it stands open. */
  updateHeart(w: Enemy): void {
    if (!this.heart) return
    this.placeHeart(w.sprite, false)
    if (this.scene.tweens.isTweening(this.heart)) return
    const open = w.state === 'recover' && w.opening
    const t = this.scene.time.now
    const pulse = this.deps.reducedMotion ? 0 : Math.sin(t * (open ? 0.018 : 0.006))
    this.heart.setAlpha(open ? 0.85 + pulse * 0.12 : 0.55 + pulse * 0.08).setScale(open ? 0.2 : 0.16)
  }

  /**
   * The warden has no health to lose. Instead: one pip per speaking still
   * needed, lit amber as each speaking lands — how close it is to settling.
   */
  drawWardenPips(bars: Phaser.GameObjects.Graphics, w: Enemy): void {
    const n = WARDEN.speakings
    const gap = 7
    const x0 = Math.round(w.sprite.x - ((n - 1) * gap) / 2)
    const y = Math.round(w.sprite.y - 30)
    for (let i = 0; i < n; i++) {
      const x = x0 + i * gap
      bars.fillStyle(0x2b1d1a, 0.9)
      bars.fillRect(x - 3, y - 3, 6, 6)
      bars.fillStyle(i < w.speakings ? 0xffc86a : 0x5a4a52, 1)
      bars.fillRect(x - 2, y - 2, 4, 4)
      if (i < w.speakings) {
        bars.fillStyle(0xffffff, 0.45)
        bars.fillRect(x - 2, y - 2, 4, 1)
      }
    }
  }

  /**
   * The warden: walks at you, lunges from range (then stops, open, to find its
   * feet — the moment to speak the naming), and sweeps its arms at anyone
   * crowding it (no opening after a sweep). Each speaking of the naming
   * calms its attacks (WARDEN.calmPerSpeaking).
   */
  updateGuardian(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
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
          this.sys.telegraph(enemy, enemy.stateTimer)
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
          const calm = enemy.speakings * WARDEN.calmPerSpeaking
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
  /**
   * The warden at rest after the naming: the delivered seated pose (Commons
   * pass), else the runtime pass's collapsed defeat frame.
   */
  private settledTexture(): string {
    return commonsArt(this.scene, 'guardian-settled') ?? this.guardianPoseTexture('defeat', 'guardian0')
  }

  guardianPoseTexture(pose: 'idle' | 'windup' | 'lunge' | 'hurt' | 'defeat', fallback: string): string {
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
