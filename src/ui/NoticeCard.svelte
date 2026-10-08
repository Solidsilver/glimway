<script lang="ts">
  import type { Snippet } from 'svelte'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'

  /**
   * A notice over play: a badge, a title, a line or two, and its buttons.
   * Never a modal and never takes focus: the world goes on around it.
   * App.svelte shows one at a time, and only on a clear screen
   * (src/ui/layers.ts BLOCKS.notices).
   *
   * - `place`: low on the screen (clear of the HUD and the area title, above
   *   the touch controls), or high, under the HUD card.
   * - `badge`: gold for an invitation, a soft gold for news, blue for the
   *   connection.
   */
  let {
    testid,
    icon,
    iconSize = 20,
    title,
    badge = 'soft',
    place = 'low',
    wide = false,
    body,
    actions
  }: {
    testid: string
    icon: string
    iconSize?: number
    title: string
    badge?: 'gold' | 'soft' | 'mana'
    place?: 'low' | 'top'
    wide?: boolean
    body?: Snippet
    actions: Snippet
  } = $props()
  const touch = isTouchFirst()
</script>

<div class="notice panel {place}" class:touch class:wide class:invite={badge === 'gold'} role="status" aria-live="polite" data-testid={testid}>
  <span class="badge {badge}" aria-hidden="true"><Icon name={icon} size={iconSize} /></span>
  <div class="body">
    <strong>{title}</strong>
    {@render body?.()}
  </div>
  <div class="actions">{@render actions()}</div>
</div>

<style>
  .notice {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: min(520px, calc(100% - 24px));
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    z-index: 30;
  }
  .notice.wide {
    width: min(560px, calc(100% - 24px));
  }
  .notice.invite {
    border-color: var(--gold-deep);
  }
  .low {
    /* Low on the screen: clear of the HUD, the area title and the side
       buttons, and above the touch controls. */
    bottom: calc(env(safe-area-inset-bottom) + 112px);
    animation: notice-up 0.3s ease-out;
  }
  /* Touch: above the joystick, the action buttons and the "Talk" prompt. */
  .low.touch {
    /* App.svelte measures the buttons and the prompt tag on them (--dock-bottom). */
    bottom: max(calc(env(safe-area-inset-bottom) + 228px), calc(var(--dock-bottom, 0px) + 8px));
  }
  .top {
    /* Below the HUD card, clear of it at every size. */
    top: max(182px, calc(env(safe-area-inset-top) + 182px));
    animation: notice-down 0.25s ease-out;
  }
  .badge {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: 2px solid var(--wood-dark);
    color: var(--wood-dark);
  }
  .badge.soft {
    background: rgba(255, 210, 74, 0.22);
  }
  .badge.gold {
    width: 38px;
    height: 38px;
    background: linear-gradient(180deg, var(--cream) 0%, var(--gold) 100%);
    box-shadow: 0 0 0 3px rgba(255, 210, 74, 0.3);
  }
  .badge.mana {
    background: rgba(79, 134, 214, 0.18);
    color: var(--mana);
  }
  strong {
    display: block;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 16px;
    line-height: 1.25;
    color: var(--wood-dark);
  }
  .body :global(p) {
    margin: 3px 0 0;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-soft);
  }
  .top .body :global(p) {
    margin-top: 2px;
    font-size: 13.5px;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .actions :global(button) {
    white-space: nowrap;
  }
  .actions :global(button.ghost) {
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
    .actions :global(button) {
      flex: 1;
    }
  }
  /* Short landscape phones (568×320): the thumbs leave no room low down, so
     it sits under the HUD, compact, and never past the screen or its safe areas. */
  @media (orientation: landscape) and (max-height: 500px) {
    .low.touch {
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
    .low.touch .badge {
      display: none;
    }
    .low.touch strong {
      font-size: 15px;
    }
    .low.touch .body :global(p) {
      font-size: 12.5px;
      line-height: 1.35;
    }
  }
  @keyframes notice-up {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }
  @keyframes notice-down {
    from {
      opacity: 0;
      transform: translate(-50%, -8px);
    }
  }
</style>
