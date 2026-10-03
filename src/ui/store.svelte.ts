import type { AreaPayload, PromptPayload, QuestPayload, StatsPayload, ToastPayload } from '../game/events'
import type { HabiticaProfile, VitalsSource } from '../lib/habitica/types'

/** Stored toast = payload plus a render key. */
type StoredToast = ToastPayload & { id: string }

/**
 * Reactive snapshot of the game's meaningful state events for the interface.
 * Written by App.svelte's bus wiring, read by UI components.
 */
class UiStore {
  stats = $state<StatsPayload>({ hp: 5, maxHp: 5, mana: 5, maxMana: 5 })
  quest = $state<QuestPayload>({ stage: 'new', objective: '' })
  area = $state<AreaPayload>({ areaId: 'village', name: 'Village', description: '' })
  prompt = $state<PromptPayload>({ label: null })
  toasts = $state<StoredToast[]>([])
  defeatCount = $state(0)
  /** Save provenance (format 2), shown in the character panel. */
  vitalsSource = $state<VitalsSource>('demo')
  importedProfile = $state<HabiticaProfile | null>(null)

  toast(payload: ToastPayload): void {
    const id = Math.random().toString(36).slice(2)
    const entry: StoredToast = { ...payload, id, kind: payload.kind ?? 'info' }
    this.toasts = [...this.toasts.slice(-3), entry]
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id)
    }, 3800)
  }
}

export const ui = new UiStore()
