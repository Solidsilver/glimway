/**
 * Residents' small routines (playtest 1, the walking art): a few of them
 * stroll a short loop from their spot, or go and sit on the square's bench
 * for a while, then come back. No Phaser here: src/game/entities/npcs.ts
 * drives a walker per resident each frame, and tests run the same code.
 *
 * Whenever you come near a resident's spot (APPROACH), they head home the
 * way they came (standing up first), and stay there while you're about:
 * talking, the "…" marker, the collision body and the server's own
 * proximity checks (content/items.json residents and menders) all stay at
 * their spot, exactly as before. Sellers and menders (Finn, Ada, Silas,
 * Elara) keep their posts and have no routine. Every route is drawn on open
 * tiles, one axis at a time (tests/npc-routines.test.ts checks the maps).
 */
import { tileBottom, tileFeet, tileMid } from '../lib/tile.ts'
import type { Facing } from './people.ts'

export type Step =
  | { kind: 'walk'; tx: number; ty: number }
  | { kind: 'wait'; s: number }
  /** Sit on the bench whose prop stands at tx, ty (src/game/seats.ts benchSeat), for `s` seconds. */
  | { kind: 'sit'; tx: number; ty: number; s: number }

const walk = (tx: number, ty: number): Step => ({ kind: 'walk', tx, ty })
const wait = (s: number): Step => ({ kind: 'wait', s })

/** Routines by resident and area; each loop ends where it started (the resident's spot). */
export const ROUTINES: Readonly<Record<string, Readonly<Record<string, readonly Step[]>>>> = {
  village: {
    // Mara walks a slow square by the well and looks up the road.
    mara: [wait(7), walk(18, 13), walk(18, 11), wait(3), walk(16, 11), walk(16, 13)],
    // Hazel takes her basket to the bench by the lantern and sits a while.
    hazel: [wait(9), walk(9, 15), walk(9, 14), { kind: 'sit', tx: 9, ty: 13, s: 16 }, walk(9, 15), walk(12, 15)],
    // Pip runs a lap of the garden.
    pip: [wait(5), walk(26, 17), walk(26, 15), walk(28, 15), wait(2), walk(28, 17)],
    // Orrin checks the road a few steps east, and comes back.
    orrin: [wait(12), walk(23, 9), wait(4), walk(21, 9)],
  },
}

/** Within this many px of a resident's spot, they go home and stay (talking stays at the spot). */
export const APPROACH = 88
/** Past this, they take up their routine again. */
export const DEPART = 112
/** Walking pace, px a second (the hero runs at about three times this). */
export const NPC_SPEED = 24
/** A seated resident's feet sit this far below the bench's base (px; the sit pose's legs hang over the front). */
export const SIT_DROP = 2

export interface Walker {
  /** Feet, px. */
  x: number
  y: number
  facing: Facing
  mode: 'stand' | 'walk' | 'sit'
  /** Index into the routine. */
  step: number
  /** Seconds spent on this step. */
  t: number
  /** Where they've walked to since leaving home (the way back). */
  trail: { x: number; y: number }[]
  /** Heading home (you came near). */
  returning: boolean
  /** Where they sat (bench seat, px), while seated. */
  seat: { x: number; y: number } | null
}

export function newWalker(home: { x: number; y: number }): Walker {
  return { x: home.x, y: home.y, facing: 'down', mode: 'stand', step: 0, t: 0, trail: [], returning: false, seat: null }
}

function faceTo(dx: number, dy: number, fallback: Facing): Facing {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return fallback
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}

/** Move toward a point; true on arrival. */
function moveTo(w: Walker, x: number, y: number, dt: number): boolean {
  const dx = x - w.x
  const dy = y - w.y
  const d = Math.hypot(dx, dy)
  const s = NPC_SPEED * dt
  w.mode = 'walk'
  w.facing = faceTo(dx, dy, w.facing)
  if (d <= s) {
    w.x = x
    w.y = y
    return true
  }
  w.x += (dx / d) * s
  w.y += (dy / d) * s
  return false
}

export function atHome(w: Walker, home: { x: number; y: number }): boolean {
  return w.x === home.x && w.y === home.y && w.mode !== 'sit'
}

/**
 * One frame of a resident's routine. `hero` is the hero's feet (null: not
 * in this area). `still`: a conversation or panel holds the world — nobody
 * moves, but they keep facing you.
 */
export function tickWalker(w: Walker, routine: readonly Step[] | undefined, home: { x: number; y: number }, hero: { x: number; y: number } | null, dt: number, still: boolean): void {
  const near = !!hero && Math.hypot(hero.x - home.x, hero.y - home.y) < APPROACH
  if (near && !w.returning) {
    w.returning = true
    if (w.mode === 'sit') {
      // Stand up in front of the bench.
      w.mode = 'stand'
      w.seat = null
      const front = w.trail[w.trail.length - 1] ?? home
      w.x = front.x
      w.y = front.y
    } else {
      // Mid-leg: where they stand is on the way back (the legs are straight).
      const last = w.trail[w.trail.length - 1] ?? home
      if (w.x !== last.x || w.y !== last.y) w.trail.push({ x: w.x, y: w.y })
    }
  } else if (w.returning && (!hero || Math.hypot(hero.x - home.x, hero.y - home.y) > DEPART) && atHome(w, home)) {
    w.returning = false
    w.step = 0
    w.t = 0
  }
  // Close by, they look at you; at home otherwise, back down the lane.
  const faceHero = () => {
    if (hero && Math.hypot(hero.x - w.x, hero.y - w.y) < 56) w.facing = faceTo(hero.x - w.x, hero.y - w.y, w.facing)
    else if (w.x === home.x && w.y === home.y) w.facing = 'down'
  }
  if (still) {
    if (w.mode === 'walk') w.mode = 'stand'
    if (w.mode !== 'sit') faceHero()
    return
  }
  if (!routine || routine.length === 0) {
    w.mode = 'stand'
    faceHero()
    return
  }
  if (w.returning) {
    // Back along the trail, point by point, to home.
    if (w.trail.length === 0) {
      if (w.x !== home.x || w.y !== home.y) moveTo(w, home.x, home.y, dt)
      else {
        w.mode = 'stand'
        w.facing = 'down'
        faceHero()
      }
      return
    }
    const target = w.trail.length > 1 ? w.trail[w.trail.length - 2] : home
    if (moveTo(w, target.x, target.y, dt)) w.trail.pop()
    return
  }
  const step = routine[w.step]
  const next = () => {
    w.step = (w.step + 1) % routine.length
    w.t = 0
    if (w.step === 0) w.trail = []
  }
  if (step.kind === 'wait') {
    w.mode = 'stand'
    if (w.x === home.x && w.y === home.y) w.facing = 'down'
    w.t += dt
    if (w.t >= step.s) next()
  } else if (step.kind === 'walk') {
    const p = tileFeet(step.tx, step.ty)
    if (moveTo(w, p.x, p.y, dt)) {
      w.mode = 'stand'
      w.trail.push(p)
      next()
    }
  } else {
    if (w.mode !== 'sit') {
      w.mode = 'sit'
      w.facing = 'down'
      w.seat = { x: tileMid(step.tx), y: tileBottom(step.ty) + SIT_DROP }
      w.x = w.seat.x
      w.y = w.seat.y
    }
    w.t += dt
    if (w.t >= step.s) {
      w.mode = 'stand'
      w.seat = null
      const front = w.trail[w.trail.length - 1] ?? home
      w.x = front.x
      w.y = front.y
      next()
    }
  }
}
