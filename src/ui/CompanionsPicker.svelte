<script lang="ts">
  /**
   * The companion picker (crafts.md 2.1, 8): every pet (or mount) you own on
   * Habitica, grouped by species, with a search field and a row of species
   * chips. It takes the Companions page's place, full height; on phones the chips
   * scroll sideways and the grid is three or four across. `first` is the
   * option above the grid (Habitica's current pet, or Leave empty).
   */
  import { companionName, groupBySpecies, matchesSearch } from '../lib/companions'
  import CompanionArt from './CompanionArt.svelte'
  import Icon from './Icon.svelte'

  let {
    title,
    kind,
    keys,
    selected,
    first = null,
    onPick,
    onClose
  }: {
    title: string
    kind: 'pet' | 'mount'
    keys: readonly string[]
    /** The key chosen now ('' for the first option). */
    selected: string
    first?: { label: string; hint?: string } | null
    onPick: (key: string) => void
    onClose: () => void
  } = $props()

  let query = $state('')
  let species = $state<string | null>(null)
  const groups = $derived(groupBySpecies(keys))
  const shown = $derived(
    groups
      .filter((g) => species === null || g.species === species)
      .map((g) => ({ ...g, keys: g.keys.filter((k) => matchesSearch(k, query)) }))
      .filter((g) => g.keys.length > 0)
  )

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="picker" role="dialog" aria-label={title} tabindex="-1" onkeydown={onKey} data-testid="companions-picker">
  <header>
    <button type="button" class="back" onclick={onClose} aria-label="Back to Companions"><Icon name="close" size={14} /></button>
    <h3>{title}</h3>
  </header>
  <input type="search" placeholder={kind === 'pet' ? 'Search your pets' : 'Search your mounts'} bind:value={query} aria-label="Search" />
  {#if groups.length > 1}
    <div class="chips" role="group" aria-label="Species">
      <button type="button" class:on={species === null} aria-pressed={species === null} onclick={() => (species = null)}>All</button>
      {#each groups as g (g.species)}
        <button type="button" class:on={species === g.species} aria-pressed={species === g.species} onclick={() => (species = species === g.species ? null : g.species)}>{g.species}</button>
      {/each}
    </div>
  {/if}
  <div class="scroll">
    {#if first}
      <button type="button" class="first" class:on={selected === ''} onclick={() => onPick('')} data-testid="companions-pick-first">
        <span class="fl">{first.label}</span>
        {#if first.hint}<small>{first.hint}</small>{/if}
      </button>
    {/if}
    {#if keys.length === 0}
      <p class="empty">{kind === 'pet' ? 'No pets on your Habitica account yet. Hatch one there and sync.' : 'No mounts on your Habitica account yet. Raise a pet there and sync.'}</p>
    {:else if shown.length === 0}
      <p class="empty">Nothing by that name.</p>
    {/if}
    {#each shown as g (g.species)}
      <h4>{g.species}</h4>
      <ul class="grid">
        {#each g.keys as key (key)}
          <li>
            <button type="button" class:on={selected === key} onclick={() => onPick(key)} aria-pressed={selected === key} data-testid={`companions-pick-${key}`}>
              <CompanionArt {key} {kind} size={48} />
              <span>{companionName(key)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/each}
  </div>
</div>

<style>
  /* Takes the Companions page's place while open: full height of the sheet. */
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: min(70vh, 560px);
    max-height: 75vh;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-family: var(--font-display);
    color: var(--wood-dark);
  }
  .back {
    min-width: 44px;
    min-height: 44px;
    display: grid;
    place-items: center;
  }
  input {
    min-height: 44px;
    padding: 0 10px;
    border: 2px solid var(--paper-line);
    border-radius: 10px;
    font: inherit;
  }
  .chips {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: thin;
  }
  .chips button {
    flex: none;
    min-height: 36px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.5);
    box-shadow: none;
    font-size: 13px;
    white-space: nowrap;
  }
  .chips button.on {
    background: #fff1c2;
    border-color: var(--gold-deep);
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  h4 {
    margin: 10px 0 4px;
    font-size: 13px;
    color: var(--text-soft);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .first {
    width: 100%;
    min-height: 44px;
    display: grid;
    justify-items: start;
    padding: 8px 12px;
    text-align: left;
  }
  .first small {
    color: var(--text-soft);
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    gap: 6px;
  }
  .grid button {
    width: 100%;
    min-height: 44px;
    display: grid;
    justify-items: center;
    gap: 2px;
    padding: 6px 4px;
    font-size: 12px;
    line-height: 1.2;
  }
  button.on {
    outline: 3px solid var(--gold-deep);
    outline-offset: -3px;
    background: #fff1c2;
  }
  .empty {
    font-style: italic;
    color: var(--text-faint);
  }
  :global(:root.touch) .grid {
    grid-template-columns: repeat(3, 1fr);
  }
</style>
