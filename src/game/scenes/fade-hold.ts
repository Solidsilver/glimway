/**
 * A scene build's dark start (WorldScene.create): the camera stays faded out
 * until the first paint is in, then fades in. Only a newer build or a move
 * away (its own fade-out takes the screen) ends the hold without the fade-in.
 * A hold on play (a Turning while the land loads) is not a move: the hold
 * still lifts, or the screen stays dark under a live world. Pure, so node
 * tests drive it.
 */
export class FadeHold {
  private token = 0
  private holding = false

  /** Still dark, waiting for its first paint. */
  get active(): boolean {
    return this.holding
  }

  /** Hold this build dark. Returns its lift: true once, when the fade-in is this build's to play. */
  start(): () => boolean {
    const token = ++this.token
    this.holding = true
    return () => {
      if (token !== this.token || !this.holding) return false
      this.holding = false
      return true
    }
  }

  /** A newer build, or a move away: the hold ends with no fade-in of its own. */
  cancel(): void {
    this.holding = false
    this.token++
  }
}
