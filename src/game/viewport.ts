import { MAX_SCREEN_SCALE } from './atlas-plan.ts'
import { TILE } from '../lib/tile.ts'

/**
 * Screen space the interface covers at each edge while playing, in CSS
 * pixels: the HUD along the top, the touch controls along the bottom. The
 * camera keeps the hero inside what's left (WorldScene), so near a map edge
 * the hero never walks under a card or a thumb. The UI writes it
 * (src/App.svelte measures the HUD and the controls); `rev` bumps on every
 * change so the scene can re-frame cheaply.
 */
export const playInsets = { top: 0, right: 0, bottom: 0, left: 0, rev: 0 }

export function setPlayInsets(next: { top: number; right: number; bottom: number; left: number }): void {
  const r = (n: number) => Math.max(0, Math.round(n))
  const v = { top: r(next.top), right: r(next.right), bottom: r(next.bottom), left: r(next.left) }
  if (v.top === playInsets.top && v.right === playInsets.right && v.bottom === playInsets.bottom && v.left === playInsets.left) return
  Object.assign(playInsets, v)
  playInsets.rev += 1
}

/**
 * Canvas pixels per CSS pixel. The canvas renders at the screen's device
 * pixel ratio (src/game/main.ts), so a world pixel gets every real pixel
 * the screen has instead of the browser upscaling a CSS-px canvas. Phaser
 * works in canvas px (the camera, scroll-factor-0 objects, `scale.width`);
 * the interface works in CSS px (playInsets, heroScreen, the dev hooks), so
 * whatever crosses between them goes through this ratio.
 */
let ratio = 1

/**
 * The largest ratio the canvas renders at: past 3 the fill cost grows with
 * nothing to see.
 *
 * The first knob for an older phone: if one struggles (dropped frames,
 * heat), set this to 2. A 390×844 phone at 3× then renders 780×1688
 * instead of 1170×2532 (4/9 of the pixels; a 5 MB drawing buffer instead of
 * 12 MB) and still shows the 4× art at 4 canvas px a world px. Lower
 * PHONE_ART_DENSITY (./atlas-plan.ts) next, if memory is the trouble.
 */
export const MAX_CANVAS_RATIO = 3

export function canvasRatio(): number {
  return ratio
}

export function setCanvasRatio(r: number): void {
  ratio = r
}

/** The ratio for this screen: its device pixel ratio, from 1 up to MAX_CANVAS_RATIO. */
export function screenCanvasRatio(dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio): number {
  return Math.min(MAX_CANVAS_RATIO, Math.max(1, dpr || 1))
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * World pixels to CSS pixels. Phones show about 12 tiles across the
 * short side (390×844 and 844×390 both get 2×: one phone, one game,
 * whichever way it's held); from a 600 px short side up, the old rule
 * (the height over 280, in half steps) holds, and the tile count ramps
 * between the two so no size jumps.
 */
export function zoomFor(w: number, h: number): number {
  const short = Math.min(w, h)
  if (short >= 600) return clamp(Math.round((h / 280) * 2) / 2, 1.5, MAX_SCREEN_SCALE)
  const tiles = 12 + (clamp(short, 440, 600) - 440) * (5.5 / 160)
  return clamp(Math.round((short / (tiles * TILE)) * 2) / 2, 1.5, MAX_SCREEN_SCALE)
}

/**
 * The camera's zoom for a canvas `w`×`h` canvas px: zoomFor its CSS size,
 * in canvas px, so the screen shows the same stretch of world at any ratio.
 */
export function canvasZoomFor(w: number, h: number, r = ratio): number {
  return zoomFor(w / r, h / r) * r
}

/**
 * The camera's zoom in a room (docs/design/indoors.md 2.7), canvas px per
 * world px: the room's height fills about 80% of the play area between the
 * interface's insets, in half steps, never below the outdoor zoom and never
 * past its top; and the whole room, all four walls, always fits that open
 * area (a phone shows the whole room, zoomed out a little if it must, in
 * quarter steps).
 */
export function roomZoomFor(w: number, h: number, room: { widthPx: number; heightPx: number }, insets: { top: number; right: number; bottom: number; left: number } = playInsets, r = ratio): number {
  const cssW = w / r
  const cssH = h / r
  const openW = Math.max(1, cssW - insets.left - insets.right)
  const openH = Math.max(1, cssH - insets.top - insets.bottom)
  const fill = Math.floor(Math.min((openH * 0.8) / room.heightPx, (openW * 0.96) / room.widthPx) * 2) / 2
  const fitAll = Math.min(openW / room.widthPx, openH / room.heightPx)
  const z = Math.min(MAX_SCREEN_SCALE, fitAll, Math.max(fill, zoomFor(cssW, cssH)))
  return Math.max(0.25, Math.floor(z * 4) / 4) * r
}

/**
 * A camera scroll on whole canvas pixels (review F2). Phaser draws a world
 * point at `zoom × (x − scroll − origin)` from a whole-pixel anchor, with
 * `origin` the camera's centre in canvas px; the scroll is snapped so that
 * product lands the world's grid on the canvas's pixels. The zoom is
 * fractional (1.5 or 2.5 canvas px a world px on a 1× screen), so a scroll in
 * whole *world* px doesn't: each frame of a pan put the map at a different
 * fraction of a pixel, and the pixel art shimmered.
 */
export function snapScroll(scroll: number, origin: number, zoom: number): number {
  if (!(zoom > 0) || !Number.isFinite(scroll)) return scroll
  return Math.round((scroll + origin) * zoom) / zoom - origin
}
