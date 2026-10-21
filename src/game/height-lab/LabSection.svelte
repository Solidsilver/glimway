<script lang="ts">
  import Icon from '../../ui/Icon.svelte'
  import { inLab, labLook, labUrl, onLabLook, setLabLook, type LabLook } from './look'

  // The height lab's corner of the dev panel (src/ui/dev/DevPanel.svelte):
  // open the lab (the page again with ?lab=height), leave it, and switch
  // its transitions while walking it. `bare`: the panel's own section
  // already gives it a title.
  let { bare = false }: { bare?: boolean } = $props()
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
    { key: 'grid', label: 'Levels overlay', options: [{ value: false, label: 'Off' }, { value: true, label: 'On' }] }
  ]
</script>

<section class="lab" class:bare data-testid="height-lab-controls">
  {#if !bare}<h3 class="section-title"><Icon name="stone" size={14} /> Height lab</h3>{/if}
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
      {#if c.key === 'way'}
        <label class="row">
          <span class="label">The cave’s view comes in over: {look.crossfade} {look.crossfade === 1 ? 'tile' : 'tiles'}</span>
          <input type="range" min="1" max="4" step="1" list="height-lab-crossfade-stops" value={look.crossfade} oninput={(e) => setLabLook({ crossfade: Number(e.currentTarget.value) })} data-testid="height-lab-crossfade" />
          <datalist id="height-lab-crossfade-stops">
            {#each [1, 2, 3, 4] as tiles}<option value={tiles} label={String(tiles)}></option>{/each}
          </datalist>
        </label>
      {/if}
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
  .lab.bare {
    margin: 0;
  }
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
