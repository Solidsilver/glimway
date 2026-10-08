/**
 * What is on screen above the world while playing, and what each thing
 * holds back. App.svelte reads one list of the layers that are up and asks
 * this table, instead of each place spelling out its own list.
 *
 * The lists differ on purpose; each exception says why.
 */

/** Everything that can sit over the world, roughly top first. */
export type Layer =
  /** Signing in: the world choice, the origin choice, the lease question. */
  | 'gate'
  /** Taken over on another device, or signed out, mid-play. */
  | 'lease'
  /** The world-move screen. */
  | 'move'
  /** A title-screen confirm (new journey, discard, overwrite). */
  | 'confirm'
  /** The log-out confirm. */
  | 'logout'
  /** Naming a lamp or a place (src/ui/NamePrompt.svelte). */
  | 'naming'
  /** "Give up your place on the deed?" */
  | 'leave-deed'
  /** A panel (journal, bag, the workshop…). */
  | 'panel'
  /** The ending card. */
  | 'ending'
  /** A conversation. */
  | 'dialogue'
  /** A cinematic. */
  | 'cinematic'
  /** Arranging the homestead. */
  | 'placement'
  /** "You played on another device" (src/ui/LinkNotice.svelte). */
  | 'link-notice'
  /** A storybook card or quest ribbon. */
  | 'banner'
  /** Saving for a reload. */
  | 'reloading'

export type LayerFlags = Record<Layer, boolean>

const ORDER: readonly Layer[] = ['gate', 'lease', 'move', 'confirm', 'logout', 'naming', 'leave-deed', 'panel', 'ending', 'dialogue', 'cinematic', 'placement', 'link-notice', 'banner', 'reloading']

/** The layers that are up, top first. */
export function layersUp(flags: LayerFlags): Layer[] {
  return ORDER.filter((l) => flags[l])
}

/** What each layer holds back: any one of the listed layers being up does. */
export const BLOCKS = {
  /**
   * The world's own input (src/game/input.ts uiState.panelOpen): moving,
   * acting, the belt. Conversations and cinematics take input themselves,
   * and placement mode is input. The title-screen and log-out confirms never
   * show in play.
   */
  worldInput: ['panel', 'ending', 'gate', 'lease', 'naming', 'leave-deed', 'move'],
  /**
   * App's own keys (J, C, I, G, the emote digits, Escape). A panel doesn't
   * block them: they open, switch and close panels. Placement mode keeps
   * its keys only while no panel is over it (see App.svelte onKeyGlobal).
   */
  appKeys: ['dialogue', 'cinematic', 'confirm', 'gate', 'lease', 'move', 'reloading', 'ending'],
  /**
   * The one-time notices (the party prompt, "you were moved out", the
   * update notice): only on a clear screen, so they are really seen.
   */
  notices: ['move', 'link-notice', 'panel', 'cinematic', 'dialogue', 'ending', 'lease', 'gate', 'confirm', 'logout', 'placement', 'naming', 'leave-deed', 'banner'],
  /**
   * The "E: Talk" action prompt. Only what covers the world or takes its
   * input hides it; a gate, a lease or a move screen covers it anyway.
   */
  actionPrompt: ['dialogue', 'panel', 'cinematic', 'ending', 'placement'],
  /**
   * The homestead bar. It stays through placement (it is placement's own
   * bar), naming and the ending.
   */
  homeBar: ['panel', 'dialogue', 'cinematic', 'gate', 'lease']
} as const satisfies Record<string, readonly Layer[]>

/** True when any of `by` is up. */
export function blocked(up: readonly Layer[], by: readonly Layer[]): boolean {
  return up.some((l) => by.includes(l))
}
