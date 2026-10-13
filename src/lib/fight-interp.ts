/** Server fight observation and prediction. No Phaser; every clock is injected.
 * Tick stamps, never receipt stamps, own poses. No extrapolation or synthetic
 * still samples: missing deltas hold the last known row.
 */
import type { FightEnemy, FightJoin, FightDelta, FightEvent, FightSwingResult, FightRoomKey } from './gen/glimway/v2/presence_pb.js'
import { fightTickDiff, fightTickAt, fightCrit } from './fight-math.ts'
import type { FightTargetRef } from './presence.ts'

type Payload<T> = Omit<T, '$typeName' | '$unknown'>
type Sample = { ms: number; row: FightEnemy }
type Track = { life: number; samples: Sample[]; knock?: { x: number; y: number; at: number }; windup?: { tick: number; ms: number; lockMs?: number }; removedAt?: number }
type Room = { closedUntil?: number; key: FightRoomKey; tick: number; received: number; incarnation: number; tracks: Map<number, Track>; camps: Map<string, Map<number, boolean>> }
/** `life`: one enemy's life on this screen. A resync keeps it; a new row (a spawn, a cycle's respawn) gets a new one. */
export interface FightDraw { incarnation: number; life: number; room: number; row: FightEnemy; x: number; y: number; elapsedMs: number; telegraphMs?: number; telegraphTick?: number; aimLocked?: boolean }
export interface FightMeasures {
  /** Feed-wide for this socket session; clear/seed replacement resets it, room churn does not. */
  scope: 'socket-session'
  snapshotGapP95: number; snapshotSamples: number; interpolationDelay: number
  hitConfirmationP95: number; confirmations: number; predictedRows: number
  refusedRows: number; refusedPercent: number; swingRefusals: number; timeouts: number; pending: number
}
export const FIGHT_RESULT_TIMEOUT = 3000
/** Covers a paced position report and a jittered view rejoin at a chunk edge. */
export const FIGHT_RESYNC_GRACE = 750

/** Bounded percentile histories. Idle rooms emit no delta, so gap statistics
 * count only consecutive active ticks; skipped/idle tick gaps are excluded. */
export class FightInterp {
  readonly rooms = new Map<number, Room>()
  seed = 0
  private incarnation = 0
  private lives = 0
  private anchor: { tick: number; ms: number } | null = null
  private clockOffset = Infinity
  private delay = 100
  private lastDraw = -Infinity
  private adjustedAt = 0
  private gaps: number[] = []
  private confirmations: number[] = []
  private pending = new Map<number, { at: number; targets: FightTargetRef[] }>()
  private events: { event: Payload<FightEvent>; ms: number }[] = []
  private eventKeys = new Set<string>()
  private predictedRows = 0
  private refusedRows = 0
  private swingRefusals = 0
  private timeouts = 0
  private confirmationCount = 0
  private frameMs = 0
  private frameSeen: { tick: number; offsetMs: number } | null = null
  private readonly now: () => number

  constructor(now: () => number) { this.now = now }

  private stamp(tick: number, offset = 0): number {
    if (!this.anchor) this.anchor = { tick, ms: tick * 100 }
    return this.anchor.ms + fightTickDiff(tick, this.anchor.tick) * 100 + offset
  }
  private clock(tick: number): number {
    const ms = this.stamp(tick)
    // Minimum observed transit time: jitter cannot pull the clock backwards.
    this.clockOffset = Math.min(this.clockOffset, this.now() - ms)
    return ms
  }

