<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import type { WorldMoveResponse, WorldRef, WorldView } from '../lib/api/types'
  import { moveBlocks, moveRefusal, type MoveBlock } from '../lib/world-moves'
  import { worldCopy } from '../content/world-moves'
  import { api } from './account'
  import { ui } from './store.svelte'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'

  /**
   * The move confirmation (design: "Moving to another world"): what comes
   * along, what stays, and anything that has to happen first. The move is
   * one keyed request; the world waits for its answer, and the screen stays
   * up ("Arriving…") until the new world is open.
   */
  let {
    session,
    target,
    home,
    view: initial,
    arriving,
    onMoved,
    onHere,
    onCancel
  }: {
    session: Session
    target: WorldRef
    /** Going back to a world you own. */
    home: boolean
    view: WorldView | null
    /** The move landed; the new world is opening. */
    arriving: boolean
    onMoved: (res: WorldMoveResponse) => void
    /** Already in that world (another device moved first): step in. */
    onHere: () => void
    onCancel: () => void
  } = $props()

  // svelte-ignore state_referenced_locally
  let view = $state<WorldView | null>(initial)
  let busy = $state(false)
  let error = $state('')
  /** A lost request's answer is still unknown (the link's, read when it may have changed). */
  // svelte-ignore state_referenced_locally
  let pending = $state(!!session.link?.pendingOperation)
  /** The server says not from here (the local area check didn't see it). */
  let unsafe = $state(false)

  const working = $derived(busy || arriving)
  const here = $derived(view ? (view.isOwner ? 'Your world' : worldCopy.name(view.world, view.partyHome)) : '…')
  const there = $derived(home ? 'Your world' : worldCopy.name(target))
  /** Lowercase, mid-sentence: "your party’s world", "Olive’s world". */
  const thereIn = $derived(worldCopy.place(target))
  /** Seconds now, ticking while the screen is up, so the cooldown lifts on its own. */
  let now = $state(Date.now() / 1000)
  const leaving = $derived(view?.leaving ?? null)
  const homestead = $derived(!!leaving && leaving.gate >= 0)
  const blocks = $derived.by(() => {
    const b = moveBlocks({
      area: session.state.area,
      outgoing: leaving?.outgoing ?? 0,
      online: ui.link?.status === 'online',
      pending,
      opensAt: view?.moveOpensAt ?? 0,
      now
    })
    if (unsafe && !b.includes('area')) b.push('area')
    return b
  })
  const blocked = $derived(!view || blocks.length > 0)

  function blockLine(b: MoveBlock): string {
    if (b === 'area') return worldCopy.blockArea
    if (b === 'mail') return worldCopy.blockMail(Math.max(1, leaving?.outgoing ?? 1))
    if (b === 'offline') return worldCopy.blockOffline
    if (b === 'cooldown') return worldCopy.blockCooldown(worldCopy.opensIn((view?.moveOpensAt ?? 0) - now))
    return worldCopy.blockPending
  }

  async function refresh(): Promise<void> {
    pending = !!session.link?.pendingOperation
    try {
      view = await api.world()
    } catch {
      if (!view) error = worldCopy.offline
    }
  }

  async function go(): Promise<void> {
    const link = session.link
    if (working || blocked || !link) return
    busy = true
    error = ''
    const r = await link.mutate<WorldMoveResponse>({ kind: 'world-move', fields: { worldId: target.id } })
    pending = !!link.pendingOperation
    if (r.ok) {
      onMoved(r.res)
      busy = false
      return
    }
    busy = false
    const why = moveRefusal(r.code)
    if (why === 'here') return onHere()
    if (why === 'area') unsafe = true
    else if (why === 'cooldown') void refresh()
    else if (why === 'denied') error = worldCopy.denied
    else if (why === 'offline') error = worldCopy.blockOffline
    else if (why === 'pending' || why === 'retry') error = worldCopy.blockPending
    else if (why === 'failed') error = worldCopy.failed
    // Mail on the road the screen didn't know about: show it as it is now.
    if (why === 'mail' || why === 'retry') void refresh()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !working) {
      e.stopPropagation()
      onCancel()
    }
  }

  onMount(() => {
    void refresh()
    const tick = setInterval(() => (now = Date.now() / 1000), 30_000)
    return () => clearInterval(tick)
  })
</script>

