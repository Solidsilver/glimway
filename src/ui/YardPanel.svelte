<script lang="ts">
  import { untrack } from 'svelte'
  import type { Session } from '../game/session'
  import { SILAS, homesteadsFor } from '../game/homestead'
  import { itemsFor } from '../game/items'
  import { serverNow } from '../game/clock'
  import { bus, EV } from '../game/events'
  import { HOMESTEAD_DATA, type HomeItem } from '../lib/homestead'
  import { itemDef, sellerFor } from '../lib/items'
  import { itemArt } from '../lib/inventory'
  import { costPhrase, workshopShort } from '../lib/village'
  import { BUILDING_BLURBS, DECORATIONS_GLIMS, DECORATIONS_MATERIAL, HOMESTEAD_TIERS, MATERIALS, SILAS_YARD } from '../content/expansion-writing'
  import { glimsCount, purseCopy } from '../content/purse'
  import { itemErrorText } from '../content/errors'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import { ui } from './store.svelte'
  import { home } from './home.svelte'
  import Glim from './Glim.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import {
    FURNISH_FILTERS,
    YARD_TABS,
    boughtToday,
    defaultYardTab,
    furnishFilter,
    leftToday,
    mergeBought,
    mendList,
    nextTier,
    silasInReach,
    yardGoods,
    type FurnishFilter,
    type MendRow,
    type YardTab
  } from './yard'

  // Silas's Yard (silas-yard.md 2.5): his portrait and the tab's line, your
  // glims and materials, then one list at a time under four chips. Prices
  // come from content; the server charges what it says, not us.
  let { session, onClose, tab: openOn }: { session: Session; onClose: () => void; tab?: YardTab } = $props()

  const homes = $derived(homesteadsFor(session))
  const items = $derived(itemsFor(session))
  const changed = busVersion(bus, EV.homeChanged, EV.villageChanged)
  const itemsChanged = busVersion(bus, EV.itemsChanged)
  const action = actionRunner()
  /** Silas's own word for being short of glims. */
  const refused = (r: { code: string; text: string }) => (r.code === 'insufficient-glims' ? SILAS.dialogue.notEnoughGlims.lines[0] : r.text)

  const blurb = (id: string) => BUILDING_BLURBS[id] ?? [...DECORATIONS_GLIMS, ...DECORATIONS_MATERIAL].find((d) => d.id === id)?.blurb ?? ''
  const materialName = (id: string) => MATERIALS.find((m) => m.id === id)?.name ?? id
  const where = (it: HomeItem) => (it.where.length === 2 ? 'Indoors or out' : it.where[0] === 'indoor' ? 'Indoors' : 'Outdoors')

  const view = $derived.by(() => {
    void changed.value
    const mine = homes.mine
    return {
      connected: homes.connected,
      ready: homes.status === 'ready' && !!mine && homes.claimed,
      tier: mine && homes.claimed ? mine.tier : null,
      materials: homes.materials,
      owned: (id: string) => homes.ownedCount(id)
    }
  })

  // The tab picked (a display's, or a chip), else the default for where your place stands.
  let picked = $state<YardTab | null>(untrack(() => openOn) ?? null)
  const tab = $derived<YardTab>(picked ?? defaultYardTab(view.tier))
  let filter = $state<FurnishFilter>('all')

  const goods = yardGoods()
  const upcoming = $derived(nextTier(view.tier))

  /** The line under his portrait: the tab's, and for Build the one for where your place stands. */
  const quote = $derived.by(() => {
    const q = SILAS_YARD.tabQuotes
    if (tab !== 'build') return q[tab]
    return view.tier === 0 ? q.build.camp : view.tier === 1 ? q.build.cottage : view.tier === null ? q.build.camp : q.build.built
  })

  function select(t: YardTab): void {
    picked = t
    action.message = null
  }

  function onTabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const i = YARD_TABS.findIndex((t) => t.id === tab)
    const n = YARD_TABS.length
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n
    select(YARD_TABS[next].id)
    document.getElementById(`yard-tab-${YARD_TABS[next].id}`)?.focus()
  }

  // ------------------------------------------------------------ Build and Furnish

  /** What a piece costs right now: a lantern post costs more for each one the home has bought. */
  function price(it: HomeItem): Record<string, number> {
    void changed.value
    return it.id === HOMESTEAD_DATA.lanternPosts.item ? homes.mine?.nextPost ?? it.materials : it.materials
  }

  /** A piece waiting on a tier: its row says so plainly. */
  const locked = (it: HomeItem) => (view.tier ?? 0) < it.minTier

  function why(it: HomeItem): string | null {
    // The tier the piece wants, by name: the stable waits on the Workshop.
    if (locked(it)) return `Needs the ${HOMESTEAD_TIERS[it.minTier].name.toLowerCase()}`
    // One stable to a homestead (crafts.md 3.2).
    if (it.id === HOMESTEAD_DATA.stable.item && view.owned(it.id) > 0) return 'Built'
    if (it.glims > 0 && ui.stats.glims < it.glims) return `Needs ${it.glims} glims`
    for (const [m, n] of Object.entries(price(it))) if ((view.materials[m] ?? 0) < n) return `Needs ${n} ${materialName(m).toLowerCase()}`
    return null
  }

  /** A price may name glims, materials, or both (the stable): show all of it. */
  const cost = (it: HomeItem) => {
    const glims = it.glims > 0 ? `${it.glims} glims` : ''
    const materials = Object.entries(price(it)).map(([m, n]) => `${n} ${materialName(m).toLowerCase()}`).join(' · ')
    return [glims, materials].filter(Boolean).join(' · ')
  }

  async function buy(it: HomeItem): Promise<void> {
    await action.run(
      it.id,
      () => homes.buy(it.id),
      it.id === HOMESTEAD_DATA.lanternPosts.item ? `${it.name} is yours. Set it at the edge of your light and give it a name: the ground it lights is yours.` : `${it.name} is yours. It’s in your pack: arrange it at your place.`,
      refused
    )
  }

  const upgradeWhy = $derived.by(() => {
    void changed.value
    if (upcoming === null) return null
    const t = HOMESTEAD_DATA.tiers[upcoming]
    if (upcoming === 2) return workshopShort(ui.stats.glims, homes.materials)
    return ui.stats.glims < t.glims ? `Needs ${t.glims} glims` : null
  })

  async function raise(): Promise<void> {
    await action.run('upgrade', () => homes.upgrade(), () => (homes.mine?.tier === 2 ? 'There. Deep eaves, a heavy bench, and a chest that won’t drink the damp. Go and make something.' : SILAS.dialogue.afterUpgrade.lines[0]), refused)
  }

  const furnishing = $derived(furnishFilter(goods.furnish, filter))

  /**
   * An items answer (a bundle, a mend) carries the pack, not the carried
   * materials the rest of the game reads: copy these counts over from it.
   */
  function syncMaterials(ids: string[]): void {
    const stacks = items.view?.stacks
    if (!stacks) return
    const counts: Record<string, number> = {}
    for (const id of ids) if (id in homes.materials || MATERIALS.some((m) => m.id === id)) counts[id] = stacks.filter((st) => st.itemDef === id).reduce((n, st) => n + st.qty, 0)
    homes.adoptMaterialCounts(counts)
  }

  // ------------------------------------------------------------ Materials

  const yard = sellerFor('silas-yard')
  /** Today's buys from the yard, by good (null until the Glim log is read). */
  let bought = $state<Record<string, number> | null>(null)
  let boughtAsked = false
  /** The read is out, and whether a buy landed meanwhile (the read may have missed it: read again once it's back). */
  let reading = false
  let boughtSince = false

  async function readBought(again = false): Promise<void> {
    const link = session.link
    if (!link || !yard || (boughtAsked && !again)) return
    boughtAsked = true
    reading = true
    boughtSince = false
    const r = await link.purseRead()
    reading = false
    if (r.ok) bought = mergeBought(bought, boughtToday(r.value.lines, yard.npc, serverNow()))
    if (boughtSince) void readBought(true)
  }

  $effect(() => {
    if (tab === 'materials') void readBought()
  })

  function bundleWhy(good: { item: string; glims: number; cap?: number }): string | null {
    if ((good.cap ?? 0) > 0 && bought && (bought[good.item] ?? 0) >= (good.cap ?? 0)) return 'Sold out today'
    if (ui.stats.glims < good.glims) return `Needs ${glimsCount(good.glims)}`
    return null
  }

  async function buyBundle(good: { item: string; qty: number; glims: number; cap?: number }): Promise<void> {
    if (!yard) return
    bus.emit(EV.notePosition)
    const name = `${materialName(good.item)} ×${good.qty}`
    const r = await action.run(`bundle:${good.item}`, () => items.buy(yard.id, good.item), `${name} is yours.`)
    if (!r) return
    if (r.ok) syncMaterials([good.item])
    if (r.ok && reading) boughtSince = true
    if (r.ok && bought) bought = { ...bought, [good.item]: (bought[good.item] ?? 0) + 1 }
    if (!r.ok && r.code === 'sold-out') bought = { ...(bought ?? {}), [good.item]: good.cap ?? 0 }
  }

  // ------------------------------------------------------------ Mend

  /** The server's clock, a tick every few seconds while Mend shows: his cycle can take him out. */
  // The scene notes your spot first (the world holds still while a panel is up).
  bus.emit(EV.notePosition)
  let now = $state(serverNow())
  $effect(() => {
    if (tab !== 'mend') return
    if (items.status === 'idle' && session.link) void items.load()
    const t = setInterval(() => {
      bus.emit(EV.notePosition)
      now = serverNow()
    }, 5000)
    return () => clearInterval(t)
  })

  const mending = $derived.by(() => {
    void itemsChanged.value
    return mendList(items.view?.instances ?? [])
  })

  /** Whether Silas stands near enough to mend: your spot, fresh from the scene. */
  const inReach = $derived.by(() => {
    void now
    const s = session.state
    return silasInReach({ area: s.area, x: s.position.x, y: s.position.y }, now)
  })

  /** What your pack holds of each stack (a mend may want a part, a peg, as well as materials). */
  const held = $derived.by(() => {
    void itemsChanged.value
    const out: Record<string, number> = {}
    for (const st of items.view?.stacks ?? []) out[st.itemDef] = (out[st.itemDef] ?? 0) + st.qty
    return out
  })

  function mendWhy(m: MendRow): string | null {
    if (!inReach) return 'Silas is out'
    if (ui.stats.glims < m.glims) return `Needs ${glimsCount(m.glims)}`
    for (const [id, n] of Object.entries(m.materials)) if ((held[id] ?? 0) < n) return `Needs ${costPhrase({ [id]: n })}`
    return null
  }

  const mendCost = (m: MendRow) => [m.glims > 0 ? glimsCount(m.glims) : '', costPhrase(m.materials)].filter(Boolean).join(' · ')

  async function mend(m: MendRow): Promise<void> {
    bus.emit(EV.notePosition)
    const r = await action.run(`mend:${m.instance}`, () => items.repair(m.instance, 'silas'), `Silas mended the ${m.name.toLowerCase()}. Good as it was.`, (r) => (r.code === 'too-far-away' ? SILAS_YARD.mendAway : r.code ? itemErrorText(r.code) : r.text))
    if (r?.ok) syncMaterials(Object.keys(m.materials))
  }
