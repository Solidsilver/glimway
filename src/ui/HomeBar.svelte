<script lang="ts">
  import { bus } from '../game/events'
  import { HOME_EV, type PlacementCommand } from '../game/homestead'
  import { isTouchFirst } from './device'
  import { home } from './home.svelte'
  import Icon from './Icon.svelte'

  // Your place: the "Arrange" button while you stand on your land or in your
  // cottage, and the tray for placement mode (pick a piece, nudge it, turn
  // it, set it down or put it away; outdoors, tap a tree, stump or boulder in
  // your light and Silas clears it). Keyboard: arrows/WASD, R, E, X, Esc.
  let { hidden = false }: { hidden?: boolean } = $props()

  const touch = isTouchFirst()
  const send = (c: PlacementCommand) => bus.emit(HOME_EV.command, c)
  const p = $derived(home.placement)
  const selected = $derived(p?.items.find((i) => i.id === p.selected) ?? null)
  const here = $derived(p ? p.items.filter((i) => i.fits) : [])
  const elsewhere = $derived(p ? p.items.filter((i) => !i.fits) : [])
  const stateOf = (i: { placed: boolean; elsewhere: boolean }) => (i.placed ? 'Set out' : i.elsewhere ? (p?.scene === 'indoor' ? 'Outdoors' : 'Indoors') : 'In your pack')
  const needsCottage = $derived(!!p && p.scene === 'indoor' && p.tier < 1)

  // Touch: the Arrange button sits just above the action buttons (bottom
  // right, in the thumb's reach), never over the HUD. Measured, since the
  // touch controls size themselves; the fallback clears the usual cluster.
  let dockBottom = $state(190)
  const showArrange = $derived(!p && home.arrange.available && !hidden)
  function measureDock(): void {
    const actions = document.querySelector('.controls .actions')
    if (!actions) return
    const top = Math.min(...[...actions.querySelectorAll('button')].map((b) => b.getBoundingClientRect().top).filter((t) => t > 0))
    if (Number.isFinite(top)) dockBottom = Math.round(window.innerHeight - top + 10)
  }
  $effect(() => {
    if (!touch || !showArrange) return
    const raf = requestAnimationFrame(measureDock)
    window.addEventListener('resize', measureDock)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measureDock)
    }
  })
</script>

