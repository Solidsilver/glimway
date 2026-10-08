<script lang="ts">
  import { onMount } from 'svelte'
  import { errorCode, isUnreachable } from '../lib/api/errors'
  import type { CreatedInvite, InviteInfo } from '../lib/api/types'
  import { inviteCodeParts } from '../lib/api/client'
  import { INVITE_LIFETIME, INVITE_LIMIT, inviteCopy } from '../content/connected'
  import { api } from './account'
  import Icon from './Icon.svelte'

  /**
   * Invite a friend into your world: create a single-use code (shown once),
   * see the codes still waiting, revoke one. Needs the session, not the lease.
   * The server's quota (lifetime codes left, how many may wait) shows up
   * front, so the limit is never a surprise.
   */
  let invites = $state<InviteInfo[]>([])
  /** Lifetime creations left (undefined before the initial load). */
  let remaining = $state<number | undefined>(undefined)
  let outstandingLimit = $state(INVITE_LIMIT)
  /** You live in a party's world: it takes no codes (the server refuses them too). */
  let partyWorld = $state(false)
  /** You came in through a party: you make no codes anywhere (the server refuses them too). */
  let partyAdmitted = $state(false)
  let loaded = $state(false)
  let fresh = $state<CreatedInvite | null>(null)
  let copied = $state(false)
  let busy = $state(false)
  let error = $state('')

  /** Active codes can be revoked; used ones are history (the list carries both). */
  const now = () => Date.now() / 1000
  const waiting = $derived(invites.filter((i) => !i.used && i.expiresAt > now()))
  const used = $derived(invites.filter((i) => i.used))
  const outOfBudget = $derived(remaining === 0)
  const atLimit = $derived(waiting.length >= outstandingLimit)
  const parts = $derived(fresh ? inviteCodeParts(fresh.code) : null)
  const when = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  function explain(err: unknown): string {
    const code = errorCode(err)
    if (code === 'invite-limit') return inviteCopy.limit(outstandingLimit)
    if (code === 'invite-budget') return inviteCopy.budget
    if (code === 'player-flagged') return inviteCopy.flagged
    if (code === 'party-world-invites') {
      partyWorld = true
      return ''
    }
    if (code === 'party-admitted-invites') {
      partyAdmitted = true
      return ''
    }
    if (code === 'unauthorized') return inviteCopy.signedOut
    if (isUnreachable(err)) return inviteCopy.offline
    return inviteCopy.failed
  }

  async function refresh(): Promise<void> {
    try {
      const list = await api.listInvites()
      invites = list.invites
      remaining = list.remaining
      outstandingLimit = list.outstandingLimit
      partyWorld = list.partyWorld
      partyAdmitted = list.partyAdmitted
      loaded = true
    } catch (err) {
      error = explain(err)
    }
  }

  async function create(): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    copied = false
    try {
      fresh = await api.createInvite()
      await refresh()
    } catch (err) {
      error = explain(err)
    } finally {
      busy = false
    }
  }

  async function copy(): Promise<void> {
    if (!fresh) return
    try {
      await navigator.clipboard.writeText(fresh.code)
      copied = true
    } catch {
      // The code stays visible and selectable.
      copied = false
    }
  }

  async function revoke(id: string): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try {
      await api.revokeInvite(id)
      if (fresh?.id === id) fresh = null
      await refresh()
    } catch (err) {
      error = explain(err)
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void refresh()
  })
</script>

