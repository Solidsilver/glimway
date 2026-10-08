/**
 * Area construction — furnishings (docs/design/indoors.md 2.8): one way to
 * draw any catalogue piece, a room's signature props and its dressing alike.
 *
 * - **Facing**: the art for the facing asked for; a side-on piece painted
 *   only facing the other way is mirrored; otherwise its front.
 * - **State**: the state's frames, still unless the state has a slow loop
 *   (a working machine). States change only when something happens (the
 *   caller sets them: a resident comes home, a quest step); nothing idles.
 * - **Parent**: a piece on another piece's surface stands on it, at its
 *   slot along the surface and the surface's height, drawn just in front.
 * - **Layer**: a rug lies under everything; wall pieces hang on the back
 *   wall; the rest sort by their foot.
 *
 * Art that hasn't been delivered (the kit, until Luna's set lands) draws a
 * small placeholder in the piece's size and footprint. Pieces never stretch:
 * frames are drawn at their own size, standing on their foot point.
 */
import type Phaser from 'phaser'
import { TILE } from '../../lib/tile.ts'
import { layoutHash01 } from '../../lib/hash.ts'
import { hasInArt, inArt } from '../indoors-art.ts'
import type { Facing, Furnishing } from '../../lib/furnishings-stand-in.ts'

/** Where a piece stands: its footprint (tiles) and, for a piece on another, its parent's drawing. */
export interface PieceAt {
  tx: number
  ty: number
  facing?: Facing
  parent?: DrawnPiece
  slot?: number
}

export interface DrawnPiece {
  piece: Furnishing
  sprite: Phaser.GameObjects.Sprite
  /** Its foot (px) and draw depth. */
  foot: { x: number; y: number }
  depth: number
  facing: Facing
  state: string | null
}

/** The frame for a piece's facing and state (null: no art), and whether to mirror it. */
export function pieceFrame(piece: Furnishing, facing: Facing, state: string | null, seed: number): { frame: string | null; flipX: boolean } {
  const s = state && piece.states?.[state] ? piece.states[state] : piece.state ? piece.states?.[piece.state] : undefined
  if (s && facing === 'front') return { frame: s.frames[0] ?? null, flipX: false }
  if (facing === 'front' && piece.variants?.length) return { frame: piece.variants[Math.floor(seed * piece.variants.length)], flipX: false }
  if (piece.art[facing]) return { frame: piece.art[facing]!, flipX: false }
  if (facing === 'left' && piece.art.right) return { frame: piece.art.right, flipX: true }
  if (facing === 'right' && piece.art.left) return { frame: piece.art.left, flipX: true }
  // Side-on with no side-on art: never the front squeezed onto a wall (the placeholder stands in).
  if (facing === 'left' || facing === 'right') return { frame: null, flipX: false }
  return { frame: s?.frames[0] ?? piece.art.front ?? null, flipX: false }
}

/** Where a piece's foot goes and how deep it draws (its parent's surface, the wall, or the floor). */
export function pieceFoot(piece: Furnishing, at: PieceAt): { x: number; y: number; depth: number } {
  const [tw, th] = piece.footprint
  if (at.parent) {
    const p = at.parent
    const surface = p.piece.offers?.top ?? p.piece.offers?.shelves
    const slots = surface?.slots ?? 1
    const width = p.piece.footprint[0] * TILE - 4
    const slot = Math.min(slots - 1, Math.max(0, at.slot ?? 0))
    const x = p.foot.x - width / 2 + (slot + 0.5) * (width / slots)
    return { x, y: p.foot.y - (surface?.height ?? 0), depth: p.depth + 0.5 + slot * 0.01 }
  }
  const x = (at.tx + tw / 2) * TILE
  if (piece.mount === 'wall') return { x, y: (at.ty + 1) * TILE - 3, depth: -7.5 }
  const y = (at.ty + th) * TILE
  return { x, y, depth: piece.layer === 'under' ? -8.5 : y }
}

