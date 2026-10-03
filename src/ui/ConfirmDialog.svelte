<script lang="ts">
  import { focusTrap } from './focus'

  /** Styled stand-in for window.confirm — keeps hard choices in the game's voice. */
  let {
    title,
    body,
    confirmLabel,
    cancelLabel = 'Never mind',
    danger = false,
    onConfirm,
    onCancel
  }: {
    title: string
    body: string
    confirmLabel: string
    cancelLabel?: string
    danger?: boolean
    onConfirm: () => void
    onCancel: () => void
  } = $props()

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
    }
  }
</script>

<div class="overlay confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body" tabindex="-1" onkeydown={onKey}>
  <div class="panel" use:focusTrap={{ initial: '.cancel' }}>
    <h2 id="confirm-title">{title}</h2>
    <p id="confirm-body">{body}</p>
    <div class="row">
      <button type="button" class="cancel" onclick={onCancel}>{cancelLabel}</button>
      <button type="button" class={danger ? 'danger' : 'primary'} onclick={onConfirm}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .confirm {
    z-index: 60;
  }
  .confirm > .panel {
    width: min(400px, 100%);
    text-align: center;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 21px;
    color: var(--wood-dark);
  }
  p {
    margin: 0 0 18px;
    font-size: 15px;
    color: var(--text-soft);
  }
  .row {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
  }
</style>
