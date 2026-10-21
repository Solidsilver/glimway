<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from '../Icon.svelte'

  // One foldable section of the dev panel (DevPanel.svelte): a <details>,
  // its summary the section's title, and what it holds. The panel keeps
  // which are open (dev-prefs.ts).
  let {
    id,
    icon,
    title,
    open,
    onToggle,
    note,
    children
  }: {
    id: string
    icon: string
    title: string
    open: boolean
    onToggle: (open: boolean) => void
    /** A short word beside the title (a count), seen folded or not. */
    note?: string
    children: Snippet
  } = $props()
</script>

<details class="dev-section" {open} data-section={id} data-testid={`dev-${id}`} ontoggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
  <summary class="section-title">
    <span class="chev" aria-hidden="true"></span>
    <Icon name={icon} size={14} />
    <span class="title">{title}</span>
    {#if note}<span class="note">{note}</span>{/if}
  </summary>
  <div class="body">
    {@render children()}
  </div>
</details>

<style>
  .dev-section {
    border-bottom: 2px dashed var(--paper-line);
  }
  .dev-section:last-child {
    border-bottom: none;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 10px 2px;
    cursor: pointer;
    list-style: none;
    user-select: none;
    -webkit-user-select: none;
    border-radius: 6px;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    color: var(--wood-dark);
    background: rgba(107, 76, 46, 0.06);
  }
  .chev {
    width: 0;
    height: 0;
    margin: 0 2px;
    border-style: solid;
    border-width: 5px 0 5px 7px;
    border-color: transparent transparent transparent currentColor;
    transition: transform 120ms ease;
  }
  details[open] > summary .chev {
    transform: rotate(90deg);
  }
  .title {
    flex: 1 1 auto;
  }
  .note {
    font-family: var(--font-body);
    font-size: 12px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--text-soft);
  }
  .body {
    padding: 0 2px 12px;
  }
</style>
