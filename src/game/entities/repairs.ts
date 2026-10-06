/**
 * Village repairs in the world (docs/items/crafting-and-repair.md, "Village
 * repairs"): the broken things standing in the village and on the Commons —
 * the well's rotten rope, a fallen fence rail, and the rest. Each one is
 * drawn at its spot while its chore is open, mended from the prompt with the
 * right part from the pack. Repairs are shared — done once for the whole
 * world — so what stands here follows the server's list, and the resident
 * who notices answers in a toast. The two scripted mends keep their change
 * visible (the new rope on the well, the pegged rail in the fence).
 *
 * A feature-scoped InteractionProvider owning `repair:*` ids. Worlds only:
 * the chores list is server state, and guests have no world to mend.
 */
import type Phaser from 'phaser'
import { itemDef } from '../../lib/items'
import { repairFor, repairsForArea, type RepairDef } from '../../lib/repairs'
import { bus, EV } from '../events'
import { ITEMS_EV, itemsFor } from '../items'
import { ensureRepairTexture } from '../repairs-art'
import type { Session } from '../session'
import { sfx } from '../sfx'
import { TILE } from '../textures'
import { VILLAGE_EV, villageFor } from '../village'
import type { InteractId, WorldData } from '../worlds'
import { NPC_NAMES } from './npcs'
import type { Effects } from './fx'
import type { Interactable, InteractionProvider, Interactables } from './interactables'

export interface RepairsDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  interactables: Interactables
}

const PREFIX = 'repair:'

/** Who answers when a chore is mended (the repairs data names them by id). */
const REPAIR_NAMES: Record<string, string> = { ...NPC_NAMES, silas: 'Silas' }

/** Where each broken thing sits on its tile: anchor offsets from the tile's base. */
const AT: Record<string, { ax: number; ay: number }> = {
  well: { ax: -4, ay: -12 },
  fence: { ax: 0, ay: 0 },
  library: { ax: 0, ay: -14 },
  bench: { ax: 0, ay: -8 },
  lamp: { ax: 0, ay: -20 },
  hame: { ax: 1, ay: -12 }
}

interface Standing {
  def: RepairDef
  image: Phaser.GameObjects.Image
}

export class RepairsLayer implements InteractionProvider {
  private standing = new Map<string, Standing>()
  private kept = new Map<string, Standing>()
  private busy = false

  constructor(private scene: Phaser.Scene, private deps: RepairsDeps) {
    const village = villageFor(deps.session)
    const sync = () => {
      if (scene.sys?.isActive()) this.sync()
    }
    bus.on(VILLAGE_EV.changed, sync)
    bus.on(ITEMS_EV.changed, sync)
    scene.events.once('shutdown', () => {
      bus.off(VILLAGE_EV.changed, sync)
      bus.off(ITEMS_EV.changed, sync)
    })
    if (deps.session.link && village.repairsStatus !== 'ready') void village.loadRepairs()
    else this.sync()
  }

  owns(id: InteractId): boolean {
    return id.startsWith(PREFIX)
  }

  /** Open chores stand out: the board points here. */
  marker(): 'quest' | 'talk' | null {
    return 'quest'
  }

  markerOffset(): number {
    return 30
  }

  verb(): string {
    return 'Mend'
  }

  label(id: InteractId): string | null {
    const def = repairFor(id.slice(PREFIX.length))
    if (!def) return null
    // "The well's rotten rope" → "Mend the well's rotten rope".
    const n = def.name
    return `Mend ${n.charAt(0).toLowerCase()}${n.slice(1)}`
  }

  activate(id: InteractId): void {
    const key = id.slice(PREFIX.length)
    const def = repairFor(key)
    if (!def || this.busy) return
    const items = itemsFor(this.deps.session)
    if (!items.view?.stacks.some((s) => s.itemDef === def.part && s.qty > 0)) {
      const part = itemDef(def.part)?.name ?? def.part
      bus.emit(EV.toast, { text: `A ${part.toLowerCase()} would mend this. The board lists what's needed.`, kind: 'error' })
      return
    }
    this.busy = true
    const village = villageFor(this.deps.session)
    void village.mend(def.id).then((r) => {
      this.busy = false
      if (!r.ok) {
        bus.emit(EV.toast, { text: r.text, kind: 'error' })
        return
      }
      // The part left the pack (and a gift may have arrived): the answer
      // carried the items view, so adopt it instead of reading again.
      items.adoptView(r.value.items)
      sfx('discover')
      const s = this.standing.get(key)
      if (s) this.deps.fx.sparkBurst(s.image.x, s.image.y - 6, 10)
      const who = REPAIR_NAMES[def.resident] ?? def.resident
      bus.emit(EV.toast, { text: `${who}: “${r.value.reaction}”`, icon: 'speech' })
      if (r.value.gift) {
        const gift = itemDef(r.value.gift.id)?.name ?? r.value.gift.id
        bus.emit(EV.toast, { text: `${who} hands you ${r.value.gift.qty > 1 ? `${r.value.gift.qty} ${gift}s` : `a ${gift}`}.`, icon: 'heart' })
      }
      this.sync()
    })
  }

  /** Open repairs standing in this area (playtests). */
  ids(): string[] {
    return [...this.standing.keys()]
  }

  private sync(): void {
    const { session, world } = this.deps
    const village = villageFor(session)
    const open = new Set(village.repairs.open.map((c) => c.id))
    const here = session.link ? repairsForArea(world.areaId) : []
    const want = here.filter((d) => open.has(d.id))
    const mended = session.link ? here.filter((d) => !open.has(d.id) && village.repairs.mended.some((m) => m.repairId === d.id)) : []
    for (const [id, s] of this.standing) {
      if (!want.some((d) => d.id === id)) {
        s.image.destroy()
        this.standing.delete(id)
      }
    }
    for (const id of [...this.kept.keys()]) {
      if (!mended.some((d) => d.id === id)) this.kept.get(id)!.image.destroy(), this.kept.delete(id)
    }
    for (const d of want) if (!this.standing.has(d.id)) this.standing.set(d.id, this.place(d, false))
    for (const d of mended) {
      if (d.target === 'well' || d.target === 'fence') this.kept.set(d.id, this.place(d, true))
    }
    this.publish(want)
  }

  private publish(want: RepairDef[]): void {
    const points: Interactable[] = want.map((d) => ({
      id: `${PREFIX}${d.id}`,
      x: this.at(d).x,
      y: (d.pos.ty + 1) * TILE + 2,
      label: this.label(`${PREFIX}${d.id}` as InteractId) ?? d.name
    }))
    this.deps.interactables.setDynamic(points, this)
  }

  private at(d: RepairDef): { x: number; y: number; depth: number } {
    const a = AT[d.target] ?? { ax: 0, ay: 0 }
    const base = (d.pos.ty + 1) * TILE
    return { x: d.pos.tx * TILE + 8 + a.ax, y: base + a.ay, depth: base + (d.target === 'hame' ? 3 : 1) }
  }

  private place(def: RepairDef, mended: boolean): Standing {
    const { x, y, depth } = this.at(def)
    const key = `repair-${def.target}-${mended ? 'mended' : 'broken'}`
    const made = ensureRepairTexture(this.scene, key)
    const image = this.scene.add
      .image(x, y, made ? key : 'px')
      .setOrigin(0.5, 1)
      .setDepth(mended ? depth - 1 : depth)
    if (!made) image.setVisible(false)
    return { def, image }
  }
}
