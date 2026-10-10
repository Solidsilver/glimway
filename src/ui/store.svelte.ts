import type { PurseView } from '../lib/purse'
import type { AbilityPayload, AreaPayload, GoalDirPayload, MagicPayload, GoalLinePayload, LinkPayload, PresencePayload, PromptPayload, QuestPayload, StatsPayload, ToastPayload } from '../game/events'
import type { HabiticaProfile, VitalsSource } from '../lib/habitica/types'
import { bus, EV } from '../game/events'
import { onContextButtons, type ContextButton } from '../game/context-buttons'
import { getCombatKit, type CombatKit } from '../lib/combat'
import { itemName } from '../lib/items'
import { isTouchFirst } from './device'

/** A move's readiness on the HUD slot / touch button (crafts.md 4.3). */
export interface AbilitySlot {
  readyAt: number
  cooldown: number
  deniedAt: number
}

const IDLE_SLOT: AbilitySlot = { readyAt: 0, cooldown: 1, deniedAt: 0 }

/** Stored toast = payload plus a render key and optional icon. */
type StoredToast = ToastPayload & { id: string }

/**
 * Things that just went into the bag or the journal: the HUD button shows
 * them as a short "+7 Fiber" tag. Gains of one item within GAIN_MERGE_MS
 * add up into one tag.
 */
export interface Gain {
  id: string
  to: 'bag' | 'journal'
  itemDef: string | null
  qty: number
  /** What the tag says ("7 Fiber", "Eleven Days"). */
  label: string
  /** The full sentence, for screen readers. */
  text: string
  art?: string
  icon?: string
  at: number
}

const GAIN_MERGE_MS = 1500
const GAIN_SHOW_MS = 2400

/** Every toast handed to the UI so far, whatever its kind (dev hook `__fsToasts`). */
interface ToastLogEntry {
  n: number
  text: string
  kind: string
}

/** A quest beat or area title waiting to be shown. */
interface Banner {
  id: string
  kind: 'quest' | 'area'
  eyebrow: string
  /** First visit: the full storybook card. Later visits pass `chip` instead (src/ui/Banners.svelte). */
  title: string
  body?: string
}

/**
 * Reactive snapshot of the game's meaningful state events for the interface.
 * Written by App.svelte's bus wiring, read by UI components.
 */
class UiStore {
  stats = $state<StatsPayload>({ hp: 5, maxHp: 5, mana: 5, maxMana: 5, embers: 0, gold: 0 })
  /** Connected play: the purse (gold, top-ups left today, a top-up still working); null until a world says. */
  purse = $state<PurseView | null>(null)
  quest = $state<QuestPayload>({ stage: 'new', objective: '' })
  /** The pinned "How do I…?" guide's step, when one leads the goal line (null: the story). */
  goalLine = $state<GoalLinePayload>({ guide: null })
  /** Which way the quest goal lies from the hero (src/game/entities/goal-guide.ts). */
  goalDir = $state<GoalDirPayload>({ angle: null, here: false })
  /** False until the first quest snapshot arrives (load is not a "change"). */
  questKnown = $state(false)
  area = $state<AreaPayload>({ areaId: 'village', name: '', description: '' })
  prompt = $state<PromptPayload>({ label: null })
  toasts = $state<StoredToast[]>([])
  /** Gains on show beside the bag and journal buttons (newest last). */
  gains = $state<Gain[]>([])
  /** The hero's latest thought (screen readers hear it from the HUD). */
  thought = $state<{ text: string; at: number } | null>(null)
  /** A title card or quest ribbon is on screen (toasts and notices wait). */
  bannerUp = $state(false)
  /** Read-only log for playtests: every toast of every kind (dev builds only). */
  toastLog: ToastLogEntry[] = []
  toastCount = 0
  defeatCount = $state(0)
  /** Save provenance (format 2), shown in the character panel. */
  vitalsSource = $state<VitalsSource>('demo')
  importedProfile = $state<HabiticaProfile | null>(null)
  /** True when the player opted to remember their Habitica details on this device. */
  remembered = $state(false)