  join(join: Payload<FightJoin>): void {
    if (!join.roomKey || !join.room || !join.critSeed) return
    if (this.seed && this.seed !== join.critSeed) this.clear()
    this.seed = join.critSeed
    const ms = this.clock(join.tick)
    const now = this.now()
    // The same physical room and epoch, live or inside its close grace: a refresh (a new view
    // handle only rewrites wire references). Nothing resets on a chunk crossing.
    const resync = [...this.rooms.entries()].find(([, room]) => sameRoomKey(room.key, join.roomKey!) && (room.closedUntil === undefined || now < room.closedUntil))
    if (resync) {
      const [oldHandle, room] = resync
      // Full joins refresh truth; matching enemy ids retain interpolation and
      // presentation, even if the view's handle changes. Keep old samples until
      // the join stamp is drawn, avoiding another delay-sized blank interval.
      const tracks = new Map<number, Track>()
      const deaths: number[] = []
      for (const row of join.enemies) {
        const found = [...room.tracks.values()].find(track => track.samples.at(-1)!.row.id === row.id)
        // A dead row that stands again is a new life (a respawn reusing its id), never a resurrection.
        const old = found && !(found.samples.at(-1)!.row.state === 6 && row.state !== 6) ? found : undefined
        if (old) {
          if (row.state === 6 && old.samples.at(-1)!.row.state !== 6) deaths.push(row.enemy)
          old.samples = old.samples.filter(sample => sample.ms <= ms).map(sample => ({ ...sample, row: { ...sample.row, enemy: row.enemy } }))
          old.samples.push({ ms, row: { ...row } })
          if (old.samples.length > 24) old.samples.splice(0, old.samples.length - 24)
          delete old.removedAt
          tracks.set(row.enemy, old)
        } else tracks.set(row.enemy, this.track(ms, row))
      }
      // Removed rows leave when the refresh reaches the drawing clock.
      const kept = new Set(tracks.values())
      for (const [index, track] of room.tracks) if (!kept.has(track)) { track.removedAt ??= ms; tracks.set(tracks.has(index) ? -1 - track.life : index, track) }
      this.drop(oldHandle)
      room.tracks = tracks; room.tick = join.tick; room.received = now
      room.camps = new Map(); delete room.closedUntil
      this.rooms.set(join.room, room)
      for (const row of join.enemies) this.campRow(room, row)
      // A refresh can confirm a death whose event was missed during the view gap.
      for (const enemy of deaths) this.event({ room: join.room, tick: join.tick, offsetMs: 0, kind: 3, enemy })
      return
    }
    // A genuinely new wake/epoch replaces the physical room immediately.
    for (const [handle, room] of this.rooms) {
      const k = room.key, n = join.roomKey
      if (handle === join.room || (k.world === n.world && k.realm === n.realm && k.layer === n.layer && k.cx === n.cx && k.cy === n.cy)) this.drop(handle)
    }
    this.rooms.set(join.room, { key: join.roomKey, incarnation: ++this.incarnation, tick: join.tick, received: now, camps: new Map(), tracks: new Map(join.enemies.map(row => [row.enemy, this.track(ms, row)])) })
    for (const row of join.enemies) this.campRow(this.rooms.get(join.room)!, row)
  }

  delta(delta: Payload<FightDelta>): void {
    const room = this.rooms.get(delta.room)
    if (!room || fightTickDiff(delta.tick, room.tick) < 0) return
    const now = this.now(), ms = this.clock(delta.tick)
    const gap = now - room.received
    // Coalesce back-to-back receipts within 1 ms, including high-resolution
    // callback clocks. Rendering cadence never suppresses independent arrivals.
    if (fightTickDiff(delta.tick, room.tick) === 1 && gap > 1) {
      bounded(this.gaps, gap)
      const variation = Math.abs(gap - 100)
      // Rise quickly under jitter, settle slowly over ~5 seconds.
      this.delay = Math.min(200, Math.max(this.delay, 100 + variation))
    }
    room.tick = delta.tick; room.received = now
    for (const patch of delta.changed) {
      const track = room.tracks.get(patch.enemy)
      if (!track) continue
      const row = { ...track.samples[track.samples.length - 1]!.row }
      for (const key of ['x', 'y', 'state', 'stateTick', 'hp', 'facing'] as const) {
        if (patch[key] !== undefined) (row[key] as number) = patch[key]!
      }
      this.campRow(room, row)
      track.samples.push({ ms, row })
      if (track.samples.length > 24) track.samples.shift()
    }
    for (const index of delta.removed) {
      const track = room.tracks.get(index)
      if (!track) continue
      // Rows are the truth: a removed row stops counting for its camp at once, and leaves the screen at its stamp.
      track.removedAt = ms
      room.camps.get(track.samples.at(-1)!.row.campId)?.delete(index)
    }
    for (const row of delta.spawned) {
      const old = room.tracks.get(row.enemy)
      if (old) room.tracks.set(-1 - old.life, { ...old, removedAt: old.removedAt ?? ms })
      room.tracks.set(row.enemy, this.track(ms, row)); this.campRow(room, row)
    }
  }