<div class="invites">
  {#if partyAdmitted}
    <p class="fine" data-testid="invite-party-admitted">{inviteCopy.partyAdmitted}</p>
  {:else if partyWorld}
    <p class="fine" data-testid="invite-party-world">{inviteCopy.partyWorld}</p>
  {:else}
  <p class="fine">{inviteCopy.intro}</p>

  {#if remaining !== undefined}
    <div class="budget" data-testid="invite-budget">
      <span class="pips" aria-hidden="true">
        {#each Array.from({ length: INVITE_LIFETIME }) as _, i}<span class="pip" class:on={i < remaining}></span>{/each}
      </span>
      <span><strong>{inviteCopy.budgetLine(remaining, INVITE_LIFETIME)}</strong> · {inviteCopy.waitingLine(outstandingLimit)}</span>
    </div>
  {/if}

  {#if fresh}
    <div class="code-card" data-testid="invite-code">
      <span class="label"><Icon name="key" size={14} /> {inviteCopy.shownOnce}</span>
      <div class="code-row">
        <!-- Words as tiles; the hyphens stay in the text, so selecting it copies the real code. -->
        <code aria-label={`Invite code ${fresh.code}`}>
          {#if parts}
            {#each parts.words as w}<span class="w">{w}</span><span class="sep">-</span>{/each}<span class="n">{parts.number}</span>
          {/if}
        </code>
        <button type="button" class="primary" onclick={copy}>{copied ? inviteCopy.copied : inviteCopy.copy}</button>
      </div>
      <p class="hint">{inviteCopy.pasteHint}</p>
    </div>
  {/if}

  <div class="row">
    <button type="button" onclick={create} disabled={busy || outOfBudget || atLimit}>
      <Icon name="key" size={14} /> {busy ? inviteCopy.creating : inviteCopy.create}
    </button>
  </div>
  {#if !error && outOfBudget}
    <p class="tiny" data-testid="invite-why">{inviteCopy.budget}</p>
  {:else if !error && atLimit && loaded}
    <p class="tiny" data-testid="invite-why">{inviteCopy.limit(outstandingLimit)}</p>
  {/if}
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if loaded}
    <h4 class="sub">{inviteCopy.outstanding}</h4>
    {#if waiting.length === 0}
      <p class="tiny">{inviteCopy.none}</p>
    {:else}
      <ul class="list" aria-label={inviteCopy.outstanding}>
        {#each waiting as inv (inv.id)}
          <li>
            <span class="dot" aria-hidden="true"></span>
            <span class="meta">
              <span>{inviteCopy.created(when(inv.createdAt))}</span>
              <span class="exp">{inviteCopy.expires(when(inv.expiresAt))}</span>
            </span>
            <button type="button" class="ghost small" onclick={() => revoke(inv.id)} disabled={busy}>{inviteCopy.revoke}</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if used.length > 0}
      <h4 class="sub">{inviteCopy.usedTitle}</h4>
      <ul class="list used" aria-label={inviteCopy.usedTitle}>
        {#each used as inv (inv.id)}
          <li>
            <span class="dot" aria-hidden="true"></span>
            <span class="meta"><span>{inviteCopy.created(when(inv.createdAt))}</span></span>
            <span class="chip-used">{inviteCopy.used}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .fine {
    margin: 0 0 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    margin: 8px 0;
  }
  .row button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .code-card {
    margin: 6px 0 10px;
    padding: 10px 12px 12px;
    border-radius: 10px;
    border: 2px dashed var(--gold-deep);
    background: rgba(255, 210, 74, 0.2);
  }
  .label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--wood-dark);
  }
  .code-row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 8px;
  }
  code {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 0;
    padding: 7px 8px;
    font-family: var(--font-display);
    font-size: 15px;
    line-height: 1.2;
    background: #fffbef;
    border: 2px solid var(--wood);
    border-radius: 8px;
    user-select: all;
    -webkit-user-select: all;
  }
  code .w {
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--wood-dark);
    background: rgba(255, 210, 74, 0.32);
  }
  code .sep {
    width: 6px;
    color: transparent;
    overflow: hidden;
    font-size: 6px;
  }
  code .n {
    padding: 1px 6px;
    border-radius: 5px;
    color: #fff;
    background: var(--accent);
    letter-spacing: 0.06em;
  }
  .hint {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-soft);
  }
  .budget {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin: 0 0 6px;
    font-size: 13px;
    color: var(--text-soft);
  }
  .budget strong {
    color: var(--wood-dark);
  }
  .pips {
    display: inline-flex;
    gap: 3px;
  }
  .pip {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    border: 1.5px solid var(--wood);
    background: transparent;
  }
  .pip.on {
    background: var(--gold);
  }
  .sub {
    margin: 12px 0 4px;
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 600;
    color: var(--wood);
  }
  .list {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 6px 6px 10px;
    border-radius: 8px;
    background: rgba(255, 252, 240, 0.6);
    border: 1.5px solid var(--paper-line);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--gold-deep);
    flex: none;
  }
  .meta {
    flex: 1;
    display: flex;
    gap: 4px 12px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .exp {
    color: var(--text-faint);
  }
  .list.used li {
    opacity: 0.75;
  }
  .list.used .dot {
    background: var(--accent);
  }
  .chip-used {
    padding: 1px 8px;
    font-family: var(--font-display);
    font-size: 12px;
    border-radius: 999px;
    color: #fff;
    background: var(--accent);
  }
  .small {
    padding: 4px 10px;
    font-size: 13px;
  }
  .tiny {
    font-size: 12.5px;
    color: var(--text-faint);
    margin: 0;
  }
  .error {
    margin: 6px 0;
    padding: 8px 10px;
    font-size: 13.5px;
    color: #7a2e1e;
    background: rgba(196, 82, 58, 0.12);
    border-radius: 8px;
  }
</style>