{#if p && !hidden}
  <div class="tray panel" role="region" aria-label="Arranging your place" data-testid="placement-tray">
    <div class="head">
      <h2><Icon name="home" size={16} /> {p.scene === 'indoor' ? 'Arranging your cottage' : 'Arranging your land'}</h2>
      <button type="button" class="done" onclick={() => send({ kind: 'exit' })}>Done{#if !touch}<span class="kbd">Esc</span>{/if}</button>
    </div>

    {#if needsCottage}
      <p class="note">Silas needs to raise your cottage before anything gets set out. Talk to him in his yard.</p>
    {/if}
    {#if p.items.length === 0}
      <p class="note">Nothing to arrange yet. Silas has a few pieces finished in his yard.</p>
    {:else}
      <ul class="pieces" aria-label="Your pieces">
        {#each [...here, ...elsewhere] as it (it.id)}
          <li>
            <button
              type="button"
              class="piece"
              class:on={it.id === p.selected}
              class:off={!it.fits}
              aria-pressed={it.id === p.selected}
              disabled={!it.fits || p.busy}
              data-piece={it.itemDef}
              onclick={() => send({ kind: 'select', itemId: it.id })}
              title={it.itemDef === 'gate-shelf' ? 'By your gate' : it.fits ? it.name : `${it.name} belongs ${p.scene === 'indoor' ? 'outdoors' : 'indoors'}`}
            >
              <span class="art">{#if home.thumbs[it.itemDef]}<img src={home.thumbs[it.itemDef]} alt="" />{/if}</span>
              <span class="nm">{it.name}</span>
              <span class="st">{it.itemDef === 'gate-shelf' ? 'By your gate' : it.fits ? stateOf(it) : p.scene === 'indoor' ? 'Outdoors only' : 'Indoors only'}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <p class="status" class:bad={!!p.problem || p.message?.kind === 'error'} role="status" aria-live="polite">
      {#if p.busy}
        Setting it down…
      {:else if p.message && !selected}
        {p.message.text}
      {:else if selected && p.problem}
        {p.problem}
      {:else if p.message}
        {p.message.text}
      {:else if selected}
        {touch ? 'Tap a spot on the grid, or nudge it.' : 'Arrows to move, R to turn, E to set it down.'}
      {:else if p.clearing}
        A {p.clearing.what} in your light. Silas can clear it for {p.clearing.cost} ember{p.clearing.cost === 1 ? '' : 's'}.
      {:else if p.scene === 'outdoor'}
        {touch ? 'Pick a piece, tap one that’s set out to move it, or tap a tree or rock in your light to clear it.' : 'Pick a piece, click one that’s set out to move it, or click a tree or rock in your light to clear it.'}
      {:else}
        {touch ? 'Pick a piece, or tap one that’s set out to move it.' : 'Pick a piece, or click one that’s set out to move it.'}
      {/if}
    </p>

    {#if p.clearing && !selected}
      <div class="controls">
        <button type="button" class="primary" disabled={p.busy} data-testid="clear-tile" onclick={() => send({ kind: 'clear' })}>Have Silas clear it · {p.clearing.cost} ember{p.clearing.cost === 1 ? '' : 's'}</button>
        <button type="button" class="ghost" onclick={() => send({ kind: 'cancel' })}>Leave it</button>
      </div>
    {/if}

    {#if selected}
      <div class="controls">
        <div class="pad" aria-label="Nudge">
          <button type="button" aria-label="Nudge left" onclick={() => send({ kind: 'nudge', dx: -1, dy: 0 })}>◀</button>
          <button type="button" aria-label="Nudge up" onclick={() => send({ kind: 'nudge', dx: 0, dy: -1 })}>▲</button>
          <button type="button" aria-label="Nudge down" onclick={() => send({ kind: 'nudge', dx: 0, dy: 1 })}>▼</button>
          <button type="button" aria-label="Nudge right" onclick={() => send({ kind: 'nudge', dx: 1, dy: 0 })}>▶</button>
        </div>
        <button type="button" disabled={!p.canRotate || p.busy} onclick={() => send({ kind: 'rotate' })} title={p.canRotate ? 'Turn it' : 'Square pieces look the same every way round'}>
          ↻ Turn{#if !touch}<span class="kbd">R</span>{/if}
        </button>
        {#if selected.placed}
          <button type="button" disabled={p.busy} onclick={() => send({ kind: 'remove' })}>Put away{#if !touch}<span class="kbd">X</span>{/if}</button>
        {/if}
        <button type="button" class="primary" disabled={p.busy || !!p.problem} onclick={() => send({ kind: 'confirm' })}>
          {selected.placed ? 'Move here' : 'Set it here'}{#if !touch}<span class="kbd">E</span>{/if}
        </button>
        <button type="button" class="ghost" onclick={() => send({ kind: 'cancel' })}>Cancel</button>
      </div>
    {/if}
  </div>
{:else if showArrange}
  <button type="button" class="arrange" class:touch style={touch ? `bottom:${dockBottom}px` : undefined} onclick={() => bus.emit('game:home-arrange')} data-testid="arrange">
    <Icon name="home" size={16} /> Arrange{#if !touch}<span class="kbd">B</span>{/if}
  </button>
{/if}

<svelte:window
  onkeydown={(e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (e.code === 'KeyB' && !home.placement && home.arrange.available && !hidden) bus.emit('game:home-arrange')
  }}
/>

<style>
  .arrange {
    position: absolute;
    left: 16px;
    bottom: 18px;
    z-index: 30;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    box-shadow: var(--shadow-drop);
  }
  .arrange.touch {
    left: auto;
    right: max(14px, env(safe-area-inset-right));
    min-height: 44px;
  }
  .kbd {
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
    border: 1.5px solid currentColor;
    opacity: 0.7;
  }
  .tray {
    position: absolute;
    display: flex;
    flex-direction: column;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    z-index: 40;
    width: min(640px, calc(100vw - 24px));
    max-height: 46vh;
    overflow: auto;
    padding: 10px 12px 12px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  .head h2 {
    margin: 0;
    font-size: 16px;
    display: inline-flex;
    gap: 6px;
    align-items: center;
    color: var(--wood-dark);
  }
  .done {
    padding: 4px 12px;
  }
  .note {
    margin: 8px 0 0;
    font-size: 13.5px;
    color: var(--ember-deep);
  }
  .pieces {
    flex: none;
    list-style: none;
    margin: 8px 0 0;
    padding: 2px 2px 4px;
    display: flex;
    gap: 6px;
    overflow-x: auto;
  }
  .piece {
    width: 84px;
    min-height: 82px;
    display: grid;
    justify-items: center;
    gap: 2px;
    padding: 5px 4px;
    font-family: var(--font-body);
    font-size: 12px;
    letter-spacing: 0;
    line-height: 1.15;
  }
  .piece.on {
    border-color: var(--gold-deep);
    background: #fff1c2;
    box-shadow: 0 0 0 2px var(--gold);
  }
  .piece.off {
    opacity: 0.55;
  }
  .art {
    height: 36px;
    display: grid;
    place-items: center;
  }
  .art img {
    image-rendering: pixelated;
    max-height: 36px;
    max-width: 60px;
  }
  .nm {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .st {
    color: var(--text-soft);
    font-size: 11px;
  }
  .status {
    margin: 8px 0 0;
    font-size: 13.5px;
    min-height: 1.4em;
    color: var(--text-soft);
  }
  .status.bad {
    color: var(--danger);
    font-weight: 700;
  }
  .controls {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .controls > button {
    padding: 6px 10px;
    font-size: 14px;
  }
  .pad {
    display: grid;
    grid-template-columns: repeat(4, 34px);
    gap: 3px;
  }
  .pad button {
    padding: 4px 0;
    min-height: 34px;
    font-size: 13px;
  }
  .tray > * {
    flex: none;
  }

  /* Touch: buttons a thumb can hit. */
  :global(:root.touch) .tray .pad {
    grid-template-columns: repeat(4, 44px);
  }
  :global(:root.touch) .tray .pad button,
  :global(:root.touch) .tray .controls > button {
    min-height: 44px;
  }

  /*
   * Phone landscape: the tray is a strip down the right side, so the land
   * stays in view and every button stays on screen (the pieces scroll).
   */
  @media (orientation: landscape) {
    :global(:root.touch) .tray {
      left: auto;
      right: max(8px, env(safe-area-inset-right));
      top: max(8px, env(safe-area-inset-top));
      bottom: max(8px, env(safe-area-inset-bottom));
      transform: none;
      width: min(330px, 42vw);
      max-height: none;
      overflow: hidden;
    }
    :global(:root.touch) .tray .pieces {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      flex-wrap: wrap;
      align-content: flex-start;
    }
    :global(:root.touch) .tray .piece {
      width: 76px;
      min-height: 74px;
    }
    :global(:root.touch) .tray .status {
      font-size: 13px;
    }
  }
</style>