  event(event: Payload<FightEvent>): void {
    if (!this.rooms.has(event.room)) return
    const key = `${event.room}:${event.enemy}:${event.kind}:${event.tick}:${event.offsetMs}`
    if (this.eventKeys.has(key)) return
    this.eventKeys.add(key)
    if (this.eventKeys.size > 512) this.eventKeys.delete(this.eventKeys.values().next().value!)
    if (event.kind === 5) this.rooms.get(event.room)!.closedUntil ??= this.now() + FIGHT_RESYNC_GRACE
    this.events.push({ event, ms: this.stamp(event.tick, event.offsetMs) })
    this.events.sort((a, b) => a.ms - b.ms)
  }

  /** Once per observation frame, shared by every enemy and attack that frame. */
  observe(): { event: Payload<FightEvent>; elapsedMs: number }[] {
    const now = this.now()
    const dt = this.adjustedAt ? Math.max(0, now - this.adjustedAt) : 0
    this.adjustedAt = now
    this.delay = Math.max(100, this.delay - dt * .02)
    this.expire(now)
    if (!this.anchor) { this.frameSeen = null; return [] }
    this.frameMs = Math.max(this.lastDraw, now - this.clockOffset - this.delay)
    this.lastDraw = this.frameMs
    this.frameSeen = fightTickAt(this.frameMs)
    const due = []
    while (this.events[0] && this.events[0].ms <= this.frameMs) {
      const { event, ms } = this.events.shift()!
      const track = event.enemy === undefined ? undefined : this.rooms.get(event.room)?.tracks.get(event.enemy)
      if (track && event.kind === 1) track.windup = { tick: event.tick, ms }
      if (track?.windup && event.kind === 2) track.windup.lockMs = ms
      if (event.kind === 3) {
        const room = this.rooms.get(event.room)
        for (const camp of room?.camps.values() ?? []) if (event.enemy !== undefined && camp.has(event.enemy)) camp.set(event.enemy, true)
      }
      due.push({ event, elapsedMs: this.frameMs - ms })
    }
    for (const [handle, room] of this.rooms) if (room.closedUntil !== undefined && now >= room.closedUntil) this.drop(handle)
    for (const room of this.rooms.values()) for (const [index, track] of room.tracks) if (track.removedAt !== undefined && track.removedAt <= this.frameMs) room.tracks.delete(index)
    return due
  }

  /** The exact instant used by draw(), retained for press-time targeting. */
  seen(): { tick: number; offsetMs: number } | null { return this.frameSeen }

  draw(): FightDraw[] {
    const out: FightDraw[] = []
    for (const [handle, room] of this.rooms) for (const track of room.tracks.values()) {
      const samples = track.samples
      // A join/spawn has no history before its first server stamp.
      if (samples[0]!.ms > this.frameMs) continue
      let a = samples[0]!, b = a
      for (const sample of samples) {
        if (sample.ms <= this.frameMs) a = sample
        else { b = sample; break }
        b = a
      }
      const share = b.ms > a.ms ? Math.max(0, Math.min(1, (this.frameMs - a.ms) / (b.ms - a.ms))) : 0
      const knock = track.knock
      const blend = knock ? Math.max(0, 1 - (this.now() - knock.at) / 150) : 0
      const windup = track.windup
      const telegraphMs = windup && fightTickDiff(a.row.stateTick, windup.tick) <= 0 && a.row.state !== 6 ? Math.max(0, this.frameMs - windup.ms) : undefined
      out.push({ incarnation: room.incarnation, life: track.life, telegraphMs, telegraphTick: telegraphMs === undefined ? undefined : windup?.tick, aimLocked: !!windup?.lockMs && this.frameMs >= windup.lockMs, room: handle, row: a.row, x: a.row.x + (b.row.x - a.row.x) * share + (knock?.x ?? 0) * blend, y: a.row.y + (b.row.y - a.row.y) * share + (knock?.y ?? 0) * blend, elapsedMs: Math.max(0, this.frameMs - this.stamp(a.row.stateTick)) })
    }
    return out
  }