/** Colours for the kit's placeholders, by what a piece is. */
function placeholderColour(piece: Furnishing): [string, string] {
  if (piece.layer === 'under') return ['#8a3a2a', '#c87a50']
  if (piece.tags?.includes('light')) return ['#7a5a20', '#ffd27a']
  if (piece.tags?.includes('books')) return ['#3a4a6a', '#a8b8d8']
  if (piece.mount === 'wall') return ['#4a3020', '#a07a50']
  if (piece.id.includes('plant')) return ['#2a4a2a', '#7ab060']
  return ['#5a3a22', '#a8804e']
}

/** The kit's placeholder for a piece without art: its footprint wide, as tall as its size. */
function placeholder(scene: Phaser.Scene, piece: Furnishing): string {
  const key = `kit-ph:${piece.id}`
  if (scene.textures.exists(key)) return key
  const [tw, th] = piece.footprint
  const w = piece.size === 'small' ? 5 : piece.size === 'medium' ? 11 : tw * TILE - 4
  // A large piece is as deep as its footprint and a little taller (a run of side shelves fills its strip of wall).
  const h = piece.layer === 'under' ? th * TILE - 4 : piece.mount === 'wall' ? 8 : piece.size === 'small' ? 6 : piece.size === 'medium' ? 12 : Math.max(14, th * TILE + 4)
  const t = scene.textures.createCanvas(key, w, h)!
  const ctx = t.getContext()
  const [dark, light] = placeholderColour(piece)
  ctx.globalAlpha = piece.layer === 'under' ? 0.7 : 1
  ctx.fillStyle = dark
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = light
  ctx.fillRect(1, 1, w - 2, Math.max(1, Math.min(3, h - 2)))
  if (piece.layer === 'under') {
    // A rug: a border and a stripe, so it reads as cloth.
    ctx.strokeStyle = light
    ctx.strokeRect(1.5, 1.5, w - 3, h - 3)
    ctx.fillRect(3, Math.floor(h / 2), w - 6, 1)
  }
  t.refresh()
  return key
}

/** The slow loop for a piece's state, registered once per game (null: still). */
function stateLoop(scene: Phaser.Scene, piece: Furnishing, state: string): string | null {
  const s = piece.states?.[state]
  if (!s?.loop || s.frames.length < 2 || !s.frames.every((f) => hasInArt(scene, f))) return null
  const key = `in-state:${piece.id}:${state}`
  if (!scene.anims.exists(key)) scene.anims.create({ key, frames: s.frames.map((f) => ({ key: inArt(f) })), frameRate: s.loop, repeat: -1 })
  return key
}

/** Draw a piece where it stands, in its default state. */
export function drawPiece(scene: Phaser.Scene, piece: Furnishing, at: PieceAt): DrawnPiece {
  const facing = at.facing ?? 'front'
  const foot = pieceFoot(piece, at)
  const { frame, flipX } = pieceFrame(piece, facing, null, layoutHash01(at.tx, at.ty, 23))
  const key = frame && hasInArt(scene, frame) ? inArt(frame) : placeholder(scene, piece)
  const sprite = scene.add.sprite(foot.x, foot.y, key).setOrigin(0.5, 1).setDepth(foot.depth).setFlipX(flipX)
  return { piece, sprite, foot: { x: foot.x, y: foot.y }, depth: foot.depth, facing, state: piece.state ?? null }
}

/**
 * Put a drawn piece in a state (null: its default). Its frame changes, and
 * its loop plays only if that state has one (slowly) and motion is allowed.
 */
export function setPieceState(scene: Phaser.Scene, d: DrawnPiece, state: string | null, reducedMotion: boolean): void {
  if (!d.piece.states) return // a piece with no states is still
  const next = state && d.piece.states?.[state] ? state : (d.piece.state ?? null)
  const loop = next && !reducedMotion ? stateLoop(scene, d.piece, next) : null
  if (loop) {
    if (d.sprite.anims.currentAnim?.key !== loop || !d.sprite.anims.isPlaying) d.sprite.play(loop)
  } else {
    if (d.sprite.anims.isPlaying) d.sprite.stop()
    const { frame } = pieceFrame(d.piece, d.facing, next, 0)
    if (frame && hasInArt(scene, frame) && d.sprite.texture.key !== inArt(frame)) d.sprite.setTexture(inArt(frame))
  }
  d.state = next
}
