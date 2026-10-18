/**
 * Why a WorldScene build stands still, and what that means for the server's
 * relocations and for the hero's place in the save. Two reasons, kept apart:
 *
 * - **leaving** (a move: an exit, a rebuild, a fall): the save already names
 *   the destination and the next build places the hero from it, so a
 *   relocation is left to that build and this spot is never written back;
 * - **held** (a Turning while the land loads): not a move. The scene stays,
 *   so the latest relocation the server sends meanwhile (a ways-home answer,
 *   a settled reach) is kept and taken as the hold lets go, before the next
 *   position sample could write the departure point over it.
 *
 * Pure, so node tests drive it.
 */
export class TravelHold<P> {
  private away = false
  private holding = false
  private kept: P | null = null

  /** A move away has begun. */
  get leaving(): boolean {
    return this.away
  }

  /** A Turning holds play (and the scene isn't leaving). */
  get held(): boolean {
    return this.holding && !this.away
  }

  /** Either: play and position samples wait. */
  get still(): boolean {
    return this.away || this.holding
  }

  /** A new build: neither held nor leaving, nothing kept. */
  reset(): void {
    this.away = false
    this.holding = false
    this.kept = null
  }

  /** Leave this build: whatever was kept is the next build's to read from the save. */
  leave(): void {
    this.away = true
    this.kept = null
  }

  /** Hold play, or let it go. Letting go returns the relocation kept meanwhile: apply it before sampling resumes. */
  hold(on: boolean): P | null {
    this.holding = on
    if (on) return null
    const p = this.kept
    this.kept = null
    return this.away ? null : p
  }

  /** The server moved the hero. True: apply it now. Held, it is kept (the latest wins); leaving, it is dropped. */
  relocate(p: P): boolean {
    if (this.away) return false
    if (this.holding) {
      this.kept = p
      return false
    }
    return true
  }

  /** Write where the hero stands into the save's position, unless standing still for either reason. */
  note(state: { position: { x: number; y: number } }, at: { x: number; y: number }): boolean {
    if (this.still) return false
    state.position = { x: Math.round(at.x), y: Math.round(at.y) }
    return true
  }
}
