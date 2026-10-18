/**
 * Camps (roadmap 0.13; docs/design/lamps.md §2.5, §2.7). A way-lamp set in a
 * Wilds chunk holds that one chunk while it has hearth oil, as a lot lantern
 * holds its backland: a wick burns at each turning, then it dims for a wick,
 * then the camp lapses and everything there waits in a crate at Pell's. Its
 * keeper says who builds there (their household by default); anyone may
 * top the lamp up. The server judges all of it (api/camps.go, recovery.go).
 */
import type { CampMember, CampView, RecoveryEntry } from './gen/glimway/v1/camps_pb.js'
import { HOMESTEAD_DATA } from './homestead.ts'
import { giftPhrase, itemName } from './items.ts'
import { CAMP_ERRORS as CAMP_ERROR_WORDS, CAMP_PLANT_WORDS, CAMP_REFUSAL, CAMP_RULE_WORDS, CAMP_WORDS, CRATE_LINES, CRATE_WORDS, LAMP_OIL, listed, MOVE_OFF_WORDS } from '../content/camps.ts'

// The words are content's (src/content/camps.ts); these are read from here too (CratePanel, the tests).
export { CAMP_PACK_WORDS, CAMP_PLANT_CHOICES, CAMP_RULE_WORDS, CRATE_WORDS } from '../content/camps.ts'

export type CampLook = 'lit' | 'dimming'

/** Dimming once its oil is gone: on its last wick, or guttering (map-lamps.ts landDimming, owner 2026-10-17). */
export function campLook(c: Pick<CampView, 'oil' | 'dimming'>): CampLook {
  return c.dimming || c.oil === 0 ? 'dimming' : 'lit'
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
  const whose = c.setterId === me ? CAMP_WORDS.yours : CAMP_WORDS.whose(c.setterName)
  const wicks = CAMP_WORDS.oil(c.oil, max)
  // Its Keeper's naming first, as a stone's is (lamps.md 2.8).
  const named = c.naming?.text ? [`“${c.naming.text}”`] : []
  if (c.dimming) return [...named, CAMP_WORDS.guttering(whose, wicks)]
  if (c.oil === 0) return [...named, CAMP_WORDS.lastWick(whose)]
  return [...named, CAMP_WORDS.burning(whose, wicks)]
}

/** A camp lamp's name in the world: its naming's short name, or plain way-lamp. */
export function campLampName(c: Pick<CampView, 'naming'>): string {
  return c.naming?.shortName || CAMP_WORDS.lampName
}

/** What an entry is, in a list: "a wooden stool", "3 stone". */
function entryPhrase(e: Pick<RecoveryEntry, 'itemDef' | 'qty'>): string {
  return giftPhrase(e.itemDef, e.qty)
}

/** Why an entry waits at Pell's (RecoveryEntry.reason; '' is a lapse). */
export const RECOVERY_REASONS = { landChanged: 'land-changed', deedLost: 'deed-lost', packedUp: 'packed-up' } as const

/**
 * Pell's words for a crate waiting: what a lapse packed (the woods turned),
 * what the land changing or a lost deed sent here, then what each camp's
 * keeper moved off their camp, by keeper.
 */
export function crateLines(entries: readonly (Pick<RecoveryEntry, 'itemDef' | 'qty'> & { movedBy?: string; reason?: string })[]): string[] {
  const lapsed = entries.filter((e) => !e.movedBy && !e.reason)
  const lines = lapsed.length ? [CRATE_LINES.lapsed, CRATE_LINES.inCrate(listed(lapsed.map(entryPhrase)), CRATE_LINES.lapsedTail)] : []
  for (const reason of Object.values(RECOVERY_REASONS)) {
    const these = entries.filter((e) => !e.movedBy && e.reason === reason)
    const [why, tail] = CRATE_LINES.reasons[reason]!
    if (these.length) lines.push(why, CRATE_LINES.inCrate(listed(these.map(entryPhrase)), tail))
  }
  const keepers = [...new Set(entries.map((e) => e.movedBy).filter((k): k is string => !!k))]
  for (const k of keepers) lines.push(CRATE_LINES.movedOff(k, listed(entries.filter((e) => e.movedBy === k).map(entryPhrase))))
  return lines
}

/** Pell's words once the crate is collected. */
export function collectedLine(entries: readonly Pick<RecoveryEntry, 'itemDef' | 'qty'>[]): string {
  return entries.length === 0 ? CRATE_WORDS.empty : CRATE_LINES.collected(listed(entries.map(entryPhrase)))
}

// ------------------------------------------------------------ Pell's crate picker (lamps.md 2.7)

type CrateEntry = Pick<RecoveryEntry, 'id' | 'kind' | 'itemDef' | 'qty'> & { movedBy?: string; reason?: string }

/** An entry as the picker lists it: what it is, why it's here, and whether it's a plant (taken whole or as its seed). */
export interface CrateRow { id: number; label: string; note: string; plant: boolean }

/** Why an entry waits, short: the note under it in the picker. */
function crateNote(e: Pick<CrateEntry, 'movedBy' | 'reason'>): string {
  const notes = CRATE_LINES.notes
  if (e.movedBy) return notes.movedOff(e.movedBy)
  if (e.reason === RECOVERY_REASONS.landChanged || e.reason === RECOVERY_REASONS.deedLost || e.reason === RECOVERY_REASONS.packedUp) return notes[e.reason]
  return notes.lapsed
}

