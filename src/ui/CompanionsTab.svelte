<script lang="ts">
  /**
   * The Character panel's Companions page (crafts.md 2.1): who comes with
   * you, who lives at home (up to three, in the yard), and the stable. Shown
   * only to a Habitica hero. Choices take effect at once (predicted, and
   * queued offline) and never change Habitica's current pet; a stall waits
   * for the world's answer.
   */
  import { onMount, tick } from 'svelte'
  import type { Session } from '../game/session'
  import { bus, EV } from '../game/events'
  import { homesteadsFor } from '../game/homestead'
  import { NO_PET, companionName, stallsShown } from '../lib/companions'
  import { HOMESTEAD_DATA } from '../lib/homestead'
  import { predictStall } from '../lib/api/predict'
  import { companionErrorText } from '../content/errors'
  import type { HomeView } from '../lib/api/types'
  import { busVersion } from './panel-state.svelte'
  import { ui } from './store.svelte'
  import CompanionArt from './CompanionArt.svelte'
  import CompanionsPicker from './CompanionsPicker.svelte'

  let { session, at = null }: { session: Session; at?: 'stable' | null } = $props()

  const changed = busVersion(bus, EV.companions, EV.homeChanged, EV.profileChanged)
  const link = $derived(session.link)
  const homes = $derived(link ? homesteadsFor(session) : null)
  const profile = $derived(ui.importedProfile)
  const view = $derived((changed.value, link?.companions ?? null))
  const home = $derived<HomeView | null>((changed.value, homes?.mine ?? null))
  const stable = $derived(home?.items.find((i) => i.itemDef === HOMESTEAD_DATA.stable.item && i.scene === 'outdoor') ?? null)
  const current = $derived(profile?.selectedPet ?? null)
  const noPet = $derived(view?.followPet === NO_PET)
  const follower = $derived(noPet ? '' : view?.followPet || current || '')
  const yard = $derived(view?.yardPets ?? [])
  const me = $derived(link?.accountId ?? null)
  const ownedMounts = $derived(profile?.mounts ?? [])

  type Picking = { what: 'follower' } | { what: 'yard'; spot: number } | { what: 'stall'; stall: number }
  let picking = $state<Picking | null>(null)
  let message = $state<{ text: string; kind: 'ok' | 'error' } | null>(null)
  let busy = $state(false)
  let stableEl = $state<HTMLElement | null>(null)
  /** The button that opened the picker (its test id): focus goes back to it when the picker closes. */
  let returnTo = ''

  function open(p: Picking, from: string): void {
    returnTo = from
    picking = p
  }

  function close(): void {
    picking = null
    const from = returnTo
    void tick().then(() => (document.querySelector(`[data-testid="${from}"]`) as HTMLElement | null)?.focus())
  }

  onMount(() => {
    // Your homestead in this world gates the choices: read it if it hasn't been.
    if (homes && homes.myGate === null) void homes.load()
    else if (homes && homes.myGate !== null && !homes.mine) void homes.fetchHome(homes.myGate)
    if (at === 'stable') void tick().then(() => stableEl?.scrollIntoView({ block: 'start' }))
  })

  function chooseFollower(key: string): void {
    close()
    link?.companionsChoice(key, yard)
    message = null
  }

  function chooseYard(spot: number, key: string): void {
    close()
    const next = [...yard]
    if (key) next[spot] = key
    else next.splice(spot, 1)
    // Slot order, at most three, no pet twice.
    const clean = next.filter((k, i) => k && next.indexOf(k) === i).slice(0, 3)
    link?.companionsChoice(view?.followPet ?? '', clean)
    message = null
  }

  async function chooseStall(stall: number, key: string): Promise<void> {
    close()
    if (!link || !homes || !home || busy) return
    const before = home
    busy = true
    message = null
    homes.adoptHome(predictStall(home, stall, key, { id: me ?? '', name: link.name || 'You' }))
    try {
      const r = await link.stall(home.id, stall, key)
      if (!r.ok) {
        homes.adoptHome(before)
        message = { text: companionErrorText(r.code), kind: 'error' }
        return
      }
      if (r.result) homes.adoptHome(r.result)
      message = { text: key ? `${companionName(key)} is in stall ${stall}.` : `Stall ${stall} stands empty.`, kind: 'ok' }
    } finally {
      busy = false
    }
  }

  /** Your own mount reads out from your companions, not the homestead as last read (crafts.md 3.1). */
  const stalls = $derived(home ? stallsShown(home.stalls, home.id, me, view, new Map(), 0) : [])
  const stallOf = (n: number) => stalls.find((s) => s.stall === n) ?? null
</script>

