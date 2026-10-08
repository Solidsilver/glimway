<script lang="ts">
  import { focusTrap } from './focus'

  /** A short naming prompt (a lantern post's name): flavour only, kept short and tidy. */
  let {
    title,
    body,
    placeholder,
    max,
    onName,
    onCancel
  }: {
    title: string
    body: string
    placeholder: string
    max: number
    onName: (name: string) => void
    onCancel: () => void
  } = $props()

  let value = $state('')
  const tidy = $derived(value.replace(/\s+/g, ' ').trim())
  const ok = $derived(tidy.length > 0 && [...tidy].length <= max)

  function submit(e: Event): void {
    e.preventDefault()
    if (ok) onName(tidy)
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
    }
  }
</script>

<div class="overlay naming" role="dialog" aria-modal="true" aria-labelledby="name-title" aria-describedby="name-body" tabindex="-1" onkeydown={onKey} data-testid="name-prompt">
  <form class="panel" use:focusTrap={{ initial: 'input' }} onsubmit={submit}>
    <h2 id="name-title">{title}</h2>
    <p id="name-body">{body}</p>
    <label class="field">
      <span class="sr">Name</span>
      <input type="text" bind:value maxlength={max} {placeholder} autocomplete="off" spellcheck="false" data-testid="name-input" />
    </label>
    <p class="count" aria-live="polite">{[...tidy].length}/{max}</p>
    <div class="row">
      <button type="button" class="cancel" onclick={onCancel}>Not yet</button>
      <button type="submit" class="primary" disabled={!ok} data-testid="name-submit">Name it</button>
    </div>
  </form>
</div>

<style>
  .naming {
    z-index: 60;
  }
  .naming > .panel {
    width: min(400px, 100%);
    text-align: center;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 21px;
    color: var(--wood-dark);
  }
  p {
    margin: 0 0 10px;
    line-height: 1.4;
  }
  .field input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    font: inherit;
    font-size: 16px;
    border: 2px solid var(--paper-line);
    border-radius: 6px;
    background: var(--paper-glow);
    color: var(--ink);
  }
  .count {
    margin: 4px 0 10px;
    font-size: 12px;
    opacity: 0.7;
    text-align: right;
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
