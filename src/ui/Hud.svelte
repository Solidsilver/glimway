<script lang="ts">
  import { ui } from './store.svelte'

  let showBars = $derived(ui.stats.maxHp > 0)
  const hpPct = $derived(Math.max(0, Math.min(100, (ui.stats.hp / ui.stats.maxHp) * 100)))
  const manaPct = $derived(Math.max(0, Math.min(100, (ui.stats.mana / ui.stats.maxMana) * 100)))

  let { onJournal, onCharacter }: { onJournal: () => void; onCharacter: () => void } = $props()
</script>

<div class="hud">
  <div class="left panel">
    <div class="location">{ui.area.name}</div>
    <div class="objective">{ui.quest.objective}</div>
    {#if showBars}
      <div class="bars">
        <div class="bar hp" title="Health">
          <div class="fill" style={`width:${hpPct}%`}></div>
          <span>{ui.stats.hp}/{ui.stats.maxHp}</span>
        </div>
        <div class="bar mana" title="Mana">
          <div class="fill" style={`width:${manaPct}%`}></div>
          <span>{ui.stats.mana}/{ui.stats.maxMana}</span>
        </div>
      </div>
    {/if}
    {#if ui.stats.hp <= 0 && ui.vitalsSource === 'imported'}
      <div class="zerohp">Too injured to adventure — village activities only. Rest until a Habitica sync brings HP back.</div>
    {/if}
  </div>
  <div class="buttons">
    <button type="button" onclick={onJournal} aria-label="Open journal">Journal</button>
    <button type="button" onclick={onCharacter} aria-label="Open character sheet">Character</button>
  </div>
</div>

<style>
  .hud {
    position: absolute;
    top: max(8px, env(safe-area-inset-top));
    left: max(8px, env(safe-area-inset-left));
    right: max(8px, env(safe-area-inset-right));
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    pointer-events: none;
    z-index: 20;
  }
  .left {
    padding: 8px 12px;
    max-width: min(420px, 70vw);
  }
  .location {
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--wood-dark);
  }
  .objective {
    font-size: 12px;
    color: #5a4a3a;
    margin-top: 2px;
  }
  .bars {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .bar {
    position: relative;
    width: 120px;
    height: 12px;
    background: #d8c79c;
    border: 2px solid var(--wood-dark);
    border-radius: 4px;
    overflow: hidden;
    font-size: 9px;
  }
  .bar .fill {
    height: 100%;
    transition: width 0.2s ease-out;
  }
  .hp .fill { background: var(--danger); }
  .mana .fill { background: var(--mana); }
  .bar span {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink);
    font-weight: 700;
  }
  .buttons {
    display: flex;
    gap: 6px;
    pointer-events: auto;
  }
  @media (max-width: 560px) {
    .bar { width: 84px; }
    .buttons button { padding: 4px 8px; font-size: 11px; }
  }
</style>
