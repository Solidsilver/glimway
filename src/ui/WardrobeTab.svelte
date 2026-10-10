<script lang="ts">
  /**
   * The Character panel's Wardrobe page (purse-and-wardrobe.md 4.1, 8): the
   * eight drawn slots, each As on Habitica, a piece you own, or Nothing; a
   * preview of your hero; Wear Habitica's look; and Check for new gear.
   * Shown only to a Habitica hero (guests look like Wren, design 5).
   * Choices take effect at once (predicted, and queued offline) and never
   * change Habitica. The owned list comes from the server's own reads only
   * (GET /api/wardrobe); this page never reads Habitica itself.
   */
  import { onMount, tick } from 'svelte'
  import type { Session } from '../game/session'
  import { bus, EV } from '../game/events'
  import { visualProfile } from '../game/avatar-render'
  import { serverNow } from '../game/clock'
  import {
    NOTHING,
    SLOT_NAMES,
    WARDROBE_SLOTS,
    choosesAny,
    cropFor,
    gearName,
    groupByClass,
    lookFor,
    matchesGear,
    piecesFor,
    readSlot,
    setPieces,
    tileProfile,
    withSlot,
    type WardrobeSlot
  } from '../lib/wardrobe'
  import { checkedLine, foundLine, wardrobeCopy as copy, wardrobeErrorText, wholeSetLine } from '../content/wardrobe'
  import { busVersion } from './panel-state.svelte'
  import { memoryCredentials } from './habitica-local'
  import { ui } from './store.svelte'
  import { isTouchFirst } from './device'
  import ArtIcon from './ArtIcon.svelte'
  import GearTile from './GearTile.svelte'
  import GridPicker from './GridPicker.svelte'

  let { session }: { session: Session } = $props()

  const changed = busVersion(bus, EV.wardrobe, EV.profileChanged)
  const link = $derived(session.link)
  const profile = $derived(ui.importedProfile)
  const chosen = $derived((changed.value, link?.wardrobe ?? {}))

  /** The picker's owned keys: null before they're read (or before the first check). */
  let owned = $state<string[] | null>(null)
  let checkedAt = $state<number | null>(null)
  let unread = $state(false)
  let checking = $state(false)
  let message = $state<{ text: string; kind: 'ok' | 'error' } | null>(null)
  let picking = $state<WardrobeSlot | null>(null)
  /** The Change button that opened the picker: focus goes back to it on close. */
  let returnTo = ''
  /** Credentials are a plain module holder, not reactive: re-read when a check ends or the profile changes. */
  const connected = $derived((changed.value, checking, memoryCredentials() !== null))

  const touch = isTouchFirst()

  onMount(() => {
    void read()
  })

  async function read(): Promise<void> {
    if (!link) return
    const r = await link.readWardrobe()
    if (!r.ok) {
      unread = true
      return
    }
    unread = false
    checkedAt = r.value.checkedAt
    owned = r.value.checkedAt === null && r.value.owned.length === 0 ? null : r.value.owned
  }

  function choose(next: Record<string, string>): void {
    link?.wardrobeChoice(next)
    message = null
  }

  function pick(slot: WardrobeSlot, key: string): void {
    choose(withSlot(chosen, slot, key))
  }

  function wearSet(pieces: Partial<Record<WardrobeSlot, string>>, from: string): void {
    let next: Record<string, string> = { ...chosen }
    for (const [slot, key] of Object.entries(pieces) as [WardrobeSlot, string][]) next = withSlot(next, slot, key)
    choose(next)
    // The line goes once the set is on: focus stays in the picker, on the piece that offered it.
    void tick().then(() => (document.querySelector(`[data-testid="wardrobe-pick-${from}"]`) as HTMLElement | null)?.focus())
  }

  function open(slot: WardrobeSlot): void {
    returnTo = `wardrobe-change-${slot}`
    picking = slot
  }

  function close(): void {
    picking = null
    const from = returnTo
    void tick().then(() => (document.querySelector(`[data-testid="${from}"]`) as HTMLElement | null)?.focus())
  }

  async function check(): Promise<void> {
    const creds = memoryCredentials()
    if (!link || !creds || checking) return
    checking = true
    message = null
    try {
      const r = await link.checkGear(creds.apiToken)
      if (!r.ok) {
        message = { text: wardrobeErrorText(r.code), kind: 'error' }
        return
      }
      owned = r.value.owned
      checkedAt = r.value.checkedAt
      unread = false
      message = { text: foundLine(r.value.newPieces), kind: 'ok' }
    } finally {
      checking = false
    }
  }

  const preview = $derived(profile ? visualProfile(profile, false, chosen) : null)
  const slotLabel = (slot: WardrobeSlot): string => {
    if (!profile) return ''
    const r = readSlot(profile, chosen, slot)
    if (r.kind === 'nothing') return copy.nothing
    if (r.kind === 'piece') return gearName(r.key)
    return `${copy.asOnHabitica} · ${r.shows ? gearName(r.shows) : 'none'}`
  }
</script>

