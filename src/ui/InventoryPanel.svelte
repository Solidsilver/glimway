<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { HOME_EV, homesteadsFor } from '../game/homestead'
  import { ITEMS_EV, giftPhrase, itemsFor } from '../game/items'
  import { presence } from '../game/presence'
  import { bus } from '../game/events'
  import { fitTargets, groupInventory, inventoryEntries, modelEntries, newTabs, type InventoryEntry, type InventoryTab } from '../lib/inventory'
  import { assetKind, conditionFraction, fittingLine, itemDef, itemName, ITEM_RULES } from '../lib/items'
  import type { Asset, InstanceView } from '../lib/api/types'
  import { INVENTORY_TABS, inventoryCopy } from '../content/inventory'
  import { ui } from './store.svelte'
  import { home } from './home.svelte'
  import { inventory } from './inventory.svelte'
  import { papers } from './papers.svelte'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import PapersTab from './PapersTab.svelte'

  /**
   * Everything you carry, in one place (I or the HUD's bag button): tools,
   * supplies, keepsakes, home goods and papers, with quest things in a small
   * "For the road" section. In a world it reads the server's item model:
   * tools with their condition, fittings and maker's mark, your pockets and
   * off hand, and what you can do with each thing (use, pocket, carry,
   * give, mend, fit). Guests see the save's pack. App owns the I/Escape keys.
   */
  let { session, onClose, onOwnChest }: { session: Session; onClose: () => void; onOwnChest?: () => void } = $props()

  const village = $derived(villageFor(session))
  const homes = $derived(homesteadsFor(session))
  const items = $derived(itemsFor(session))
  const connected = $derived(!!session.link)
  let tab = $state<InventoryTab>('supplies')
  let version = $state(0)
  let busy = $state<string | null>(null)
  let message = $state<{ text: string; kind: 'ok' | 'error' } | null>(null)
  /** The row whose hand-over / mend / fit chooser is open: `${action}:${key}`. */
  let open = $state<string | null>(null)

  onMount(() => {
    const bump = () => (version += 1)
    bus.on(VILLAGE_EV.changed, bump)
    bus.on(HOME_EV.changed, bump)
    bus.on(ITEMS_EV.changed, bump)
    inventory.syncPack(session.state.inventory)
    // In a world, ask for the item model and your home's pieces. Offline,
    // what's known shows.
    if (session.link) {
      void items.load()
      void homes.load()
    }
    // Open on the first tab with something new, else Supplies.
    const fresh = newTabs(entries, inventory.seenSet)
    const first = INVENTORY_TABS.find((t) => t.id !== 'papers' && fresh.has(t.id))
    if (first) tab = first.id
    return () => {
      bus.off(VILLAGE_EV.changed, bump)
      bus.off(HOME_EV.changed, bump)
      bus.off(ITEMS_EV.changed, bump)
      // Whatever was on screen has now been seen.
      markTab(tab)
    }
  })

  const model = $derived.by(() => {
    void version
    return connected && items.view ? items.view : null
  })

  const entries = $derived.by<InventoryEntry[]>(() => {
    void version
    const pack = inventory.pack.length ? inventory.pack : session.state.inventory
    const decorations = homes.mine?.items ?? []
    if (model) return modelEntries(model, { pack, decorations })
    return inventoryEntries({
      pack,
      materials: ui.materials ?? village.inventory?.materials ?? null,
      items: village.inventory?.items ?? null,
      decorations
    })
  })
  const groups = $derived(groupInventory(entries))
  const fresh = $derived(newTabs(entries, inventory.seenSet))
  const seen = $derived(inventory.seenSet)

  function markTab(t: InventoryTab): void {
    if (t === 'papers') return
    inventory.markSeen([...groups[t].main, ...groups[t].road].map((e) => e.key))
  }

  function select(t: InventoryTab): void {
    if (t === tab) return
    markTab(tab)
    tab = t
    open = null
    message = null
  }

  function onTabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const i = INVENTORY_TABS.findIndex((t) => t.id === tab)
    const n = INVENTORY_TABS.length
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n
    select(INVENTORY_TABS[next].id)
    document.getElementById(`inv-tab-${INVENTORY_TABS[next].id}`)?.focus()
  }

  /** "1 set out · 2 put away" for a home good. */
  const where = (e: InventoryEntry) =>
    [e.placed ? inventoryCopy.placed(e.placed) : '', e.stored ? inventoryCopy.stored(e.stored) : ''].filter(Boolean).join(' · ')
  /** Kinds of thing on a tab (not the sum of quantities). */
  const count = (t: InventoryTab) => (t === 'papers' ? papers.found.length : groups[t].main.length + groups[t].road.length)
  const tabHasNew = (t: InventoryTab) => (t === 'papers' ? papers.unread.length > 0 : fresh.has(t))

  /** The delivered art for an icon: the wear-state frame when it's loaded, else the item's own. */
  function artOf(e: InventoryEntry): string | null {
    if (e.stateArt && ui.artIcons[e.stateArt]) return e.stateArt
    return e.art
  }

  // ------------------------------------------------------------ actions

  async function act(id: string, run: () => Promise<{ ok: true; value: unknown } | { ok: false; text: string }>, ok: string): Promise<void> {
    if (busy) return
    busy = id
    message = null
    const r = await run()
    busy = null
    open = null
    message = r.ok ? { text: ok, kind: 'ok' } : { text: r.text, kind: 'error' }
  }

  const maker = (e: InventoryEntry) => (e.maker ? e.maker.id : undefined)

  function useIt(e: InventoryEntry): void {
    void act(`use:${e.key}`, () => items.useItem(e.id, e.maker ? e.maker.id : '', ui.unmoored), `You used ${giftPhrase(e.id, 1)}.`)
  }

  function pocketIt(e: InventoryEntry): void {
    if (e.pocket) {
      void act(`pocket:${e.key}`, () => items.pocket(e.pocket!, null), `${e.name} is back in your pack.`)
      return
    }
    const slots = model?.pockets ?? []
    const empty = slots.findIndex((p) => !p.itemDef)
    const slot = empty >= 0 ? empty + 1 : 1
    void act(`pocket:${e.key}`, () => items.pocket(slot, e.id), `${e.name} is in your pocket.`)
  }

  function carryIt(e: InventoryEntry): void {
    if (e.inHand) {
      void act(`carry:${e.key}`, () => items.offHand(null), `You put ${e.name.toLowerCase()} away.`)
      return
    }
    void act(`carry:${e.key}`, () => items.offHand(e.instance ? { instance: e.instance.id } : { itemDef: e.id }), `You carry ${giftPhrase(e.id, 1)} in your off hand.`)
  }

  /** Players standing close enough to hand something to. */
  function nearby(): { habiticaId: string; displayName: string }[] {
    const feed = presence()
    if (!feed) return []
    const p = session.state.position
    return feed.nearby(p.x, p.y, ITEM_RULES.give.radiusTiles * 16)
  }

  function assetOf(e: InventoryEntry): Asset {
    const d = itemDef(e.id)
    const kind = d ? assetKind(d) : 'item'
    if (e.instance) return { kind: 'instance', id: e.id, qty: 1, instance: e.instance.id }
    const m = maker(e)
    return { kind: kind === 'instance' ? 'item' : kind, id: e.id, qty: 1, ...(m !== undefined ? { maker: m } : { maker: '' }) } as Asset
  }

  function giveIt(e: InventoryEntry, to: { habiticaId: string; displayName: string }): void {
    void act(`give:${e.key}`, () => items.give(to.habiticaId, assetOf(e)), `You gave ${to.displayName} ${giftPhrase(e.id, 1)}.`)
  }

  function costLine(cost: Record<string, number> | undefined): string {
    return Object.entries(cost ?? {})
      .map(([id, n]) => `${n} ${itemName(id).toLowerCase()}`)
      .join(', ')
  }

  function mendIt(e: InventoryEntry, at: string, who: string): void {
    void act(`mend:${e.key}`, () => items.repair(e.instance!.id, at), at === 'bench' ? `You mended the ${e.name.toLowerCase()} at your bench.` : `${who} mended the ${e.name.toLowerCase()} while you talked.`)
  }

  function fitIt(fitting: InstanceView, tool: InstanceView): void {
    void act(`fit:${fitting.id}`, () => items.fit(tool.id, fitting.id), `${itemName(fitting.itemDef)} fitted to the ${itemName(tool.itemDef).toLowerCase()}.`)
  }

  function takeOff(fittingId: string, def: string): void {
    void act(`unfit:${fittingId}`, () => items.unfit(fittingId), `${itemName(def)} is back in your pack.`)
  }

  const percent = (i: InstanceView) => Math.round(conditionFraction(i) * 100)
  const wearWords = (i: InstanceView) => {
    if (i.wardenSet) {
      if (i.condition === i.maxCondition) return 'Sharp'
      if (i.condition === 0) return inventoryCopy.state['dull'] ?? 'Dull. Sharp again by morning.'
      return inventoryCopy.usesLeft(i.usesLeft)
    }
    return i.maxCondition === 0 ? inventoryCopy.neverWears : (inventoryCopy.state[i.state] ?? inventoryCopy.usesLeft(i.usesLeft))
  }
  const toggleOpen = (id: string) => {
    open = open === id ? null : id
    message = null
  }
