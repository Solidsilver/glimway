<script lang="ts">
  import Icon from '../../ui/Icon.svelte'
  import { inLab, labLook, labUrl, onLabLook, setLabLook, type LabLook } from './look'

  // The height lab's corner of the dev panel (src/ui/dev/DevPanel.svelte):
  // open the lab (the page again with ?lab=height), leave it, and switch
  // its transitions while walking it.
  let look = $state<LabLook>(labLook())
  $effect(() => onLabLook((l) => (look = l)))
  const here = inLab()

  const choices: { key: keyof LabLook; label: string; options: { value: LabLook[keyof LabLook]; label: string }[] }[] = [
    { key: 'area', label: 'Area', options: [{ value: 'shoulder', label: 'Plateau and shoulder' }, { value: 'mountain', label: 'Mountain and deep cave' }] },
    { key: 'fog', label: 'Levels above and below fade to', options: [{ value: 'fog', label: 'Fog' }, { value: 'sky', label: 'Sky' }, { value: 'none', label: 'Nothing' }] },
    { key: 'fogStrength', label: 'Fog per level', options: [{ value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'strong', label: 'Strong' }] },
    { key: 'caveStyle', label: 'Cave floors', options: [{ value: 'mixed', label: 'Mixed' }, { value: 'built', label: 'Built' }, { value: 'rough', label: 'Rough' }] },
    { key: 'zoom', label: 'Climbing, the camera', options: [{ value: true, label: 'Eases out' }, { value: false, label: 'Stays' }] },
    { key: 'haze', label: 'Climbing, haze at the edges', options: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] },
    { key: 'cave', label: 'In a cave, your own light', options: [{ value: 'lantern', label: 'Close' }, { value: 'wide', label: 'Wide' }, { value: 'dim', label: 'None' }] },
    { key: 'skyTiles', label: 'Daylight reaches in', options: [{ value: 3, label: '3 tiles' }, { value: 6, label: '6 tiles' }, { value: 10, label: '10 tiles' }] },
    { key: 'way', label: 'Into a cave, the way in', options: [{ value: 'blend', label: 'Even (round 4)' }, { value: 'eased', label: 'Longer, eased' }, { value: 'stages', label: 'Dark first, then the cave' }, { value: 'iris', label: 'Iris from the mouth' }] },
    { key: 'crossfade', label: 'The cave’s view comes in over', options: [{ value: 1, label: '1 tile' }, { value: 3, label: '3 tiles' }] },
    { key: 'grid', label: 'Levels overlay', options: [{ value: false, label: 'Off' }, { value: true, label: 'On' }] }
  ]
</script>

<section class="lab" data-testid="dev-height-lab">
  <h3 class="section-title"><Icon name="stone" size={14} /> Height lab</h3>
  <p class="what">Hand-made areas with real levels and caves: a valley, plateau and shoulder; a mountain with a saddle and a deep cave. It doesn’t save or send anything.</p>
  {#if here}
    <button type="button" onclick={() => location.assign(labUrl(false))}>Leave the lab</button>
    {#each choices as c (c.key)}
      <div class="row" role="group" aria-label={c.label}>
        <span class="label">{c.label}</span>
        {#each c.options as o (String(o.value))}
          <button type="button" class="small" aria-pressed={look[c.key] === o.value} onclick={() => setLabLook({ [c.key]: o.value })}>{o.label}</button>
        {/each}
      </div>
    {/each}
    <label class="row">
      <span class="label">Underground, levels above and below get darker: {Math.round(look.darkness * 100)}% at most</span>
      <input type="range" min="0" max="0.9" step="0.05" value={look.darkness} oninput={(e) => setLabLook({ darkness: Number(e.currentTarget.value) })} data-testid="height-lab-darkness" />
    </label>
  {:else}
    <button type="button" class="primary" onclick={() => location.assign(labUrl(true))}>Walk the height lab</button>
  {/if}
</section>

<style>
  .lab {
    margin: 4px 0 12px;
  }
  .what {
    margin: 0 0 8px;
    font-size: 13px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .label {
    flex: 1 1 100%;
    font-size: 12px;
    font-weight: 700;
    color: var(--wood-dark);
  }
  input[type='range'] {
    flex: 1 1 100%;
  }
  .small {
    padding: 5px 12px;
    font-size: 13px;
    min-height: 36px;
  }
  .small[aria-pressed='true'] {
    background: var(--wood);
    color: var(--cream-hi);
  }
</style>
