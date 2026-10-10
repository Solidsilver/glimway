<script lang="ts">
  /**
   * The purse log (purse-and-wardrobe.md 2.1): the last 50 lines, newest
   * first. Every top-up with Habitica's gold before and after, every buy,
   * sale, letter and gift, and who the other player was. Habitica keeps no
   * record of a top-up; this is the record.
   */
  import { purseCopy } from '../content/purse'
  import { logDate, signed } from '../lib/purse'
  import { purseUi } from './purse.svelte'
  import Panel from './Panel.svelte'
</script>

<Panel id="purse-log" icon="scroll" title={purseCopy.logTitle} closeLabel={purseCopy.closeLog} onClose={() => purseUi.closeSheet()} class="purse-log">
  <p class="note">{purseCopy.logNote}</p>
  {#if purseUi.logStatus === 'offline' && !purseUi.log}
    <p class="none">{purseCopy.needsConnection}</p>
  {:else if !purseUi.log}
    <p class="none">{purseCopy.logLoading}</p>
  {:else if purseUi.log.length === 0}
    <p class="none">{purseCopy.logEmpty}</p>
  {:else}
    <ol class="log" data-testid="purse-log">
      {#each purseUi.log as e, i (`${e.at}:${i}`)}
        <li class="entry" class:top-up={e.kind === 'top-up'}>
          <span class="date">{logDate(e.at)}</span>
          <span class="what">
            <span class="text">{e.text}</span>
            {#if e.detail}<span class="detail">{e.detail}</span>{/if}
          </span>
          <span class="delta" class:out={e.delta !== null && e.delta < 0}>{e.delta === null ? '' : signed(e.delta)}</span>
        </li>
      {/each}
    </ol>
  {/if}
</Panel>

<style>
  :global(.overlay > .panel.purse-log) {
    width: min(560px, 100%);
  }
  .note {
    margin: 4px 0 10px;
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .none {
    font-style: italic;
    color: var(--text-faint);
  }
  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .entry {
    display: grid;
    grid-template-columns: 52px 1fr auto;
    gap: 10px;
    align-items: baseline;
    padding: 6px 4px;
    border-bottom: 1px solid var(--paper-line);
    font-size: 14px;
    line-height: 1.35;
  }
  .date {
    font-size: 12.5px;
    color: var(--text-faint);
    white-space: nowrap;
  }
  .what {
    display: grid;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .detail {
    font-size: 12.5px;
    color: var(--text-soft);
  }
  .delta {
    font-family: var(--font-display);
    white-space: nowrap;
    color: #3f6b2a;
  }
  .delta.out {
    color: var(--wood-dark);
  }
</style>
