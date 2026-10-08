/**
 * Items, game side (docs/items/): what the player carries in a world, read
 * from and changed through the server's item model (stacks, instances with
 * condition and fittings, pockets, the off hand, pickups). No Phaser here:
 * the inventory panel, the pickups in the world and the hero's off hand
 * read it and hear about changes on the bus.
 *
 * Guests carry only the save's pack (src/lib/inventory.ts); everything here
 * needs a world.
 */
import type { Asset, ItemsActionResponse, ItemsOp, ItemsView } from '../lib/api/types.ts'
import type { Refusal, Result } from '../lib/api/errors.ts'
import { itemErrorText } from '../content/errors.ts'
import { giftPhrase, ITEM_RULES, menderNear, pickupById, pocketHelps } from '../lib/items.ts'
import { TILE } from '../lib/tile.ts'
import { bus, EV } from './events.ts'
import type { Session } from './session.ts'
import { presence } from './presence.ts'

export type ItemsStatus = 'guest' | 'idle' | 'loading' | 'ready' | 'offline'

export { giftPhrase } from '../lib/items.ts'

export class Items {
  view: ItemsView | null = null
  status: ItemsStatus
  private inFlightGrants = new Set<string>()
  private inFlightAdaOil = false

  private readonly session: Session

  constructor(session: Session) {
    this.session = session
    this.status = session.link ? 'idle' : 'guest'
    bus.on(EV.mutationResolved, (p) => {
      if (current?.items !== this || p.op.kind !== 'items') return
      void this.load().then(() => {
        bus.emit(EV.toast, { text: p.outcome === 'landed' ? 'Your last change to your pack went through after all.' : 'Your last change to your pack didn’t go through. Nothing changed.', icon: 'bag' })
      })
    })
    bus.on(EV.gift, (g) => {
      if (current?.items !== this) return
      bus.emit(EV.toast, { text: `${g.fromName} gave you ${giftPhrase(g.itemDef, g.qty)}.`, icon: 'heart' })
      void this.load()
    })
  }

  /** Read what's carried (connected only). */
  async load(): Promise<Result> {
    const link = this.session.link
    if (!link) {
      this.status = 'guest'
      return fail('guest')
    }
    this.status = 'loading'
    const r = await link.readWith((raw) => raw.items())
    if (!r.ok) {
      this.status = 'offline'
      this.emit('status')
      return fail(r.code)
    }
    this.adopt(r.value.items)
    return { ok: true, value: undefined }
  }

  private adopt(v: ItemsView, what = 'items'): void {
    this.view = v
    this.status = 'ready'
    this.emit(what)
  }

  /** Adopt an items view carried in another answer (a village mend's). */
  adoptView(v: ItemsView): void {
    if (this.status !== 'guest') this.adopt(v)
  }

