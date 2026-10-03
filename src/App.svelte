<script lang="ts">
  import { onMount } from 'svelte'
  import type Phaser from 'phaser'
  import { bus, EV, type AreaPayload, type PromptPayload, type QuestPayload, type StatsPayload, type ToastPayload } from './game/events'
  import { ui } from './ui/store.svelte'
  import { Session } from './game/session'
  import { createNewGame } from './lib/state'
  import { clearSave, loadSaveRecord } from './lib/save'
  import { locations } from './content/world'
  import { startGame, stopGame } from './game/main'
  import { uiState } from './game/input'
  import Hud from './ui/Hud.svelte'
  import DialoguePanel from './ui/DialoguePanel.svelte'
  import JournalPanel from './ui/JournalPanel.svelte'
  import CharacterPanel from './ui/CharacterPanel.svelte'
  import TouchControls from './ui/TouchControls.svelte'
  import Toasts from './ui/Toasts.svelte'

  type Phase = 'loading' | 'title' | 'playing' | 'recovery'

  let phase = $state<Phase>('loading')
  let hasSave = $state(false)
  let journalOpen = $state(false)
  let characterOpen = $state(false)
  let recovery = $state<{ message: string; raw: string } | null>(null)
  let rawCopied = $state(false)

  let stageEl: HTMLDivElement
  let game: Phaser.Game | null = null
  let session = $state<Session | null>(null)

  function wireBus(): () => void {
    const onStats = (p: StatsPayload) => {
      ui.stats = p
    }
    const onQuest = (p: QuestPayload) => {
      const changed = ui.quest.stage !== p.stage
      ui.quest = p
      if (changed) ui.toast({ text: p.objective })
    }
    const onArea = (p: AreaPayload) => {
      const info = locations[p.areaId]
      ui.area = { areaId: p.areaId, name: info.name, description: info.description }
      if (phase === 'playing') ui.toast({ text: `— ${info.name} —` })
    }
    const onPrompt = (p: PromptPayload) => {
      ui.prompt = p
    }
    const onToast = (p: ToastPayload) => ui.toast(p)
    const onDefeat = () => {
      ui.defeatCount += 1
    }
    bus.on(EV.stats, onStats)
    bus.on(EV.quest, onQuest)
    bus.on(EV.area, onArea)
    bus.on(EV.prompt, onPrompt)
    bus.on(EV.toast, onToast)
    bus.on(EV.defeat, onDefeat)
    return () => {
      bus.off(EV.stats, onStats)
      bus.off(EV.quest, onQuest)
      bus.off(EV.area, onArea)
      bus.off(EV.prompt, onPrompt)
      bus.off(EV.toast, onToast)
      bus.off(EV.defeat, onDefeat)
    }
  }

  onMount(() => {
    const cleanupBus = wireBus()

    const onHide = () => session?.flushSync()
    const onVisibility = () => {
      if (document.hidden) onHide()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onHide)

    // No implicit fresh fallback: a corrupt or unreadable save surfaces a
    // recovery state that preserves the data until the player chooses.
    loadSaveRecord()
      .then((record) => {
        hasSave = record !== null
        ui.vitalsSource = record?.vitalsSource ?? 'demo'
        ui.importedProfile = record?.importedProfile ?? null
        session = new Session(record?.state ?? createNewGame(), {
          vitalsSource: record?.vitalsSource,
          importedProfile: record?.importedProfile
        })
        phase = 'title'
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        const raw = err && typeof err === 'object' && 'raw' in err && err.raw != null ? JSON.stringify((err as { raw: unknown }).raw, null, 1) : ''
        console.warn('[fingersnap] save could not be loaded', err)
        recovery = { message, raw }
        phase = 'recovery'
      })

    return () => {
      cleanupBus()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHide)
      session?.destroy()
      stopGame(game)
      game = null
    }
  })

  function begin(): void {
    if (!session || !stageEl || phase !== 'title') return
    phase = 'playing'
    game = startGame(stageEl, session)
  }

  function startFresh(): void {
    session?.destroy(true)
    session = new Session(createNewGame())
    hasSave = false
    ui.vitalsSource = 'demo'
    ui.importedProfile = null
    void session.save()
    begin()
  }

  async function copyRawSave(): Promise<void> {
    if (!recovery?.raw) return
    try {
      await navigator.clipboard.writeText(recovery.raw)
      rawCopied = true
    } catch {
      rawCopied = true // text stays visible in the details box
    }
  }

  async function discardAndReset(): Promise<void> {
    if (!window.confirm('Discard the unreadable save permanently? The corrupted data will be erased.')) return
    await clearSave()
    window.location.reload()
  }

  /** Explicit overwrite of a corrupt record with a fresh demo save. */
  async function overwriteAndStart(): Promise<void> {
    if (!window.confirm('Start a new journey now? This replaces the unreadable save with a fresh one (the corrupted data will not be recoverable).')) return
    const { saveGame } = await import('./lib/save')
    await saveGame(createNewGame(), { overwriteCorrupt: true })
    window.location.reload()
  }

  $effect(() => {
    uiState.panelOpen = journalOpen || characterOpen
  })

  /**
   * Single owner of panel open/close keys (J / C / Escape). Panels mount
   * already-open and close only through this state — their overlays and
   * uiState.panelOpen can never drift apart. Key events coming from text
   * fields (credentials, import codes) are ignored so typing never toggles.
   */
  function onKeyGlobal(e: KeyboardEvent): void {
    if (phase !== 'playing' || uiState.dialogueOpen) return
    const t = e.target as HTMLElement | null
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    // Typing J/C in a text field must never toggle panels — but Escape always
    // closes (standard dismiss UX, including from a focused field).
    if (typing && e.code !== 'Escape') return
    if (e.code === 'KeyJ') {
      journalOpen = !journalOpen
      if (journalOpen) characterOpen = false
    } else if (e.code === 'KeyC') {
      characterOpen = !characterOpen
      if (characterOpen) journalOpen = false
    } else if (e.code === 'Escape') {
      journalOpen = false
      characterOpen = false
    }
  }
