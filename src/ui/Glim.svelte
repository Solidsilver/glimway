<script lang="ts">
  /**
   * A glim (silas-yard.md 1.9): the glims pass's art when it's loaded (the
   * HUD size for small marks, the full bead from 24 px up, or three beads
   * for `few`), else the drawn bead (src/ui/Icon.svelte `glim`). Every glim
   * on the interface draws through here.
   */
  import ArtIcon from './ArtIcon.svelte'

  let { size = 13, few = false }: { size?: number; few?: boolean } = $props()

  const art = $derived(few ? 'glims-few' : size >= 24 ? 'glim' : 'glim-hud')
</script>

<span class="glim"><ArtIcon {art} name="glim" {size} /></span>

<style>
  .glim {
    display: inline-grid;
    place-items: center;
    flex: none;
    color: var(--ember-deep);
  }
</style>
