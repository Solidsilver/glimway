import type { ArrangeView, NamePrompt, PlacementView } from '../game/homestead'

/** Homestead UI state, written by App.svelte's bus wiring. */
class HomeUi {
  /** Standing where you may arrange your own place. */
  arrange = $state<ArrangeView>({ available: false, scene: null, tier: 0 })
  /** Placement mode (null when not arranging). */
  placement = $state<PlacementView | null>(null)
  /** Decoration art as data URLs (for the shop and the tray). */
  thumbs = $state<Record<string, string>>({})
  /** Naming a lantern post (null: not asked). */
  namePrompt = $state<NamePrompt | null>(null)
  /** Asking before striking your name from the deed. */
  leaveAsk = $state<{ place: string; shared: boolean } | null>(null)
  /** The homestead goal ("find your gate"), or null. */
  goal = $state<string | null>(null)
}

export const home = new HomeUi()
