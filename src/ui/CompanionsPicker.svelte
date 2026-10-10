<script lang="ts">
  /**
   * The companion picker (crafts.md 2.1, 8): every pet (or mount) you own on
   * Habitica, grouped by species, with a search field and a row of species
   * chips, on the shared picker (./GridPicker.svelte, which the Wardrobe uses
   * too). `first` is the option above the grid (Habitica's current pet, or
   * Leave empty).
   */
  import { companionName, groupBySpecies, matchesSearch } from '../lib/companions'
  import CompanionArt from './CompanionArt.svelte'
  import GridPicker from './GridPicker.svelte'

  let {
    title,
    kind,
    keys,
    selected,
    first = null,
    also = [],
    onPick,
    onClose
  }: {
    title: string
    kind: 'pet' | 'mount'
    keys: readonly string[]
    /** The key chosen now ('' for the first option). */
    selected: string
    first?: { label: string; hint?: string } | null
    also?: readonly { key: string; label: string; hint?: string }[]
    onPick: (key: string) => void
    onClose: () => void
  } = $props()

  const groups = $derived(groupBySpecies(keys).map((g) => ({ id: g.species, label: g.species, keys: g.keys })))
</script>

<GridPicker
  {title}
  backLabel="Back to Companions"
  searchPlaceholder={kind === 'pet' ? 'Search your pets' : 'Search your mounts'}
  chipsLabel="Species"
  {groups}
  matches={matchesSearch}
  nameOf={companionName}
  {selected}
  {first}
  {also}
  emptyText={kind === 'pet' ? 'No pets on your Habitica account yet. Hatch one there and sync.' : 'No mounts on your Habitica account yet. Raise a pet there and sync.'}
  testid="companions-picker"
  pickPrefix="companions-pick"
  {onPick}
  {onClose}
>
  {#snippet tile(key)}
    <CompanionArt {key} {kind} size={48} />
  {/snippet}
</GridPicker>
