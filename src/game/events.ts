/**
 * Event bridge between the Phaser runtime and the Svelte interface.
 *
 * The game loop stays in Phaser. Only meaningful state changes cross this bus —
 * never per-frame movement data.
 */
import Phaser from 'phaser'

export const bus = new Phaser.Events.EventEmitter()

export const EV = {
  // game -> ui
  sync: 'ui:sync',
  stats: 'ui:stats',
  quest: 'ui:quest',
  area: 'ui:area',
  prompt: 'ui:prompt',
  dialogue: 'ui:dialogue',
  toast: 'ui:toast',
  defeat: 'ui:defeat',
  /** Session committed a new imported profile — the world avatar/pet refresh. */
  profileChanged: 'ui:profile-changed',
  // ui -> game (and dialogue panel -> scene)
  action: 'game:action',
  cast: 'game:cast',
  dpad: 'game:dpad',
  dialogueClosed: 'game:dialogue-closed'
} as const

export interface StatsPayload {
  hp: number
  maxHp: number
  mana: number
  maxMana: number
}

export interface QuestPayload {
  stage: string
  objective: string
}

export interface DialoguePayload {
  id: string
  speaker: string
  lines: string[]
  event?: string
}

export interface AreaPayload {
  areaId: 'village' | 'woodland' | 'ruin'
  name: string
  description: string
}

export interface PromptPayload {
  label: string | null
}

export interface ToastPayload {
  text: string
  kind?: 'info' | 'error'
}
