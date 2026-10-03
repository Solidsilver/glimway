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
  /** Signature ability fired (cooldown starts) or failed (not enough mana). */
  ability: 'ui:ability',
  /** A scripted beat (lantern lighting) owns the screen: hide the HUD. */
  cinematic: 'ui:cinematic',
  /** Native-size portrait images for dialogue, built once from loaded art. */
  portraits: 'ui:portraits',
  /** A discovery was written into the journal. */
  discovery: 'ui:discovery',
  /** The hero rolled (cooldown starts) — HUD/touch cooldown sweep. */
  rolled: 'ui:rolled',
  // ui -> game (and dialogue panel -> scene)
  action: 'game:action',
  cast: 'game:cast',
  /** Touch roll button. */
  dodge: 'game:dodge',
  dpad: 'game:dpad',
  dialogueClosed: 'game:dialogue-closed'
} as const

export interface StatsPayload {
  hp: number
  maxHp: number
  mana: number
  maxMana: number
  /** Ember balance (spent at lanterns and the Ashwatch chest). */
  embers: number
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
  /** Optional replies offered after the last line (all keep the same event). */
  choices?: DialogueChoice[]
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
  /** Icon name (src/ui/Icon.svelte); defaults to a sparkle. */
  icon?: string
}

export interface AbilityPayload {
  status: 'cast' | 'no-mana' | 'cooldown'
  /** Seconds until the ability is ready again (cast only). */
  cooldown?: number
}

export interface CinematicPayload {
  active: boolean
}

/** Speaker name -> PNG data URL. */
export type PortraitsPayload = Record<string, string>

export interface DiscoveryPayload {
  id: string
  label: string
}

export interface DefeatPayload {
  /** 'falling' fires as the hero collapses; 'woke' once back at the well. */
  phase: 'falling' | 'woke'
}

export interface DialogueChoice {
  text: string
  reply?: string[]
  /** World action applied when the conversation closes (e.g. an ember spend). */
  action?: string
  disabled?: boolean
  /** Cost, or why the choice is unavailable. */
  note?: string
}

export interface DialogueClosedPayload {
  event?: string
  /** The picked choice's action, if any. */
  action?: string
}
