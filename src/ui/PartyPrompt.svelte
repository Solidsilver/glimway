<script lang="ts">
  import { onMount } from 'svelte'
  import type { WorldRef } from '../lib/api/types'
  import { worldCopy } from '../content/world-moves'
  import { api } from './account'
  import Icon from './Icon.svelte'
  import NoticeCard from './NoticeCard.svelte'

  /**
   * Shown once when your party has a world and you live elsewhere. The server
   * remembers it was shown only once it has really been on screen (this
   * mounting). Never a modal: the world goes on around it.
   */
  let { world, onJoin, onLater }: { world: WorldRef; onJoin: () => void; onLater: () => void } = $props()

  onMount(() => {
    void api.worldPrompt(world.id).catch(() => undefined)
  })
</script>

<NoticeCard testid="party-prompt" icon="world" badge="gold" wide title={worldCopy.prompt(world.members)}>
  {#snippet body()}
    <p><span class="who"><Icon name="person" size={11} /> {worldCopy.travelers(world.members, world.ownerName, world.ownerHere)}</span> <span class="note">{worldCopy.promptNote}</span></p>
  {/snippet}
  {#snippet actions()}
    <button type="button" class="primary" onclick={onJoin}>{worldCopy.join(world.members)}</button>
    <button type="button" class="ghost" onclick={onLater}>{worldCopy.later}</button>
  {/snippet}
</NoticeCard>

<style>
  .note {
    color: var(--text-faint);
  }
  .who {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 4px;
    font-weight: 700;
    color: var(--wood);
  }
</style>
