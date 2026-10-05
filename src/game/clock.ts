/**
 * The game's clock: real Unix seconds plus a dev/playtest offset, so the
 * calendar (festivals, the Turning) can be moved to any day. The village's
 * calendar and guests' outer Wilds both read it.
 */
let devOffset = 0

/** The game's "now" in Unix seconds. */
export function gameNow(): number {
  return Math.floor(Date.now() / 1000) + devOffset
}

/** Is the dev clock moved (connected play then reads the calendar locally)? */
export function clockMoved(): boolean {
  return devOffset !== 0
}

/** Dev/playtest: pretend it is `unix` now (null: the real clock again). */
export function setGameNow(unix: number | null): void {
  devOffset = unix === null ? 0 : unix - Math.floor(Date.now() / 1000)
}
