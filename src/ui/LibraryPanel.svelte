<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { Library, type ShelfView } from '../game/papers'
  import { PAPER_COLLECTIONS, PAPERS, paperById, paperFlag } from '../content/papers'
  import type { ShelfEntry } from '../lib/papers/library'
  import { actionRunner } from './panel-state.svelte'
  import { papers } from './papers.svelte'
  import PaperReader, { KIND_LABEL } from './PaperReader.svelte'
  import Panel from './Panel.svelte'

  // The Hearthwick Library's reading room, opened at its door. Anyone can
  // read what is shelved; you can donate papers you found that aren't yet.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const library = $derived(new Library(session))
  let view = $state<ShelfView | null>(null)
  let reading = $state<string | null>(null)
  const action = actionRunner()
  let listEl = $state<HTMLElement | null>(null)
  let lastOpened: string | null = null

  onMount(() => {
    void library.load().then((v) => (view = v))
  })

  const shelf = $derived(view?.shelf ?? new Map<string, ShelfEntry>())
  const owned = $derived(new Set(papers.found))
  const groups = $derived(
    PAPER_COLLECTIONS.map((name) => {
      const list = PAPERS.filter((p) => p.collection === name)
      return { name, list, shelved: list.filter((p) => shelf.has(p.id)).length }
    })
  )
  const current = $derived(reading ? paperById(reading) : undefined)
  const currentEntry = $derived(reading ? shelf.get(reading) : undefined)

  function formatDay(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }

  function creditFor(e: ShelfEntry | undefined): string {
    if (!e) return ''
    if (!e.donatedBy) return 'On the shelves since the Keepers’ day.'
    const day = formatDay(e.donatedAt)
    return `First donated by ${e.donatedBy}${day ? ` · ${day}` : ''}`
  }

  function open(id: string): void {
    lastOpened = id
    reading = id
    action.clear()
    if (owned.has(id)) papers.markSeen(id)
  }

  function back(): void {
    reading = null
    queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-paper="${lastOpened}"]`)?.focus())
  }

  async function donate(id: string): Promise<void> {
    const r = await action.run(id, () => library.donate(id), `“${paperById(id)?.title}” is on the shelves now. Thank you.`)
    if (!r) return
    if (r.ok) {
      const next = new Map(shelf)
      next.set(id, r.entry)
      view = { shelf: next, mode: view?.mode ?? 'local', offline: view?.offline ?? false }
    } else {
      // Someone else may have shelved it: show the world's shelf as it is.
      void library.load().then((v) => (view = v))
    }
  }

  const canDonate = (id: string) => session.state.flags.includes(paperFlag(id)) && !shelf.has(id)
</script>

<Panel id="library" icon="book" title="Hearthwick Library" closeLabel="Close the library" {onClose}>

  {#if current}
    <PaperReader paper={current} onBack={back} backLabel="The shelves">
      {#snippet credit()}{creditFor(currentEntry)}{/snippet}
    </PaperReader>
  {:else}
    <p class="lede">
      {#if view?.mode === 'shared'}
        The Keepers’ old reading room. Everyone in your world fills these shelves together.
      {:else}
        The Keepers’ old reading room. Bring what you find; the shelves remember.
      {/if}
    </p>

    {#if !view}
      <p class="fine" aria-live="polite">Lighting the reading lamp…</p>
    {:else}
      <div class="progress" aria-live="polite">
        <p><b>{shelf.size} of {PAPERS.length}</b> on the shelves</p>
        <div class="bar" aria-hidden="true"><span style={`width:${(shelf.size / PAPERS.length) * 100}%`}></span></div>
        {#if view.offline}<p class="fine warn">Can’t reach your world’s library right now — showing what this device knows.</p>{/if}
      </div>
    {/if}

    {#if action.message}<p class="msg {action.message.kind}" role="status">{action.message.text}</p>{/if}

    {#if view}
      <div bind:this={listEl}>
        {#each groups as g (g.name)}
          <section aria-label={g.name}>
            <h3 class="section-title"><span>{g.name}</span><span class="count">{g.shelved}/{g.list.length}</span></h3>
            <ul>
              {#each g.list as p (p.id)}
                {@const entry = shelf.get(p.id)}
                <li>
                  {#if entry}
                    <button type="button" class="row shelved" data-paper={p.id} onclick={() => open(p.id)}>
                      <span class="spine" aria-hidden="true"></span>
                      <span class="txt">
                        <span class="name">{p.title}</span>
                        <span class="desc">{creditFor(entry)}</span>
                      </span>
                      <span class="go" aria-hidden="true">Read ›</span>
                    </button>
                  {:else if canDonate(p.id)}
                    <div class="row held">
                      <span class="spine gap" aria-hidden="true"></span>
                      <span class="txt">
                        <span class="name">{p.title}</span>
                        <span class="desc">You found this one. The shelf has a gap its size.</span>
                      </span>
                      <button type="button" class="primary small" data-donate={p.id} disabled={action.busy !== null} onclick={() => donate(p.id)}>
                        {action.busy === p.id ? 'Shelving…' : 'Donate'}
                      </button>
                    </div>
                  {:else}
                    <div class="row missing">
                      <span class="spine gap" aria-hidden="true"></span>
                      <span class="txt">
                        <span class="name">{KIND_LABEL[p.style]}</span>
                        <span class="desc">Not on the shelves yet.</span>
                      </span>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</Panel>

<style>
  .lede {
    margin: 0 0 10px;
    font-size: 14.5px;
    color: var(--text-soft);
  }
  .progress p {
    margin: 0 0 6px;
  }
  .bar {
    height: 8px;
    border-radius: 999px;
    background: rgba(107, 76, 46, 0.15);
    border: 1.5px solid var(--wood);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--accent), #5cb0a8);
  }
  .warn {
    margin-top: 6px;
    color: var(--ember-deep);
  }
  .msg {
    margin: 10px 0 0;
    padding: 8px 10px;
    font-size: 14px;
  }
  .section-title {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    text-transform: none;
    letter-spacing: 0.04em;
    font-size: 14px;
  }
  .count {
    flex: none;
    font-size: 12.5px;
    color: var(--text-soft);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    min-height: 44px;
    text-align: left;
    font-family: var(--font-body);
    font-size: 14px;
    letter-spacing: 0;
    border-radius: 9px;
  }
  div.row {
    border: 2px dashed var(--paper-line);
    background: rgba(255, 255, 255, 0.18);
  }
  div.row.held {
    border-style: solid;
    border-color: var(--gold-deep);
    background: rgba(255, 233, 160, 0.3);
  }
  button.row {
    box-shadow: 0 2px 0 var(--wood-dark);
  }
  .spine {
    flex: none;
    width: 10px;
    height: 30px;
    border-radius: 2px;
    background: linear-gradient(90deg, #6c3a2a, #9a5a3c 60%, #6c3a2a);
    border: 1.5px solid var(--wood-dark);
  }
  .spine.gap {
    background: transparent;
    border-style: dashed;
    border-color: var(--text-faint);
  }
  .txt {
    display: grid;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .name {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .missing .name {
    color: var(--text-soft);
  }
  .desc {
    font-size: 13px;
    color: var(--text-soft);
    line-height: 1.35;
  }
  .go {
    flex: none;
    font-family: var(--font-display);
    font-size: 14px;
    color: var(--wood);
  }
  .small {
    flex: none;
    padding: 5px 12px;
    font-size: 14px;
  }
</style>
