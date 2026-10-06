<script lang="ts">
  import { worldCopy } from '../content/world-moves'
  import Icon from './Icon.svelte'

  /**
   * Shown once when your party plays in a world that isn't yours (the server
   * remembers it was shown). Never a modal: the world goes on around it.
   */
  let { owner, members, onJoin, onLater }: { owner: string; members: number; onJoin: () => void; onLater: () => void } = $props()
</script>

<div class="notice panel" role="status" aria-live="polite" data-testid="party-prompt">
  <span class="badge" aria-hidden="true"><Icon name="world" size={20} /></span>
  <div class="body">
    <strong>{worldCopy.prompt(owner)}</strong>
    <p><span class="who"><Icon name="person" size={11} /> {worldCopy.travelers(members, owner)}</span> <span class="note">{worldCopy.promptNote}</span></p>
  </div>
  <div class="actions">
    <button type="button" class="primary" onclick={onJoin}>{worldCopy.join}</button>
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
