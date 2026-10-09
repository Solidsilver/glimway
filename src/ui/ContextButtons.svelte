<script lang="ts">
  /**
   * The context buttons row (src/game/context-buttons.ts; crafts.md 8): what
   * the game has put up for this moment, beside the desktop action bar
   * (`bar`, with key caps) or above the phone's action button (`touch`).
   */
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import type { ContextButton } from '../game/context-buttons'

  let { variant }: { variant: 'bar' | 'touch' } = $props()

  function press(e: Event, b: ContextButton): void {
    e.preventDefault()
    b.press()
  }
</script>

{#if ui.contextButtons.length}
  <div class="ctx {variant}" role="group" aria-label="For now" data-testid="context-buttons" data-inset-watch>
    {#each ui.contextButtons as b (b.id)}
      <button
        type="button"
        class="cb"
        class:big={b.size === 'big'}
        data-ctx={b.id}
        data-inset={variant === 'touch' ? 'ctx' : undefined}
        aria-label={b.ariaLabel ?? b.label}
        tabindex={variant === 'bar' ? -1 : undefined}
        onpointerdown={variant === 'touch' ? (e) => press(e, b) : undefined}
        onclick={variant === 'bar' ? (e) => press(e, b) : undefined}
        oncontextmenu={(e) => e.preventDefault()}
      >
        <span class="face">
          {#if b.art}<ArtIcon art={b.art} name={b.icon ?? 'sparkle'} size={b.size === 'big' ? 32 : 16} />{:else}<Icon name={b.icon ?? 'sparkle'} size={b.size === 'big' ? 22 : 16} />{/if}
        </span>
        {#if variant === 'bar' && b.key}<span class="kbd">{b.key}</span>{/if}
        <span class="label">{b.label}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .ctx {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    pointer-events: none;
  }
  .cb {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 3px;
    padding: 0;
    border: 0;
    background: none;
    pointer-events: auto;
    touch-action: none;
    color: var(--wood-dark);
  }
  .face {
    display: grid;
    place-items: center;
    border: 2.5px solid var(--wood-dark);
    background: linear-gradient(180deg, #fff6dd, #e8d4a4);
    box-shadow: 0 3px 0 rgba(20, 12, 16, 0.45);
  }
  .label {
    font-family: var(--font-display);
    font-size: 11px;
    color: #fff3c4;
    text-shadow: 0 1px 0 var(--outline), 1px 0 0 var(--outline), -1px 0 0 var(--outline), 0 -1px 0 var(--outline);
    white-space: nowrap;
  }
  /* Desktop: small rounded slots before the belt, with their key. */
  .bar .face {
    width: 40px;
    height: 40px;
    border-radius: 10px;
  }
  .bar .big .face {
    width: 56px;
    height: 56px;
    border-radius: 14px;
  }
  .bar .kbd {
    position: absolute;
    top: 28px;
    right: -6px;
    font-size: 10px;
    height: 16px;
    min-width: 16px;
  }
  .bar .big .kbd {
    top: 42px;
  }
  /* Phones: round, thumb-sized (44 px at least). */
  .touch .face {
    width: 44px;
    height: 44px;
    border-radius: 50%;
  }
  .touch .big .face {
    width: 64px;
    height: 64px;
  }
  .touch .label {
    font-size: 11px;
  }
</style>
