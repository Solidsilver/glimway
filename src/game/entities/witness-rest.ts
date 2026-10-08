/**
 * A waiting warden's rest for someone else's naming (src/content/witness.ts),
 * timed in real time: the scene's clock (`scene.time.now`, the sum of the
 * real frame times), checked every frame. Not a Phaser timer: those advance
 * by the loop's smoothed delta, which an unfocused window clamps to the 60 fps
 * step, so on a slow frame rate a 4.2 s rest ran for 10 s and more. A later
 * naming nearby lengthens the rest; only its end is announced. Phaser-free
 * (tests drive it with their own clock).
 */
export class WitnessRest {
  private until = 0
  private onEnd: (() => void) | null = null

  /** Rest until `now + ms`; `onEnd` runs once when it ends (a later start replaces it). */
  start(now: number, ms: number, onEnd: () => void): void {
    this.until = now + ms
    this.onEnd = onEnd
  }

  resting(now: number): boolean {
    return this.until > now
  }

  /** Each frame: true (and `onEnd` run) when the rest has just ended. */
  tick(now: number): boolean {
    if (this.until === 0 || now < this.until) return false
    const end = this.onEnd
    this.until = 0
    this.onEnd = null
    end?.()
    return true
  }

  /** The rest is over without an end to show (the warden settled, the scene went). */
  clear(): void {
    this.until = 0
    this.onEnd = null
  }
}
