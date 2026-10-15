/** The Commons layers share the fixed chunks' build and teardown lifecycle. */
import { chunkOfTile, fixedNpcs, footprintAt, exitOf, objectOut } from './fixed.ts'
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
import type { PipWalkOn } from '../entities/pip-walk-on.ts'
import type { Fishing } from '../entities/fishing.ts'
import type { HouseLights } from '../entities/house-lights.ts'
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
  lights?: HouseLights
  pip?: PipWalkOn
  fishing?: Fishing
  homes: () => FixedHooks | null
}

export class FixedLife implements FixedHooks {
  private homeKeys = new Set<string>()
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
      () => {
        for (const o of fp?.objects.get(key) ?? []) if (o.id === 'hearth') world.glimSpots.push({ id: 'hearth', tx: o.tx, ty: o.ty })
        talk.refresh()
        this.deps.fishing?.attachChunk(key)
      },
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
        if (fp) touches.attachChunk(owner, (fp.objects.get(key) ?? []).filter((o) => objectOut(o, day)).map((o) => exitOf(o, fp)).filter((e): e is ExitDef => e !== null), fp.ty + fp.h, fp.place.id, (fp.objects.get(key) ?? []).filter((o) => objectOut(o, day)))
      },
      ...this.late(key),
      ...(this.deps.lights?.attachChunk(key) ?? []),
      ...village.attachChunk(key)
    ]
  }

  late(key: string): (() => void)[] {
    const homes = this.deps.homes()
    if (!homes || this.homeKeys.has(key)) return []
    this.homeKeys.add(key)
    return homes.attach(key)
  }

  detach(key: string, refreshing = false): void {
    const { world, npcs, talk, pickups, papers, repairs, touches, village } = this.deps
    const ids = fixedNpcs(key).map((n) => n.id)
    npcs.remove(ids)
    this.deps.pip?.detachChunk()
    world.npcs = world.npcs.filter((n) => !ids.includes(n.id))
    world.glimSpots = world.glimSpots.filter((s) => chunkOfTile(s.tx, s.ty) !== key)
    talk.refresh()
    this.deps.fishing?.detachChunk(key)
    pickups.detachChunk(key)
    papers.detachChunk(key)
    repairs.detachChunk(key)
    const owner = this.exitOwners.get(key)
    if (owner) touches.detachChunk(owner)
    this.exitOwners.delete(key)
    if (this.homeKeys.delete(key)) this.deps.homes()?.detach(key, refreshing)
    this.deps.lights?.detachChunk(key)
    village.detachChunk(key)
  }
}
