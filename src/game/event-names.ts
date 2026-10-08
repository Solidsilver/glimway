import type { LibrarySection } from '../content/library'
import type { HomePlantView } from '../lib/api/types'
import type { BeltKind } from '../lib/belt'
import type { HabiticaProfile } from '../lib/habitica/types'
import type { PresenceStatus } from '../lib/presence-client.ts'
import type { HeldPayload } from './held'
import type { ArrangeView, NamePrompt, PlacementCommand, PlacementView } from './homestead'
import type { MutationOp } from './link'
import type { PaperFoundPayload, PapersSyncPayload } from './papers'
import type { ResidentsMetPayload } from './residents'
import type { SoundCue } from './sound-bank'
import type { VillagePanel } from './village'

/**
 * Event names and payloads for the bus (src/game/events.ts): the one registry.
 * Kept free of Phaser so plain modules (the server link) and Node tests can
 * use them. A new event gets a name here and a payload in `EventMap` below.
 */
export const EV = {
  // game -> ui
  stats: 'ui:stats',
  quest: 'ui:quest',
  /** What the hero holds changed: { kind } (src/game/held.ts, src/lib/belt.ts). */
  held: 'ui:held',
  /** Take something in hand (UI -> game): { kind }. */
  hold: 'game:hold',
  /** The pin moved: { id }, the slot (`quest:<id>`, `guide:<id>` or null; src/game/guide-pin.ts). */
  guidePin: 'ui:guide-pin',
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
  /** Presence: someone near you reached a story beat (src/content/witness.ts): { beat, accountId, name }. */
  witness: 'game:witness',
  /** Connected play: a mutation whose answer was lost is now known: { op, outcome, res? | code? }. */
  mutationResolved: 'game:mutation-resolved',
  /** Connected play: balances or paid outcomes changed — markers and lanterns refresh. */
  worldRefresh: 'game:world-refresh',
  /** Connected play: the world answered a fall: { lantern } ('placed': a fallen-hero lantern now waits in the Wilds). */
  fallSettled: 'game:fall-settled',
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
  dialogueClosed: 'game:dialogue-closed',
  /** Leave the unmoored state: { instant } (instant: at once, e.g. a turncap jar; else it eases off). */
  clearUnmoored: 'game:clear-unmoored',
  /** The hero became unmoored or steady again: { active } (src/game/entities/unmoored.ts). */
  unmoored: 'ui:unmoored',

  // items (src/game/items.ts)
  /** The carried items changed: { what? }. */
  itemsChanged: 'items:changed',

  // village (src/game/village.ts)
  /** Something here changed: { what: 'calendar' | 'projects' | 'goods' | 'mail' }. */
  villageChanged: 'village:changed',
  /** Open a panel: { panel, to?, gate? }. */
  villageOpen: 'ui:village-open',

  // homesteads (src/game/homestead.ts, src/game/entities/homesteads.ts)
  /** The lane or a home changed: { reason, gate? }. */
  homeChanged: 'home:changed',
  /** The UI should open Silas's shop. */
  homeShop: 'ui:home-shop',
  /** Placement-mode state for the tray: PlacementView | null. */
  homePlacement: 'ui:home-placement',
  /** Tray → scene: a placement command (PlacementCommand). */
  homeCommand: 'game:home-command',
  /** Whether the player stands where they may arrange their home: ArrangeView. */
  homeArrange: 'ui:home-arrange',
  /** UI → scene: start (or leave) arranging, from the Arrange button or B. */
  homeArrangeToggle: 'game:home-arrange-toggle',
  /** Decoration art as data URLs: Record<itemId, string>. */
  homeThumbs: 'ui:home-thumbs',
  /** Entered a homestead or a cottage: { key, title, eyebrow, body }. */
  homeRoom: 'ui:home-room',
  /** The homestead goal for the journal and HUD: { text }. */
  homeGoal: 'ui:home-goal',
  /** Ask the player to name a lantern post: NamePrompt; answered on `homeNamed`. */
  homeNamePrompt: 'ui:home-name-prompt',
  /** The name given (null: cancelled). */
  homeNamed: 'game:home-named',
  /** Ask the player to confirm leaving the deed. */
  homeConfirmLeave: 'ui:home-confirm-leave',
  /** UI → scene: a homestead action decided outside a conversation: { action }. */
  homeAction: 'game:home-action',

  // papers (src/game/papers.ts)
  /** A paper was found just now: { id }. */
  paperFound: 'ui:paper-found',
  /** The full found list for this save: { found }. */
  papersSync: 'ui:papers-sync',
  /** The player stepped up to the library door. */
  libraryOpen: 'ui:library-open',

  // residents (src/game/residents.ts)
  /** Flags used to assemble journal entries, including first meetings. */
  residentsMet: 'ui:residents-met',

  // sound (src/game/sound.ts listens; nothing else plays audio)
  /** A sound cue where no richer event fits: { cue, speaker? } (src/game/sfx.ts). */
  sfx: 'sound:cue',
  /** The hero's foot came down: { terrain } (a TERRAIN id, src/lib/tile.ts; the ground decides the step). */
  footstep: 'sound:footstep',
  /** A swing of gathering work landed: { action } ('chop', 'break', 'dig'). */
  work: 'sound:work'
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
  /** The lantern road's step (`'new'` before it starts). */
  stage: string
  /** The road's current goal in full (the HUD's open line, the title screen). */
  objective: string
  /** The goal in a few words (HUD line, quest ribbon). */
  short?: string
  /** The step this news reached (`quest:step`), when it reached one. */
  quest?: string
  step?: string
}

