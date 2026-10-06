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
import { TILE } from '../textures'
import { commonsAnim } from '../commons-pass'
import type { InteractId, WorldData } from '../worlds'
import type { Effects } from './fx'
import { emitPapers, grantPaper, PAPER_EV } from '../papers'
import { itemsFor } from '../items'
import type { QuestStage } from '../../lib/state'

export interface PaperDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
}

export interface PaperInteraction {
  id: InteractId
  x: number
  y: number
  label: string
}

interface Pickup {
  paperId: string
  image: Phaser.GameObjects.Sprite
  twinkle: Phaser.GameObjects.Image
  timer: Phaser.Time.TimerEvent | null
}

const PAPER_PREFIX = 'paper:'

export function isPaperInteract(id: string): boolean {
  return id.startsWith(PAPER_PREFIX)
}

// ------------------------------------------------------------ pixel art

type Art = { rows: string[]; pal: Record<string, string> }

const PAL: Record<string, string> = {
  o: '#3a2a28', // outline, as everywhere in the game
  w: '#fffbef',
  p: '#f4e4c1',
  s: '#d8c79c',
  k: '#8a7458', // faded ink
  r: '#b25a3c', // ribbon
  R: '#e07a52',
  f: '#8a5a34', // frame wood
  F: '#b07a48',
  g: '#4c5560', // slate
  G: '#6b7684',
  c: '#e8e4d8', // chalk
  b: '#4a6f9c', // book cloth
  B: '#6c93bd',
  y: '#ffd24a'
}

const ART: Record<string, Art> = {
  'paper-folded': {
    rows: [
      '....oooooooo',
      '...owwwwwwpo',
      '..owwkkkkwpo',
      '.owwwwwwwpso',
      'owkkkkkwwpso',
      'owwwwwkkppso',
      'oppppppppsso',
      '.oosssssssoo',
      '...oooooooo.'
    ],
    pal: PAL
  },
  'paper-scroll': {
    rows: [
      '.oo.......oo.',
      'oFfoooooooFfo',
      'ofwwwwrwwwwfo',
      'ofppppRrpppfo',
      'ofpppprRpppfo',
      'ofsssssrsssfo',
      'oFfoooooooFfo',
      '.oo...rr..oo.',
      '.....r..r....'
    ],
    pal: PAL
  },
  'paper-slate': {
    rows: [
      'oooooooooooo',
      'oFFFFFFFFFFo',
      'oFggggggggfo',
      'oFgcgGgcggfo',
      'oFggcgcgGgfo',
      'oFgcgGgcggfo',
      'oFggggggggfo',
      'offfffffffo.',
      '.oooooooooo.'
    ],
    pal: PAL
  },
  // Hangs over the library door: an open book on a board.
  'library-sign': {
    rows: [
      '...o............o...',
      '...o............o...',
      'oooooooooooooooooooo',
      'oFFFFFFFFFFFFFFFFFFo',
      'oFFoooooFFFFoooooFFo',
      'oFowwwwwooooowwwwoFo',
      'oFowkkkwwwowwkkkwoFo',
      'oFowwwwwwwowwwwwwoFo',
      'oFowkkkkwwowkkkkwoFo',
      'oFowwwwwwwowwwwwwoFo',
      'oFoobbbbbooobbbbboFo',
      'oFFFoooooFFFoooooFFo',
      'offfffffffffffffffo.',
      'oooooooooooooooooooo'
    ],
    pal: PAL
  }
}

function ensureTextures(scene: Phaser.Scene): void {
  for (const [key, art] of Object.entries(ART)) {
    if (scene.textures.exists(key)) continue
    const w = Math.max(...art.rows.map((r) => r.length))
    const h = art.rows.length
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    art.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = art.pal[row[x]]
        if (!c) continue
        ctx.fillStyle = c
        ctx.fillRect(x, y, 1, 1)
      }
    })
    scene.textures.addCanvas(key, canvas)
  }
}

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
    ensureTextures(scene)
    this.build()
    if (deps.world.library) {
      const d = deps.world.library
      if (scene.textures.exists('commons-art:hearthwick-library')) {
        // The delivered building carries its open book over the door: the
        // hanging sign stands out front, beside the step.
        const y = (d.ty + 1) * TILE + 9
        scene.add.image(d.tx * TILE + 8 + 22, y, 'library-sign').setOrigin(0.5, 1).setDepth(y)
      } else {
        scene.add.image(d.tx * TILE + 8, d.ty * TILE - 1, 'library-sign').setOrigin(0.5, 1).setDepth(d.ty * TILE + TILE + 1)
      }
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
    emitPapers(deps.session)
    // Quest beats owed to a save that is already past them (older saves).
    this.grantBeats(deps.session.questStage, 0)
  }

  /** Interaction points: the library door and every pickup lying here. */
  interactions(): PaperInteraction[] {
    const out: PaperInteraction[] = []
    const lib = this.deps.world.library
    if (lib) out.push({ id: 'library', x: lib.tx * TILE + 8, y: lib.ty * TILE + TILE, label: 'Enter the Hearthwick Library' })
    for (const p of placedPapersIn(this.deps.world.areaId, this.deps.session.questStage, this.deps.session.state.flags)) {
      out.push({ id: `paper:${p.id}`, x: p.source.tx * TILE + 8, y: p.source.ty * TILE + TILE - 2, label: LOOK_LABEL[p.source.look] })
    }
    return out
  }

  owns(id: string): boolean {
    return id === 'library' || isPaperInteract(id)
  }

  /** Act on an owned interaction. True when the interaction point is used up. */
  activate(id: string): boolean {
    if (id === 'library') {
      bus.emit(PAPER_EV.openLibrary)
      return false
    }
    const paperId = id.slice(PAPER_PREFIX.length)
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
    const { world, session, reducedMotion } = this.deps
    for (const p of placedPapersIn(world.areaId, session.questStage, session.state.flags)) {
      const x = p.source.tx * TILE + 8
      const y = p.source.ty * TILE + TILE - 3
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

  /** Connected: another device may have picked something up. */
  private onWorldRefresh(): void {
    const still = new Set(placedPapersIn(this.deps.world.areaId, this.deps.session.questStage, this.deps.session.state.flags).map((p) => p.id))
    for (const id of [...this.pickups.keys()]) if (!still.has(id)) this.removePickup(id)
    emitPapers(this.deps.session)
  }

  /** Paper ids still lying in this area (playtest hook). */
  lying(): string[] {
    return [...this.pickups.keys()]
  }
}
