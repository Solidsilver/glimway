<script lang="ts">
  import { onMount } from 'svelte'
  import type { WorldRef } from '../lib/api/types'
  import { worldCopy } from '../content/world-moves'
  import { api } from './account'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'

  /**
   * Shown once when your party has a world and you live elsewhere. The server
   * remembers it was shown only once it has really been on screen (this
   * mounting). Never a modal: the world goes on around it.
   */
  let { world, onJoin, onLater }: { world: WorldRef; onJoin: () => void; onLater: () => void } = $props()
  const touch = isTouchFirst()

  onMount(() => {
    void api.worldPrompt(world.id).catch(() => undefined)
  })
</script>

<div class="notice panel" class:touch role="status" aria-live="polite" data-testid="party-prompt">
  <span class="badge" aria-hidden="true"><Icon name="world" size={20} /></span>
  <div class="body">
    <strong>{worldCopy.prompt(world.members)}</strong>
    <p><span class="who"><Icon name="person" size={11} /> {worldCopy.travelers(world.members, world.ownerName, world.ownerHere)}</span> <span class="note">{worldCopy.promptNote}</span></p>
  </div>
  <div class="actions">
    <button type="button" class="primary" onclick={onJoin}>{worldCopy.join(world.members)}</button>
    <button type="button" class="ghost" onclick={onLater}>{worldCopy.later}</button>
  </div>
</div>

<style>
  .notice {
    position: absolute;
    left: 50%;
    /* Low on the screen: clear of the HUD, the area title and the side
       buttons, and above the touch controls. */
    bottom: calc(env(safe-area-inset-bottom) + 112px);
    transform: translateX(-50%);
    width: min(560px, calc(100% - 24px));
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    z-index: 30;
    border-color: var(--gold-deep);
    animation: notice-in 0.3s ease-out;
  }
  /* Touch: above the joystick, the action buttons and the "Talk" prompt. */
  .notice.touch {
    /* App.svelte measures the buttons and the prompt tag on them (--dock-bottom). */
    bottom: max(calc(env(safe-area-inset-bottom) + 228px), calc(var(--dock-bottom, 0px) + 8px));
  }
  .badge {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    border: 2px solid var(--wood-dark);
    background: linear-gradient(180deg, #fff3c2 0%, var(--gold) 100%);
    color: var(--wood-dark);
    box-shadow: 0 0 0 3px rgba(255, 210, 74, 0.3);
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
  .note {
    color: var(--text-faint);
  }
  .who {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 4px;
    font-weight: 700;
    color: var(--wood);
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
  @keyframes notice-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }
</style>
