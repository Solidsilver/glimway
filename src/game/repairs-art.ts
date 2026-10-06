/**
 * The village's broken things, code-drawn in the game's pixel style (1 px
 * dark outlines, warm palette, crisp nearest-neighbour), until the art pack
 * covers them (docs/art-requests.md). One 16-px overlay per repair, drawn at
 * its spot only while the chore is open; the two scripted repairs keep a
 * mended overlay (the well's new rope, the pegged rail) because the change
 * is the reward. Made on demand (`ensureRepairTexture`), like the mill.
 */
import type Phaser from 'phaser'

type C = CanvasRenderingContext2D

const O = '#3a2a28'
const WOOD = { hi: '#c49a62', lt: '#a8804e', md: '#8a6642', dk: '#6b4c2e', xd: '#4a3220' }
const ROPE = '#e6d6a0'
const ROPE_OLD = '#b8a888'
const SLATE = { hi: '#7d8794', md: '#5e6773', dk: '#454c57' }
const FLAME = '#ffb84a'
const DULL = { hi: '#9a927e', md: '#7a7260' }

function rect(c: C, x: number, y: number, w: number, h: number, col: string): void {
  if (w <= 0 || h <= 0) return
  c.fillStyle = col
  c.fillRect(x, y, w, h)
}

function px(c: C, x: number, y: number, col: string): void {
  rect(c, x, y, 1, 1, col)
}

function make(scene: Phaser.Scene, key: string, w: number, h: number, draw: (c: C) => void): void {
  if (scene.textures.exists(key)) return
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')!
  c.imageSmoothingEnabled = false
  draw(c)
  scene.textures.addCanvas(key, canvas)
}

/** The well's rotten rope: strands frayed to wisps, too short to reach. */
function drawRopeBroken(c: C): void {
  rect(c, 7, 0, 2, 5, O)
  rect(c, 7, 1, 2, 8, ROPE_OLD)
  for (const [x, dy] of [[6, 9], [9, 10], [7, 11]] as const) {
    px(c, x, dy, ROPE_OLD)
    px(c, x + (x === 7 ? 1 : 0), dy + 1, '#8a7c68')
  }
  px(c, 5, 11, '#8a7c68')
}

/** The well's new rope: a neat coil on the lip and a sound line down. */
function drawRopeMended(c: C): void {
  rect(c, 7, 0, 2, 10, O)
  rect(c, 7, 1, 2, 9, ROPE)
  for (const [x, y] of [[5, 10], [6, 9], [7, 9], [8, 9], [9, 9], [10, 10], [6, 11], [8, 11], [9, 11], [7, 12]] as const) px(c, x, y, ROPE)
  px(c, 7, 10, '#c4b070')
  px(c, 8, 10, '#c4b070')
}

/** The fallen rail: one split rail leaning into the gap off its peg. */
function drawFenceBroken(c: C): void {
  for (let i = 0; i < 12; i++) {
    const x = 2 + i
    const y = 12 - Math.round(i * 0.7)
    rect(c, x, y, 2, 3, i % 4 === 3 ? WOOD.dk : WOOD.md)
    px(c, x, y + 3, O)
  }
  px(c, 3, 13, O)
}

/** The mended rail: pegged true across the gap, two rails and a post line. */
function drawFenceMended(c: C): void {
  rect(c, 6, 2, 3, 14, O)
  rect(c, 7, 3, 1, 12, WOOD.dk)
  rect(c, 0, 5, 16, 3, O)
  rect(c, 1, 6, 14, 1, WOOD.md)
  rect(c, 0, 10, 16, 3, O)
  rect(c, 1, 11, 14, 1, WOOD.lt)
  px(c, 7, 6, WOOD.hi)
  px(c, 7, 11, WOOD.hi)
}

/** Slipped slates: a dark tear in the roof line, one slate fallen below. */
function drawRoofBroken(c: C): void {
  rect(c, 3, 4, 10, 5, O)
  rect(c, 4, 5, 8, 3, '#2e3440')
  px(c, 5, 6, SLATE.dk)
  px(c, 8, 7, SLATE.md)
  rect(c, 6, 10, 4, 3, O)
  rect(c, 7, 11, 2, 2, SLATE.md)
  px(c, 7, 13, SLATE.hi)
}

/** The cracked slat: a bench seat split its length. */
function drawBenchBroken(c: C): void {
  rect(c, 1, 5, 14, 4, O)
  rect(c, 2, 6, 12, 2, WOOD.md)
  rect(c, 7, 6, 1, 4, O)
  px(c, 8, 7, O)
  px(c, 6, 8, O)
  px(c, 2, 6, WOOD.lt)
  px(c, 13, 7, WOOD.dk)
}

/** A guttering lamp: the flame low in the head, a thread of smoke rising. */
function drawLampBroken(c: C): void {
  px(c, 6, 2, '#8a8a92')
  px(c, 7, 1, '#6e6e76')
  px(c, 8, 3, '#8a8a92')
  rect(c, 6, 9, 4, 4, O)
  px(c, 7, 12, FLAME)
  px(c, 8, 11, FLAME)
  px(c, 8, 12, '#ffd98a')
}

/** The weathered hame: the same collar, its brass gone dull (a grey veil). */
function drawHameBroken(c: C): void {
  c.globalAlpha = 0.55
  rect(c, 1, 4, 15, 16, DULL.md)
  for (const [x, y] of [[4, 7], [12, 7], [8, 6], [5, 14], [11, 14], [8, 16]] as const) px(c, x, y, DULL.hi)
  c.globalAlpha = 1
}

/**
 * Make a repair texture by key when asked (false: not a repair key). Keys:
 * `repair-<target>-broken`, `repair-<target>-mended` (well, fence only).
 */
export function ensureRepairTexture(scene: Phaser.Scene, key: string): boolean {
  if (scene.textures.exists(key)) return key.startsWith('repair-')
  const m = /^repair-([a-z]+)-(broken|mended)$/.exec(key)
  if (!m) return false
  const [, target, state] = m
  const draw
    = target === 'well'
      ? state === 'broken' ? drawRopeBroken : drawRopeMended
      : target === 'fence'
        ? state === 'broken' ? drawFenceBroken : drawFenceMended
        : target === 'library'
          ? state === 'broken' ? drawRoofBroken : null
          : target === 'bench'
            ? state === 'broken' ? drawBenchBroken : null
            : target === 'lamp'
              ? state === 'broken' ? drawLampBroken : null
              : target === 'hame'
                ? state === 'broken' ? drawHameBroken : null
                : null
  if (!draw) return false
  make(scene, key, 16, 16, draw)
  return true
}
