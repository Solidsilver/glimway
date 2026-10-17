/**
 * Communal lamps (roadmap 0.13; docs/design/lamps.md §1.3, §2.4): Common
 * light, kept by presence, never by oil. Anyone relights a dark lamp stone
 * of the Lantern Road (it burns a lamp wick) or sets a way-lamp as a
 * communal post (no oil, no store). One visit to its chunk in the wick keeps
 * it lit through the turning; a wick nobody comes, a stone goes dark again
 * and a post waits for its setter at Pell's. Only a post's setter takes it
 * down. The server judges all of it (api/communal_lamps.go).
 *
 * Until a Keeper names a lamp (the Keeper's-hand lane) it goes by a neutral
 * label, so the map's ledger and the world say the same thing.
 */
import type { CommunalLampView } from './gen/glimway/v1/lamps_pb.js'
import { HOMESTEAD_DATA } from './homestead.ts'
import { giftPhrase } from './items.ts'
import { MAP_LAMPS } from '../content/map-lamps.ts'

/** What a lamp is called before anyone names it: the map ledger's word, so the world and the map agree. */
export const COMMUNAL_LAMP_LABEL: string = MAP_LAMPS.names['common-lamp'] ?? 'Common lamp'

/** A lamp's short name: its naming's, or the neutral label. */
export function communalLampName(l: Pick<CommunalLampView, 'naming'>): string {
  return l.naming?.shortName || COMMUNAL_LAMP_LABEL
}

/**
 * A post's frame: the way-lamp's lit frame (open-map pass), the same lamp
 * a camp burns, here kept by passers-by.
 */
export const COMMUNAL_POST_FRAME = 'way-lamp-1'

/**
 * A Lantern Road stone's open-map art (assets/generated/open-map-pass/):
 * its frame, and its slow wick loop while lit (the pass's animations.json).
 * The Keeper's-hand quest stone (the read's cut_stone) is the route stone,
 * the same lamp stone with Wenna's cut panel beside it. Relit frames match
 * the dark ones texel for texel outside the niche, so either is drawn over
 * the dark stone the chunk already shows.
 */
export interface RoadStoneArt {
  frame: string
  loop: string | null
  route: boolean
}

export function roadStoneArt(site: string, cutStone: string, lit: boolean): RoadStoneArt {
  const route = site !== '' && site === cutStone
  const base = route ? 'route-stone' : 'lamp-stone'
  return lit ? { frame: `${base}-relit-0`, loop: `${base}-relit`, route } : { frame: `${base}-dark`, loop: null, route }
}

/** Where the lamp stands across a route stone's 2×1 canvas: the stone fills its left half, the cut panel its right. */
export const ROUTE_STONE_ORIGIN_X = 0.25

/** The lit lamp standing for a road stone's site, if it's lit. */
export function litStone(lamps: readonly CommunalLampView[], site: string): CommunalLampView | null {
  return lamps.find((l) => l.kind === 'stone' && l.id === site) ?? null
}

/** The lamps in a chunk and its eight neighbours (the ones the open map draws around the hero). */
export function lampsNear(lamps: readonly CommunalLampView[], cx: number, cy: number): CommunalLampView[] {
  return lamps.filter((l) => Math.abs(l.cx - cx) <= 1 && Math.abs(l.cy - cy) <= 1)
}

/** The tiles lit lamps stand on (world tiles, "x,y"), so nothing is set down on one. */
export function lampTiles(lamps: readonly CommunalLampView[]): Set<string> {
  return new Set(lamps.map((l) => `${l.x},${l.y}`))
}

/** What relighting a stone burns, in words ("a lamp wick"), or null when it's free. */
export function relightCost(): string | null {
  const r = HOMESTEAD_DATA.communalLamp
  return r.relightQty > 0 ? giftPhrase(r.relight, r.relightQty) : null
}

/** Whether the pack holds enough to relight a stone. */
export function canRelight(carried: number): boolean {
  return carried >= HOMESTEAD_DATA.communalLamp.relightQty
}

/** Only a post's setter takes it down; a stone stays where the road put it. */
export function canLift(l: Pick<CommunalLampView, 'kind' | 'setterId'>, me: string | null): boolean {
  return l.kind === 'post' && me !== null && l.setterId === me
}

/** Who lit it, in a sentence. */
function whose(l: Pick<CommunalLampView, 'kind' | 'setterId' | 'setterName'>, me: string | null): string {
  const verb = l.kind === 'stone' ? 'lit' : 'set'
  return l.setterId === me ? `You ${verb} it.` : `${l.setterName || 'Someone'} ${verb} it.`
}

/** What becomes of it at the turning, as things stand. */
function outlook(l: Pick<CommunalLampView, 'kind' | 'visited'>): string {
  if (l.visited) return 'Someone’s been by this wick, so it stays lit through the turning.'
  return l.kind === 'stone'
    ? 'Nobody’s been by this wick yet. If nobody comes, it goes dark at the turning.'
    : 'Nobody’s been by this wick yet. If nobody comes, it goes back to its setter by way of Pell’s.'
}

/** The readout at a lit lamp: its naming if it has one, who lit it, and the coming turning. */
export function communalLampLines(l: Pick<CommunalLampView, 'kind' | 'setterId' | 'setterName' | 'visited' | 'naming'>, me: string | null): string[] {
  const head = l.naming?.text ? `“${l.naming.text}”` : l.kind === 'stone' ? 'An old lamp stone, burning again. It asks for no oil.' : 'A communal lamp, free to anyone passing. It asks for no oil.'
  return [head, `${whose(l, me)} ${outlook(l)}`]
}

/** The look at a dark stone: what it is, and what lighting it takes. */
export function darkStoneLines(stoneWords: string): string[] {
  const cost = relightCost()
  return [stoneWords, cost ? `Its niche still takes a wick. Light it with ${cost} and anyone passing keeps it burning.` : 'Its niche still takes a wick. Light it, and anyone passing keeps it burning.']
}

/** What a done thing says. */
export const COMMUNAL_LAMP_DONE = {
  relight: 'The stone takes the light. Walk this way now and then and it keeps.',
  tend: 'You trim the wick. Your visit counts this wick.',
  post: 'The lamp is lit for anyone passing. A visit each wick keeps it.',
  lift: 'You take your lamp down. It’s in your pack.'
} as const

/** A communal-lamp refusal in words, where it differs from the shared ones. */
export const COMMUNAL_LAMP_ERRORS: Record<string, string> = {
  'too-far-away': 'Stand closer to the lamp.',
  'insufficient-materials': 'You need a lamp wick to light it.',
  'land-blocked': 'There’s no open ground beside you for a lamp.'
}
