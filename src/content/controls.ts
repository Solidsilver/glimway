/**
 * The Menu's controls list, for keyboards and for touch. Each keyboard row
 * names its touch equivalent (or says there is none), so the two lists can
 * never drift apart; tests/world.test.ts holds them to that.
 */

export interface ControlRow {
  /** Key caps, as shown. */
  keys: string[]
  does: string
  /** What to use on a touch screen, or null when there's no touch equivalent. */
  touch: string | null
}

export const CONTROLS: ControlRow[] = [
  { keys: ['W', 'A', 'S', 'D'], does: 'Walk (arrows work too)', touch: 'Joystick (bottom left)' },
  { keys: ['E', 'Space'], does: 'Talk, use, attack — or hold up the rubbing', touch: 'The big action button (its label says what it will do)' },
  { keys: ['F'], does: 'Signature ability', touch: 'The ✦ button (shows its mana cost)' },
  { keys: ['Shift'], does: 'Dodge roll — move when the enemy flashes white', touch: 'The Roll button' },
  { keys: ['J', 'C'], does: 'Journal · Character', touch: 'The book and person buttons, top right' },
  { keys: ['B'], does: 'Arrange your home (on your plot or in your cottage)', touch: 'The Arrange button, top right' },
  { keys: ['G'], does: 'Emotes, then 1–5 (in a world)', touch: 'The speech button, top right (in a world)' },
  { keys: ['M'], does: 'Ride your mount (Habitica heroes, outdoors)', touch: null },
  { keys: ['Esc'], does: 'Menu · close panels', touch: 'The menu button, top right' }
]

/** The touch list: every row with a touch equivalent, in the same order. */
export const TOUCH_CONTROLS: Array<{ control: string; does: string }> = CONTROLS.filter((r) => r.touch !== null).map((r) => ({
  control: r.touch!,
  does: r.does.replace(/ \(arrows work too\)/, '').replace(/ — move when the enemy flashes white/, ' when the enemy flashes white')
}))
