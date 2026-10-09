<script lang="ts">
  import { DEMO_CHARACTER, discoveryInfo } from '../content/world'
  import { inventoryCopy } from '../content/inventory'
  import { getCombatKit } from '../lib/combat'
  import { EMBER_COSTS, ROAD_LANTERNS, XP_PER_EMBER, chestOpened, isLit, withCharm } from '../lib/embers'
  import type { Session } from '../game/session'
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'
  import Panel from './Panel.svelte'
  import { isTouchFirst } from './device'
  import { heroLine } from './hero'
  import CompanionsTab from './CompanionsTab.svelte'

  // Keyboard open/close (C / Escape) is owned by App.svelte's global handler.
  // The pack, materials and keepsakes live in the Inventory (I); this panel
  // stays on the hero.
  // Two pages: the hero, and their companions (a Habitica hero's only: guests
  // and heroes without a profile have no pets to choose from, crafts.md 2.2).
  // `initialTab`: the page to open on (the stable's "Choose a mount" opens
  // Companions).
  let {
    session,
    onClose,
    onInventory,
    initialTab = 'hero'
  }: { session: Session; onClose: () => void; onInventory: () => void; initialTab?: CharacterTab } = $props()

  type CharacterTab = 'hero' | 'companions'
  const TABS: { id: CharacterTab; label: string }[] = [
    { id: 'hero', label: 'Hero' },
    { id: 'companions', label: 'Companions' }
  ]
  let tab = $state<CharacterTab>('hero')
  $effect.pre(() => {
    tab = initialTab
  })
  const showTabs = $derived(ui.importedProfile !== null)
  const page = $derived<CharacterTab>(showTabs ? tab : 'hero')

  function onTabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const i = TABS.findIndex((t) => t.id === tab)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
    tab = TABS[next].id
    document.getElementById(`char-tab-${tab}`)?.focus()
  }

  // Tracks quest/inventory changes: a quest step (session.reachStep) replaces the state object.
  const snapshot = $derived(session.state)
  const profile = $derived(ui.importedProfile)
  const kit = $derived(withCharm(getCombatKit(profile), snapshot.inventory))
  const litCount = $derived(ROAD_LANTERNS.filter((id) => isLit(snapshot, id)).length)
  const chestDone = $derived(chestOpened(snapshot))
  const who = $derived(heroLine(profile))
  const name = $derived(who.name)
  const className = $derived(who.className)
  const level = $derived(who.level)
  const stats = $derived(profile?.stats ?? DEMO_CHARACTER.stats)
  const hpPct = $derived(Math.max(0, Math.min(100, (ui.stats.hp / ui.stats.maxHp) * 100)))
  const manaPct = $derived(Math.max(0, Math.min(100, (ui.stats.mana / ui.stats.maxMana) * 100)))

  /** Whole numbers only: "~8 damage", never "~8.13 dmg". */
  const n = (v: number) => Math.max(1, Math.round(v))
  const pct = (v: number) => Math.round(v * 100)
  const secs = (v: number) => (Math.round(v * 10) / 10).toString()

  const STAT_ROWS = [
    { key: 'str', label: 'Strength', hint: 'Melee power' },
    { key: 'int', label: 'Intellect', hint: 'Magic power' },
    { key: 'con', label: 'Constitution', hint: 'Toughness' },
    { key: 'per', label: 'Perception', hint: 'Finesse & crits' }
  ] as const

  const touch = isTouchFirst()
</script>

