/**
 * Camps (roadmap 0.13; docs/design/lamps.md §2.5, §2.7). A way-lamp set in a
 * Wilds chunk holds that one chunk while it has hearth oil, as a lot lantern
 * holds its backland: a wick burns at each turning, then it dims for a wick,
 * then the camp lapses and everything there waits in a crate at Pell's. Its
 * setter (and their household) set pieces out and plant there; anyone may
 * top the lamp up. The server judges all of it (api/camps.go, recovery.go).
 */
import type { CampView, RecoveryEntry } from './gen/glimway/v1/camps_pb.js'
import { HOMESTEAD_DATA } from './homestead.ts'
import { giftPhrase, itemName } from './items.ts'

export type CampLook = 'lit' | 'dimming'

export function campLook(c: Pick<CampView, 'dimming'>): CampLook {
  return c.dimming ? 'dimming' : 'lit'
}

/**
 * The way-lamp's own open-map frame for each oil state.
 */
export function campFrame(look: CampLook): string {
  return look === 'dimming' ? 'way-lamp-2' : 'way-lamp-1'
}

/** The chunk a world tile lies in (24-tile chunks). */
export function campChunk(tx: number, ty: number): { cx: number; cy: number } {
  return { cx: Math.floor(tx / 24), cy: Math.floor(ty / 24) }
}

/** The camp whose chunk holds a world tile, if any. */
export function campAtTile(camps: readonly CampView[], tx: number, ty: number): CampView | null {
  const { cx, cy } = campChunk(tx, ty)
  return camps.find((c) => c.cx === cx && c.cy === cy) ?? null
}

/** The tiles a camp's pieces and plants stand on (world tiles, "x,y"). */
export function campTaken(c: CampView): Set<string> {
  const out = new Set<string>()
  for (const p of c.pieces) {
    const def = HOMESTEAD_DATA.items.find((i) => i.id === p.itemDef)
    const [w, h] = def ? (p.rotation === 90 || p.rotation === 270 ? [def.footprint[1], def.footprint[0]] : def.footprint) : [1, 1]
    for (let y = p.y; y < p.y + h; y++) for (let x = p.x; x < p.x + w; x++) out.add(`${x},${y}`)
  }
  for (const p of c.plants) out.add(`${p.x},${p.y}`)
  return out
}

/**
 * Where to set something down beside the hero: the first open tile next to
 * their feet (above, then the sides, then below), in one chunk, nothing
 * standing on it. `open` is the ground as the client knows it; the server
 * has the last word.
 */
export function campSpot(feet: { tx: number; ty: number }, open: (tx: number, ty: number) => boolean, taken: ReadonlySet<string> = new Set()): { tx: number; ty: number } | null {
  const here = campChunk(feet.tx, feet.ty)
  for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const tx = feet.tx + dx, ty = feet.ty + dy
    const c = campChunk(tx, ty)
    if (c.cx !== here.cx || c.cy !== here.cy || taken.has(`${tx},${ty}`) || !open(tx, ty)) continue
    return { tx, ty }
  }
  return null
}

/** Whether one more flask fits. */
export function campHasRoom(c: Pick<CampView, 'oil'>): boolean {
  const r = HOMESTEAD_DATA.wayLamp
  return c.oil + r.wicksPerOil <= r.maxWicks
}

/** The readout at the lamp: whose it is, the wicks of oil left, and what the next turning brings. */
export function campLines(c: Pick<CampView, 'oil' | 'dimming' | 'setterName' | 'setterId' | 'naming'>, me: string | null): string[] {
  const max = HOMESTEAD_DATA.wayLamp.maxWicks
  const whose = c.setterId === me ? 'Your way-lamp.' : `${c.setterName || 'Someone'}’s way-lamp.`
  const wicks = `${c.oil} of ${max} ${max === 1 ? 'wick' : 'wicks'} of oil`
  // Its Keeper's naming first, as a stone's is (lamps.md 2.8).
  const named = c.naming?.text ? [`“${c.naming.text}”`] : []
  if (c.dimming) return [...named, `${whose} It’s guttering: ${wicks}. Unless it’s filled, it goes dark at the turning and the camp turns with it. Everything set out here would wait at Pell’s.`]
  if (c.oil === 0) return [...named, `${whose} It burns, ${wicks} left. It dims at the turning: fill it to keep this camp.`]
  return [...named, `${whose} It burns, ${wicks} left. The woods it lights hold while it does.`]
}

/** A camp lamp's name in the world: its naming's short name, or plain way-lamp. */
export function campLampName(c: Pick<CampView, 'naming'>): string {
  return c.naming?.shortName || 'Way-lamp'
}

/** What an entry is, in a list: "a wooden stool", "3 stone". */
function entryPhrase(e: Pick<RecoveryEntry, 'itemDef' | 'qty'>): string {
  return giftPhrase(e.itemDef, e.qty)
}

/** "a, b and c". */
function listed(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** Pell's words for a crate waiting: the lapse line, then what's in it. */
export function crateLines(entries: readonly Pick<RecoveryEntry, 'itemDef' | 'qty'>[]): string[] {
  if (entries.length === 0) return []
  return ['The woods turned. I have your things.', `In the crate: ${listed(entries.map(entryPhrase))}. Nothing’s missing. I counted.`]
}

/** Pell's words once the crate is collected. */
export function collectedLine(entries: readonly Pick<RecoveryEntry, 'itemDef' | 'qty'>[]): string {
  return entries.length === 0 ? 'Nothing waiting for you. The book’s square.' : `Signed out to you: ${listed(entries.map(entryPhrase))}. The home pieces are in your pack.`
}

/** A camp refusal in words: the lot lantern's shared codes, said of a way-lamp. */
export const CAMP_ERRORS: Record<string, string> = {
  'cannot-hold': 'A way-lamp can’t hold this ground: it’s the town, the Tangle, a lot’s backland or someone else’s camp.',
  'too-far-away': 'Stand closer to the way-lamp.',
  'lantern-full': 'The lamp’s full. It takes three wicks of oil at most.'
}

/** A piece's name at a camp. */
export function campPieceName(itemDef: string): string {
  return itemName(itemDef)
}
