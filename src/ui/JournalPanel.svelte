<script lang="ts">
  import Panel from './Panel.svelte'
  import PapersTab from './PapersTab.svelte'
  import GuidesTab from './GuidesTab.svelte'
  import QuestsTab from './QuestsTab.svelte'
  import type { Session } from '../game/session'
  import { papers } from './papers.svelte'

  // Mounted only while open (App owns journalOpen + the J/Escape keys).
  // `focus`: a quest to put at the top of the Quests page (the opening's note).
  let { onClose, session, initialTab = 'quests', focus = null }: { onClose: () => void; session: Session; initialTab?: 'quests' | 'papers' | 'guides'; focus?: string | null } = $props()

  // Three pages: the quests, the found texts ("Papers"), and "How do I…?".
  type Tab = 'quests' | 'papers' | 'guides'
  const TABS: { id: Tab; label: string }[] = [
    { id: 'quests', label: 'Quests' },
    { id: 'papers', label: 'Papers' },
    { id: 'guides', label: 'How do I…?' }
  ]
  // Opens on the page asked for; the tabs take over from there.
  let tab = $state<Tab>('quests')
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
    <div role="tabpanel" id="journal-page-quests" aria-labelledby="journal-tab-quests">
      <QuestsTab {session} {focus} />
    </div>
  {/if}
</Panel>

<style>
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
</style>
