<script lang="ts">
  import { updateCopy } from '../content/update'
  import { update } from './update.svelte'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'

  /**
   * A newer build is being served: reload when it suits you. Never a modal
   * and never takes focus; App.svelte holds it back while anything else
   * wants the player (a dialogue, a panel, another notice).
   */
  let { onReload }: { onReload: () => void } = $props()
  const touch = isTouchFirst()
</script>

<div class="notice panel" class:touch role="status" aria-live="polite" data-testid="update-notice">
  <span class="badge" aria-hidden="true"><Icon name="sparkle" size={20} /></span>
  <div class="body">
    <strong>{updateCopy.title}</strong>
    {#if update.held}
      <p data-testid="update-held">{update.held === 'offline' ? updateCopy.offline : updateCopy.unsaved}</p>
    {:else}
      <p>{updateCopy.note}</p>
    {/if}
  </div>
  <div class="actions">
    <button type="button" class="primary" onclick={onReload} disabled={update.reloading}>{update.reloading ? updateCopy.reloading : updateCopy.reload}</button>
    <button type="button" class="ghost" onclick={() => update.dismiss()} disabled={update.reloading}>{updateCopy.later}</button>
  </div>
</div>

<style>
  .notice {
    position: absolute;
    left: 50%;
    /* The party prompt's place (low, clear of the HUD and the area title);
       App.svelte shows one of them at a time. */
    bottom: calc(env(safe-area-inset-bottom) + 112px);
    transform: translateX(-50%);
    width: min(520px, calc(100% - 24px));
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    z-index: 30;
    animation: notice-in 0.3s ease-out;
  }
  /* Touch: above the joystick, the action buttons and the "Talk" prompt. */
  .notice.touch {
    bottom: max(calc(env(safe-area-inset-bottom) + 228px), calc(var(--dock-bottom, 0px) + 8px));
  }
  .badge {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: 2px solid var(--wood-dark);
    background: rgba(255, 210, 74, 0.22);
    color: var(--wood-dark);
  }
  strong {
    display: block;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 16px;
    line-height: 1.25;
    color: var(--wood-dark);
  }
  p {
    margin: 3px 0 0;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-soft);
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .actions button {
    white-space: nowrap;
  }
  .ghost {
    padding: 4px 10px;
    font-size: 13px;
  }
  @media (max-width: 560px) {
    .notice {
      grid-template-columns: auto 1fr;
    }
    .actions {
      grid-column: 1 / -1;
      flex-direction: row;
    }
    .actions button {
      flex: 1;
    }
  }
  /* Short landscape phones (568×320): the thumbs leave no room low down, so
     it sits under the HUD, compact, and never past the screen or its safe areas. */
  @media (orientation: landscape) and (max-height: 500px) {
    .notice.touch {
      --top: max(var(--hud-bottom, 64px), env(safe-area-inset-top));
      top: calc(var(--top) + 6px);
      bottom: auto;
      width: min(520px, calc(100% - 24px - env(safe-area-inset-left) - env(safe-area-inset-right)));
      max-height: calc(100% - var(--top) - 12px - env(safe-area-inset-bottom));
      overflow-y: auto;
      grid-template-columns: 1fr auto;
      gap: 10px;
      padding: 8px 12px;
    }
    .notice.touch .badge {
      display: none;
    }
    .notice.touch strong {
      font-size: 15px;
    }
    .notice.touch p {
      font-size: 12.5px;
      line-height: 1.35;
    }
  }
  @keyframes notice-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }
</style>
