<script lang="ts">
  import type { LoadView } from '../lib/loading'
  import { loadingCopy, loadingLines } from '../content/loading'

  /**
   * Entering the world, on the title screen's own backdrop (App.svelte puts
   * this where the title's buttons go): one line for the stage, a bar on the
   * stages that count, a gentle word when it's slow, and Retry or the title
   * when it's stuck. Reduced motion stills the spark and the bar (app.css).
   */
  let { view, onRetry, onBack }: { view: LoadView; onRetry: () => void; onBack: () => void } = $props()
</script>

<div class="loading" role="status" aria-label={loadingCopy.label} data-testid="loading-screen" data-stage={view.stage}>
  <p class="line" aria-live="polite"><span class="spark" aria-hidden="true"></span> {loadingLines[view.stage]}</p>
  <div class="bar" class:idle={view.progress === null} aria-hidden="true">
    <span style:width={`${Math.round((view.progress ?? 0) * 100)}%`}></span>
  </div>
  {#if view.stuck}
    <p class="note" role="alert" data-testid="loading-stuck">{view.failed ? loadingCopy.failed : loadingCopy.stuck}</p>
    <div class="buttons">
      <button type="button" class="primary" onclick={onRetry} data-testid="loading-retry">{loadingCopy.retry}</button>
      <button type="button" class="secondary small" onclick={onBack} data-testid="loading-back">{loadingCopy.back}</button>
    </div>
  {:else if view.slow}
    <p class="note" data-testid="loading-slow">{loadingCopy.slow}</p>
    <button type="button" class="secondary small" onclick={onBack} data-testid="loading-back">{loadingCopy.back}</button>
  {/if}
</div>

<style>
  .loading {
    width: min(360px, 100%);
    display: grid;
    justify-items: center;
    gap: 12px;
  }
  .line {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display);
    font-size: 18px;
    color: var(--paper);
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
  }
  .spark {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--gold);
    box-shadow: 0 0 12px 4px rgba(255, 210, 74, 0.6);
    animation: flicker 1.4s ease-in-out infinite;
  }
  /* A lantern-wick bar in the HUD's frame colours: square ends, a hard edge. */
  .bar {
    width: min(240px, 80%);
    height: 10px;
    padding: 2px;
    box-sizing: border-box;
    background: rgba(20, 14, 30, 0.7);
    border: 2px solid var(--outline);
    box-shadow: 0 0 0 2px rgba(255, 210, 74, 0.35);
    image-rendering: pixelated;
  }
  .bar span {
    display: block;
    height: 100%;
    background: linear-gradient(180deg, #ffe48a, var(--gold));
    transition: width 0.25s linear;
  }
  /* A stage with nothing to count keeps the bar where it was, dimmed. */
  .bar.idle {
    opacity: 0.45;
  }
  .note {
    margin: 0;
    max-width: 320px;
    font-size: 15px;
    line-height: 1.35;
    color: var(--paper);
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
  }
  .buttons {
    display: grid;
    gap: 10px;
    justify-items: center;
  }
  /* The title's quiet button (App.svelte .secondary.small). */
  .secondary {
    padding: 5px 14px;
    font-size: 14px;
    background: rgba(36, 28, 40, 0.75);
    color: var(--paper);
    border-color: rgba(244, 228, 193, 0.6);
    box-shadow: 0 3px 0 rgba(0, 0, 0, 0.5);
  }
  .secondary:hover:not(:disabled) {
    background: rgba(56, 44, 60, 0.85);
  }
  @keyframes flicker {
    0%, 100% { opacity: 1; }
    45% { opacity: 0.75; }
    60% { opacity: 1; }
  }
</style>