</script>

{#snippet slotChip(label: string, def: string | null, onEmpty: (() => void) | null, testid: string, note?: string)}
  <span class="slot" class:filled={!!def} data-testid={testid}>
    <span class="slot-label">{label}</span>
    {#if def}
      <ArtIcon art={def} name="sparkle" size={16} />
      <b>{itemName(def)}</b>
      {#if onEmpty}<button type="button" class="x" aria-label={`Take ${itemName(def)} out`} disabled={busy !== null} onclick={onEmpty}><Icon name="close" size={10} /></button>{/if}
    {:else}
      <i>{note ?? inventoryCopy.pocketEmpty}</i>
    {/if}
  </span>
{/snippet}

{#snippet row(e: InventoryEntry)}
  <li class="item" class:new={!seen.has(e.key)} data-item={e.key} data-state={e.instance?.state}>
    <span class="ii" class:dim={e.instance && (e.instance.state === 'blunt' || e.instance.state === 'cracked')}>
      {#if e.kind === 'decoration' && home.thumbs[e.id]}
        <img class="thumb" src={home.thumbs[e.id]} alt="" />
      {:else}
        <ArtIcon art={artOf(e)} name={e.icon} size={32} />
      {/if}
      {#if e.instance?.wardenSet}
        <span class="grey-chip" title="Warden-set" data-testid="grey-chip"></span>
      {/if}
    </span>
    <span class="txt">
      <span class="name">
        <b>{e.name}</b>
        {#if !seen.has(e.key)}<span class="badge">{inventoryCopy.newBadge}</span>{/if}
        {#if e.pocket}<span class="tag" data-testid="in-pocket">In pocket {e.pocket}</span>{/if}
        {#if e.inHand}<span class="tag" data-testid="in-hand">In your off hand</span>{/if}
      </span>
      {#if e.blurb}<small>{e.blurb}</small>{/if}
      {#if e.maker}<small class="maker" data-testid="maker">{inventoryCopy.madeBy(e.maker.name)}</small>{/if}
      {#if e.instance && e.instance.maxCondition > 0}
        <span class="wear">
          <span
            class="bar"
            class:low={percent(e.instance) < ITEM_RULES.wear.wornBelowPercent}
            role="meter"
            aria-label={`${e.name} condition`}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={percent(e.instance)}
            data-testid="condition"
          ><span style={`width:${percent(e.instance)}%`}></span></span>
          <small class="uses" data-testid="wear-words">{wearWords(e.instance)}</small>
        </span>
      {:else if e.instance && e.kind === 'tool'}
        <small class="uses">{inventoryCopy.neverWears}</small>
      {/if}
      {#if e.instance && e.instance.fittings.length > 0}
        <span class="fittings" data-testid="fittings">
          {#each e.instance.fittings as f (f.id)}
            <span class="fit" data-fitting={f.itemDef}>
              <ArtIcon art={f.itemDef} name="sparkle" size={16} />
              {fittingLine(f.fitting)}{#if f.maxCondition > 0}<i> · {inventoryCopy.usesLeft(f.usesLeft)}</i>{/if}
              <button type="button" class="x" aria-label={`${inventoryCopy.actions.takeOff} ${itemName(f.itemDef)}`} disabled={busy !== null} onclick={() => takeOff(f.id, f.itemDef)}><Icon name="close" size={10} /></button>
            </span>
          {/each}
        </span>
      {/if}
      {#if e.helps && e.helps.length > 0}<small class="helps">{e.helps.join(' · ')}</small>{/if}
      {#if e.rule && e.kind === 'tool'}<small class="rule">{e.rule}</small>{/if}
      {#if e.kind === 'decoration'}
        <small class="where">{where(e)}</small>
      {/if}
      {#if model && e.section === 'main' && e.kind !== 'decoration' && e.kind !== 'material'}
        <span class="acts">
          {#if e.usable && session.state.hp > 0}<button type="button" class="act primary" data-act="use" disabled={busy !== null} onclick={() => useIt(e)}>{inventoryCopy.actions.use}</button>{/if}
          {#if e.pocketable}<button type="button" class="act" data-act="pocket" disabled={busy !== null} onclick={() => pocketIt(e)}>{e.pocket ? inventoryCopy.actions.unpocket : inventoryCopy.actions.pocket}</button>{/if}
          {#if e.carryable}<button type="button" class="act" data-act="carry" disabled={busy !== null} onclick={() => carryIt(e)}>{e.inHand ? inventoryCopy.actions.putAway : inventoryCopy.actions.carry}</button>{/if}
          {#if e.mendable}<button type="button" class="act" data-act="mend" aria-expanded={open === `mend:${e.key}`} disabled={busy !== null} onclick={() => toggleOpen(`mend:${e.key}`)}>{inventoryCopy.actions.mend}…</button>{/if}
          {#if e.kind === 'fitting' && e.instance}<button type="button" class="act" data-act="fit" aria-expanded={open === `fit:${e.key}`} disabled={busy !== null} onclick={() => toggleOpen(`fit:${e.key}`)}>{inventoryCopy.actions.fit}…</button>{/if}
          {#if e.giveable}<button type="button" class="act" data-act="give" aria-expanded={open === `give:${e.key}`} disabled={busy !== null} onclick={() => toggleOpen(`give:${e.key}`)}>{inventoryCopy.actions.give}…</button>{/if}
        </span>
        {#if open === `give:${e.key}`}
          {@const people = nearby()}
          <span class="chooser" data-testid="give-to">
            {#if people.length === 0}
              <small>{inventoryCopy.giveNobody}</small>
            {:else}
              <small>{inventoryCopy.giveTo}</small>
              {#each people as p (p.habiticaId)}
                <button type="button" class="act" data-give-to={p.habiticaId} disabled={busy !== null} onclick={() => giveIt(e, p)}>{p.displayName}</button>
              {/each}
            {/if}
          </span>
        {:else if open === `mend:${e.key}` && e.instance}
          {@const d = itemDef(e.id)}
          {@const mender = items.menderHere()}
          <span class="chooser" data-testid="mend-at">
            <button type="button" class="act" data-mend="bench" disabled={busy !== null} onclick={() => mendIt(e, 'bench', '')}>{inventoryCopy.mendAt(inventoryCopy.mendBench, costLine(d?.repair?.bench))}</button>
            {#if mender}
              <button type="button" class="act" data-mend={mender.npc} disabled={busy !== null} onclick={() => mendIt(e, mender.npc, mender.name)}>{inventoryCopy.mendAt(mender.name, costLine(d?.repair?.mender) + (d?.repair?.menderEmbers ? `, ${d.repair.menderEmbers} embers` : ''))}</button>
            {/if}
          </span>
        {:else if open === `fit:${e.key}` && e.instance && model}
          {@const targets = fitTargets(model, e.instance)}
          <span class="chooser" data-testid="fit-to">
            {#if targets.length === 0}<small>No tool here has a free slot for it.</small>{/if}
            {#each targets as t (t.id)}
              <button type="button" class="act" data-fit-to={t.id} disabled={busy !== null} onclick={() => fitIt(e.instance!, t)}>{itemName(t.itemDef)}</button>
            {/each}
          </span>
        {/if}
      {/if}
    </span>
    {#if e.section === 'main'}<span class="qty" data-testid={e.kind === 'material' ? `material-${e.id}` : `qty-${e.key}`}>{e.qty}</span>{/if}
  </li>
{/snippet}

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="inv-title">
  <div class="panel inventory" use:focusTrap>
    <button type="button" class="modal-close" onclick={onClose} aria-label={inventoryCopy.close}><Icon name="close" size={14} /></button>
    <h2 class="panel-title" id="inv-title"><Icon name="bag" size={20} /> {inventoryCopy.title}</h2>

    {#if model}
      <div class="carry" data-testid="carry-strip">
        <span class="group">
          {#each model.pockets as p, i (p.slot)}
            {@render slotChip(inventoryCopy.pocket(i + 1), p.itemDef, p.itemDef ? () => void act(`pocket:${i}`, () => items.pocket(i + 1, null), `${itemName(p.itemDef!)} is back in your pack.`) : null, `pocket-${i + 1}`)}
          {/each}
          {#if model.pockets.length < ITEM_RULES.pockets.withCarryGear}
            <small class="more">{inventoryCopy.pocketMore}</small>
          {/if}
        </span>
        <span class="group">
          {@render slotChip(
            inventoryCopy.offHand,
            model.offHand.open ? model.offHand.itemDef : null,
            model.offHand.itemDef ? () => void act('hand', () => items.offHand(null), 'Put away.') : null,
            'off-hand',
            model.offHand.open ? inventoryCopy.offHandEmpty : inventoryCopy.offHandClosed
          )}
          {#if model.offHand.open && model.offHand.itemDef}<small class="more">{inventoryCopy.offHandNote}</small>{/if}
        </span>
        {#if onOwnChest}
          <button type="button" class="act chest" data-testid="own-chest" onclick={onOwnChest}><Icon name="key" size={12} /> {inventoryCopy.ownChest}</button>
        {/if}
      </div>
      {#if model.thanks.length > 0}
        <details class="thanks" data-testid="thanks">
          <summary>{inventoryCopy.thanks} ({model.thanks.length})</summary>
          <ul>
            {#each model.thanks as t (t.at + t.fromName + t.itemDef)}<li>{inventoryCopy.thanksLine(t.fromName, giftPhrase(t.itemDef, 1))}</li>{/each}
          </ul>
        </details>
      {/if}
    {:else if connected && items.status === 'loading'}
      <p class="fine">{inventoryCopy.loading}</p>
    {/if}
    {#if message}<p class="msg {message.kind}" role="status" data-testid="inv-message">{message.text}</p>{/if}

    <div class="tabs" role="tablist" aria-label="Inventory">
      {#each INVENTORY_TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          id={`inv-tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls={`inv-page-${t.id}`}
          tabindex={tab === t.id ? 0 : -1}
          class:active={tab === t.id}
          onclick={() => select(t.id)}
          onkeydown={onTabKey}
        >
          <span class="ti"><Icon name={t.icon} size={14} /></span>
          <span class="tl">{t.label}</span>
          {#if count(t.id) > 0}<span class="tc">{count(t.id)}</span>{/if}
          {#if tabHasNew(t.id)}<span class="newdot" aria-hidden="true"></span><span class="sr">, new</span>{/if}
        </button>
      {/each}
    </div>

    <div class="page" role="tabpanel" id={`inv-page-${tab}`} aria-labelledby={`inv-tab-${tab}`} data-testid={`inv-page-${tab}`}>
      {#if tab === 'papers'}
        <p class="fine">{inventoryCopy.papersNote}</p>
        <PapersTab />
      {:else}
        <p class="fine">{inventoryCopy.intro[tab]}</p>
        {#if groups[tab].main.length === 0}
          <p class="empty">
            {tab === 'home' ? (connected ? inventoryCopy.empty.homeWorld : inventoryCopy.empty.homeGuest) : inventoryCopy.empty[tab]}
          </p>
        {:else}
          <ul class="items">
            {#each groups[tab].main as e (e.key)}{@render row(e)}{/each}
          </ul>
        {/if}
        {#if groups[tab].road.length > 0}
          <h3 class="section-title">{inventoryCopy.road}</h3>
          <p class="fine">{inventoryCopy.roadNote}</p>
          <ul class="items road">
            {#each groups[tab].road as e (e.key)}{@render row(e)}{/each}
          </ul>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .inventory {
    width: min(720px, 100%);
  }
  .carry {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: -4px 0 10px;
    padding: 7px 9px;
    border-radius: 10px;
    background: rgba(255, 252, 240, 0.55);
    border: 2px dashed var(--paper-line);
  }
  .group {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .slot {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 28px;
    padding: 2px 7px 2px 4px;
    border-radius: 8px;
    border: 2px solid var(--paper-line);
    background: var(--paper-hi);
    font-size: 13px;
    color: var(--wood-dark);
  }
  .slot.filled {
    border-color: var(--wood);
  }
  .slot-label {
    padding: 0 5px;
    font-family: var(--font-display);
    font-size: 11px;
    border-radius: 6px;
    color: var(--paper-hi);
    background: var(--wood);
  }
  .slot i,
  .more {
    color: var(--text-soft);
    font-style: italic;
    font-size: 12px;
  }
  .x {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    border-width: 1.5px;
    box-shadow: none;
  }
  .x:hover:not(:disabled) {
    transform: none;
    box-shadow: none;
  }
  .act {
    padding: 2px 9px;
    font-size: 12.5px;
    border-radius: 7px;
    box-shadow: 0 2px 0 var(--wood-dark);
  }
  .act.chest {
    margin-left: auto;
  }
  .thanks {
    margin: -4px 0 10px;
    font-size: 13px;
    color: var(--text-soft);
  }
  .thanks ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
  .msg {
    margin: -2px 0 10px;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 13.5px;
    background: rgba(255, 255, 255, 0.4);
    border: 1.5px solid var(--paper-line);
  }
  .msg.ok {
    border-color: #7aa25a;
    background: rgba(160, 210, 120, 0.2);
  }
  .msg.error {
    border-color: #c0603e;
    background: rgba(224, 122, 82, 0.15);
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(5, auto);
    justify-content: start;
    gap: 4px;
    margin: -2px 0 12px;
    border-bottom: 2px solid var(--paper-line);
  }
  .tabs button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 11px 7px;
    border-radius: 9px 9px 0 0;
    border-bottom: none;
    box-shadow: none;
    background: rgba(255, 255, 255, 0.25);
    color: var(--text-soft);
    margin-bottom: -2px;
    font-size: 14px;
  }
  .tabs button.active {
    background: var(--paper-hi);
    color: var(--wood-dark);
    border-bottom: 2px solid var(--paper-hi);
  }
  .tabs button:hover:not(:disabled) {
    transform: none;
    box-shadow: none;
  }
  .ti {
    display: inline-grid;
    color: var(--wood);
  }
  .tc {
    min-width: 18px;
    padding: 0 5px;
    font-size: 11px;
    line-height: 16px;
    text-align: center;
    border-radius: 999px;
    background: rgba(107, 76, 46, 0.14);
    color: var(--wood-dark);
  }
  .newdot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--ember);
    border: 1.5px solid var(--wood-dark);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .fine {
    margin: 0 0 10px;
  }
  .empty {
    margin: 6px 0 10px;
    padding: 14px 12px;
    text-align: center;
    font-size: 14px;
    color: var(--text-soft);
    border: 2px dashed var(--paper-line);
    border-radius: 10px;
  }
  .items {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .item {
    display: grid;
    grid-template-columns: 40px 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 10px;
    background: rgba(255, 252, 240, 0.55);
    border: 2px solid var(--paper-line);
  }
  .item.new {
    border-color: var(--ember-hi);
    background: rgba(255, 210, 74, 0.14);
  }
  .ii {
    position: relative;
    display: grid;
    place-items: center;
    align-self: start;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    background: var(--paper-hi);
    border: 2px solid var(--wood);
    color: var(--wood);
  }
  .grey-chip {
    position: absolute;
    bottom: 2px;
    right: 2px;
    width: 6px;
    height: 6px;
    background: #9aa0a6;
    border: 1px solid #5f6368;
    border-radius: 2px;
    box-sizing: border-box;
  }
  .ii.dim {
    filter: grayscale(0.6);
    border-style: dashed;
  }
  .thumb {
    max-width: 34px;
    max-height: 34px;
    image-rendering: pixelated;
  }
  .txt {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .name b {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    color: var(--wood-dark);
  }
  .badge,
  .tag {
    padding: 0 6px;
    font-family: var(--font-display);
    font-size: 11px;
    border-radius: 999px;
    border: 1.5px solid var(--wood-dark);
  }
  .badge {
    color: #5a2410;
    background: linear-gradient(180deg, #ffe0b0, #ffc27a);
  }
  .tag {
    color: var(--wood-dark);
    background: var(--paper-hi);
  }
  small {
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--text-soft);
  }
  .maker {
    font-style: italic;
  }
  .helps {
    color: var(--accent);
  }
  .rule {
    font-size: 12px;
  }
  .wear {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 2px 0;
  }
  .bar {
    position: relative;
    flex: 0 0 120px;
    height: 8px;
    border-radius: 4px;
    background: rgba(107, 76, 46, 0.16);
    border: 1.5px solid var(--wood-dark);
    overflow: hidden;
  }
  .bar span {
    position: absolute;
    inset: 0 auto 0 0;
    background: linear-gradient(180deg, #a8d27a, #6f9c48);
  }
  .bar.low span {
    background: linear-gradient(180deg, #ffc27a, #e07a52);
  }
  .uses {
    font-weight: 700;
    color: var(--wood-dark);
  }
  .fittings {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .fit {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px 1px 2px;
    font-size: 12px;
    border-radius: 6px;
    background: var(--paper-hi);
    border: 1.5px solid var(--paper-line);
    color: var(--wood-dark);
  }
  .fit i {
    color: var(--text-soft);
  }
  .acts,
  .chooser {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    margin-top: 4px;
  }
  .chooser {
    padding: 5px 7px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.35);
    border: 1.5px dashed var(--paper-line);
  }
  .where {
    font-weight: 700;
    color: var(--accent);
  }
  .qty {
    align-self: start;
    min-width: 34px;
    padding: 2px 8px;
    text-align: center;
    font-family: var(--font-display);
    font-size: 15px;
    border-radius: 8px;
    color: var(--wood-dark);
    background: var(--paper-hi);
    border: 2px solid var(--paper-line);
  }
  .road .item {
    grid-template-columns: 40px 1fr;
    background: rgba(255, 255, 255, 0.25);
  }
  .tl {
    white-space: nowrap;
  }
  /* Phones: five equal tabs, icon over label, so none scrolls out of sight. */
  @media (max-width: 560px) {
    .tabs {
      grid-template-columns: repeat(5, 1fr);
      gap: 3px;
    }
    .tabs button {
      flex-direction: column;
      gap: 2px;
      padding: 6px 2px 5px;
      font-size: 11.5px;
      line-height: 1.1;
    }
    .tl {
      white-space: normal;
      text-align: center;
    }
    .tc {
      display: none;
    }
    .item {
      grid-template-columns: 36px 1fr auto;
      gap: 8px;
    }
    .ii {
      width: 36px;
      height: 36px;
    }
    .bar {
      flex-basis: 84px;
    }
    .act.chest {
      margin-left: 0;
    }
  }
</style>
