<script lang="ts">
  import { onMount } from 'svelte'
  import { errorCode, isUnreachable } from '../lib/api/errors'
  import type { CreatedInvite, InviteInfo } from '../lib/api/types'
  import { inviteCopy } from '../content/connected'
  import { api } from './account'
  import Icon from './Icon.svelte'

  /**
   * Invite a friend into your world: create a single-use code (shown once),
   * see the codes still waiting, revoke one. Needs the session, not the lease.
   */
  let invites = $state<InviteInfo[]>([])
  let loaded = $state(false)
  let fresh = $state<CreatedInvite | null>(null)
  let copied = $state(false)
  let busy = $state(false)
  let error = $state('')

  /** Active codes can be revoked; used ones are history (the list carries both). */
  const now = () => Date.now() / 1000
  const waiting = $derived(invites.filter((i) => !i.used && i.expiresAt > now()))
  const used = $derived(invites.filter((i) => i.used))
  const when = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  function explain(err: unknown): string {
    const code = errorCode(err)
    if (code === 'invite-limit') return inviteCopy.limit
    if (code === 'invite-budget') return inviteCopy.budget
    if (code === 'player-flagged') return inviteCopy.flagged
    if (code === 'unauthorized') return inviteCopy.signedOut
    if (isUnreachable(err)) return inviteCopy.offline
    return inviteCopy.failed
  }

  async function refresh(): Promise<void> {
    try {
      invites = await api.listInvites()
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
  <p class="fine">{inviteCopy.intro}</p>

  {#if fresh}
    <div class="code-card" data-testid="invite-code">
      <span class="label"><Icon name="key" size={14} /> {inviteCopy.shownOnce}</span>
      <div class="code-row">
        <code>{fresh.code}</code>
        <button type="button" class="primary" onclick={copy}>{copied ? inviteCopy.copied : inviteCopy.copy}</button>
      </div>
    </div>
  {/if}

  <div class="row">
    <button type="button" onclick={create} disabled={busy}>
      <Icon name="key" size={14} /> {busy ? inviteCopy.creating : inviteCopy.create}
    </button>
  </div>

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
    padding: 8px 10px;
    font-family: ui-monospace, monospace;
    font-size: 12.5px;
    word-break: break-all;
    background: #fffbef;
    border: 2px solid var(--wood);
    border-radius: 8px;
    user-select: all;
    -webkit-user-select: all;
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
