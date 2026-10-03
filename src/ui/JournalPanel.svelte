<script lang="ts">
  import { journalEntries } from '../content/world'
  import type { QuestStage } from '../lib/state'
  import { ui } from './store.svelte'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'

  // Mounted only while open (App owns journalOpen + the J/Escape keys). Quest
  // state comes from the shared store, which App keeps current from the
  // first snapshot on — never a local copy that starts at 'new'.
  let { onClose }: { onClose: () => void } = $props()

  const STEPS: { stage: QuestStage; label: string }[] = [
    { stage: 'new', label: 'Hear Mara out' },
    { stage: 'accepted', label: 'Find the old route marker' },
    { stage: 'clue-found', label: 'Face the stone warden' },
    { stage: 'guardian-defeated', label: 'Light the hilltop lantern' },
    { stage: 'lantern-lit', label: 'Tell Mara the road is lit' }
  ]
  const ORDER: QuestStage[] = ['new', 'accepted', 'clue-found', 'guardian-defeated', 'lantern-lit', 'complete']

  const stage = $derived(ui.quest.stage as QuestStage)
  const current = $derived(ORDER.indexOf(stage))
  // Newest first: the latest page is what the player wants to read.
  const entries = $derived([...journalEntries(stage)].reverse())
  const illustration = $derived(
    ui.area.areaId === 'ruin' ? '/assets/fingersnap/fingersnap-shrine.png' : '/assets/fingersnap/fingersnap-village.png'
  )
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="journal-title">
  <div class="panel" use:focusTrap>
    <button type="button" class="modal-close" onclick={onClose} aria-label="Close journal"><Icon name="close" size={14} /></button>
    <h2 class="panel-title" id="journal-title"><Icon name="book" size={20} /> Journal</h2>

    <div class="hero">
      <img src={illustration} alt="" />
      <div class="goal">
        <span class="eyebrow">{stage === 'complete' ? 'All done' : 'Current goal'}</span>
        <span class="text">{ui.quest.objective}</span>
      </div>
    </div>

    <h3 class="section-title">The Lantern Road</h3>
    <ol class="steps">
      {#each STEPS as step, i}
        {@const st = i < current ? 'done' : i === current ? 'now' : 'later'}
        <li class={st}>
          <span class="dot">{#if st === 'done'}<Icon name="check" size={12} />{:else}{i + 1}{/if}</span>
          <span class="lbl">{st === 'later' ? '???' : step.label}</span>
        </li>
      {/each}
    </ol>

    <h3 class="section-title">Notes</h3>
    {#each entries as entry, i (entry.title)}
      <article class:latest={i === 0}>
        <h4>{entry.title}</h4>
        <p>{entry.body}</p>
      </article>
    {/each}
  </div>
</div>

<style>
  .hero {
    position: relative;
    border: 3px solid var(--wood-dark);
    border-radius: 10px;
    overflow: hidden;
  }
  .hero img {
    display: block;
    width: 100%;
    height: 150px;
    object-fit: cover;
  }
  .goal {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 28px 14px 10px;
    display: grid;
    gap: 2px;
    background: linear-gradient(180deg, transparent, rgba(20, 12, 16, 0.85));
    color: #fff6dc;
  }
  .goal .eyebrow {
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--gold);
  }
  .goal .text {
    font-size: 15px;
    font-weight: 700;
    line-height: 1.35;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14.5px;
  }
  .dot {
    width: 24px;
    height: 24px;
    flex: none;
    display: grid;
    place-items: center;
    font-family: var(--font-display);
    font-size: 12px;
    border-radius: 50%;
    border: 2px solid var(--wood);
    color: var(--wood);
    background: var(--paper-hi);
  }
  .done .dot {
    background: var(--accent);
    border-color: #1d5552;
    color: #fff;
  }
  .done .lbl {
    color: var(--text-soft);
    text-decoration: line-through;
    text-decoration-color: rgba(110, 90, 68, 0.5);
  }
  .now .dot {
    background: var(--gold);
    border-color: var(--wood-dark);
    color: var(--wood-dark);
    box-shadow: 0 0 0 4px rgba(255, 210, 74, 0.35);
  }
  .now .lbl {
    font-weight: 800;
  }
  .later {
    opacity: 0.55;
  }
  article {
    padding: 10px 12px;
    margin-bottom: 8px;
    border-left: 3px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.3);
    border-radius: 0 8px 8px 0;
  }
  article.latest {
    border-left-color: var(--gold-deep);
    background: rgba(255, 233, 160, 0.35);
  }
  article h4 {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 16px;
    color: var(--wood-dark);
  }
  article p {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.55;
  }
</style>
