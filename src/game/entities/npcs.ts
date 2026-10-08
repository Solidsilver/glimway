/**
 * Area NPCs (Mara, Orrin, Pip, and the residents Elara, Finn, Hazel and
 * Ada). The playtest-1 walking art (../people.ts) when it loaded: each
 * breathes facing one of four ways, faces you when you're close, walks the
 * way it goes, and sits on a bench in its sit pose; some keep a small
 * routine (../npc-routines.ts). Otherwise the earlier breathing art, or the
 * restrained placeholder bob. Positions come from WorldData. A resident on
 * a cycle (../resident-cycle.ts) stands at a spot only while the cycle puts
 * them there: absent, they're hidden; at a change they walk a short path
 * (`walkPath`) and fade.
 */
import type Phaser from 'phaser'
import { tileBottom, tileMid } from '../../lib/tile'
import { commonsAnim, commonsArt } from '../commons-pass'
import { isResident, residentName, RESIDENT_IDS } from '../../content/residents'
import type { InteractId, WorldData } from '../worlds'
import { PEOPLE_KEY, hasPerson, peopleDensity, personAnim, sitFrame } from '../people'
import type { PersonId } from '../atlas-plan'
import { NPC_SPEED, ROUTINES, atHome, newWalker, tickWalker, type Walker } from '../npc-routines'
import { prefersReducedMotion } from '../sfx'
import { expose } from '../dev-hooks'

export const NPC_NAMES: Record<string, string> = {
  mara: 'Mara',
  orrin: 'Orrin',
  pip: 'Pip',
  ...Object.fromEntries(RESIDENT_IDS.map((id) => [id, residentName(id)]))
}

/**
 * The residents' art comes with the Commons pass (`commons-art:<id>-…`);
 * if it didn't load, they borrow a quest NPC's placeholder, tinted.
 */
const RESIDENT_FALLBACK: Record<string, { key: string; tint: number }> = {
  elara: { key: 'mara', tint: 0xb8d0a8 },
  finn: { key: 'orrin', tint: 0xe8d8b0 },
  hazel: { key: 'mara', tint: 0xf0c0a0 },
  ada: { key: 'orrin', tint: 0xd0b8c8 }
}

/** The breathing animation and first idle frame for an NPC, when delivered. */
function idleArt(scene: Phaser.Scene, id: string): { anim: string; texture: string } | null {
  if (isResident(id)) {
    const anim = commonsAnim(scene, `${id}-breathing`)
    const texture = commonsArt(scene, `${id}-idle-0`)
    return anim && texture ? { anim, texture } : null
  }
  const anim = `${id}-breathing`
  return scene.anims.exists(anim) && scene.textures.exists(`${id}-idle-0`) ? { anim, texture: `${id}-idle-0` } : null
}

export interface NpcEntity {
  id: Exclude<InteractId, 'clue' | 'lantern'>
  sprite: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite
  /** The walking art: where they stand, which way, what they're doing. */
  walker?: Walker
  home?: { x: number; y: number }
  /** A resident's cycle spot here (null: always here). */
  spot: string | null
  /** Here now (a resident whose cycle is elsewhere is hidden, and can't be talked to). */
  present: boolean
  /** Walking a scripted path (the cycle's walk to a door, or in from it): points left, then what to do. */
  path?: { points: { x: number; y: number }[]; done: () => void; speed: number }
}

export class Npcs {
  readonly npcs: NpcEntity[] = []
  private readonly still = prefersReducedMotion()

  constructor(scene: Phaser.Scene, private world: WorldData) {
    const k = peopleDensity(scene)
    // Read-only, for playtests: the walking residents' poses.
    expose('__fsNpcs', () => this.view(), scene)
    for (const n of world.npcs) {
      const x = tileMid(n.tx)
      const y = tileBottom(n.ty)
      if (k && hasPerson(scene, n.id)) {
        // The walking art: feet at the canvas's bottom centre, drawn at world size.
        const sprite = scene.add.sprite(x, y, PEOPLE_KEY, `resident-${n.id}-down-idle-0`).setOrigin(0.5, 1).setScale(1 / k).setDepth(y)
        sprite.play(personAnim(n.id, 'down', false))
        this.npcs.push({ id: n.id, sprite, walker: newWalker({ x, y }), home: { x, y }, spot: n.spot ?? null, present: true })
        continue
      }
      // Delivered breathing art: two poses at 1.5 fps on a foot-anchored
      // sprite. The old bob tween is intentionally gone — the runtime-pass
      // README warns never to stack a bob on top of breathing (stable feet).
      const art = idleArt(scene, n.id)
      if (art) {
        const sprite = scene.add.sprite(x, y, art.texture)
          .setOrigin(0.5, 1)
          .setDepth(y)
        sprite.play(art.anim)
        this.npcs.push({ id: n.id, sprite, spot: n.spot ?? null, present: true })
      } else {
        // Fallback placeholder: static image with the old restrained bob.
        const fallback = RESIDENT_FALLBACK[n.id]
        const sprite = scene.add.image(x, y, fallback?.key ?? n.id)
          .setOrigin(0.5, 1)
          .setDepth(y)
        if (fallback) sprite.setTint(fallback.tint)
        this.npcs.push({ id: n.id, sprite, spot: n.spot ?? null, present: true })
        scene.tweens.add({
          targets: sprite,
          y: '-=1.5',
          duration: 900 + Math.random() * 400,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        })
      }
    }
  }

