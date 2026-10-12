/**
 * A generated camp's claim prompt on this client (shared-fights.md 1.9; step-back
 * review F6). Every camp is fought in its server room. The server's word is the
 * near read's `camp_claimable` for the camp's exact cycle (a stored fall that
 * lists this account, not yet claimed): that alone makes a camp claimable. The
 * room only hurries the word along and hides a prompt it contradicts:
 *
 * - Rows all confirmed dead (the last death, or a join with only corpses) while
 *   the store has no word for this cycle: ask for a fresh near read, a few
 *   times, spaced (the fall is written off the tick). Dead rows never grant a
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

/** Fresh reads asked after one completion, and how far apart. */
export const CAMP_READ_TRIES = 4
export const CAMP_READ_EVERY_MS = 1_500

type Known = { epoch: string; cycle: number; complete: boolean; tries: number; askedAt: number; claimed: boolean }

export class ServerCampOutcome {
  private readonly known = new Map<string, Known>()
  private readonly read: (camp: Pick<CampNow, 'id' | 'epoch'>) => boolean | undefined
  private readonly ask: () => void
  private readonly now: () => number

  /** `read`: the room's answer (true all dead, false one stands, undefined unknown); `ask`: request a near read. */
  constructor(read: (camp: Pick<CampNow, 'id' | 'epoch'>) => boolean | undefined, ask: () => void = () => {}, now: () => number = () => Date.now()) {
    this.read = read
    this.ask = ask
    this.now = now
  }

  private at(camp: Pick<CampNow, 'id' | 'epoch' | 'cycle'>): Known {
    let k = this.known.get(camp.id)
    if (!k || k.epoch !== camp.epoch || k.cycle !== camp.cycle) {
      k = { epoch: camp.epoch, cycle: camp.cycle, complete: false, tries: 0, askedAt: -Infinity, claimed: false }
      this.known.set(camp.id, k)
    }
    return k
  }

  won(camp: CampNow): boolean {
    const k = this.at(camp)
    const answer = this.read(camp)
    if (answer === false) {
      k.complete = false
      return false
    }
    if (answer === true) {
      // A completion seen here: a new one earns a fresh round of reads.
      if (!k.complete) { k.complete = true; k.tries = 0 }
      if (!camp.claimable && !k.claimed && k.tries < CAMP_READ_TRIES && this.now() - k.askedAt >= CAMP_READ_EVERY_MS) {
        k.tries++
        k.askedAt = this.now()
        this.ask()
      }
    }
    return camp.claimable && !k.claimed
  }

  /** This account settled (or can't settle) this camp's cycle. */
  claimed(camp: Pick<CampNow, 'id' | 'epoch' | 'cycle'>): void {
    this.at(camp).claimed = true
  }
}