  /** Glimway server: unknown until the first probe; unavailable = it didn't answer. */
  server = $state<'unknown' | 'available' | 'unavailable'>('unknown')
  /** Signed in to the Glimway server (session cookie), whether or not play has started. */
  account = $state<{ accountId: string; name: string } | null>(null)
  /** Connected play: the running session's server link. */
  link = $state<LinkPayload | null>(null)
  /** Connected play: the reconnect notice ("you played somewhere else"). */
  linkNotice = $state<'played-elsewhere' | null>(null)
  /** Presence: socket status and others in this area. */
  presence = $state<PresencePayload>({ status: 'off', here: 0 })
  /** The emote picker is open. */
  emoteOpen = $state(false)
  /** Wilds materials (server balances, or the latest gather). Null until the Wilds load. */
  materials = $state<Record<string, number> | null>(null)

  /** Mirrors of world/UI ownership flags, reactive for the interface. */
  dialogueOpen = $state(false)
  cinematic = $state(false)
  /** The save's resident-meeting flags (`met:<id>@<stage>`): the journal's resident notes. */
  residentsMet = $state<string[]>([])
  /** Unmoored status (light drift status from deep Tangle, turns, or stirs): the game's, via EV.unmoored. */
  unmoored = $state(false)
  /** Speaker -> portrait data URL. */
  portraits = $state<Record<string, string>>({})
  /** Delivered UI icons by frame key (`icon-timber`, …): src/ui/ArtIcon.svelte. */
  artIcons = $state<Record<string, string>>({})
  /** The moves' readiness for the HUD slots / touch buttons, keyed by ability id (`fingersnap`, `kindle`, …). */
  ability = $state<Record<string, AbilitySlot>>({})
  /** The server's level and class marks (PlayerState.magic); null until a connected state says. */
  magic = $state<MagicPayload | null>(null)
  /** The hero's kit as the interface shows it: craft, signature (F) and level-20 move (R). */
  kit: CombatKit = $derived(getCombatKit(this.importedProfile, this.magic))
  /** The context buttons the game has up (src/game/context-buttons.ts): saddle, Go home, Keep / Let it go. */
  contextButtons = $state.raw<readonly ContextButton[]>([])
  /** Dodge roll cooldown for the HUD slot / touch button. */
  roll = $state<{ readyAt: number; cooldown: number }>({ readyAt: 0, cooldown: 1 })
  /** Queue of quest beats / area titles (shown one at a time). */
  banners = $state<Banner[]>([])
  /** Defeat overlay phase. */
  defeat = $state<'none' | 'falling' | 'woke'>('none')
  /** The end-of-quest card. */
  endingOpen = $state(false)

  /** Another account, or none: the purse shown is this one's (null when signed out). */
  showPurse(purse: PurseView | null): void {
    this.purse = purse
    this.stats = { ...this.stats, gold: purse?.gold ?? 0 }
  }

  toast(payload: ToastPayload): void {
    const kind = payload.kind ?? 'info'
    if (import.meta.env.DEV) {
      this.toastCount += 1
      this.toastLog.push({ n: this.toastCount, text: payload.text, kind })
      if (this.toastLog.length > 100) this.toastLog.shift()
    }
    // The hero noticing something: a line above the hero, not news. The HUD
    // reads it out for screen readers (the bubble is canvas text).
    if (kind === 'thought') {
      // A title card or ribbon over the hero would hide it: it waits for the card.
      if (this.bannerUp) this.pendingThought = payload.text
      else this.think(payload.text)
      return
    }
    if (kind === 'gain' && payload.gain) {
      this.gain(payload)
      return
    }
    const id = Math.random().toString(36).slice(2)
    const entry: StoredToast = { ...payload, id, kind }
    // Waiting and showing toasts. A phone shows one at a time and a desktop
    // two (src/ui/Toasts.svelte); only the newest plain lines wait, and an
    // error is never pushed out by a later line. Each toast's clock starts
    // when it is really on screen (not behind a title card).
    const errors = this.toasts.filter((t) => t.kind === 'error')
    const infos = this.toasts.filter((t) => t.kind !== 'error')
    if (kind === 'error') errors.push(entry)
    else infos.push(entry)
    const keep = isTouchFirst() ? 1 : 2
    const kept = new Set([...errors.slice(-2), ...infos.slice(-keep)])
    this.toasts = [...this.toasts, entry].filter((t) => kept.has(t))
  }

