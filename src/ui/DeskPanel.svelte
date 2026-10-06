<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { bus } from '../game/events'
  import { countOf } from '../lib/village'
  import { itemDef, itemName } from '../lib/items'
  import { focusTrap } from './focus'
  import { sheet } from './sheet'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'

  // The writing desk (docs/items/crafting-and-repair.md): copies of any
  // recipe page you hold, 1 fiber a copy, to give away. Needs a writing
  // desk set out at home.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  let version = $state(0)
  let loaded = $state<'loading' | 'ready'>('loading')
  let busy = $state<string | null>(null)
  let message = $state<{ text: string; kind: 'ok' | 'error' } | null>(null)
  let copies = $state<Record<string, number>>({})

  onMount(() => {
    const bump = () => (version += 1)
    bus.on(VILLAGE_EV.changed, bump)
    void village.loadStorage().then((r) => {
      loaded = r.ok ? 'ready' : 'loading'
    })
    return () => bus.off(VILLAGE_EV.changed, bump)
  })

  /** The recipe pages you carry, by item id. */
  const pages = $derived.by(() => {
    void version
    return Object.keys(village.inventory?.items ?? {})
      .filter((id) => itemDef(id)?.kind === 'paper')
      .sort()
  })

  const fiber = $derived.by(() => {
    void version
    return countOf(village.inventory, 'material', 'fiber')
  })

  function chosen(id: string): number {
    return Math.min(Math.max(1, copies[id] ?? 1), 100)
  }

  async function copy(pageId: string): Promise<void> {
    if (busy) return
    busy = `copy:${pageId}`
    message = null
    const n = chosen(pageId)
    const r = await village.deskCopy(pageId, n)
    busy = null
    if (r.ok) copies = { ...copies, [pageId]: 1 }
    const name = itemName(pageId)
    message = r.ok
      ? { text: `Copied ${n === 1 ? 'the page' : `${n} pages`} — ${n} fresh ${n === 1 ? 'copy' : 'copies'} of the ${name.toLowerCase()}, your mark on each.`, kind: 'ok' }
      : { text: r.text, kind: 'error' }
  }
</script>

<div class="overlay sheet" use:sheet={onClose} role="dialog" aria-modal="true" aria-labelledby="desk-title">
  <div class="panel" use:focusTrap>
    <header class="panel-head">
      <button type="button" class="modal-close" onclick={onClose} aria-label="Close the desk"><Icon name="close" size={14} /></button>
      <h2 class="panel-title" id="desk-title"><Icon name="scroll" size={20} /> The Writing Desk</h2>
      {#if message}<p class="msg {message.kind}" role="status">{message.text}</p>{/if}
    </header>
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
              <button type="button" class="small" class:primary={fiber > 0} data-copy={id} disabled={busy !== null || fiber < 1} onclick={() => copy(id)}>
                {busy === `copy:${id}` ? 'Copying…' : 'Copy'}
              </button>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
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
    background: rgba(107, 76, 46, 0.12);
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
  .tiny {
    min-width: 34px;
    min-height: 30px;
    padding: 0 6px;
    font-size: 13px;
  }
</style>