{#if picking?.what === 'follower'}
  <CompanionsPicker
    title="Who comes with you"
    kind="pet"
    keys={profile?.pets ?? []}
    selected={view?.followPet ?? ''}
    first={{ label: 'Habitica’s current pet', hint: current ? companionName(current) : 'None chosen on Habitica' }}
    also={[{ key: NO_PET, label: 'No pet', hint: 'Walk on your own' }]}
    onPick={chooseFollower}
    onClose={close}
  />
{:else if picking?.what === 'yard'}
  {@const spot = picking.spot}
  <CompanionsPicker
    title="At home"
    kind="pet"
    keys={(profile?.pets ?? []).filter((k) => !yard.includes(k) || yard[spot] === k)}
    selected={yard[spot] ?? ''}
    first={{ label: 'Leave empty' }}
    onPick={(k) => chooseYard(spot, k)}
    onClose={close}
  />
{:else if picking?.what === 'stall'}
  {@const stall = picking.stall}
  {@const st = stallOf(stall)}
  <CompanionsPicker
    title={`Stall ${stall}`}
    kind="mount"
    keys={ownedMounts}
    selected={st?.ownerId === me ? (st?.mount ?? '') : ''}
    first={st?.mount && st.ownerId === me ? { label: 'Leave empty' } : null}
    onPick={(k) => void chooseStall(stall, k)}
    onClose={close}
  />
{:else}
  <div class="companions" data-testid="companions-page">
    {#if message}<p class="msg {message.kind}" role="status">{message.text}</p>{/if}

    <h3 class="section-title">Who comes with you</h3>
    <div class="row" data-testid="companions-follower">
      {#if follower}
        <CompanionArt key={follower} kind="pet" />
        <span class="who"
          ><b data-testid="companions-follower-name">{companionName(follower)}</b>
          <small>{view?.followPet ? 'Chosen here' : 'Habitica’s current pet'}</small></span
        >
      {:else if noPet}
        <span class="who"><b data-testid="companions-follower-name">No pet</b> <small>You walk on your own</small></span>
      {:else}
        <span class="who"><small>No pet walks with you. Choose one here, or on Habitica.</small></span>
      {/if}
      {#if home}
        <button type="button" onclick={() => open({ what: 'follower' }, 'companions-change-follower')} data-testid="companions-change-follower">Change</button>
      {/if}
    </div>

    {#if !home}
      <p class="fine">Once you’ve a place of your own, you can choose who comes along.</p>
    {:else}
      <div class="head-row">
        <h3 class="section-title">At home</h3>
        <small>up to three, in the yard</small>
      </div>
      <ul class="spots" data-testid="companions-yard">
        {#each [0, 1, 2] as spot (spot)}
          {@const key = yard[spot]}
          {#if key || spot === yard.length}
            <li>
              <button
                type="button"
                class="spot"
                onclick={() => open({ what: 'yard', spot }, `companions-yard-${spot}`)}
                aria-label={key ? `${companionName(key)}, at home: change` : 'Choose a pet to live at home'}
                data-testid={`companions-yard-${spot}`}
              >
                {#if key}<CompanionArt {key} kind="pet" /><span>{companionName(key)}</span>{:else}<span class="plus">+</span>{/if}
              </button>
            </li>
          {/if}
        {/each}
      </ul>

      {#if stable}
        <h3 class="section-title" bind:this={stableEl}>The stable</h3>
        <ul class="stalls" data-testid="companions-stalls">
          {#each Array.from({ length: stable.stalls ?? 1 }, (_, i) => i + 1) as n (n)}
            {@const st = stallOf(n)}
            {@const mine = !st?.mount || st.ownerId === me}
            <li>
              <span class="n">Stall {n}</span>
              {#if st?.mount}
                <CompanionArt key={st.mount} kind="mount" size={40} />
                <span class="who"
                  ><b>{companionName(st.mount)}</b>
                  <small>{st.ownerId !== me ? `${st.ownerName || 'A partner'}’s` : st.out ? 'out with you' : 'in its stall'}</small></span
                >
              {:else}
                <span class="who"><small>empty</small></span>
              {/if}
              {#if mine}
                <button type="button" disabled={busy} onclick={() => open({ what: 'stall', stall: n }, `companions-stall-${n}`)} data-testid={`companions-stall-${n}`}>{st?.mount ? 'Change' : 'Choose'}</button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if (stable.stalls ?? 1) < HOMESTEAD_DATA.stable.maxStalls}
          <p class="fine">To build another stall, stand at the stable’s east end.</p>
        {/if}
      {:else if home.tier >= 2}
        <p class="fine">Silas sells a stable now you’ve the Workshop. That’s where a mount stands, and where riding starts.</p>
      {/if}
    {/if}
    <p class="fine foot">Choosing here never changes your pet or mount on Habitica.</p>
  </div>
{/if}

<style>
  .row,
  .stalls li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.4);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .who small,
  .head-row small {
    color: var(--text-soft);
  }
  button {
    min-height: 44px;
    min-width: 44px;
  }
  .head-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .spots {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .spot {
    width: 84px;
    min-height: 84px;
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 2px;
    padding: 6px 4px;
    font-size: 12px;
    line-height: 1.2;
  }
  .plus {
    font-family: var(--font-display);
    font-size: 26px;
    color: var(--wood);
  }
  .stalls {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .n {
    width: 52px;
    font-weight: 800;
    font-size: 13px;
  }
  .msg {
    margin: 0 0 8px;
  }
  .foot {
    margin-top: 16px;
  }
</style>
