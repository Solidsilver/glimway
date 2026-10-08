<script lang="ts">
  import { whatsNewCopy } from '../content/update'
  import { CHANGELOG_URL } from '../lib/version'
  import type { Release } from '../lib/changelog'
  import NoticeCard from './NoticeCard.svelte'

  /**
   * "What's new": the players' lines from the changelog, after an update or
   * from the Menu. A notice like the others: never a modal, never takes
   * focus, shown only on a clear screen.
   */
  let { releases, onClose }: { releases: Release[]; onClose: () => void } = $props()
  const title = $derived(releases.length > 1 ? whatsNewCopy.titleSince : releases.length === 1 ? whatsNewCopy.title(releases[0].version) : whatsNewCopy.menu)
</script>

<NoticeCard testid="whats-new" icon="sparkle" wide {title}>
  {#snippet body()}
    <div class="lines">
      {#if releases.length === 0}
        <p>{whatsNewCopy.nothing}</p>
      {/if}
      {#each releases as r (r.version)}
        {#if releases.length > 1}<p class="release">{whatsNewCopy.release(r.version)}</p>{/if}
        <ul>
          {#each r.players as line, i (i)}
            <li>{line}</li>
          {/each}
        </ul>
      {/each}
      <p class="all"><a href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer">{whatsNewCopy.all}</a></p>
    </div>
  {/snippet}
  {#snippet actions()}
    <button type="button" class="primary" onclick={onClose} data-testid="whats-new-ok">{whatsNewCopy.ok}</button>
  {/snippet}
</NoticeCard>

<style>
  /* Long lists scroll inside the card, so it never runs under the HUD or the thumbs. */
  .lines {
    max-height: min(38vh, 260px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  /* Short landscape phones: the card sits under the HUD across the screen
     (src/ui/NoticeCard.svelte), so the list stops above the thumbs
     (App measures --hud-bottom and --dock-bottom). */
  @media (orientation: landscape) and (max-height: 500px) {
    :global(:root.touch) .lines {
      max-height: max(44px, calc(100vh - var(--hud-bottom, 64px) - var(--dock-bottom, 140px) - 56px));
    }
  }
  ul {
    margin: 4px 0 0;
    padding-left: 18px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-soft);
  }
  li + li {
    margin-top: 3px;
  }
  .release {
    margin-top: 8px;
    font-weight: 800;
    color: var(--wood);
  }
  .all a {
    color: var(--accent);
  }
</style>
