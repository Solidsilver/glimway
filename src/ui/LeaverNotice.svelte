<script lang="ts">
  import type { WorldView } from '../lib/api/types'
  import { worldCopy } from '../content/world-moves'
  import NoticeCard from './NoticeCard.svelte'

  /**
   * After a sign-in, when you've left the party whose world you live in: how
   * long until you're moved out, and "Leave now" (the move screen, no
   * cooldown). Or, once the server has moved you out, what happened (shown
   * until you dismiss it). Never a modal: the world goes on around it.
   */
  let { view, onLeave, onClose }: { view: WorldView; onLeave: () => void; onClose: () => void } = $props()
  /** Seconds left, counted on this device's clock from the server's figure. */
  // svelte-ignore state_referenced_locally
  const deadline = Date.now() / 1000 + (view.leaver?.moveOutIn ?? 0)
</script>

{#if view.movedOutAt > 0}
  <NoticeCard testid="party-moved-out" icon="lantern" badge="gold" wide title={worldCopy.movedOut}>
    {#snippet actions()}
      <button type="button" class="primary" onclick={onClose}>{worldCopy.movedOutOk}</button>
    {/snippet}
  </NoticeCard>
{:else if view.leaver}
  {@const hasOwn = view.leaver.hasOwn}
  <NoticeCard testid="party-leaver" icon="world" badge="gold" wide title={worldCopy.leaver(worldCopy.within(deadline - Date.now() / 1000))}>
    {#snippet body()}
      <p>{worldCopy.leaverNote(hasOwn)}</p>
    {/snippet}
    {#snippet actions()}
      <button type="button" class="primary" onclick={onLeave}>{worldCopy.leaveNow}</button>
      <button type="button" class="ghost" onclick={onClose}>{worldCopy.later}</button>
    {/snippet}
  </NoticeCard>
{/if}
