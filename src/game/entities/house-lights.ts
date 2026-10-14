/**
 * Outside, from the cycle (docs/design/indoors.md 2.7): a building whose
 * resident is home shows a lit window and smoke from its chimney; the
 * library's window is always softly lit. Overlays on the existing building
 * art, toggled when the cycle changes (`refresh`). Nobody outside sees who
 * else is inside.
 *
 * The delivered buildings already paint their windows lit, and the pass's
 * lit-window overlays don't fit their glass (a whole frame, larger than the
 * window). So the window works the other way round: lit as painted while
 * the resident is home, its glass dimmed while they're out. The library has
 * no resident, so it stays lit. Smoke rises from the chimney the rooms data
 * names (the mill has none to smoke from).
 */
import type Phaser from 'phaser'
import { onSceneEnd } from '../scene-end'
import { chunkOfTile, footprint } from '../wilds/fixed'
import { TILE } from '../../lib/tile'
import { ROOMS } from '../../lib/rooms'
import { hasInArt, inArt } from '../indoors-art'
import { residentIn, residentOf } from '../resident-cycle'
import type { WorldData } from '../worlds'

/**
 * Each resident building's window glass, as the village draws it (world
 * px), dimmed while they're out; `base` is the building's own draw depth
 * (its foot), so the glass sorts just in front of it and behind anyone
 * standing before the house.
 */
const WINDOW_GLASS: Readonly<Record<string, { x: number; y: number; w: number; h: number; base: number }>> = {
  'house-west': { x: 138, y: 103, w: 7, h: 8, base: 128 },
  'tolley-mill': { x: 463, y: 342, w: 8, h: 9, base: 368 }
}

interface Lit {
  chunk: string
  room: string
  resident: string | null
  /** The dimmed glass (shown while the resident is out). */
  dark: Phaser.GameObjects.Rectangle | null
  smoke: Phaser.GameObjects.Sprite | null
}

export class HouseLights {
  private lit: Lit[] = []

  private chunks = new Set<string>()
  constructor(private scene: Phaser.Scene, private deps: { world: WorldData; reducedMotion: boolean }) {
    if (!deps.world.open) this.draw()
    onSceneEnd(scene, () => this.destroy())
  }

  attachChunk(key: string): (() => void)[] {
    this.chunks.add(key)
    return [() => { if (this.chunks.has(key)) { this.detachDrawn(key); this.draw(key) } }]
  }

  private draw(key?: string): void {
    const { scene, deps } = this
    for (const room of ROOMS.rooms) {
      const out = room.outside
      if (!out || room.parent !== (deps.world.open ? 'hearthwick' : deps.world.areaId) || /:\d+$/.test(room.id)) continue
      const window = out.window
      if (key && (!window || chunkOfTile(window.tx, window.ty) !== key)) continue
      const old = WINDOW_GLASS[out.building]
      const building = [...(footprint('hearthwick')?.objects.values() ?? [])].flat().find((o) => o.id === (out.building === 'tolley-mill' ? 'mill' : out.building))
      const glass = deps.world.open && window && old ? {
        x: window.tx * TILE + (out.building === 'house-west' ? 10 : -1),
        y: window.ty * TILE + (out.building === 'house-west' ? 7 : 6),
        w: old.w, h: old.h, base: building ? building.ty * TILE + (building.art?.oy ?? TILE) : (window.ty + 2) * TILE
      } : old
      const resident = residentOf(room.id)
      const dark = glass && resident ? scene.add.rectangle(glass.x, glass.y, glass.w, glass.h, 0x26304a, 0.78).setOrigin(0, 0).setDepth(glass.base + 0.5) : null
      let smoke: Phaser.GameObjects.Sprite | null = null
      if (out.chimney && hasInArt(scene, 'chimney-smoke-0')) {
        smoke = scene.add.sprite(out.chimney.x, out.chimney.y, inArt('chimney-smoke-0')).setOrigin(0.5, 1).setDepth(5000).setAlpha(0.75)
        if (!deps.reducedMotion && scene.anims.exists(inArt('chimney-smoke'))) smoke.play(inArt('chimney-smoke'))
      }
      this.lit.push({ room: room.id, resident, dark, smoke, chunk: key ?? '' })
    }
    this.refresh()
  }

  private detachDrawn(key: string): void {
    this.lit = this.lit.filter((l) => {
      if (l.chunk !== key) return true
      l.dark?.destroy(); l.smoke?.destroy()
      return false
    })
  }
  detachChunk(key: string): void { this.chunks.delete(key); this.detachDrawn(key) }
  destroy(): void { for (const l of this.lit) { l.dark?.destroy(); l.smoke?.destroy() }; this.lit = []; this.chunks.clear() }

  /** Lit and smoking while the resident is home (a room with no resident: lit, no smoke). */
  refresh(): void {
    for (const l of this.lit) {
      const home = l.resident === null || residentIn(l.room)
      l.dark?.setVisible(!home)
      l.smoke?.setVisible(home && l.resident !== null)
    }
  }

  /** What the playtests read: which buildings show light and smoke. */
  view(): { room: string; window: boolean; smoke: boolean }[] {
    return this.lit.map((l) => ({ room: l.room, window: !l.dark?.visible, smoke: !!l.smoke?.visible }))
  }
}
