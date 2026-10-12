/**
 * Generated camps' fights, as this client plays them until fights are
 * shared (step-back review F6). A camp's fight belongs to its epoch, entity
 * and cycle, not to whether its chunk is drawn: a depletion (anyone's claim)
 * ends it and clears its creatures, the next cycle (or a depleted camp come
 * round again) starts a new one, and another epoch's camp under the same id
 * is another camp. Drawing is separate: a chunk leaving the window takes the
 * creatures away, and coming back sets an unfinished fight up again; a won
 * fight stays won for its cycle.
 *
 * Claim eligibility reads the outcome through `CampOutcome`; shared fights
 * replace this local source with the server's. Curated story fights don't
 * come through here. No Phaser: the host spawns and removes the creatures.
 */

/** A camp as the store holds it now. */
export interface CampNow {
  id: string
  epoch: string
  cycle: number
  /** Available now (not depleted). */
  available: boolean
}

/** Where a camp fight's outcome comes from (claimable only once it is won). */
export interface CampOutcome {
  won(camp: Pick<CampNow, 'id' | 'epoch' | 'cycle'>): boolean
}

export interface CampHost<T extends CampNow> {
  /** Set the camp's creatures out (a new fight, or one drawn again). */
  spawn(camp: T): void
  /** Take the camp's creatures away (alive or dead). */
  remove(id: string): void
  /** Any of the camp's creatures still standing? */
  alive(id: string): boolean
}

type Fight = { epoch: string; cycle: number; phase: 'fighting' | 'won' | 'depleted'; drawn: boolean }

export class CampFights<T extends CampNow = CampNow> implements CampOutcome {
  private readonly fights = new Map<string, Fight>()
  private readonly host: CampHost<T>

  constructor(host: CampHost<T>) {
    this.host = host
  }

  /** Bring each attached camp's fight in line with the store (every frame; cheap when nothing moved). */
  reconcile(camps: readonly T[]): void {
    for (const c of camps) {
      let f = this.fights.get(c.id)
      if (f && f.epoch !== c.epoch) {
        // Another epoch's camp under the same id: a different camp.
        if (f.drawn) this.host.remove(c.id)
        f = undefined
      }
      if (!f) {
        f = { epoch: c.epoch, cycle: c.cycle, phase: 'depleted', drawn: false }
        this.fights.set(c.id, f)
      }
      this.settle(c.id, f)
      if (!c.available) {
        // Depleted (by anyone): the fight is over, its creatures go.
        if (f.drawn) this.host.remove(c.id)
        f.phase = 'depleted'
        f.drawn = false
        f.cycle = c.cycle
        continue
      }
      if (f.phase === 'depleted' || f.cycle !== c.cycle) {
        // A new cycle, or a depleted camp come round again: a new fight.
        if (f.drawn) this.host.remove(c.id)
        f.phase = 'fighting'
        f.cycle = c.cycle
        f.drawn = false
      }
      if (f.phase === 'fighting' && !f.drawn) {
        this.host.spawn(c)
        f.drawn = true
      }
    }
  }

  /** The camps with a fight on record (drawn or not). */
  ids(): string[] {
    return [...this.fights.keys()]
  }

  /** A camp's chunk left the window: its creatures go; the fight's outcome stays. */
  undraw(id: string): void {
    const f = this.fights.get(id)
    if (!f) return
    this.settle(id, f)
    if (f.drawn) this.host.remove(id)
    f.drawn = false
  }

  won(camp: Pick<CampNow, 'id' | 'epoch' | 'cycle'>): boolean {
    const f = this.fights.get(camp.id)
    if (!f || f.epoch !== camp.epoch || f.cycle !== camp.cycle) return false
    this.settle(camp.id, f)
    return f.phase === 'won'
  }

  /** A drawn fight whose creatures are all down is won. */
  private settle(id: string, f: Fight): void {
    if (f.phase === 'fighting' && f.drawn && !this.host.alive(id)) f.phase = 'won'
  }
}
