<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { villageFor } from '../game/village'
  import { homesteadsFor } from '../game/homestead'
  import { bus, EV } from '../game/events'
  import { assetKey, assetName, assetPhrase, mailBuckets, movableAssets, settledLine } from '../lib/village'
  import { giftPhrase } from '../lib/items'
  import { MAIL } from '../lib/mail'
  import type { Asset, AssetView, Mail } from '../lib/api/types'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import { home } from './home.svelte'
  import Icon from './Icon.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import PurseAmount from './PurseAmount.svelte'
  import { ui } from './store.svelte'
  import { purseCopy } from '../content/purse'
  import Glim from './Glim.svelte'
  import { parseAmount } from '../lib/purse'

  // The mailbox at your place: parcels for you to collect, sending to a
  // neighbour in your world, and what you've sent (recall it while it waits).
  let { session, to = null, onClose }: { session: Session; to?: string | null; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  const homes = $derived(homesteadsFor(session))
  let tab = $state<'box' | 'send'>('box')
  const changed = busVersion(bus, EV.villageChanged, EV.homeChanged)
  const action = actionRunner()
  let recipient = $state('')
  let pick = $state('')
  let qty = $state(1)

  onMount(() => {
    if (to) {
      tab = 'send'
      recipient = to
    }
    void village.loadMail()
    if (homes.gates.length === 0) void homes.load()
  })

  const me = $derived(session.link?.accountId ?? '')
  const view = $derived.by(() => {
    void changed.value
    const neighbours = homes.neighbours()
    const goods = movableAssets(village.inventory)
    const buckets = mailBuckets(village.mail, me)
    const pendingParcels = buckets.outgoing.filter((m) => m.asset.kind !== 'thanks')
    return { buckets, neighbours, goods, status: village.mailStatus, more: !!village.mailCursor, full: pendingParcels.length >= MAIL.maxOutstandingSent }
  })
  const chosen = $derived(view.goods.find((g) => assetKey(g) === pick) ?? null)
  /** Glims (silas-yard.md 1.6, a glim letter): the first row once you have some. */
  const GLIMS = 'glims'
  const haveGlims = $derived(ui.stats.glims)
  let glimsText = $state('')
  const glimsAmount = $derived(parseAmount(glimsText, haveGlims))

  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  const when = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  async function claim(m: Mail): Promise<void> {
    await action.run(m.id, () => village.claim(m.id), m.asset.kind === 'thanks' ? `${m.fromName} used ${giftPhrase(m.asset.id, 1)} you made.` : `You collect ${assetPhrase(m.asset)} from ${m.fromName}.`)
  }

  async function recall(m: Mail): Promise<void> {
    await action.run(m.id, () => village.recall(m.id), `${cap(assetPhrase(m.asset))} came back to you.`)
  }

  async function sendGlims(): Promise<void> {
    const n = glimsAmount
    if (n === null || !recipient) return
    const to = recipient
    const r = await action.run('send', () => village.sendGlims(to, n), () => purseCopy.mailSent(view.neighbours.find((x) => x.id === to)?.name ?? 'them', n))
    if (r?.ok) {
      pick = ''
      glimsText = ''
    }
  }

  async function send(): Promise<void> {
    if (!chosen || !recipient) return
    const asset: Asset = { kind: chosen.kind, id: chosen.id, qty: Math.max(1, Math.min(chosen.qty, Math.round(qty) || 1)), ...(chosen.instance ? { instance: chosen.instance } : {}) }
    const to = recipient
    const r = await action.run('send', () => village.send(to, asset), () => `Sent ${assetPhrase(asset)} to ${view.neighbours.find((n) => n.id === to)?.name ?? 'them'}. It waits in their mailbox.`)
    if (r?.ok) {
      pick = ''
      qty = 1
    }
  }

  function art(a: AssetView): string | null {
    return a.kind === 'decoration' ? home.thumbs[a.id] ?? null : null
  }

  /** Materials, trinkets and crafted goods have delivered icons (src/ui/ArtIcon.svelte); a glim letter shows a few glims. */
  function icon(a: Pick<AssetView, 'kind' | 'id'>): string | null {
    if (a.kind === 'glims') return 'glims-few'
    return a.kind === 'decoration' ? null : `icon-${a.id}`
  }
</script>

<Panel id="mail" icon="scroll" title="Mailbox" closeLabel="Close the mailbox" {onClose} message={action.message}>
  {#snippet head()}
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'box'} class:on={tab === 'box'} onclick={() => ((tab = 'box'), action.clear())}>
        Your mail{#if view.buckets.waiting.length}<span class="count">{view.buckets.waiting.length}</span>{/if}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'send'} class:on={tab === 'send'} onclick={() => ((tab = 'send'), action.clear())}>Send something</button>
    </div>
    {#if view.status === 'offline'}<p class="msg error">Needs a connection. The post goes when the road to your world is clear.</p>{/if}
  {/snippet}

  {#if tab === 'box'}
    <h3 class="section-title">Waiting for you</h3>
    {#if view.buckets.waiting.length === 0}<p class="none">No parcels. The flag is down.</p>{/if}
    <ul class="list">
      {#each view.buckets.waiting as m (m.id)}
        <li class="parcel" data-mail={m.id}>
          <span class="thumb">
            {#if m.asset.kind === 'thanks'}
              <Icon name="heart" size={16} />
            {:else if art(m.asset)}
              <img src={art(m.asset)} alt="" />
            {:else}
              <ArtIcon art={icon(m.asset)} name="sparkle" size={16} />
            {/if}
          </span>
          <span class="txt">
            {#if m.asset.kind === 'thanks'}
              <span class="what">{m.fromName} used {giftPhrase(m.asset.id, 1)} you made.</span>
              <span class="from">{when(m.sentAt)}</span>
            {:else}
              <span class="what">{assetPhrase(m.asset)}</span>
              <span class="from">from {m.fromName} · {when(m.sentAt)}</span>
            {/if}
          </span>
          <button type="button" class="primary small" data-claim={m.id} disabled={action.busy !== null} onclick={() => claim(m)}>
            {action.busy === m.id ? (m.asset.kind === 'thanks' ? 'Reading…' : 'Opening…') : (m.asset.kind === 'thanks' ? 'Read' : 'Collect')}
          </button>
        </li>
      {/each}
    </ul>
    <h3 class="section-title">You sent, still waiting</h3>
    {#if view.buckets.outgoing.length === 0}<p class="none">Nothing on its way.</p>{/if}
    <ul class="list">
      {#each view.buckets.outgoing as m (m.id)}
        <li class="parcel" data-sent={m.id}>
          <span class="thumb">{#if art(m.asset)}<img src={art(m.asset)} alt="" />{:else}<ArtIcon art={icon(m.asset)} name="sparkle" size={16} />{/if}</span>
          <span class="txt"><span class="what">{m.asset.kind === 'thanks' ? `Your thanks to ${m.toName} for ${giftPhrase(m.asset.id, 1)}` : assetPhrase(m.asset)}</span><span class="from">to {m.toName} · {when(m.sentAt)}</span></span>
          {#if m.asset.kind !== 'thanks'}
            <button type="button" class="small" data-recall={m.id} disabled={action.busy !== null} onclick={() => recall(m)}>{action.busy === m.id ? 'Recalling…' : 'Recall'}</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if view.buckets.history.length}
      <details>
        <summary>Settled ({view.buckets.history.length})</summary>
        <ul class="list history">
          {#each view.buckets.history as m (m.id)}
            <li class="line">
              {#if m.asset.kind === 'thanks' && m.fromId === me}
                Your thanks to {m.toName} for {giftPhrase(m.asset.id, 1)} ·
              {:else}
                {m.fromId === me ? `To ${m.toName}` : `From ${m.fromName}`}: {assetPhrase(m.asset)} ·
              {/if}
              {settledLine(m)}{m.claimedAt ? ` ${when(m.claimedAt)}` : m.returnedAt ? ` ${when(m.returnedAt)}` : ''}
            </li>
          {/each}
        </ul>
        {#if view.more}
          <button type="button" class="small" disabled={action.busy !== null} onclick={() => village.loadOlderMail()}>Older parcels</button>
        {/if}
      </details>
    {/if}
  {:else}
    {#if view.neighbours.length === 0}
      <p class="msg">No neighbours in your world yet. Invite a friend from the Menu.</p>
    {:else}
      <label class="field">
        <span>To</span>
        <select bind:value={recipient} data-testid="mail-to">
          <option value="" disabled>Choose a neighbour</option>
          {#each view.neighbours as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
        </select>
      </label>
      <p class="hint">Materials, things the Wilds gave back, crafted goods and pieces that aren’t set out can be posted, and glims. Keepsakes stay with you. Uncollected parcels come back after {MAIL.returnAfterDays} days.</p>
      {#if view.goods.length === 0 && haveGlims <= 0}<p class="none">Nothing in your pack to send.</p>{/if}
      <ul class="goods" aria-label="What to send" data-dirty={pick ? 'true' : undefined}>
        {#if haveGlims > 0}
          <li>
            <button type="button" class="good glims" class:on={pick === GLIMS} aria-pressed={pick === GLIMS} data-pick={GLIMS} data-testid="mail-glims" onclick={() => ((pick = GLIMS), (glimsText = ''))}>
              <span class="thumb"><Glim size={16} /></span>
              <span class="nm">{purseCopy.mailRow}</span>
              <span class="have">{haveGlims.toLocaleString('en-US')}</span>
            </button>
          </li>
        {/if}
        {#each view.goods as g (assetKey(g))}
          <li>
            <button type="button" class="good" class:on={pick === assetKey(g)} aria-pressed={pick === assetKey(g)} data-pick={assetKey(g)} onclick={() => ((pick = assetKey(g)), (qty = 1))}>
              <span class="thumb">{#if art(g)}<img src={art(g)} alt="" />{:else}<ArtIcon art={icon(g)} name="sparkle" size={16} />{/if}</span>
              <span class="nm">{assetName(g)}</span>
              <span class="have">{g.qty}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if view.full}
        <p class="msg error">You have {MAIL.maxOutstandingSent} parcels waiting to be collected. Recall one, or wait for some to be collected.</p>
      {:else if pick === GLIMS && haveGlims > 0}
        <div class="sendrow glims-row">
          <PurseAmount bind:value={glimsText} max={haveGlims} label={purseCopy.mailLabel} maxTitle={purseCopy.maxSendTitle} testid="mail-glims-amount" />
          <button type="button" class="primary" disabled={action.busy !== null || !recipient || glimsAmount === null} data-testid="mail-send" onclick={sendGlims}>
            {action.busy === 'send' ? 'Posting…' : purseCopy.mailSend(glimsAmount)}
          </button>
        </div>
      {:else if chosen}
        <div class="sendrow">
          <label class="field qty">
            <span>How many</span>
            <input type="number" min="1" max={chosen.qty} bind:value={qty} inputmode="numeric" data-testid="mail-qty" />
          </label>
          <button type="button" class="primary" disabled={action.busy !== null || !recipient} data-testid="mail-send" onclick={send}>
            {action.busy === 'send' ? 'Posting…' : `Send ${assetPhrase({ ...chosen, qty: Math.max(1, Math.min(chosen.qty, Math.round(qty) || 1)) })}`}
          </button>
        </div>
      {/if}
    {/if}
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
  .count {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--danger);
    color: #fff;
    font-size: 12px;
  }
  .section-title {
    text-transform: none;
    letter-spacing: 0.04em;
    font-size: 14px;
    margin-top: 10px;
  }
  .none {
    margin: 0 0 6px;
    font-size: 13.5px;
    color: var(--text-faint);
    font-style: italic;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .parcel {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 7px 9px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.3);
  }
  .thumb {
    flex: none;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 7px;
    background: var(--wood-wash);
    color: var(--wood);
  }
  .thumb img {
    image-rendering: pixelated;
    max-width: 30px;
    max-height: 30px;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .what {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .from {
    font-size: 12.5px;
    color: var(--text-soft);
  }
  .small {
    flex: none;
    padding: 5px 12px;
    font-size: 14px;
  }
  details {
    margin-top: 10px;
    font-size: 13px;
  }
  summary {
    cursor: pointer;
    color: var(--text-soft);
  }
  .history .line {
    color: var(--text-soft);
  }
  .field {
    display: grid;
    gap: 3px;
    font-size: 13px;
    font-weight: 700;
    color: var(--wood-dark);
  }
  .field select,
  .field input {
    font: inherit;
    font-weight: 600;
    padding: 6px 8px;
    border: 1.5px solid var(--wood);
    border-radius: 8px;
    background: var(--cream-hi);
    min-height: 38px;
  }
  .hint {
    margin: 8px 0;
    font-size: 12.5px;
    color: var(--text-soft);
  }
  .goods {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 6px;
  }
  .good {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 7px;
    font-family: var(--font-body);
    font-size: 13px;
    letter-spacing: 0;
    text-align: left;
  }
  .good.on {
    border-color: var(--gold-deep);
    background: #fff1c2;
    box-shadow: 0 0 0 2px var(--gold);
  }
  .good .nm {
    flex: 1;
    font-weight: 800;
    color: var(--wood-dark);
  }
  .have {
    font-weight: 800;
    color: var(--text-soft);
  }
  .sendrow {
    margin-top: 10px;
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .qty input {
    width: 6em;
  }
  /* The glim letter: the amount and Max, then Send, all full width on a phone (purse-and-wardrobe.md 8). */
  .glims-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    max-width: 360px;
  }
  .glims-row button {
    min-height: 44px;
  }
</style>
