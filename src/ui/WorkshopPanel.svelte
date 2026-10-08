<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { villageFor } from '../game/village'
  import { bus, EV } from '../game/events'
  import { assetName, assetPhrase, batchesAffordable, effectiveBatches, costPhrase, countOf, MATERIAL_IDS, movableDecorations, RECIPES, recipeCost } from '../lib/village'
  import type { Asset, ChestId } from '../lib/api/types'
  import { HOMESTEAD_DATA } from '../lib/homestead'
  import { itemName } from '../lib/items'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import { home } from './home.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'

  // The workshop at home: the chests (carried ⇄ stored: the shared home
  // chest, or your own small one that goes with you if you leave the deed)
  // and the crafting bench (recipes from content/crafting.json). Needs the Workshop.
  let { session, mode, initialChest = 'shared', onClose }: { session: Session; mode: 'chest' | 'bench'; initialChest?: ChestId; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  let tab = $state<'chest' | 'bench'>('chest')
  const changed = busVersion(bus, EV.villageChanged)
  const action = actionRunner()
  let loaded = $state<'loading' | 'ready' | string>('loading')
  let batches = $state<Record<string, number>>({})
  let chest = $state<ChestId>('shared')

  onMount(() => {
    tab = mode
    chest = initialChest
    void village.loadStorage().then((r) => {
      loaded = r.ok ? 'ready' : r.text
      // No shared chest here (no home, or no Workshop yet): your own chest still opens.
      if (r.ok && village.shared !== 'open') chest = 'personal'
    })
  })

  /** The shared chest and the bench need a Workshop home; your own chest never does. */
  const sharedOpen = $derived.by(() => {
    void changed.value
    return village.shared === 'open'
  })
  const homeless = $derived.by(() => {
    void changed.value
    return village.shared === 'not-a-member'
  })

  const view = $derived.by(() => {
    void changed.value
    const inv = village.inventory
    const sto = chest === 'shared' ? village.storage : village.personal
    const rows: { kind: Asset['kind']; id: string; carried: number; stored: number }[] = []
    const add = (kind: Asset['kind'], id: string, carried: number, stored: number) => {
      if (carried > 0 || stored > 0) rows.push({ kind, id, carried, stored })
    }
    for (const id of MATERIAL_IDS) add('material', id, countOf(inv, 'material', id), countOf(sto, 'material', id))
    const items = new Set([...Object.keys(inv?.items ?? {}), ...Object.keys(sto?.items ?? {})])
    for (const id of [...items].sort()) add('item', id, countOf(inv, 'item', id), countOf(sto, 'item', id))
    const movable = movableDecorations(inv)
    const decos = new Set([...Object.keys(movable), ...Object.keys(sto?.decorations ?? {})])
    for (const id of [...decos].sort()) add('decoration', id, movable[id] ?? 0, countOf(sto, 'decoration', id))
    const own = village.personal
    const ownUnits = own ? [own.materials, own.items, own.decorations].reduce((n, m) => n + Object.values(m).reduce((a, b) => a + b, 0), 0) + (own.instances?.length ?? 0) : 0
    // Tools and gear, one by one.
    const tools = [
      ...(inv?.instances ?? []).map((i) => ({ instance: i, where: 'carried' as const })),
      ...(sto?.instances ?? []).map((i) => ({ instance: i, where: 'stored' as const }))
    ]
    return { rows, tools, carried: { ...(inv?.items ?? {}), ...(inv?.materials ?? {}) }, ownUnits }
  })

  async function moveInstance(direction: 'deposit' | 'withdraw', id: string, instance: string): Promise<void> {
    await action.run(`${direction}:instance:${instance}`, () => village.move(direction, { kind: 'instance', id, qty: 1, instance }, chest), () =>
      `${direction === 'deposit' ? 'Stored' : 'Took out'} the ${itemName(id).toLowerCase()}${chest === 'personal' ? ' (your own chest)' : ''}.`
    )
  }

  async function move(direction: 'deposit' | 'withdraw', kind: Asset['kind'], id: string, qty: number): Promise<void> {
    if (qty <= 0) return
    const asset = { kind, id, qty }
    await action.run(`${direction}:${kind}:${id}`, () => village.move(direction, asset, chest), () =>
      `${direction === 'deposit' ? 'Stored' : 'Took out'} ${assetPhrase(asset)}${chest === 'personal' ? ' (your own chest)' : ''}.`
    )
  }

  async function craft(recipeId: string): Promise<void> {
    if (action.busy) return
    const recipe = RECIPES.find((x) => x.id === recipeId)
    if (!recipe) return
    // Exactly what the row shows: the chosen batch, clamped to what's affordable now.
    const n = effectiveBatches(batches[recipeId], batchesAffordable(recipe, view.carried))
    const r = await action.run(`craft:${recipeId}`, () => village.craft(recipeId, n), ({ value: made }) => `Made ${assetPhrase(made)}. ${made.kind === 'decoration' ? 'Arrange it at your place.' : 'It’s in your pack.'}`)
    if (r?.ok) batches = { ...batches, [recipeId]: 1 }
  }

  const steps = (n: number) => [...new Set([1, 5, n].filter((v) => v > 0 && v <= n))]
</script>

<Panel id="workshop" icon="home" title="The Workshop" closeLabel="Close the workshop" {onClose} message={action.message}>
  {#snippet head()}
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'chest'} class:on={tab === 'chest'} onclick={() => ((tab = 'chest'), action.clear())}>Chests</button>
      <button type="button" role="tab" aria-selected={tab === 'bench'} class:on={tab === 'bench'} onclick={() => ((tab = 'bench'), action.clear())}>Crafting bench</button>
    </div>

    {#if loaded !== 'ready' && loaded !== 'loading'}
      <p class="msg error">{loaded}</p>
    {:else if loaded === 'loading'}
      <p class="msg">Lifting the lid…</p>
    {/if}
  {/snippet}

  {#if tab === 'chest' && loaded === 'ready'}
    <div class="chests" role="radiogroup" aria-label="Which chest">
      <button type="button" role="radio" aria-checked={chest === 'shared'} class:on={chest === 'shared'} data-chest="shared" disabled={!sharedOpen} onclick={() => ((chest = 'shared'), action.clear())}>Home chest</button>
      <button type="button" role="radio" aria-checked={chest === 'personal'} class:on={chest === 'personal'} data-chest="personal" onclick={() => ((chest = 'personal'), action.clear())}>Your own chest · {view.ownUnits}/{HOMESTEAD_DATA.personalChest.maxUnits}</button>
    </div>
    {#if chest === 'shared'}
      <p class="lede">Oak and iron, waxed against the damp. Everyone on the deed can open it. What’s stored stays home; you can’t send it or build with it until you take it out.</p>
    {:else}
      <p class="lede">Your own small chest, with your mark burned in the lid. Only you open it, and it goes with you if you ever give up your place on the deed.</p>
      {#if homeless}<p class="msg" data-testid="homeless-chest">You have no place on a deed just now, so you can only take things out. Put things in again once you have a home.</p>{/if}
    {/if}
    {#if view.rows.length === 0}
      <p class="msg">Nothing to store yet. Bring things back from the Wilds.</p>
    {/if}
    <table class="goods">
      <thead><tr><th scope="col">Goods</th><th scope="col">Carried</th><th scope="col"></th><th scope="col">In the chest</th></tr></thead>
      <tbody>
        {#each view.rows as r (r.kind + r.id)}
          <tr data-goods={`${r.kind}:${r.id}`}>
            <th scope="row"><ArtIcon art={r.kind === 'decoration' ? null : `icon-${r.id}`} size={16} /> {assetName(r)}</th>
            <td class="n">{r.carried}</td>
            <td class="moves">
              <span class="dir">
                {#each chest === 'personal' && homeless ? [] : steps(r.carried) as q (q)}
                  <button type="button" class="tiny" data-store={`${r.id}:${q}`} disabled={action.busy !== null} onclick={() => move('deposit', r.kind, r.id, q)} aria-label={`Store ${q} ${assetName(r)}`}>{q === r.carried && q > 1 ? 'All' : q} ›</button>
                {/each}
              </span>
              <span class="dir">
                {#each steps(r.stored) as q (q)}
                  <button type="button" class="tiny" data-take={`${r.id}:${q}`} disabled={action.busy !== null} onclick={() => move('withdraw', r.kind, r.id, q)} aria-label={`Take out ${q} ${assetName(r)}`}>‹ {q === r.stored && q > 1 ? 'All' : q}</button>
                {/each}
              </span>
            </td>
            <td class="n">{r.stored}</td>
          </tr>
        {/each}
        {#each view.tools as t (t.instance.id)}
          <tr data-goods={`instance:${t.instance.id}`}>
            <th scope="row"><ArtIcon art={t.instance.itemDef} size={16} /> {itemName(t.instance.itemDef)}{t.instance.wardenSet ? (t.instance.condition === t.instance.maxCondition ? ' · Warden-set (sharp)' : t.instance.condition === 0 ? ' · Warden-set (dull)' : ` · Warden-set (${Math.round((100 * t.instance.condition) / t.instance.maxCondition)}%)`) : t.instance.maxCondition > 0 ? ` · ${Math.round((100 * t.instance.condition) / t.instance.maxCondition)}%` : ''}</th>
            <td class="n">{t.where === 'carried' ? 1 : 0}</td>
            <td class="moves">
              <span class="dir">
                {#if t.where === 'carried' && !(chest === 'personal' && homeless)}<button type="button" class="tiny" data-store={`instance:${t.instance.id}`} disabled={action.busy !== null} onclick={() => moveInstance('deposit', t.instance.itemDef, t.instance.id)} aria-label={`Store the ${itemName(t.instance.itemDef)}`}>1 ›</button>{/if}
              </span>
              <span class="dir">
                {#if t.where === 'stored'}<button type="button" class="tiny" data-take={`instance:${t.instance.id}`} disabled={action.busy !== null} onclick={() => moveInstance('withdraw', t.instance.itemDef, t.instance.id)} aria-label={`Take out the ${itemName(t.instance.itemDef)}`}>‹ 1</button>{/if}
              </span>
            </td>
            <td class="n">{t.where === 'stored' ? 1 : 0}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if tab === 'bench' && loaded === 'ready' && !sharedOpen}
    <p class="msg" data-testid="bench-closed">{homeless ? 'The bench is at home. You need a place on a deed, with a Workshop.' : 'The bench comes with the Workshop. Silas can build it on.'}</p>
  {:else if tab === 'bench' && loaded === 'ready'}
    <p class="lede">Clean tools, a heavy bench. Each batch takes the materials shown from what you carry.</p>
    <p class="carried">You carry: {#each MATERIAL_IDS as m (m)}<span><ArtIcon art={`icon-${m}`} size={16} /> {view.carried[m] ?? 0} {m}</span>{/each}</p>
    <ul class="recipes">
      {#each RECIPES as r (r.id)}
        {@const can = batchesAffordable(r, view.carried)}
        {@const n = effectiveBatches(batches[r.id], can)}
        <li class="recipe" class:can={can > 0} data-recipe={r.id}>
          <span class="thumb" aria-hidden="true">
            {#if r.output.kind === 'decoration' && home.thumbs[r.output.id]}<img src={home.thumbs[r.output.id]} alt="" />{:else}<ArtIcon art={`icon-${r.output.id}`} name="sparkle" size={32} />{/if}
          </span>
          <span class="txt">
            <span class="name">{r.name}</span>
            <span class="cost">{costPhrase(recipeCost(r, n))}{n > 1 ? ` for ${n}` : ''}</span>
            <span class="can">{can > 0 ? `You can make ${can}` : 'Not enough materials'}</span>
          </span>
          <span class="go">
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
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</Panel>

<style>
  .tabs {
    display: flex;
    gap: 6px;
    margin: 0 0 10px;
  }
  .tabs button {
    flex: 1;
    padding: 6px 8px;
  }
  .tabs button.on {
    background: #fff1c2;
    border-color: var(--gold-deep);
  }
  .chests {
    display: flex;
    gap: 6px;
    margin: 0 0 8px;
  }
  .chests button {
    flex: 1;
    padding: 4px 8px;
    font-size: 0.85em;
  }
  .chests button.on {
    background: #fff1c2;
    border-color: var(--gold-deep);
  }
  .goods {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .goods thead th {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 12.5px;
    color: var(--text-soft);
    text-align: left;
    padding-bottom: 4px;
  }
  .goods tbody th {
    text-align: left;
    font-weight: 800;
    color: var(--wood-dark);
    padding: 4px 4px 4px 0;
  }
  .goods td {
    padding: 3px 2px;
    border-top: 1px dashed var(--paper-line);
  }
  .goods tbody th {
    border-top: 1px dashed var(--paper-line);
  }
  .n {
    text-align: center;
    font-weight: 800;
    min-width: 2.4em;
  }
  .moves {
    display: grid;
    gap: 3px;
  }
  .dir {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }
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
  .thumb img {
    image-rendering: pixelated;
    max-width: 36px;
    max-height: 36px;
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
