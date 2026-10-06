<script lang="ts">
  import { onMount } from 'svelte'
  import { isUnreachable } from '../lib/api/errors'
  import type { WorldRef, WorldView } from '../lib/api/types'
  import { worldCopy } from '../content/world-moves'
  import { api } from './account'
  import Icon from './Icon.svelte'

  /**
   * The Menu's world settings: where you live, your party's world (the join
   * prompt, findable again here), going back to a world you own, and, for an
   * owner, the party link. Reads need the session only, not the lease.
   */
  let { onMove }: { onMove: (target: WorldRef, home: boolean, view: WorldView) => void } = $props()

  let view = $state<WorldView | null>(null)
  let busy = $state(false)
  let error = $state('')

  async function refresh(): Promise<void> {
    try {
      view = await api.world()
      error = ''
    } catch (err) {
      error = isUnreachable(err) ? worldCopy.offline : worldCopy.failed
    }
  }

  async function setLink(link: boolean): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      view = await api.worldParty(link)
    } catch (err) {
      error = isUnreachable(err) ? worldCopy.offline : worldCopy.failed
    } finally {
      busy = false
    }
  }

  const linkLine = $derived(view ? (view.linkedToMine ? worldCopy.linkedMine : view.linked ? worldCopy.linkedOther : worldCopy.unlinked) : '')

  onMount(() => {
    void refresh()
  })
</script>

<div class="world-settings" data-testid="world-settings">
  {#if view}
    <p class="lives"><Icon name="world" size={14} /> <span>{worldCopy.livesIn(view.world.ownerName, view.isOwner)}</span> <small>{worldCopy.members(view.world.members)}</small></p>

    {#if view.partyWorld}
      <div class="offer party" data-testid="world-party-offer">
        <span class="badge" aria-hidden="true"><Icon name="person" size={14} /></span>
        <span class="text">{worldCopy.partyThere(view.partyWorld.ownerName)}</span>
        <button type="button" class="primary small" onclick={() => onMove(view!.partyWorld!, false, view!)}>{worldCopy.join}</button>
      </div>
    {/if}
    {#if view.ownWorld}
      <div class="offer own" data-testid="world-own-offer">
        <span class="badge" aria-hidden="true"><Icon name="lantern" size={14} /></span>
        <span class="text">{worldCopy.ownThere}</span>
        <button type="button" class="small" onclick={() => onMove(view!.ownWorld!, true, view!)}>{worldCopy.goHome}</button>
      </div>
    {/if}

    {#if view.isOwner}
      <div class="link" data-testid="world-link">
        <h4><Icon name="key" size={12} /> {worldCopy.linkTitle}</h4>
        <p class="fine"><span class="dot" class:on={view.linkedToMine} aria-hidden="true"></span>{linkLine}</p>
        {#if view.linkedToMine}
          <button type="button" class="small" onclick={() => setLink(false)} disabled={busy}>{worldCopy.unlink}</button>
        {:else if view.inParty}
          <button type="button" class="small" onclick={() => setLink(true)} disabled={busy}>{worldCopy.link}</button>
        {:else}
          <p class="tiny">{worldCopy.noParty}</p>
        {/if}
      </div>
    {/if}
  {:else if !error}
    <p class="tiny">…</p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .world-settings {
    display: grid;
    gap: 8px;
    margin: 6px 0 4px;
  }
  .lives {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin: 0;
    font-size: 14px;
    color: var(--wood-dark);
  }
  .lives small {
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .offer {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 10px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 252, 240, 0.6);
  }
  .offer.party {
    border-color: var(--gold-deep);
    background: rgba(255, 210, 74, 0.2);
  }
  .badge {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 2px solid var(--wood-dark);
    background: var(--paper-hi);
    color: var(--wood);
  }
  .party .badge {
    background: var(--gold);
    color: var(--wood-dark);
  }
  .text {
    font-size: 14px;
    line-height: 1.35;
  }
  .link {
    padding-top: 4px;
    border-top: 1.5px dashed var(--paper-line);
  }
  h4 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0 2px;
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 600;
    color: var(--wood);
  }
  .fine {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin: 0 0 6px;
    font-size: 13.5px;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--paper-line);
  }
  .dot.on {
    background: var(--accent);
  }
  .small {
    padding: 4px 10px;
    font-size: 13px;
  }
  .tiny {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .error {
    margin: 0;
    padding: 8px 10px;
    font-size: 13.5px;
    color: #7a2e1e;
    background: rgba(196, 82, 58, 0.12);
    border-radius: 8px;
  }
  @media (max-width: 560px) {
    .offer {
      grid-template-columns: auto 1fr;
    }
    .offer button {
      grid-column: 1 / -1;
    }
  }
</style>
