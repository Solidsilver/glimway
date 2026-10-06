import type { AreaPayload, LinkPayload, PresencePayload, PromptPayload, QuestPayload, StatsPayload, ToastPayload } from '../game/events'
import type { HabiticaProfile, VitalsSource } from '../lib/habitica/types'
import { isMuted } from '../game/sfx'
import { bus, EV } from '../game/events'
import { itemName } from '../lib/items'
import { isTouchFirst } from './device'

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
export interface ToastLogEntry {
  n: number
  text: string
  kind: string
}

/** A quest beat or area title waiting to be shown. */
export interface Banner {
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
  stats = $state<StatsPayload>({ hp: 5, maxHp: 5, mana: 5, maxMana: 5, embers: 0 })
  quest = $state<QuestPayload>({ stage: 'new', objective: '' })
  /** False until the first quest snapshot arrives (load is not a "change"). */
  questKnown = $state(false)
  area = $state<AreaPayload>({ areaId: 'village', name: 'Village', description: '' })
  prompt = $state<PromptPayload>({ label: null })
  toasts = $state<StoredToast[]>([])
  /** Gains on show beside the bag and journal buttons (newest last). */
  gains = $state<Gain[]>([])
  /** Read-only log for playtests: every toast of every kind (dev builds read it). */
  toastLog: ToastLogEntry[] = []
  toastCount = 0
  defeatCount = $state(0)
  /** Save provenance (format 2), shown in the character panel. */
  vitalsSource = $state<VitalsSource>('demo')
  importedProfile = $state<HabiticaProfile | null>(null)
  /** True when the player opted to remember their Habitica details on this device. */
  remembered = $state(false)

  /** Fingersnap server: unknown until the first probe; unavailable = guest-only build or offline. */
  server = $state<'unknown' | 'available' | 'unavailable'>('unknown')
  /** Signed in to the Fingersnap server (session cookie), whether or not play has started. */
  account = $state<{ habiticaId: string; name: string } | null>(null)
  /** Connected play: the running session's server link (null for guests). */
  link = $state<LinkPayload | null>(null)
  /** Connected play: the reconnect notice ("you played somewhere else"). */
  linkNotice = $state<'played-elsewhere' | null>(null)
  /** Presence (phase 6): socket status and others in this area. */
  presence = $state<PresencePayload>({ status: 'off', here: 0 })
  /** The emote picker is open. */
  emoteOpen = $state(false)
  /** Wilds materials (server balances, or the guest pack). Null until the Wilds load. */
  materials = $state<Record<string, number> | null>(null)

  /** Mirrors of world/UI ownership flags, reactive for the interface. */
  dialogueOpen = $state(false)
  cinematic = $state(false)
  /** The save's resident-meeting flags (`met:<id>@<stage>`): the journal's resident notes. */
  residentsMet = $state<string[]>([])
  /** Unmoored status (light drift status from deep Tangle, turns, or stirs). */
  unmoored = $state(false)
  unmooredEasing = $state(false)
  /** Speaker -> portrait data URL. */
  portraits = $state<Record<string, string>>({})
  /** Delivered UI icons by frame key (`icon-timber`, …): src/ui/ArtIcon.svelte. */
  artIcons = $state<Record<string, string>>({})
  /** Signature ability readiness for the HUD slot / touch button. */
  ability = $state<{ readyAt: number; cooldown: number; deniedAt: number }>({ readyAt: 0, cooldown: 1, deniedAt: 0 })
  /** Dodge roll cooldown for the HUD slot / touch button. */
  roll = $state<{ readyAt: number; cooldown: number }>({ readyAt: 0, cooldown: 1 })
  /** Queue of quest beats / area titles (shown one at a time). */
  banners = $state<Banner[]>([])
  /** Defeat overlay phase. */
  defeat = $state<'none' | 'falling' | 'woke'>('none')
  /** The end-of-quest card. */
  endingOpen = $state(false)
  muted = $state(isMuted())

  toast(payload: ToastPayload): void {
    const kind = payload.kind ?? 'info'
    this.toastCount += 1
    this.toastLog.push({ n: this.toastCount, text: payload.text, kind })
    if (this.toastLog.length > 100) this.toastLog.shift()
    // The hero noticing something: a line above the hero, not news.
    if (kind === 'thought') {
      bus.emit(EV.thought, { text: payload.text })
      return
    }
    if (kind === 'gain' && payload.gain) {
      this.gain(payload)
      return
    }
    const id = Math.random().toString(36).slice(2)
    const entry: StoredToast = { ...payload, id, kind }
    // A phone has room for one toast, a desktop for two: the newest wins.
    const keep = isTouchFirst() ? 0 : 1
    this.toasts = [...this.toasts.slice(this.toasts.length - keep), entry]
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id)
    }, kind === 'error' ? 6000 : 4200)
  }

  private gain(payload: ToastPayload): void {
    const g = payload.gain!
    const now = performance.now()
    // A counted single item adds up with the last one; mixed loot says what it was.
    const counted = !!g.itemDef && g.qty !== undefined
    const recent = counted ? this.gains.find((x) => x.to === g.to && x.itemDef === g.itemDef && x.qty > 0 && now - x.at < GAIN_MERGE_MS) : undefined
    const total = counted ? (recent?.qty ?? 0) + g.qty! : 0
    const label = counted ? `${total} ${itemName(g.itemDef!)}` : gainLabel(payload.text)
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
