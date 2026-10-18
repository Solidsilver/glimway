<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { itemsFor } from '../game/items'
  import { homesteadsFor } from '../game/homestead'
  import { homeErrorText } from '../content/errors'
  import type { RecoveryEntry } from '../lib/gen/glimway/v1/camps_pb.js'
  import { CRATE_WORDS, collectedLine, cratePick, crateRows } from '../lib/camps'
  import { actionRunner, latestRead } from './panel-state.svelte'
  import Panel from './Panel.svelte'

  // Pell's crate (lamps.md 2.7), opened from his desk: everything waiting
  // for you, entry by entry. Take one, or everything; a plant whole (its
  // growth kept) or as its seed. What you leave waits, with no end. The
  // server takes each entry once; the pack holds whatever is taken.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const action = actionRunner()
  const crate = latestRead<RecoveryEntry[]>(async () => {
    const r = await session.link?.recoveryRead()
    if (!r) return { ok: false, code: 'offline' }
    return r.ok ? { ok: true, value: r.value.entries } : r
  })
  const entries = $derived(crate.value)
  const rows = $derived(entries ? crateRows(entries) : [])

  onMount(() => {
    void crate.read()
    return () => crate.stop()
  })

  /**
   * The buttons stay held until the crate is read again: the server takes
   * each entry once, so a second press on a row still listed would come back
   * with nothing taken. What was taken leaves the list as the answer lands.
   */
  async function take(id: number | null, asSeed = false): Promise<void> {
    const link = session.link
    if (!link) return
    const busy = id === null ? 'all' : `${id}:${asSeed ? 'seed' : 'whole'}`
    await action.run(
      busy,
      async () => {
        const r = await link.recoveryCollect(cratePick(id, asSeed))
        if (r.ok && entries) {
          const taken = new Set(r.result.collected.map((e) => e.id))
          crate.adopt(entries.filter((e) => !taken.has(e.id)))
        }
        void itemsFor(session).load()
        void homesteadsFor(session).load()
        await crate.read()
        if (!r.ok) return { ok: false as const, text: homeErrorText(r.code) }
        return { ok: true as const, collected: r.result.collected }
      },
      (d) => collectedLine(d.collected)
    )
  }
</script>

<Panel id="crate" icon="home" title={CRATE_WORDS.title} closeLabel={CRATE_WORDS.close} {onClose} message={action.message} messageTestId="crate-message">
  <p class="lede">{CRATE_WORDS.lede}</p>
  {#if entries === null}
    <p class="msg">{crate.error === null ? CRATE_WORDS.loading : homeErrorText(crate.error)}</p>
  {:else if rows.length === 0}
    <p class="msg" data-crate-empty>{CRATE_WORDS.empty}</p>
  {:else}
    <ul class="rows">
      {#each rows as row (row.id)}
        <li class="row" data-crate-row={row.id}>
          <span class="what">
            <span class="label">{row.label}</span>
            <span class="note">{row.note}</span>
            {#if row.plant}<span class="note">{CRATE_WORDS.plantNote}</span>{/if}
          </span>
          {#if row.plant}
            <button type="button" class="small" data-take-whole={row.id} disabled={action.busy !== null} onclick={() => take(row.id)}>
              {action.busy === `${row.id}:whole` ? CRATE_WORDS.taking : CRATE_WORDS.takeWhole}
            </button>
            <button type="button" class="small" data-take-seed={row.id} disabled={action.busy !== null} onclick={() => take(row.id, true)}>
              {action.busy === `${row.id}:seed` ? CRATE_WORDS.taking : CRATE_WORDS.takeSeed}
            </button>
          {:else}
            <button type="button" class="small" data-take={row.id} disabled={action.busy !== null} onclick={() => take(row.id)}>
              {action.busy === `${row.id}:whole` ? CRATE_WORDS.taking : CRATE_WORDS.take}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="allrow">
      <button type="button" class="small primary" data-take-all disabled={action.busy !== null} onclick={() => take(null)}>
        {action.busy === 'all' ? CRATE_WORDS.taking : CRATE_WORDS.takeAll}
      </button>
    </p>
  {/if}
</Panel>

<style>
  .small {
    padding: 5px 12px;
    font-size: 14px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 7px 9px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.28);
  }
  .what {
    flex: 1 1 12em;
    display: grid;
    gap: 2px;
  }
  .label {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .note {
    font-size: 13px;
    color: var(--text-soft);
  }
  .allrow {
    margin: 10px 0 0;
  }
</style>
