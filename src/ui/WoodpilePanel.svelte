<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { bus } from '../game/events'
  import { countOf } from '../lib/village'
  import type { WoodpileView } from '../lib/api/types'
  import { focusTrap } from './focus'
  import { sheet } from './sheet'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'

  // The woodpile (docs/items/crafting-and-repair.md): green timber stacked
  // here seasons after a real day ("Green wood sinks, dry wood sings").
  // Needs a woodpile set out at home.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  let version = $state(0)
  let loaded = $state<'loading' | 'ready' | string>('loading')
  let busy = $state<string | null>(null)
  let message = $state<{ text: string; kind: 'ok' | 'error' } | null>(null)
  let view = $state<WoodpileView | null>(null)
  let stackQty = $state(10)
  let timer: ReturnType<typeof setInterval> | null = null

  onMount(() => {
    const bump = () => (version += 1)
    bus.on(VILLAGE_EV.changed, bump)
    const reread = async (): Promise<void> => {
      const r = await village.loadWoodpile()
      if (r.ok) {
        view = r.value
        loaded = 'ready'
      } else if (loaded === 'loading') loaded = r.code
    }
    void reread()
    // The seasoning clock ticks in real days; refresh now and then while open.
    timer = setInterval(() => void reread(), 30_000)
    return () => {
      bus.off(VILLAGE_EV.changed, bump)
      if (timer) clearInterval(timer)
    }
  })

  const timber = $derived.by(() => {
    void version
    return countOf(village.inventory, 'material', 'timber')
  })

  function waitLine(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.ceil((seconds % 3600) / 60)
    if (h >= 1) return `about ${h}h ${m}m more`
    return `about ${Math.max(1, m)}m more`
  }

  async function stack(): Promise<void> {
    if (busy) return
    const q = Math.min(Math.max(1, Math.floor(stackQty) || 1), Math.min(1000, timber))
    busy = 'stack'
    message = null
    const r = await village.woodpile('stack', q)
    busy = null
    if (r.ok) {
      stackQty = 10
      message = { text: `Stacked ${q} green timber. It seasons after a real day.`, kind: 'ok' }
    } else message = { text: r.text, kind: 'error' }
  }

  async function collect(stackId?: string): Promise<void> {
    if (busy) return
    busy = 'collect'
    message = null
    const r = await village.woodpile('collect', 1, stackId)
    busy = null
    message = r.ok
      ? { text: r.value.collectedQty ? `Took ${r.value.collectedQty} seasoned timber from the pile. Dry wood sings.` : 'Took the seasoned timber.', kind: 'ok' }
      : { text: r.text, kind: 'error' }
  }
</script>

<div class="overlay sheet" use:sheet={onClose} role="dialog" aria-modal="true" aria-labelledby="woodpile-title">
  <div class="panel" use:focusTrap>
    <header class="panel-head">
      <button type="button" class="modal-close" onclick={onClose} aria-label="Close the woodpile"><Icon name="close" size={14} /></button>
      <h2 class="panel-title" id="woodpile-title"><Icon name="home" size={20} /> The Woodpile</h2>
      {#if message}<p class="msg {message.kind}" role="status">{message.text}</p>{/if}
    </header>
    <p class="lede">“Green wood sinks, dry wood sings.” Stack green timber and it seasons after a real day. Fine work wants seasoned.</p>
    <p class="carried"><span><ArtIcon art="icon-timber" name="sparkle" size={16} /> {timber} green timber carried</span></p>
    {#if loaded !== 'ready'}
      <p class="msg">{loaded === 'loading' ? 'Counting the stack…' : loaded}</p>
    {:else if view}
      <div class="stackrow">
        <span class="batch">
          <button type="button" class="tiny" aria-label="Fewer" disabled={stackQty <= 1} onclick={() => (stackQty = Math.max(1, stackQty - 5))}>−</button>
          <span class="bn">{stackQty}</span>
          <button type="button" class="tiny" aria-label="More" disabled={stackQty >= Math.min(1000, timber)} onclick={() => (stackQty = Math.min(Math.min(1000, timber), stackQty + 5))}>+</button>
        </span>
        <button type="button" class="small" class:primary={timber > 0} data-stack disabled={busy !== null || timber < 1} onclick={stack}>
          {busy === 'stack' ? 'Stacking…' : `Stack green timber`}
        </button>
      </div>
      {#if view.stacks.length === 0}
        <p class="msg">The pile is empty. Stack green timber from the Wilds and give it a day.</p>
      {:else}
        <ul class="stacks">
          {#each view.stacks as s (s.id)}
            <li class="stack" class:ready={s.ready} data-stack-row={s.id}>
              <span class="qty">{s.qty} green timber</span>
              <span class="when">{s.ready ? 'Seasoned — ready to take' : waitLine(s.remaining)}</span>
              {#if s.ready}
                <button type="button" class="small" data-collect={s.id} disabled={busy !== null} onclick={() => collect(s.id)}>
                  {busy === 'collect' ? 'Taking…' : 'Take'}
                </button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if view.readyCount > 0}
          <p class="allrow">
            <button type="button" class="small primary" data-collect-all disabled={busy !== null} onclick={() => collect()}>
              {busy === 'collect' ? 'Taking…' : `Take all seasoned (${view.readyCount})`}
            </button>
          </p>
        {/if}
      {/if}
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
  .stackrow {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0 0 10px;
  }
  .batch {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }
  .bn {
    min-width: 2.2em;
    text-align: center;
    font-weight: 800;
  }
  .tiny {
    min-width: 34px;
    min-height: 30px;
    padding: 0 6px;
    font-size: 13px;
  }
  .small {
    padding: 5px 12px;
    font-size: 14px;
  }
  .stacks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .stack {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 7px 9px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.18);
    opacity: 0.8;
  }
  .stack.ready {
    opacity: 1;
    background: rgba(255, 255, 255, 0.32);
  }
  .qty {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .when {
    flex: 1;
    font-size: 13px;
    color: var(--text-soft);
  }
  .allrow {
    margin: 10px 0 0;
  }
</style>
