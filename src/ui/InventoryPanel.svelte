<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Session } from '../game/session'
  import { villageFor } from '../game/village'
  import { homesteadsFor } from '../game/homestead'
  import { giftPhrase, itemsFor } from '../game/items'
  import { itemErrorText } from '../content/errors'
  import { presence } from '../game/presence'
  import { bus, EV } from '../game/events'
  import { assetOf, costLine, fitTargets, inventoryEntries, modelEntries, newestFirst, newTabs, wearWords, type InventoryEntry, type InventoryTab } from '../lib/inventory'
  import { conditionFraction, fittingLine, itemDef, itemName, ITEM_RULES } from '../lib/items'
  import type { InstanceView } from '../lib/api/types'
  import { INVENTORY_FILTERS, inventoryCopy } from '../content/inventory'
  import { beltFor, heldSlot, KIND_WORDS, type BeltKind } from '../lib/belt'
  import { GATHERING_DATA, isPlantableSeed, PLANTS_FULL_LINE } from '../lib/gathering'
  import { parseHomeArea, plantTileNear } from '../lib/homestead'
  import { ui } from './store.svelte'
  import { home } from './home.svelte'
  import { inventory } from './inventory.svelte'
  import { heldUi } from './held.svelte'
  import { papers } from './papers.svelte'
  import { isTouchFirst } from './device'
  import { heroLine } from './hero'
  import { actionRunner, busVersion, type Outcome } from './panel-state.svelte'
  import Icon from './Icon.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import PapersTab from './PapersTab.svelte'
  import PurseAmount from './PurseAmount.svelte'
  import { goldPhrase, purseCopy } from '../content/purse'
  import { parseAmount } from '../lib/purse'

  /**
   * Everything you carry, in one place (I or the HUD's bag button). At the
   * top, Equipped: the hero, with what's in hand, the off hand and the
   * pockets around them. Below, Carrying: one icon grid, newest first, with
   * filter chips (All, Tools, Supplies, Keepsakes, Home, Papers). Pick an
   * icon (or hover it on a desktop) for its card: name, count, a line, its
   * wear and what you can do with it (use, pocket, carry, hold, give, mend,
   * fit, plant). In a world it reads the server's item model; offline it sees
   * the save's pack. App owns the I key; Escape closes an open card first.
   */
  let {
    session,
    onClose,
    onOwnChest,
    onCharacter
  }: {
    session: Session
    onClose: () => void
    onOwnChest?: () => void
    /** Phones: the HUD has no Character button, so the bag leads to it. */
    onCharacter?: () => void
  } = $props()

  const touch = isTouchFirst()
  let panelEl: HTMLDivElement | undefined = $state()
  const hero = $derived.by(() => {
    const p = ui.importedProfile
    const who = heroLine(p)
    return { name: who.name, line: `Level ${who.level} ${who.className}`, portrait: !p ? ui.portraits['You'] ?? null : null }
  })
  /** Phone copy never names keys. */
  const blurbOf = (e: InventoryEntry) => (touch ? inventoryCopy.touchBlurbs[e.id] ?? e.blurb : e.blurb)

  const village = $derived(villageFor(session))
  const homes = $derived(homesteadsFor(session))
  const items = $derived(itemsFor(session))
  const connected = $derived(!!session.link)
  type Filter = 'all' | InventoryTab
  let tab = $state<Filter>('all')
  const changed = busVersion(bus, EV.villageChanged, EV.homeChanged, EV.itemsChanged)
  const action = actionRunner()
  /** The card's hand-over / mend / fit chooser that is open: `${action}:${key}`. */
  let open = $state<string | null>(null)
  /** The card picked (an entry's key, or `slot:<name>` for an empty slot or the weapon). */
  let selected = $state<string | null>(null)
  /** Desktop: the icon under the pointer, shown while nothing is picked. */
  let hovered = $state<string | null>(null)
  /** Which grid cell holds the keyboard's place (roving tabindex). */
  let cursor = $state(0)
  let headEl: HTMLElement | undefined = $state()
  let cardTop = $state(120)

  const kit = $derived(ui.kit)

  onMount(() => {
    inventory.syncPack(session.state.inventory)
    // In a world, ask for the item model and your home's pieces. Offline,
    // what's known shows.
    if (session.link) {
      void items.load()
      void homes.load()
    }
    // The card sits under the pinned header (side column): measure it.
    const ro = new ResizeObserver(() => {
      if (!headEl || !panelEl) return
      cardTop = Math.round(headEl.offsetHeight - parseFloat(getComputedStyle(panelEl).paddingTop) + 10)
    })
    if (headEl) ro.observe(headEl)
    return () => {
      ro.disconnect()
      // Everything carried was on screen (the bag opens on All): seen now.
      markTab('all')
    }
  })

  const model = $derived.by(() => {
    void changed.value
    return connected && items.view ? items.view : null
  })

  const entries = $derived.by<InventoryEntry[]>(() => {
    void changed.value
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
  const fresh = $derived(newTabs(entries, inventory.seenSet))
  const seen = $derived(inventory.seenSet)
  /** What the current filter shows, newest first (quest things last). */
  const shown = $derived.by(() => {
    if (tab === 'papers') return [] as InventoryEntry[]
    return newestFirst(tab === 'all' ? entries : entries.filter((e) => e.tab === tab), inventory.seenAt)
  })
  const mainShown = $derived(shown.filter((e) => e.section === 'main'))
  const roadShown = $derived(shown.filter((e) => e.section === 'road'))
  const cells = $derived([...mainShown, ...roadShown])

  // ---- the hand, the off hand, the pockets
  const belt = $derived(beltFor(model?.instances))
  // What's in hand (src/game/held.ts, through heldUi): it follows the action bar and the phone ring.
  const hand = $derived(heldSlot(belt, heldUi.kind))
  const handEntry = $derived(hand.instance ? entries.find((e) => e.key === `inst:${hand.instance}`) ?? null : null)
  const offEntry = $derived(entries.find((e) => e.inHand) ?? null)
  const pocketEntry = (n: number) => entries.find((e) => e.pocket === n) ?? null
  /** The belt kind a tool works as (its first action on the belt), when it's the belt's tool for that kind. */
  function beltKindOf(e: InventoryEntry): BeltKind | null {
    if (!e.instance) return null
    const slot = belt.find((s) => s.instance === e.instance!.id)
    return slot ? slot.kind : null
  }
  function hold(kind: BeltKind): void {
    // The game answers at once with EV.held, which heldUi follows.
    bus.emit(EV.hold, { kind })
  }

  // ---- the card
  const cardKey = $derived(selected ?? (touch ? null : hovered))
  const card = $derived(cardKey ? (entries.find((e) => e.key === cardKey) ?? null) : null)
  /** An empty slot's (or the weapon's) card. */
  const slotCard = $derived(cardKey?.startsWith('slot:') ? cardKey.slice(5) : null)

  /** What opened the card (a cell or a slot): focus goes back to it when the card closes. */
  let opener: HTMLElement | null = null

  function pick(key: string, from?: EventTarget | null): void {
    selected = key
    open = null
    action.clear()
    if (from instanceof HTMLElement) opener = from
  }
  /** Pick a slot: its item's card, or the slot's own (empty, locked, the weapon). */
  function pickSlot(name: string, e: InventoryEntry | null, from?: EventTarget | null): void {
    pick(e ? e.key : `slot:${name}`, from)
  }

  /** Close the card, and put focus back where the player was (never on the page behind). */
  async function closeCard(): Promise<void> {
    selected = null
    open = null
    // Not straight back to a hover preview of what was just closed.
    hovered = null
    await tick()
    refocus()
  }
  function refocus(): void {
    const target =
      (opener?.isConnected && opener.offsetParent !== null ? opener : null) ??
      panelEl?.querySelector<HTMLElement>('[data-cell][tabindex="0"]') ??
      panelEl ??
      null
    target?.focus()
  }

  // A picked thing that's gone (used up, given away) closes its card; focus stays in the bag.
  $effect(() => {
    if (selected && !selected.startsWith('slot:') && !entries.some((e) => e.key === selected)) void closeCard()
  })
  // The grid shrank under the keyboard's place (the last of something used up): keep a cell in the Tab order.
  $effect(() => {
    if (cursor > 0 && cursor > cells.length - 1) cursor = Math.max(0, cells.length - 1)
  })

  function markTab(t: Filter): void {
    if (t === 'papers') return
    inventory.markSeen((t === 'all' ? entries : entries.filter((e) => e.tab === t)).map((e) => e.key))
  }

  function select(t: Filter): void {
    if (t === tab) return
    tab = t
    open = null
    selected = null
    hovered = null
    cursor = 0
    action.clear()
    // A new filter starts at its top, under the pinned header.
    panelEl?.scrollTo({ top: 0 })
  }

  function onTabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const i = INVENTORY_FILTERS.findIndex((t) => t.id === tab)
    const n = INVENTORY_FILTERS.length
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n
    select(INVENTORY_FILTERS[next].id)
    document.getElementById(`inv-tab-${INVENTORY_FILTERS[next].id}`)?.focus()
  }

  /** Arrow keys walk the grid (rows as laid out), Home/End jump; Enter or Space picks. */
  function onGridKey(ev: KeyboardEvent): void {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
    if (!keys.includes(ev.key) || cells.length === 0) return
    ev.preventDefault()
    const els = [...(panelEl?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])]
    const tops = els.map((el) => el.offsetTop)
    const cols = Math.max(1, tops.filter((t) => t === tops[0]).length)
    const n = els.length
    let i = cursor
    if (ev.key === 'ArrowRight') i = Math.min(n - 1, i + 1)
    else if (ev.key === 'ArrowLeft') i = Math.max(0, i - 1)
    else if (ev.key === 'ArrowDown') i = Math.min(n - 1, i + cols)
    else if (ev.key === 'ArrowUp') i = Math.max(0, i - cols)
    else if (ev.key === 'Home') i = 0
    else i = n - 1
    cursor = i
    els[i]?.focus()
  }

  /** Escape closes the card first, focus back where it came from (then App's Escape closes the panel). */
  function onPanelKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape' || (!selected && !open)) return
    ev.preventDefault()
    ev.stopPropagation()
    void closeCard()
  }

  /** "1 set out · 2 put away" for a home good. */
  const where = (e: InventoryEntry) =>
    [e.placed ? inventoryCopy.placed(e.placed) : '', e.stored ? inventoryCopy.stored(e.stored) : ''].filter(Boolean).join(' · ')
  /** Kinds of thing under a filter (not the sum of quantities). */
  const count = (t: Filter) => (t === 'papers' ? papers.found.length : t === 'all' ? entries.length : entries.filter((e) => e.tab === t).length)
  const tabHasNew = (t: Filter) => (t === 'papers' ? papers.unread.length > 0 : t === 'all' ? fresh.size > 0 : fresh.has(t))
  /** One short line: the first sentence of the description. */
  const shortLine = (s: string) => {
    const m = /^(.+?[.!?])(\s|$)/.exec(s)
    return (m ? m[1] : s).trim()
  }

  /** A cell's name for screen readers: "Bench axe, 30 uses left, in hand, new". */
  function cellLabel(e: InventoryEntry): string {
    const k = beltKindOf(e)
    return [
      e.name,
      e.section === 'main' && !e.instance && e.qty > 1 ? `${e.qty}` : '',
      e.instance && e.instance.maxCondition > 0 ? wearWords(e.instance) : '',
      e.instance?.wardenSet ? 'warden-set' : '',
      k && k === hand.kind ? inventoryCopy.inHandTag.toLowerCase() : '',
      e.inHand ? inventoryCopy.atBeltSpoken : '',
      e.pocket ? `in pocket ${e.pocket}` : '',
      !seen.has(e.key) ? inventoryCopy.newBadge.toLowerCase() : ''
    ]
      .filter(Boolean)
      .join(', ')
  }

  /** The delivered art for an icon: the wear-state frame when it's loaded, else the item's own. */
  function artOf(e: InventoryEntry): string | null {
    if (e.stateArt && ui.artIcons[e.stateArt]) return e.stateArt
    return e.art
  }

  // ------------------------------------------------------------ actions

  /** An action from the card: its chooser closes once it has answered. */
  async function act(id: string, run: () => Promise<Outcome>, ok: string): Promise<void> {
    if (await action.run(id, run, ok)) open = null
  }

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
    void act(`carry:${e.key}`, () => items.offHand(e.instance ? { instance: e.instance.id } : { itemDef: e.id }), inventoryCopy.carried(giftPhrase(e.id, 1)))
  }

  /** Seeds and saplings go into your own land, at your feet. */
  function plantable(e: InventoryEntry): boolean {
    const gate = parseHomeArea(session.state.area)
    return isPlantableSeed(e.id) && gate !== null && homes.mine?.gate === gate
  }

  function plantIt(e: InventoryEntry): void {
    const gate = parseHomeArea(session.state.area)
    const mine = homes.mine
    // Where the hero stands now (the server measures reach from the save).
    bus.emit(EV.notePosition)
    if (mine && (mine.plants?.length ?? 0) >= GATHERING_DATA.plantsPerHome) {
      action.say(PLANTS_FULL_LINE, 'error')
      return
    }
    const tile = mine ? plantTileNear(mine, session.state.position) : null
    if (gate === null || !tile) {
      action.say(itemErrorText('land-blocked'), 'error')
      return
    }
    void act(
      `plant:${e.key}`,
      () =>
        items.plant(e.id, tile).then((r) => {
          // The scene draws it now; the home's state keeps it for next time.
          if (r.ok && r.value.plant) {
            bus.emit(EV.planted, { plant: r.value.plant })
            void homes.fetchHome(gate)
          }
          return r
        }),
      `You planted ${giftPhrase(e.id, 1)}.`
    )
  }

  /** Players standing close enough to hand something to. */
  function nearby(): { accountId: string; displayName: string }[] {
    const feed = presence()
    if (!feed) return []
    const p = session.state.position
    return feed.nearby(p.x, p.y, ITEM_RULES.give.radiusTiles * 16)
  }

  // ---- the Purse row (purse-and-wardrobe.md 3.4): gold handed to someone standing near
  const purseGold = $derived(ui.purse?.gold ?? 0)
  /** Who the gold goes to (picked from the people nearby), then how much. */
  let goldTo = $state<{ accountId: string; displayName: string } | null>(null)
  let goldText = $state('')
  const goldAmount = $derived(parseAmount(goldText, purseGold))

  function toggleGold(): void {
    toggleOpen('give:purse')
    goldTo = null
    goldText = ''
  }

  function giveGold(): void {
    const to = goldTo
    const n = goldAmount
    if (!to || n === null) return
    void act('give:purse', () => items.giveGold(to.accountId, n), purseCopy.gave(to.displayName, n)).then(() => {
      if (open === null) {
        goldTo = null
        goldText = ''
      }
    })
  }

  function giveIt(e: InventoryEntry, to: { accountId: string; displayName: string }): void {
    void act(`give:${e.key}`, () => items.give(to.accountId, assetOf(e)), `You gave ${to.displayName} ${giftPhrase(e.id, 1)}.`)
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
  const toggleOpen = (id: string) => {
    open = open === id ? null : id
    action.clear()
  }
</script>

{#snippet icon(e: InventoryEntry, size: number)}
  {#if e.kind === 'decoration' && home.thumbs[e.id]}
    <img class="thumb" src={home.thumbs[e.id]} alt="" />
  {:else}
    <ArtIcon art={artOf(e)} name={e.icon} size={size} />
  {/if}
{/snippet}

{#snippet wearBar(e: InventoryEntry, testid: boolean, decorative = false)}
  {#if e.instance && e.instance.maxCondition > 0}
    <span
      class="bar"
      class:low={percent(e.instance) < ITEM_RULES.wear.wornBelowPercent}
      role={decorative ? undefined : 'meter'}
      aria-hidden={decorative ? 'true' : undefined}
      aria-label={decorative ? undefined : `${e.name} condition`}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={percent(e.instance)}
      data-testid={testid ? 'condition' : undefined}
    ><span style={`width:${percent(e.instance)}%`}></span></span>
  {/if}
{/snippet}

{#snippet cell(e: InventoryEntry, i: number)}
  <li>
    <button
      type="button"
      class="cell"
      class:on={cardKey === e.key}
      class:dim={e.instance && (e.instance.state === 'blunt' || e.instance.state === 'cracked')}
      data-cell={e.key}
      aria-pressed={selected === e.key}
      tabindex={i === cursor ? 0 : -1}
      title={touch ? undefined : e.name}
      aria-label={cellLabel(e)}
      onclick={(ev) => {
        cursor = i
        pick(e.key, ev.currentTarget)
      }}
      onmouseenter={() => !touch && (hovered = e.key)}
      onfocus={() => (cursor = i)}
    >
      <span class="ci" aria-hidden="true">
        {@render icon(e, 32)}
        {#if e.instance?.wardenSet}<span class="grey-chip" title="Warden-set"></span>{/if}
        {#if !seen.has(e.key)}<span class="badge" aria-hidden="true"></span>{/if}
        {#if e.section === 'main' && !e.instance}
          <span class="count" class:one={e.qty === 1} data-testid={e.kind === 'material' ? `material-${e.id}` : `qty-${e.key}`}>{e.qty}</span>
        {/if}
        {#if e.pocket || e.inHand || (beltKindOf(e) && beltKindOf(e) === hand.kind)}<span class="worn" aria-hidden="true"><Icon name="check" size={9} /></span>{/if}
      </span>
      {@render wearBar(e, false, true)}
      <span class="cn" aria-hidden="true">{e.name}</span>
    </button>
  </li>
{/snippet}

{#snippet beltRow()}
  <span class="acts belt" role="group" aria-label={inventoryCopy.holdGroup}>
    {#each belt as s (s.kind)}
      <button type="button" class="act" class:primary={s.kind === hand.kind} aria-pressed={s.kind === hand.kind} data-hold={s.kind} onclick={() => hold(s.kind)}>{s.kind === 'weapon' ? kit.basicName : KIND_WORDS[s.kind]}</button>
    {/each}
  </span>
{/snippet}

<!-- `full`: the picked card, with its actions; a hovered card (desktop) only shows what the thing is. -->
{#snippet itemCard(e: InventoryEntry, full: boolean)}
  {@const k = beltKindOf(e)}
  <div class="card-head">
    <span class="card-icon" class:dim={e.instance && (e.instance.state === 'blunt' || e.instance.state === 'cracked')}>
      {@render icon(e, 32)}
      {#if e.instance?.wardenSet}<span class="grey-chip" title="Warden-set" data-testid="grey-chip"></span>{/if}
    </span>
    <span class="card-name">
      <b>{e.name}</b>
      {#if e.section === 'main' && !e.instance && e.qty > 1}<span class="times">×{e.qty}</span>{/if}
      {#if !seen.has(e.key)}<span class="tag new">{inventoryCopy.newBadge}</span>{/if}
      {#if e.pocket}<span class="tag" data-testid="in-pocket">In pocket {e.pocket}</span>{/if}
      {#if e.inHand}<span class="tag" data-testid="in-hand">{inventoryCopy.atBeltTag}</span>{/if}
      {#if k && k === hand.kind}<span class="tag held" data-testid="in-main-hand">{inventoryCopy.inHandTag}</span>{/if}
    </span>
  </div>
  {#if e.blurb}<p class="line">{shortLine(blurbOf(e))}</p>{/if}
  {#if e.instance && e.instance.maxCondition > 0}
    <span class="wear">
      {@render wearBar(e, true)}
      <small class="uses" data-testid="wear-words">{wearWords(e.instance)}</small>
    </span>
  {:else if e.instance && e.kind === 'tool'}
    <small class="uses">{inventoryCopy.neverWears}</small>
  {/if}
  {#if e.maker}<small class="maker" data-testid="maker">{inventoryCopy.madeBy(e.maker.name)}</small>{/if}
  {#if e.instance && e.instance.fittings.length > 0}
    <span class="fittings" data-testid="fittings">
      {#each e.instance.fittings as f (f.id)}
        <span class="fit" data-fitting={f.itemDef}>
          <ArtIcon art={f.itemDef} name="sparkle" size={16} />
          {fittingLine(f.fitting)}{#if f.maxCondition > 0}<i> · {inventoryCopy.usesLeft(f.usesLeft)}</i>{/if}
          {#if full}<button type="button" class="x" aria-label={`${inventoryCopy.actions.takeOff} ${itemName(f.itemDef)}`} disabled={action.busy !== null} onclick={() => takeOff(f.id, f.itemDef)}><Icon name="close" size={10} /></button>{/if}
        </span>
      {/each}
    </span>
  {/if}
  {#if e.helps && e.helps.length > 0}<small class="helps">{e.helps.join(' · ')}</small>{/if}
  {#if e.rule && e.kind === 'tool'}<small class="rule">{e.rule}</small>{/if}
  {#if e.kind === 'decoration'}<small class="where">{where(e)}</small>{/if}
  {#if e.section === 'road'}<small class="rule">{inventoryCopy.roadNote}</small>{/if}
  {#if !full && model && e.section === 'main' && e.kind !== 'decoration' && e.kind !== 'material'}
    <small class="rule pick-hint">{inventoryCopy.pickToAct}</small>
  {:else if model && e.section === 'main' && e.kind !== 'decoration' && e.kind !== 'material'}
    {#if k && k === hand.kind}
      <!-- In hand now: the belt, to take something else in hand (or put it away for the weapon). -->
      {@render beltRow()}
    {/if}
    <span class="acts">
      {#if k && k !== hand.kind}<button type="button" class="act primary" data-act="hold" onclick={() => hold(k)}>{inventoryCopy.holdThis}</button>{/if}
      {#if e.usable && session.state.hp > 0}<button type="button" class="act primary" data-act="use" disabled={action.busy !== null} onclick={() => useIt(e)}>{inventoryCopy.actions.use}</button>{/if}
      {#if e.pocketable}<button type="button" class="act" data-act="pocket" disabled={action.busy !== null} onclick={() => pocketIt(e)}>{e.pocket ? inventoryCopy.actions.unpocket : inventoryCopy.actions.pocket}</button>{/if}
      {#if e.carryable}<button type="button" class="act" data-act="carry" disabled={action.busy !== null} onclick={() => carryIt(e)}>{e.inHand ? inventoryCopy.actions.putAway : inventoryCopy.actions.carry}</button>{/if}
      {#if e.mendable}<button type="button" class="act" data-act="mend" aria-expanded={open === `mend:${e.key}`} disabled={action.busy !== null} onclick={() => toggleOpen(`mend:${e.key}`)}>{inventoryCopy.actions.mend}…</button>{/if}
      {#if e.kind === 'fitting' && e.instance}<button type="button" class="act" data-act="fit" aria-expanded={open === `fit:${e.key}`} disabled={action.busy !== null} onclick={() => toggleOpen(`fit:${e.key}`)}>{inventoryCopy.actions.fit}…</button>{/if}
      {#if e.giveable}<button type="button" class="act" data-act="give" aria-expanded={open === `give:${e.key}`} disabled={action.busy !== null} onclick={() => toggleOpen(`give:${e.key}`)}>{inventoryCopy.actions.give}…</button>{/if}
      {#if plantable(e)}<button type="button" class="act" data-act="plant" disabled={action.busy !== null} onclick={() => plantIt(e)}>{inventoryCopy.actions.plant}</button>{/if}
    </span>
    {#if open === `give:${e.key}`}
      {@const people = nearby()}
      <span class="chooser" data-testid="give-to">
        {#if people.length === 0}
          <small>{inventoryCopy.giveNobody}</small>
        {:else}
          <small>{inventoryCopy.giveTo}</small>
          {#each people as p (p.accountId)}
            <button type="button" class="act" data-give-to={p.accountId} disabled={action.busy !== null} onclick={() => giveIt(e, p)}>{p.displayName}</button>
          {/each}
        {/if}
      </span>
    {:else if open === `mend:${e.key}` && e.instance}
      {@const d = itemDef(e.id)}
      {@const mender = items.menderHere()}
      <span class="chooser" data-testid="mend-at">
        <button type="button" class="act" data-mend="bench" disabled={action.busy !== null} onclick={() => mendIt(e, 'bench', '')}>{inventoryCopy.mendAt(inventoryCopy.mendBench, costLine(d?.repair?.bench))}</button>
        {#if mender}
          <button type="button" class="act" data-mend={mender.npc} disabled={action.busy !== null} onclick={() => mendIt(e, mender.npc, mender.name)}>{inventoryCopy.mendAt(mender.name, costLine(d?.repair?.mender) + (d?.repair?.menderEmbers ? `, ${d.repair.menderEmbers} embers` : ''))}</button>
        {/if}
      </span>
    {:else if open === `fit:${e.key}` && e.instance && model}
      {@const targets = fitTargets(model, e.instance)}
      <span class="chooser" data-testid="fit-to">
        {#if targets.length === 0}<small>No tool here has a free slot for it.</small>{/if}
        {#each targets as t (t.id)}
          <button type="button" class="act" data-fit-to={t.id} disabled={action.busy !== null} onclick={() => fitIt(e.instance!, t)}>{itemName(t.itemDef)}</button>
        {/each}
      </span>
    {/if}
  {/if}
{/snippet}

{#snippet slotView(name: string)}
  {#if name === 'hand'}
    <div class="card-head">
      <span class="card-icon"><Icon name="sword" size={24} /></span>
      <span class="card-name"><b>{inventoryCopy.hand}</b><span class="tag held">{inventoryCopy.handWeapon(kit.basicName)}</span></span>
    </div>
    <p class="line">{inventoryCopy.handHint}</p>
  {:else if name.startsWith('pocket') && name !== 'pocket-locked'}
    <div class="card-head">
      <span class="card-icon"><Icon name="bag" size={22} /></span>
      <span class="card-name"><b>{inventoryCopy.pocket(Number(name.slice(7)))}</b><span class="tag">{inventoryCopy.pocketEmpty}</span></span>
    </div>
    <p class="line">{inventoryCopy.pocketHint}</p>
  {:else if name === 'pocket-locked'}
    <div class="card-head">
      <span class="card-icon"><Icon name="key" size={20} /></span>
      <span class="card-name"><b>{inventoryCopy.pocket((model?.pockets.length ?? 1) + 1)}</b><span class="tag">{inventoryCopy.lockedTag}</span></span>
    </div>
    <p class="line">{inventoryCopy.pocketLocked}</p>
  {:else if name === 'off-locked'}
    <div class="card-head">
      <span class="card-icon"><Icon name="key" size={20} /></span>
      <span class="card-name"><b>{inventoryCopy.offHand}</b><span class="tag">{inventoryCopy.lockedTag}</span></span>
    </div>
    <p class="line">{inventoryCopy.offHandClosed}</p>
  {:else}
    <div class="card-head">
      <span class="card-icon"><Icon name="lantern" size={22} /></span>
      <span class="card-name"><b>{inventoryCopy.offHand}</b><span class="tag">{inventoryCopy.offHandEmpty}</span></span>
    </div>
    <p class="line">{inventoryCopy.offHandHint}</p>
  {/if}
  {#if belt.length > 1 && name === 'hand'}{@render beltRow()}{/if}
{/snippet}

<!-- A slot around the hero: its item, or its own card (empty, the weapon). `held`: the hand. -->
{#snippet slotButton(name: string, label: string, e: InventoryEntry | null, testid: string, fallbackIcon: string, held = false, emptyName = inventoryCopy.pocketEmpty)}
  <button type="button" class="eq" class:filled={!!e} class:on={cardKey === (e ? e.key : `slot:${name}`)} data-testid={testid} onclick={(ev) => pickSlot(name, e, ev.currentTarget)} title={`${label}: ${e ? e.name : emptyName}`}>
    <span class="eq-box" class:held>
      {#if e}{@render icon(e, 32)}{:else}<span class="eq-empty" class:weapon={held}><Icon name={fallbackIcon} size={held ? 20 : 18} /></span>{/if}
    </span>
    <span class="eq-label">{label}</span>
    <span class="sr">{e ? e.name : emptyName}</span>
  </button>
{/snippet}

<!-- A slot that isn't open yet: a button too, so a tap says why (a title only shows on hover). -->
{#snippet lockedSlot(name: string, label: string, testid: string, reason: string)}
  <button type="button" class="eq locked" class:on={cardKey === `slot:${name}`} data-testid={testid} onclick={(ev) => pickSlot(name, null, ev.currentTarget)} title={reason}>
    <span class="eq-box"><span class="eq-empty"><Icon name="key" size={16} /></span></span>
    <span class="eq-label">{label}</span>
    <span class="sr">{reason}</span>
  </button>
{/snippet}

<Panel
  id="inv"
  icon="bag"
  title={inventoryCopy.title}
  closeLabel={inventoryCopy.close}
  {onClose}
  message={action.message}
  messageTestId="inv-message"
  class="inventory"
  bind:panelEl
  bind:headEl
  onkeydown={onPanelKey}
  onmouseleave={() => (hovered = null)}
>

  <!-- Equipped: the hero, with the hand, the off hand and the pockets around them. -->
  <section class="equipped" data-testid="carry-strip" aria-label={inventoryCopy.equipped}>
    <div class="eq-side">
      {@render slotButton('hand', inventoryCopy.hand, handEntry, 'hand-slot', 'sword', true, kit.basicName)}
      {#if model}
        {#if model.offHand.open}
          {@render slotButton('off', inventoryCopy.offHand, offEntry, 'off-hand', 'lantern')}
        {:else}
          {@render lockedSlot('off-locked', inventoryCopy.offHand, 'off-hand', inventoryCopy.offHandClosed)}
        {/if}
      {/if}
    </div>

    <svelte:element this={onCharacter ? 'button' : 'div'} type={onCharacter ? 'button' : undefined} class="hero" onclick={onCharacter} data-testid={onCharacter ? 'open-character' : undefined} role={onCharacter ? undefined : 'group'} aria-label={onCharacter ? `${hero.name}, ${hero.line}: ${inventoryCopy.heroEntry}` : undefined}>
      <span class="hero-face">{#if hero.portrait}<img src={hero.portrait} alt="" />{:else}{hero.name[0]}{/if}</span>
      <b>{hero.name}</b>
      <small>{hero.line}{#if onCharacter}&nbsp;›{/if}</small>
    </svelte:element>

    <div class="eq-side">
      {#if model}
        {#each model.pockets as p, i (p.slot)}
          {@render slotButton(`pocket-${i + 1}`, inventoryCopy.pocket(i + 1), pocketEntry(i + 1), `pocket-${i + 1}`, 'bag')}
        {/each}
        {#if model.pockets.length < ITEM_RULES.pockets.withCarryGear}
          {@render lockedSlot('pocket-locked', inventoryCopy.pocket(model.pockets.length + 1), `pocket-${model.pockets.length + 1}-locked`, inventoryCopy.pocketLocked)}
        {/if}
      {/if}
    </div>
    {#if model && onOwnChest}
      <button type="button" class="act chest" data-testid="own-chest" onclick={onOwnChest}><Icon name="key" size={12} /> {inventoryCopy.ownChest}</button>
    {/if}
  </section>
  {#if model && purseGold > 0}
    <section class="purse-row" data-testid="purse-row" aria-label={purseCopy.title} data-dirty={open === 'give:purse' && goldText ? 'true' : undefined}>
      <span class="purse-coin"><ArtIcon art="purse-gold" name="coin" size={16} /></span>
      <b class="purse-gold">{goldPhrase(purseGold)}</b>
      <button type="button" class="act" data-act="give-gold" aria-expanded={open === 'give:purse'} disabled={action.busy !== null} onclick={toggleGold}>{purseCopy.give}</button>
      {#if open === 'give:purse'}
        {@const people = nearby()}
        <div class="chooser purse-give" data-testid="give-gold-to">
          {#if !goldTo}
            {#if people.length === 0}
              <small>{purseCopy.giveNobody}</small>
            {:else}
              <small>{purseCopy.giveTo}</small>
              {#each people as p (p.accountId)}
                <button type="button" class="act" data-give-gold-to={p.accountId} onclick={() => (goldTo = p)}>{p.displayName}</button>
              {/each}
            {/if}
          {:else}
            <small>{purseCopy.giveTo} {goldTo.displayName}</small>
            <PurseAmount bind:value={goldText} max={purseGold} label="How much gold" testid="give-gold-amount" autofocus />
            <button type="button" class="act primary" disabled={action.busy !== null || goldAmount === null} onclick={giveGold} data-testid="give-gold">{purseCopy.giveButton(goldAmount)}</button>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
  {#if model && model.thanks.length > 0}
    <details class="thanks" data-testid="thanks">
      <summary>{inventoryCopy.thanks} ({model.thanks.length})</summary>
      <ul>
        {#each model.thanks as t (t.at + t.fromName + t.itemDef)}<li>{inventoryCopy.thanksLine(t.fromName, giftPhrase(t.itemDef, 1))}</li>{/each}
      </ul>
    </details>
  {:else if !model && connected && items.status === 'loading'}
    <p class="fine">{inventoryCopy.loading}</p>
  {/if}

  <!-- Carrying: filter chips, then the grid and the picked thing's card. -->
  <h3 class="section-title carrying">{inventoryCopy.carrying}</h3>
  <div class="chips" role="tablist" aria-label="Inventory">
    {#each INVENTORY_FILTERS as t (t.id)}
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
        <span class="ti"><Icon name={t.icon} size={13} /></span>
        <span class="tl">{t.label}</span>
        {#if count(t.id) > 0}<span class="tc">{count(t.id)}</span>{/if}
        {#if tabHasNew(t.id)}<span class="newdot" aria-hidden="true"></span><span class="sr">, new</span>{/if}
      </button>
    {/each}
  </div>

  <div class="page" role="tabpanel" id={`inv-page-${tab}`} aria-labelledby={`inv-tab-${tab}`} data-testid={`inv-page-${tab}`}>
    {#if tab === 'papers'}
      <p class="fine">{touch ? inventoryCopy.papersNoteTouch : inventoryCopy.papersNote}</p>
      <PapersTab />
    {:else}
      <div class="body" style={`--card-top:${cardTop}px`}>
        <div class="grids">
          {#if mainShown.length === 0}
            <p class="empty">
              {tab === 'all' ? inventoryCopy.emptyFilter : inventoryCopy.empty[tab]}
            </p>
          {:else}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <ul class="grid" aria-label={inventoryCopy.carrying} onkeydown={onGridKey}>
              {#each mainShown as e, i (e.key)}{@render cell(e, i)}{/each}
            </ul>
          {/if}
          {#if roadShown.length > 0}
            <h3 class="section-title">{inventoryCopy.road}</h3>
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <ul class="grid road" aria-label={inventoryCopy.road} onkeydown={onGridKey}>
              {#each roadShown as e, i (e.key)}{@render cell(e, mainShown.length + i)}{/each}
            </ul>
          {/if}
        </div>
        {#if card}
          <aside class="card" data-item={card.key} data-state={card.instance?.state} aria-label={card.name} aria-live="polite">
            {#if selected}<button type="button" class="x card-x" aria-label={inventoryCopy.closeCard} onclick={() => void closeCard()}><Icon name="close" size={12} /></button>{/if}
            {@render itemCard(card, selected === card.key)}
          </aside>
        {:else if slotCard}
          <aside class="card" data-slot={slotCard} aria-live="polite">
            <button type="button" class="x card-x" aria-label={inventoryCopy.closeCard} onclick={() => void closeCard()}><Icon name="close" size={12} /></button>
            {@render slotView(slotCard)}
          </aside>
        {:else if !touch && mainShown.length > 0}
          <aside class="card hint" aria-hidden="true"><p class="line">{inventoryCopy.pick}</p></aside>
        {/if}
      </div>
    {/if}
  </div>
</Panel>

<style>
  :global(.overlay > .panel.inventory) {
    width: min(820px, 100%);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .fine {
    margin: 0 0 10px;
  }
  /* ---- the Purse row ---- */
  .purse-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 10px 0 0;
    padding: 6px 10px;
    border: 2px solid var(--paper-line);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.3);
  }
  .purse-coin {
    display: inline-grid;
    place-items: center;
    color: var(--gold-deep);
  }
  .purse-gold {
    font-family: var(--font-display);
    font-weight: normal;
    color: var(--wood-dark);
  }
  .purse-row > .act {
    margin-left: auto;
  }
  .chooser.purse-give {
    flex: 1 1 100%;
    display: grid;
    gap: 8px;
  }
  small {
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--text-soft);
  }

  /* ---- message (in the pinned header, src/ui/Panel.svelte): the bag's is tinted ---- */
  :global(.overlay > .panel.inventory > .panel-head > .msg) {
    border-width: 1.5px;
  }
  :global(.overlay > .panel.inventory > .panel-head > .msg.ok) {
    border-color: #7aa25a;
    --msg-tint: rgba(160, 210, 120, 0.2);
  }
  :global(.overlay > .panel.inventory > .panel-head > .msg.error) {
    border-color: #c0603e;
    --msg-tint: rgba(224, 122, 82, 0.15);
  }

  /* ---- Equipped: hand and off hand | the hero | pockets ---- */
  .equipped {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 8px 14px;
    margin: 0 0 6px;
    padding: 10px 12px;
    border-radius: 12px;
    background: radial-gradient(120% 140% at 50% 0%, rgba(255, 249, 226, 0.95), rgba(240, 222, 178, 0.6));
    border: 2px solid var(--paper-line);
  }
  .eq-side {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .eq-side:last-of-type {
    justify-content: flex-start;
  }
  .eq {
    all: unset;
    box-sizing: border-box;
    display: grid;
    justify-items: center;
    gap: 3px;
    width: 64px;
    cursor: pointer;
    border-radius: 10px;
  }
  /* Not open yet: faded, but a tap still says why. */
  .eq.locked {
    opacity: 0.6;
  }
  .eq:focus-visible {
    outline: 3px solid var(--gold);
  }
  .eq-box {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 10px;
    background: var(--paper-hi);
    border: 2px dashed var(--paper-line);
    color: var(--wood);
  }
  .eq.filled .eq-box,
  .eq-box.held {
    border: 2px solid var(--wood);
    box-shadow: inset 0 0 0 2px rgba(255, 249, 230, 0.9);
  }
  .eq-box.held {
    background: radial-gradient(circle, #fff7d6 0%, #f5d98a 100%);
    border-color: var(--gold-deep);
  }
  .eq.on .eq-box {
    outline: 3px solid var(--gold);
    outline-offset: 1px;
  }
  .eq-empty {
    display: grid;
    place-items: center;
    opacity: 0.6;
  }
  .eq-empty.weapon {
    opacity: 1;
    color: var(--wood-dark);
  }
  .eq-label {
    font-family: var(--font-display);
    font-size: 11.5px;
    color: var(--wood);
    white-space: nowrap;
  }
  .hero {
    all: unset;
    box-sizing: border-box;
    display: grid;
    justify-items: center;
    gap: 1px;
    min-width: 96px;
    padding: 4px 8px;
    border-radius: 12px;
    text-align: center;
  }
  button.hero {
    cursor: pointer;
  }
  button.hero:hover .hero-face,
  button.hero:focus-visible .hero-face {
    border-color: var(--gold-deep);
  }
  button.hero:focus-visible {
    outline: 3px solid var(--gold);
  }
  .hero-face {
    width: 64px;
    height: 64px;
    display: grid;
    place-items: center;
    overflow: hidden;
    border: 3px solid var(--wood-dark);
    border-radius: 14px;
    background: radial-gradient(circle at 50% 70%, #fff8e0, #e9d3a1);
    font-family: var(--font-display);
    font-size: 30px;
    color: var(--wood);
  }
  .hero-face img {
    width: 58px;
    height: 58px;
    object-fit: contain;
    image-rendering: pixelated;
    align-self: end;
  }
  .hero b {
    margin-top: 3px;
    font-family: var(--font-display);
    font-size: 15px;
    color: var(--wood-dark);
  }
  .hero small {
    font-size: 12px;
    line-height: 1.2;
  }
  .act.chest {
    position: absolute;
    right: 8px;
    bottom: 6px;
  }
  .thanks {
    margin: 4px 0 4px;
    font-size: 13px;
    color: var(--text-soft);
  }
  .thanks ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }

  /* ---- Carrying: chips ---- */
  .section-title.carrying {
    margin-top: 12px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 0 0 10px;
  }
  .chips button {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 32px;
    padding: 3px 10px;
    font-size: 13.5px;
    border-radius: 999px;
    border-width: 2px;
    box-shadow: 0 2px 0 rgba(74, 50, 32, 0.35);
    background: rgba(255, 252, 240, 0.7);
    color: var(--text-soft);
  }
  .chips button.active {
    background: linear-gradient(180deg, var(--cream), var(--gold));
    color: var(--wood-dark);
    border-color: var(--wood-dark);
  }
  .chips button:hover:not(:disabled) {
    transform: none;
  }
  .ti {
    display: inline-grid;
    color: var(--wood);
  }
  .tc {
    min-width: 16px;
    padding: 0 4px;
    font-size: 11px;
    line-height: 15px;
    text-align: center;
    border-radius: 999px;
    background: rgba(107, 76, 46, 0.14);
    color: var(--wood-dark);
  }
  .newdot {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--ember);
    border: 1.5px solid var(--wood-dark);
  }

  /* ---- the grid and the card ---- */
  .page {
    container-type: inline-size;
  }
  .body {
    display: grid;
    gap: 12px;
  }
  .grids {
    min-width: 0;
  }
  .grid {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
    gap: 6px;
  }
  .cell {
    all: unset;
    box-sizing: border-box;
    position: relative;
    display: grid;
    justify-items: center;
    align-content: start;
    gap: 3px;
    width: 100%;
    min-height: 88px;
    padding: 6px 4px 5px;
    cursor: pointer;
    border-radius: 10px;
    background: rgba(255, 252, 240, 0.55);
    border: 2px solid var(--paper-line);
  }
  .cell:hover {
    border-color: var(--wood);
  }
  .cell:focus-visible {
    outline: 3px solid var(--gold);
  }
  .cell.on {
    border-color: var(--gold-deep);
    background: rgba(255, 226, 140, 0.35);
  }
  .cell.dim .ci {
    filter: grayscale(0.6);
    opacity: 0.7;
  }
  .ci {
    position: relative;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 8px;
    background: var(--paper-hi);
    border: 2px solid var(--wood);
    color: var(--wood);
  }
  .thumb {
    max-width: 36px;
    max-height: 36px;
    image-rendering: pixelated;
  }
  .count {
    position: absolute;
    right: -7px;
    bottom: -6px;
    min-width: 18px;
    padding: 0 4px;
    font-family: var(--font-display);
    font-size: 11.5px;
    line-height: 16px;
    text-align: center;
    color: var(--paper-hi);
    background: var(--wood-dark);
    border-radius: 999px;
  }
  /* A count of one says nothing on the icon (it stays for screen readers). */
  .count.one {
    width: 1px;
    height: 1px;
    min-width: 0;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .badge {
    position: absolute;
    top: -5px;
    right: -5px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--ember);
    border: 1.5px solid var(--wood-dark);
  }
  .worn {
    position: absolute;
    left: -6px;
    top: -6px;
    display: grid;
    place-items: center;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    color: var(--wood-dark);
    background: var(--gold);
    border: 1.5px solid var(--wood-dark);
  }
  .grey-chip {
    position: absolute;
    bottom: 2px;
    left: 2px;
    width: 6px;
    height: 6px;
    background: #9aa0a6;
    border: 1px solid #5f6368;
    border-radius: 2px;
    box-sizing: border-box;
  }
  .cn {
    max-width: 100%;
    font-size: 11.5px;
    line-height: 1.2;
    text-align: center;
    color: var(--wood-dark);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .bar {
    position: relative;
    display: block;
    width: 44px;
    height: 5px;
    border-radius: 3px;
    background: rgba(107, 76, 46, 0.16);
    border: 1px solid var(--wood-dark);
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
  .grid.road .cell {
    background: rgba(255, 255, 255, 0.25);
  }
  .empty {
    margin: 0 0 10px;
    padding: 12px;
    text-align: center;
    font-size: 14px;
    color: var(--text-soft);
    border: 2px dashed var(--paper-line);
    border-radius: 10px;
  }

  /* The card: under the grid, held at the sheet's bottom while the grid scrolls. */
  .card {
    position: sticky;
    bottom: -24px;
    z-index: 2;
    display: grid;
    gap: 5px;
    max-height: 48dvh;
    overflow-y: auto;
    padding: 10px 12px 12px;
    border-radius: 12px;
    background: linear-gradient(180deg, var(--paper-glow) 0%, var(--paper-hi) 100%);
    border: 2px solid var(--wood);
    box-shadow: 0 -6px 14px -8px rgba(58, 38, 20, 0.45);
  }
  .card.hint {
    display: none;
  }
  .card-x {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 28px;
    height: 28px;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-right: 22px;
  }
  .card-icon {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 8px;
    background: var(--paper);
    border: 2px solid var(--wood);
    color: var(--wood);
  }
  .card-icon.dim {
    filter: grayscale(0.6);
  }
  .card-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    min-width: 0;
  }
  .card-name b {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 16px;
    color: var(--wood-dark);
  }
  .times {
    font-family: var(--font-display);
    font-size: 14px;
    color: var(--wood);
  }
  .tag {
    padding: 0 6px;
    font-family: var(--font-display);
    font-size: 11px;
    border-radius: 999px;
    border: 1.5px solid var(--wood-dark);
    color: var(--wood-dark);
    background: var(--paper-hi);
  }
  .tag.new {
    color: #5a2410;
    background: linear-gradient(180deg, #ffe0b0, #ffc27a);
  }
  .tag.held {
    background: linear-gradient(180deg, var(--cream), var(--gold));
  }
  .line {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.4;
    color: var(--text);
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
  .where {
    font-weight: 700;
    color: var(--accent);
  }
  .wear {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .wear .bar {
    width: 110px;
    height: 8px;
    border-width: 1.5px;
    border-radius: 4px;
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
  .x {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border-radius: 50%;
    border-width: 1.5px;
    box-shadow: none;
  }
  .x:hover:not(:disabled) {
    transform: none;
    box-shadow: none;
  }
  /* A thumb-sized hit area around the small round buttons (the card's close, a fitting's take-off). */
  .x {
    position: relative;
  }
  .card-x {
    position: absolute;
  }
  :global(:root.touch) .x::after {
    content: '';
    position: absolute;
    inset: -12px;
  }
  :global(:root.touch) .card-x::after {
    inset: -8px;
  }
  .acts,
  .chooser {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
  }
  .chooser {
    padding: 5px 7px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.35);
    border: 1.5px dashed var(--paper-line);
  }
  .pick-hint {
    font-style: italic;
    color: var(--text-soft);
  }
  .act {
    padding: 3px 10px;
    font-size: 13px;
    border-radius: 7px;
    box-shadow: 0 2px 0 var(--wood-dark);
  }

  /* Room beside the grid: the card is a column, under the pinned header. */
  @container (min-width: 540px) {
    .body {
      grid-template-columns: minmax(0, 1fr) 250px;
      align-items: start;
    }
    .card {
      position: sticky;
      top: var(--card-top, 120px);
      bottom: auto;
      max-height: calc(100dvh - var(--card-top, 120px) - 48px);
      box-shadow: 0 4px 12px -8px rgba(58, 38, 20, 0.45);
    }
    .card.hint {
      display: grid;
      place-items: center;
      min-height: 120px;
      border-style: dashed;
      border-color: var(--paper-line);
      background: none;
      box-shadow: none;
    }
    .card.hint .line {
      color: var(--text-soft);
      font-size: 13px;
      text-align: center;
    }
  }

  /* Phones: thumb-sized slots and chips; the chips in one row. */
  :global(:root.touch) .chips {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 3px;
  }
  :global(:root.touch) .chips button {
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    min-height: 44px;
    padding: 4px 1px;
    font-size: 11px;
    line-height: 1.1;
    border-radius: 10px;
  }
  :global(:root.touch) .tc {
    display: none;
  }
  :global(:root.touch) .act {
    min-height: 44px;
    padding: 6px 14px;
  }
  /* Phone landscape: a wider side sheet, so the grid and its card sit side
     by side, and a slimmer Equipped row (the screen is short). */
  @media (orientation: landscape) {
    :global(:root.touch .overlay.sheet > .panel.inventory) {
      width: min(90vw, 780px);
    }
    :global(:root.touch) .equipped {
      grid-template-columns: auto auto 1fr auto;
      padding: 6px 10px;
    }
    :global(:root.touch) .eq-side:last-of-type {
      grid-column: 3;
    }
    :global(:root.touch) .hero {
      grid-column: 1;
      grid-row: 1;
      grid-template-columns: auto auto;
      grid-template-rows: auto auto;
      column-gap: 8px;
      justify-items: start;
      align-items: center;
      text-align: left;
    }
    :global(:root.touch) .hero-face {
      grid-row: 1 / 3;
      width: 48px;
      height: 48px;
      font-size: 22px;
    }
    :global(:root.touch) .hero-face img {
      width: 44px;
      height: 44px;
    }
    :global(:root.touch) .hero b {
      margin: 0;
    }
    :global(:root.touch) .eq-box {
      width: 44px;
      height: 44px;
    }
    :global(:root.touch) .act.chest {
      position: static;
      grid-column: 4;
      grid-row: 1;
      align-self: center;
    }
  }
  @media (max-width: 560px) {
    .equipped {
      grid-template-columns: auto 1fr auto;
      padding: 8px;
      gap: 6px;
    }
    .eq-side {
      flex-direction: column;
      gap: 4px;
    }
    .eq {
      width: 58px;
    }
    .eq-box {
      width: 46px;
      height: 46px;
    }
    .act.chest {
      position: static;
      grid-column: 1 / -1;
      justify-self: center;
    }
  }
</style>