</script>

<Panel id="shop" icon="home" title="Silas’s Yard" closeLabel="Close Silas’s yard" {onClose} message={action.message} messageTestId="yard-message" class="yard">
  {#snippet head()}
    <div class="counter" data-testid="yard-counter">
      {#if ui.portraits[SILAS.name]}<img src={ui.portraits[SILAS.name]} alt="" class="portrait" />{/if}
      <div class="said">
        <p class="quote">“{quote}”</p>
        {#if view.connected}
          <p class="balance" aria-live="polite" data-testid="yard-balance">
            <span><Glim size={14} /> {ui.stats.glims} glims</span>
            {#each MATERIALS as m (m.id)}
              {#if (view.materials[m.id] ?? 0) > 0}<span><ArtIcon art={`icon-${m.id}`} size={16} /> {view.materials[m.id]} {m.name.toLowerCase()}</span>{/if}
            {/each}
          </p>
        {/if}
      </div>
    </div>
    <div class="tabs" role="tablist" aria-label="Silas’s Yard">
      {#each YARD_TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          id={`yard-tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls={`yard-page-${t.id}`}
          tabindex={tab === t.id ? 0 : -1}
          class:active={tab === t.id}
          data-testid={`yard-tab-${t.id}`}
          onclick={() => select(t.id)}
          onkeydown={onTabKey}>{t.label}</button
        >
      {/each}
    </div>
  {/snippet}

  <div class="page" role="tabpanel" id={`yard-page-${tab}`} aria-labelledby={`yard-tab-${tab}`} data-testid={`yard-page-${tab}`}>
    {#if !view.connected}
      <p class="msg">{tab === 'build' || tab === 'furnish' ? SILAS_YARD.pellPointerGuest : purseCopy.needsConnection}</p>
    {:else if tab === 'build' || tab === 'furnish'}
      {#if !view.ready}
        <p class="msg" data-testid="yard-no-deed">{homes.status === 'ready' ? SILAS_YARD.pellPointer : 'Hold on, Silas is finding your page in the plot book.'}</p>
      {:else if tab === 'build'}
        {#if upcoming !== null}
          {@const t = HOMESTEAD_DATA.tiers[upcoming]}
          <section aria-label={upcoming === 1 ? 'The cottage' : 'The workshop'}>
            <h3 class="section-title">{upcoming === 1 ? 'The cottage' : 'The workshop'}</h3>
            <div class="row feature" data-testid="yard-upgrade">
              <span class="txt">
                <span class="name">{t.name}</span>
                <span class="desc">{HOMESTEAD_TIERS[upcoming].blurb} {upcoming === 1 ? 'Unlocks the inside and setting things out.' : 'Unlocks the storage chest and the crafting bench.'}</span>
                <span class="meta">{[glimsCount(t.glims), costPhrase(t.materials ?? {})].filter(Boolean).join(' · ')}</span>
              </span>
              <button type="button" class="small" class:primary={!upgradeWhy} data-testid={upcoming === 2 ? 'build-workshop' : 'raise-cottage'} disabled={action.busy !== null || !!upgradeWhy} onclick={raise}>
                {action.busy === 'upgrade' ? (upcoming === 1 ? 'Raising…' : 'Building…') : upgradeWhy ?? (upcoming === 1 ? 'Raise it' : 'Build it')}
              </button>
            </div>
          </section>
        {/if}
        <section aria-label="Buildings" data-testid="shop-buildings">
          <h3 class="section-title">Buildings and posts</h3>
          <ul>
            {#each goods.build as it (it.id)}
              {@render row(it, true)}
            {/each}
          </ul>
        </section>
      {:else}
        <div class="filters" role="group" aria-label="Where it goes">
          {#each FURNISH_FILTERS as f (f.id)}
            <button type="button" class:active={filter === f.id} aria-pressed={filter === f.id} data-filter={f.id} onclick={() => (filter = f.id)}>{f.label}</button>
          {/each}
        </div>
        <section aria-label="Furnish">
          <ul>
            {#each furnishing as it (it.id)}
              {@render row(it, false)}
            {/each}
          </ul>
        </section>
      {/if}
    {:else if tab === 'materials'}
      <section aria-label="Materials">
        <ul>
          {#each yard?.goods ?? [] as g (g.item)}
            {@const reason = bundleWhy(g)}
            {@const left = bought ? leftToday(g.cap ?? 0, bought[g.item] ?? 0) : (g.cap ?? 0) > 0 ? `Up to ${g.cap} a day` : null}
            <li class="row" data-bundle={g.item}>
              <span class="thumb" aria-hidden="true"><ArtIcon art={`icon-${g.item}`} size={28} /></span>
              <span class="txt">
                <span class="name">{materialName(g.item)} ×{g.qty}</span>
                {#if left}<span class="meta" data-testid={`left-${g.item}`}>{left}</span>{/if}
              </span>
              <button type="button" class="small" class:primary={!reason} data-buy-bundle={g.item} disabled={action.busy !== null || !!reason} onclick={() => buyBundle(g)}>
                {action.busy === `bundle:${g.item}` ? 'Buying…' : reason ?? `Buy · ${glimsCount(g.glims)}`}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {:else}
      <section aria-label="Mend">
        {#if !inReach}<p class="msg" data-testid="mend-away">{SILAS_YARD.mendAway}</p>{/if}
        {#if items.status === 'loading' && !items.view}
          <p class="fine">Looking through your pack…</p>
        {:else if mending.length === 0}
          <p class="fine" data-testid="mend-none">Nothing in your pack needs mending.</p>
        {:else}
          <ul>
            {#each mending as m (m.instance)}
              {@const reason = mendWhy(m)}
              {@const pic = itemDef(m.itemDef)}
              <li class="row" data-mend-row={m.itemDef}>
                <span class="thumb" aria-hidden="true">{#if pic}<ArtIcon art={itemArt(pic).art} name={itemArt(pic).icon} size={28} />{/if}</span>
                <span class="txt">
                  <span class="name">{m.name}</span>
                  <span class="meta">{m.condition === 0 ? 'Won’t work until it’s mended' : 'Worn'} · {mendCost(m)}</span>
                </span>
                <button type="button" class="small" class:primary={!reason} data-mend-at-silas={m.instance} disabled={action.busy !== null || !!reason} onclick={() => mend(m)} title={reason ?? ''}>
                  {action.busy === `mend:${m.instance}` ? 'Mending…' : reason ?? 'Mend'}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if (view.tier ?? 0) >= 2}<p class="fine" data-testid="mend-own-bench">{SILAS_YARD.mendOwnBench}</p>{/if}
      </section>
    {/if}
  </div>
</Panel>

{#snippet row(it: HomeItem, building: boolean)}
  {@const reason = why(it)}
  <li class="row" class:building class:locked={locked(it)} data-building={building ? it.id : undefined}>
    <span class="thumb" aria-hidden="true">{#if home.thumbs[it.id]}<img src={home.thumbs[it.id]} alt="" />{/if}</span>
    <span class="txt">
      <span class="name">{it.name}{#if !building && view.owned(it.id) > 0}<span class="owned">· own {view.owned(it.id)}</span>{/if}</span>
      <span class="desc">{blurb(it.id)}</span>
      {#if building && locked(it)}
        <span class="lock" data-testid={`shop-locked-${it.id}`}>Silas builds it once your {HOMESTEAD_TIERS[it.minTier].name.toLowerCase()} stands.</span>
      {/if}
      <span class="meta">{where(it)} · {it.footprint[0]}×{it.footprint[1]} · {cost(it)}</span>
    </span>
    <button type="button" class="small" class:primary={!reason} data-buy={it.id} disabled={action.busy !== null || !!reason} onclick={() => buy(it)} title={reason ?? ''}>
      {action.busy === it.id ? 'Buying…' : reason ?? 'Buy'}
    </button>
  </li>
{/snippet}

<style>
  /* The counter: Silas and his line, your purse under it; pinned with the tabs. */
  .counter {
    order: 2;
    flex: 1 1 100%;
    box-sizing: border-box;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    border-radius: 12px;
    background: linear-gradient(180deg, var(--paper-glow) 0%, var(--paper-hi) 100%);
    border: 2px solid var(--wood-dark);
    box-shadow: 0 3px 0 rgba(58, 38, 20, 0.55), 0 6px 14px rgba(20, 12, 16, 0.22);
  }
  .portrait {
    width: 56px;
    height: 56px;
    image-rendering: pixelated;
    border: 2px solid var(--wood);
    border-radius: 8px;
    background: var(--paper-dark);
    flex: none;
  }
  .said {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .quote {
    margin: 0;
    font-style: italic;
    color: var(--text-soft);
    font-size: 13.5px;
    line-height: 1.35;
  }
  .balance {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    margin: 0;
    font-weight: 800;
    font-size: 13.5px;
    color: var(--wood-dark);
  }
  .balance span {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .tabs button {
    min-width: 0;
    min-height: 40px;
    padding: 6px 4px;
    border-radius: 9px;
    border: 2px solid transparent;
    box-shadow: none;
    background: transparent;
    color: var(--text-soft);
    font-size: 14px;
    white-space: nowrap;
  }
  .tabs button.active {
    background: #fff1c2;
    border-color: var(--gold-deep);
    color: var(--wood-dark);
  }
  .tabs button:hover:not(:disabled) {
    transform: none;
    box-shadow: none;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 0 0 10px;
  }
  .filters button {
    min-height: 32px;
    padding: 3px 12px;
    font-size: 13.5px;
    border-radius: 999px;
    border-width: 2px;
    box-shadow: 0 2px 0 rgba(74, 50, 32, 0.35);
    background: rgba(255, 252, 240, 0.7);
    color: var(--text-soft);
  }
  .filters button.active {
    background: linear-gradient(180deg, var(--cream), var(--gold));
    color: var(--wood-dark);
    border-color: var(--wood-dark);
  }
  .filters button:hover:not(:disabled) {
    transform: none;
  }
  .msg {
    padding: 8px 10px;
    font-size: 14px;
  }
  .fine {
    margin: 8px 2px;
    font-size: 13px;
    color: var(--text-soft);
  }
  .section-title {
    text-transform: none;
    letter-spacing: 0.04em;
    font-size: 14px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.22);
  }
  .row.feature {
    border-color: var(--gold-deep);
    background: rgba(255, 233, 160, 0.3);
  }
  .txt {
    display: grid;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .name {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .owned {
    margin-left: 6px;
    font-weight: 600;
    font-size: 12.5px;
    color: var(--accent);
  }
  .desc {
    font-size: 13px;
    color: var(--text-soft);
    line-height: 1.35;
  }
  .meta {
    font-size: 12px;
    color: var(--text-faint);
  }
  .row.building {
    border-color: var(--wood);
  }
  .row.locked {
    border-style: dashed;
    background: transparent;
  }
  .row.locked .thumb {
    opacity: 0.55;
  }
  .lock {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--wood-dark);
  }
  .thumb {
    flex: none;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--wood-wash);
  }
  .thumb img {
    image-rendering: pixelated;
    max-width: 36px;
    max-height: 36px;
  }
  .small {
    flex: none;
    padding: 5px 10px;
    font-size: 13.5px;
    max-width: 9.5em;
    white-space: normal;
  }

  /* Phones: the portrait at 40 px, the line in two lines at most, thumb-sized chips; rows wrap. */
  :global(:root.touch) .portrait {
    width: 40px;
    height: 40px;
    border-radius: 6px;
  }
  :global(:root.touch) .counter {
    padding: 6px 8px;
    gap: 8px;
  }
  :global(:root.touch) .quote {
    font-size: 12.5px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  :global(:root.touch) .balance {
    font-size: 12.5px;
  }
  :global(:root.touch) .tabs button {
    min-height: 44px;
    padding: 4px 2px;
    font-size: 13px;
  }
  :global(:root.touch) .filters button {
    min-height: 40px;
  }
  /* Narrow: a row wraps its button under the words only when it doesn't fit beside them. */
  @media (max-width: 560px) {
    .portrait {
      width: 40px;
      height: 40px;
      border-radius: 6px;
    }
    .row {
      flex-wrap: wrap;
    }
    .row .txt {
      flex: 1 1 11em;
    }
    .row .small {
      margin-left: auto;
    }
  }
</style>
