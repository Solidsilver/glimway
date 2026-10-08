/**
 * What presence brings into the scene besides the others' figures
 * (./remote-players.ts): your own emote's bubble (the server doesn't echo
 * it back), and the story beats others reach near you (src/content/witness.ts).
 */
import type Phaser from 'phaser'
import { hasWitnessed, isWitnessBeat, witnessCopy, witnessMoment } from '../../content/witness'
import { bus, EV, type EmotePayload, type WitnessPayload } from '../events'
import type { Session } from '../session'
import type { WorldData } from '../worlds'
import type { EnemySystem } from './enemies'
import { showEmoteBubble } from './remote-players'

/** How long a waiting warden rests for someone else's naming before it remembers its pose. */
const WITNESS_REST_MS = 4200

export interface PresenceMomentsDeps {
  session: Session
  world: WorldData
  enemies: EnemySystem
  hero: () => Phaser.GameObjects.Components.Transform
}

export function presenceMoments(scene: Phaser.Scene, deps: PresenceMomentsDeps): void {
  let bubble: Phaser.GameObjects.Container | null = null
  const onEmote = (p: EmotePayload) => {
    if (p.accountId !== null) return
    bubble?.destroy()
    bubble = showEmoteBubble(scene, deps.hero(), p.id, -32)
  }
  const onWitness = (p: WitnessPayload) => witness(deps, p)
  bus.on(EV.emote, onEmote)
  bus.on(EV.witness, onWitness)
  scene.events.once('shutdown', () => {
    bus.off(EV.emote, onEmote)
    bus.off(EV.witness, onWitness)
  })
}

/**
 * Someone standing near reached a story beat (the server relayed it from
 * its record of their progress): the moment on screen, a lantern over
 * them, and a journal line, once per beat and traveler. Your story doesn't
 * move. Your own waiting warden rests a moment, then remembers its pose.
 */
function witness(deps: PresenceMomentsDeps, p: WitnessPayload): void {
  const s = deps.session
  if (!s.link || !p || !isWitnessBeat(p.beat) || !p.accountId) return
  if (hasWitnessed(s.state.flags, p.beat, p.accountId)) return
  // The journal line is the relay's `witness:` mark, written by the server
  // (design server-first 2.2); it arrives with the next state.
  bus.emit(EV.toast, { text: witnessMoment(p.beat, p.name), icon: 'lantern' })
  bus.emit(EV.emote, { accountId: p.accountId, id: 'lantern' } satisfies EmotePayload)
  if (p.beat === 'warden' && deps.world.areaId === 'ruin') {
    deps.enemies.warden.witnessRest(WITNESS_REST_MS, () => bus.emit(EV.toast, { text: witnessCopy.wardenRises, icon: 'lantern' }))
  }
}
