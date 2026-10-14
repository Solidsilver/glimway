/** Mutable home drawings share the fixed window's per-piece build budget. */
import type { HomeView } from '../../lib/api/types.ts'
import { lotAt, lotOrigin } from '../../lib/lots.ts'
import { TILE } from '../../lib/tile.ts'
import { buildLand, type LandWorld } from '../homeland.ts'
import { HomesteadLayer } from '../entities/homesteads.ts'
import { HomesteadArt } from '../entities/homestead-art.ts'
import { HomesteadTalk } from '../entities/homestead-talk.ts'
import { HomesteadArranging } from '../entities/homestead-placement.ts'
import { HomesteadYard } from '../entities/homestead-yard.ts'

export class LotHomes {
  private lots = new Map<number, { child: HomesteadLayer }>()
  private read = new Set<number>()
  actionOwner: HomesteadLayer | null = null
  private previous: HomesteadLayer | null = null
  constructor(private root: HomesteadLayer) {}

  active(): HomesteadLayer | null {
    const placing = [...this.lots.values()].find((l) => l.child.arranging.placement)
    if (placing) return placing.child
    const p = this.root.deps.hero(), g = lotAt(Math.floor(p.x / (24 * TILE)), Math.floor((p.y - 1) / (24 * TILE)))
    return g === null ? null : this.lots.get(g)?.child ?? null
  }

  attach(key: string): (() => void)[] {
    const [cx, cy] = key.split(',').map(Number), gate = lotAt(cx!, cy!)
    if (gate === null) return []
    this.detach(key)
    const origin = lotOrigin(gate), gridOrigin = { x: origin.tx * TILE, y: origin.ty * TILE }
    const L = buildLand(gate)
    Object.assign(L, { gridOrigin, areaId: 'outdoors', origin: { x: L.origin.x + gridOrigin.x, y: L.origin.y + gridOrigin.y }, door: { tx: origin.tx + 11, ty: origin.ty + 7 }, doorstep: { tx: origin.tx + 11, ty: origin.ty + 8 }, mailbox: { tx: origin.tx + 13, ty: origin.ty + 18 } })
    const child = Object.assign(Object.create(HomesteadLayer.prototype), {
      scene: this.root.scene, homes: this.root.homes, village: this.root.village,
      deps: { ...this.root.deps, world: L, commons: null, rebuild: () => this.root.deps.refreshLot?.(key) },
      land: L as LandWorld, gate, commons: null, yardRoom: null, gone: false, lots: null,
      yard: new HomesteadYard(this.root.scene, this.root.deps.reducedMotion, this.root.deps.hero, gridOrigin)
    }) as HomesteadLayer
    Object.assign(child, { art: new HomesteadArt(child), talk: new HomesteadTalk(child), arranging: new HomesteadArranging(child) })
    const entry = { child }
    this.lots.set(gate, entry)
    if (!this.read.has(gate) && this.root.homes.connected) {
      this.read.add(gate)
      void this.root.homes.fetchHome(gate)
    }
    return [...child.art.landSteps(), () => child.yard?.sync(child.here()), () => this.publish(child)].map((step) => () => { if (this.lots.get(gate) === entry && !child.gone) step() })
  }

  private publish(child: HomesteadLayer): void {
    this.root.deps.interactables.register(child, child.talk.interactionList().map((p) => ({ ...p, id: `lot:${child.gate!}:${p.id}` as import('../worlds.ts').InteractId, activate: () => { this.actionOwner = child; p.activate() } })))
  }

  refresh(gates?: Set<number>): void {
    for (const [gate] of this.lots) if (!gates || gates.has(gate)) {
      const o = lotOrigin(gate), key = `${o.tx / 24},${o.ty / 24}`
      // The window refreshes base collision/decor together with this overlay.
      this.root.deps.refreshLot?.(key)
    }
  }

  detach(key: string): void {
    const [cx, cy] = key.split(',').map(Number), gate = lotAt(cx!, cy!)
    if (gate === null) return
    const entry = this.lots.get(gate)
    if (!entry) return
    const child = entry.child
    child.gone = true
    child.arranging.endPlacement(false)
    child.yard?.destroy()
    child.art.destroyLand()
    this.root.deps.interactables.register(child, [])
    if (this.actionOwner === child) this.actionOwner = null
    if (this.previous === child) this.previous = null
    this.lots.delete(gate)
  }

  update(dt: number): void {
    const active = this.active()
    if (active !== this.previous) {
      this.previous?.arranging.emitArrange({ available: false, scene: null, tier: 0 })
      this.previous = active
      if (active?.here()?.member) this.root.homes.arrived(active.gate!)
    }
    active?.arranging.update(dt)
    for (const { child } of this.lots.values()) child.yard?.update(dt)
  }

  destroy(): void { for (const gate of [...this.lots.keys()]) { const o = lotOrigin(gate); this.detach(`${o.tx / 24},${o.ty / 24}`) } }
  companionsOf(accountId: string): void {
    for (const [gate, { child }] of this.lots) {
      const h = child.here()
      if (h && (h.members.some((m) => m.id === accountId) || h.stalls.some((s) => s.ownerId === accountId))) void this.root.homes.fetchHome(gate)
    }
  }
  companions(): void { this.refresh() }
  has(gate: number): boolean { return this.lots.has(gate) }
  home(gate: number): HomeView | null { return this.lots.get(gate)?.child.here() ?? null }
}
