<script lang="ts">
  import { offlineCopy } from '../content/connected'
  import Icon from './Icon.svelte'

  /** Shown once after an offline reconnect merged into newer server progress. */
  let { onDismiss }: { onDismiss: () => void } = $props()
</script>

<div class="notice panel" role="status" aria-live="polite" data-testid="link-notice">
  <span class="badge" aria-hidden="true"><Icon name="cloud" size={18} /></span>
  <div class="body">
    <strong>{offlineCopy.noticeTitle}</strong>
    <p>{offlineCopy.notice}</p>
  </div>
  <button type="button" class="primary" onclick={onDismiss}>{offlineCopy.dismiss}</button>
</div>

<style>
  .notice {
    position: absolute;
    left: 50%;
    /* Below the HUD card, clear of it at every size. */
    top: max(182px, calc(env(safe-area-inset-top) + 182px));
    transform: translateX(-50%);
    width: min(520px, calc(100% - 24px));
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    z-index: 30;
    animation: notice-in 0.25s ease-out;
  }
  .badge {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: 2px solid var(--wood-dark);
    background: rgba(79, 134, 214, 0.18);
    color: var(--mana);
  }
  strong {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 16px;
    color: var(--wood-dark);
  }
  p {
    margin: 2px 0 0;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--text-soft);
  }
  @media (max-width: 560px) {
    .notice {
      grid-template-columns: auto 1fr;
    }
    .notice button {
      grid-column: 1 / -1;
    }
  }
  @keyframes notice-in {
    from { opacity: 0; transform: translate(-50%, -8px); }
  }
</style>
