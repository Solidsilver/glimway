<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { HOME_EV, homesteadsFor } from '../game/homestead'
  import { bus } from '../game/events'
  import { assetKey, assetName, assetPhrase, mailBuckets, movableAssets, settledLine } from '../lib/village'
  import { giftPhrase } from '../lib/items'
  import { MAIL } from '../lib/mail'
  import type { Asset, Mail } from '../lib/api/types'
  import { focusTrap } from './focus'
  import { home } from './home.svelte'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'

  // The mailbox at your place: parcels for you to collect, sending to a
  // neighbour in your world, and what you've sent (recall it while it waits).
  let { session, to = null, onClose }: { session: Session; to?: string | null; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  const homes = $derived(homesteadsFor(session))
  let tab = $state<'box' | 'send'>('box')
  let version = $state(0)
  let busy = $state<string | null>(null)
  let message = $state<{ text: string; kind: 'ok' | 'error' } | null>(null)
  let recipient = $state('')
  let pick = $state('')
  let qty = $state(1)

  onMount(() => {
    if (to) {
      tab = 'send'
      recipient = to
    }
    const bump = () => (version += 1)
    bus.on(VILLAGE_EV.changed, bump)
    bus.on(HOME_EV.changed, bump)
    void village.loadMail()
    if (homes.gates.length === 0) void homes.load()
    return () => {
      bus.off(VILLAGE_EV.changed, bump)
      bus.off(HOME_EV.changed, bump)
    }
  })

  const me = $derived(session.link?.habiticaId ?? '')
  const view = $derived.by(() => {
    void version
    const neighbours = homes.neighbours()
    const goods = movableAssets(village.inventory)
    const buckets = mailBuckets(village.mail, me)
    const pendingParcels = buckets.outgoing.filter((m) => m.asset.kind !== 'thanks')
    return { buckets, neighbours, goods, status: village.mailStatus, recall: !village.recallUnsupported, more: !!village.mailCursor, full: pendingParcels.length >= MAIL.maxOutstandingSent }
  })
  const chosen = $derived(view.goods.find((g) => assetKey(g) === pick) ?? null)

  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  const when = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  async function claim(m: Mail): Promise<void> {
    if (busy) return
    busy = m.id
    message = null
    const r = await village.claim(m.id)
    busy = null
    message = r.ok
      ? {
          text: m.asset.kind === 'thanks' ? `${m.fromName} used ${giftPhrase(m.asset.id, 1)} you made.` : `You collect ${assetPhrase(m.asset)} from ${m.fromName}.`,
          kind: 'ok'
        }
      : { text: r.text, kind: 'error' }
  }

  async function recall(m: Mail): Promise<void> {
    if (busy) return
    busy = m.id
    message = null
    const r = await village.recall(m.id)
    busy = null
    message = r.ok ? { text: `${cap(assetPhrase(m.asset))} came back to you.`, kind: 'ok' } : { text: r.text, kind: 'error' }
  }

  async function send(): Promise<void> {
    if (busy || !chosen || !recipient) return
    const asset: Asset = { kind: chosen.kind, id: chosen.id, qty: Math.max(1, Math.min(chosen.qty, Math.round(qty) || 1)), ...(chosen.instance ? { instance: chosen.instance } : {}) }
    busy = 'send'
    message = null
    const r = await village.send(recipient, asset)
    busy = null
    const name = view.neighbours.find((n) => n.id === recipient)?.name ?? 'them'
    if (r.ok) {
      message = { text: `Sent ${assetPhrase(asset)} to ${name}. It waits in their mailbox.`, kind: 'ok' }
      pick = ''
      qty = 1
    } else message = { text: r.text, kind: 'error' }
  }

  function art(a: Asset): string | null {
    return a.kind === 'decoration' ? home.thumbs[a.id] ?? null : null
  }

  /** Materials, trinkets and crafted goods have delivered icons (src/ui/ArtIcon.svelte). */
  function icon(a: Pick<Asset, 'kind' | 'id'>): string | null {
    return a.kind === 'decoration' ? null : `icon-${a.id}`
  }
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="mail-title">
  <div class="panel" use:focusTrap>
    <button type="button" class="modal-close" onclick={onClose} aria-label="Close the mailbox"><Icon name="close" size={14} /></button>
    <h2 class="panel-title" id="mail-title"><Icon name="scroll" size={20} /> Mailbox</h2>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'box'} class:on={tab === 'box'} onclick={() => ((tab = 'box'), (message = null))}>
        Your mail{#if view.buckets.waiting.length}<span class="count">{view.buckets.waiting.length}</span>{/if}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'send'} class:on={tab === 'send'} onclick={() => ((tab = 'send'), (message = null))}>Send something</button>
    </div>
    {#if view.status === 'offline'}<p class="msg error">Needs a connection. The post goes when the road to your world is clear.</p>{/if}
    {#if message}<p class="msg {message.kind}" role="status">{message.text}</p>{/if}

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
            <button type="button" class="primary small" data-claim={m.id} disabled={busy !== null} onclick={() => claim(m)}>
              {busy === m.id ? (m.asset.kind === 'thanks' ? 'Reading…' : 'Opening…') : (m.asset.kind === 'thanks' ? 'Read' : 'Collect')}
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
            {#if view.recall && m.asset.kind !== 'thanks'}
              <button type="button" class="small" data-recall={m.id} disabled={busy !== null} onclick={() => recall(m)}>{busy === m.id ? 'Recalling…' : 'Recall'}</button>
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
            <button type="button" class="small" disabled={busy !== null} onclick={() => village.loadOlderMail()}>Older parcels</button>
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
        <p class="hint">Materials, things the Wilds gave back, crafted goods and pieces that aren’t set out can be posted. Embers and keepsakes stay with you. Uncollected parcels come back after {MAIL.returnAfterDays} days.</p>
        {#if view.goods.length === 0}<p class="none">Nothing in your pack to send.</p>{/if}
        <ul class="goods" aria-label="What to send">
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
        {:else if chosen}
          <div class="sendrow">
            <label class="field qty">
              <span>How many</span>
              <input type="number" min="1" max={chosen.qty} bind:value={qty} inputmode="numeric" data-testid="mail-qty" />
            </label>
            <button type="button" class="primary" disabled={busy !== null || !recipient} data-testid="mail-send" onclick={send}>
              {busy === 'send' ? 'Posting…' : `Send ${assetPhrase({ ...chosen, qty: Math.max(1, Math.min(chosen.qty, Math.round(qty) || 1)) })}`}
            </button>
          </div>
        {/if}
      {/if}
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
    background: rgba(107, 76, 46, 0.12);
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
    background: #fffbef;
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
</style>