</script>

<svelte:window onkeydown={onKeyGlobal} />

<main>
  <div class="stage" bind:this={stageEl}></div>

  {#if phase === 'playing'}
    <Hud
      onJournal={() => { journalOpen = !journalOpen; if (journalOpen) characterOpen = false }}
      onCharacter={() => { characterOpen = !characterOpen; if (characterOpen) journalOpen = false }}
    />
    {#if ui.prompt.label && !uiState.dialogueOpen && !uiState.panelOpen}
      <div class="prompt panel">{ui.prompt.label}</div>
    {/if}
    <DialoguePanel />
    <TouchControls />
    <Toasts />
    {#if journalOpen}
      <JournalPanel onClose={() => (journalOpen = false)} />
    {/if}
    {#if characterOpen && session}
      <CharacterPanel {session} onClose={() => (characterOpen = false)} />
    {/if}
  {/if}

  {#if phase === 'recovery' && recovery}
    <div class="title overlay">
      <div class="panel titlecard">
        <img class="hero-illus" src="/assets/fingersnap/fingersnap-village.png" alt="The village of Fingersnap" />
        <h1>Fingersnap</h1>
        <p class="error-title">Your saved journey could not be loaded.</p>
        <p class="note">{recovery.message}</p>
        <div class="choices">
          <button type="button" onclick={() => window.location.reload()}>Try again</button>
          {#if recovery.raw}
            <button type="button" onclick={copyRawSave}>{rawCopied ? 'Corrupted data shown below' : 'Copy corrupted save data'}</button>
          {/if}
          <button type="button" onclick={discardAndReset}>Discard save &amp; reload</button>
          <button type="button" onclick={overwriteAndStart}>Start a new journey now</button>
        </div>
        {#if recovery.raw}
          <details>
            <summary>Corrupted save data</summary>
            <textarea readonly rows="6">{recovery.raw}</textarea>
          </details>
        {/if}
      </div>
    </div>
  {/if}

  {#if phase !== 'playing' && phase !== 'recovery'}
    <div class="title overlay">
      <div class="panel titlecard">
        <img class="hero-illus" src="/assets/fingersnap/fingersnap-village.png" alt="The village of Fingersnap" />
        <h1>Fingersnap</h1>
        <p class="tag">A cozy lantern-restoring adventure — playable demo.</p>
        <p class="note">Runs entirely in your browser. No accounts, no credentials. The demo saves your journey locally.</p>
        {#if phase === 'loading'}
          <p class="status">Lighting the lamps…</p>
        {:else}
          <div class="choices">
            {#if hasSave}
              <button type="button" class="big" onclick={begin}>Continue journey</button>
              <button type="button" onclick={startFresh}>New journey</button>
            {:else}
              <button type="button" class="big" onclick={begin}>Begin journey</button>
            {/if}
          </div>
        {/if}
        <p class="keys">Move: WASD / arrows / touch pad · Act: E / Space / A button · Cast: F / ✦</p>
      </div>
    </div>
  {/if}
</main>

<style>
  main {
    position: relative;
    width: 100%;
    height: 100dvh;
    overflow: hidden;
    background: var(--ink);
  }
  .stage {
    position: absolute;
    inset: 0;
  }
  .stage :global(canvas) {
    display: block;
  }
  .prompt {
    position: absolute;
    bottom: max(84px, calc(env(safe-area-inset-bottom) + 84px));
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 12px;
    font-size: 12px;
    z-index: 22;
    pointer-events: none;
  }
  .titlecard {
    width: min(440px, 100%);
    padding: 0 0 16px;
    text-align: center;
    max-height: 100%;
    overflow-y: auto;
  }
  .hero-illus {
    width: 100%;
    height: 170px;
    object-fit: cover;
    border-bottom: 3px solid var(--wood-dark);
    display: block;
  }
  h1 {
    margin: 12px 0 2px;
    font-size: 26px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--wood-dark);
  }
  .tag { margin: 0 12px; font-size: 13px; color: var(--accent); }
  .note { margin: 8px 16px 0; font-size: 11px; line-height: 1.5; color: #6a5a48; }
  .error-title { margin: 10px 16px 0; font-size: 14px; color: var(--danger); font-weight: 700; }
  .status { margin: 14px 0 4px; font-size: 13px; color: #8a7a5a; }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    margin-top: 14px;
  }
  .big { font-size: 16px; padding: 10px 22px; }
  .keys { font-size: 10px; color: #8a7a5a; margin: 14px 16px 0; line-height: 1.6; }  details {
    margin: 10px 16px 0;
    text-align: left;
  }
  summary { font-size: 11px; color: #6a5a48; cursor: pointer; }
  textarea {
    width: 100%;
    font-size: 10px;
    border: 2px solid var(--wood);
    border-radius: 6px;
    padding: 6px;
    background: #fffbeF;
  }
</style>
