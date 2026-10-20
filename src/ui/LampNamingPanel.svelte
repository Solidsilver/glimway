<script lang="ts">
  import { focusTrap } from './focus'
  import { NAMING_SLOTS, defaultParts, namingChoices, renderNaming, type NamingLandmark } from '../lib/lamp-naming'
  import { LAMP_NAMING } from '../content/lamp-naming'

  /**
   * Naming a lamp from parts (docs/design/lamps.md §2.8): one pick per part
   * from what the server offered, never typed words; the sentence and short
   * name preview as you pick, and the server renders them again.
   */
  let {
    landmarks,
    onName,
    onCancel
  }: {
    landmarks: NamingLandmark[]
    onName: (parts: string[]) => void
    onCancel: () => void
  } = $props()

  const choices = $derived(namingChoices(landmarks))
  let parts = $state<string[]>([])
  $effect.pre(() => {
    if (parts.length === 0) parts = defaultParts(landmarks)
  })
  const preview = $derived(renderNaming(parts, landmarks))
  // Few choices read better as a row of buttons than a list to open.
  const asChips = (slot: (typeof NAMING_SLOTS)[number]) => slot === 'relation' || slot === 'closing'

  function submit(e: Event): void {
    e.preventDefault()
    if (preview) onName([...parts])
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
    }
  }
</script>

<div class="overlay lamp-naming" role="dialog" aria-modal="true" aria-labelledby="lamp-naming-title" aria-describedby="lamp-naming-body" tabindex="-1" onkeydown={onKey} data-testid="lamp-naming">
  <form class="panel" use:focusTrap={{ initial: 'select' }} onsubmit={submit}>
    <h2 id="lamp-naming-title">{LAMP_NAMING.title}</h2>
    <p id="lamp-naming-body">{LAMP_NAMING.body}</p>
    <div class="parts">
      {#each NAMING_SLOTS as slot, i (slot)}
        {#if asChips(slot)}
          <fieldset class="part">
            <legend>{LAMP_NAMING.slots[slot]}</legend>
            <div class="chips">
              {#each choices[slot] as c (c.id)}
                <button type="button" class="chip" aria-pressed={parts[i] === c.id} onclick={() => (parts[i] = c.id)} data-part={`${slot}:${c.id}`}>{c.words}</button>
              {/each}
            </div>
          </fieldset>
        {:else}
          <label class="part">
            <span class="legend">{LAMP_NAMING.slots[slot]}</span>
            <select bind:value={parts[i]} data-testid={`naming-${slot}`}>
              {#each choices[slot] as c (c.id)}
                <option value={c.id}>{c.words}</option>
              {/each}
            </select>
          </label>
        {/if}
      {/each}
    </div>
    <blockquote class="preview" aria-live="polite" data-testid="naming-preview">
      {#if preview}
        <p class="sentence">“{preview.text}”</p>
        <p class="short">{LAMP_NAMING.short(preview.shortName)}</p>
      {/if}
    </blockquote>
    <p class="once">{LAMP_NAMING.once}</p>
    <div class="row">
      <button type="button" class="cancel" onclick={onCancel}>{LAMP_NAMING.cancel}</button>
      <button type="submit" class="primary" disabled={!preview} data-testid="naming-submit">{LAMP_NAMING.confirm}</button>
    </div>
  </form>
</div>

<style>
  .lamp-naming {
    z-index: 60;
  }
  .lamp-naming > .panel {
    width: min(460px, 100%);
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
    box-sizing: border-box;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 21px;
    color: var(--wood-dark);
    text-align: center;
  }
  p {
    margin: 0 0 10px;
    line-height: 1.4;
  }
  .parts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 10px;
    margin-bottom: 10px;
  }
  .part {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  fieldset.part {
    grid-column: 1 / -1;
  }
  legend,
  .legend {
    padding: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--wood-dark);
  }
  select {
    width: 100%;
    min-height: 40px;
    padding: 6px 8px;
    font: inherit;
    font-size: 16px;
    border: 2px solid var(--paper-line);
    border-radius: 6px;
    background: var(--paper-glow);
    color: var(--ink);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    min-height: 40px;
    padding: 6px 12px;
    font: inherit;
    font-size: 15px;
    border: 2px solid var(--paper-line);
    border-radius: 999px;
    background: var(--paper-glow);
    color: var(--ink);
    cursor: pointer;
  }
  .chip[aria-pressed='true'] {
    border-color: var(--wood-dark);
    background: var(--wood-dark);
    color: var(--paper-glow);
  }
  .preview {
    margin: 0 0 8px;
    padding: 10px 12px;
    border-left: 3px solid var(--wood-dark);
    background: var(--paper-glow);
    min-height: 3.2em;
  }
  .sentence {
    margin: 0 0 4px;
    font-style: italic;
  }
  .short,
  .once {
    margin: 0;
    font-size: 13px;
    opacity: 0.8;
  }
  .once {
    margin-bottom: 10px;
    text-align: center;
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  @media (max-width: 480px) {
    .parts {
      grid-template-columns: 1fr;
    }
  }
</style>
