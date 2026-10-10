<script lang="ts">
  /**
   * The full-height picker both the Companions and the Wardrobe pages open
   * (crafts.md 2.1, 8; purse-and-wardrobe.md 4.1, 8): a search field, a row
   * of chips (one per group, shown when there's more than one), the options
   * above the grid (`first`, then `also`), and a grid of owned keys under
   * their group headings. It takes the page's place while open; on phones the
   * chips scroll sideways and the grid is three across. The page decides what
   * a pick does (close, or stay open) and how a tile is drawn.
   */
  import { onMount, type Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  interface PickerGroup {
    id: string
    label: string
    keys: readonly string[]
  }

  let {
    title,
    backLabel,
    searchPlaceholder,
    chipsLabel,
    groups,
    matches,
    nameOf,
    selected,
    first = null,
    also = [],
    emptyText,
    testid,
    pickPrefix,
    tile,
    aside,
    above,
    onPick,
    onClose
  }: {
    title: string
    backLabel: string
    searchPlaceholder: string
    /** What the chips are (the group's aria label): "Species", "Class". */
    chipsLabel: string
    groups: readonly PickerGroup[]
    matches: (key: string, query: string) => boolean
    nameOf: (key: string) => string
    /** The key chosen now ('' for the first option). */
    selected: string
    first?: { label: string; hint?: string } | null
    also?: readonly { key: string; label: string; hint?: string }[]
    /** Said when there's nothing at all to pick from. */
    emptyText: string
    testid: string
    /** Each option's test id is `${pickPrefix}-${key}`, the first option's `${pickPrefix}-first`. */
    pickPrefix: string
    tile: Snippet<[string]>
    /** Beside the title (the Wardrobe's small preview). */
    aside?: Snippet
    /** Between the options and the grid (the Wardrobe's Wear the whole set). */
    above?: Snippet
    onPick: (key: string) => void
    onClose: () => void
  } = $props()

  let query = $state('')
  let searchEl = $state<HTMLInputElement | null>(null)
  // Focus comes into the picker as it opens (the page that opened it gives it back on close).
  onMount(() => searchEl?.focus())
  let group = $state<string | null>(null)
  const anything = $derived(groups.some((g) => g.keys.length > 0))
  const shown = $derived(
    groups
      .filter((g) => group === null || g.id === group)
      .map((g) => ({ ...g, keys: g.keys.filter((k) => matches(k, query)) }))
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
<div class="picker" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onkeydown={onKey} data-testid={testid}>
  <header>
    <button type="button" class="back" onclick={onClose} aria-label={backLabel}><Icon name="close" size={14} /></button>
    <h3>{title}</h3>
    {#if aside}<div class="aside">{@render aside()}</div>{/if}
  </header>
  <input type="search" bind:this={searchEl} placeholder={searchPlaceholder} bind:value={query} aria-label="Search" />
  {#if groups.length > 1}
    <div class="chips" role="group" aria-label={chipsLabel}>
      <button type="button" class:on={group === null} aria-pressed={group === null} onclick={() => (group = null)}>All</button>
      {#each groups as g (g.id)}
        <button type="button" class:on={group === g.id} aria-pressed={group === g.id} onclick={() => (group = group === g.id ? null : g.id)}>{g.label}</button>
      {/each}
    </div>
  {/if}
  <div class="scroll">
    {#if first}
      <button type="button" class="first" class:on={selected === ''} onclick={() => onPick('')} data-testid={`${pickPrefix}-first`}>
        <span class="fl">{first.label}</span>
        {#if first.hint}<small>{first.hint}</small>{/if}
      </button>
    {/if}
    {#each also as o (o.key)}
      <button type="button" class="first" class:on={selected === o.key} onclick={() => onPick(o.key)} data-testid={`${pickPrefix}-${o.key}`}>
        <span class="fl">{o.label}</span>
        {#if o.hint}<small>{o.hint}</small>{/if}
      </button>
    {/each}
    {#if above}{@render above()}{/if}
    {#if !anything}
      <p class="empty">{emptyText}</p>
    {:else if shown.length === 0}
      <p class="empty">Nothing by that name.</p>
    {/if}
    {#each shown as g (g.id)}
      <h4>{g.label}</h4>
      <ul class="grid">
        {#each g.keys as key (key)}
          <li>
            <button type="button" class:on={selected === key} onclick={() => onPick(key)} aria-pressed={selected === key} data-testid={`${pickPrefix}-${key}`}>
              {@render tile(key)}
              <span>{nameOf(key)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/each}
  </div>
</div>

<style>
  /* Takes the page's place while open: full height of the sheet. */
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
  .aside {
    margin-left: auto;
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
    min-height: 44px;
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
