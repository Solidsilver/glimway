import type { AreaPayload, LinkPayload, PromptPayload, QuestPayload, StatsPayload, ToastPayload } from '../game/events'
import type { HabiticaProfile, VitalsSource } from '../lib/habitica/types'
import { isMuted } from '../game/sfx'

/** Stored toast = payload plus a render key and optional icon. */
type StoredToast = ToastPayload & { id: string }

/** A quest beat or area title waiting to be shown. */
export interface Banner {
  id: string
  kind: 'quest' | 'area'
  eyebrow: string
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
  /** Wilds materials (server balances, or the guest pack). Null until the Wilds load. */
  materials = $state<Record<string, number> | null>(null)

  /** Mirrors of world/UI ownership flags, reactive for the interface. */
  dialogueOpen = $state(false)
  cinematic = $state(false)
  /** Speaker -> portrait data URL. */
  portraits = $state<Record<string, string>>({})
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
    const id = Math.random().toString(36).slice(2)
    const entry: StoredToast = { ...payload, id, kind: payload.kind ?? 'info' }
    this.toasts = [...this.toasts.slice(-2), entry]
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id)
    }, payload.kind === 'error' ? 6000 : 4200)
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

export const ui = new UiStore()
