<script lang="ts">
  import { journalEntries, QUEST_STEPS } from '../content/world'
  import type { QuestStage } from '../lib/state'
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'
  import Panel from './Panel.svelte'
  import PapersTab from './PapersTab.svelte'
  import GuidesTab from './GuidesTab.svelte'
  import type { Session } from '../game/session'
  import { papers } from './papers.svelte'
  import { home } from './home.svelte'

  // Mounted only while open (App owns journalOpen + the J/Escape keys). Quest
  // state comes from the shared store, which App keeps current from the
  // first snapshot on — never a local copy that starts at 'new'.
  let { onClose, session, initialTab = 'road' }: { onClose: () => void; session: Session; initialTab?: 'road' | 'papers' | 'guides' } = $props()

  // Three pages: the quest, the found texts ("Papers"), and "How do I…?".
  type Tab = 'road' | 'papers' | 'guides'
  const TABS: { id: Tab; label: string }[] = [
    { id: 'road', label: 'Lantern Road' },
    { id: 'papers', label: 'Papers' },
    { id: 'guides', label: 'How do I…?' }
  ]
  // Opens on the page asked for; the tabs take over from there.
  let tab = $state<Tab>('road')
  $effect.pre(() => {
    tab = initialTab
  })

  function onTabKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const i = TABS.findIndex((t) => t.id === tab)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
    tab = TABS[next].id
    document.getElementById(`journal-tab-${tab}`)?.focus()
  }

  const STEPS = QUEST_STEPS
  const ORDER: QuestStage[] = ['new', 'accepted', 'clue-found', 'guardian-defeated', 'lantern-lit', 'complete']

  const stage = $derived(ui.quest.stage as QuestStage)
  const current = $derived(ORDER.indexOf(stage))
  // Newest first: the latest page is what the player wants to read.
  const entries = $derived([...journalEntries(stage, ui.residentsMet)].reverse())
  const illustration = $derived(
    ui.area.areaId === 'ruin' ? '/assets/fingersnap/packed/fingersnap-shrine.webp' : '/assets/fingersnap/packed/fingersnap-village.webp'
  )
</script>

<Panel id="journal" icon="book" title="Journal" closeLabel="Close journal" {onClose}>
  {#snippet head()}
    <div class="tabs" role="tablist" aria-label="Journal pages">
      {#each TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          id={`journal-tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls={`journal-page-${t.id}`}
          tabindex={tab === t.id ? 0 : -1}
          class:active={tab === t.id}
          onclick={() => (tab = t.id)}
          onkeydown={onTabKey}
        >
          {t.label}
          {#if t.id === 'papers' && papers.unread.length > 0}<span class="newdot" aria-hidden="true"></span><span class="sr">, {papers.unread.length} new</span>{/if}
        </button>
      {/each}
    </div>
  {/snippet}

  {#if tab === 'papers'}
    <div role="tabpanel" id="journal-page-papers" aria-labelledby="journal-tab-papers">
      <PapersTab />
    </div>
  {:else if tab === 'guides'}
    <div role="tabpanel" id="journal-page-guides" aria-labelledby="journal-tab-guides">
      <GuidesTab {session} />
    </div>
  {:else}
  <div role="tabpanel" id="journal-page-road" aria-labelledby="journal-tab-road">
  <div class="hero">
    <img src={illustration} alt="" />
    <div class="goal">
      <span class="eyebrow">{stage === 'complete' ? 'All done' : 'Current goal'}</span>
      <span class="text">{ui.quest.objective}</span>
    </div>
  </div>
  {#if home.goal}
    <div class="home-goal" data-testid="journal-home-goal">
      <span class="eyebrow"><Icon name="home" size={12} /> Your homestead</span>
      <span class="text">{home.goal}</span>
    </div>
  {/if}

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
  {#each entries as entry, i (entry.title + '\n' + entry.body)}
    <article class:latest={i === 0}>
      <h4>{entry.title}</h4>
      <p>{entry.body}</p>
    </article>
  {/each}
  </div>
  {/if}
</Panel>

<style>
  .home-goal {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: -4px 0 12px;
    padding: 8px 10px;
    border: 2px dashed var(--paper-line);
    border-radius: 8px;
    background: #fff8e4;
  }
  .home-goal .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.75;
  }
  /* A segmented chip under the title (src/app.css .panel-head). */
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tabs button {
    position: relative;
    flex: 1;
    min-height: 40px;
    padding: 6px 10px;
    border-radius: 9px;
    border: 2px solid transparent;
    box-shadow: none;
    background: transparent;
    color: var(--text-soft);
  }
  .tabs button.active {
    background: #fff1c2;
    border-color: var(--gold-deep);
    color: var(--wood-dark);
  }
  :global(:root.touch) .tabs button {
    min-height: 36px;
    padding: 4px 6px;
    font-size: 13px;
    white-space: nowrap;
  }
  .tabs button:hover:not(:disabled) {
    transform: none;
    box-shadow: none;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .newdot {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--ember);
    border: 1.5px solid var(--wood-dark);
  }
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
    box-shadow: 0 0 0 4px var(--gold-glow);
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
