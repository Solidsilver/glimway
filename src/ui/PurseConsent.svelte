<script lang="ts">
  /**
   * The consent card (purse-and-wardrobe.md 2.1, step 2): shown on every
   * top-up, nothing pre-filled and nothing remembered. The amount starts
   * empty; **All** only fills it; the main button names the number and is
   * the one thing to confirm. **Not now** is the same size beside it.
   * While the gold moves the card stays calm: one line, no spinner.
   */
  import type { Session } from '../game/session'
  import { purseCopy } from '../content/purse'
  import { TOP_UPS_PER_DAY } from '../lib/purse'
  import { ui } from './store.svelte'
  import { purseUi } from './purse.svelte'
  import Panel from './Panel.svelte'
  import PurseAmount from './PurseAmount.svelte'

  let { session }: { session: Session } = $props()

  const n = $derived(purseUi.parsed)
  const left = $derived(ui.purse?.topUpsLeft ?? TOP_UPS_PER_DAY)
  const working = $derived(purseUi.phase === 'moving' || purseUi.phase === 'checking')
  const typed = $derived(purseUi.amount.trim() !== '')
</script>

<Panel id="purse-consent" icon="coin" title={purseCopy.consentTitle} closeLabel={purseCopy.closeConsent} onClose={() => purseUi.closeSheet()} class="purse-consent">
  <div class="body" data-testid="purse-consent" data-dirty={typed ? 'true' : undefined}>
    <p class="have" data-testid="consent-habitica-gold">{purseCopy.youHave(purseUi.habiticaGold)}</p>

    {#if purseUi.habiticaGold < 1}
      <p class="fine">{purseCopy.nothingThere}</p>
    {:else}
      <PurseAmount bind:value={purseUi.amount} max={purseUi.habiticaGold} disabled={working} testid="consent-amount" autofocus />
      {#if typed && n === null && !working}<p class="hint">{purseCopy.amountHint(purseUi.habiticaGold)}</p>{/if}
    {/if}

    <p class="terms">{purseCopy.spends}</p>
    <p class="terms">{purseCopy.how}</p>
    <p class="left">{purseCopy.topUpsLeft(left, TOP_UPS_PER_DAY)}</p>

    {#if working}
      <p class="status" role="status" data-testid="consent-status">{purseUi.phase === 'moving' ? purseCopy.moving : purseCopy.checking}</p>
      <p class="tiny">{purseCopy.closeNote}</p>
    {:else if purseUi.outcome && purseUi.phase === 'idle'}
      <p class="outcome" class:ok={purseUi.outcome.ok} role="status" data-testid="consent-outcome">{purseUi.outcome.text}</p>
    {/if}
    {#if purseUi.error}<p class="error" role="alert" data-testid="consent-error">{purseUi.error}</p>{/if}

    <div class="buttons">
      {#if purseUi.phase === 'consent'}
        <button type="button" onclick={() => purseUi.cancel()} data-testid="consent-not-now">{purseCopy.notNow}</button>
        <button type="button" class="primary" disabled={n === null} onclick={() => purseUi.confirm(session)} data-testid="consent-move">{purseCopy.move(n)}</button>
      {:else}
        <button type="button" onclick={() => purseUi.closeSheet()} data-testid="consent-close">{purseCopy.closeConsent}</button>
        <button type="button" class="primary" disabled>{working ? purseCopy.moving : purseCopy.move(null)}</button>
      {/if}
    </div>
  </div>
</Panel>

<style>
  :global(.overlay > .panel.purse-consent) {
    width: min(480px, 100%);
  }
  :global(:root.touch .overlay > .panel.purse-consent) {
    max-height: 100%;
  }
  .body {
    display: grid;
    gap: 10px;
    margin-top: 8px;
  }
  .have {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    color: var(--wood-dark);
  }
  .fine,
  .hint,
  .terms,
  .left,
  .tiny {
    margin: 0;
    line-height: 1.45;
  }
  .terms {
    font-size: 14px;
    color: var(--text-soft);
  }
  .hint,
  .tiny {
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .left {
    font-size: 13.5px;
  }
  .status {
    margin: 0;
    font-size: 15px;
    color: var(--wood);
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 14px;
  }
  .outcome {
    margin: 0;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 14px;
    background: rgba(224, 122, 82, 0.12);
    border: 1.5px solid rgba(192, 96, 62, 0.4);
  }
  .outcome.ok {
    background: rgba(160, 210, 120, 0.2);
    border-color: #7aa25a;
  }
  .buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 4px;
  }
  .buttons button {
    min-height: 48px;
  }
</style>
