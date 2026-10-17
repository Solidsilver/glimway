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

/** Why an entry waits at Pell's (RecoveryEntry.reason; '' is a lapse). */
export const RECOVERY_REASONS = { landChanged: 'land-changed', deedLost: 'deed-lost', packedUp: 'packed-up' } as const

/** Pell's opening line for entries waiting for a reason other than a lapse. */
const REASON_LINES: Record<string, [string, string]> = {
  [RECOVERY_REASONS.landChanged]: ['The land changed out past the Commons, and your old paths went with it. What you paid for them didn’t.', 'Every tile you laid, counted'],
  [RECOVERY_REASONS.deedLost]: ['Your lot went back to the deeds book. Before it did, I packed up everything on it.', 'Yours whenever you want it'],
  [RECOVERY_REASONS.packedUp]: ['You packed up your camp. It’s all here, every piece of it.', 'All of it, as you left it'],
}

/**
 * Pell's words for a crate waiting: what a lapse packed (the woods turned),
 * what the land changing or a lost deed sent here, then what each camp's
 * keeper moved off their camp, by keeper.
 */
export function crateLines(entries: readonly (Pick<RecoveryEntry, 'itemDef' | 'qty'> & { movedBy?: string; reason?: string })[]): string[] {
  const lapsed = entries.filter((e) => !e.movedBy && !e.reason)
  const lines = lapsed.length ? ['The woods turned. I have your things.', `In the crate: ${listed(lapsed.map(entryPhrase))}. Nothing’s missing. I counted.`] : []
  for (const [reason, [why, tail]] of Object.entries(REASON_LINES)) {
    const these = entries.filter((e) => !e.movedBy && e.reason === reason)
    if (these.length) lines.push(why, `In the crate: ${listed(these.map(entryPhrase))}. ${tail}.`)
  }
  const keepers = [...new Set(entries.map((e) => e.movedBy).filter((k): k is string => !!k))]
  for (const k of keepers) lines.push(`Moved off ${k}’s camp: ${listed(entries.filter((e) => e.movedBy === k).map(entryPhrase))}. I kept it safe for you.`)
  return lines
}

/** Pell's words once the crate is collected. */
export function collectedLine(entries: readonly Pick<RecoveryEntry, 'itemDef' | 'qty'>[]): string {
  return entries.length === 0 ? 'Nothing waiting for you. The book’s square.' : `Signed out to you: ${listed(entries.map(entryPhrase))}. The home pieces are in your pack.`
}

/** A camp refusal in words: the lot lantern's shared codes, said of a way-lamp. */
export const CAMP_ERRORS: Record<string, string> = {
  'cannot-hold': 'A way-lamp can’t hold this ground: it’s the town, the Tangle, a lot’s backland or someone else’s camp.',
  'too-far-away': 'Stand closer to the way-lamp.',
  'lantern-full': 'The lamp’s full. It takes three wicks of oil at most.',
  'not-in-world': 'You can only name people who live in this world.'
}

// ------------------------------------------------------------ who may build here

/**
 * Who may build at a camp (lamps.md 2.5), its keeper's to set: one rule and
 * one list of world members. The keeper always may; anyone may walk there
 * and add oil, whatever the rule. The server judges it (api/claim_rules.go).
 */
export type CampRule = 'household' | 'listed' | 'except' | 'everyone'

export const CAMP_RULES: readonly CampRule[] = ['household', 'listed', 'except', 'everyone']

/** The panel's words: its heading, and each rule as a choice and as a sentence. */
export const CAMP_RULE_WORDS = {
  heading: 'Who may build here',
  rules: {
    household: { pick: 'Just my household', line: 'You and your household build here.' },
    listed: { pick: 'My household and people I name', line: 'You, your household and the people you name build here.' },
    except: { pick: 'Everyone but people I name', line: 'Everyone in the world builds here, except the people you name.' },
    everyone: { pick: 'Everyone in the world', line: 'Everyone in the world builds here.' }
  } satisfies Record<CampRule, { pick: string; line: string }>,
  now: 'As it is',
  name: 'Name someone',
  noneToName: 'Everyone’s on the list already',
  unname: (name: string) => `Take ${name} off the list`,
  named: (names: string[]) => `Named: ${listed(names)}.`,
  noneNamed: 'No one named yet.',
  open: 'Anyone may still walk here and add oil.',
  pickWho: 'Who goes on the list?',
  done: 'Done'
} as const

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
  return who
    ? `This is ${who}’s camp, and ${who} says who builds here. You’re welcome to walk through and tend the lamp.`
    : 'This camp’s keeper says who builds here. You’re welcome to walk through and tend the lamp.'
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
  return [`Move ${owner}’s ${piece.toLowerCase()} off your camp? Pell keeps it in a crate for ${owner}. Nothing is lost.`]
}

/** Said once the keeper has moved it. */
export function movedOffLine(owner: string, piece: string): string {
  return `${owner}’s ${piece.toLowerCase()} is waiting at Pell’s for ${owner}.`
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
  const name = plant.toLowerCase()
  const whose = owner ? `${owner}’s ${name}, growing in the lamp’s light.` : `Your ${name}, growing in the lamp’s light.`
  return mayDig ? [whose, 'A trowel would dig it up.'] : [whose]
}

/** A camp plant's look: its only choice is to leave it (digging up is the trowel's). */
export const CAMP_PLANT_CHOICES = [{ text: 'Leave it', dismiss: true }] as const

/** The keeper's "pack up the camp": everything to Pell's at once, as at a lapse. */
export const CAMP_PACK_WORDS = {
  pack: { text: 'Pack up the camp', note: 'Everything here goes to Pell’s' },
  ask: [
    'Pack up the whole camp?',
    'Pell keeps every piece and plant in a crate for whoever it belongs to. The lamp and its oil wait there for you. Nothing is lost.',
    'Any path laid here comes back at the turning.'
  ],
  confirm: 'Pack it all up',
  keep: 'Leave it standing',
  done: 'The camp’s packed up. Everything waits at Pell’s.'
} as const
