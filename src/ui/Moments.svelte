<script lang="ts">
  import { ui } from './store.svelte'
  import type { Session } from '../game/session'
  import Icon from './Icon.svelte'
  import { focusTrap } from './focus'

  let { session }: { session: Session } = $props()

  /** "Woke" card lingers briefly, then gets out of the way. */
  let wokeTimer: number | null = null
  $effect(() => {
    if (ui.defeat !== 'woke') return
    if (wokeTimer !== null) window.clearTimeout(wokeTimer)
    wokeTimer = window.setTimeout(() => (ui.defeat = 'none'), 4200)
    return () => {
      if (wokeTimer !== null) window.clearTimeout(wokeTimer)
    }
  })

  const lockedOut = $derived(ui.stats.hp <= 0 && ui.vitalsSource === 'imported')

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return `${h}h ${m % 60}m`
    return m > 0 ? `${m} min` : `${Math.max(1, Math.round(sec))} sec`
  }

  const stats = $derived(
    ui.endingOpen
      ? {
          time: formatTime(session.state.playSeconds),
          found: session.state.discoveries.length,
          calmed: session.state.defeatedEnemies.length
        }
      : null
  )
</script>

{#if ui.defeat === 'falling'}
  <div class="falling" aria-live="assertive">
    <p>You stumble…</p>
  </div>
{:else if ui.defeat === 'woke'}
  <button type="button" class="woke panel" onclick={() => (ui.defeat = 'none')} aria-live="polite">
    <span class="title">You wake by the well.</span>
    {#if lockedOut}
      <span class="body">Too battered for the road. Rest in Hearthwick — a Habitica sync will patch you up.</span>
    {:else}
      <span class="body">Pip is poking you with a stick. Everything you found is still in your pack.</span>
    {/if}
  </button>
{/if}

{#if ui.endingOpen && !ui.cinematic && stats}
  <div class="overlay ending-wrap" role="dialog" aria-modal="true" aria-labelledby="ending-title">
    <div class="panel ending" use:focusTrap>
      <div class="glow" aria-hidden="true"></div>
      <span class="eyebrow"><Icon name="lantern" size={14} /> Quest complete</span>
      <h2 id="ending-title">The Road Is Lit</h2>
      <p class="quote">“A road is a promise people keep renewing.”</p>
      <p class="sub">Hearthwick is staying out late tonight, pretending to check the fences.</p>
      <dl class="tally">
        <div><dt><Icon name="clock" size={16} /></dt><dd><b>{stats.time}</b><span>on the road</span></dd></div>
        <div><dt><Icon name="scroll" size={16} /></dt><dd><b>{stats.found}</b><span>discoveries</span></dd></div>
        <div><dt><Icon name="sparkle" size={16} /></dt><dd><b>{stats.calmed}</b><span>creatures calmed</span></dd></div>
      </dl>
      <button type="button" class="primary big" onclick={() => (ui.endingOpen = false)}>Keep exploring</button>
    </div>
  </div>
{/if}

<style>
  .falling {
    position: absolute;
    inset: 0;
    z-index: 45;
    display: grid;
    place-items: center;
    pointer-events: none;
    animation: fade-in 0.8s ease-out;
  }
  .falling p {
    font-family: var(--font-display);
    font-size: 32px;
    color: #fff6dc;
    text-shadow: 0 2px 0 var(--outline), 0 0 20px rgba(0, 0, 0, 0.8);
    animation: sink 1.1s ease-in forwards;
  }
  .woke {
    all: unset;
    position: absolute;
    left: 50%;
    /* Upper third, under the HUD: the hero who just woke stands mid-screen. */
    top: max(12%, calc(var(--hud-bottom, 0px) + 14px));
    transform: translateX(-50%);
    z-index: 36;
    width: min(420px, 90vw);
    padding: 16px 20px;
    display: grid;
    gap: 4px;
    text-align: center;
    cursor: pointer;
    background: linear-gradient(180deg, var(--paper-hi), var(--paper));
    border: 3px solid var(--wood-dark);
    border-radius: 14px;
    box-shadow: inset 0 0 0 2px rgba(255, 249, 230, 0.9), var(--shadow-drop);
    animation: rise 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  .woke .title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 600;
    color: var(--wood-dark);
  }
  .woke .body {
    font-size: 14.5px;
    color: var(--text-soft);
  }

  .ending-wrap {
    background: radial-gradient(ellipse at 50% 35%, rgba(255, 200, 90, 0.25) 0%, rgba(20, 14, 24, 0.8) 70%);
  }
  .ending {
    width: min(460px, 100%) !important;
    text-align: center;
    display: grid;
    justify-items: center;
    gap: 6px;
    overflow: hidden;
  }
  .glow {
    position: absolute;
    top: -80px;
    left: 50%;
    width: 260px;
    height: 200px;
    transform: translateX(-50%);
    background: radial-gradient(ellipse, rgba(255, 210, 74, 0.55), transparent 70%);
    pointer-events: none;
  }
  .eyebrow {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--gold-deep);
  }
  h2 {
    margin: 2px 0 4px;
    font-size: 34px;
    color: var(--wood-dark);
  }
  .quote {
    margin: 0;
    font-style: italic;
    font-size: 16px;
  }
  .sub {
    margin: 0 0 8px;
    font-size: 14px;
    color: var(--text-soft);
  }
  .tally {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    width: 100%;
    margin: 6px 0 16px;
  }
  .tally div {
    display: grid;
    justify-items: center;
    gap: 2px;
    padding: 10px 4px;
    background: rgba(255, 255, 255, 0.45);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
  }
  .tally dt {
    color: var(--gold-deep);
  }
  .tally dd {
    margin: 0;
    display: grid;
  }
  .tally b {
    font-family: var(--font-display);
    font-size: 20px;
    color: var(--wood-dark);
  }
  .tally span {
    font-size: 12px;
    color: var(--text-soft);
  }
  .big {
    font-size: 17px;
    padding: 10px 26px;
  }

  @keyframes fade-in {
    from { opacity: 0; }
  }
  @keyframes sink {
    from { transform: translateY(0); opacity: 1; }
    to { transform: translateY(14px); opacity: 0.2; }
  }
  @keyframes rise {
    from { transform: translate(-50%, 12px); opacity: 0; }
    to { transform: translate(-50%, 0); opacity: 1; }
  }
</style>