<div class="overlay gate" role="dialog" aria-modal="true" aria-labelledby="move-title" aria-busy={working} tabindex="-1" onkeydown={onKey} data-testid="world-move">
  <div class="panel gate-panel wide" use:focusTrap={{ initial: '.stay' }}>
    <p class="gate-eyebrow"><Icon name="world" size={14} /> {worldCopy.eyebrow}</p>
    <h2 class="gate-title" id="move-title">{home ? worldCopy.titleHome : worldCopy.title(thereIn)}</h2>

    <div class="route" aria-label={`From ${here} to ${there}`}>
      <span class="stop from"><Icon name="lantern" size={13} /> {here}</span>
      <span class="trail" aria-hidden="true"><span></span><span></span><span></span><Icon name="map" size={14} /><span></span><span></span><span></span></span>
      <span class="stop to"><Icon name="world" size={13} /> {there} <small>{worldCopy.travelers(target.members, target.ownerName, target.ownerHere)}</small></span>
    </div>

    <p class="gate-lead">{worldCopy.lead}</p>

    <div class="sides">
      <section class="side comes" aria-labelledby="comes-title">
        <h3 id="comes-title"><Icon name="bag" size={14} /> {worldCopy.comes}</h3>
        <ul>
          <li><span class="ic ok"><Icon name="check" size={11} /></span>{worldCopy.comeHero}</li>
          <li><span class="ic ember"><Icon name="ember" size={12} /></span>{worldCopy.comeEmbers(session.state.embers)}</li>
          <li><span class="ic ok"><Icon name="check" size={11} /></span>{worldCopy.comePack}</li>
          <li><span class="ic ok"><Icon name="check" size={11} /></span>{worldCopy.comeChest}</li>
        </ul>
      </section>
      <section class="side stays" aria-labelledby="stays-title">
        <h3 id="stays-title"><Icon name="home" size={14} /> {worldCopy.stays}</h3>
        <ul>
          {#if leaving && homestead}
            <li>
              <span class="ic stay"><Icon name="home" size={11} /></span>
              <span>
                {worldCopy.stayHome(leaving.gate + 1)}
                {#if leaving.last}<em class="warn" data-testid="move-last">{worldCopy.stayHomeLast}</em>{/if}
              </span>
            </li>
          {:else if leaving}
            <li class="muted"><span class="ic stay"><Icon name="home" size={11} /></span>{worldCopy.stayNoHome}</li>
          {/if}
          {#if homestead}<li><span class="ic stay"><Icon name="stone" size={11} /></span>{worldCopy.stayGoods}</li>{/if}
          <li><span class="ic stay"><Icon name="map" size={11} /></span>{worldCopy.stayWilds}</li>
          <li><span class="ic stay"><Icon name="star" size={11} /></span>{worldCopy.stayProjects}</li>
        </ul>
      </section>
    </div>

    {#if leaving && leaving.wardenTools > 0}
      <p class="note warn-note" data-testid="move-warden"><Icon name="tools" size={13} /> {worldCopy.wardenTools(leaving.wardenTools)}</p>
    {/if}
    {#if leaving && leaving.incoming > 0}
      <p class="note" data-testid="move-incoming"><Icon name="scroll" size={13} /> {worldCopy.incoming(leaving.incoming)}</p>
    {/if}
    {#if leaving && leaving.deedCost > 0}
      <p class="note" data-testid="move-deed"><Icon name="ember" size={13} /> {worldCopy.deedCost(leaving.deedCost)}</p>
    {/if}

    {#if view && blocks.length > 0}
      <ul class="blocks" role="alert" data-testid="move-blocks">
        {#each blocks as b (b)}<li data-block={b}><Icon name="clock" size={13} /> {blockLine(b)}</li>{/each}
      </ul>
    {/if}
    {#if error}<p class="gate-error" role="alert">{error}</p>{/if}

    <p class="gate-fine again">{worldCopy.again}</p>
    {#if working}
      <p class="gate-status" role="status"><span class="gate-spinner" aria-hidden="true"></span> {arriving ? worldCopy.arriving : worldCopy.working}</p>
    {:else}
      <div class="row">
        <button type="button" class="stay" onclick={onCancel}>{worldCopy.cancel}</button>
        <button type="button" class="primary" onclick={go} disabled={blocked}>{home ? worldCopy.confirmHome : worldCopy.confirm(thereIn)}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .route {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 4px 0 10px;
  }
  .stop {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 2px solid var(--wood);
    font-family: var(--font-display);
    font-size: 14px;
    color: var(--wood-dark);
    background: var(--paper-hi);
  }
  .stop.to {
    border-color: var(--gold-deep);
    background: linear-gradient(180deg, #fff3c2 0%, #f6d77c 100%);
  }
  .stop small {
    font-family: var(--font-body);
    font-size: 11.5px;
    font-weight: 700;
    color: var(--text-soft);
  }
  .trail {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--wood);
  }
  .trail > span {
    width: 4px;
    height: 4px;
    background: var(--paper-line);
  }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 10px 0 8px;
    text-align: left;
  }
  .side {
    padding: 10px 12px 12px;
    border-radius: 12px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.32);
  }
  .side.comes {
    border-color: rgba(47, 127, 122, 0.45);
    background: rgba(47, 127, 122, 0.08);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    color: var(--wood-dark);
  }
  ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: 6px;
    align-items: start;
    font-size: 14px;
    line-height: 1.4;
  }
  li.muted {
    color: var(--text-faint);
  }
  .ic {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 50%;
  }
  .ic.ok {
    background: var(--accent);
    color: #fff;
  }
  .ic.ember {
    color: var(--ember-deep);
  }
  .ic.stay {
    border: 1.5px solid var(--wood);
    color: var(--wood);
    background: var(--paper-hi);
  }
  .warn {
    display: block;
    margin-top: 2px;
    font-style: normal;
    font-size: 12.5px;
    color: var(--ember-deep);
  }
  .note {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 4px 0;
    font-size: 13.5px;
    color: var(--text-soft);
    text-align: left;
  }
  .note :global(svg) {
    flex: none;
    margin-top: 3px;
  }
  .warn-note {
    font-weight: 600;
    color: var(--ember-deep);
  }
  .again {
    margin-top: 10px;
  }
  .blocks {
    margin: 8px 0;
    padding: 8px 12px;
    border-radius: 10px;
    border: 2px dashed var(--gold-deep);
    background: rgba(255, 210, 74, 0.18);
    text-align: left;
  }
  .blocks li {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--wood-dark);
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
    margin: 12px 0 4px;
  }
  @media (max-width: 620px) {
    .route {
      flex-direction: column;
      gap: 4px;
    }
    .trail {
      flex-direction: column;
      gap: 3px;
    }
    .sides {
      grid-template-columns: 1fr;
    }
    .row button {
      flex: 1 1 100%;
    }
  }
</style>
