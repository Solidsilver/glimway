/**
 * Which chunks the terrain must bake for what's on screen. Top-down, the
 * chunks under the view. In the ¾ lift a chunk's image reaches north of
 * its own square by its highest ground's lift, so the view also needs the
 * chunks south of it whose high ground is lifted into it: as many rows
 * south as the tallest of them reaches (a chunk not known yet is taken at
 * the highest level). Nearest the view's middle first, at most `budget`.
 */
import { CHUNK_PX } from './bake.ts'
import { MAX_LEVEL } from './field.ts'

export interface ViewRect {
  x: number
  y: number
  w: number
  h: number
}

/** Px past the view's edges still counted in it (the camera moves a little before the next look). */
export const NEED_MARGIN = 32

/**
 * The chunks a view needs: those whose image (lifted by `liftPx` of their
 * highest ground, `top`: NaN when not known) meets the view.
 */
export function neededChunks(view: ViewRect, liftPx: (z: number) => number, top: (cx: number, cy: number) => number, budget: number): [number, number][] {
  const m = NEED_MARGIN
  const reach = liftPx(MAX_LEVEL)
  const x0 = Math.floor((view.x - m) / CHUNK_PX)
  const x1 = Math.floor((view.x + view.w + m) / CHUNK_PX)
  const y0 = Math.floor((view.y - m) / CHUNK_PX)
  const y1 = Math.floor((view.y + view.h + m + reach) / CHUNK_PX)
  const out: [number, number][] = []
  for (let cy = y0; cy <= y1; cy++)
    for (let cx = x0; cx <= x1; cx++) {
      const z = top(cx, cy)
      // The image runs from its top's lift above the chunk down to the chunk's south edge.
      const north = cy * CHUNK_PX - liftPx(Number.isNaN(z) ? MAX_LEVEL : z)
      if (north < view.y + view.h + m && (cy + 1) * CHUNK_PX > view.y - m) out.push([cx, cy])
    }
  const mx = (view.x + view.w / 2) / CHUNK_PX - 0.5
  const my = (view.y + view.h / 2) / CHUNK_PX - 0.5
  out.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my))
  return out.slice(0, budget)
}
