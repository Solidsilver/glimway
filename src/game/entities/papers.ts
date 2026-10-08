/**
 * Papers in the world: the found-text pickups lying in an area (a folded
 * page, a tied scroll, a child's slate — code-drawn in the game's pixel
 * style, with a slow sparkle so attentive players notice), the Hearthwick
 * Library's door, and the papers NPCs hand over in conversation.
 *
 * Interactables asks this module for its interaction points and hands back
 * any interaction it owns, so WorldScene only constructs it.
 */
import type Phaser from 'phaser'
import { beatsDue, handoverFor, LOOK_LABEL, paperById, placedPapersIn, type PickupLook } from '../../content/papers'
import { bus, EV, type DialogueClosedPayload, type QuestPayload } from '../events'
import type { Session } from '../session'
import { tileBottom, tileMid } from '../../lib/tile'
import { commonsAnim } from '../commons-pass'
import type { WorldData } from '../worlds'
import type { Effects } from './fx'
import type { Interactable, Interactables } from './interactables'
import { emitPapers, grantPaper } from '../papers'
import { pickupChanges } from '../rollback'
import { itemsFor } from '../items'
import type { QuestStage } from '../../lib/state'

export interface PaperDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  interactables: Interactables
}

interface Pickup {
  paperId: string
  image: Phaser.GameObjects.Sprite
  twinkle: Phaser.GameObjects.Image
  timer: Phaser.Time.TimerEvent | null
}

const PAPER_PREFIX = 'paper:'

// ------------------------------------------------------------ art

/** The Commons pass draws the pickups and the library's sign (src/game/commons-pass-install.ts). */
const LOOK_TEXTURE: Record<PickupLook, string> = {
  folded: 'paper-folded',
  scroll: 'paper-scroll',
  slate: 'paper-slate'
}

// ------------------------------------------------------------ pickups

/** Papers glint brighter while a pocketed keepsake says so (worlds only). */
export function papersGlintBright(session: Session): boolean {
  return !!session.link && itemsFor(session).helps('papers-glint')
}

export class PaperPickups {
  private pickups = new Map<string, Pickup>()
  /** Paper an NPC is handing over in the open conversation (granted on close). */
  private pendingHandover: string | null = null

  constructor(private scene: Phaser.Scene, private deps: PaperDeps) {
    this.build()
    if (deps.world.library) {
      // The building carries its open book over the door: the hanging sign
      // stands out front, beside the step.
      const d = deps.world.library
      const y = tileBottom(d.ty) + 9
      scene.add.image(tileMid(d.tx) + 22, y, 'library-sign').setOrigin(0.5, 1).setDepth(y)
    }
    bus.on(EV.dialogueClosed, this.onDialogueClosed, this)
    bus.on(EV.quest, this.onQuest, this)
    bus.on(EV.worldRefresh, this.onWorldRefresh, this)
    scene.events.once('shutdown', () => {
      bus.off(EV.dialogueClosed, this.onDialogueClosed, this)
      bus.off(EV.quest, this.onQuest, this)
      bus.off(EV.worldRefresh, this.onWorldRefresh, this)
      for (const p of this.pickups.values()) p.timer?.remove()
      this.pickups.clear()
    })
    this.publish()
    emitPapers(deps.session)
    // Quest beats owed to a save that is already past them (older saves).
    this.grantBeats(deps.session.questStage, 0)
  }

  /**
   * Interaction points: the library door and every pickup lying here (they
   * sparkle instead of carrying a marker). A pickup is used up when taken.
   */
  private publish(): void {
    const points: Interactable[] = []
    const lib = this.deps.world.library
    if (lib) points.push({ id: 'library', x: tileMid(lib.tx), y: tileBottom(lib.ty), label: 'Enter the Hearthwick Library', markerOffset: 44, activate: () => void bus.emit(EV.libraryOpen) })
    for (const p of placedPapersIn(this.deps.world.areaId, this.deps.session.questStage, this.deps.session.state.flags)) {
      if (!this.pickups.has(p.id)) continue
      points.push({ id: `${PAPER_PREFIX}${p.id}`, x: tileMid(p.source.tx), y: tileBottom(p.source.ty) - 2, label: LOOK_LABEL[p.source.look], markerOffset: 12, activate: () => this.take(p.id) })
    }
    this.deps.interactables.register(this, points)
  }

  /** Pick up a paper lying here (true: its point is used up). */
  private take(paperId: string): boolean {
    const pickup = this.pickups.get(paperId)
    if (!grantPaper(this.deps.session, paperId)) {
      this.removePickup(paperId)
      return true
    }
    if (pickup) this.deps.fx.sparkBurst(pickup.image.x, pickup.image.y - 4, 8)
    this.removePickup(paperId)
    return true
  }

