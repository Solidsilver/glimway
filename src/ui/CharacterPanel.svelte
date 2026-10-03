<script lang="ts">
  import { bus, EV, type StatsPayload } from '../game/events'
  import { DEMO_CHARACTER } from '../content/world'
  import { clearSave, exportSave, importSaveDocument, saveGame } from '../lib/save'
  import { createNewGame } from '../lib/state'
  import { syncProfile, vitalsSourceLabel } from '../lib/habitica/sync'
  import { getCombatKit } from '../lib/combat'
  import type { Session } from '../game/session'
  import { ui } from './store.svelte'
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

  let stats = $state<StatsPayload>({ ...ui.stats })
  // Tracks quest/inventory changes: advanceQuest replaces the state object.
  let snapshot = $derived(session.state)
  let importText = $state('')
  let importError = $state('')

  $effect(() => {
    const onStats = (p: StatsPayload) => (stats = p)
    bus.on(EV.stats, onStats)
    return () => bus.off(EV.stats, onStats)
  })

  // Keyboard open/close (C / Escape) is owned by App.svelte's global handler —
  // this panel has no key listeners of its own, so App's characterOpen flag
  // and uiState.panelOpen can never drift out of sync with this overlay.

  function close(): void {
    onClose()
  }

  async function copySave(): Promise<void> {
    // The session is the source of truth for provenance.
    const json = exportSave(session!.state, {
      vitalsSource: session!.vitalsSource,
      importedProfile: session!.importedProfile ?? undefined
    })
    try {
      await navigator.clipboard.writeText(json)
      ui.toast({ text: 'Save code copied to clipboard.' })
    } catch {
      importText = json
      ui.toast({ text: 'Clipboard unavailable — save code placed in the import box.' })
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
          importError = 'Restoring failed — the save could not be written.'
        })
    } catch {
      importError = 'That save code could not be read.'
    }
  }

  function resetDemo(): void {
    if (!window.confirm('Reset the demo? Story progress, discoveries and enemies are cleared.')) return
    // Invalidate in-flight syncs first, then clear + write the fresh save
    // (a corrupt record refuses silent overwrite; clearSave resets that).
    session.destroy(true)
    clearSave()
      .then(() => saveGame(createNewGame(), { overwriteCorrupt: true, vitalsSource: 'demo', importedProfile: null }))
      .then(() => window.location.reload())
      .catch(() => ui.toast({ text: 'Reset failed — the save could not be written.', kind: 'error' }))
  }

  // ---- Habitica connect (real read-only adapter; credentials in memory only) ----

  type ConnectionState = 'disconnected' | 'connected' | 'syncing' | 'error'

  let connection = $state<ConnectionState>(isConnected() ? 'connected' : 'disconnected')
  let userId = $state('')
  let apiToken = $state('')
  let connectionError = $state('')
  let setupNotice = $state(creatorId() === null)
  /** Shared in-flight guard: one sync (real or sample) at a time, and its
   * persistence is awaited — never a dangling write racing the user. */
  let syncBusy = $state(false)
  const provenanceLabel = $derived(vitalsSourceLabel(ui.vitalsSource))
  /** Live combat kit for the CURRENT provenance (demo starter or imported class). */
  const kit = $derived(getCombatKit(ui.importedProfile))

  /** Safety gate: sync only in a quiet village — before network and after. */
  function syncBlocker(): string | null {
    const safety = (window as unknown as {
      __fsSafety?: () => { areaId: string; transitioning: boolean; dialogueOpen: boolean; enemiesNear: boolean }
    }).__fsSafety?.()
    if (!safety) return 'The world is still loading.'
    if (safety.areaId !== 'village') return 'Return to Hearthwick to sync.'
    if (safety.transitioning) return 'Finish moving between areas first.'
    if (safety.dialogueOpen) return 'Finish the conversation first.'
    if (safety.enemiesNear) return 'Not while creatures are near.'
    return null
  }

  function connect(): void {
    connectionError = ''
    if (!userId.trim() || !apiToken.trim()) {
      connectionError = 'Both a user id and an API token are required.'
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
      connectionError = 'Connect first — credentials stay in memory until you Disconnect.'
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
        connectionError = 'That sync was cancelled (the journey changed). Nothing was applied.'
        return
      }

      // Post-response gate: scene-transient conditions only (the shared
      // syncProfile owns boundary/account rejections).
      const late = (window as unknown as { __fsSafety?: () => { transitioning: boolean; dialogueOpen: boolean; enemiesNear: boolean } }).__fsSafety?.()
      if (late && (late.transitioning || late.dialogueOpen || late.enemiesNear)) {
        connection = 'error'
        connectionError = 'Sync finished, but the world changed mid-flight. Press Sync again from a quiet Hearthwick.'
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
          ? 'That Habitica account is a different character. Start a New journey (or Reset demo) to switch accounts.'
          : 'Sync only applies in the village (safe boundary). The save is unchanged.'
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
            connectionError = 'Your profile was read, but saving the updated baseline failed locally — press Sync again once saving works.'
            return
          } else if (applied === 'stale') {
            connection = isConnected() ? 'connected' : 'disconnected'
            connectionError = 'That sync was cancelled (the journey changed). Nothing was applied.'
            return
          }
        }
        ui.toast({ text: 'Profile unchanged — no refill applied.' })
        return
      }

      // Persist first; the runtime commits only after a successful save.
      const applied = await session.applySynced(result.save, generation)
      if (applied === 'committed') {
        ui.vitalsSource = 'imported'
        ui.importedProfile = profile
        connection = 'connected'
        ui.toast({ text: result.notes[0] ?? 'Character imported — vitals now follow your Habitica profile.' })
      } else if (applied === 'stale') {
        connection = isConnected() ? 'connected' : 'disconnected'
        connectionError = 'That sync was cancelled (the journey changed). Nothing was applied.'
      } else {
        connection = 'error'
        connectionError = 'Your character was read, but saving failed locally — the world kept its previous state. Try again once saving works.'
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
      connectionError = 'Sample imports follow the same rules: return to Hearthwick first.'
      return
    }
    syncBusy = true
    try {
      const applied = await session.applySynced(result.save, generation)
      if (applied === 'committed') {
        ui.vitalsSource = 'imported'
        ui.importedProfile = sample.profile
        ui.toast({ text: `Sample character loaded: ${sample.profile.name}.` })
      } else if (applied === 'save-failed') {
        connectionError = 'The sample character was built, but saving failed locally — the world kept its previous state.'
      } else if (applied === 'stale') {
        connectionError = 'That import was cancelled (the journey changed). Nothing was applied.'
      }
    } finally {
      syncBusy = false
    }
  }