<Panel id="char" icon="person" title="Character" closeLabel="Close character sheet" {onClose}>
  {#snippet head()}
    {#if showTabs}
      <div class="tabs" role="tablist" aria-label="Character pages">
        {#each TABS as t (t.id)}
          <button
            type="button"
            role="tab"
            id={`char-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`char-page-${t.id}`}
            tabindex={tab === t.id ? 0 : -1}
            class:active={tab === t.id}
            data-testid={`char-tab-${t.id}`}
            onclick={() => (tab = t.id)}
            onkeydown={onTabKey}
          >
            {t.label}
          </button>
        {/each}
      </div>
    {/if}
  {/snippet}

  {#if page === 'companions'}
  <div role="tabpanel" id="char-page-companions" aria-labelledby="char-tab-companions">
    <CompanionsTab />
  </div>
  {:else}
  <div role="tabpanel" id="char-page-hero" aria-labelledby={showTabs ? 'char-tab-hero' : undefined}>
  <div class="hero">
    <div class="avatar">
      {#if !profile && ui.portraits['You']}
        <img class="pixel" src={ui.portraits['You']} alt="" />
      {:else}
        <span class="initial">{name[0]}</span>
      {/if}
    </div>
    <div class="who">
      <h3 class="name">{name}</h3>
      <p class="sub">Level {level} {className}</p>
      <span class="badge habitica">Habitica hero</span>
    </div>
  </div>

  <div class="vitals">
    <div class="vital">
      <span class="vi hp"><Icon name="heart" size={16} /></span>
      <div class="bar hp"><div class="fill" style={`width:${hpPct}%`}></div></div>
      <span class="num">{ui.stats.hp}/{ui.stats.maxHp}</span>
    </div>
    <div class="vital">
      <span class="vi mana"><Icon name="drop" size={16} /></span>
      <div class="bar mana"><div class="fill" style={`width:${manaPct}%`}></div></div>
      <span class="num">{ui.stats.mana}/{ui.stats.maxMana}</span>
    </div>
    <p class="fine">Mana trickles back as you walk.{profile ? ' Health comes from your Habitica hero — heal there and sync, or spend embers on a warm rest.' : ' Health mends slowly in Hearthwick.'}</p>
  </div>

  <h3 class="section-title">Embers</h3>
  <div class="embers">
    <div class="purse">
      <span class="ei"><Icon name="ember" size={26} /></span>
      <span class="count">{ui.stats.embers}</span>
      <span class="what">
        {#if profile}
          Every {XP_PER_EMBER} XP you earn on Habitica becomes an ember when you sync in Hearthwick or the Commons.
        {:else}
          Connect Habitica in the Menu and every {XP_PER_EMBER} XP you earn there becomes an ember.
        {/if}
      </span>
    </div>
    <ul class="spends">
      <li><b>Warm rest</b><span>Hearthwick lantern · full health &amp; mana</span><em><Icon name="ember" size={11} />{EMBER_COSTS.rest}</em></li>
      <li class:done={litCount === ROAD_LANTERNS.length}><b>Road lanterns</b><span>Brackenwood · rest spots · {litCount}/{ROAD_LANTERNS.length} lit</span><em><Icon name="ember" size={11} />{EMBER_COSTS.roadLantern} each</em></li>
      <li class:done={chestDone}><b>Ashwatch chest</b><span>{chestDone ? 'Opened — the charm is in your pack' : 'Something warm inside'}</span><em>{#if chestDone}<Icon name="check" size={11} />{:else}<Icon name="ember" size={11} />{EMBER_COSTS.chest}{/if}</em></li>
    </ul>
  </div>

  <h3 class="section-title">Stats</h3>
  <div class="stats">
    {#each STAT_ROWS as s}
      <div class="stat" title={s.hint}>
        <span class="val">{stats[s.key]}</span>
        <span class="lbl">{s.label}</span>
        <span class="hint">{s.hint}</span>
      </div>
    {/each}
  </div>

  <!-- Lane F replaces this Abilities block (through the chips) with its AbilitiesSection component. -->
  <h3 class="section-title">Abilities</h3>
  <div class="abilities">
    <div class="ability">
      <div class="ai"><Icon name="sword" size={22} /></div>
      <div class="ab">
        <div class="ah"><b>{kit.basicName}</b> <span class="kbd">E</span></div>
        <p>Hits for about <b>{n(kit.meleeDamage)}</b>. Ready again in {secs(kit.basicAttackCooldown)}s.</p>
      </div>
    </div>
    <div class="ability sig">
      <div class="ai"><Icon name="sparkle" size={22} /></div>
      <div class="ab">
        <div class="ah"><b>{kit.signatureName}</b> <span class="kbd">F</span> <span class="cost"><Icon name="drop" size={10} />{kit.manaCost}</span></div>
        <p>Hits for about <b>{n(kit.signatureDamage)}</b>{#if kit.healAmount > 0} and mends <b>{n(kit.healAmount)}</b> health{/if}.</p>
      </div>
    </div>
  </div>
  <div class="chips">
    <span class="chip"><Icon name="star" size={12} /> {pct(kit.critChance)}% critical hits (2×)</span>
    <span class="chip"><Icon name="heart" size={12} /> Shrugs off {pct(kit.mitigation)}% of damage</span>
  </div>

  <div class="to-inv">
    <span class="ii"><Icon name="bag" size={20} /></span>
    <p>{inventoryCopy.characterPointer}</p>
    <button type="button" onclick={onInventory} data-testid="open-inventory">{inventoryCopy.open}{#if !touch} <span class="kbd">I</span>{/if}</button>
  </div>

  <h3 class="section-title">Discoveries</h3>
  {#if snapshot.discoveries.length === 0}
    <p class="empty">Nothing noted yet. Keep your eyes open on the road.</p>
  {:else}
    <ul class="items">
      {#each snapshot.discoveries as id}
        {@const info = discoveryInfo(id)}
        <li>
          <span class="ii found"><Icon name={info.icon} size={20} /></span>
          <span><b>{info.name}</b>{#if info.blurb}<small>{info.blurb}</small>{/if}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="fine foot">
    Stats come from your Habitica hero, gear and level included. Nothing here ever changes your account.
  </p>
  </div>
  {/if}
</Panel>

<style>
  /* The page chips, as the journal's (JournalPanel.svelte). */
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tabs button {
    flex: 1;
    min-height: 40px;
    padding: 6px 10px;
    border-radius: 9px;
    border: 2px solid transparent;
    box-shadow: none;
    background: transparent;
    color: var(--text-soft);
  }
  .tabs button.active {
    background: #fff1c2;
    border-color: var(--gold-deep);
    color: var(--wood-dark);
  }
  :global(:root.touch) .tabs button {
    min-height: 44px;
    padding: 4px 6px;
    font-size: 13px;
    white-space: nowrap;
  }
  .tabs button:hover:not(:disabled) {
    transform: none;
    box-shadow: none;
  }
  /* Phones: a smaller portrait, so the pinned header leaves room for the sheet. */
  :global(:root.touch) .avatar {
    width: 60px;
    height: 60px;
  }
  :global(:root.touch) .avatar img {
    width: 52px;
    height: 52px;
  }
  :global(:root.touch) .who .name {
    font-size: 22px;
  }
  .hero {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 14px;
    padding-right: 40px;
  }
  .avatar {
    width: 84px;
    height: 84px;
    flex: none;
    display: grid;
    place-items: center;
    border: 3px solid var(--wood-dark);
    border-radius: 14px;
    background: radial-gradient(circle at 50% 70%, #fff8e0, #e9d3a1);
    box-shadow: inset 0 0 0 2px rgba(255, 249, 230, 0.8);
    overflow: hidden;
  }
  .avatar img {
    width: 72px;
    height: 72px;
    object-fit: contain;
    align-self: end;
  }
  .initial {
    font-family: var(--font-display);
    font-size: 40px;
    color: var(--wood);
  }
  .who .name {
    margin: 0;
    font-size: 28px;
    line-height: 1.05;
    color: var(--wood-dark);
  }
  .sub {
    margin: 2px 0 6px;
    color: var(--text-soft);
    font-weight: 700;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 6px;
    border: 2px solid var(--paper-line);
    color: var(--text-soft);
  }
  .badge.habitica {
    background: #6b4c9a;
    border-color: #3f2b5e;
    color: #fff;
  }
  .vitals {
    display: grid;
    gap: 8px;
  }
  .vital {
    display: grid;
    grid-template-columns: 20px 1fr 64px;
    align-items: center;
    gap: 8px;
  }
  .vi.hp { color: var(--hp); }
  .vi.mana { color: var(--mana); }
  .bar {
    height: 14px;
    background: #4a3a30;
    border: 2px solid var(--wood-dark);
    border-radius: 7px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    box-shadow: inset 0 2px 0 rgba(255, 255, 255, 0.35);
    transition: width 0.25s ease-out;
  }
  .hp .fill { background: linear-gradient(180deg, var(--hp-hi), var(--hp)); }
  .mana .fill { background: linear-gradient(180deg, var(--mana-hi), var(--mana)); }
  .num {
    font-family: var(--font-display);
    text-align: right;
    color: var(--wood-dark);
  }
  .vitals .fine {
    margin: 0;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }
  .stat {
    display: grid;
    justify-items: center;
    padding: 10px 4px 8px;
    background: rgba(255, 255, 255, 0.4);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
    text-align: center;
  }
  .stat .val {
    font-family: var(--font-display);
    font-size: 26px;
    line-height: 1;
    color: var(--wood-dark);
  }
  .stat .lbl {
    margin-top: 4px;
    font-weight: 800;
    font-size: 12.5px;
  }
  .stat .hint {
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .abilities {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .ability {
    display: flex;
    gap: 10px;
    padding: 10px;
    background: rgba(255, 255, 255, 0.4);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
  }
  .ai {
    width: 42px;
    height: 42px;
    flex: none;
    display: grid;
    place-items: center;
    border: 2px solid var(--wood-dark);
    border-radius: 10px;
    background: linear-gradient(180deg, var(--paper-hi), var(--paper-dark));
    color: var(--wood-dark);
  }
  .sig .ai {
    background: linear-gradient(180deg, #d6e6ff, #8fb3ec);
    color: #20365c;
  }
  .ah {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 16px;
  }
  .ah b {
    font-weight: 600;
  }
  .ab p {
    margin: 2px 0 0;
    font-size: 13.5px;
    color: var(--text-soft);
  }
  .cost {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 5px;
    font-size: 11px;
    color: #fff;
    background: var(--mana);
    border-radius: 6px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--text-soft);
    background: rgba(255, 255, 255, 0.45);
    border: 1.5px solid var(--paper-line);
    border-radius: 999px;
  }
  .chip :global(.icon) {
    color: var(--gold-deep);
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .items li {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.4);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
  }
  .items li span:last-child {
    display: grid;
  }
  .items small {
    font-size: 12.5px;
    color: var(--text-soft);
  }
  .ii {
    width: 36px;
    height: 36px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--paper-dark);
    color: var(--wood);
  }
  .ii.found {
    background: #f5dc8a;
    color: #7a4a10;
  }
  .to-inv {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: 16px 0 4px;
    padding: 8px 10px;
    border: 2px dashed var(--paper-line);
    border-radius: 10px;
  }
  .to-inv p {
    flex: 1;
    min-width: 160px;
    margin: 0;
    font-size: 14px;
    color: var(--text-soft);
  }
  .items li {
    flex-wrap: wrap;
  }
  .items li span:nth-child(2) {
    flex: 1;
    min-width: 0;
  }
  .empty {
    margin: 0;
    font-style: italic;
    color: var(--text-faint);
  }
  .foot {
    margin: 18px 0 0;
  }
  @media (max-width: 560px) {
    .stats {
      grid-template-columns: repeat(2, 1fr);
    }
    .abilities {
      grid-template-columns: 1fr;
    }
    .avatar {
      width: 68px;
      height: 68px;
    }
    .avatar img {
      width: 58px;
      height: 58px;
    }
    .who .name {
      font-size: 23px;
    }
  }
  .embers {
    display: grid;
    gap: 8px;
  }
  .purse {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(255, 194, 122, 0.28), rgba(255, 179, 92, 0.12));
    border: 2px solid rgba(181, 72, 31, 0.35);
  }
  .purse .ei {
    color: var(--ember-deep);
  }
  .purse .count {
    font-family: var(--font-display);
    font-size: 28px;
    line-height: 1;
    color: #5a2410;
  }
  .purse .what {
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-soft);
  }
  .spends {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .spends li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: baseline;
    gap: 8px;
    padding: 5px 10px;
    font-size: 13.5px;
    border-radius: 8px;
    background: rgba(107, 76, 46, 0.06);
  }
  .spends li span {
    color: var(--text-soft);
    font-size: 12.5px;
  }
  .spends li em {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-style: normal;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--ember-deep);
  }
  .spends li.done {
    opacity: 0.7;
  }
  .spends li.done em {
    color: var(--accent);
  }
  @media (max-width: 560px) {
    .spends li {
      grid-template-columns: 1fr auto;
    }
    .spends li span {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
