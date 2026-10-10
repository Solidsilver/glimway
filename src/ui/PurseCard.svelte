<script lang="ts">
  /**
   * The glims block in the Menu's Habitica card (silas-yard.md 1.6): what
   * glims are, **Turn gold into glims** and the **Glim log**. The balance
   * is the HUD's one counter, so it isn't repeated here. Turn gold into
   * glims syncs first (the sync's safe places and messages, through `sync`),
   * then opens the consent card (./PurseConsent.svelte). Guests have the log
   * but no top-up (purse-and-wardrobe.md 5).
   */
  import type { Session } from '../game/session'
  import { ui } from './store.svelte'
  import { purseCopy } from '../content/purse'
  import { offlineCopy } from '../content/connected'
  import { isConnected } from './habitica-local'
  import { purseUi, type SyncForTopUp } from './purse.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import Icon from './Icon.svelte'

  let { session, sync }: { session: Session; sync: () => Promise<SyncForTopUp> } = $props()

  /** Null until a world says: no top-up before then. */
  const purse = $derived(ui.purse)
  const habitica = $derived(ui.vitalsSource === 'imported')
  const offline = $derived(ui.link?.status !== 'online')
  const canTopUp = $derived(!!purse && purse.topUpsLeft > 0 && purse.glimsLeft > 0)
  /** A top-up from another tab, or one this tab lost track of. */
  const workingElsewhere = $derived(!!ui.purse?.working && !purseUi.busy)

  function topUp(): void {
    if (!isConnected()) {
      purseUi.error = purseCopy.connectFirst
      return
    }
    void purseUi.start(sync, () => ui.purse)
  }
</script>

<div class="purse" data-testid="purse-card">
  <h4 class="purse-title"><ArtIcon art="glim" name="glim" size={16} /> {purseCopy.title}</h4>
  <p class="fine">{habitica ? purseCopy.blurb : purseCopy.guest}</p>
  {#if habitica}
    <div class="row">
      <button
        type="button"
        class="primary top-up"
        disabled={purseUi.busy || offline || !canTopUp || workingElsewhere}
        title={offline ? offlineCopy.needs : undefined}
        onclick={topUp}
        data-testid="purse-top-up"
      >{purseUi.phase === 'syncing' ? purseCopy.topUpBusy : purseCopy.topUp}</button>
      <button type="button" class="ghost log" onclick={() => purseUi.openLog(session)} data-testid="purse-log-open">{purseCopy.log}&nbsp;›</button>
    </div>
    {#if purse}<p class="tiny" data-testid="top-ups-left">{canTopUp ? purseCopy.glimsLeft(purse.glimsLeft, purse.topUpsLeft) : purseCopy.noTopUpsLeft}</p>{/if}
  {:else}
    <div class="row">
      <button type="button" class="ghost log" onclick={() => purseUi.openLog(session)} data-testid="purse-log-open">{purseCopy.log}&nbsp;›</button>
    </div>
  {/if}
  {#if offline && habitica}<p class="tiny">{purseCopy.offline}</p>{/if}
  {#if purseUi.phase === 'moving' || purseUi.phase === 'checking'}
    <p class="status" role="status">{purseUi.phase === 'moving' ? purseCopy.getting : purseCopy.checking}</p>
  {:else if workingElsewhere}
    <p class="status" role="status">{purseCopy.working}</p>
  {/if}
  {#if purseUi.error && !purseUi.sheet}<p class="error" role="alert">{purseUi.error}</p>{/if}
  {#if purseUi.outcome && !purseUi.sheet}
    <p class="outcome" class:ok={purseUi.outcome.ok} role="status" data-testid="purse-outcome"><Icon name={purseUi.outcome.ok ? 'check' : 'glim'} size={12} /> {purseUi.outcome.text}</p>
  {/if}
</div>

<style>
  .purse {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 2px dashed var(--paper-line);
  }
  .purse-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 4px;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-soft);
  }
  .fine {
    margin: 0 0 10px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .top-up {
    min-height: 44px;
  }
  .log {
    min-height: 44px;
    text-decoration: underline;
    color: var(--wood);
  }
  .tiny {
    margin: 4px 0;
    font-size: 12px;
    color: var(--text-faint);
  }
  .status {
    margin: 8px 0 0;
    font-size: 14px;
    color: var(--wood);
  }
  .error {
    margin: 8px 0 0;
    color: var(--danger);
    font-size: 14px;
  }
  .outcome {
    margin: 8px 0 0;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 14px;
    line-height: 1.4;
    background: rgba(224, 122, 82, 0.12);
    border: 1.5px solid rgba(192, 96, 62, 0.4);
  }
  .outcome.ok {
    background: rgba(160, 210, 120, 0.2);
    border-color: #7aa25a;
  }
  @media (max-width: 560px) {
    .top-up {
      flex: 1 1 100%;
    }
  }
</style>