  private async run(op: ItemsOp, fields: Record<string, unknown>): Promise<Result<ItemsActionResponse['result']>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<ItemsActionResponse>({ kind: 'items', op, fields })
    if (!r.ok) return fail(r.code)
    this.adopt(r.res.result.items, op)
    return { ok: true, value: r.res.result }
  }

  /**
   * One chop, break or dig with a tool, where the hero stands (the server
   * reads the area from the progress that rides along). On home land the
   * tile names the piece; elsewhere the woods are scenery. In the Wilds the
   * region rides along (the Tangle's trees stand in the Tangle only). A made
   * tool that wears out here thanks its maker, as any use does.
   */
  async gather(tool: string, action: string, target: string, visitId: string, where: { tile?: [number, number]; region?: string } = {}) {
    const makerId = this.view?.instances.find((i) => i.id === tool)?.maker?.id
    const r = await this.run('gather', { tool, action, target, visitId, ...(where.tile ? { tile: where.tile } : {}), ...(where.region ? { region: where.region } : {}) })
    if (r.ok && (r.value?.wear?.broke || r.value?.wear?.woreOut) && makerId && makerId !== this.session.link?.accountId) {
      this.thankNearby(makerId)
    }
    return r
  }
  /** Plant a seed or sapling on your own land, at a tile beside you. */
  plant(itemDef: string, tile: [number, number]) {
    return this.run('plant', { itemDef, tile })
  }
  /** One use of a tool (gathering wears tools through gather; the dev hook calls this). */
  async useTool(instance: string, action?: string) {
    const makerId = this.view?.instances.find((i) => i.id === instance)?.maker?.id
    const r = await this.run('use', { instance, ...(action ? { action } : {}) })
    if (r.ok && (r.value?.wear?.broke || r.value?.wear?.woreOut) && makerId && makerId !== this.session.link?.accountId) {
      this.thankNearby(makerId)
    }
    return r
  }
  /** Eat or drink one (any maker's, unmarked first, unless one is named). */
  async useItem(itemDef: string, maker?: string, unmoored?: boolean) {
    const r = await this.run('use', { itemDef, ...(maker !== undefined ? { maker } : {}), ...(unmoored !== undefined ? { unmoored } : {}) })
    if (r.ok) {
      if (itemDef === 'comfrey-salve') {
        bus.emit(EV.clearUnmoored, { instant: true })
      } else if (itemDef === 'willow-bark-tea') {
        bus.emit(EV.clearUnmoored, { instant: false })
      }
      if (maker && maker !== this.session.link?.accountId) this.thankNearby(maker)
    }
    return r
  }

  private thankNearby(makerId: string): void {
    const feed = presence()
    if (!feed) return
    if (feed.isWithin(makerId, ITEM_RULES.thanks.nearbyTiles * TILE)) {
      bus.emit(EV.emote, { accountId: makerId, id: 'heart' })
    }
  }
  /** Mend an heirloom at your bench ('bench') or by a mender ('silas', 'orrin'). */
  repair(instance: string, at: string) {
    return this.run('repair', { instance, at })
  }
  fit(tool: string, fitting: string) {
    return this.run('fit', { tool, instance: fitting })
  }
  unfit(fitting: string) {
    return this.run('unfit', { instance: fitting })
  }
  give(toId: string, asset: Asset) {
    return this.run('give', { toId, asset })
  }
  /** Pocket 1 or 2; null empties it. */
  pocket(slot: number, itemDef: string | null) {
    return this.run('pocket', { slot, ...(itemDef ? { itemDef } : {}) })
  }
  /** Carry an instance or a keepsake in the off hand; null puts it away. */
  offHand(what: { instance: string } | { itemDef: string } | null) {
    return this.run('offhand', what ?? {})
  }
  pickup(id: string) {
    return this.run('pickup', { pickup: id }).then((r) => {
      if (r.ok) {
        const p = pickupById(id)
        if (p) bus.emit(EV.toast, { text: p.found, icon: 'bag', kind: 'gain', gain: { to: 'bag', itemDef: p.item, qty: p.qty } })
      }
      return r
    })
  }
  returnKeepsake(itemDef: string, target: string) {
    return this.run('return', { itemDef, target })
  }
  isGrantInFlight(itemDef: string): boolean {
    return this.inFlightGrants.has(itemDef)
  }
  isAdaOilInFlight(): boolean {
    return this.inFlightAdaOil
  }
  grantHeirloom(itemDef: string) {
    if (this.inFlightGrants.has(itemDef)) return Promise.resolve(fail('busy'))
    this.inFlightGrants.add(itemDef)
    return this.run('heirloom', { itemDef }).finally(() => {
      this.inFlightGrants.delete(itemDef)
    })
  }
  giveAdaOil() {
    if (this.inFlightAdaOil) return Promise.resolve(fail('busy'))
    this.inFlightAdaOil = true
    return this.run('ada-oil', { itemDef: 'hearth-oil' }).finally(() => {
      this.inFlightAdaOil = false
    })
  }
  /** Buy a good from a seller (Hazel's kitchen, Finn's mill door, the Carting Day stall). */
  buy(seller: string, good: string) {
    return this.run('buy', { seller, good })
  }

  // ------------------------------------------------------------ reads

  pickedUp(): string[] {
    return this.view?.pickedUp ?? []
  }
  pocketed(): (string | null)[] {
    return this.view?.pockets.map((p) => p.itemDef) ?? []
  }
  /** A pocketed keepsake gives this help (`papers-glint`, …). */
  helps(type: string): boolean {
    return pocketHelps(this.pocketed(), type)
  }
  /** What the off hand holds, by definition (null: empty or closed). */
  offHandItem(): string | null {
    return this.view?.offHand.open ? this.view.offHand.itemDef : null
  }
  /** The mender standing near the hero right now, if any. */
  menderHere(): { npc: string; name: string } | null {
    const s = this.session.state
    return menderNear(s.area, s.position.x, s.position.y)
  }

  private emit(what: string): void {
    bus.emit(EV.itemsChanged, { what })
  }
}

function fail(code: string): Refusal {
  return { ok: false, code, text: itemErrorText(code) }
}

let current: { session: Session; items: Items } | null = null

/** The items state for this session (made on first use). */
export function itemsFor(session: Session): Items {
  if (!current || current.session !== session) current = { session, items: new Items(session) }
  return current.items
}
