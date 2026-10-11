/**
 * This wick's rumour in words (docs/design/open-map.md 2.10, decision 19):
 * Elara hints at one hidden find out there, built from content's phrase
 * tables (content/wilds.json `rumour`), so it never names coordinates: the
 * landmark it's tucked under, a compass word from the gate, "past the
 * river" when the Wend lies between, and a distance word by ring.
 *
 * No Phaser, no network.
 */
import { loadWilds } from './data.ts';

/** The rumour's parts, as the server sends them (`PlayerState.rumour`). */
export interface RumourParts {
  landmark: string;
  compass: string;
  ring: number;
  pastRiver: boolean;
  opened: boolean;
}

/**
 * The rumour's sentence: "Something's tucked under a split oak, north-west
 * of the gate, past the river. A fair walk." Parts content doesn't know
 * fall back to plain words, never to an id or a number.
 */
export function rumourSentence(r: Omit<RumourParts, 'opened'>): string {
  const t = loadWilds().rumour;
  const landmark = t.landmarks.find((l) => l.decor === r.landmark)?.phrase ?? 'an old landmark';
  const compass = t.compass.find((c) => c.dir === r.compass)?.phrase ?? 'out';
  const rings = [...t.distance].sort((a, b) => a.ring - b.ring);
  const distance = (rings.find((d) => d.ring === r.ring) ?? (r.ring > (rings.at(-1)?.ring ?? 0) ? rings.at(-1) : rings[0]))?.phrase ?? '';
  const values: Record<string, string> = { landmark, compass, river: r.pastRiver ? t.pastRiver : '', distance };
  return t.template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m).replace(/\s+/g, ' ').trim();
}

/**
 * What Elara says about the rumour now: the sentence while it waits, her
 * line once you've opened it, or that nothing has reached her (no rumour
 * this wick, or none read yet).
 */
export function rumourLines(r: RumourParts | null): { found: boolean; text: string } {
  const t = loadWilds().rumour;
  if (!r) return { found: false, text: t.none };
  if (r.opened) return { found: true, text: t.opened };
  return { found: false, text: rumourSentence(r) };
}