  /** Lines an NPC adds to this conversation when they have a paper for you. */
  handover(npc: string): string[] | null {
    const h = handoverFor(npc, this.deps.session.questStage, this.deps.session.state.flags)
    this.pendingHandover = h?.paperId ?? null
    return h?.lines ?? null
  }

  private build(): void {
    const { world, session } = this.deps
    for (const p of placedPapersIn(world.areaId, session.questStage, session.state.flags)) this.addPickup(p)
  }

  /** One paper lying here, drawn with its glint. */
  private addPickup(p: ReturnType<typeof placedPapersIn>[number]): void {
    const { session, reducedMotion } = this.deps
    const x = tileMid(p.source.tx)
    const y = tileBottom(p.source.ty) - 3
    const image = this.scene.add.sprite(x, y, LOOK_TEXTURE[p.source.look]).setOrigin(0.5, 1).setDepth(y - 6)
    // The delivered pickups glint on their own (Commons pass), out of step.
    const glinting = commonsAnim(this.scene, `${LOOK_TEXTURE[p.source.look]}-animation`)
    if (glinting && !reducedMotion) image.play({ key: glinting, startFrame: Math.floor(Math.random() * 3) })
    const twinkle = this.scene.add.image(x + 3, y - 8, 'spark').setDepth(y + 1).setBlendMode(1 /* ADD */)
    let timer: Phaser.Time.TimerEvent | null = null
    if (reducedMotion) {
      twinkle.setAlpha(0.7)
    } else {
      twinkle.setAlpha(0).setScale(0.4)
      // A gentle glint every few seconds, staggered so pickups never pulse in step.
      const glint = () => {
        if (!twinkle.active) return
        // A keepsake in a pocket (Hollis's fox) makes papers glint brighter.
        const bright = papersGlintBright(session)
        twinkle.setPosition(x + Math.round((Math.random() - 0.5) * 8), y - 6 - Math.round(Math.random() * 5))
        this.scene.tweens.add({ targets: twinkle, alpha: { from: 0, to: 1 }, scale: { from: 0.4, to: bright ? 1.7 : 1.1 }, duration: bright ? 420 : 260, yoyo: true, ease: 'Sine.easeOut' })
      }
      timer = this.scene.time.addEvent({ delay: 2200 + Math.floor(Math.random() * 900), loop: true, startAt: Math.floor(Math.random() * 1800), callback: glint })
    }
    this.pickups.set(p.id, { paperId: p.id, image, twinkle, timer })
  }

  private removePickup(paperId: string): void {
    const p = this.pickups.get(paperId)
    if (!p) return
    p.timer?.remove()
    if (this.deps.reducedMotion) {
      p.image.destroy()
      p.twinkle.destroy()
    } else {
      this.scene.tweens.add({ targets: [p.image, p.twinkle], y: '-=6', alpha: 0, duration: 260, ease: 'Quad.easeOut', onComplete: () => { p.image.destroy(); p.twinkle.destroy() } })
    }
    this.pickups.delete(paperId)
  }

  private onDialogueClosed(_payload: DialogueClosedPayload): void {
    const id = this.pendingHandover
    this.pendingHandover = null
    if (id) grantPaper(this.deps.session, id)
  }

  private onQuest(p: QuestPayload): void {
    // Let the lantern beat finish before a page turns up on the ledge.
    this.grantBeats(p.stage as QuestStage, 2600)
  }

  private grantBeats(stage: QuestStage, delayMs: number): void {
    const due = beatsDue(stage, this.deps.session.state.flags)
    if (due.length === 0) return
    const grant = () => {
      for (const p of due) if (paperById(p.id)) grantPaper(this.deps.session, p.id)
    }
    if (delayMs <= 0) grant()
    else this.scene.time.delayedCall(delayMs, grant)
  }

  /**
   * Connected: another device may have picked something up, or the world
   * refused a take this one predicted, and the paper lies here again.
   */
  private onWorldRefresh(): void {
    const due = placedPapersIn(this.deps.world.areaId, this.deps.session.questStage, this.deps.session.state.flags)
    const { add, remove } = pickupChanges(this.pickups.keys(), due.map((p) => p.id))
    for (const id of remove) this.removePickup(id)
    for (const p of due) if (add.includes(p.id)) this.addPickup(p)
    if (add.length || remove.length) this.publish()
    emitPapers(this.deps.session)
  }

  /** Paper ids still lying in this area (playtest hook). */
  lying(): string[] {
    return [...this.pickups.keys()]
  }
}
