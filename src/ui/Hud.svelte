<script lang="ts">
  import { home } from './home.svelte'
  import { villageUi } from './village.svelte'
  import { calendarLine, MARK_NOTES } from '../lib/village'
  import { ui, type AbilitySlot, type Gain } from './store.svelte'
  import type { KitMove } from '../lib/combat'
  import { EMBER_COSTS } from '../lib/embers'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import { offlineCopy } from '../content/connected'
  import { presenceCopy } from '../content/presence'
  import { papers } from './papers.svelte'
  import { heldUi } from './held.svelte'
  import { setHeld } from '../game/held'
  import { KIND_WORDS } from '../lib/belt'
  import ContextButtons from './ContextButtons.svelte'

  let {
    onJournal,
    onCharacter,
    onInventory,
    inventoryNew = 0,
    onMenu,
    onEmote,
    onGuides,
    prompt = null
  }: {
    onJournal: () => void
    onCharacter: () => void
    onInventory: () => void
    /** Items this device hasn't seen yet (the bag's dot). */
    inventoryNew?: number
    onMenu: () => void
    onEmote?: () => void
    /** Open the journal's "How do I…?" page (the pinned guide's goal line). */
    onGuides?: () => void
    /** What E does here right now ("Talk to Mara"), when the world may act on it (desktop shows it on the E slot). */
    prompt?: string | null
  } = $props()
  const presenceLive = $derived(ui.presence.status === 'live')
  /** The needle in words, for screen readers: "this way: north-east", and whether it's here or onward. */
  const needleWords = $derived.by(() => {
    const a = ui.goalDir.angle
    if (a === null) return ''
    const names = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east']
    const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8
    return `${ui.goalDir.here ? 'here, to the' : 'onward, to the'} ${names[i]}`
  })

  /**
   * Phones get a slim strip (bars, place, one line of goal) and three
   * buttons; Character lives in the bag there. Desktop keeps the card.
   */
  const touch = isTouchFirst()
  const showBars = $derived(ui.stats.maxHp > 0)
  const hpPct = $derived(Math.max(0, Math.min(100, (ui.stats.hp / ui.stats.maxHp) * 100)))
  const manaPct = $derived(Math.max(0, Math.min(100, (ui.stats.mana / ui.stats.maxMana) * 100)))
  const lowHp = $derived(ui.stats.hp > 0 && hpPct <= 30)
  const kit = $derived(ui.kit)
  /** The F and R slots: a hero without a craft has neither (crafts.md 4.2). */
  const sigSlot = $derived(ui.slot(kit.signature?.id))
  const moveSlot = $derived(ui.slot(kit.move?.id))
  const resting = $derived(ui.stats.hp <= 0 && ui.vitalsSource === 'imported')
  /** The E/Space slot says what it will do here: the prompt's verb, else the swing. */
  const actLabel = $derived(ui.prompt.label ? (ui.prompt.verb ?? 'Use') : heldUi.kind === 'weapon' ? kit.basicName : KIND_WORDS[heldUi.kind])
  /** What's in hand (src/game/held.ts): its icon on the E slot, the belt beside it. */
  const heldDef = $derived(heldUi.slot?.itemDef ?? null)
  let objectiveOpen = $state(false)
  const showEmbers = $derived(ui.stats.embers > 0 || ui.vitalsSource === 'imported')
  /** Phones show the numbers on the bars only when asked or when health runs low. */
  let numbersOpen = $state(false)
  const showNumbers = $derived(!touch || numbersOpen || lowHp)
  /** Bumps when the balance grows, to replay the little glow. */
  let emberPulse = $state(0)
  let lastEmbers = -1
  $effect(() => {
    const n = ui.stats.embers
    if (lastEmbers >= 0 && n > lastEmbers) emberPulse += 1
    lastEmbers = n
  })

  // ---- the place name: it changes over in place, and says where you came from
  /** "from Hearthwick", for a moment after walking somewhere already seen. */
  let cameFrom = $state<string | null>(null)
  let lastPlace: string | null = null
  let fromTimer: number | null = null
  $effect(() => {
    const name = ui.area.name
    const prev = lastPlace
    lastPlace = name
    // The first place after a load (before it, the name is empty) is arriving, not coming from anywhere.
    if (!prev || prev === name) return
    // A first visit has its storybook card; the chip is for coming back.
    const carded = ui.banners.some((b) => b.kind === 'area')
    if (fromTimer !== null) window.clearTimeout(fromTimer)
    cameFrom = carded ? null : prev
    fromTimer = window.setTimeout(() => (cameFrom = null), 2200)
  })

  // ---- status chips: an icon and a word; the sentence on hover or tap
  type Chip = { id: string; icon: string; text: string; why: string; tone: string; testid?: string }
  const chips = $derived.by((): Chip[] => {
    const out: Chip[] = []
    if (ui.link?.busy) out.push({ id: 'pending', icon: 'clock', text: offlineCopy.pending, why: offlineCopy.pending, tone: 'busy', testid: 'net-pending' })
    // Server trouble (a 5xx) keeps the link online now; a lost connection with trouble is offline.
    else if ((ui.link?.status === 'online' || ui.link?.status === 'offline') && ui.link.trouble) out.push({ id: 'trouble', icon: 'cloud', text: offlineCopy.troubleChip, why: offlineCopy.troubleTitle, tone: 'trouble', testid: 'net-trouble' })
    else if (ui.link?.status === 'offline') out.push({ id: 'offline', icon: 'cloud', text: offlineCopy.chip, why: offlineCopy.chipTitle, tone: 'off', testid: 'net-offline' })
    if (presenceLive && ui.presence.here > 0) out.push({ id: 'here', icon: 'person', text: presenceCopy.here(ui.presence.here), why: presenceCopy.hereTitle, tone: 'here', testid: 'presence-here' })
    if (resting) out.push({ id: 'resting', icon: 'heart', text: 'Resting', why: `Resting in Hearthwick: heal on Habitica and sync, or rest by the lantern with ${EMBER_COSTS.rest} embers earned on Habitica.`, tone: 'trouble' })
    return out
  })
  let openChip = $state<string | null>(null)
  let chipTimer: number | null = null
  function toggleChip(id: string): void {
    openChip = openChip === id ? null : id
    if (chipTimer !== null) window.clearTimeout(chipTimer)
    if (openChip) chipTimer = window.setTimeout(() => (openChip = null), 5000)
  }
  const unmooredWhy = 'Unmoored: the drift’s sway holds you. Rest in lamplight or take a remedy.'
  const openWhy = $derived.by(() => {
    if (!openChip) return null
    if (openChip === 'date' && villageUi.calendar) {
      const c = villageUi.calendar
      return `${calendarLine(c)}. ${MARK_NOTES[c.mark] ?? ''}`.trim()
    }
    if (openChip === 'unmoored') return ui.unmoored ? unmooredWhy : null
    return chips.find((c) => c.id === openChip)?.why ?? null
  })

  const gainOf = (to: Gain['to']): Gain | null => [...ui.gains].reverse().find((g) => g.to === to) ?? null
  // A phone shows only the newest tag (the two would overlap in its narrow row).
  const newest = $derived(ui.gains.at(-1) ?? null)
  const bagGain = $derived(touch ? (newest?.to === 'bag' ? newest : null) : gainOf('bag'))
  const journalGain = $derived(touch ? (newest?.to === 'journal' ? newest : null) : gainOf('journal'))
  /** What's new in the status chips, read out once (the chips themselves are buttons). */
  const statusLine = $derived(chips.filter((c) => c.id !== 'here').map((c) => c.text).join('. '))
