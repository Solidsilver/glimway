/**
 * A generated camp's claim prompt on this client (shared-fights.md 1.9; step-back
 * review F6). Every camp is fought in its server room. The server's word is the
 * near read's `camp_claimable` for the camp's exact cycle (a stored fall that
 * lists this account, not yet claimed): that alone makes a camp claimable. The
 * room only hurries the word along and hides a prompt it contradicts:
 *
 * - Rows all confirmed dead (the last death, or a join with only corpses) while
 *   the store has no word for this cycle: ask for fresh near reads, spaced
 *   until recovery ends (the fall is written off the tick). Dead rows never grant a
 *   claim, so an older cycle's corpses can't make the next cycle claimable.
 * - Rows that stand (a respawn) hide the prompt at once.
 * - No room, or no socket: the store's last word for this cycle stands.
 * - A new epoch or cycle starts over; a claim settled (or refused as already
 *   claimed, or condition-unmet: not a witness) ends this cycle's prompt for this account until
 *   the next read says otherwise for a new cycle.
 *
 * No Phaser: the host reads the feed and asks the store for a read.
 */

/** A camp as the store holds it now. */
export interface CampNow {
  id: string
  epoch: string
  /** The projected cycle (entityCycle): what the claim names. */
  cycle: number
  /** The near read's word for exactly this cycle (store.ts campClaimable). */
  claimable: boolean
}

/** Recovery reads while a completed cycle still lacks its durable claim word. */
export const CAMP_READ_EVERY_MS = 5_000

type Known = { epoch: string; cycle: number; complete: boolean; askedAt: number; claimed: boolean; inFlight: object | null }

export class ServerCampOutcome {
  private readonly known = new Map<string, Known>()
  private readonly read: (camp: Pick<CampNow, 'id' | 'epoch'>) => boolean | undefined
  private readonly ask: () => Promise<unknown>
  private readonly now: () => number

  /** `read`: the room's answer (true all dead, false one stands, undefined unknown); `ask`: the recovery near read's own promise. */
  constructor(read: (camp: Pick<CampNow, 'id' | 'epoch'>) => boolean | undefined, ask: () => Promise<unknown> = () => Promise.resolve(), now: () => number = () => Date.now()) {
    this.read = read
    this.ask = ask
    this.now = now
  }

  private at(camp: Pick<CampNow, 'id' | 'epoch' | 'cycle'>): Known {
    let k = this.known.get(camp.id)
    if (!k || k.epoch !== camp.epoch || k.cycle !== camp.cycle) {
      k = { epoch: camp.epoch, cycle: camp.cycle, complete: false, askedAt: -Infinity, claimed: false, inFlight: null }
      this.known.set(camp.id, k)
    }
    return k
  }

  won(camp: CampNow): boolean {
    const k = this.at(camp)
    const answer = this.read(camp)
    if (answer === false) {
      // Standing rows end this completion; a later fall earns a fresh schedule.
      k.complete = false
      k.inFlight = null
      k.askedAt = -Infinity
      return false
    }
    if (answer === true) {
      // A completion seen here: a new one earns a fresh round of reads.
      if (!k.complete) { k.complete = true; k.askedAt = -Infinity }
      if (!camp.claimable && !k.claimed && !k.inFlight && this.now() - k.askedAt >= CAMP_READ_EVERY_MS) {
        k.askedAt = this.now()
        const attempt = k.inFlight = {}
        const finished = () => {
          // Neither another read nor an obsolete cycle/life can release this gate.
          if (this.known.get(camp.id) === k && k.inFlight === attempt) k.inFlight = null
        }
        void this.ask().then(finished, finished)
      }
    }
    return camp.claimable && !k.claimed
  }

  /** This account settled (or can't settle) this camp's cycle. */
  claimed(camp: Pick<CampNow, 'id' | 'epoch' | 'cycle'>): void {
    const k = this.at(camp)
    k.claimed = true
    k.inFlight = null
  }

  /** A scene lifetime ended; no scheduled recovery state belongs to its successor. */
  clear(): void {
    this.known.clear()
  }
}
