<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { homesteadsFor, lotName } from '../game/homestead'
  import { bus, EV } from '../game/events'
  import { atTable, deedOffers, deedPlaceName, shareCandidates, standsAtTable, type AtTable } from '../game/deed-table'
  import { HOMESTEAD_DATA } from '../lib/homestead'
  import { DEED_PANEL_COPY as COPY, PELL_DEED } from '../content/pell'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import { home } from './home.svelte'
  import Panel from './Panel.svelte'

  // Manage your deed (silas-yard.md 2.6), opened from Pell's talk: who's on
  // your deed, sharing it with whoever is at the deed table, the signatures
  // waiting on you, and giving up your place. Every write is one of the deed
  // operations the talk used; the server checks the table itself.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const homes = $derived(homesteadsFor(session))
  const changed = busVersion(bus, EV.homeChanged)
  const action = actionRunner()
  const WINDOW = HOMESTEAD_DATA.jointDeed.confirmWindowSeconds

  // Fresh invites and members when it opens (Pell's talk may have read them a while ago).
  onMount(() => {
    if (session.link) void homes.load()
  })

  /** Who's at the table, and whether you are: read again every couple of seconds while it's open. */
  let tick = $state(0)
  bus.emit(EV.notePosition)
  $effect(() => {
    const t = setInterval(() => {
      bus.emit(EV.notePosition)
      tick += 1
    }, 2000)
    return () => clearInterval(t)
  })

  const view = $derived.by(() => {
    void changed.value
    void tick
    const mine = homes.claimed ? homes.mine : null
    const gate = homes.myGate ?? 0
    const s = session.state
    const here: AtTable[] = mine ? atTable() : []
    return {
      mine,
      gate,
      place: deedPlaceName(mine, gate),
      names: mine?.members.map((m) => m.displayName || 'A neighbour').join(', ') ?? '',
      atTable: standsAtTable(s.area, s.position),
      candidates: mine ? shareCandidates(here, mine.members) : [],
      offers: deedOffers(homes.invites, homes.myId, mine?.id ?? null, Date.now() / 1000)
    }
  })

  function answered(status: 'joined' | 'waiting' | undefined): string {
    return status === 'joined' ? PELL_DEED.signedTogether : PELL_DEED.signedWaiting(WINDOW)
  }

  async function offer(p: AtTable): Promise<void> {
    bus.emit(EV.notePosition)
    await action.run(`offer:${p.id}`, () => homes.offerDeed(p.id), (r) => answered(r.status))
  }

  async function signBack(homeId: string, to: string): Promise<void> {
    bus.emit(EV.notePosition)
    await action.run(`sign:${to}`, () => homes.sign(homeId, to), (r) => answered(r.status))
  }

  async function signTheirs(homeId: string): Promise<void> {
    const me = homes.myId
    if (!me) return
    bus.emit(EV.notePosition)
    await action.run(`sign:${homeId}`, () => homes.sign(homeId, me), (r) => answered(r.status))
  }

  /** The confirm (App.svelte), its copy Pell's; striking the name happens here once it's confirmed. */
  function giveUp(): void {
    const mine = view.mine
    if (!mine) return
    const shared = mine.members.length > 1
    home.leaveAsk = { place: view.place, shared, onConfirm: () => void leave(shared) }
  }

  async function leave(shared: boolean): Promise<void> {
    const r = await action.run('leave', () => homes.leave(), null)
    if (!r?.ok) return
    bus.emit(EV.toast, { text: PELL_DEED.struck(shared).join(' '), icon: 'scroll' })
    onClose()
  }
</script>

