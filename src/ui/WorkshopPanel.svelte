<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { homesteadsFor } from '../game/homestead'
  import { bus } from '../game/events'
  import { assetName, assetPhrase, batchesAffordable, effectiveBatches, costPhrase, countOf, MATERIAL_IDS, movableDecorations, RECIPES, recipeCost } from '../lib/village'
  import type { Asset } from '../lib/api/types'
  import { focusTrap } from './focus'
  import { home } from './home.svelte'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'

  // The workshop at home: the storage chest (carried ⇄ stored) and the
  // crafting bench (recipes from content/crafting.json). Needs the Workshop.
  let { session, mode, onClose }: { session: Session; mode: 'chest' | 'bench'; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  let tab = $state<'chest' | 'bench'>('chest')
  let version = $state(0)
  let loaded = $state<'loading' | 'ready' | string>('loading')
  let busy = $state<string | null>(null)
  let message = $state<{ text: string; kind: 'ok' | 'error' } | null>(null)
  let batches = $state<Record<string, number>>({})

  onMount(() => {
    tab = mode
    const bump = () => (version += 1)
    bus.on(VILLAGE_EV.changed, bump)
    void village.loadStorage().then((r) => (loaded = r.ok ? 'ready' : r.text))
    return () => bus.off(VILLAGE_EV.changed, bump)
  })

  const view = $derived.by(() => {
    void version
    const placed = homesteadsFor(session).mine?.items ?? []
    const inv = village.inventory
    const sto = village.storage
    const rows: { kind: Asset['kind']; id: string; carried: number; stored: number }[] = []
    const add = (kind: Asset['kind'], id: string, carried: number, stored: number) => {
      if (carried > 0 || stored > 0) rows.push({ kind, id, carried, stored })
    }
    for (const id of MATERIAL_IDS) add('material', id, countOf(inv, 'material', id), countOf(sto, 'material', id))
    const items = new Set([...Object.keys(inv?.items ?? {}), ...Object.keys(sto?.items ?? {})])
    for (const id of [...items].sort()) add('item', id, countOf(inv, 'item', id), countOf(sto, 'item', id))
    const movable = movableDecorations(inv, placed)
    const decos = new Set([...Object.keys(movable), ...Object.keys(sto?.decorations ?? {})])
    for (const id of [...decos].sort()) add('decoration', id, movable[id] ?? 0, countOf(sto, 'decoration', id))
    return { rows, carried: inv?.materials ?? {} }
  })

  async function move(direction: 'deposit' | 'withdraw', kind: Asset['kind'], id: string, qty: number): Promise<void> {
    if (busy || qty <= 0) return
    busy = `${direction}:${kind}:${id}`
    message = null
    const asset = { kind, id, qty }
    const r = await village.move(direction, asset)
    busy = null
    message = r.ok ? { text: `${direction === 'deposit' ? 'Stored' : 'Took out'} ${assetPhrase(asset)}.`, kind: 'ok' } : { text: r.text, kind: 'error' }
  }

  async function craft(recipeId: string): Promise<void> {
    if (busy) return
    const recipe = RECIPES.find((x) => x.id === recipeId)
    if (!recipe) return
    // Exactly what the row shows: the chosen batch, clamped to what's affordable now.
    const n = effectiveBatches(batches[recipeId], batchesAffordable(recipe, view.carried))
    busy = `craft:${recipeId}`
    message = null
    const r = await village.craft(recipeId, n)
    busy = null
    if (r.ok) batches = { ...batches, [recipeId]: 1 }
    message = r.ok ? { text: `Made ${assetPhrase(r.value)}. ${r.value.kind === 'decoration' ? 'Arrange it at your place.' : 'It’s in your pack.'}`, kind: 'ok' } : { text: r.text, kind: 'error' }
  }

  const steps = (n: number) => [...new Set([1, 5, n].filter((v) => v > 0 && v <= n))]
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="workshop-title">
  <div class="panel" use:focusTrap>
    <button type="button" class="modal-close" onclick={onClose} aria-label="Close the workshop"><Icon name="close" size={14} /></button>
    <h2 class="panel-title" id="workshop-title"><Icon name="home" size={20} /> Your Workshop</h2>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'chest'} class:on={tab === 'chest'} onclick={() => ((tab = 'chest'), (message = null))}>Storage chest</button>
      <button type="button" role="tab" aria-selected={tab === 'bench'} class:on={tab === 'bench'} onclick={() => ((tab = 'bench'), (message = null))}>Crafting bench</button>
    </div>

    {#if loaded !== 'ready' && loaded !== 'loading'}
      <p class="msg error">{loaded}</p>
    {:else if loaded === 'loading'}
      <p class="msg">Lifting the lid…</p>
    {/if}
    {#if message}<p class="msg {message.kind}" role="status">{message.text}</p>{/if}

    {#if tab === 'chest' && loaded === 'ready'}
      <p class="lede">Oak and iron, waxed against the damp. What’s stored stays home; you can’t send it or build with it until you take it out.</p>
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
                  {#each steps(r.carried) as q (q)}
                    <button type="button" class="tiny" data-store={`${r.id}:${q}`} disabled={busy !== null} onclick={() => move('deposit', r.kind, r.id, q)} aria-label={`Store ${q} ${assetName(r)}`}>{q === r.carried && q > 1 ? 'All' : q} ›</button>
                  {/each}
                </span>
                <span class="dir">
                  {#each steps(r.stored) as q (q)}
                    <button type="button" class="tiny" data-take={`${r.id}:${q}`} disabled={busy !== null} onclick={() => move('withdraw', r.kind, r.id, q)} aria-label={`Take out ${q} ${assetName(r)}`}>‹ {q === r.stored && q > 1 ? 'All' : q}</button>
                  {/each}
                </span>
              </td>
              <td class="n">{r.stored}</td>
            </tr>
          {/each}
        </tbody>
      </table>
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
              <button type="button" class="small" class:primary={can > 0} data-craft={r.id} disabled={busy !== null || can <= 0} onclick={() => craft(r.id)}>
                {busy === `craft:${r.id}` ? 'Making…' : 'Make'}
              </button>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

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
  .lede {
    margin: 0 0 8px;
    font-size: 13.5px;
    color: var(--text-soft);
  }
  .msg {
    margin: 8px 0;
    padding: 7px 10px;
    border-radius: 8px;
    font-size: 13.5px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.4);
  }
  .msg.error {
    border-color: rgba(196, 82, 58, 0.6);
  }
  .msg.ok {
    border-color: rgba(47, 127, 122, 0.55);
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
  .tiny {
    min-width: 34px;
    min-height: 30px;
    padding: 0 6px;
    font-size: 13px;
  }
  .carried {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--text-soft);
  }
  .carried span {
    font-weight: 800;
    color: var(--wood-dark);
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
    background: rgba(107, 76, 46, 0.12);
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
  .batch {
    display: inline-flex;
    gap: 3px;
    align-items: center;
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
