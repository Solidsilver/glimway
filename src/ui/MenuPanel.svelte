<script lang="ts">
  import { clearSave, exportSave, importSaveDocument, saveGame } from '../lib/save'
  import { createNewGame } from '../lib/state'
  import type { Session } from '../game/session'
  import { setMuted, sfx } from '../game/sfx'
  import { ui } from './store.svelte'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import ConnectGuide from './ConnectGuide.svelte'
  import InvitePanel from './InvitePanel.svelte'
  import type { HabiticaProfile } from '../lib/habitica/types'
  import type { Snapshot } from '../lib/api/types'
  import { accountCopy, offlineCopy } from '../content/connected'

  let {
    session,
    onClose,
    onSignedIn,
    onLogout,
    onEnterWorld
  }: {
    session: Session
    onClose: () => void
    /** The guide signed in to the Fingersnap server (connected mode starts). */
    onSignedIn?: (snapshot: Snapshot, profile: HabiticaProfile) => void
    onLogout?: () => void
    /** Signed in but playing the guest save: switch to the world. */
    onEnterWorld?: () => void
  } = $props()

  let importText = $state('')
  let importError = $state('')
  let confirmReset = $state(false)
  let confirmLogout = $state(false)
  let logoutBusy = $state(false)

  /** Upload what's pending first, so the dialog says truthfully whether anything is unsent. */
  async function requestLogout(): Promise<void> {
    logoutBusy = true
    const link = session.link
    if (link?.online) await Promise.race([link.flush().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))])
    logoutBusy = false
    confirmLogout = true
  }
  /** Connected play: the world holds the save; export/restore and Start over are guest-only. */
  const connected = $derived(!!session.link)
  const offline = $derived(connected && ui.link?.status === 'offline')

  /** Text fields must not leak keys to the game (Phaser captures WASD/E/F). */
  const keepKeys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') e.stopPropagation()
  }

  function toggleSound(): void {
    const next = !ui.muted
    setMuted(next)
    ui.muted = next
    if (!next) sfx('click')
  }

  async function copySave(): Promise<void> {
    // The session is the source of truth for provenance.
    const json = exportSave(session.state, {
      vitalsSource: session.vitalsSource,
      importedProfile: session.importedProfile ?? undefined
    })
    try {
      await navigator.clipboard.writeText(json)
      ui.toast({ text: 'Save code copied — keep it somewhere safe.', icon: 'scroll' })
    } catch {
      importText = json
      ui.toast({ text: 'Clipboard said no, so the code is in the box below. Copy it from there.' })
    }
  }

  function applyImport(): void {
    try {
      const imported = importSaveDocument(importText)
      // Invalidate in-flight syncs BEFORE touching disk: a concurrent
      // applySynced must not land its write after the restore (reload would
      // undo it). destroy(true): the restore write below is authoritative.
      session.destroy(true)
      // Explicit restore — may overwrite a corrupt stored save on purpose;
      // provenance travels with the document. importedProfile: null on a demo
      // document explicitly clears a stored imported baseline.
      saveGame(imported.state, {
        overwriteCorrupt: true,
        vitalsSource: imported.vitalsSource,
        importedProfile: imported.importedProfile ?? null
      })
        .then(() => window.location.reload())
        .catch(() => {
          importError = 'That code looked right, but this browser wouldn’t let us save it.'
        })
    } catch {
      importError = 'Hmm, that doesn’t look like a Fingersnap save code.'
    }
  }

  function resetJourney(): void {
    confirmReset = false
    // Invalidate in-flight syncs first, then clear + write the fresh save
    // (a corrupt record refuses silent overwrite; clearSave resets that).
    session.destroy(true)
    clearSave()
      .then(() => saveGame(createNewGame(), { overwriteCorrupt: true, vitalsSource: 'demo', importedProfile: null }))
      .then(() => window.location.reload())
      .catch(() => ui.toast({ text: 'Couldn’t start over — this browser wouldn’t save.', kind: 'error' }))
  }
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="menu-title">
  <div class="panel" use:focusTrap>
    <button type="button" class="modal-close" onclick={onClose} aria-label="Close menu"><Icon name="close" size={14} /></button>
    <h2 class="panel-title" id="menu-title"><Icon name="menu" size={20} /> Menu</h2>

    <div class="quick">
      <button type="button" class="primary" onclick={onClose}>Back to the road</button>
      <button type="button" onclick={toggleSound} aria-pressed={!ui.muted}>
        <Icon name={ui.muted ? 'mute' : 'sound'} size={16} /> Sound {ui.muted ? 'off' : 'on'}
      </button>
    </div>

    {#if ui.account}
      <section class="card world" data-testid="world-card">
        <h3 class="section-title"><Icon name="lantern" size={14} /> {accountCopy.section}</h3>
        <p class="who"><strong>{accountCopy.signedInAs(ui.account.name)}</strong></p>
        {#if connected}
          <p class="fine">
            {#if offline}<span class="chip off"><Icon name="cloud" size={12} /> {ui.link?.trouble ? offlineCopy.troubleChip : offlineCopy.chip}</span>{/if}
            {offline ? (ui.link?.trouble ? accountCopy.savedTrouble : accountCopy.savedOffline) : accountCopy.saved}
          </p>
        {/if}
        <div class="row">
          {#if !connected && onEnterWorld}
            <button type="button" class="primary" onclick={onEnterWorld}>Play in your world</button>
          {/if}
          <button type="button" onclick={requestLogout} disabled={offline || logoutBusy} title={offline ? offlineCopy.needs : undefined}>{accountCopy.logout}</button>
          {#if offline}<span class="tiny inline">{offlineCopy.needs}</span>{/if}
        </div>
      </section>
    {/if}

    {#if !connected}
    <section class="card">
      <h3 class="section-title"><Icon name="scroll" size={14} /> Save & restore</h3>
      <p class="fine">Your journey saves itself in this browser as you play. Copy a save code to back it up or carry it to another device.</p>
      <div class="row">
        <button type="button" onclick={copySave}>Copy save code</button>
      </div>
      <textarea
        bind:value={importText}
        rows="3"
        placeholder="Paste a save code here to restore it…"
        aria-label="Save code to restore"
        onkeydown={keepKeys}
      ></textarea>
      {#if importError}<p class="error" role="alert">{importError}</p>{/if}
      <div class="row">
        <button type="button" onclick={applyImport} disabled={importText.trim().length === 0}>Restore this save</button>
      </div>
    </section>
    {/if}

    <section class="card">
      <h3 class="section-title"><Icon name="person" size={14} /> {connected ? 'Sync your Habitica hero' : 'Play as your Habitica hero'}</h3>
      <ConnectGuide {session} mode="menu" {onSignedIn} />
    </section>

    {#if ui.account}
      <section class="card" data-testid="invites-card">
        <h3 class="section-title"><Icon name="key" size={14} /> Invite a friend</h3>
        <InvitePanel />
      </section>
    {/if}

    <section class="card">
      <h3 class="section-title"><Icon name="star" size={14} /> Controls</h3>
      <dl class="keys">
        <div><dt><span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span></dt><dd>Walk (arrows work too)</dd></div>
        <div><dt><span class="kbd">E</span> <span class="kbd">Space</span></dt><dd>Talk, use, attack</dd></div>
        <div><dt><span class="kbd">F</span></dt><dd>Signature ability</dd></div>
        <div><dt><span class="kbd">Shift</span></dt><dd>Dodge roll — move when the enemy flashes white</dd></div>
        <div><dt><span class="kbd">J</span> <span class="kbd">C</span></dt><dd>Journal · Character</dd></div>
        <div><dt><span class="kbd">M</span></dt><dd>Ride your mount (Habitica heroes, outdoors)</dd></div>
        <div><dt><span class="kbd">Esc</span></dt><dd>Menu · close panels</dd></div>
      </dl>
    </section>

    <section class="card">
      <h3 class="section-title"><Icon name="lantern" size={14} /> About</h3>
      {#if connected}
        <p class="fine">Fingersnap plays in your browser. Your journey is kept in your world on the Fingersnap server; your Habitica token never is.</p>
      {:else}
        <p class="fine">Fingersnap plays entirely in your browser — no account needed, and your saves never leave this device.</p>
      {/if}
      <p class="tiny">
        Avatar and companion art derived from Habitica (habitica.com), © HabitRPG / Weirdly Wonderful,
        licensed CC BY-NC-SA 3.0; gear statistics derived from Habitica content data (GPL v3).
      </p>
      {#if !connected}
        <div class="row">
          <button type="button" class="danger" onclick={() => (confirmReset = true)}>Start over…</button>
        </div>
      {/if}
    </section>
  </div>
</div>

{#if confirmLogout}
  <ConfirmDialog
    title={accountCopy.logoutTitle}
    body={session.link?.dirty ? accountCopy.logoutDirty : accountCopy.logoutBody}
    confirmLabel={accountCopy.logout}
    onConfirm={() => {
      confirmLogout = false
      onLogout?.()
    }}
    onCancel={() => (confirmLogout = false)}
  />
{/if}

{#if confirmReset}
  <ConfirmDialog
    title="Start a brand-new journey?"
    body="Your story, discoveries and calmed creatures will be cleared. This can’t be undone — copy a save code first if you might want it back."
    confirmLabel="Start over"
    danger
    onConfirm={resetJourney}
    onCancel={() => (confirmReset = false)}
  />
{/if}

<style>
  .quick {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .quick button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .card {
    margin-top: 14px;
    padding: 4px 16px 14px;
    background: rgba(255, 255, 255, 0.32);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
  }
  .card .section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  .fine {
    margin: 0 0 10px;
  }
  .who {
    margin: 0 0 4px;
    font-size: 15px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 6px;
    padding: 1px 8px;
    border-radius: 999px;
    font-family: var(--font-display);
    font-size: 12px;
    vertical-align: 1px;
  }
  .chip.off {
    background: rgba(79, 134, 214, 0.16);
    color: #2c4f84;
    border: 1.5px solid rgba(79, 134, 214, 0.4);
  }
  .tiny.inline {
    align-self: center;
  }
  .tiny {
    font-size: 12px;
    color: var(--text-faint);
    line-height: 1.45;
  }
  .row {
    display: flex;
    gap: 8px;
    margin: 8px 0;
    flex-wrap: wrap;
  }
  textarea {
    font: inherit;
    font-family: var(--font-body);
    font-size: 12.5px;
    width: 100%;
    padding: 8px 10px;
    border: 2px solid var(--wood);
    border-radius: 8px;
    background: #fffbef;
    color: var(--text);
    resize: vertical;
    user-select: text;
    -webkit-user-select: text;
  }
  .error {
    margin: 6px 0;
    padding: 8px 10px;
    font-size: 13.5px;
    color: #7a2e1e;
    background: rgba(196, 82, 58, 0.12);
    border-radius: 8px;
  }
  .keys {
    display: grid;
    gap: 8px;
    margin: 0;
  }
  .keys div {
    display: grid;
    grid-template-columns: 150px 1fr;
    align-items: center;
    gap: 10px;
  }
  .keys dt {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .keys dd {
    margin: 0;
    font-size: 14px;
  }
  @media (max-width: 560px) {
    .keys div {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