<Panel id="deed" icon="scroll" title={COPY.title} closeLabel="Close your deed" {onClose} message={action.message} messageTestId="deed-message" class="deed">
  {#if !view.mine}
    <p class="msg" data-testid="deed-none">You’re not on a deed. Pell sells them at the desk.</p>
  {:else}
    <section class="who" aria-label="Your deed">
      <p class="place" data-testid="deed-place">{COPY.where(view.place, lotName(view.gate))}</p>
      <p class="names" data-testid="deed-names">{COPY.onTheDeed(view.names)}</p>
    </section>

    <section aria-labelledby="deed-share" data-testid="deed-share">
      <h3 class="section-title" id="deed-share">{COPY.shareHeading}</h3>
      {#if !view.atTable}
        <p class="fine" data-testid="deed-not-at-table">{COPY.notAtTable}</p>
      {:else if view.candidates.length === 0}
        <p class="fine" data-testid="deed-table-empty">{COPY.tableEmpty}</p>
      {:else}
        <p class="fine">{COPY.atTable}</p>
        <ul>
          {#each view.candidates as p (p.id)}
            {@const offered = view.offers.offered.get(p.id)}
            <li class="row" data-candidate={p.id}>
              <span class="name">{p.name}</span>
              {#if offered && offered.fromConfirmedAt !== null && Date.now() / 1000 - offered.fromConfirmedAt <= WINDOW}
                <span class="note" data-testid="deed-offered">{COPY.offered(p.name)}</span>
              {:else}
                <button type="button" class="small primary" data-offer={p.id} disabled={action.busy !== null} onclick={() => offer(p)}>
                  {action.busy === `offer:${p.id}` ? 'Signing…' : COPY.offer}
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <p class="help">{COPY.shareHelp}</p>
    </section>

    {#if view.offers.signBack.length > 0 || view.offers.toMe.length > 0}
      <section aria-labelledby="deed-waiting" data-testid="deed-waiting">
        <h3 class="section-title" id="deed-waiting">{COPY.waitingHeading}</h3>
        <ul>
          {#each view.offers.signBack as i (i.to.id)}
            <li class="row" data-sign-back={i.to.id}>
              <span class="name">{i.to.name} has signed. Your name goes next to it.</span>
              <button type="button" class="small primary" disabled={action.busy !== null} onclick={() => signBack(i.homeId, i.to.id)}>
                {action.busy === `sign:${i.to.id}` ? 'Signing…' : COPY.sign}
              </button>
            </li>
          {/each}
          {#each view.offers.toMe as i (i.homeId)}
            <li class="row" data-invite={i.homeId}>
              <span class="name">{COPY.inviteRow(i.from.name, lotName(i.gate))}</span>
              <!-- One deed at a time: their deed waits until you're off your own (the server says the same). -->
              <button type="button" class="small" disabled title="Give up your place on your own deed first" onclick={() => signTheirs(i.homeId)}>{COPY.sign}</button>
            </li>
          {/each}
        </ul>
        {#if view.offers.toMe.length > 0}<p class="help">You can sign another deed once you’ve given up your place on this one.</p>{/if}
      </section>
    {/if}

    <section class="leave" aria-label="Give up your place">
      <button type="button" class="danger" data-testid="deed-give-up" disabled={action.busy !== null} onclick={giveUp}>{COPY.giveUp}</button>
      <p class="help">{COPY.giveUpHelp(HOMESTEAD_DATA.desolation.deedLostAfterDays)}</p>
    </section>
  {/if}
</Panel>

<style>
  .who {
    margin: 0 0 12px;
  }
  .place {
    margin: 0;
    font-weight: 800;
    font-size: 16px;
    color: var(--wood-dark);
  }
  .names {
    margin: 2px 0 0;
    font-size: 14px;
    color: var(--text-soft);
  }
  .section-title {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 13px;
    margin: 14px 0 6px;
  }
  .msg {
    padding: 8px 10px;
    font-size: 14px;
  }
  .fine {
    margin: 4px 0 6px;
    font-size: 13.5px;
    color: var(--text-soft);
  }
  .help {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-faint);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 8px 10px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.22);
  }
  .row .name {
    flex: 1 1 10em;
    min-width: 0;
    font-weight: 800;
    color: var(--wood-dark);
  }
  .note {
    flex: 1 1 100%;
    font-size: 13px;
    color: var(--text-soft);
  }
  .small {
    flex: none;
    margin-left: auto;
    padding: 5px 12px;
    font-size: 13.5px;
  }
  .leave {
    margin-top: 18px;
    padding-top: 12px;
    border-top: 2px solid var(--paper-line);
  }
  .leave button {
    width: 100%;
  }
  :global(:root.touch) .small {
    min-height: 44px;
  }
  :global(:root.touch) .leave button {
    min-height: 48px;
  }
</style>