</script>

<div class="overlay" role="dialog" aria-label="Character sheet">
    <div class="panel" style="position:relative">
      <button type="button" class="modal-close" onclick={close} aria-label="Close character sheet">×</button>
      <h2 class="panel-title">{DEMO_CHARACTER.name} — {provenanceLabel}</h2>
      {#if ui.importedProfile}
        <p class="note">
          Imported from Habitica: {ui.importedProfile.name}, level {ui.importedProfile.level}
          {ui.importedProfile.class ? `(${ui.importedProfile.class})` : '(no class selected)'}.
          Vitals come from the last import; gameplay here never touches your account.
        </p>
      {:else}
        <p class="note">Demo adventurer — a sensible starter kit standing in for a future Habitica import. No account data is used.</p>
      {/if}

      <div class="cols">
        <section>
          <h3>Stats</h3>
          <ul class="stats">
            <li><b>STR</b> {ui.importedProfile?.stats.str ?? DEMO_CHARACTER.stats.str}</li>
            <li><b>INT</b> {ui.importedProfile?.stats.int ?? DEMO_CHARACTER.stats.int}</li>
            <li><b>CON</b> {ui.importedProfile?.stats.con ?? DEMO_CHARACTER.stats.con}</li>
            <li><b>PER</b> {ui.importedProfile?.stats.per ?? DEMO_CHARACTER.stats.per}</li>
          </ul>
          <p class="note">Imported stats are effective values (gear and level included, via the bundled Habitica gear catalog).</p>
          <h3>Vitals</h3>
          <p class="vitals">HP {stats.hp}/{stats.maxHp} · Mana {stats.mana}/{stats.maxMana}</p>
          <p class="note">Damage, healing and mana are local to this adventure. Nothing here touches Habitica. Mana returns slowly over time; sync and reload never reset it.</p>
          <h3>Abilities</h3>
          <ul class="stats">
            <li><b>{kit.basicName}</b> ~{kit.meleeDamage} dmg</li>
            <li><b>{kit.signatureName}</b> ~{kit.signatureDamage} dmg</li>
            <li><b>Cost</b> {kit.manaCost} mana</li>
            <li><b>Recovery</b> {kit.cooldown}s</li>
            <li><b>Guard</b> {Math.round(kit.mitigation * 100)}% of damage blocked</li>
            <li><b>Critical</b> {Math.round(kit.critChance * 100)}% chance (2×)</li>
            {#if kit.healAmount > 0}
              <li><b>Mend</b> heals ~{kit.healAmount}</li>
            {/if}
          </ul>
          <p class="note">
            {kit.class ? `Class kit: ${kit.class}.` : 'Classless starter kit — pick a class on Habitica to change it.'}
            Numbers derive from effective stats (gear and level included) and stay bounded for extreme imports.
          </p>
        </section>
        <section>
          <h3>Inventory</h3>
          {#if snapshot.inventory.length === 0}
            <p class="empty">Nothing yet.</p>
          {:else}
            <ul class="list">
              {#each snapshot.inventory as item}
                <li>{item}</li>
              {/each}
            </ul>
          {/if}
          <h3>Discoveries</h3>
          {#if snapshot.discoveries.length === 0}
            <p class="empty">None noted yet.</p>
          {:else}
            <ul class="list">
              {#each snapshot.discoveries as disc}
                <li>{disc}</li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>

      <h3>Save backup</h3>
      <p class="note">Saves live in this browser (IndexedDB). Copy the save code to back it up or move it by hand — provenance travels with it; it never contains credentials.</p>
      <div class="saverow">
        <button type="button" onclick={copySave}>Copy save code</button>
        <button type="button" onclick={resetDemo}>Reset demo</button>
      </div>
      <textarea bind:value={importText} rows="3" placeholder="Paste a save code here to restore it…" aria-label="Import save code" onkeydown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}></textarea>
      {#if importError}<p class="error">{importError}</p>{/if}
      <div class="saverow">
        <button type="button" onclick={applyImport} disabled={importText.trim().length === 0}>Restore from code</button>
      </div>

      {#if setupNotice}
        <h3>Connect Habitica <span class="flag">setup needed</span></h3>
        <p class="error">Live connection is disabled: no creator id is configured (VITE_HABITICA_CREATOR_ID). A sample import is available below.</p>
        <div class="saverow">
          <button type="button" onclick={sampleImport} disabled={syncBusy}>Load a sample character</button>
        </div>
      {:else}
        <h3>Connect Habitica</h3>
        <p class="note">Optional. Read-only: credentials stay in this tab's memory until you Disconnect — never saved, exported, or logged. Syncing is one explicit request per press, in a quiet Hearthwick. Disconnect stays available during a sync and cancels it.</p>
        {#if connection === 'disconnected' || connection === 'error'}
          <label class="field">
            <span>User ID</span>
            <input type="text" bind:value={userId} autocomplete="off" spellcheck="false" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" onkeydown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }} />
          </label>
          <label class="field">
            <span>API Token</span>
            <input type="password" bind:value={apiToken} autocomplete="off" placeholder="••••••••••••" onkeydown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }} />
          </label>
          <div class="saverow">
            <button type="button" onclick={connect}>Connect</button>
            <button type="button" onclick={sampleImport} disabled={syncBusy}>Load a sample character</button>
          </div>
        {:else if connection === 'syncing'}
          <p class="vitals">Syncing character…</p>
          <div class="saverow">
            <button type="button" disabled>Sync character</button>
            <!-- Disconnect stays available mid-sync: it cancels the in-flight
                 sync (generation guard + durable rollback protect the save). -->
            <button type="button" onclick={disconnect}>Disconnect</button>
          </div>
        {:else}
          <p class="vitals">Account connected (memory only).</p>
          <div class="saverow">
            <button type="button" onclick={syncCharacter} disabled={syncBusy}>Sync character</button>
            <button type="button" onclick={disconnect}>Disconnect</button>
          </div>
        {/if}
        {#if connectionError}
          <p class="error">{connectionError}</p>
        {/if}
      {/if}
      <p class="note credits">
        Avatar and companion art derived from Habitica (habitica.com), © HabitRPG / Weirdly Wonderful,
        licensed CC BY-NC-SA 3.0; gear statistics derived from Habitica content data (GPL v3).
      </p>
    </div>
  </div>

<style>
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  @media (max-width: 520px) {
    .cols { grid-template-columns: 1fr; }
  }
  h3 {
    margin: 8px 0 4px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--wood-dark);
  }
  .stats {
    list-style: none;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 10px;
    padding: 0;
    margin: 0;
    font-size: 13px;
  }
  .vitals { font-size: 13px; margin: 0; }
  .note { font-size: 11px; color: #6a5a48; line-height: 1.4; }
  .empty { font-size: 12px; color: #8a7a5a; font-style: italic; }
  .list {
    margin: 0;
    padding-left: 16px;
    font-size: 13px;
  }
  .saverow {
    display: flex;
    gap: 8px;
    margin: 8px 0;
    flex-wrap: wrap;
  }
  .flag {
    font-size: 9px;
    color: #8a7a5a;
    border: 1px solid #b8a888;
    border-radius: 4px;
    padding: 1px 5px;
    vertical-align: middle;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 6px 0;
    font-size: 12px;
    color: var(--wood-dark);
  }
  .field input {
    font: inherit;
    padding: 6px 8px;
    border: 2px solid var(--wood);
    border-radius: 6px;
    background: #fffbeF;
    color: var(--ink);
  }
  textarea {
    width: 100%;
    font: inherit;
    font-size: 11px;
    border: 2px solid var(--wood);
    border-radius: 6px;
    padding: 6px;
    background: #fffbeF;
    resize: vertical;
  }
  .error { color: var(--danger); font-size: 12px; }
  .credits { margin-top: 12px; font-size: 10px; }
</style>
