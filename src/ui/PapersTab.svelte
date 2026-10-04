<script lang="ts">
  import { PAPER_COLLECTIONS, PAPERS, paperById } from '../content/papers'
  import { papers } from './papers.svelte'
  import PaperReader, { KIND_LABEL } from './PaperReader.svelte'
  import Icon from './Icon.svelte'

  // The player's own collection: papers they found themselves. The
  // library's starting shelf is everyone's, read at the library itself.
  let reading = $state<string | null>(null)
  let listEl = $state<HTMLElement | null>(null)
  let lastOpened: string | null = null

  const owned = $derived(new Set(papers.found))
  const findable = PAPERS.filter((p) => p.source.kind !== 'library-start').length
  const onShelf = PAPERS.filter((p) => p.source.kind === 'library-start').length
  const groups = $derived(
    PAPER_COLLECTIONS.map((name) => {
      const list = PAPERS.filter((p) => p.collection === name)
      return { name, list, found: list.filter((p) => owned.has(p.id)).length }
    })
  )
  const current = $derived(reading ? paperById(reading) : undefined)

  function open(id: string): void {
    lastOpened = id
    reading = id
    papers.markSeen(id)
  }

  function back(): void {
    reading = null
    // Return focus to the row the player came from.
    queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-paper="${lastOpened}"]`)?.focus())
  }
</script>

{#if current}
  <PaperReader paper={current} onBack={back} backLabel="All papers" />
{:else}
  <div class="summary">
    <p><b>{papers.found.length}</b> of {findable} found <span class="sep">·</span> {onShelf} more on the library shelves</p>
    <div class="bar" aria-hidden="true"><span style={`width:${(papers.found.length / findable) * 100}%`}></span></div>
  </div>

  <div bind:this={listEl}>
    {#each groups as g (g.name)}
      <section class="collection" aria-label={g.name}>
        <h3 class="section-title">
          <span>{g.name}</span>
          <span class="count">{g.found}/{g.list.length}</span>
        </h3>
        <ul>
          {#each g.list as p (p.id)}
            <li>
              {#if owned.has(p.id)}
                <button type="button" class="row found" data-paper={p.id} onclick={() => open(p.id)}>
                  <span class="ico"><Icon name="scroll" size={16} /></span>
                  <span class="txt">
                    <span class="name">{p.title}{#if papers.isNew(p.id)}<span class="new">New</span>{/if}</span>
                    <span class="desc">{p.description}</span>
                  </span>
                  <span class="go" aria-hidden="true">›</span>
                </button>
              {:else if p.source.kind === 'library-start'}
                <div class="row shelf">
                  <span class="ico"><Icon name="book" size={16} /></span>
                  <span class="txt">
                    <span class="name">{p.title}</span>
                    <span class="desc">On the Hearthwick Library’s shelves — read it there.</span>
                  </span>
                </div>
              {:else}
                <div class="row missing">
                  <span class="ico" aria-hidden="true">?</span>
                  <span class="txt">
                    <span class="name">{KIND_LABEL[p.style]} <span class="nf">· not yet found</span></span>
                    <span class="desc hint">{p.hint}</span>
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

<style>
  .summary p {
    margin: 0 0 6px;
    font-size: 14.5px;
  }
  .sep {
    color: var(--text-faint);
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
    background: linear-gradient(90deg, var(--gold-deep), var(--gold));
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
    text-align: left;
    font-family: var(--font-body);
    font-size: 14px;
    letter-spacing: 0;
    border-radius: 9px;
    min-height: 44px;
  }
  div.row {
    border: 2px dashed var(--paper-line);
    background: rgba(255, 255, 255, 0.18);
  }
  button.row {
    box-shadow: 0 2px 0 var(--wood-dark);
  }
  .ico {
    flex: none;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    background: rgba(255, 210, 74, 0.35);
    color: var(--wood-dark);
    font-family: var(--font-display);
  }
  .missing .ico {
    background: rgba(107, 76, 46, 0.12);
    color: var(--text-faint);
  }
  .shelf .ico {
    background: rgba(47, 127, 122, 0.18);
    color: var(--accent);
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
  .nf {
    font-weight: 600;
    color: var(--text-faint);
  }
  .desc {
    font-size: 13px;
    color: var(--text-soft);
    line-height: 1.35;
  }
  .hint {
    font-style: italic;
  }
  .go {
    font-family: var(--font-display);
    font-size: 20px;
    color: var(--wood);
  }
  .new {
    display: inline-block;
    margin-left: 8px;
    padding: 0 6px;
    font-family: var(--font-display);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #3d2410;
    background: var(--gold);
    border: 1.5px solid var(--wood-dark);
    border-radius: 999px;
    vertical-align: 2px;
  }
</style>