  private pendingThought: string | null = null

  private think(text: string): void {
    this.thought = { text, at: performance.now() }
    bus.emit(EV.thought, { text })
  }

  /** A title card or quest ribbon came up or went (src/ui/Banners.svelte). */
  setBannerUp(up: boolean): void {
    this.bannerUp = up
    if (!up && this.pendingThought) {
      const text = this.pendingThought
      this.pendingThought = null
      this.think(text)
    }
  }

  /** A move's slot: idle when it was never used. */
  slot(id: string | null | undefined): AbilitySlot {
    return (id && this.ability[id]) || IDLE_SLOT
  }

  /** A move fired or was refused (EV.ability): its slot's sweep or shake. */
  abilityEvent(p: AbilityPayload): void {
    const slot = this.slot(p.ability)
    if (p.status === 'cast') this.ability = { ...this.ability, [p.ability]: { ...slot, readyAt: performance.now() + (p.cooldown ?? 1) * 1000, cooldown: p.cooldown ?? 1 } }
    else if (p.status === 'no-mana') this.ability = { ...this.ability, [p.ability]: { ...slot, deniedAt: performance.now() } }
  }

  dismissToast(id: string): void {
    this.toasts = this.toasts.filter((t) => t.id !== id)
  }

  private gain(payload: ToastPayload): void {
    const g = payload.gain!
    const now = performance.now()
    // A counted single item adds up with the last one; mixed loot says what it was.
    const counted = !!g.itemDef && g.qty !== undefined
    const recent = counted ? this.gains.find((x) => x.to === g.to && x.itemDef === g.itemDef && x.qty > 0 && now - x.at < GAIN_MERGE_MS) : undefined
    const total = counted ? (recent?.qty ?? 0) + g.qty! : 0
    const label = counted ? `${total} ${itemName(g.itemDef!)}` : (g.label ?? gainLabel(payload.text))
    const id = Math.random().toString(36).slice(2)
    const next: Gain = { id, to: g.to, itemDef: g.itemDef ?? null, qty: total, label, text: payload.text, art: payload.art, icon: payload.icon, at: now }
    this.gains = [...this.gains.filter((x) => x !== recent && x.to !== g.to), next]
    setTimeout(() => {
      this.gains = this.gains.filter((x) => x.id !== id)
    }, GAIN_SHOW_MS)
  }

  /** Id of the banner currently on screen (set by Banners.svelte). */
  shownBannerId: string | null = null

  banner(b: Omit<Banner, 'id'>): void {
    const id = Math.random().toString(36).slice(2)
    // A newer banner of the same kind supersedes any not yet seen, so an
    // overtaken quest beat is never shown late. Area titles describe where
    // you are now: a new one replaces even the title on screen.
    const rest = this.banners.filter((x) => x.kind !== b.kind || (b.kind === 'quest' && x.id === this.shownBannerId))
    this.banners = [...rest, { ...b, id }]
  }

  dismissBanner(id: string): void {
    this.banners = this.banners.filter((b) => b.id !== id)
  }
}

/** A short tag for a gain without an item: the name in "Found: “Eleven Days” — it's in your journal." */
function gainLabel(text: string): string {
  const quoted = /[“"]([^”"]+)[”"]/.exec(text)?.[1]
  // "Mara Wells: noted in your journal." → "Mara Wells"
  const noted = /^(.+?): noted in your journal/.exec(text)?.[1]
  // "For the light: 3 timber, 2 stone." → "3 timber, 2 stone"
  const after = /^[^:]{1,40}:\s*([^—]+?)\.?(?:\s+—.*)?$/.exec(text)?.[1]
  return (quoted ?? noted ?? after ?? text).trim().replace(/^\+/, '')
}

export const ui = new UiStore()

onContextButtons((buttons) => {
  ui.contextButtons = buttons
})

bus.on(EV.magic, (p: MagicPayload) => {
  ui.magic = p
})
