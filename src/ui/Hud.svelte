<script lang="ts">
  import { villageUi } from './village.svelte'
  import { dateLine, MARK_NOTES } from '../lib/village'
  import { ui } from './store.svelte'
  import { getCombatKit } from '../lib/combat'
  import { EMBER_COSTS } from '../lib/embers'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'
  import { offlineCopy } from '../content/connected'
  import { papers } from './papers.svelte'

  let { onJournal, onCharacter, onMenu }: { onJournal: () => void; onCharacter: () => void; onMenu: () => void } = $props()

  const touch = isTouchFirst()
  const showBars = $derived(ui.stats.maxHp > 0)
  const hpPct = $derived(Math.max(0, Math.min(100, (ui.stats.hp / ui.stats.maxHp) * 100)))
  const manaPct = $derived(Math.max(0, Math.min(100, (ui.stats.mana / ui.stats.maxMana) * 100)))
  const lowHp = $derived(ui.stats.hp > 0 && hpPct <= 30)
  const kit = $derived(getCombatKit(ui.importedProfile))
  const canAfford = $derived(ui.stats.mana >= kit.manaCost)
  const resting = $derived(ui.stats.hp <= 0 && ui.vitalsSource === 'imported')
  /** The E/Space slot follows context: talking beats swinging. */
  const actLabel = $derived(ui.prompt.label ? (ui.prompt.label.startsWith('Talk') ? 'Talk' : 'Use') : kit.basicName)
  let objectiveOpen = $state(false)
  const showEmbers = $derived(ui.stats.embers > 0 || ui.vitalsSource === 'imported')
  /** Bumps when the balance grows, to replay the little glow. */
  let emberPulse = $state(0)
  let lastEmbers = -1
  $effect(() => {
    const n = ui.stats.embers
    if (lastEmbers >= 0 && n > lastEmbers) emberPulse += 1
    lastEmbers = n
  })
</script>

