/**
 * Pip's walk-on (docs/design/quests.md 3, indoors.md 5.7): as Orrin sets
 * the signpost (the opening reaches `set-post`), Pip runs up from the
 * garden with Mara's message, says it, and runs back. A small scripted beat
 * of the village scene: drawing and one conversation, nothing saved.
 */
import type Phaser from 'phaser'
import { bus, EV, type QuestPayload } from '../events'
import { openDialogue } from '../dialogue'
import { tileAt } from '../../lib/tile'
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

  constructor(scene: Phaser.Scene, private deps: PipWalkOnDeps) {
    if (deps.world.areaId !== 'village') return
    // The opening's step comes with the quest event (lane C's `{ quest, step }`).
    const onQuest = (p: QuestPayload & { quest?: string; step?: string }) => {
      if (p.quest === 'signpost' && p.step === 'set-post') this.play()
    }
    bus.on(EV.quest, onQuest)
    scene.events.once('shutdown', () => bus.off(EV.quest, onQuest))
  }

  /** Run up to the hero, say the message, run home. False when Pip isn't here (or already running). */
  play(): boolean {
    const pip = this.deps.npcs.npcs.find((n) => n.id === 'pip')
    if (!pip || !pip.home || this.running) return false
    this.running = true
    const hero = this.deps.hero()
    const from = { tx: tileAt(pip.home.x), ty: tileAt(pip.home.y - 1) }
    // Beside the hero, a step to their right.
    const to = { tx: tileAt(hero.x) + 1, ty: tileAt(hero.y - 1) }
    const there = twoLegs(from, to)
    this.deps.npcs.walkPath(pip, there, () => {
      openDialogue({ id: 'pip', speaker: 'Pip', lines: PIP_MESSAGE })
      bus.once(EV.dialogueClosed, () => {
        this.deps.npcs.walkPath(pip, [...twoLegs(to, from)], () => {
          this.deps.npcs.place(pip, true)
          this.running = false
        }, RUN)
      })
    }, RUN)
    return true
  }
}
