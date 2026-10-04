<script lang="ts" module>
  import type { PaperStyle } from '../content/papers'

  /** What a paper is, without saying what it says (for unfound papers). */
  export const KIND_LABEL: Record<PaperStyle, string> = {
    ledger: 'A ledger page',
    letter: 'A letter',
    broadside: 'A posted notice',
    card: 'A recipe card',
    song: 'A song',
    page: 'A printed page',
    notebook: 'A notebook page',
    scrap: 'A scrap of wood',
    record: 'A clerk’s record'
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Paper } from '../content/papers'
  import { parseBody, type Line } from '../lib/papers/markup'
  import Icon from './Icon.svelte'

  let { paper, onBack, backLabel = 'Back', credit }: { paper: Paper; onBack: () => void; backLabel?: string; credit?: Snippet } = $props()

  const blocks = $derived(parseBody(paper.body))

  /** Opening a paper starts at its top, with focus on the way back. */
  function arrive(node: HTMLElement): void {
    node.closest('.panel')?.scrollTo({ top: 0 })
    node.querySelector<HTMLElement>('.back')?.focus({ preventScroll: true })
  }
  const titleId = $derived(`paper-title-${paper.id}`)
</script>

{#snippet line(l: Line)}{#each l as piece}<span class:b={piece.b} class:i={piece.i} class:pencil={piece.pencil}>{piece.text}</span>{/each}{/snippet}

<div class="reader" use:arrive>
  <button type="button" class="ghost back" onclick={onBack}><span aria-hidden="true">‹</span> {backLabel}</button>

  <article class="sheet {paper.style}" aria-labelledby={titleId}>
    {#if paper.style === 'broadside' || paper.style === 'record'}<span class="seal" aria-hidden="true"></span>{/if}
    <h3 class="doc-title" id={titleId}>{paper.title}</h3>
    <div class="doc-body">
      {#each blocks as block, bi (bi)}
        {#if block.kind === 'heading'}
          <h4>{@render line(block.line)}</h4>
        {:else if block.kind === 'list'}
          {#if block.ordered}
            <ol class={block.tone}>{#each block.items as item, ii (ii)}<li>{@render line(item)}</li>{/each}</ol>
          {:else}
            <ul class={block.tone}>{#each block.items as item, ii (ii)}<li>{@render line(item)}</li>{/each}</ul>
          {/if}
        {:else}
          <p class={block.tone}>{#each block.lines as l, li (li)}{#if li > 0}<br />{/if}{@render line(l)}{/each}</p>
        {/if}
      {/each}
    </div>
  </article>

  <dl class="provenance">
    {#each paper.meta as m (m.label)}
      <div><dt>{m.label}</dt><dd>{m.value.replace(/\*/g, '')}</dd></div>
    {/each}
    <div><dt>Collection</dt><dd>{paper.collection}</dd></div>
  </dl>
  {#if credit}<div class="credit"><Icon name="book" size={14} /> {@render credit()}</div>{/if}
</div>

<style>
  .reader {
    display: grid;
    gap: 12px;
  }
  .back {
    justify-self: start;
    padding: 4px 10px;
    font-size: 14px;
  }

  /* ---- the sheet: shared bones ---- */
  .sheet {
    --ink-doc: #3b2a1e;
    --ink-hand: #7a2e1e;
    position: relative;
    padding: 22px 22px 20px;
    color: var(--ink-doc);
    border-radius: 4px;
    box-shadow: 0 2px 0 rgba(74, 50, 32, 0.25), 0 10px 22px rgba(40, 24, 16, 0.18);
    font-size: 15px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .doc-title {
    margin: 0 0 12px;
    font-size: 19px;
    line-height: 1.25;
    color: var(--ink-doc);
  }
  .doc-body p,
  .doc-body ul,
  .doc-body ol {
    margin: 0 0 12px;
  }
  .doc-body ul,
  .doc-body ol {
    padding-left: 22px;
  }
  .doc-body li + li {
    margin-top: 4px;
  }
  .doc-body h4 {
    margin: 14px 0 6px;
    font-size: 16px;
  }
  .b {
    font-weight: 800;
  }
  .i {
    font-style: italic;
  }
  .pencil {
    color: #55525e;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.92em;
    letter-spacing: 0.01em;
  }
  p.intro {
    color: var(--text-soft);
    font-style: italic;
  }
  p.aside {
    font-size: 13.5px;
    color: #7c6a54;
    font-style: italic;
  }
  p.hand,
  ul.hand,
  ol.hand {
    color: var(--ink-hand);
    padding-left: 12px;
    border-left: 2px dotted color-mix(in srgb, var(--ink-hand) 45%, transparent);
    transform: rotate(-0.35deg);
  }
  ul.hand,
  ol.hand {
    padding-left: 30px;
  }
  p.sign {
    text-align: right;
    font-style: italic;
    font-weight: 700;
  }

  /* ---- ledger: green oilcloth, ruled, iron-gall ink ---- */
  .sheet.ledger {
    --ink-doc: #262848;
    --ink-hand: #4a2a5a;
    background:
      linear-gradient(90deg, transparent 30px, rgba(196, 72, 60, 0.45) 30px 32px, transparent 32px),
      repeating-linear-gradient(180deg, transparent 0 23px, rgba(70, 110, 120, 0.22) 23px 24px),
      linear-gradient(180deg, #eef0dc, #e3e6cc);
    border: 6px solid #3f5a46;
    padding-left: 44px;
    line-height: 24px;
  }
  .sheet.ledger .doc-title {
    font-family: var(--font-display);
    letter-spacing: 0.03em;
  }

  /* ---- letter: folded writing paper ---- */
  .sheet.letter {
    --ink-doc: #3a2416;
    background:
      linear-gradient(180deg, transparent 33%, rgba(120, 90, 50, 0.12) 33.3%, transparent 34%, transparent 66%, rgba(120, 90, 50, 0.12) 66.6%, transparent 67%),
      radial-gradient(140% 90% at 30% 10%, #fffaf0, #f3e6c8);
    border: 1px solid #d9c49a;
  }

  /* ---- broadside: posted vellum, block capitals, a seal ---- */
  .sheet.broadside {
    --ink-doc: #2a1d14;
    background: linear-gradient(180deg, #f8f0dc, #ecdcb6);
    border: 3px double #6b4c2e;
    outline: 1px solid rgba(107, 76, 46, 0.35);
    outline-offset: -9px;
    padding-top: 30px;
  }
  .sheet.broadside .doc-title,
  .sheet.record .doc-title {
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 17px;
    padding: 0 26px;
  }
  .seal {
    position: absolute;
    top: 10px;
    right: 12px;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background:
      radial-gradient(circle at 50% 50%, transparent 7px, rgba(255, 220, 200, 0.55) 7px 8.5px, transparent 8.5px),
      radial-gradient(circle at 35% 30%, #d0604a, #8e2a1c 70%);
    box-shadow: 0 1px 0 rgba(60, 10, 0, 0.4);
  }

  /* ---- recipe card: index card, blue rules, a grease spot ---- */
  .sheet.card {
    --ink-doc: #34261a;
    background:
      radial-gradient(38px 28px at 82% 70%, rgba(210, 170, 90, 0.22), transparent 70%),
      linear-gradient(180deg, transparent 52px, rgba(200, 70, 70, 0.55) 52px 54px, transparent 54px),
      repeating-linear-gradient(180deg, transparent 0 25px, rgba(80, 130, 200, 0.25) 25px 26px),
      #fffdf6;
    border: 1px solid #e0d4b8;
    line-height: 26px;
  }
  .sheet.card .doc-title {
    font-family: var(--font-display);
    line-height: 26px;
    margin-bottom: 14px;
  }

  /* ---- song: centred verses ---- */
  .sheet.song {
    background: radial-gradient(120% 100% at 50% 0%, #fffaf0, #f2e3c2);
    border: 1px solid #dcc79c;
    text-align: center;
  }
  .sheet.song p.hand {
    border-left: none;
    padding-left: 0;
  }

  /* ---- printed page: a book's typeset leaf ---- */
  .sheet.page {
    --ink-doc: #26201a;
    --ink-hand: #a3271b;
    font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
    font-size: 15.5px;
    background: linear-gradient(90deg, rgba(120, 90, 50, 0.1), transparent 18px), linear-gradient(180deg, #fbf6e8, #f1e7cf);
    border: 1px solid #ddcfae;
  }
  .sheet.page .doc-title {
    font-family: inherit;
    font-weight: 700;
    text-align: center;
  }

  /* ---- notebook: copybook and field-note paper ---- */
  .sheet.notebook {
    --ink-doc: #2e2c3a;
    --ink-hand: #2f5f8a;
    background:
      linear-gradient(90deg, transparent 26px, rgba(220, 110, 110, 0.4) 26px 27px, transparent 27px),
      repeating-linear-gradient(180deg, transparent 0 23px, rgba(110, 150, 200, 0.28) 23px 24px),
      #fbfaf3;
    border: 1px solid #d8d6c8;
    padding-left: 38px;
    line-height: 24px;
  }

  /* ---- scrap: pale pine and charcoal ---- */
  .sheet.scrap {
    --ink-doc: #2a2622;
    --ink-hand: #3d3a52;
    background:
      repeating-linear-gradient(176deg, rgba(160, 120, 60, 0.1) 0 3px, transparent 3px 11px),
      linear-gradient(180deg, #ecd6a6, #ddbf86);
    border: 2px solid #b0884e;
    border-radius: 8px 14px 6px 16px;
    font-weight: 700;
  }
  .sheet.scrap .doc-title {
    font-family: var(--font-display);
  }

  /* ---- record: clerks' forms and rulings ---- */
  .sheet.record {
    --ink-doc: #2b2318;
    background: linear-gradient(180deg, #f6eedb, #ebdfc2);
    border: 1px solid #c9b48a;
    box-shadow: inset 0 0 0 6px rgba(255, 255, 255, 0.35), 0 2px 0 rgba(74, 50, 32, 0.25), 0 10px 22px rgba(40, 24, 16, 0.18);
    padding-top: 28px;
  }

  /* ---- provenance card ---- */
  .provenance {
    margin: 0;
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.35);
    border: 1.5px dashed var(--paper-line);
    border-radius: 8px;
    font-size: 13px;
  }
  .provenance div {
    display: grid;
    grid-template-columns: 7.5em 1fr;
    gap: 8px;
  }
  .provenance dt {
    font-family: var(--font-display);
    color: var(--wood);
    letter-spacing: 0.04em;
  }
  .provenance dd {
    margin: 0;
    color: var(--text-soft);
  }
  .credit {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13.5px;
    color: var(--wood);
  }
  @media (max-width: 560px) {
    .sheet {
      padding: 18px 14px 16px;
      font-size: 14.5px;
    }
    .sheet.ledger {
      padding-left: 38px;
    }
    .sheet.notebook {
      padding-left: 34px;
    }
    .provenance div {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }
</style>
