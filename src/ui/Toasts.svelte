<script lang="ts">
  import { ui } from './store.svelte'
  import ArtIcon from './ArtIcon.svelte'
</script>

<div class="toasts" aria-live="polite">
  {#each ui.toasts as toast (toast.id)}
    <div class="toast {toast.kind}">
      <span class="ico"><ArtIcon art={toast.kind === 'error' ? null : toast.art} name={toast.kind === 'error' ? 'close' : (toast.icon ?? 'sparkle')} size={14} /></span>
      <span>{toast.text}</span>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: absolute;
    top: max(16px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    z-index: 35;
    pointer-events: none;
    width: min(380px, 92vw);
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 14px;
    font-size: 14px;
    line-height: 1.35;
    color: #fff6dc;
    background: rgba(36, 28, 40, 0.92);
    border: 2px solid rgba(255, 210, 74, 0.55);
    border-radius: 12px;
    box-shadow: 0 6px 18px rgba(10, 6, 12, 0.4);
    animation: pop 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.3);
  }
  .ico {
    color: var(--gold);
    margin-top: 2px;
  }
  .toast.error {
    border-color: rgba(232, 115, 79, 0.85);
  }
  .toast.error .ico {
    color: var(--ember);
  }
  @keyframes pop {
    from { transform: translateY(-8px) scale(0.96); opacity: 0; }
    to { transform: translateY(0) scale(1); opacity: 1; }
  }
  /* Narrower screens: drop below the HUD card instead of between widgets. */
  @media (max-width: 940px) {
    .toasts { top: calc(max(10px, env(safe-area-inset-top)) + 140px); }
  }
  @media (max-width: 560px) {
    .toasts { top: calc(max(10px, env(safe-area-inset-top)) + 112px); }
  }
</style>
