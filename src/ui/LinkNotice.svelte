<script lang="ts">
  import { offlineCopy } from '../content/connected'
  import NoticeCard from './NoticeCard.svelte'

  /** Shown once after an offline reconnect merged into newer server progress. */
  let { onDismiss }: { onDismiss: () => void } = $props()
</script>

<NoticeCard testid="link-notice" icon="cloud" iconSize={18} badge="mana" place="top" title={offlineCopy.noticeTitle}>
  {#snippet body()}
    <p>{offlineCopy.notice}</p>
  {/snippet}
  {#snippet actions()}
    <button type="button" class="primary" onclick={onDismiss}>{offlineCopy.dismiss}</button>
  {/snippet}
</NoticeCard>