  private track(ms: number, row: FightEnemy): Track { return { life: ++this.lives, samples: [{ ms, row: { ...row } }] } }

  private campRow(room: Room, row: FightEnemy): void {
    let camp = room.camps.get(row.campId)
    if (!camp) room.camps.set(row.campId, camp = new Map())
    camp.set(row.enemy, row.state === 6)
  }
  /** True: every row the camp has in a room of this epoch is confirmed dead; false: one stands; undefined: no room shows it. */
  campWon(id: string, epoch: string): boolean | undefined {
    for (const room of this.rooms.values()) {
      const camp = room.camps.get(id)
      if (room.key.epoch === epoch && camp?.size) return [...camp.values()].every(Boolean)
    }
    return undefined // absent room is unknown, not a confirmed live camp
  }

  knock(target: FightTargetRef, x: number, y: number): void {
    const track = this.rooms.get(target.room)?.tracks.get(target.enemy)
    if (track) track.knock = { x, y, at: this.now() }
  }
  crit(counter: number, chance: number): boolean { return !!this.seed && fightCrit(this.seed, counter, chance) }
  sent(counter: number, targets: FightTargetRef[]): void {
    this.pending.set(counter, { at: this.now(), targets: targets.map(t => ({ ...t })) })
    this.predictedRows += targets.length
  }
  unsent(counter: number): void {
    const pending = this.pending.get(counter)
    if (pending) { this.predictedRows -= pending.targets.length; this.pending.delete(counter) }
  }
  result(result: Payload<FightSwingResult>): void {
    const pending = this.pending.get(result.swingCounter)
    if (!pending) return // duplicates and results from an earlier socket
    this.pending.delete(result.swingCounter)
    bounded(this.confirmations, this.now() - pending.at); this.confirmationCount++
    if (result.refusedReason) this.swingRefusals++
    else for (const hit of result.hits) {
      if (hit.refusedReason && pending.targets.some(t => t.room === hit.room && t.enemy === hit.enemy)) this.refusedRows++
    }
    // HP always comes from snapshots, so refusals need no corrective effect.
  }
  private expire(now: number): void {
    for (const [counter, pending] of this.pending) if (now - pending.at >= FIGHT_RESULT_TIMEOUT) { this.pending.delete(counter); this.timeouts++ }
  }
  measures(): FightMeasures {
    this.expire(this.now())
    return { scope: 'socket-session', snapshotGapP95: percentile(this.gaps), snapshotSamples: this.gaps.length, interpolationDelay: this.delay, hitConfirmationP95: percentile(this.confirmations), confirmations: this.confirmationCount, predictedRows: this.predictedRows, refusedRows: this.refusedRows, refusedPercent: this.predictedRows ? this.refusedRows / this.predictedRows * 100 : 0, swingRefusals: this.swingRefusals, timeouts: this.timeouts, pending: this.pending.size }
  }
  drop(handle: number): void {
    this.rooms.delete(handle)
    this.events = this.events.filter(e => e.event.room !== handle)
  }
  clear(): void {
    this.rooms.clear(); this.pending.clear(); this.events = []; this.eventKeys.clear()
    this.seed = 0; this.anchor = null; this.clockOffset = Infinity; this.lastDraw = -Infinity
    this.delay = 100; this.frameSeen = null; this.adjustedAt = 0
    this.gaps = []; this.confirmations = []
    this.predictedRows = 0; this.refusedRows = 0; this.swingRefusals = 0; this.timeouts = 0; this.confirmationCount = 0
  }
}
function bounded(list: number[], value: number): void { list.push(value); if (list.length > 512) list.shift() }
function percentile(list: number[]): number { const sorted = [...list].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0 }

function sameRoomKey(a: FightRoomKey, b: FightRoomKey): boolean { return a.world === b.world && a.realm === b.realm && a.layer === b.layer && a.cx === b.cx && a.cy === b.cy && a.epoch === b.epoch }
