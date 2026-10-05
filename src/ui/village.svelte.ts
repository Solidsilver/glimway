import type { CalendarDay } from '../lib/calendar'

/** Village-life UI state, written by App.svelte's bus wiring. */
class VillageUi {
  /** Today in Hearthwick (server's when connected, else this device's). */
  calendar = $state<CalendarDay | null>(null)
  /** Parcels waiting in your mailbox. */
  waiting = $state(0)
}

export const villageUi = new VillageUi()