  /**
   * Each frame: routines step on (not while a conversation or panel holds
   * the world, nor with reduced motion), and the sprites follow their
   * walkers' pose.
   */
  update(dt: number, hero: { x: number; y: number }, held: boolean): void {
    const routines = ROUTINES[this.world.areaId] ?? {}
    for (const n of this.npcs) {
      if (n.path) {
        this.stepPath(n, Math.min(dt, 0.1))
        continue
      }
      const w = n.walker
      if (!w || !n.home || !n.present) continue
      tickWalker(w, this.still ? undefined : routines[n.id], n.home, hero, Math.min(dt, 0.1), held)
      const sprite = n.sprite as Phaser.GameObjects.Sprite
      sprite.setPosition(w.x, w.y)
      const id = n.id as PersonId
      if (w.mode === 'sit') {
        if (sprite.frame.name !== sitFrame(id)) sprite.stop().setFrame(sitFrame(id))
      } else {
        const anim = personAnim(id, w.facing, w.mode === 'walk')
        if (sprite.anims.currentAnim?.key !== anim || !sprite.anims.isPlaying) sprite.play(anim, true)
      }
    }
  }

  /** Away from their spot (their "…" marker waits there for them). */
  away(id: string): boolean {
    const n = this.npcs.find((x) => x.id === id)
    return !!n && (!!n.path || (!!n.walker && !!n.home && !atHome(n.walker, n.home)))
  }

  /** Not here at all (a resident whose cycle is elsewhere): no talking, no marker. */
  gone(id: string): boolean {
    const n = this.npcs.find((x) => x.id === id)
    return !!n && !n.present
  }

  /** Show or hide a resident at their spot, at once (no walk: the cycle says where they simply are). */
  place(n: NpcEntity, present: boolean): void {
    n.present = present
    n.path = undefined
    n.sprite.setVisible(present).setAlpha(1)
    if (n.home) n.sprite.setPosition(n.home.x, n.home.y)
    if (n.walker && n.home) Object.assign(n.walker, newWalker(n.home))
  }

  /**
   * Walk a resident along `points` at the residents' pace (or `speed`, px a second), then `done`
   * (drawing only: where they are is the cycle's). Without the walking
   * art they glide.
   */
  walkPath(n: NpcEntity, points: { x: number; y: number }[], done: () => void, speed = NPC_SPEED): void {
    n.sprite.setVisible(true)
    n.path = { points: [...points], done, speed }
  }

  private stepPath(n: NpcEntity, dt: number): void {
    const path = n.path!
    const target = path.points[0]
    const sprite = n.sprite as Phaser.GameObjects.Sprite
    if (!target) {
      n.path = undefined
      if (n.walker) n.walker.mode = 'stand'
      path.done()
      return
    }
    const dx = target.x - sprite.x
    const dy = target.y - sprite.y
    const d = Math.hypot(dx, dy)
    const step = path.speed * dt
    const x = d <= step ? target.x : sprite.x + (dx / d) * step
    const y = d <= step ? target.y : sprite.y + (dy / d) * step
    if (d <= step) path.points.shift()
    sprite.setPosition(x, y)
    const w = n.walker
    if (!w) return
    w.x = x
    w.y = y
    w.mode = 'walk'
    if (d > 0.01) w.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down'
    const anim = personAnim(n.id as PersonId, w.facing, true)
    if (sprite.anims && sprite.anims.currentAnim?.key !== anim) sprite.play(anim, true)
  }

  /** What the playtests read: each walking resident's pose. */
  view(): { id: string; x: number; y: number; facing: string; mode: string; frame: string; present: boolean; spot: string | null; walking: boolean }[] {
    return this.npcs.filter((n) => n.walker).map((n) => ({ id: n.id, x: n.walker!.x, y: n.walker!.y, facing: n.walker!.facing, mode: n.walker!.mode, frame: String((n.sprite as Phaser.GameObjects.Sprite).frame.name), present: n.present, spot: n.spot, walking: !!n.path }))
  }

  /** Depth-by-y so NPCs sort against the hero, enemies and props (seated: just in front of the bench). */
  updateDepth(): void {
    for (const npc of this.npcs) {
      const seat = npc.walker?.seat
      npc.sprite.setDepth(seat ? seat.y - 1.5 : npc.sprite.y + 1)
    }
  }
}
