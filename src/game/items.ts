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
import type { Asset, ItemsActionResponse, ItemsOp, ItemsView } from '../lib/api/types'
import type { ApiErrorCode } from '../lib/api/errors'
import { effectLine, giftPhrase, itemDef, menderNear, pickupById, pocketHelps } from '../lib/items'
import { bus, EV } from './events'
import type { MutationOp } from './link'
import type { Session } from './session'

export const ITEMS_EV = {
  /** The carried items changed: { what?: string }. */
  changed: 'items:changed'
} as const

export type ItemsStatus = 'guest' | 'idle' | 'loading' | 'ready' | 'offline'
export type ItemsResult<T = undefined> = { ok: true; value: T } | { ok: false; code: string; text: string }

/** Player-facing words for item refusals. */
export function itemErrorText(code: ApiErrorCode | string): string {
  switch (code) {
    case 'tool-blunt':
      return 'It’s too blunt to work with. Mend it first.'
    case 'wrong-tool':
      return 'That isn’t the tool for this.'
    case 'not-a-tool':
      return 'That isn’t a tool.'
    case 'not-needed':
      return 'No need just now.'
    case 'too-weak':
      return 'You’re too far gone to eat. Rest by a hearth first.'
    case 'not-usable-yet':
      return 'Keep it for when you need it.'
    case 'cannot-mend':
      return 'Bench tools aren’t worth mending. Make another.'
    case 'too-far-away':
      return 'You need to be right there.'
    case 'not-a-member':
    case 'tier-required':
      return 'That needs your own workshop bench.'
    case 'no-free-slot':
      return 'There’s no room on it for another fitting.'
    case 'fitting-kind-taken':
      return 'It already has one of those.'
    case 'already-fitted':
      return 'That’s already on it.'
    case 'not-fitted':
      return 'That isn’t fitted to anything.'
    case 'not-together':
      return 'Stand next to them to hand it over.'
    case 'not-giveable':
      return 'That was given to you. It stays with you.'
    case 'well-rope-broken':
      return 'The well rope is rotten through. Mend it first.'
    case 'already-returned':
      return 'You have already returned that.'
    case 'wrong-recipient':
      return 'That doesn’t belong to them.'
    case 'self-gift':
      return 'You can’t give something to yourself.'
    case 'recipient-not-found':
    case 'world-access-denied':
    case 'recipient-unavailable':
      return 'They aren’t in your world just now.'
    case 'no-such-pocket':
      return 'A satchel, apron or coat gives you a second pocket.'
    case 'not-a-keepsake':
      return 'Pockets are for keepsakes.'
    case 'off-hand-closed':
      return 'Your off hand opens when you take a class.'
    case 'not-for-the-off-hand':
      return 'That isn’t something to carry in your off hand.'
    case 'already-picked-up':
      return 'You’ve already picked that up.'
    case 'condition-unmet':
      return 'You aren’t ready for that yet.'
    case 'already-granted':
      return 'You’ve already received that heirloom.'
    case 'insufficient-items':
      return 'You don’t have that any more.'
    case 'insufficient-materials':
      return 'You don’t have enough to mend it.'
    case 'insufficient-embers':
      return 'You don’t have enough embers.'
    case 'item-not-available':
    case 'item-not-found':
      return 'That isn’t in your pack any more.'
    case 'offline':
      return 'Needs a connection. Nothing changed — try again when you’re back online.'
    case 'superseded':
      return 'Another device took over this journey.'
    case 'busy':
      return 'Hold on — the last one is still on its way.'
    case 'resolved':
      return 'Your last request went through after all. Check what you have before trying again.'
    case 'pending':
      return 'No answer yet — it may have gone through. We’ll find out when the connection is back; nothing will be taken twice.'
    case 'guest':
      return 'Things you carry are kept in a world. Sign in to yours from the Menu.'
    default:
      return 'That didn’t go through. Nothing changed — try again in a moment.'
  }
}

export { giftPhrase } from '../lib/items'

export class Items {
  view: ItemsView | null = null
  status: ItemsStatus

  constructor(private session: Session) {
    this.status = session.link ? 'idle' : 'guest'
    bus.on(EV.mutationResolved, (p: { op: MutationOp; outcome: 'landed' | 'refused' }) => {
      if (current?.items !== this || p.op.kind !== 'items') return
      void this.load().then(() => {
        bus.emit(EV.toast, { text: p.outcome === 'landed' ? 'Your last change to your pack went through after all.' : 'Your last change to your pack didn’t go through. Nothing changed.', icon: 'bag' })
      })
    })
    bus.on(EV.gift, (g: { fromName: string; kind: string; itemDef: string; qty: number }) => {
      if (current?.items !== this) return
      bus.emit(EV.toast, { text: `${g.fromName} gave you ${giftPhrase(g.itemDef, g.qty)}.`, icon: 'heart' })
      void this.load()
    })
  }

  /** Read what's carried (connected only). */
  async load(): Promise<ItemsResult> {
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

  private async run(op: ItemsOp, fields: Record<string, unknown>): Promise<ItemsResult<ItemsActionResponse['result']>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<ItemsActionResponse>({ kind: 'items', op, fields })
    if (!r.ok) return fail(r.code)
    this.adopt(r.res.result.items, op)
    return { ok: true, value: r.res.result }
  }

  /** One use of a tool (gathering will call this; the dev hook does now). */
  useTool(instance: string, action?: string) {
    return this.run('use', { instance, ...(action ? { action } : {}) })
  }
  /** Eat or drink one (any maker's, unmarked first, unless one is named). */
  useItem(itemDef: string, maker?: string) {
    return this.run('use', { itemDef, ...(maker !== undefined ? { maker } : {}) })
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
        if (p) bus.emit(EV.toast, { text: p.found, icon: 'bag' })
      }
      return r
    })
  }
  returnKeepsake(itemDef: string, target: string) {
    return this.run('return', { itemDef, target })
  }
  grantHeirloom(itemDef: string) {
    return this.run('heirloom', { itemDef })
  }
  giveAdaOil(itemDef = 'hearth-oil') {
    return this.run('ada-oil', { itemDef })
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
    bus.emit(ITEMS_EV.changed, { what })
  }
}

/** One help in words, for lists. */
export const helpLine = effectLine
export const defOf = itemDef

function fail(code: string): { ok: false; code: string; text: string } {
  return { ok: false, code, text: itemErrorText(code) }
}

let current: { session: Session; items: Items } | null = null

/** The items state for this session (made on first use). */
export function itemsFor(session: Session): Items {
  if (!current || current.session !== session) current = { session, items: new Items(session) }
  return current.items
}