/** The crate's entries as the picker lists them, in Pell's order (oldest first). */
export function crateRows(entries: readonly CrateEntry[]): CrateRow[] {
  return entries.map((e) => {
    const what = entryPhrase(e)
    return { id: e.id, label: what.charAt(0).toUpperCase() + what.slice(1), note: crateNote(e), plant: e.kind === 'plant' }
  })
}

/** The collect request for one entry (a plant whole, or as its seed), or for everything. */
export function cratePick(id: number | null, asSeed = false): { entries: number[]; asSeed: number[] } {
  return id === null ? { entries: [], asSeed: [] } : { entries: [id], asSeed: asSeed ? [id] : [] }
}

/** A camp refusal in words; a full lamp says its cap, from content. */
export const CAMP_ERRORS: Record<string, string> = {
  ...CAMP_ERROR_WORDS,
  'lantern-full': LAMP_OIL.full('The lamp', HOMESTEAD_DATA.wayLamp.maxWicks)
}

// ------------------------------------------------------------ who may build here

/**
 * Who may build at a camp (lamps.md 2.5), its keeper's to set: one rule and
 * one list of world members. The keeper always may; anyone may walk there
 * and add oil, whatever the rule. The server judges it (api/claim_rules.go).
 */
export type CampRule = 'household' | 'listed' | 'except' | 'everyone'

export const CAMP_RULES: readonly CampRule[] = ['household', 'listed', 'except', 'everyone']

/** A camp's rule as its keeper reads it (household when unset). */
export function campRule(c: Pick<CampView, 'rule'>): CampRule {
  return (CAMP_RULES as readonly string[]).includes(c.rule) ? (c.rule as CampRule) : 'household'
}

/** Whether the rule reads the list. */
export function ruleNames(rule: CampRule): boolean {
  return rule === 'listed' || rule === 'except'
}

/** The panel's line: the rule in a sentence, who's named (when it counts), and what stays open to all. */
export function campRuleLines(c: Pick<CampView, 'rule' | 'members'>): string[] {
  const rule = campRule(c)
  const parts: string[] = [CAMP_RULE_WORDS.rules[rule].line]
  if (ruleNames(rule)) parts.push(c.members.length ? CAMP_RULE_WORDS.named(c.members.map((m) => m.name)) : CAMP_RULE_WORDS.noneNamed)
  parts.push(CAMP_RULE_WORDS.open)
  return [parts.join(' ')]
}

/** World members the keeper could add: not on the list yet, and not the keeper. */
export function campNameable(c: Pick<CampView, 'members' | 'setterId'>, people: readonly CampMember[]): CampMember[] {
  const named = new Set(c.members.map((m) => m.accountId))
  return people.filter((p) => p.accountId !== c.setterId && !named.has(p.accountId))
}

/** The list with someone added, or taken off: account ids, as the rule operation sends them. */
export function withMember(c: Pick<CampView, 'members'>, id: string): string[] {
  const ids = c.members.map((m) => m.accountId)
  return ids.includes(id) ? ids : [...ids, id]
}

export function withoutMember(c: Pick<CampView, 'members'>, id: string): string[] {
  return c.members.map((m) => m.accountId).filter((m) => m !== id)
}

/** The refusal when you may not build at someone's camp: whose it is, and what you can still do. */
export function campRefusal(c: Pick<CampView, 'setterName'> | null): string {
  const who = c?.setterName
  return who ? CAMP_REFUSAL.named(who) : CAMP_REFUSAL.unnamed
}

/** A world member's name from the keeper's read, or "someone". */
export function personName(people: readonly CampMember[], id: string): string {
  return people.find((p) => p.accountId === id)?.name || 'someone'
}

/** Whose a camp piece or plant is: the name the camp read carries, else the world list's. */
export function ownerName(people: readonly CampMember[], p: { ownerId: string; ownerName?: string }): string {
  return p.ownerName || personName(people, p.ownerId)
}

/** Asked before the keeper moves someone's piece off: it goes to Pell's, still theirs. */
export function moveOffLines(owner: string, piece: string): string[] {
  return [MOVE_OFF_WORDS.ask(owner, piece)]
}

/** Said once the keeper has moved it. */
export function movedOffLine(owner: string, piece: string): string {
  return MOVE_OFF_WORDS.done(owner, piece)
}

/** A piece's name at a camp. */
export function campPieceName(itemDef: string): string {
  return itemName(itemDef)
}

// ------------------------------------------------------------ taking a camp apart

/**
 * A plant at a camp: whose it is. Anyone who may build there can dig one
 * up, and whoever planted it always can, but only with a trowel in hand
 * (./trowel.ts): the look never offers it, and says so to whoever may.
 */
export function campPlantLines(plant: string, owner: string | null, mayDig = false): string[] {
  const whose = owner ? CAMP_PLANT_WORDS.theirs(owner, plant) : CAMP_PLANT_WORDS.yours(plant)
  return mayDig ? [whose, CAMP_PLANT_WORDS.mayDig] : [whose]
}
