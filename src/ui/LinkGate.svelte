<script lang="ts">
  import { leaseCopy } from '../content/connected'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'

  /**
   * Connected play can't continue here right now:
   * - `elsewhere`: another device holds the play lease. Take over is always
   *   the player's choice, never automatic.
   * - `signed-out`: the session cookie ended.
   */
  let {
    kind,
    busy = false,
    error = '',
    onTakeOver,
    onBack,
    backLabel = leaseCopy.back
  }: {
    kind: 'elsewhere' | 'signed-out'
    busy?: boolean
    error?: string
    onTakeOver?: () => void
    onBack: () => void
    backLabel?: string
  } = $props()
</script>

<div class="overlay gate" role="alertdialog" aria-modal="true" aria-labelledby="lease-title" aria-describedby="lease-body" aria-busy={busy}>
  <div class="panel gate-panel lease" use:focusTrap={{ initial: '.primary' }}>
    <div class="scene" aria-hidden="true">
      <span class="lamp here"><Icon name="lantern" size={22} /></span>
      <span class="path"></span>
      <span class="lamp there" class:out={kind === 'signed-out'}><Icon name={kind === 'signed-out' ? 'key' : 'lantern'} size={22} /></span>
    </div>
    {#if kind === 'elsewhere'}
      <h2 class="gate-title" id="lease-title">{leaseCopy.title}</h2>
      <p class="gate-lead" id="lease-body">{leaseCopy.body}</p>
      <p class="note">{leaseCopy.note}</p>
      {#if error}<p class="gate-error" role="alert">{error}</p>{/if}
      <div class="gate-actions">
        <button type="button" class="ghost" onclick={onBack} disabled={busy}>{backLabel}</button>
        <button type="button" class="primary" onclick={onTakeOver} disabled={busy}>
          {busy ? leaseCopy.working : leaseCopy.takeOver}
        </button>
      </div>
    {:else}
      <h2 class="gate-title" id="lease-title">{leaseCopy.signedOutTitle}</h2>
      <p class="gate-lead" id="lease-body">{leaseCopy.signedOutBody}</p>
      <div class="gate-actions">
        <button type="button" class="primary" onclick={onBack}>{leaseCopy.toTitle}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .lease {
    text-align: center;
  }
  .scene {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin: 4px auto 2px;
  }
  .lamp {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 3px solid var(--wood-dark);
    background: var(--ink-soft);
    color: rgba(244, 228, 193, 0.45);
  }
  .lamp.there {
    color: var(--gold);
    background: var(--ink);
    box-shadow: 0 0 18px rgba(255, 210, 74, 0.55);
  }
  .lamp.there.out {
    color: var(--paper-dark);
    box-shadow: none;
  }
  .path {
    width: 70px;
    height: 4px;
    background: repeating-linear-gradient(90deg, var(--wood) 0 6px, transparent 6px 11px);
  }
  .note {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--text-faint);
  }
  .gate-actions {
    justify-content: center;
  }
</style>
