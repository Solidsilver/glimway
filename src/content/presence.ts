/**
 * Copy for presence (phase 6): emote labels and speech bubbles, and the HUD
 * line. The emote ids themselves are shared content (content/presence.json,
 * validated by the server too); this only says how each one reads.
 */
import { PRESENCE } from '../lib/presence'

export interface EmoteCopy {
  /** Picker button label. */
  label: string
  /** What the bubble over the player says. */
  say: string
  /** Pixel icon (src/ui/Icon.svelte). */
  icon: string
}

const COPY: Record<string, EmoteCopy> = {
  wave: { label: 'Wave', say: 'Hello!', icon: 'person' },
  nod: { label: 'Nod', say: 'Mm-hm.', icon: 'check' },
  cheer: { label: 'Cheer', say: 'Hooray!', icon: 'star' },
  thanks: { label: 'Thanks', say: 'Thank you!', icon: 'heart' },
  lantern: { label: 'Lantern', say: 'Light the way!', icon: 'lantern' }
}

/** The emotes in shared order, each with its copy (unknown ids read as themselves). */
export const EMOTES: Array<{ id: string } & EmoteCopy> = PRESENCE.emotes.map((id) => ({
  id,
  ...(COPY[id] ?? { label: id.charAt(0).toUpperCase() + id.slice(1), say: `*${id}*`, icon: 'sparkle' })
}))

export function emoteSay(id: string): string {
  return EMOTES.find((e) => e.id === id)?.say ?? id
}

export const presenceCopy = {
  pickerTitle: 'Emote',
  pickerHint: 'Press 1–5, or G to close',
  here: (n: number) => (n === 1 ? '1 other here' : `${n} others here`),
  hereTitle: 'Other players in your world, in this area',
  wait: 'A moment…'
}
