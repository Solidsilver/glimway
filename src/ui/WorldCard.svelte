<script lang="ts">
  import { onMount } from 'svelte'
  import { isUnreachable } from '../lib/api/errors'
  import type { WorldRef, WorldView } from '../lib/api/types'
  import { worldCopy } from '../content/world-moves'
  import { api } from './account'
  import Icon from './Icon.svelte'

  /**
   * The Menu's world settings: where you live, your party's world (the join
   * prompt, findable again here, or opening it when your party has none
   * yet and you may), going back to a world you own, and, when you've left
   * the party whose world you live in, when you'll be moved out and "Leave
   * now". Reads need the session only, not the lease.
   */
  let { onMove, onLeave }: { onMove: (target: WorldRef, home: boolean, view: WorldView) => void; onLeave?: (view: WorldView) => void } = $props()

  let view = $state<WorldView | null>(null)
  let busy = $state(false)
  let error = $state('')

  async function refresh(): Promise<void> {
    try {
      view = await api.world()
      error = ''
    } catch (err) {
      error = isUnreachable(err) ? worldCopy.offline : worldCopy.readFailed
    }
  }

  /** Make your party's world (it moves no one; joining is the usual move). */
  async function openPartyWorld(): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      view = await api.worldParty()
    } catch (err) {
      error = isUnreachable(err) ? worldCopy.offline : worldCopy.partyOpenFailed
      void refresh()
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void refresh()
  })
</script>

<div class="world-settings" data-testid="world-settings">
  {#if view}
    <p class="lives"><Icon name="world" size={14} /> <span>{worldCopy.livesIn(worldCopy.place(view.world, view.partyHome), view.isOwner)}</span> <small>{view.isOwner ? worldCopy.members(view.world.members) : worldCopy.travelers(view.world.members, view.world.ownerName, view.world.ownerHere)}</small></p>
    {#if view.partyHome}<p class="tiny" data-testid="world-party-home">{worldCopy.partyHome}</p>{/if}
    {#if view.leaver}
      <div class="offer party" data-testid="world-leaver">
        <span class="badge" aria-hidden="true"><Icon name="clock" size={14} /></span>
        <span class="text">
          {worldCopy.leaver(worldCopy.within(view.leaver.moveOutIn))}
          <small>{worldCopy.leaverNote(view.leaver.hasOwn)}</small>
        </span>
        {#if onLeave}<button type="button" class="primary small" onclick={() => onLeave(view!)}>{worldCopy.leaveNow}</button>{/if}
      </div>
    {/if}

    {#if view.partyWorld}
      <div class="offer party" data-testid="world-party-offer">
        <span class="badge" aria-hidden="true"><Icon name="person" size={14} /></span>
        <span class="text">
          {worldCopy.partyThere}
          <small>{worldCopy.travelers(view.partyWorld.members, view.partyWorld.ownerName, view.partyWorld.ownerHere)}</small>
        </span>
        <button type="button" class="primary small" onclick={() => onMove(view!.partyWorld!, false, view!)}>{worldCopy.join(view.partyWorld.members)}</button>
      </div>
    {:else if view.partyCanOpen}
      <div class="offer party" data-testid="world-party-missing">
        <span class="badge" aria-hidden="true"><Icon name="person" size={14} /></span>
        <span class="text">{worldCopy.partyMissing}</span>
        <button type="button" class="small" onclick={openPartyWorld} disabled={busy}>{worldCopy.partyOpen}</button>
      </div>
    {/if}
    {#if view.ownWorld && !view.leaver}
      <div class="offer own" data-testid="world-own-offer">
        <span class="badge" aria-hidden="true"><Icon name="lantern" size={14} /></span>
        <span class="text">
          {worldCopy.ownThere}
          <small>{worldCopy.travelers(view.ownWorld.members, view.ownWorld.ownerName, view.ownWorld.ownerHere)}</small>
        </span>
        <button type="button" class="small" onclick={() => onMove(view!.ownWorld!, true, view!)}>{worldCopy.goHome}</button>
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
  .text small {
    display: block;
    margin-top: 2px;
    font-size: 12.5px;
    color: var(--text-faint);
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
