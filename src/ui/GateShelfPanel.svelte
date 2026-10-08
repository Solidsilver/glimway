<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { villageErrorText } from '../content/errors'
  import { itemsFor, ITEMS_EV } from '../game/items'
  import { homesteadsFor, HOME_EV } from '../game/homestead'
  import { bus, EV } from '../game/events'
  import { assetKind, itemDef, giveable } from '../lib/items'
  import { homeItem } from '../lib/homestead'
  import type { Asset, ShelfSlotView, ShelfView } from '../lib/api/types'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import Icon from './Icon.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'

  let { session, gate = 0, onClose }: { session: Session; gate?: number; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  const items = $derived(itemsFor(session))
  const homes = $derived(homesteadsFor(session))

  const action = actionRunner()
  let loaded = $state<'loading' | 'ready' | string>('loading')
  let view = $state<ShelfView | null>(null)
  let pickingSlot = $state<number | null>(null)
  /** Bumped when the pack or the homestead changes: the sources below are plain store fields. */
  const changed = busVersion(bus, ITEMS_EV.changed, HOME_EV.changed)

  async function reread(): Promise<void> {
    const r = await village.loadShelf(gate)
    if (r.ok) {
      view = r.value
      homes.adoptShelfState(gate, view.hasShelf, view.slots.length > 0)
      loaded = 'ready'
    } else {
      if (loaded === 'loading') loaded = r.code
    }
  }

  onMount(() => {
    // The pack arriving (the read above, or another answer carrying it)
    // re-reads the shelf as well as re-opening the choice list.
    bus.on(VILLAGE_EV.changed, reread)
    bus.on(ITEMS_EV.changed, reread)
    void reread()
    if (session.link) void items.load()
    return () => {
      bus.off(VILLAGE_EV.changed, reread)
      bus.off(ITEMS_EV.changed, reread)
    }
  })

  const slots = $derived.by(() => {
    const list: (ShelfSlotView | null)[] = [null, null, null, null, null, null]
    if (view?.slots) {
      for (const s of view.slots) {
        if (s.slot >= 0 && s.slot < 6) list[s.slot] = s
      }
    }
    return list
  })

  interface StockChoice {
    asset: Asset
    name: string
    maker?: string
  }

  const stockChoices = $derived.by(() => {
    void changed.value
    const out: StockChoice[] = []
    if (!items.view) return out

    // Carried stacks
    for (const s of items.view.stacks) {
      const d = itemDef(s.itemDef)
      if (d && giveable(d)) {
        out.push({
          asset: { kind: assetKind(d), id: s.itemDef, qty: 1, maker: s.maker?.id ?? '' },
          name: d.name,
          maker: s.maker?.name
        })
      }
    }

    // Carried tool/gear instances
    for (const inst of items.view.instances) {
      const d = itemDef(inst.itemDef)
      if (d && giveable(d)) {
        out.push({
          asset: { kind: 'instance', id: inst.itemDef, qty: 1, instance: inst.id },
          name: d.name,
          maker: inst.maker?.name
        })
      }
    }

    // Carried unplaced decorations
    if (homes.mine?.items) {
      const seen = new Set<string>()
      for (const it of homes.mine.items) {
        if (it.scene === null && it.itemDef !== 'door-fox' && it.itemDef !== 'gate-shelf') {
          if (seen.has(it.itemDef)) continue
          seen.add(it.itemDef)
          const hd = homeItem(it.itemDef)
          out.push({
            asset: { kind: 'decoration', id: it.itemDef, qty: 1 },
            name: hd?.name ?? it.itemDef
          })
        }
      }
    }

    return out
  })

  function itemNameDisplay(slot: ShelfSlotView): string {
    const d = itemDef(slot.itemDef)
    if (d) return d.name
    const hd = homeItem(slot.itemDef)
    if (hd) return hd.name
    return slot.itemDef
  }

  async function take(slot: number): Promise<void> {
    const r = await action.run(`take-${slot}`, () => village.shelfAction({ op: 'take', gate, slot }), (done) => done.value.line ?? 'You took a gift from the shelf.')
    if (!r?.ok) return
    view = r.value.shelf
    homes.adoptShelfState(gate, view.hasShelf, view.slots.length > 0)
    bus.emit(EV.toast, { text: r.value.line ?? 'You took a gift from the shelf.', icon: 'gift' })
    bus.emit(VILLAGE_EV.changed)
    bus.emit(ITEMS_EV.changed)
  }

  async function stock(slot: number, asset: Asset): Promise<void> {
    const r = await action.run(`stock-${slot}`, () => village.shelfAction({ op: 'stock', gate, slot, asset }), 'Placed on the shelf for travellers to take.')
    if (!r) return
    pickingSlot = null
    if (!r.ok) return
    view = r.value.shelf
    homes.adoptShelfState(gate, view.hasShelf, view.slots.length > 0)
    bus.emit(VILLAGE_EV.changed)
    bus.emit(ITEMS_EV.changed)
  }

  const shelfItem = $derived(homes.mine?.items.find((i) => i.itemDef === 'gate-shelf' && i.scene === 'gate'))
  const isEmpty = $derived(slots.every((s) => s === null))

  async function removeShelf(): Promise<void> {
    if (!shelfItem) return
    const itemId = shelfItem.id
    const r = await action.run('remove', () => homes.act({ op: 'remove', itemId }), 'Gift shelf put away.')
    if (r?.ok) setTimeout(onClose, 800)
  }
</script>

<Panel
  id="shelf"
  icon="home"
  title={view ? (view.ownerName ? `${view.ownerName}’s Gift Shelf` : `Lot ${view.gate + 1} Gift Shelf`) : 'The Gift Shelf'}
  closeLabel="Close the gift shelf"
  {onClose}
>
  <p class="lede">Pure gifts for travellers walking past on the Commons lane. Take one into your pack: exactly one gift per traveller each day.</p>
  {#if view?.takenToday}
    <p class="notice"><Icon name="check" size={14} /> You have taken your gift from this shelf today. Walk past again tomorrow.</p>
  {/if}
  {#if action.message}<p class="msg {action.message.kind}" role="status">{action.message.text}</p>{/if}

  {#if loaded !== 'ready'}
    <p class="msg">{loaded === 'loading' ? 'Looking at the shelf…' : villageErrorText(loaded)}</p>
  {:else if view}
    {#if !view.hasShelf}<p class="none">No shelf is set out at this gate.</p>{/if}
    <ul class="slots" aria-label="Shelf slots">
      {#each slots as slot, i}
        <li class="slot-card" class:occupied={slot !== null}>
          {#if slot}
            <div class="item-info">
              <span class="thumb"><ArtIcon art={`icon-${slot.itemDef}`} name="sparkle" size={20} /></span>
              <div class="details">
                <span class="name">{itemNameDisplay(slot)}{slot.qty > 1 ? ` ×${slot.qty}` : ''}</span>
                {#if slot.maker}
                  <span class="maker"><Icon name="heart" size={12} /> by {slot.maker.name}</span>
                {/if}
              </div>
            </div>
            <button
              type="button"
              class="small primary"
              disabled={action.busy !== null || view.takenToday}
              onclick={() => take(i)}
              data-testid={`take-slot-${i}`}
            >
              {action.busy === `take-${i}` ? 'Taking…' : view.takenToday ? 'Taken today' : 'Take gift'}
            </button>
          {:else}
            <div class="empty-info">
              <span class="empty-lbl">Empty slot</span>
            </div>
            {#if view.hasShelf && view.canStock}
              <button
                type="button"
                class="small"
                class:on={pickingSlot === i}
                disabled={action.busy !== null}
                onclick={() => (pickingSlot = pickingSlot === i ? null : i)}
              >
                {pickingSlot === i ? 'Cancel' : '+ Put a gift'}
              </button>
            {/if}
          {/if}
        </li>
        {#if pickingSlot === i && view.canStock}
          <li class="picker-row">
            <p class="picker-hint">Choose a gift from your pack to leave on the shelf:</p>
            {#if stockChoices.length === 0}
              <p class="none">Nothing in your pack that can be gifted.</p>
            {:else}
              <ul class="stock-list">
                {#each stockChoices as c}
                  <li>
                    <button
                      type="button"
                      class="stock-btn"
                      disabled={action.busy !== null}
                      onclick={() => stock(i, c.asset)}
                    >
                      <span class="thumb"><ArtIcon art={`icon-${c.asset.id}`} name="sparkle" size={16} /></span>
                      <span class="nm">{c.name}</span>
                      {#if c.maker}<span class="mk">by {c.maker}</span>{/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/if}
      {/each}
    </ul>

    {#if view.canStock && isEmpty && shelfItem}
      <div class="footer-actions">
        <button type="button" class="small muted" disabled={action.busy !== null} onclick={removeShelf}>
          {action.busy === 'remove' ? 'Putting away…' : 'Take down shelf'}
        </button>
      </div>
    {/if}
  {/if}
</Panel>

<style>
  .lede {
    font-size: 13px;
    color: #5a4632;
    margin: 0 0 10px;
    line-height: 1.4;
  }
  .notice {
    font-size: 12px;
    color: #4a6f9c;
    background: #eef4fa;
    border: 1px solid #c9daea;
    border-radius: 6px;
    padding: 6px 10px;
    margin: 0 0 10px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .slots {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .slot-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    background: #fbf7ee;
    border: 1px solid #e2d7c3;
    border-radius: 6px;
  }
  .slot-card.occupied {
    background: #fffdf8;
    border-color: #d8c39e;
  }
  .item-info {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .details {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    font-weight: bold;
    font-size: 13px;
    color: var(--outline);
  }
  .maker {
    font-size: 11px;
    color: var(--danger);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .empty-info {
    color: #9c8a78;
    font-size: 12px;
    font-style: italic;
  }
  .picker-row {
    background: #f5ede0;
    border: 1px dashed #cbbda5;
    border-radius: 6px;
    padding: 8px 10px;
  }
  .picker-hint {
    font-size: 12px;
    color: #5a4632;
    margin: 0 0 6px;
  }
  .stock-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .stock-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #fff;
    border: 1px solid #d4c4aa;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }
  .stock-btn:hover {
    background: #fff9e6;
    border-color: #bfa57a;
  }
  .stock-btn .mk {
    font-size: 10px;
    color: #995533;
  }
  .footer-actions {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid #e8decb;
    display: flex;
    justify-content: flex-end;
  }
  .muted {
    background: transparent;
    border: 1px solid #d0c0a8;
    color: #8c7860;
  }
  .muted:hover {
    background: #f7f1e6;
  }
</style>
