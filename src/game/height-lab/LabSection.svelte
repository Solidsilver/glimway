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
    { key: 'fog', label: 'Climbing, the land below fades to', options: [{ value: 'fog', label: 'Fog' }, { value: 'sky', label: 'Sky' }, { value: 'none', label: 'Nothing' }] },
    { key: 'zoom', label: 'Climbing, the camera', options: [{ value: true, label: 'Eases out' }, { value: false, label: 'Stays' }] },
    { key: 'haze', label: 'Climbing, haze at the edges', options: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] },
    { key: 'cave', label: 'In a cave', options: [{ value: 'lantern', label: 'Close light' }, { value: 'wide', label: 'Wide light' }, { value: 'dim', label: 'All dim' }] },
    { key: 'grid', label: 'Levels overlay', options: [{ value: false, label: 'Off' }, { value: true, label: 'On' }] }
  ]
</script>

<section class="lab" data-testid="dev-height-lab">
  <h3 class="section-title"><Icon name="stone" size={14} /> Height lab</h3>
  <p class="what">A hand-made valley, plateau, mountain shoulder and cave, to try real levels. It doesn’t save or send anything.</p>
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
