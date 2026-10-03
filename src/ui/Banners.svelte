<script lang="ts">
  import { ui } from './store.svelte'
  import { sfx } from '../game/sfx'
  import Icon from './Icon.svelte'

  /**
   * One banner at a time: quest beats get a ribbon with a chime, area
   * changes get a big storybook title card. Banners wait while a cinematic
   * owns the screen so they land after the moment, not on top of it.
   */
  const current = $derived(!ui.cinematic && ui.defeat === 'none' ? ui.banners[0] ?? null : null)
  let timer: number | null = null
  let shownId: string | null = null

  $effect(() => {
    const b = current
    if (!b) {
      // Hidden by a cinematic/defeat: stop the clock so it re-shows in full.
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      shownId = null
      ui.shownBannerId = null
      return
    }
    if (b.id === shownId) return
    shownId = b.id
    ui.shownBannerId = b.id
    sfx(b.kind === 'quest' ? 'quest' : 'step-area')
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => dismiss(b.id), b.kind === 'quest' ? 4200 : 2600)
  })

  function dismiss(id: string): void {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    if (ui.shownBannerId === id) ui.shownBannerId = null
    ui.dismissBanner(id)
  }
</script>

{#if current}
  {#key current.id}
    {#if current.kind === 'quest'}
      <button type="button" class="quest" onclick={() => dismiss(current.id)} aria-live="polite">
        <span class="eyebrow"><Icon name="star" size={12} /> {current.eyebrow} <Icon name="star" size={12} /></span>
        <span class="title">{current.title}</span>
        {#if current.body}<span class="body">{current.body}</span>{/if}
      </button>
    {:else}
      <div class="area" aria-live="polite">
        <span class="rule"></span>
        <span class="eyebrow">{current.eyebrow}</span>
        <span class="title">{current.title}</span>
        {#if current.body}<span class="body">{current.body}</span>{/if}
        <span class="rule"></span>
      </div>
    {/if}
  {/key}
{/if}

<style>
  .quest {
    all: unset;
    position: absolute;
    top: 22%;
    left: 50%;
    transform: translateX(-50%);
    z-index: 36;
    width: min(520px, 90vw);
    padding: 16px 28px 18px;
    display: grid;
    justify-items: center;
    gap: 4px;
    text-align: center;
    cursor: pointer;
    color: #3d2410;
    background:
      radial-gradient(120% 120% at 50% 0%, #fff6c8 0%, rgba(255, 246, 200, 0) 70%),
      linear-gradient(180deg, #ffe58a 0%, #f2b93a 100%);
    border: 3px solid #5a3410;
    border-radius: 14px;
    box-shadow:
      inset 0 0 0 2px rgba(255, 250, 220, 0.85),
      0 6px 0 rgba(40, 20, 8, 0.5),
      0 0 60px rgba(255, 210, 74, 0.55);
    animation: ribbon-in 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.25), ribbon-out 0.4s ease-in 3.8s forwards;
  }
  .quest:focus-visible {
    outline: 3px solid #fff;
  }
  .quest .eyebrow {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #7a4a10;
  }
  .quest .title {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 28px;
    line-height: 1.1;
  }
  .quest .body {
    font-size: 14.5px;
    color: #5a3a14;
    max-width: 40ch;
  }

  .area {
    position: absolute;
    top: 30%;
    left: 50%;
    transform: translateX(-50%);
    z-index: 34;
    width: min(820px, 94vw);
    display: grid;
    justify-items: center;
    gap: 6px;
    text-align: center;
    pointer-events: none;
    padding: 26px 24px;
    color: #fff6dc;
    text-shadow: 0 2px 0 rgba(20, 12, 16, 0.85), 0 0 24px rgba(20, 12, 16, 0.8);
    background: radial-gradient(ellipse at center, rgba(20, 14, 24, 0.62) 0%, rgba(20, 14, 24, 0.35) 45%, transparent 72%);
    animation: area-in 0.6s ease-out, area-out 0.5s ease-in 2.1s forwards;
  }
  .area .eyebrow {
    font-family: var(--font-display);
    font-size: 14px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: var(--gold);
  }
  .area .title {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: clamp(34px, 7vw, 56px);
    line-height: 1;
    letter-spacing: 0.04em;
  }
  .area .body {
    font-size: 15px;
    max-width: 44ch;
    font-style: italic;
    opacity: 0.92;
  }
  .rule {
    width: 120px;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--gold), transparent);
  }

  @keyframes ribbon-in {
    from { transform: translate(-50%, -20px) scale(0.85); opacity: 0; }
    to { transform: translate(-50%, 0) scale(1); opacity: 1; }
  }
  @keyframes ribbon-out {
    to { transform: translate(-50%, -12px); opacity: 0; }
  }
  @keyframes area-in {
    from { opacity: 0; transform: translate(-50%, 10px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  @keyframes area-out {
    to { opacity: 0; }
  }
</style>