<div class="hud" class:hidden={ui.cinematic} aria-hidden={ui.cinematic}>
  <div class="card panel" class:open={objectiveOpen}>
    <div class="place">
      <Icon name="lantern" size={14} />
      <span>{ui.area.name}</span>
      {#if showEmbers}
        {#key emberPulse}
          <span class="embers" class:pulse={emberPulse > 0} title="Embers — earned from your Habitica XP, spent at lanterns" aria-label={`${ui.stats.embers} embers`}>
            <Icon name="ember" size={13} />{ui.stats.embers}
          </span>
        {/key}
      {/if}
    </div>
    {#if villageUi.calendar}
      {@const c = villageUi.calendar}
      <div class="date" data-testid="calendar-line" title={MARK_NOTES[c.mark] ?? c.mark}>
        <span>{dateLine(c)} — {c.mark}</span>
        {#if c.festival}<span class="fest">{c.festival}</span>{/if}
      </div>
    {/if}
    {#if ui.link && (ui.link.status === 'offline' || ui.link.busy)}
      <div class="net" role="status" aria-live="polite">
        {#if ui.link.busy}
          <span class="pill busy" data-testid="net-pending"><span class="dots" aria-hidden="true"></span>{offlineCopy.pending}</span>
        {:else}
          {#if ui.link.trouble}
            <span class="pill off trouble" title={offlineCopy.troubleTitle} data-testid="net-trouble"><Icon name="cloud" size={12} />{offlineCopy.troubleChip}</span>
            <span class="why">{offlineCopy.troubleTitle}</span>
          {:else}
            <span class="pill off" title={offlineCopy.chipTitle} data-testid="net-offline"><Icon name="cloud" size={12} />{offlineCopy.chip}</span>
            <span class="why">{offlineCopy.chipTitle}</span>
          {/if}
        {/if}
      </div>
    {/if}
    <button
      type="button"
      class="objective"
      onclick={() => (objectiveOpen = !objectiveOpen)}
      aria-expanded={objectiveOpen}
      title="Current goal"
    >
      <span class="goal-icon"><Icon name="star" size={12} /></span>
      <span class="goal-text">{ui.quest.objective}</span>
    </button>
    {#if showBars}
      <div class="bars">
        <div class="vital" class:low={lowHp} title="Health">
          <span class="vi hp"><Icon name="heart" size={14} /></span>
          <div class="bar hp" role="meter" aria-label="Health" aria-valuemin="0" aria-valuemax={ui.stats.maxHp} aria-valuenow={ui.stats.hp}>
            <div class="fill" style={`width:${hpPct}%`}></div>
          </div>
          <span class="num">{ui.stats.hp}<small>/{ui.stats.maxHp}</small></span>
        </div>
        <div class="vital" title="Mana">
          <span class="vi mana"><Icon name="drop" size={14} /></span>
          <div class="bar mana" role="meter" aria-label="Mana" aria-valuemin="0" aria-valuemax={ui.stats.maxMana} aria-valuenow={ui.stats.mana}>
            <div class="fill" style={`width:${manaPct}%`}></div>
          </div>
          <span class="num">{ui.stats.mana}<small>/{ui.stats.maxMana}</small></span>
        </div>
      </div>
    {/if}
    {#if resting}
      <div class="resting">Resting in Hearthwick — heal on Habitica and sync, or rest by the lantern with {EMBER_COSTS.rest} embers earned on Habitica.</div>
    {/if}
  </div>

  <nav class="buttons" aria-label="Menus">
    <button type="button" class="hb" onclick={onJournal} aria-label={papers.unread.length ? `Journal (J), ${papers.unread.length} new paper${papers.unread.length === 1 ? '' : 's'}` : 'Journal (J)'} title="Journal">
      <Icon name="book" size={20} />
      {#if papers.unread.length > 0}<span class="newdot" aria-hidden="true"></span>{/if}
      {#if !touch}<span class="kbd">J</span>{/if}
    </button>
    <button type="button" class="hb" onclick={onCharacter} aria-label="Character (C)" title="Character">
      <Icon name="person" size={20} />
      {#if !touch}<span class="kbd">C</span>{/if}
    </button>
    <button type="button" class="hb" onclick={onMenu} aria-label="Menu (Esc)" title="Menu">
      <Icon name="menu" size={20} />
      {#if !touch}<span class="kbd">Esc</span>{/if}
    </button>
  </nav>
</div>

{#if !touch && showBars}
  <div class="actionbar" class:hidden={ui.cinematic || ui.dialogueOpen}>
    <div class="slot" class:context={!!ui.prompt.label}>
      <div class="face"><Icon name={ui.prompt.label ? 'sparkle' : 'sword'} size={22} /></div>
      <span class="kbd">E</span>
      <span class="label">{actLabel}</span>
    </div>
    <div class="slot sig" class:dim={!canAfford} class:denied={ui.ability.deniedAt > 0}>
      {#key ui.ability.deniedAt}
        <div class="face" class:shake={ui.ability.deniedAt > 0}><Icon name="sparkle" size={22} /></div>
      {/key}
      {#key ui.ability.readyAt}
        {#if ui.ability.readyAt > 0}
          <div class="sweep" style={`animation-duration:${ui.ability.cooldown}s`}></div>
        {/if}
      {/key}
      <span class="kbd">F</span>
      <span class="label">{kit.signatureName}</span>
      <span class="cost"><Icon name="drop" size={10} />{kit.manaCost}</span>
    </div>
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
  .date {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 6px;
    margin: 1px 0 3px 20px;
    font-size: 12px;
    font-style: italic;
    color: var(--text-soft);
  }
  .fest {
    font-style: normal;
    font-family: var(--font-display);
    font-size: 11px;
    padding: 0 6px;
    border-radius: 999px;
    color: var(--wood-dark);
    background: linear-gradient(180deg, #ffe9a6, #f2c95a);
    border: 1.5px solid var(--gold-deep);
  }
  .card {
    padding: 10px 14px 12px;
    width: min(340px, 62vw);
    pointer-events: auto;
  }
  .place {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--wood-dark);
  }
  .place :global(.icon) {
    color: var(--gold-deep);
  }
  .embers {
    margin-left: auto;
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
  }
  .place .embers :global(.icon) {
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
  .net {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 0;
    min-width: 0;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    padding: 1px 9px 1px 7px;
    font-family: var(--font-display);
    font-size: 12.5px;
    border-radius: 999px;
    border: 2px solid var(--wood-dark);
  }
  .pill.off {
    color: #1f3c66;
    background: linear-gradient(180deg, #dbe8ff, #b5cdf5);
  }
  .pill.trouble {
    color: #5a1a0e;
    background: linear-gradient(180deg, #ffe1d6, #f4b8a3);
  }
  .pill.busy {
    color: #5a2410;
    background: linear-gradient(180deg, #fff2c9, #ffd98a);
  }
  .dots {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--ember);
    animation: net-pulse 0.9s ease-in-out infinite;
  }
  .why {
    font-size: 11.5px;
    line-height: 1.25;
    color: var(--text-soft);
    min-width: 0;
  }
  @media (max-width: 560px) {
    .why {
      display: none;
    }
  }
  @keyframes net-pulse {
    0%, 100% { opacity: 0.35; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1); }
  }
  .objective {
    all: unset;
    display: flex;
    gap: 6px;
    align-items: flex-start;
    margin-top: 4px;
    font-family: var(--font-body);
    font-size: 13.5px;
    line-height: 1.35;
    color: var(--text-soft);
    cursor: pointer;
    border-radius: 6px;
  }
  .objective:hover:not(:disabled),
  .objective:active:not(:disabled) {
    background: none;
    box-shadow: none;
    transform: none;
  }
  .objective:focus-visible {
    outline: 3px solid var(--gold);
  }
  .goal-icon {
    color: var(--gold-deep);
    margin-top: 2px;
  }
  .goal-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card.open .goal-text {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .bars {
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
    height: 12px;
    background: #4a3a30;
    border: 2px solid var(--wood-dark);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: inset 0 2px 0 rgba(0, 0, 0, 0.25);
  }
  .bar .fill {
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
  .resting {
    margin-top: 8px;
    padding: 6px 8px;
    font-size: 12.5px;
    border-radius: 6px;
    background: rgba(196, 82, 58, 0.12);
    color: #7a2e1e;
  }

  .buttons {
    display: flex;
    gap: 8px;
    pointer-events: auto;
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
  .slot.sig .face {
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
    text-shadow: 0 1px 0 #2b1d1a, 1px 0 0 #2b1d1a, -1px 0 0 #2b1d1a, 0 -1px 0 #2b1d1a;
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

  @media (max-width: 560px) {
    .card {
      width: auto;
      flex: 1;
      max-width: none;
      padding: 8px 12px 10px;
    }
    .place {
      font-size: 15px;
    }
    .objective {
      font-size: 12.5px;
    }
    .goal-text {
      -webkit-line-clamp: 1;
      line-clamp: 1;
    }
    .buttons {
      flex-direction: column;
      gap: 6px;
    }
    .hb {
      width: 42px;
      height: 42px;
      border-radius: 10px;
    }
  }
</style>
