<script lang="ts">
  /**
   * A delivered 16-px icon from the Commons pass (`icon-timber`, …), drawn
   * crisp at a whole multiple of its native size; the code-drawn Icon when
   * that art isn't loaded (or there is none for this thing), or nothing
   * when no fallback is named.
   */
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'

  let { art, name, size = 16 }: { art?: string | null; name?: string; size?: number } = $props()

  const src = $derived(art ? (ui.artIcons[art] ?? null) : null)
  // 16-px art only scales cleanly by whole steps: 14→16, 20→16, 26→32.
  const px = $derived(Math.max(1, Math.round(size / 16)) * 16)
</script>

{#if src}
  <img class="art-icon" {src} alt="" width={px} height={px} data-art={art} />
{:else if name}
  <Icon {name} {size} />
{/if}

<style>
  .art-icon {
    display: inline-block;
    vertical-align: middle;
    flex: none;
    image-rendering: pixelated;
  }
</style>