/** What the HUD's goal line says: the road's short goal, or a pinned quest's or guide's step. */
export interface GoalLinePayload {
  /** null: no guide leads (the HUD shows a pinned quest's words, or the road's). */
  guide: { id: string; title: string; step: string; index: number; count: number } | null
  /** A pinned, open quest's next step (null: none pinned, or it's done or locked). */
  quest?: { id: string; title: string; step: string; objective: string } | null
  /** The next step's `where` is the journal: the book button glows. */
  journal?: boolean
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

/**
 * The library panel, opened from the reading room (src/game/library-open.ts):
 * on its shelves (`section`: one of them; nothing shelved there yet opens
 * the whole collection), on Elara's donations, or the reader.
 */
export interface LibraryOpenPayload {
  focus?: 'shelf' | 'donate' | 'read'
  /** A section's shelves (docs/design/indoors.md 3.3): the panel opens on that section (an empty one: the whole collection). */
  section?: LibrarySection
}

/** The reading room's four sections, painted on their shelves' signs. */
export type { LibrarySection } from '../content/library'

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
  /** Answers keep failing on the server's side (5xx, 429), not the network. */
  trouble: boolean
  /** No answer for over a minute: "Reaching the world…". */
  reaching: boolean
  /**
   * Sending stopped: a newer build is needed (`reload`), the world couldn't
   * read a queued request (`client-bug`), or a queued key committed a
   * different request (`mismatch`).
   */
  paused: null | 'reload' | 'client-bug' | 'mismatch'
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
  status: PresenceStatus
  /** Other players in this area right now. */
  here: number
}

export interface EmotePayload {
  /** null for the local hero. */
  accountId: string | null
  id: string
}

export interface MutationResolvedPayload {
  op: MutationOp
  outcome: 'landed' | 'refused'
  /** The original response, when it landed and came back. */
  res?: unknown
  /** Why it was refused. */
  code?: string
}

export interface GiftPayload {
  fromName: string
  kind: string
  itemDef: string
  qty: number
}

export interface WitnessPayload {
  beat: string
  accountId: string
  name: string
}

export interface VillageOpenPayload {
  panel: VillagePanel
  /** Mail: the neighbour to write to. */
  to?: string
  /** Shelf: whose gate. */
  gate?: number
}

