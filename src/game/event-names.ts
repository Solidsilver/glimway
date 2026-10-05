/**
 * Event names and payloads for the bus (src/game/events.ts). Kept free of
 * Phaser so plain modules (the server link) and Node tests can use them.
 */
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
  /** Connected play: server link status changed (online, offline, taken over…). */
  link: 'ui:link',
  /** Connected play: a reconnect merged offline progress into newer server progress. */
  linkNotice: 'ui:link-notice',
  /** Connected play: the server moved the hero (a stale merge) — the scene follows. */
  relocate: 'game:relocate',
  /** Presence (phase 6): socket status and how many others share the area. */
  presence: 'ui:presence',
  /** Presence: someone (or you) emoted — the scene shows a bubble. */
  emote: 'game:emote',
  /** Connected play: balances or paid outcomes changed — markers and lanterns refresh. */
  worldRefresh: 'game:world-refresh',
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
  /** Short word for the touch action button (default "Talk"). */
  verb?: string
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

export type LinkStatus = 'online' | 'offline' | 'superseded' | 'signed-out'

export interface LinkPayload {
  status: LinkStatus
  /** A spend or sync is waiting for the server. */
  busy: boolean
  /** Local changes the server hasn't accepted yet. */
  dirty: boolean
  /** Offline because the server is failing (500s), not the network. */
  trouble: boolean
}

export interface RelocatePayload {
  area: 'village' | 'woodland' | 'ruin'
  x: number
  y: number
}

export interface PresencePayload {
  /** 'off' for guests and before the lease; 'live' once the socket is ready. */
  status: 'off' | 'connecting' | 'live' | 'retrying' | 'superseded' | 'unauthorized' | 'replaced' | 'rejected'
  /** Other players in this area right now. */
  here: number
}

export interface EmotePayload {
  /** null for the local hero. */
  habiticaId: string | null
  id: string
}
