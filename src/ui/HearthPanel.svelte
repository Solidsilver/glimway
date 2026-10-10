<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { villageFor } from '../game/village'
  import { bus, EV } from '../game/events'
  import { sfx } from '../game/sfx'
  import { batchesAffordable, costPhrase, effectiveBatches, recipeCost } from '../lib/village'
  import { HEARTH_RECIPES } from '../lib/workshop'
  import type { AssetView } from '../lib/api/types'
  import { itemName } from '../lib/items'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'

  // The cottage hearth (docs/items/crafting-and-repair.md): food, remedies
  // and oils, each batch carrying your maker's mark. Needs the Cottage
  // (tier 1). Found recipes open only once their page is held.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  const changed = busVersion(bus, EV.villageChanged)
  const action = actionRunner()
  let batches = $state<Record<string, number>>({})

  onMount(() => {
    void village.loadStorage()
  })

  const carried = $derived.by(() => {
    void changed.value
    return { ...(village.inventory?.materials ?? {}), ...(village.inventory?.items ?? {}) }
  })

  /** A found recipe is locked until its page is held. */
  const known = (page?: string): boolean => !page || (carried[page] ?? 0) > 0

  /** Every material the hearth recipes can ask for, in a steady order. */
  const hearthMaterials = $derived.by(() => {
    const ids = new Set<string>()
    for (const r of HEARTH_RECIPES) for (const m of Object.keys(r.materials)) ids.add(m)
    return [...ids].sort((a, b) => (a === 'water' ? -1 : b === 'water' ? 1 : a.localeCompare(b)))
  })

  async function craft(recipeId: string): Promise<void> {
    if (action.busy) return
    const recipe = HEARTH_RECIPES.find((x) => x.id === recipeId)
    if (!recipe) return
    // Exactly what the row shows: the chosen batch, clamped to what's affordable now.
    const n = effectiveBatches(batches[recipeId], batchesAffordable(recipe, carried))
    const r = await action.run(`craft:${recipeId}`, () => village.hearthCraft(recipeId, n), (done) => `Made ${phrase(done.value)} at the hearth, your mark on it. It’s in your pack.`)
    if (r?.ok) {
      sfx('craft')
      batches = { ...batches, [recipeId]: 1 }
    }
  }

  function phrase(a: AssetView): string {
    const name = itemName(a.id)
    if (a.qty === 1) return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`
    return `${a.qty} ${name}${name.endsWith('s') ? '' : 's'}`
  }
</script>

<Panel id="hearth" icon="ember" title="The Hearth" closeLabel="Close the hearth" {onClose} message={action.message}>
  <p class="lede">The kettle’s on and the griddle’s warm. Each batch takes the materials shown from what you carry, and everything made here carries your maker’s mark.</p>
  <p class="carried">You carry: {#each hearthMaterials as m (m)}<span><ArtIcon art={`icon-${m}`} name="sparkle" size={16} /> {carried[m] ?? 0} {itemName(m).toLowerCase()}</span>{/each}</p>
  <ul class="recipes">
    {#each HEARTH_RECIPES as r (r.id)}
      {@const can = batchesAffordable(r, carried)}
      {@const n = effectiveBatches(batches[r.id], can)}
      {@const learned = known(r.page)}
      <li class="recipe" class:can={can > 0 && learned} class:locked={!learned} data-recipe={r.id}>
        <span class="thumb" aria-hidden="true"><ArtIcon art={`icon-${r.output.id}`} name="sparkle" size={32} /></span>
        <span class="txt">
          <span class="name">{r.name}</span>
          {#if learned}
            <span class="cost">{costPhrase(recipeCost(r, n))}{n > 1 ? ` for ${n}` : ''}</span>
            <span class="can">{can > 0 ? `You can make ${can}` : 'Not enough materials'}</span>
          {:else}
            <span class="can">You never learned this recipe — {r.found}.</span>
          {/if}
        </span>
        <span class="go">
          {#if learned}
            {#if can > 1}
              <span class="batch">
                <button type="button" class="tiny" aria-label="Fewer" disabled={n <= 1} onclick={() => (batches = { ...batches, [r.id]: n - 1 })}>−</button>
                <span class="bn">{n}</span>
                <button type="button" class="tiny" aria-label="More" disabled={n >= can} onclick={() => (batches = { ...batches, [r.id]: n + 1 })}>+</button>
              </span>
            {/if}
            <button type="button" class="small" class:primary={can > 0} data-craft={r.id} disabled={action.busy !== null || can <= 0} onclick={() => craft(r.id)}>
              {action.busy === `craft:${r.id}` ? 'Making…' : 'Make'}
            </button>
          {:else}
            <span class="locked-tag" data-testid="locked">page not found</span>
          {/if}
        </span>
      </li>
    {/each}
  </ul>
</Panel>

<style>
  .recipes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .recipe {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 7px 9px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.18);
    opacity: 0.8;
  }
  .recipe.can {
    opacity: 1;
    background: rgba(255, 255, 255, 0.32);
  }
  .recipe.locked {
    opacity: 0.62;
    border-style: dashed;
  }
  .locked-tag {
    font-size: 12px;
    font-weight: 800;
    color: var(--text-soft);
    border: 2px dashed var(--paper-line);
    border-radius: 8px;
    padding: 3px 8px;
  }
  .thumb {
    flex: none;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--wood-wash);
    color: var(--wood);
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .name {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .cost {
    font-size: 13px;
    color: var(--text-soft);
  }
  .txt .can {
    font-size: 12px;
    color: var(--accent);
  }
  .go {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .bn {
    min-width: 1.6em;
    text-align: center;
    font-weight: 800;
  }
  .small {
    padding: 5px 12px;
    font-size: 14px;
  }
</style>
