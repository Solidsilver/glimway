<script lang="ts">
  import { ui } from './store.svelte'
</script>

<div class="toasts" aria-live="polite">
  {#each ui.toasts as toast (toast.id)}
    <div class="toast panel {toast.kind}">{toast.text}</div>
  {/each}
</div>

<style>
  .toasts {
    position: absolute;
    top: max(64px, calc(env(safe-area-inset-top) + 56px));
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    z-index: 35;
    pointer-events: none;
    width: min(420px, 92vw);
  }
  .toast {
    padding: 8px 12px;
    font-size: 12px;
    text-align: center;
    animation: pop 0.18s ease-out;
  }
  .toast.error {
    background: #f3d0c4;
    border-color: var(--danger);
    color: #6e2a1a;
  }
  @keyframes pop {
    from { transform: translateY(-6px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
</style>