</script>

{#snippet placeName()}
  <span class="place-name">
    {#key ui.area.name}<span class="nm">{ui.area.name}</span>{/key}
    {#if cameFrom}<span class="from" aria-hidden="true">from {cameFrom}</span>{/if}
  </span>
{/snippet}

{#snippet embers()}
  {#if showEmbers}
    {#key emberPulse}
      <span class="embers" class:pulse={emberPulse > 0} title="Embers: earned from your Habitica XP, spent at lanterns" aria-label={`${ui.stats.embers} embers`}>
        <Icon name="ember" size={13} />{ui.stats.embers}
      </span>
    {/key}
  {/if}
{/snippet}

{#snippet statusChips()}
  <!-- On a phone the date waits for a festival: the goal needs the room. -->
  {#if villageUi.calendar && (!touch || villageUi.calendar.festival)}
    {@const c = villageUi.calendar}
    <button type="button" class="chip date" data-testid="calendar-line" title={`${calendarLine(c)}. ${MARK_NOTES[c.mark] ?? ''}`} aria-expanded={openChip === 'date'} onclick={() => toggleChip('date')}>
      <span aria-hidden="true">{c.wick} {c.day}</span>
      <span class="sr">{calendarLine(c).replace(` · ${c.festival}`, '')}</span>
      {#if c.festival}<span class="fest">{c.festival}</span>{/if}
    </button>
  {/if}
  {#each chips as chip (chip.id)}
    <button type="button" class="chip {chip.tone}" data-testid={chip.testid} title={chip.why} aria-expanded={openChip === chip.id} onclick={() => toggleChip(chip.id)}>
      {#if chip.id === 'pending'}<span class="dots" aria-hidden="true"></span>{:else}<Icon name={chip.icon} size={12} />{/if}
      <span>{chip.text}</span>
    </button>
  {/each}
  {#if ui.unmoored}
    <button type="button" class="chip unmoored-hint" data-testid="unmoored-hint" title={unmooredWhy} aria-expanded={openChip === 'unmoored'} onclick={() => toggleChip('unmoored')}>
      <Icon name="sparkle" size={11} />
      <span>Unmoored</span>
    </button>
  {/if}
{/snippet}

{#snippet goal()}
  {#if ui.goalLine.guide}
    {@const g = ui.goalLine.guide}
    <!-- A pinned "How do I…?" guide leads: its step, with a pin; tap for the guide in the journal. -->
    <button type="button" class="objective pinned" onclick={() => onGuides?.()} title={`${g.title}: ${g.step}`} aria-label={`Pinned guide, ${g.title}, step ${g.index + 1} of ${g.count}: ${g.step}${needleWords ? ` (${needleWords})` : ''}`} data-testid="goal-pinned">
      <span class="goal-icon pin"><Icon name="pin" size={14} /></span>
      <span class="goal-text">{g.step}</span>
      {#if ui.goalDir.angle !== null}
        <span class="needle" class:here={ui.goalDir.here} data-testid="goal-needle" aria-hidden="true" style={`--a:${ui.goalDir.angle}rad`}>
          <svg viewBox="0 0 12 12" width="14" height="14"><path d="M11 6 L3 2 L5 6 L3 10 Z" /></svg>
        </span>
      {/if}
    </button>
  {:else if ui.goalLine.quest}
    {@const q = ui.goalLine.quest}
    <!-- A pinned quest leads: its next step, with a pin; tap for the Quests page. -->
    <button type="button" class="objective pinned" onclick={onJournal} title={`${q.title}: ${q.objective}`} aria-label={`Pinned quest, ${q.title}: ${q.objective}${needleWords ? ` (${needleWords})` : ''}`} data-testid="goal-pinned-quest">
      <span class="goal-icon pin"><Icon name="pin" size={14} /></span>
      <span class="goal-text">{q.step}</span>
      {#if ui.goalDir.angle !== null}
        <span class="needle" class:here={ui.goalDir.here} data-testid="goal-needle" aria-hidden="true" style={`--a:${ui.goalDir.angle}rad`}>
          <svg viewBox="0 0 12 12" width="14" height="14"><path d="M11 6 L3 2 L5 6 L3 10 Z" /></svg>
        </span>
      {/if}
    </button>
  {:else}
  <!-- The goal in a few words, and a needle toward it; open, the whole objective. -->
  <button type="button" class="objective" onclick={() => (objectiveOpen = !objectiveOpen)} aria-expanded={objectiveOpen} title={ui.quest.objective} aria-label={`Current goal: ${ui.quest.objective}${needleWords ? ` (${needleWords})` : ''}`}>
    <span class="goal-icon"><Icon name="star" size={12} /></span>
    <span class="goal-text">{objectiveOpen ? ui.quest.objective : (ui.quest.short ?? ui.quest.objective)}</span>
    {#if ui.goalDir.angle !== null}
      <span class="needle" class:here={ui.goalDir.here} data-testid="goal-needle" aria-hidden="true" style={`--a:${ui.goalDir.angle}rad`}>
        <svg viewBox="0 0 12 12" width="14" height="14"><path d="M11 6 L3 2 L5 6 L3 10 Z" /></svg>
      </span>
    {/if}
  </button>
  {/if}
  {#if home.goal}
    <p class="home-goal" data-testid="home-goal"><Icon name="home" size={11} /> <span>{home.goal}</span></p>
  {/if}
{/snippet}

{#snippet bars()}
  {#if showBars}
    <svelte:element this={touch ? 'button' : 'div'} type={touch ? 'button' : undefined} class="bars" class:nums={showNumbers} onclick={touch ? () => (numbersOpen = !numbersOpen) : undefined} aria-label={touch ? `Health ${ui.stats.hp} of ${ui.stats.maxHp}, mana ${ui.stats.mana} of ${ui.stats.maxMana}. Show the numbers` : undefined} role={touch ? undefined : 'group'}>
      <span class="vital" class:low={lowHp} title="Health">
        <span class="vi hp"><Icon name="heart" size={touch ? 12 : 14} /></span>
        <span class="bar hp" role="meter" aria-label="Health" aria-valuemin="0" aria-valuemax={ui.stats.maxHp} aria-valuenow={ui.stats.hp}>
          <span class="fill" style={`width:${hpPct}%`}></span>
        </span>
        {#if showNumbers}<span class="num">{ui.stats.hp}<small>/{ui.stats.maxHp}</small></span>{/if}
      </span>
      <span class="vital" title="Mana">
        <span class="vi mana"><Icon name="drop" size={touch ? 12 : 14} /></span>
        <span class="bar mana" role="meter" aria-label="Mana" aria-valuemin="0" aria-valuemax={ui.stats.maxMana} aria-valuenow={ui.stats.mana}>
          <span class="fill" style={`width:${manaPct}%`}></span>
        </span>
        {#if showNumbers}<span class="num">{ui.stats.mana}<small>/{ui.stats.maxMana}</small></span>{/if}
      </span>
    </svelte:element>
  {/if}
{/snippet}

{#snippet gainTag(g: Gain | null)}
  {#if g}
    {#key g.id}
      <span class="gain" aria-hidden="true">
        <ArtIcon art={g.art ?? (g.itemDef ? `icon-${g.itemDef}` : null)} name={g.icon ?? (g.to === 'journal' ? 'scroll' : 'sparkle')} size={14} />
        <span>+{g.label}</span>
      </span>
    {/key}
  {/if}
{/snippet}

{#snippet buttons()}
  <nav class="buttons" aria-label="Menus">
    <!-- The next step is in the journal (the opening's note): the book glows like the edge glint. -->
    <button type="button" class="hb" class:glow={ui.goalLine.journal} data-testid="journal-button" onclick={onJournal} aria-label={papers.unread.length ? `Journal (J), ${papers.unread.length} new paper${papers.unread.length === 1 ? '' : 's'}` : 'Journal (J)'} title="Journal">
      <Icon name="book" size={20} />
      {#if papers.unread.length > 0}<span class="newdot" aria-hidden="true"></span>{/if}
      {#if !touch}<span class="kbd">J</span>{/if}
      {@render gainTag(journalGain)}
    </button>
    {#if !touch}
      <button type="button" class="hb" onclick={onCharacter} aria-label="Character (C)" title="Character">
        <Icon name="person" size={20} />
        <span class="kbd">C</span>
      </button>
    {/if}
    <button type="button" class="hb" onclick={onInventory} aria-label={inventoryNew ? `Inventory (I), ${inventoryNew} new` : 'Inventory (I)'} title="Inventory" data-testid="inventory-button">
      <Icon name="bag" size={20} />
      {#if inventoryNew > 0}<span class="newdot" aria-hidden="true"></span>{/if}
      {#if !touch}<span class="kbd">I</span>{/if}
      {@render gainTag(bagGain)}
    </button>
    {#if presenceLive && onEmote}
      <button type="button" class="hb" class:on={ui.emoteOpen} onclick={onEmote} aria-label="Emote (G)" title="Emote" data-testid="emote-button">
        <Icon name="speech" size={20} />
        {#if !touch}<span class="kbd">G</span>{/if}
      </button>
    {/if}
    <button type="button" class="hb" onclick={onMenu} aria-label="Menu (Esc)" title="Menu">
      <Icon name="menu" size={20} />
      {#if !touch}<span class="kbd">Esc</span>{/if}
    </button>
  </nav>
{/snippet}

<!-- data-inset: App measures the HUD's children for the camera (src/ui/play-insets.ts). -->
<div class="hud" class:slim={touch} class:hidden={ui.cinematic} aria-hidden={ui.cinematic} data-inset="hud">
  {#if touch}
    <div class="strip panel">
      {@render bars()}
      {@render embers()}
      <span class="place"><Icon name="lantern" size={12} />{@render placeName()}</span>
    </div>
    <div class="goalbar panel" class:open={objectiveOpen}>
      {@render goal()}
      <span class="chips">{@render statusChips()}</span>
    </div>
    {@render buttons()}
  {:else}
    <div class="card panel" class:open={objectiveOpen}>
      <div class="place">
        <Icon name="lantern" size={14} />
        {@render placeName()}
        {@render embers()}
      </div>
      <div class="row chips">
        {@render statusChips()}
      </div>
      {@render goal()}
      {@render bars()}
    </div>
    {@render buttons()}
  {/if}
  {#if openWhy}
    <p class="why" role="status" data-inset-skip>{openWhy}</p>
  {/if}
  <!-- Read out in full: gains (the tags only show "+7 Fiber"), the hero's thoughts (canvas text), and status changes. -->
  <p class="sr" aria-live="polite" data-inset-skip>{bagGain?.text ?? ''} {journalGain?.text ?? ''}</p>
  <p class="sr" aria-live="polite" data-inset-skip>{ui.thought?.text ?? ''}</p>
  <p class="sr" role="status" data-inset-skip>{statusLine}</p>
</div>

{#snippet moveSlotView(m: KitMove, st: AbilitySlot, key: string, which: 'sig' | 'move')}
  <div class="slot {which}" class:dim={ui.stats.mana < m.mana} class:denied={st.deniedAt > 0} data-ability={m.id}>
    {#key st.deniedAt}
      <div class="face" class:shake={st.deniedAt > 0}><ArtIcon art={m.icon} name="sparkle" size={32} /></div>
    {/key}
    {#key st.readyAt}
      {#if st.readyAt > 0}
        <div class="sweep" style={`animation-duration:${st.cooldown}s`}></div>
      {/if}
    {/key}
    <span class="kbd">{key}</span>
    <span class="label">{m.name}</span>
    <span class="cost"><Icon name="drop" size={10} />{m.mana}</span>
  </div>
{/snippet}

{#if !touch && showBars}
  <div class="actionbar" class:hidden={ui.cinematic || ui.dialogueOpen}>
    {#if prompt}
      <!-- The E slot says what it will do here; tests and players read it as the prompt. -->
      <div class="prompt" role="status"><span class="kbd">E</span><span>{prompt}</span></div>
    {/if}
    <!-- What the game has up for now (a saddle, Go home, Keep / Let it go): src/game/context-buttons.ts. -->
    <div class="ctxbar"><ContextButtons variant="bar" /></div>
    {#if heldUi.belt.length > 1}
      <!-- The belt: what you carry to hand, by number key; click or press to take one. -->
      <div class="belt" role="group" aria-label="Take in hand" data-testid="belt">
        {#each heldUi.belt as b, i (b.kind)}
          <button
            type="button"
            class="bslot"
            class:on={b.kind === heldUi.kind}
            class:worn={!b.usable}
            aria-pressed={b.kind === heldUi.kind}
            aria-label={`Hold the ${(b.kind === 'weapon' ? kit.basicName : KIND_WORDS[b.kind]).toLowerCase()} (${i + 1})`}
            title={b.kind === 'weapon' ? kit.basicName : KIND_WORDS[b.kind]}
            data-kind={b.kind}
            tabindex="-1"
            onclick={() => setHeld(b.kind)}
          >
            {#if b.itemDef}<ArtIcon art={b.itemDef} name="tools" size={16} />{:else}<Icon name="sword" size={16} />{/if}
            <span class="kbd">{i + 1}</span>
          </button>
        {/each}
      </div>
    {/if}
    <div class="slot" class:context={!!ui.prompt.label} data-held={heldUi.kind}>
      <div class="face">
        {#if ui.prompt.label}<Icon name="sparkle" size={22} />{:else if heldDef}<ArtIcon art={heldDef} name="tools" size={32} />{:else}<Icon name="sword" size={22} />{/if}
      </div>
      <span class="kbd">E</span>
      <span class="label">{actLabel}</span>
    </div>
    {#if kit.signature}
      {@render moveSlotView(kit.signature, sigSlot, 'F', 'sig')}
    {/if}
    {#if kit.move}
      {@render moveSlotView(kit.move, moveSlot, 'R', 'move')}
    {/if}
    <div class="slot roll">
      <div class="face"><Icon name="roll" size={20} /></div>
      {#key ui.roll.readyAt}
        {#if ui.roll.readyAt > 0}
          <div class="sweep" style={`animation-duration:${ui.roll.cooldown}s`}></div>
        {/if}
      {/key}
      <span class="kbd wide">Shift</span>
      <span class="label">Roll</span>
    </div>
  </div>
{/if}

{#if lowHp && !ui.cinematic}
  <div class="vignette" aria-hidden="true"></div>
{/if}

<style>
  .hud {
    position: absolute;
    top: max(10px, env(safe-area-inset-top));
    left: max(10px, env(safe-area-inset-left));
    right: max(10px, env(safe-area-inset-right));
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    pointer-events: none;
    z-index: 20;
    transition: opacity 300ms ease, transform 300ms ease;
  }
  .hud.hidden,
  .actionbar.hidden {
    opacity: 0;
    transform: translateY(-6px);
    pointer-events: none;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .row {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  /* ---- desktop card ---- */
  .card {
    padding: 10px 14px 12px;
    width: min(340px, 62vw);
    pointer-events: auto;
  }
  .place {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--wood-dark);
  }
  .place :global(.icon) {
    color: var(--gold-deep);
    flex: none;
  }
  .place-name {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
  }
  .place-name .nm {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    animation: name-in 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.1);
  }
  .from {
    flex: none;
    font-family: var(--font-body);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0;
    color: var(--text-soft);
    animation: from-life 2.2s ease forwards;
  }
  @keyframes name-in {
    from { transform: translateX(14px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes from-life {
    0% { opacity: 0; transform: translateX(-6px); }
    15%, 75% { opacity: 1; transform: translateX(0); }
    100% { opacity: 0; }
  }
  .card .chips {
    flex-wrap: wrap;
    gap: 4px;
    margin: 4px 0 2px;
  }
  .card .chips:empty {
    display: none;
  }
  .embers {
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px 1px 6px;
    font-size: 14px;
    letter-spacing: 0.02em;
    color: #5a2410;
    background: linear-gradient(180deg, #ffe0b0, #ffc27a);
    border: 2px solid var(--wood-dark);
    border-radius: 999px;
    box-shadow: 0 2px 0 var(--wood-dark);
    font-family: var(--font-display);
  }
  .embers :global(.icon) {
    color: var(--ember-deep);
  }
  .embers.pulse {
    animation: ember-pop 0.7s cubic-bezier(0.2, 0.9, 0.3, 1.4);
  }
  @keyframes ember-pop {
    0% { transform: scale(1); box-shadow: 0 2px 0 var(--wood-dark), 0 0 0 0 rgba(255, 179, 92, 0.9); }
    40% { transform: scale(1.18); box-shadow: 0 2px 0 var(--wood-dark), 0 0 0 8px rgba(255, 179, 92, 0); }
    100% { transform: scale(1); }
  }

  /* ---- status chips ---- */
  .chip {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    min-height: 22px;
    padding: 1px 8px 1px 6px;
    font-family: var(--font-display);
    font-size: 12px;
    line-height: 1.2;
    color: var(--wood-dark);
    background: rgba(255, 249, 230, 0.7);
    border: 1.5px solid rgba(74, 50, 32, 0.45);
    border-radius: 999px;
    cursor: pointer;
  }
  .chip:focus-visible {
    outline: 3px solid var(--gold);
  }
  /* A thumb-sized hit area around a small chip. */
  .slim .chip {
    position: relative;
  }
  .slim .chip::after {
    content: '';
    position: absolute;
    inset: -11px -2px;
  }
  .chip.date {
    font-style: normal;
    color: var(--text-soft);
  }
  .fest {
    padding: 0 6px;
    margin-right: -4px;
    border-radius: 999px;
    color: var(--wood-dark);
    background: linear-gradient(180deg, #ffe9a6, #f2c95a);
    border: 1.5px solid var(--gold-deep);
  }
  .chip.off {
    color: #1f3c66;
    background: linear-gradient(180deg, #dbe8ff, #b5cdf5);
    border-color: #1f3c66;
  }
  .chip.here {
    color: #173f3c;
    background: linear-gradient(180deg, #d6f2ee, #a9dcd5);
    border-color: #173f3c;
  }
  .chip.trouble {
    color: #5a1a0e;
    background: linear-gradient(180deg, #ffe1d6, #f4b8a3);
    border-color: #5a1a0e;
  }
  .chip.busy {
    color: #5a2410;
    background: linear-gradient(180deg, #fff2c9, #ffd98a);
  }
  .chip.unmoored-hint {
    color: var(--wood-dark);
    background: rgba(180, 195, 208, 0.6);
    border-color: rgba(90, 105, 120, 0.7);
  }
  .dots {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    background: var(--ember);
    animation: net-pulse 0.9s ease-in-out infinite;
  }
  @keyframes net-pulse {
    0%, 100% { opacity: 0.35; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1); }
  }
  .why {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    max-width: min(340px, calc(100vw - 32px));
    margin: 0;
    padding: 7px 11px;
    font-size: 13px;
    line-height: 1.35;
    color: #fff6dc;
    background: rgba(36, 28, 40, 0.94);
    border: 2px solid rgba(255, 210, 74, 0.5);
    border-radius: 10px;
    pointer-events: none;
    animation: why-in 0.18s ease-out;
  }
  @keyframes why-in {
    from { opacity: 0; transform: translateY(-4px); }
  }

  /* ---- goal ---- */
  .objective {
    all: unset;
    display: flex;
    gap: 6px;
    align-items: flex-start;
    min-width: 0;
    margin-top: 4px;
    font-family: var(--font-body);
    font-size: 13.5px;
    line-height: 1.35;
    color: var(--text-soft);
    cursor: pointer;
    border-radius: 6px;
  }
  .objective:focus-visible {
    outline: 3px solid var(--gold);
  }
  .goal-icon {
    flex: none;
    color: var(--gold-deep);
    margin-top: 2px;
  }
  /* The needle: a small gold arrow toward the goal (the next way out, or the goal itself, which glows). */
  .needle {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-left: auto;
    border-radius: 50%;
    background: rgba(255, 249, 230, 0.9);
    border: 1.5px solid var(--gold-deep);
  }
  .needle svg {
    transform: rotate(var(--a));
    transition: transform 0.35s ease;
  }
  .needle path {
    fill: var(--wood-dark);
  }
  .needle.here {
    background: radial-gradient(circle, #fff3c4 0%, var(--gold) 100%);
    box-shadow: 0 0 6px rgba(255, 210, 74, 0.8);
  }
  /* A pinned guide leads: the goal icon becomes a gold pin. */
  .goal-icon.pin {
    color: var(--ember-deep);
    filter: drop-shadow(0 0 2px rgba(255, 210, 74, 0.9));
  }
  .goal-text {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .open .goal-text {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .home-goal {
    margin: 4px 0 0;
    padding: 3px 8px;
    font-size: 12px;
    line-height: 1.3;
    border-radius: 6px;
    background: rgba(255, 243, 196, 0.92);
    color: var(--wood-dark);
    display: flex;
    gap: 4px;
    align-items: center;
    min-width: 0;
  }
  .home-goal span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- vitals ---- */
  .bars {
    all: unset;
    box-sizing: border-box;
    display: grid;
    gap: 6px;
    margin-top: 10px;
  }
  .vital {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    align-items: center;
    gap: 6px;
  }
  .vi.hp {
    color: var(--hp);
  }
  .vi.mana {
    color: var(--mana);
  }
  .bar {
    position: relative;
    display: block;
    height: 12px;
    background: #4a3a30;
    border: 2px solid var(--wood-dark);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: inset 0 2px 0 rgba(0, 0, 0, 0.25);
  }
  .bar .fill {
    display: block;
    height: 100%;
    border-radius: 3px 0 0 3px;
    transition: width 0.25s ease-out;
    box-shadow: inset 0 2px 0 rgba(255, 255, 255, 0.35);
  }
  .hp .fill {
    background: linear-gradient(180deg, var(--hp-hi), var(--hp));
  }
  .mana .fill {
    background: linear-gradient(180deg, var(--mana-hi), var(--mana));
  }
  .num {
    font-family: var(--font-display);
    font-size: 14px;
    color: var(--wood-dark);
    min-width: 46px;
    text-align: right;
  }
  .num small {
    font-size: 11px;
    color: var(--text-faint);
  }
  .vital.low .bar {
    animation: lowpulse 0.9s ease-in-out infinite;
  }
  .vital.low .vi {
    animation: beat 0.9s ease-in-out infinite;
  }

  /* ---- menu buttons ---- */
  .buttons {
    display: flex;
    gap: 8px;
    pointer-events: auto;
  }
  .hb.on {
    background: linear-gradient(180deg, #ffe58a 0%, #f2b93a 100%);
  }
  .hb {
    position: relative;
    width: 48px;
    height: 48px;
    padding: 0;
    display: grid;
    place-items: center;
    border-width: 3px;
    border-radius: 12px;
  }
  .hb.glow {
    border-color: var(--gold-deep);
    box-shadow: 0 0 0 3px var(--gold-glow), 0 0 14px rgba(255, 210, 74, 0.85);
    animation: book-glow 1.6s ease-in-out infinite;
  }
  @keyframes book-glow {
    50% {
      box-shadow: 0 0 0 3px var(--gold-glow), 0 0 4px rgba(255, 210, 74, 0.4);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .hb.glow {
      animation: none;
    }
  }
  .newdot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--ember);
    border: 2px solid var(--wood-dark);
    animation: newdot 1.8s ease-in-out infinite;
  }
  @keyframes newdot {
    50% { transform: scale(1.2); }
  }
  .hb .kbd {
    position: absolute;
    bottom: -10px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 12px;
    height: 20px;
    min-width: 20px;
  }
  /* "+7 Fiber" under the bag (or the journal) for a moment. */
  .gain {
    position: absolute;
    top: calc(100% + 14px);
    right: -4px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 9px 2px 6px;
    white-space: nowrap;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--wood-dark);
    background: linear-gradient(180deg, #fff6d0, #ffd98a);
    border: 2px solid var(--wood-dark);
    border-radius: 999px;
    box-shadow: 0 3px 0 rgba(20, 12, 16, 0.45);
    pointer-events: none;
    max-width: min(240px, 60vw);
    animation: gain-life 2.4s ease forwards;
  }
  .gain > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @keyframes gain-life {
    0% { opacity: 0; transform: translateY(10px) scale(0.8); }
    12% { opacity: 1; transform: translateY(0) scale(1.08); }
    20% { transform: scale(1); }
    80% { opacity: 1; }
    100% { opacity: 0; transform: translateY(-4px); }
  }

  /* ---- phone: a strip of vitals and place, a line of goal, three buttons ---- */
  .hud.slim {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 8px;
    align-items: center;
  }
  .strip,
  .goalbar {
    min-width: 0;
    pointer-events: auto;
    background: rgba(251, 241, 218, 0.92);
    box-shadow: inset 0 0 0 2px rgba(255, 249, 230, 0.8), 0 3px 0 rgba(20, 12, 16, 0.35);
    border-width: 2px;
    border-radius: 12px;
  }
  .strip {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
  }
  .goalbar {
    grid-column: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 3px 8px;
    min-height: 44px;
    box-sizing: border-box;
    padding: 4px 10px;
  }
  .slim .bars {
    flex: 1 1 0;
    min-width: 84px;
    max-width: 220px;
    margin: 0;
    gap: 3px;
    cursor: pointer;
  }
  .slim .vital {
    grid-template-columns: 12px 1fr auto;
    gap: 4px;
  }
  .slim .bar {
    height: 8px;
    border-width: 1.5px;
    border-radius: 4px;
  }
  .slim .num {
    min-width: 0;
    font-size: 11px;
  }
  .slim .num small {
    font-size: 9px;
  }
  .slim .embers {
    margin-left: 0;
    padding: 0 6px 0 4px;
    font-size: 12px;
    border-width: 1.5px;
    box-shadow: 0 1.5px 0 var(--wood-dark);
  }
  .slim .place {
    flex: 0 1 auto;
    margin-left: auto;
    font-size: 14px;
    letter-spacing: 0.04em;
  }
  .slim .from {
    display: none;
  }
  .slim .objective {
    flex: 1 1 0;
    align-self: stretch;
    align-items: center;
    min-height: 40px;
    margin: -2px 0;
    font-size: 12.5px;
  }
  .slim .objective .goal-icon {
    margin-top: 0;
  }
  .slim .home-goal {
    order: 3;
    flex: 1 1 100%;
    margin: 0;
    font-size: 11.5px;
    padding: 1px 6px;
  }
  .slim .chips {
    display: flex;
    flex: none;
    gap: 4px;
  }
  .slim .chips:empty {
    display: none;
  }
  .slim .chip {
    font-size: 11px;
    min-height: 22px;
  }
  .slim .buttons {
    grid-column: 2;
    gap: 6px;
  }
  .slim .hb {
    width: 44px;
    height: 44px;
    border-radius: 10px;
  }
  .slim .gain {
    top: calc(100% + 8px);
  }
  .slim .why {
    top: calc(100% + 6px);
  }
  /* Phone landscape: everything on one row along the top. */
  @media (orientation: landscape) {
    .hud.slim {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }
    .strip {
      grid-column: 1;
      min-height: 40px;
      box-sizing: border-box;
    }
    .slim .bars {
      flex: none;
      width: 130px;
    }
    .goalbar {
      grid-column: 2;
    }
    .slim .buttons {
      grid-column: 3;
    }
  }

  /* ---- desktop action bar ---- */
  .actionbar {
    position: absolute;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    display: flex;
    gap: 12px;
    z-index: 20;
    pointer-events: none;
    transition: opacity 250ms ease, transform 250ms ease;
  }
  /* The context buttons, first on the bar (bottom-aligned with the slots' faces). */
  .ctxbar {
    display: flex;
    align-items: flex-end;
    padding-bottom: 0;
    margin-right: 4px;
  }
  .ctxbar:empty {
    display: none;
  }
  /* The belt beside the E slot: small slots, the one in hand lit. */
  .belt {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin-right: 4px;
    padding-bottom: 22px;
    pointer-events: auto;
  }
  .bslot {
    position: relative;
    width: 36px;
    height: 36px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 2px solid var(--wood-dark);
    border-radius: 9px;
    background: linear-gradient(180deg, var(--paper-hi), var(--paper-dark));
    color: var(--wood-dark);
    opacity: 0.85;
  }
  .bslot.on {
    opacity: 1;
    background: linear-gradient(180deg, #fff3b8, #f5cf5c);
    box-shadow: 0 0 0 2px rgba(255, 210, 74, 0.6);
  }
  .bslot.worn {
    filter: grayscale(0.8);
  }
  .bslot .kbd {
    position: absolute;
    bottom: -9px;
    right: -6px;
    font-size: 10px;
    height: 16px;
    min-width: 16px;
  }
  /* What E does here, sitting on the E slot (no separate pill mid-screen). */
  .prompt {
    position: absolute;
    bottom: calc(100% + 12px);
    right: 0;
    min-width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px 6px 8px;
    font-family: var(--font-display);
    font-size: 15px;
    color: #fff6dc;
    white-space: nowrap;
    background: rgba(36, 28, 40, 0.92);
    border: 2px solid rgba(255, 210, 74, 0.7);
    border-radius: 12px;
    box-shadow: 0 4px 14px rgba(10, 6, 12, 0.4);
    animation: prompt-in 0.18s ease-out;
  }
  .prompt::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 26px;
    border: 7px solid transparent;
    border-top-color: rgba(255, 210, 74, 0.7);
  }
  .prompt .kbd {
    position: static;
  }
  @keyframes prompt-in {
    from { opacity: 0; transform: translateY(4px); }
  }
  .slot {
    position: relative;
    width: 64px;
    display: grid;
    justify-items: center;
    gap: 4px;
  }
  .face {
    position: relative;
    width: 56px;
    height: 56px;
    display: grid;
    place-items: center;
    border: 3px solid var(--wood-dark);
    border-radius: 14px;
    background: linear-gradient(180deg, var(--paper-hi), var(--paper-dark));
    color: var(--wood-dark);
    box-shadow: 0 4px 0 rgba(20, 12, 16, 0.5), inset 0 0 0 2px rgba(255, 249, 230, 0.8);
  }
  .slot.context .face {
    background: linear-gradient(180deg, #fff3b8, #f5cf5c);
  }
  .slot.sig .face,
  .slot.move .face {
    background: linear-gradient(180deg, #d6e6ff, #8fb3ec);
    color: #20365c;
  }
  .slot.roll .face {
    background: linear-gradient(180deg, #eef6e4, #b9d7a5);
    color: #2c4a22;
  }
  .slot .kbd.wide {
    right: -8px;
    font-size: 10px;
  }
  .slot.dim .face {
    filter: grayscale(0.7) brightness(0.85);
  }
  .face.shake {
    animation: deny 0.32s ease;
  }
  .slot .kbd {
    position: absolute;
    top: 42px;
    right: 0;
  }
  .label {
    font-family: var(--font-display);
    font-size: 12px;
    color: #fff3c4;
    text-shadow: 0 1px 0 var(--outline), 1px 0 0 var(--outline), -1px 0 0 var(--outline), 0 -1px 0 var(--outline);
    white-space: nowrap;
  }
  .cost {
    position: absolute;
    top: -6px;
    left: -4px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 1px 5px;
    font-family: var(--font-display);
    font-size: 11px;
    color: #fff;
    background: var(--mana);
    border: 2px solid #20365c;
    border-radius: 8px;
  }
  .sweep {
    position: absolute;
    top: 0;
    left: 4px;
    width: 56px;
    height: 56px;
    border-radius: 14px;
    background: conic-gradient(rgba(20, 14, 24, 0.55) var(--p, 100%), transparent 0);
    animation: sweep linear forwards;
    pointer-events: none;
  }

  .vignette {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 15;
    background: radial-gradient(ellipse at center, transparent 42%, rgba(150, 20, 10, 0.32) 72%, rgba(110, 8, 4, 0.72) 100%);
    box-shadow: inset 0 0 60px rgba(120, 10, 5, 0.55);
    animation: vig 1.8s ease-in-out infinite;
  }

  @property --p {
    syntax: '<percentage>';
    inherits: false;
    initial-value: 100%;
  }
  @keyframes sweep {
    from { --p: 100%; }
    to { --p: 0%; }
  }
  @keyframes lowpulse {
    0%, 100% { box-shadow: inset 0 2px 0 rgba(0, 0, 0, 0.25), 0 0 0 0 rgba(224, 86, 63, 0); }
    50% { box-shadow: inset 0 2px 0 rgba(0, 0, 0, 0.25), 0 0 0 3px rgba(224, 86, 63, 0.45); }
  }
  @keyframes beat {
    0%, 100% { transform: scale(1); }
    15% { transform: scale(1.25); }
    30% { transform: scale(1); }
  }
  @keyframes deny {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4px); }
    50% { transform: translateX(4px); }
    75% { transform: translateX(-2px); }
  }
  @keyframes vig {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 1; }
  }

  /* A narrow desktop window (no touch): the card shrinks, buttons stack. */
  @media (max-width: 560px) {
    .card {
      width: auto;
      flex: 1;
      padding: 8px 12px 10px;
    }
    .card .place {
      font-size: 15px;
    }
    .hud:not(.slim) .buttons {
      flex-direction: column;
      gap: 6px;
    }
    .hud:not(.slim) .hb {
      width: 42px;
      height: 42px;
      border-radius: 10px;
    }
  }
</style>
