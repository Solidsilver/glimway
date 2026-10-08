<script lang="ts">
  import { updateCopy } from '../content/update'
  import { update } from './update.svelte'
  import NoticeCard from './NoticeCard.svelte'

  /**
   * A newer build is being served: reload when it suits you. Never a modal
   * and never takes focus; App.svelte holds it back while anything else
   * wants the player (a dialogue, a panel, another notice).
   */
  let { onReload }: { onReload: () => void } = $props()
</script>

<NoticeCard testid="update-notice" icon="sparkle" title={updateCopy.title}>
  {#snippet body()}
    {#if update.held}
      <p data-testid="update-held">{update.held === 'offline' ? updateCopy.offline : updateCopy.unsaved}</p>
    {:else}
      <p>{updateCopy.note}</p>
    {/if}
  {/snippet}
  {#snippet actions()}
    <button type="button" class="primary" onclick={onReload} disabled={update.reloading}>{update.reloading ? updateCopy.reloading : updateCopy.reload}</button>
    <button type="button" class="ghost" onclick={() => update.dismiss()} disabled={update.reloading}>{updateCopy.later}</button>
  {/snippet}
</NoticeCard>