export interface HomeRoomPayload {
  /** First-visit key for the banner. */
  key: string
  eyebrow: string
  title: string
  body: string
}

/** Every event's payload (`void`: none). `bus.on`/`emit` check against this. */
export interface EventMap {
  [EV.stats]: StatsPayload
  [EV.quest]: QuestPayload
  [EV.held]: HeldPayload
  [EV.hold]: { kind: BeltKind }
  [EV.guidePin]: { id: string | null }
  [EV.goalDir]: GoalDirPayload
  [EV.area]: Pick<AreaPayload, 'areaId'>
  [EV.prompt]: PromptPayload
  [EV.dialogue]: DialoguePayload
  [EV.toast]: ToastPayload
  [EV.thought]: { text: string }
  [EV.defeat]: DefeatPayload
  [EV.profileChanged]: { profile: HabiticaProfile | null }
  [EV.ability]: AbilityPayload
  [EV.cinematic]: CinematicPayload
  [EV.portraits]: PortraitsPayload
  [EV.artIcons]: Record<string, string>
  [EV.discovery]: DiscoveryPayload
  [EV.rolled]: { cooldown: number }
  [EV.link]: LinkPayload
  [EV.linkNotice]: { kind: 'played-elsewhere' }
  [EV.relocate]: RelocatePayload
  [EV.presence]: PresencePayload
  [EV.emote]: EmotePayload
  [EV.gift]: GiftPayload
  [EV.witness]: WitnessPayload
  [EV.mutationResolved]: MutationResolvedPayload
  [EV.worldRefresh]: void
  [EV.fallSettled]: { lantern: string }
  [EV.wilds]: WildsPayload
  [EV.clock]: void
  [EV.turning]: { reason: 'epoch-ended' }
  [EV.planted]: { plant: HomePlantView }
  [EV.notePosition]: void
  [EV.action]: void
  [EV.cast]: void
  [EV.dodge]: void
  [EV.dialogueClosed]: DialogueClosedPayload
  [EV.clearUnmoored]: { instant: boolean }
  [EV.unmoored]: { active: boolean }
  [EV.itemsChanged]: { what?: string } | undefined
  [EV.villageChanged]: { what?: string } | undefined
  [EV.villageOpen]: VillageOpenPayload
  [EV.homeChanged]: { reason: string; gate?: number }
  [EV.homeShop]: void
  [EV.homePlacement]: PlacementView | null
  [EV.homeCommand]: PlacementCommand
  [EV.homeArrange]: ArrangeView
  [EV.homeArrangeToggle]: void
  [EV.homeThumbs]: Record<string, string>
  [EV.homeRoom]: HomeRoomPayload
  [EV.homeGoal]: { text: string | null }
  [EV.homeNamePrompt]: NamePrompt
  [EV.homeNamed]: { name: string | null }
  [EV.homeConfirmLeave]: { place: string; shared: boolean }
  [EV.homeAction]: { action: string }
  [EV.paperFound]: PaperFoundPayload
  [EV.papersSync]: PapersSyncPayload
  [EV.libraryOpen]: LibraryOpenPayload | void
  [EV.residentsMet]: ResidentsMetPayload
  [EV.sfx]: { cue: SoundCue; speaker?: string }
  [EV.footstep]: { terrain: number }
  [EV.work]: { action: string }
}

export type EventName = keyof EventMap

/** The bus's emit, for code that has it injected (the server link). */
export type Emit = <K extends EventName>(name: K, ...args: EventArgs<EventMap[K]>) => void

/** A handler for payload `P` (none for `void`). */
export type EventHandler<P> = [P] extends [void] ? () => void : (payload: P) => void

/** `emit`'s arguments after the name: none for `void`, optional when `P` may be undefined. */
export type EventArgs<P> = [P] extends [void] ? [] : undefined extends P ? [payload?: P] : [payload: P]
