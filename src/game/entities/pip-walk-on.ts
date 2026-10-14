import { onSceneEnd } from '../scene-end.ts'
/**
 * Pip's walk-on (docs/design/quests.md 3, indoors.md 5.7): as Orrin sets
 * the signpost (the opening reaches `set-post`), Pip runs up from the
 * garden with Mara's message, says it, and runs back. A small scripted beat
 * of the village scene: drawing and one conversation, nothing saved.
 */
import type Phaser from 'phaser'
import { bus, EV, type QuestPayload } from '../events'
import { openDialogue } from '../dialogue'
import { tileAt, tileFeet } from '../../lib/tile'
import { townPath } from '../wilds/town-path.ts'
import { twoLegs } from '../resident-cycle'
import type { Npcs } from './npcs'
import type { WorldData } from '../worlds'

/** Pip's pace running a message (px a second; a walk is 24). */
const RUN = 64

export const PIP_MESSAGE = [
  'Mara says if you’re done holding Orrin’s ladder, the ledger’s open and the soup’s on. That’s the whole message. I ran it twice to get it right.'
]

export interface PipWalkOnDeps {
  world: WorldData
  npcs: Npcs
  hero: () => { x: number; y: number }
}

export class PipWalkOn {
  private running = false
  private stopped = false
  private closed: (() => void) | null = null

  constructor(scene: Phaser.Scene, private deps: PipWalkOnDeps) {
    if (deps.world.areaId !== 'village' && !deps.world.open) return
    // The opening's step comes with the quest event (lane C's `{ quest, step }`).
    const onQuest = (p: QuestPayload & { quest?: string; step?: string }) => {
      if (p.quest === 'signpost' && p.step === 'set-post') this.play()
    }
    bus.on(EV.quest, onQuest)
    const cleanup = () => {
      this.stopped = true
      this.running = false
      bus.off(EV.quest, onQuest)
      this.cancelConversation()
    }
    onSceneEnd(scene, cleanup)
  }

  private cancelConversation(): void {
    if (this.closed) bus.off(EV.dialogueClosed, this.closed)
    this.closed = null
  }

  /** A streamed-out Pip cannot finish a conversation or start a return walk. */
  detachChunk(): void {
    if (!this.deps.npcs.npcs.some((n) => n.id === 'pip')) {
      this.cancelConversation()
      this.running = false
    }
  }

  /** Run up to the hero, say the message, run home. False when Pip isn't here (or already running). */
  play(): boolean {
    const pip = this.deps.npcs.npcs.find((n) => n.id === 'pip')
    if (this.stopped || !pip || !pip.home || this.running) return false
    this.running = true
    const hero = this.deps.hero()
    const from = { tx: tileAt(pip.home.x), ty: tileAt(pip.home.y - 1) }
    // Choose a reachable neighbour: the signpost may occupy the east tile.
    const hx = tileAt(hero.x), hy = tileAt(hero.y - 1)
    const candidates = [{ tx: hx + 1, ty: hy }, { tx: hx - 1, ty: hy }, { tx: hx, ty: hy + 1 }, { tx: hx, ty: hy - 1 }]
    let there: { x: number; y: number }[] | null | undefined
    for (const to of candidates) {
      there = this.deps.world.open ? townPath(from, to, this.deps.world.open.solidAt)?.map((t) => tileFeet(t.tx, t.ty)) : twoLegs(from, to)
      if (there) break
    }
    if (!there) { this.running = false; return false }
    this.deps.npcs.walkPath(pip, there, () => {
      if (this.stopped || !this.deps.npcs.npcs.includes(pip)) return
      openDialogue({ id: 'pip', speaker: 'Pip', lines: PIP_MESSAGE })
      this.closed = () => {
        this.closed = null
        if (this.stopped || !this.deps.npcs.npcs.includes(pip)) return
        this.deps.npcs.walkPath(pip, [...there].reverse().slice(1).concat([tileFeet(from.tx, from.ty)]), () => {
          this.deps.npcs.place(pip, true)
          this.running = false
        }, RUN)
      }
      bus.once(EV.dialogueClosed, this.closed)
    }, RUN)
    return true
  }
}
