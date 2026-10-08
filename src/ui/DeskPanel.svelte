<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { villageFor } from '../game/village'
  import { bus, EV } from '../game/events'
  import { countOf } from '../lib/village'
  import { itemDef, itemName } from '../lib/items'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'

  // The writing desk (docs/items/crafting-and-repair.md): copies of any
  // recipe page you hold, 1 fiber a copy, to give away. Needs a writing
  // desk set out at home.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  const changed = busVersion(bus, EV.villageChanged)
  const action = actionRunner()
  let loaded = $state<'loading' | 'ready'>('loading')
  let copies = $state<Record<string, number>>({})

  onMount(() => {
    void village.loadStorage().then((r) => {
      loaded = r.ok ? 'ready' : 'loading'
    })
  })

  /** The recipe pages you carry, by item id. */
  const pages = $derived.by(() => {
    void changed.value
    return Object.keys(village.inventory?.items ?? {})
      .filter((id) => itemDef(id)?.kind === 'paper')
      .sort()
  })

  const fiber = $derived.by(() => {
    void changed.value
    return countOf(village.inventory, 'material', 'fiber')
  })

  function chosen(id: string): number {
    return Math.min(Math.max(1, copies[id] ?? 1), 100)
  }

  async function copy(pageId: string): Promise<void> {
    const n = chosen(pageId)
    const name = itemName(pageId)
    const r = await action.run(`copy:${pageId}`, () => village.deskCopy(pageId, n), `Copied ${n === 1 ? 'the page' : `${n} pages`} — ${n} fresh ${n === 1 ? 'copy' : 'copies'} of the ${name.toLowerCase()}, your mark on each.`)
    if (r?.ok) copies = { ...copies, [pageId]: 1 }
  }
</script>

<Panel id="desk" icon="scroll" title="The Writing Desk" closeLabel="Close the desk" {onClose} message={action.message}>
  <p class="lede">A slant-top desk, a jar of quills, rag paper. Choose a page you carry and strike copies to give away — one fiber each, your mark on every copy.</p>
  <p class="carried"><span><ArtIcon art="icon-fiber" name="sparkle" size={16} /> {fiber} fiber carried</span></p>
  {#if loaded !== 'ready'}
    <p class="msg">Dipping the quill…</p>
  {:else if pages.length === 0}
    <p class="msg" data-testid="no-pages">You don’t carry any recipe pages. Find them, or receive one from a neighbour, and the desk can copy it.</p>
  {:else}
    <ul class="pages">
      {#each pages as id (id)}
        {@const held = countOf(village.inventory, 'item', id)}
        <li class="page" data-page={id}>
          <span class="thumb" aria-hidden="true"><ArtIcon art={`icon-${id}`} name="scroll" size={32} /></span>
          <span class="txt">
            <span class="name">{itemName(id)}</span>
            <span class="can">You hold {held} · {chosen(id)} cop{chosen(id) === 1 ? 'y' : 'ies'} · {chosen(id)} fiber</span>
          </span>
          <span class="go">
            {#if fiber > 1}
              <span class="batch">
                <button type="button" class="tiny" aria-label="Fewer" disabled={chosen(id) <= 1} onclick={() => (copies = { ...copies, [id]: chosen(id) - 1 })}>−</button>
                <span class="bn">{chosen(id)}</span>
                <button type="button" class="tiny" aria-label="More" disabled={chosen(id) >= Math.min(100, fiber)} onclick={() => (copies = { ...copies, [id]: chosen(id) + 1 })}>+</button>
              </span>
            {/if}
            <button type="button" class="small" class:primary={fiber > 0} data-copy={id} disabled={action.busy !== null || fiber < 1} onclick={() => copy(id)}>
              {action.busy === `copy:${id}` ? 'Copying…' : 'Copy'}
            </button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</Panel>

<style>
  .pages {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .page {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 7px 9px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.28);
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
