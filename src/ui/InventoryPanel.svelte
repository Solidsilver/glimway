<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { HOME_EV, homesteadsFor } from '../game/homestead'
  import { bus } from '../game/events'
  import { groupInventory, inventoryEntries, newTabs, type InventoryEntry, type InventoryTab } from '../lib/inventory'
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
   * "For the road" section. Mounted only while open; App owns the I/Escape
   * keys. Reads what exists today; nothing here writes to the save.
   */
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  const homes = $derived(homesteadsFor(session))
  const connected = $derived(!!session.link)
  let tab = $state<InventoryTab>('supplies')
  let version = $state(0)

  onMount(() => {
    const bump = () => (version += 1)
    bus.on(VILLAGE_EV.changed, bump)
    bus.on(HOME_EV.changed, bump)
    inventory.syncPack(session.state.inventory)
    // In a world, ask for current counts (the mail read carries them, no
    // workshop needed) and your home's pieces. Offline, what's known shows.
    if (session.link) {
      void village.loadMail()
      void homes.load()
    }
    // Open on the first tab with something new, else Supplies.
    const fresh = newTabs(entries, inventory.seenSet)
    const first = INVENTORY_TABS.find((t) => t.id !== 'papers' && fresh.has(t.id))
    if (first) tab = first.id
    return () => {
      bus.off(VILLAGE_EV.changed, bump)
      bus.off(HOME_EV.changed, bump)
      // Whatever was on screen has now been seen.
      markTab(tab)
    }
  })

  const entries = $derived.by<InventoryEntry[]>(() => {
    void version
    return inventoryEntries({
      pack: inventory.pack.length ? inventory.pack : session.state.inventory,
      materials: ui.materials ?? village.inventory?.materials ?? null,
      items: village.inventory?.items ?? null,
      decorations: homes.mine?.items ?? []
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
</script>

{#snippet row(e: InventoryEntry)}
  <li class="item" class:new={!seen.has(e.key)} data-item={e.key}>
    <span class="ii">
      {#if e.kind === 'decoration' && home.thumbs[e.id]}
        <img class="thumb" src={home.thumbs[e.id]} alt="" />
      {:else}
        <ArtIcon art={e.art} name={e.icon} size={32} />
      {/if}
    </span>
    <span class="txt">
      <span class="name">
        <b>{e.name}</b>
        {#if !seen.has(e.key)}<span class="badge">{inventoryCopy.newBadge}</span>{/if}
      </span>
      {#if e.blurb}<small>{e.blurb}</small>{/if}
      {#if e.kind === 'decoration'}
        <small class="where">{where(e)}</small>
      {/if}
    </span>
    {#if e.section === 'main'}<span class="qty" data-testid={e.kind === 'material' ? `material-${e.id}` : `qty-${e.key}`}>{e.qty}</span>{/if}
  </li>
{/snippet}

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="inv-title">
  <div class="panel inventory" use:focusTrap>
    <button type="button" class="modal-close" onclick={onClose} aria-label={inventoryCopy.close}><Icon name="close" size={14} /></button>
    <h2 class="panel-title" id="inv-title"><Icon name="bag" size={20} /> {inventoryCopy.title}</h2>

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
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    background: var(--paper-hi);
    border: 2px solid var(--wood);
    color: var(--wood);
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
  .badge {
    padding: 0 6px;
    font-family: var(--font-display);
    font-size: 11px;
    border-radius: 999px;
    color: #5a2410;
    background: linear-gradient(180deg, #ffe0b0, #ffc27a);
    border: 1.5px solid var(--wood-dark);
  }
  small {
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--text-soft);
  }
  .where {
    font-weight: 700;
    color: var(--accent);
  }
  .qty {
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
  }
</style>
