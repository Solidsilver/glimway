<script lang="ts">
  import { companionName } from '../lib/companions'
  import { ui } from './store.svelte'

  // The Character panel's Companions page (crafts.md 2.1): who comes with you,
  // who lives at home, and the stable. Shown only to a Habitica hero.
  const current = $derived(ui.importedProfile?.selectedPet ?? null)
</script>

<h3 class="section-title">Who comes with you</h3>
<div class="row" data-testid="companions-follower">
  {#if current}
    <b>{companionName(current)}</b>
    <span class="fine">Habitica's current pet</span>
  {:else}
    <span class="fine">No pet walks with you. Choose one on Habitica and sync.</span>
  {/if}
</div>
<p class="fine">Once you've a place of your own, you can choose who comes along.</p>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.4);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
  }
</style>
