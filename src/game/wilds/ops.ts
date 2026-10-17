/**
 * The open map's path and discover operations, by their outbox key
 * (server-first.md 2.4, open-map.md section 3 and 2.10). Each one is
 * tracked from the moment it is sent with the identity it was made under
 * (the world, the wick, its chunk's epoch) and the prediction it shows, and
 * settles exactly once, however its outcome arrives:
 *
 * - its own answer or refusal, or a replay after a lost answer, or a replay
 *   after a reload (the link's EV.wildsSettled, whoever waits);
 * - a refusal before it ever reached the outbox (its sender settles it).
 *
 * `pending` is not an outcome: the prediction stays until the outbox settles
 * the key. An answer for land that has turned since (another wick, another
 * epoch for its chunk, another world) is not applied: the Wilds are read
 * again instead. A refusal that shows the store was wrong (the pack, the
 * tile) asks for a fresh read too. A replay nobody here tracks (sent before
 * a reload) asks for a fresh read.
 */
import { FINDS, PATH_DONE, PATH_REFUSALS, WAY_NEWS } from '../../content/open-map.ts'
import { firstFindText, placeName, refusalText } from '../../lib/wilds/paths.ts'
import type { WildsClearResult, WildsDiscoverResult, WildsLayResult, WildsLiftResult } from '../../lib/gen/glimway/v1/operations_pb.js'
import type { WildsWay } from '../../lib/gen/glimway/v1/wilds_pb.js'
import { bus, EV } from '../events.ts'
import type { WildsSettledPayload } from '../event-names.ts'
import { sfx } from '../sfx.ts'
import { applyBalances, applyDiscovery, applyPathAnswer, chunkEpoch, knownPlaces, lootName, requestRead, settlePrediction, wildsEpoch, wildsLive, wildsView, type LootDrop } from './store.ts'
import { newKey } from '../../lib/api/client.ts'
import type { Session } from '../session.ts'

export type WildsOpKind = 'clear' | 'lay' | 'lift' | 'discover'

export interface WildsOp {
  key: string
  kind: WildsOpKind
  /** The world, the wick and the chunk's epoch it was made under. */
  world: string
  wick: string
  epoch: string
  cx: number
  cy: number
  /** The prediction it shows (path operations), settled with it. */
  token: number | null
  /** For the words: the tool action, the material, the decor cleared, the place found. */
  action?: string
  material?: string
  decor?: string
  place?: string
  /** Who sent it (a discover found by yourself says nothing). */
  account?: string
}

const ops = new Map<string, WildsOp>()
/** When a place may be asked about again after a refusal (ms), by place id. */
const retryAt = new Map<string, number>()
let last = '-'

/** Track an operation as it is sent. */
export function trackOp(op: WildsOp): void {
  ops.set(op.key, op)
}

/** Is this key still unsettled? */
export function tracked(key: string): boolean {
  return ops.has(key)
}

/** Stop tracking a key that never reached the outbox, keeping its prediction (it is sent again under a new key). */
export function release(key: string): void {
  ops.delete(key)
}

/** An unsettled discover for this place (no second key while it's unresolved). */
export function asking(place: string): boolean {
  for (const op of ops.values()) if (op.kind === 'discover' && op.place === place) return true
  return false
}

/** May this place be asked about now? Not while one is unresolved, nor before its retry time. */
export function mayAsk(place: string, now = Date.now()): boolean {
  return !asking(place) && now >= (retryAt.get(place) ?? 0)
}

/** Ask about a place again no sooner than `ms` from now. */
export function retryLater(place: string, ms: number): void {
  retryAt.set(place, Date.now() + ms)
}

/** The last outcome, as words for the playtest hooks (`landed:lay`, `refused:<code>`). */
export function lastOutcome(): string {
  return last
}

/** A refusal said before anything was sent (the client's own check): the hooks see it too. */
export function noteOutcome(outcome: string): void {
  last = outcome
}

/** Forget everything tracked (tests, a sign-out). */
export function forgetOps(): void {
  ops.clear()
  retryAt.clear()
  last = '-'
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m)

/** Refusals that show the store held something the world doesn't (the pack, the tile): read again. */
const NOT_DISPROVING = new Set(['too-far-away', 'offline', 'busy', 'pending', 'superseded', 'unauthorized', 'reload-needed'])

/** Is the land this operation was made in still the land the store holds? */
function current(op: WildsOp, world: string): boolean {
  const view = wildsView()
  if (!view || (op.world && world && op.world !== world)) return false
  if (view.wick.id !== op.wick) return false
  return op.kind === 'discover' || chunkEpoch(op.cx, op.cy)?.id === op.epoch
}

const say = (text: string, kind: 'thought' | 'gain' = 'thought') => bus.emit(EV.toast, { text, icon: 'map', kind })

/** An operation settled: apply it once (EV.wildsSettled, or its sender for a refusal before the outbox). */
export function settleWildsOp(p: WildsSettledPayload): void {
  const op = ops.get(p.key)
  if (!op) {
    // Sent before a reload (or settled already): the world is read again rather than guessed.
    if (p.outcome.ok || p.outcome.code !== 'offline') requestRead()
    return
  }
  ops.delete(p.key)
  if (op.token !== null) settlePrediction(op.token)
  if (!p.outcome.ok) return refused(op, p.outcome.code, p.world)
  last = `landed:${op.kind}`
  if (!current(op, p.world)) {
    // Committed in land that has turned since: nothing of it applies here; the balances are read again.
    requestRead()
    return
  }
  if (op.kind === 'discover') return found(op, p.outcome.result as WildsDiscoverResult)
  landed(op, p.outcome.result as WildsClearResult | WildsLayResult | WildsLiftResult)
}