{#if !profile}
  <!-- Guests never see this page (CharacterPanel hides the tabs); nothing stands in for Habitica gear. -->
{:else if picking}
  {@const slot = picking}
  {@const shows = readSlot(profile, {}, slot)}
  {@const sel = chosen[slot] ?? ''}
  {@const set = sel && sel !== NOTHING ? setPieces(sel, owned ?? [], lookFor(profile, chosen)) : {}}
  {@const more = Object.values(set).length}
  <GridPicker
    title={SLOT_NAMES[slot]}
    backLabel="Back to the Wardrobe"
    searchPlaceholder="Search your gear"
    chipsLabel="Class"
    groups={groupByClass(piecesFor(owned ?? [], slot)).map((g) => ({ id: g.klass, label: g.label, keys: g.keys }))}
    matches={matchesGear}
    nameOf={gearName}
    selected={sel}
    first={{ label: copy.asOnHabitica, hint: shows.kind === 'habitica' && shows.shows ? gearName(shows.shows) : 'Nothing there on Habitica now' }}
    also={[{ key: NOTHING, label: copy.nothing, hint: copy.nothingHint }]}
    emptyText={owned === null ? copy.neverChecked : copy.nothingElse}
    testid="wardrobe-picker"
    pickPrefix="wardrobe-pick"
    onPick={(k) => pick(slot, k)}
    onClose={close}
  >
    {#snippet aside()}
      {#if preview}<span class="mini" data-testid="wardrobe-picker-preview"><GearTile profile={preview} size={52} /></span>{/if}
    {/snippet}
    {#snippet above()}
      {#if more > 0}
        <button type="button" class="set" onclick={() => wearSet(set, sel)} data-testid="wardrobe-wear-set">
          <span>{wholeSetLine(more + 1)}</span>
          <small>{Object.values(set).map((k) => gearName(k!)).join(', ')}</small>
        </button>
      {/if}
    {/snippet}
    {#snippet tile(key)}
      <GearTile profile={tileProfile(profile, slot, key)} crop={cropFor(slot)} size={56} />
    {/snippet}
  </GridPicker>
{:else}
  <div class="wardrobe" data-testid="wardrobe-page">
    <div class="top">
      <span class="preview" data-testid="wardrobe-preview">{#if preview}<GearTile profile={preview} size={touch ? 68 : 88} />{/if}</span>
      <div class="lead">
        <h3 class="section-title"><ArtIcon art="wardrobe" size={24} />{copy.title}</h3>
        <button type="button" disabled={!link || !choosesAny(chosen)} onclick={() => choose({})} data-testid="wardrobe-habitica-look">{copy.habiticaLook}</button>
      </div>
    </div>

    {#if !link}
      <p class="fine">{copy.noLink}</p>
    {:else}
      <ul class="slots">
        {#each WARDROBE_SLOTS as slot (slot)}
          <li data-testid={`wardrobe-slot-${slot}`}>
            <button type="button" onclick={() => open(slot)} aria-label={`${SLOT_NAMES[slot]}: ${slotLabel(slot)}. ${copy.change}`} data-testid={`wardrobe-change-${slot}`}>
              <span class="slot">{SLOT_NAMES[slot]}</span>
              <span class="what" data-testid={`wardrobe-slot-${slot}-name`}>{slotLabel(slot)}</span>
              <span class="change">{copy.change}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <p class="fine">{copy.foot}</p>

    {#if link}
      <p class="fine checked" data-testid="wardrobe-checked">
        {#if unread}{copy.unread}{:else if checkedAt !== null}{checkedLine(checkedAt, serverNow())}{:else}{copy.neverChecked}{/if}
      </p>
      <button type="button" class="check" disabled={checking || !connected} onclick={() => void check()} data-testid="wardrobe-check">
        {checking ? copy.checking : connected ? copy.check : copy.connectFirst}
      </button>
      {#if !connected && !checking}<p class="fine">{copy.connectHint}</p>{/if}
      <!-- The check's answer sits under its button, where the eye is. -->
      {#if message}<p class="msg {message.kind}" role="status" data-testid="wardrobe-message">{message.text}</p>{/if}
    {/if}
  </div>
{/if}

<style>
  .top {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 10px;
  }
  .preview {
    width: 96px;
    height: 96px;
    flex: none;
    display: grid;
    place-items: center;
    border: 3px solid var(--wood-dark);
    border-radius: 14px;
    background: radial-gradient(circle at 50% 70%, #fff8e0, #e9d3a1);
  }
  .lead {
    display: grid;
    gap: 6px;
    justify-items: start;
  }
  .lead h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mini {
    display: grid;
    place-items: center;
    border: 2px solid var(--paper-line);
    border-radius: 10px;
    background: #fff8e0;
  }
  button {
    min-height: 44px;
  }
  .slots {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  /* Each slot row is one tap target (design 8). */
  .slots button {
    width: 100%;
    display: grid;
    grid-template-columns: 92px 1fr auto;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    text-align: left;
    background: rgba(255, 255, 255, 0.4);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
    box-shadow: none;
  }
  .slot {
    font-weight: 800;
    font-size: 13px;
  }
  .what {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text-soft);
  }
  .change {
    font-size: 13px;
    color: var(--wood);
    text-decoration: underline;
  }
  .set {
    width: 100%;
    display: grid;
    justify-items: start;
    margin: 6px 0;
    padding: 8px 12px;
    text-align: left;
  }
  .set small {
    color: var(--text-soft);
  }
  .checked {
    margin-top: 14px;
  }
  .check {
    width: 100%;
  }
  .msg {
    margin: 8px 0 0;
  }
  :global(:root.touch) .preview {
    width: 76px;
    height: 76px;
  }
  @media (max-width: 420px) {
    .slots button {
      grid-template-columns: 1fr auto;
    }
    .what {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
