import type { HomeView, StallView } from '../../lib/api/types.ts'
import { nextHomecoming } from '../../lib/companions.ts'
import { lotAt, lotOrigin } from '../../lib/lots.ts'
import { TILE } from '../../lib/tile.ts'
import { buildLand, type LandWorld } from '../lot-land.ts'
import { HomesteadLayer } from '../entities/homesteads.ts'
import { HomesteadArt } from '../entities/homestead-art.ts'
import { HomesteadTalk } from '../entities/homestead-talk.ts'
import { HomesteadArranging } from '../entities/homestead-placement.ts'
import { HomesteadYard } from '../entities/homestead-yard.ts'
import { homeward } from '../entities/led-mount.ts'

export class LotHomes {
  private lots = new Map<number, { child: HomesteadLayer }>()
  private read = new Set<number>()
  private homecoming = new Map<number, Phaser.Time.TimerEvent>()
  actionOwner: HomesteadLayer | null = null
  private previous: HomesteadLayer | null = null
  constructor(private root: HomesteadLayer) {}

  private recheckStalls(gate: number, stalls: readonly StallView[]): void {
    this.homecoming.get(gate)?.remove()
    const next = nextHomecoming(stalls, this.root.homes.myId, homeward, Date.now())
    if (next !== null) {
      const timer = this.root.scene.time.delayedCall(Math.max(0, next - Date.now()) + 50, () => {
        this.homecoming.delete(gate)
        this.refresh(new Set([gate]))
      })
      this.homecoming.set(gate, timer)
    } else {
      this.homecoming.delete(gate)
    }
  }

  active(): HomesteadLayer | null {
    const placing = [...this.lots.values()].find((l) => l.child.arranging.placement)
    if (placing) return placing.child
    const p = this.root.deps.hero()
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE)
    const g = lotAt(Math.floor(tx / 24), Math.floor(ty / 24))
    if (g === null) return null
    const o = lotOrigin(g)
    const lx = tx - o.tx, ly = ty - o.ty
    if (lx < 2 || lx > 21 || ly < 0 || ly >= 20) return null
    return this.lots.get(g)?.child ?? null
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
      if (!this.root.homes.homes.has(gate)) {
        void this.root.homes.fetchHome(gate).then(() => {
          if (this.lots.get(gate) === entry && !child.gone) {
            if (this.active() === child && child.announcePending) {
              child.announcePending = false
              child.announce()
            }
            this.refresh(new Set([gate]))
          }
        })
      }
    }
    return [...child.art.landSteps(), () => child.yard?.sync(child.here()), () => { const h = child.here(); if (h) this.recheckStalls(gate, h.stalls) }, () => this.publish(child)].map((step) => () => { if (this.lots.get(gate) === entry && !child.gone) step() })
  }

  private publish(child: HomesteadLayer): void {
    this.root.deps.interactables.register(child, child.talk.interactionList().map((p) => ({ ...p, id: `lot:${child.gate!}:${p.id}` as import('../worlds.ts').InteractId, activate: () => { this.actionOwner = child; p.activate() } })))
  }

  refresh(gates?: Set<number>): void {
    for (const [gate, { child }] of this.lots) if (!gates || gates.has(gate)) {
      if (child.announcePending && (this.root.homes.homes.has(gate) || this.root.homes.gateInfo(gate)?.homeId === null)) {
        child.announcePending = false
        child.announce()
      }
      const h = child.here()
      if (h) this.recheckStalls(gate, h.stalls)
      const origin = lotOrigin(gate), gridOrigin = { x: origin.tx * TILE, y: origin.ty * TILE }
      const L = buildLand(gate)
      Object.assign(L, { gridOrigin, areaId: 'outdoors', origin: { x: L.origin.x + gridOrigin.x, y: L.origin.y + gridOrigin.y }, door: { tx: origin.tx + 11, ty: origin.ty + 7 }, doorstep: { tx: origin.tx + 11, ty: origin.ty + 8 }, mailbox: { tx: origin.tx + 13, ty: origin.ty + 18 } })
      Object.assign(child, { land: L })
      child.art.drawLand()
      child.yard?.sync(h)
      this.publish(child)
      if (child.arranging.placement) {
        child.arranging.refreshPlacement()
      }
      const o = lotOrigin(gate), key = `${o.tx / 24},${o.ty / 24}`
      this.root.deps.refreshLot?.(key)
    }
  }

  detach(key: string): void {
    const [cx, cy] = key.split(',').map(Number), gate = lotAt(cx!, cy!)
    if (gate === null) return
    this.homecoming.get(gate)?.remove()
    this.homecoming.delete(gate)
    this.read.delete(gate)
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
      if (active) {
        const info = this.root.homes.gateInfo(active.gate!)
        if (!this.root.homes.connected || info?.homeId === null || this.root.homes.homes.has(active.gate!)) {
          active.announce()
        } else {
          active.announcePending = true
        }
      }
    }
    if (active?.here()?.member) this.root.homes.arrived(active.gate!)
    active?.arranging.update(dt)
    for (const { child } of this.lots.values()) child.yard?.update(dt)
  }

  petPoints() {
    return [...this.lots.values()].flatMap(({ child }) => child.yard?.petPoints() ?? [])
  }

  destroy(): void {
    for (const t of this.homecoming.values()) t.remove()
    this.homecoming.clear()
    for (const gate of [...this.lots.keys()]) { const o = lotOrigin(gate); this.detach(`${o.tx / 24},${o.ty / 24}`) }
  }
  companionsOf(accountId: string): void {
    for (const [gate, { child }] of this.lots) {
      const h = child.here()
      if (h && (h.members.some((m) => m.id === accountId) || h.stalls.some((s) => s.ownerId === accountId))) void this.root.homes.fetchHome(gate)
    }
  }
  companions(): void {
    this.refresh()
    for (const [gate, { child }] of this.lots) {
      const h = child.here()
      if (h) this.recheckStalls(gate, h.stalls)
    }
  }
  has(gate: number): boolean { return this.lots.has(gate) }
  home(gate: number): HomeView | null { return this.lots.get(gate)?.child.here() ?? null }
}
