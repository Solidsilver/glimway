<script lang="ts">
  import { bus, EV, type QuestPayload } from '../game/events'
  import { journalEntries } from '../content/world'
  import type { QuestStage } from '../lib/state'
  import { ui } from './store.svelte'

  // Mounted only while open (App owns journalOpen + the J/Escape keys, exactly
  // like CharacterPanel) — no local key listeners, so App's flag,
  // uiState.panelOpen and this overlay can never disagree.
  let { onClose }: { onClose: () => void } = $props()

  let quest = $state<QuestPayload>({ stage: 'new', objective: '' })

  $effect(() => {
    const onQuest = (p: QuestPayload) => {
      quest = p
    }
    bus.on(EV.quest, onQuest)
    return () => bus.off(EV.quest, onQuest)
  })

  const entries = $derived(journalEntries(quest.stage as QuestStage))
  const illustration = $derived(
    ui.area.areaId === 'village'
      ? '/assets/fingersnap/fingersnap-village.png'
      : ui.area.areaId === 'ruin'
        ? '/assets/fingersnap/fingersnap-shrine.png'
        : null
  )
</script>

<div class="overlay" role="dialog" aria-label="Journal">
    <div class="panel" style="position:relative">
      <button type="button" class="modal-close" onclick={onClose} aria-label="Close journal">×</button>
      <h2 class="panel-title">Journal</h2>
      {#if illustration}
        <img class="illus" src={illustration} alt="Illustration of the area" />
      {/if}
      <p class="objective">Current goal: {quest.objective}</p>
      {#each entries as entry}
        <article>
          <h3>{entry.title}</h3>
          <p>{entry.body}</p>
        </article>
      {/each}
    </div>
  </div>

<style>
  .illus {
    width: 100%;
    height: 110px;
    object-fit: cover;
    border: 2px solid var(--wood-dark);
    border-radius: 6px;
    image-rendering: auto;
    margin-bottom: 8px;
  }
  .objective {
    font-size: 13px;
    color: var(--accent);
    font-weight: 700;
  }
  article h3 {
    margin: 10px 0 4px;
    font-size: 13px;
    color: var(--wood-dark);
  }
  article p {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
  }
</style>
