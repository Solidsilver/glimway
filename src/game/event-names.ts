/**
 * Event names and payloads for the bus (src/game/events.ts). Kept free of
 * Phaser so plain modules (the server link) and Node tests can use them.
 */
export const EV = {
  // game -> ui
  sync: 'ui:sync',
  stats: 'ui:stats',
  quest: 'ui:quest',
  /** What the hero holds changed: { kind } (src/game/held.ts, src/lib/belt.ts). */
  held: 'ui:held',
  /** Take something in hand (UI -> game): { kind }. */
  hold: 'game:hold',
  /** A "How do I…?" guide was pinned or unpinned: { id } (src/game/guide-pin.ts). */
  guidePin: 'ui:guide-pin',
  /** The goal line's text and source changed: GoalLinePayload. */
  goalLine: 'ui:goal-line',
  /** Which way the quest goal lies: { angle, here } (GoalDirPayload). */
  goalDir: 'ui:goal-dir',
  area: 'ui:area',
  prompt: 'ui:prompt',
  dialogue: 'ui:dialogue',
  toast: 'ui:toast',
  /** A passing thought shown above the hero (flavour, not news): { text }. Sent by the UI for `kind: 'thought'` toasts. */
  thought: 'game:thought',
  defeat: 'ui:defeat',
  /** Session committed a new imported profile — the world avatar/pet refresh. */
  profileChanged: 'ui:profile-changed',
  /** Signature ability fired (cooldown starts) or failed (not enough mana). */
  ability: 'ui:ability',
  /** A scripted beat (lantern lighting) owns the screen: hide the HUD. */
  cinematic: 'ui:cinematic',
  /** Native-size portrait images for dialogue, built once from loaded art. */
  portraits: 'ui:portraits',
  /** Delivered 16-px UI icons (Commons pass) by frame key, as data URLs. */
  artIcons: 'ui:art-icons',
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
  /** Presence: someone standing by you handed you something: { fromName, kind, itemDef, qty }. */
  gift: 'game:gift',
  /** Presence: someone near you reached a story beat (src/content/witness.ts): { beat, habiticaId, name }. */
  witness: 'game:witness',
  /** Connected play: a mutation whose answer was lost is now known: { op, outcome, res? | code? }. */
  mutationResolved: 'game:mutation-resolved',
  /** Connected play: balances or paid outcomes changed — markers and lanterns refresh. */
  worldRefresh: 'game:world-refresh',
  /** The Wilds region changed (loaded, claimed, materials moved): { materials }. */
  wilds: 'ui:wilds',
  /** The dev/playtest clock moved (the calendar and the outer Wilds follow). */
  clock: 'game:clock',
  /** The outer Wilds turned under the player (an ended epoch): { reason }. */
  turning: 'game:turning',
  /** Something was planted on the land you stand on: { plant } (a HomePlantView). */
  planted: 'game:planted',
  /** Write the hero's spot into the save now (before a mutation that measures reach). */
  notePosition: 'game:note-position',
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
  /** The goal in a few words (HUD line, quest ribbon). */
  short?: string
}

/** What the HUD's goal line says: the story's short goal, or a pinned guide's step. */
export interface GoalLinePayload {
  /** null: the story leads (the HUD shows the quest's own words). */
  guide: { id: string; title: string; step: string; index: number; count: number } | null
}

/**
 * Which way the current goal lies from the hero, in screen terms (radians,
 * 0 = right, clockwise; null when there is no place to point at). `here`:
 * the goal is in this area (else the angle points at the way out toward it).
 */
export interface GoalDirPayload {
  angle: number | null
  here: boolean
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
  /** Any registered area id (the Wilds report `wilds`). */
  areaId: string
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
  /**
   * info: a toast. error: a red toast that stays longer. thought: the hero
   * noticing something (a line above the hero, no toast). gain: something
   * went into the bag or the journal (the button shows it, no toast).
   */
  kind?: 'info' | 'error' | 'thought' | 'gain'
  /** For `kind: 'gain'`: where it went, and what (merged per item for a moment). */
  gain?: { to: 'bag' | 'journal'; itemDef?: string; qty?: number; /** The tag's words when it isn't one counted item ("3 fiber, 1 amber", a paper's title). */ label?: string }
  /** Icon name (src/ui/Icon.svelte); defaults to a sparkle. */
  icon?: string
  /** A delivered icon frame (`icon-timber`, …) shown instead, when loaded. */
  art?: string
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
  /**
   * Plays `reply`, then offers the other choices again ("Hear it again"):
   * it doesn't end the talk. It goes from the list once picked.
   */
  replay?: boolean
  /** A plain goodbye: dropped when it would be the only choice left. */
  dismiss?: boolean
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

export interface WildsPayload {
  /** Materials the player holds (server balances, or the guest pack). */
  materials: Record<string, number> | null
}

export interface RelocatePayload {
  area: string
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
