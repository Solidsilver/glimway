<script lang="ts">
  /**
   * An amount of glims: a whole number from 1 to `max`, and **Max**, which
   * only fills the field with `max` (silas-yard.md 1.5; purse-and-wardrobe.md
   * 2.1, owner 2026-10-09). It never sends anything: the caller's own button
   * does, and its label follows the number. Shared by the consent card, the
   * mailbox's glims row and the Inventory's Give.
   */
  import { purseCopy } from '../content/purse'

  let {
    value = $bindable(''),
    max,
    label = purseCopy.amountLabel,
    maxTitle = purseCopy.maxTitle,
    disabled = false,
    testid = 'glims-amount',
    autofocus = false
  }: { value?: string; max: number; label?: string; maxTitle?: string; disabled?: boolean; testid?: string; autofocus?: boolean } = $props()

  let input: HTMLInputElement | undefined = $state()

  /** Text fields must not leak keys to the game (Phaser captures WASD/E/F). */
  const keepKeys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') e.stopPropagation()
  }

  function fillMax(): void {
    value = String(max)
    input?.focus()
  }

  $effect(() => {
    if (autofocus) input?.focus()
  })
</script>

<div class="amount">
  <label class="field">
    <span>{label}</span>
    <input
      bind:this={input}
      bind:value
      type="text"
      inputmode="numeric"
      autocomplete="off"
      spellcheck="false"
      placeholder=""
      {disabled}
      onkeydown={keepKeys}
      data-testid={testid}
    />
  </label>
  <button type="button" class="ghost max" disabled={disabled || max < 1} title={maxTitle} onclick={fillMax} data-testid={`${testid}-max`}>{purseCopy.max}</button>
</div>

<style>
  .amount {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .field {
    flex: 1 1 auto;
    display: grid;
    gap: 4px;
    min-width: 0;
    font-size: 13px;
    color: var(--text-soft);
  }
  .field input {
    min-height: 44px;
    font-size: 18px;
    padding: 6px 10px;
    box-sizing: border-box;
    width: 100%;
  }
  .max {
    flex: none;
    min-height: 44px;
    text-decoration: underline;
    color: var(--wood);
  }
</style>
