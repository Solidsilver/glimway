<script lang="ts">
  /**
   * One line: the purse's gold (purse-and-wardrobe.md 2.1). Lane E places it
   * in the Character panel's Hero page, under Embers; the Inventory's Purse
   * row and the Menu's purse card draw the same coin. `onOpen` adds a link
   * to the Menu's purse card (where Top up and the log are).
   */
  import { ui } from './store.svelte'
  import { goldPhrase, purseCopy } from '../content/purse'
  import ArtIcon from './ArtIcon.svelte'

  let { onOpen }: { onOpen?: () => void } = $props()

  const gold = $derived(ui.purse?.gold ?? ui.stats.gold ?? 0)
</script>

<p class="purse-line" data-testid="purse-line">
  <span class="coin"><ArtIcon art="purse-gold" name="coin" size={16} /></span>
  <span class="amount" aria-label={purseCopy.balanceLabel(gold)}>{goldPhrase(gold)}</span>
  {#if onOpen}<button type="button" class="linky" onclick={onOpen} data-testid="purse-line-open">{purseCopy.openPurse}&nbsp;›</button>{/if}
</p>

<style>
  .purse-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 14px;
  }
  .coin {
    display: inline-grid;
    place-items: center;
    color: var(--gold-deep);
  }
  .amount {
    font-family: var(--font-display);
    color: var(--wood-dark);
  }
  .linky {
    margin-left: auto;
    min-height: 32px;
    padding: 2px 8px;
    border: none;
    background: none;
    box-shadow: none;
    color: var(--wood);
    text-decoration: underline;
    font-size: 13px;
  }
  :global(:root.touch) .linky {
    min-height: 44px;
  }
</style>
