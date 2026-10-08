/**
 * What a resident calls out when you knock and they're elsewhere
 * (docs/design/indoors.md 2.6): one line per spot away from home, in their
 * voice. Doors never latch: after the line you go in to an empty room.
 */
export const KNOCK_LINES: Readonly<Record<string, Readonly<Record<string, { from: string; line: string }>>>> = {
  hazel: {
    square: { from: 'from the square', line: 'Out with the basket. Shop’s open, mind the oven.' }
  },
  finn: {
    door: { from: 'round the front', line: 'Wheel’s turning, I’m round the front.' }
  }
}
