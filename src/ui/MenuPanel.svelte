<script lang="ts">
  import { clearSave, exportSave, importSaveDocument, saveGame } from '../lib/save'
  import { createNewGame } from '../lib/state'
  import { syncProfile } from '../lib/habitica/sync'
  import type { Session } from '../game/session'
  import { setMuted, sfx } from '../game/sfx'
  import { ui } from './store.svelte'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import {
    connectedClient,
    connectSession,
    creatorId,
    disconnectSession,
    fixtureProfiles,
    friendlyErrorCopy,
    isConnected
  } from './habitica-local'

  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  let importText = $state('')
  let importError = $state('')
  let confirmReset = $state(false)

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

  // ---- Habitica connect (real read-only adapter; credentials in memory only) ----

  type ConnectionState = 'disconnected' | 'connected' | 'syncing' | 'error'

  let connection = $state<ConnectionState>(isConnected() ? 'connected' : 'disconnected')
  let userId = $state('')
  let apiToken = $state('')
  let connectionError = $state('')
  const setupNotice = creatorId() === null
  /** Shared in-flight guard: one sync (real or sample) at a time, and its
   * persistence is awaited — never a dangling write racing the user. */
  let syncBusy = $state(false)

  /** Safety gate: sync only in a quiet village — before network and after. */
  function syncBlocker(): string | null {
    const safety = (window as unknown as {
      __fsSafety?: () => { areaId: string; transitioning: boolean; dialogueOpen: boolean; enemiesNear: boolean }
    }).__fsSafety?.()
    if (!safety) return 'The world is still waking up — try again in a moment.'
    if (safety.areaId !== 'village') return 'Head back to Hearthwick first — syncing only happens somewhere safe.'
    if (safety.transitioning) return 'Finish walking through the gate first.'
    if (safety.dialogueOpen) return 'Finish your conversation first.'
    if (safety.enemiesNear) return 'Not with creatures this close!'
    return null
  }

  function connect(): void {
    connectionError = ''
    if (!userId.trim() || !apiToken.trim()) {
      connectionError = 'We need both your User ID and your API Token.'
      return
    }
    connectSession(userId.trim(), apiToken.trim())
    userId = ''
    apiToken = ''
    connection = 'connected'
  }

  async function syncCharacter(): Promise<void> {
    const client = connectedClient()
    if (!client) {
      connection = 'disconnected'
      connectionError = 'Connect first — your details stay in this tab until you disconnect.'
      return
    }
    if (syncBusy) return
    const generation = session.currentGeneration
    const blocker = syncBlocker()
    if (blocker) {
      connectionError = blocker
      return
    }
    connection = 'syncing'
    connectionError = ''
    syncBusy = true
    try {
      // One explicit GET per press. Ordinary gameplay never reaches here.
      const profile = await client.fetchProfile()

      // Race guard first: a disconnect/reset during the fetch cancels the
      // sync entirely — no status updates without a live connection.
      if (!isConnected() || session.currentGeneration !== generation) {
        connection = isConnected() ? 'connected' : 'disconnected'
        connectionError = 'That sync was cancelled because your journey changed. Nothing was applied.'
        return
      }

      // Post-response gate: scene-transient conditions only (the shared
      // syncProfile owns boundary/account rejections).
      const late = (window as unknown as { __fsSafety?: () => { transitioning: boolean; dialogueOpen: boolean; enemiesNear: boolean } }).__fsSafety?.()
      if (late && (late.transitioning || late.dialogueOpen || late.enemiesNear)) {
        connection = 'error'
        connectionError = 'Something happened mid-sync. Try again from a quiet spot in Hearthwick.'
        return
      }

      // Shared reconciliation: first import replaces demo vitals; later syncs
      // credit external deltas exactly once; boundary/account rules enforced.
      const result = syncProfile(
        { state: session.state, vitalsSource: session.vitalsSource, importedProfile: session.importedProfile ?? undefined },
        profile,
        { atSafeBoundary: true }
      )

      if (result.status === 'rejected') {
        connection = 'error'
        connectionError = result.reason === 'account-switch'
          ? 'That’s a different Habitica character than this journey’s. Start over to switch heroes.'
          : 'Syncing only works in Hearthwick. Your save is unchanged.'
        return
      }
      if (result.status === 'unchanged') {
        connection = 'connected'
        // The shared logic may still advance the stored baseline (capped
        // deltas): persist it and await the outcome — no dangling write.
        const baselineMoved = JSON.stringify(result.save.importedProfile ?? null) !== JSON.stringify(session.importedProfile)
        if (baselineMoved) {
          const applied = await session.applySynced(result.save, generation)
          if (applied === 'committed') {
            ui.importedProfile = result.save.importedProfile ?? null
          } else if (applied === 'save-failed') {
            connection = 'error'
            connectionError = 'We read your character, but couldn’t save here. Try again in a moment.'
            return
          } else if (applied === 'stale') {
            connection = isConnected() ? 'connected' : 'disconnected'
            connectionError = 'That sync was cancelled because your journey changed. Nothing was applied.'
            return
          }
        }
        ui.toast({ text: 'All caught up — nothing new on Habitica.' })
        return
      }

      // Persist first; the runtime commits only after a successful save.
      const firstImport = session.vitalsSource !== 'imported'
      const applied = await session.applySynced(result.save, generation)
      if (applied === 'committed') {
        ui.vitalsSource = 'imported'
        ui.importedProfile = profile
        connection = 'connected'
        ui.toast({
          text: firstImport
            ? `Welcome to Hearthwick, ${profile.name}! Your Habitica health and mana travel with you.`
            : `Synced — ${profile.name} is up to date.`,
          icon: 'person'
        })
      } else if (applied === 'stale') {
        connection = isConnected() ? 'connected' : 'disconnected'
        connectionError = 'That sync was cancelled because your journey changed. Nothing was applied.'
      } else {
        connection = 'error'
        connectionError = 'We read your character, but couldn’t save here — nothing changed. Try again in a moment.'
      }
    } catch (err) {
      connectionError = friendlyErrorCopy(err)
      connection = 'error'
    } finally {
      syncBusy = false
    }
  }

  function disconnect(): void {
    // Ends the sync session: an in-flight sync must not commit after this.
    // If its write already landed, applySynced's stale path re-persists the
    // current intent durably (session still owns persistence here).
    session.markReset()
    disconnectSession()
    connectionError = ''
    connection = 'disconnected'
  }

  /** Offline demo of the import pipeline (no network, no credentials). Same
   * village gate and one-at-a-time rule as the real sync. */
  async function sampleImport(): Promise<void> {
    if (syncBusy) return
    const blocker = syncBlocker()
    if (blocker) {
      connectionError = blocker
      return
    }
    const generation = session.currentGeneration
    const sample = fixtureProfiles().find((f) => f.key === 'lowLevel') ?? fixtureProfiles()[0]
    const result = syncProfile(
      { state: session.state, vitalsSource: session.vitalsSource, importedProfile: session.importedProfile ?? undefined },
      sample.profile,
      { atSafeBoundary: true }
    )
    if (result.status === 'rejected') {
      connectionError = 'Sample heroes follow the same rules: head back to Hearthwick first.'
      return
    }
    syncBusy = true
    try {
      const applied = await session.applySynced(result.save, generation)
      if (applied === 'committed') {
        ui.vitalsSource = 'imported'
        ui.importedProfile = sample.profile
        ui.toast({ text: `${sample.profile.name} steps into Hearthwick.`, icon: 'person' })
      } else if (applied === 'save-failed') {
        connectionError = 'The sample hero is ready, but this browser wouldn’t save — nothing changed.'
      } else if (applied === 'stale') {
        connectionError = 'That was cancelled because your journey changed. Nothing was applied.'
      }
    } finally {
      syncBusy = false
    }
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

    <section class="card">
      <h3 class="section-title"><Icon name="person" size={14} /> Play as your Habitica hero</h3>
      {#if setupNotice}
        <p class="fine">Live Habitica connection isn’t switched on in this build, but you can still try a sample hero to see how it works.</p>
        <div class="row">
          <button type="button" onclick={sampleImport} disabled={syncBusy}>Try a sample hero</button>
        </div>
        <p class="tiny">Builders: set VITE_HABITICA_CREATOR_ID to enable live connection.</p>
      {:else}
        <p class="fine">Optional and read-only: we only <em>look</em> at your character, never change it. Your details stay in this tab until you disconnect — never saved, exported or logged. Sync from Hearthwick.</p>
        {#if connection === 'disconnected' || connection === 'error'}
          <label class="field">
            <span>User ID</span>
            <input type="text" bind:value={userId} autocomplete="off" spellcheck="false" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" onkeydown={keepKeys} />
          </label>
          <label class="field">
            <span>API Token</span>
            <input type="password" bind:value={apiToken} autocomplete="off" placeholder="••••••••••••" onkeydown={keepKeys} />
          </label>
          <div class="row">
            <button type="button" class="primary" onclick={connect}>Connect</button>
            <button type="button" onclick={sampleImport} disabled={syncBusy}>Try a sample hero</button>
          </div>
        {:else if connection === 'syncing'}
          <p class="status"><span class="spinner" aria-hidden="true"></span> Fetching your hero…</p>
          <div class="row">
            <button type="button" disabled>Sync character</button>
            <!-- Disconnect stays available mid-sync: it cancels the in-flight
                 sync (generation guard + durable rollback protect the save). -->
            <button type="button" onclick={disconnect}>Disconnect</button>
          </div>
        {:else}
          <p class="status"><span class="ok"><Icon name="check" size={12} /></span> Connected for this tab.</p>
          <div class="row">
            <button type="button" class="primary" onclick={syncCharacter} disabled={syncBusy}>Sync character</button>
            <button type="button" onclick={disconnect}>Disconnect</button>
          </div>
        {/if}
      {/if}
      {#if connectionError}
        <p class="error" role="alert">{connectionError}</p>
      {/if}
    </section>

    <section class="card">
      <h3 class="section-title"><Icon name="star" size={14} /> Controls</h3>
      <dl class="keys">
        <div><dt><span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span></dt><dd>Walk (arrows work too)</dd></div>
        <div><dt><span class="kbd">E</span> <span class="kbd">Space</span></dt><dd>Talk, use, attack</dd></div>
        <div><dt><span class="kbd">F</span></dt><dd>Signature ability</dd></div>
        <div><dt><span class="kbd">J</span> <span class="kbd">C</span></dt><dd>Journal · Character</dd></div>
        <div><dt><span class="kbd">M</span></dt><dd>Ride your mount (Habitica heroes, outdoors)</dd></div>
        <div><dt><span class="kbd">Esc</span></dt><dd>Menu · close panels</dd></div>
      </dl>
    </section>

    <section class="card">
      <h3 class="section-title"><Icon name="lantern" size={14} /> About</h3>
      <p class="fine">Fingersnap plays entirely in your browser — no account needed, and your saves never leave this device.</p>
      <p class="tiny">
        Avatar and companion art derived from Habitica (habitica.com), © HabitRPG / Weirdly Wonderful,
        licensed CC BY-NC-SA 3.0; gear statistics derived from Habitica content data (GPL v3).
      </p>
      <div class="row">
        <button type="button" class="danger" onclick={() => (confirmReset = true)}>Start over…</button>
      </div>
    </section>
  </div>
</div>

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
  .field {
    display: grid;
    gap: 4px;
    margin: 8px 0;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--wood-dark);
  }
  input,
  textarea {
    font: inherit;
    font-family: var(--font-body);
    font-size: 14px;
    width: 100%;
    padding: 8px 10px;
    border: 2px solid var(--wood);
    border-radius: 8px;
    background: #fffbef;
    color: var(--text);
    user-select: text;
    -webkit-user-select: text;
  }
  textarea {
    resize: vertical;
    font-size: 12.5px;
  }
  .error {
    margin: 6px 0;
    padding: 8px 10px;
    font-size: 13.5px;
    color: #7a2e1e;
    background: rgba(196, 82, 58, 0.12);
    border-radius: 8px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    font-weight: 700;
  }
  .ok {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 3px solid var(--paper-line);
    border-top-color: var(--wood);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
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
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (max-width: 560px) {
    .keys div {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