function refused(op: WildsOp, code: string, world: string): void {
  last = `refused:${code}`
  if (code === 'epoch-ended') {
    bus.emit(EV.turning, { reason: 'epoch-ended' })
    return
  }
  if (op.kind === 'discover') {
    // Not yet (a step too far, the link busy): ask again in a moment, under a new key.
    if (op.place) retryLater(op.place, code === 'busy' ? 500 : code === 'too-far-away' || code === 'offline' ? 4000 : 60_000)
    return
  }
  say(refusalText(code, { action: op.action, material: op.material, extra: PATH_REFUSALS }))
  if (!NOT_DISPROVING.has(code) && current(op, world)) requestRead()
}

function landed(op: WildsOp, r: WildsClearResult | WildsLayResult | WildsLiftResult): void {
  const made = r.$typeName === 'glimway.v1.WildsLayResult' ? r.waysMade : []
  const broken = r.$typeName === 'glimway.v1.WildsLiftResult' ? r.waysBroken : []
  const rerouted = r.$typeName === 'glimway.v1.WildsLiftResult' ? r.waysRerouted : []
  const before = new Map(wildsView()?.ways ?? [])
  if (!applyPathAnswer(r.ground, r.materials, { made, broken, rerouted })) {
    requestRead()
    return
  }
  if (op.kind === 'clear' && op.decor && PATH_DONE.cleared[op.decor]) say(PATH_DONE.cleared[op.decor]!)
  for (const w of made) wayMade(w)
  for (const id of broken) {
    const w = before.get(id)
    if (w) say(fill(WAY_NEWS.broken, { way: w.name }))
  }
  for (const w of rerouted) say(fill(WAY_NEWS.rerouted, { way: w.name }))
}

/** A named way: said once, its name on the journal chip. */
function wayMade(w: WildsWay): void {
  const places = knownPlaces()
  const name = (id: string) => placeName(id, places.find((p) => p.id === id)?.kind ?? null)
  bus.emit(EV.toast, { text: fill(WAY_NEWS.made, { way: w.name, from: name(w.a), to: name(w.b) }), icon: 'map', kind: 'gain', gain: { to: 'journal', label: w.name } })
  sfx('discover')
}

/** Loot in a sentence's words: "2 stone, 2 fiber and 1 amber". */
export function lootWords(drop: LootDrop): string {
  const parts = drop.materials.map((m) => `${m.qty} ${lootName(m.id).toLowerCase()}`)
  if (drop.trinket) parts.push(lootName(drop.trinket))
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'nothing much')
}

function found(op: WildsOp, r: WildsDiscoverResult): void {
  const d = r.discovery
  if (!d || !applyDiscovery({ entityId: d.entityId, poiId: d.poiId, discovererId: d.discovererId, displayName: d.displayName }, r.epoch)) {
    requestRead()
    return
  }
  if (r.first) {
    const drop: LootDrop = { materials: (r.loot?.materials ?? []).map((m) => ({ id: m.id, qty: m.qty })), trinket: r.loot?.trinket ?? null }
    applyBalances(r.materials)
    sfx('discover')
    const art = drop.trinket ? `icon-${drop.trinket}` : drop.materials[0] ? `icon-${drop.materials[0].id}` : undefined
    const first = drop.trinket ?? drop.materials[0]?.id
    if (drop.materials.length || drop.trinket) {
      bus.emit(EV.toast, { text: firstFindText(lootWords(drop)), icon: 'sparkle', art, kind: 'gain', ...(first ? { gain: { to: 'bag', itemDef: first, label: lootWords(drop) } } : {}) })
    } else say(FINDS.firstEmpty)
  } else if (op.place && d.displayName && d.discovererId !== op.account) {
    say(FINDS.foundBefore.replace('{name}', d.displayName))
  }
}

/**
 * Tell the server you reached a place (no button). One key a place while it
 * is unresolved: a lost answer is settled by its replay, never asked again
 * under a new key; a refusal before the outbox (busy, offline) may be asked
 * again later. `where` is the hero's world pixels.
 */
export async function discoverPlace(session: Session, place: { id: string; cx: number; cy: number }, where: { x: number; y: number }): Promise<void> {
  const link = session.link
  const wick = wildsEpoch('wick').id
  if (!link || !wick || !wildsLive(session) || !mayAsk(place.id)) return
  const key = newKey()
  // A held chunk's place (`<id>@<epoch>`, placeKey) is found in that chunk's pinned epoch.
  const [id, pinned] = place.id.split('@') as [string, string | undefined]
  const epoch = pinned ?? wick
  trackOp({ key, kind: 'discover', world: link.worldId, wick, epoch, cx: place.cx, cy: place.cy, token: null, place: place.id, account: link.accountId })
  const res = await link.wildsDiscover({ epoch, place: id, where: { area: 'outdoors', x: Math.round(where.x), y: Math.round(where.y) }, key })
  if (res.ok || !tracked(key)) return
  // In the outbox, unanswered: its replay settles it (this key, never a new one).
  if (res.code === 'pending') return
  // Refused before it reached the outbox (busy, offline): settled here.
  settleWildsOp({ kind: 'wilds-discover', key, world: link.worldId, outcome: { ok: false, code: res.code } })
}

bus.on(EV.wildsSettled, settleWildsOp)
