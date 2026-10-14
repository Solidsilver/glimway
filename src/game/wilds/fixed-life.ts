/** The Commons layers share the fixed chunks' build and teardown lifecycle. */
import { fixedNpcs, footprintAt, exitOf, objectOut } from './fixed.ts'
import { calendarAt } from '../../lib/calendar.ts'
import { gameNow } from '../clock.ts'
import type { FixedHooks } from './fixed-chunk.ts'
import type { ExitDef, WorldData } from '../worlds.ts'
import type { Npcs } from '../entities/npcs.ts'
import type { ResidentCycle } from '../resident-cycle.ts'
import type { WorldTalk } from '../entities/world-talk.ts'
import type { ItemPickups } from '../entities/item-pickups.ts'
import type { PaperPickups } from '../entities/papers.ts'
import type { RepairsLayer } from '../entities/repairs.ts'
import type { Touches } from '../entities/touches.ts'
import type { VillageLayer } from '../entities/village-life.ts'

export interface FixedLifeDeps {
  world: WorldData
  npcs: Npcs
  cycle: ResidentCycle
  talk: WorldTalk
  pickups: ItemPickups
  papers: PaperPickups
  repairs: RepairsLayer
  touches: Touches
  village: VillageLayer
  homes: () => FixedHooks | null
}

export class FixedLife implements FixedHooks {
  private exitOwners = new Map<string, object>()

  constructor(private deps: FixedLifeDeps) {}

  attach(key: string): (() => void)[] {
    const { world, npcs, cycle, talk, pickups, papers, repairs, touches, village } = this.deps
    const spots = fixedNpcs(key)
    const [cx, cy] = key.split(',').map(Number) as [number, number]
    const fp = footprintAt(cx, cy)
    const owner = {}
    this.exitOwners.set(key, owner)
    return [
      ...spots.map((spot) => () => {
        world.npcs.push(spot)
        npcs.add([spot])
        cycle.attach([spot.id])
        talk.refresh()
      }),
      () => pickups.attachChunk(key),
      () => papers.attachChunk(key),
      () => repairs.attachChunk(key),
      () => {
        const day = calendarAt(gameNow())
        if (fp) touches.attachChunk(owner, (fp.objects.get(key) ?? []).filter((o) => objectOut(o, day)).map((o) => exitOf(o, fp)).filter((e): e is ExitDef => e !== null), fp.ty + fp.h, fp.place.id)
      },
      ...(this.deps.homes()?.attach(key) ?? []),
      ...village.attachChunk(key)
    ]
  }

  detach(key: string): void {
    const { world, npcs, talk, pickups, papers, repairs, touches, village } = this.deps
    const ids = fixedNpcs(key).map((n) => n.id)
    npcs.remove(ids)
    world.npcs = world.npcs.filter((n) => !ids.includes(n.id))
    talk.refresh()
    pickups.detachChunk(key)
    papers.detachChunk(key)
    repairs.detachChunk(key)
    const owner = this.exitOwners.get(key)
    if (owner) touches.detachChunk(owner)
    this.exitOwners.delete(key)
    this.deps.homes()?.detach(key)
    village.detachChunk(key)
  }
}
