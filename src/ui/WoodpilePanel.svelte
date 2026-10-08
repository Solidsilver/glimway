<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { bus } from '../game/events'
  import { countOf } from '../lib/village'
  import type { WoodpileView } from '../lib/api/types'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'

  // The woodpile (docs/items/crafting-and-repair.md): green timber stacked
  // here seasons after a real day ("Green wood sinks, dry wood sings").
  // Needs a woodpile set out at home.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  const changed = busVersion(bus, VILLAGE_EV.changed)
  const action = actionRunner()
  let loaded = $state<'loading' | 'ready' | string>('loading')
  let view = $state<WoodpileView | null>(null)
  let stackQty = $state(10)
  let timer: ReturnType<typeof setInterval> | null = null

  onMount(() => {
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
      if (timer) clearInterval(timer)
    }
  })

  const timber = $derived.by(() => {
    void changed.value
    return countOf(village.inventory, 'material', 'timber')
  })

  function waitLine(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.ceil((seconds % 3600) / 60)
    if (h >= 1) return `about ${h}h ${m}m more`
    return `about ${Math.max(1, m)}m more`
  }

  async function stack(): Promise<void> {
    const q = Math.min(Math.max(1, Math.floor(stackQty) || 1), Math.min(1000, timber))
    const r = await action.run('stack', () => village.woodpile('stack', q), `Stacked ${q} green timber. It seasons after a real day.`)
    if (r?.ok) stackQty = 10
  }

  async function collect(stackId?: string): Promise<void> {
    await action.run('collect', () => village.woodpile('collect', 1, stackId), ({ value: v }) =>
      v.collectedQty ? `Took ${v.collectedQty} seasoned timber from the pile. Dry wood sings.` : 'Took the seasoned timber.'
    )
  }
</script>

<Panel id="woodpile" icon="home" title="The Woodpile" closeLabel="Close the woodpile" {onClose} message={action.message}>
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
      <button type="button" class="small" class:primary={timber > 0} data-stack disabled={action.busy !== null || timber < 1} onclick={stack}>
        {action.busy === 'stack' ? 'Stacking…' : `Stack green timber`}
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
              <button type="button" class="small" data-collect={s.id} disabled={action.busy !== null} onclick={() => collect(s.id)}>
                {action.busy === 'collect' ? 'Taking…' : 'Take'}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if view.readyCount > 0}
        <p class="allrow">
          <button type="button" class="small primary" data-collect-all disabled={action.busy !== null} onclick={() => collect()}>
            {action.busy === 'collect' ? 'Taking…' : `Take all seasoned (${view.readyCount})`}
          </button>
        </p>
      {/if}
    {/if}
  {/if}
</Panel>

<style>
  .stackrow {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0 0 10px;
  }
  .bn {
    min-width: 2.2em;
    text-align: center;
    font-weight: 800;
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
