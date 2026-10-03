<script lang="ts">
  import { onMount } from 'svelte'
  import type Phaser from 'phaser'
  import {
    bus,
    EV,
    type AbilityPayload,
    type AreaPayload,
    type CinematicPayload,
    type DefeatPayload,
    type DiscoveryPayload,
    type PortraitsPayload,
    type PromptPayload,
    type QuestPayload,
    type StatsPayload,
    type ToastPayload
  } from './game/events'
  import { ui } from './ui/store.svelte'
  import { Session } from './game/session'
  import { createNewGame, questObjective, type QuestStage } from './lib/state'
  import { clearSave, loadSaveRecord } from './lib/save'
  import { discoveryInfo, locations } from './content/world'
  import { startGame, stopGame } from './game/main'
  import { uiState } from './game/input'
  import { sfx, unlockAudio } from './game/sfx'
  import { isTouchFirst } from './ui/device'
  import Hud from './ui/Hud.svelte'
  import DialoguePanel from './ui/DialoguePanel.svelte'
  import JournalPanel from './ui/JournalPanel.svelte'
  import CharacterPanel from './ui/CharacterPanel.svelte'
  import MenuPanel from './ui/MenuPanel.svelte'
  import TouchControls from './ui/TouchControls.svelte'
  import Toasts from './ui/Toasts.svelte'
  import Banners from './ui/Banners.svelte'
  import Moments from './ui/Moments.svelte'
  import ConfirmDialog from './ui/ConfirmDialog.svelte'
  import Icon from './ui/Icon.svelte'

  type Phase = 'loading' | 'title' | 'playing' | 'recovery'
  type Panel = 'journal' | 'character' | 'menu' | null

  let phase = $state<Phase>('loading')
  let hasSave = $state(false)
  let panel = $state<Panel>(null)
  let recovery = $state<{ message: string; raw: string } | null>(null)
  let rawCopied = $state(false)
  let confirm = $state<'new' | 'discard' | 'overwrite' | null>(null)

  let stageEl: HTMLDivElement
  let game: Phaser.Game | null = null
  let session = $state<Session | null>(null)
  const touch = isTouchFirst()

  /** Quest beats: the ribbon that celebrates each step of the story. */
  const QUEST_BEATS: Partial<Record<QuestStage, { eyebrow: string; title: string }>> = {
    accepted: { eyebrow: 'Quest accepted', title: 'The Lantern Road' },
    'clue-found': { eyebrow: 'Clue found', title: 'The Closure Mark' },
    'guardian-defeated': { eyebrow: 'Victory', title: 'The Warden Yields' },
    'lantern-lit': { eyebrow: 'The light returns', title: 'A Flame on the Hill' }
  }

  /** Save preview for the title screen's Continue card. */
  const saveSummary = $derived.by(() => {
    if (!hasSave || !session) return null
    const s = session.state
    const mins = Math.floor(s.playSeconds / 60)
    return {
      place: locations[s.area].name,
      goal: questObjective(s.quest),
      time: mins < 1 ? 'just started' : mins < 60 ? `${mins} min played` : `${Math.floor(mins / 60)}h ${mins % 60}m played`
    }
  })

  function wireBus(): () => void {
    const onStats = (p: StatsPayload) => {
      // Recovery is saved the instant the hero falls; hold the bars until
      // the screen is dark so they don't refill mid-collapse.
      if (ui.defeat === 'falling') {
        pendingStats = p
        return
      }
      ui.stats = p
    }
    const onQuest = (p: QuestPayload) => {
      // The first snapshot after load is a reading, not a change.
      const changed = ui.questKnown && ui.quest.stage !== p.stage
      ui.quest = p
      ui.questKnown = true
      if (!changed) return
      if (p.stage === 'complete') {
        ui.endingOpen = true
        return
      }
      const beat = QUEST_BEATS[p.stage as QuestStage]
      if (beat) ui.banner({ kind: 'quest', eyebrow: beat.eyebrow, title: beat.title, body: p.objective })
    }
    const onArea = (p: AreaPayload) => {
      const info = locations[p.areaId]
      const moved = ui.area.areaId !== p.areaId || !areaShown
      ui.area = { areaId: p.areaId, name: info.name, description: info.description }
      if (phase === 'playing' && moved) {
        areaShown = true
        ui.banner({ kind: 'area', eyebrow: info.eyebrow, title: info.name, body: info.tagline })
      }
    }
    const onPrompt = (p: PromptPayload) => {
      ui.prompt = p
    }
    const onToast = (p: ToastPayload) => ui.toast(p)
    const onDefeat = (p: DefeatPayload) => {
      if (p?.phase === 'falling') ui.defeatCount += 1
      ui.defeat = p?.phase ?? 'none'
      if (ui.defeat !== 'falling' && pendingStats) {
        ui.stats = pendingStats
        pendingStats = null
      }
    }
    const onAbility = (p: AbilityPayload) => {
      if (p.status === 'cast') ui.ability = { ...ui.ability, readyAt: performance.now() + (p.cooldown ?? 1) * 1000, cooldown: p.cooldown ?? 1 }
      else if (p.status === 'no-mana') ui.ability = { ...ui.ability, deniedAt: performance.now() }
    }
    const onCinematic = (p: CinematicPayload) => {
      ui.cinematic = p.active
    }
    const onPortraits = (p: PortraitsPayload) => {
      ui.portraits = { ...ui.portraits, ...p }
    }
    const onDiscovery = (p: DiscoveryPayload) => {
      sfx('discover')
      ui.toast({ text: `New in your journal: ${discoveryInfo(p.id).name}`, icon: 'scroll' })
    }
    const pairs: [string, (...args: never[]) => void][] = [
      [EV.stats, onStats],
      [EV.quest, onQuest],
      [EV.area, onArea],
      [EV.prompt, onPrompt],
      [EV.toast, onToast],
      [EV.defeat, onDefeat],
      [EV.ability, onAbility],
      [EV.cinematic, onCinematic],
      [EV.portraits, onPortraits],
      [EV.discovery, onDiscovery]
    ]
    for (const [ev, fn] of pairs) bus.on(ev, fn)
    return () => {
      for (const [ev, fn] of pairs) bus.off(ev, fn)
    }
  }
  let areaShown = false
  let pendingStats: StatsPayload | null = null

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

  async function begin(): Promise<void> {
    if (!session || !stageEl || phase !== 'title') return
    unlockAudio()
    sfx('open')
    // World text (damage numbers, exit labels) uses the display font: make
    // sure it is ready before the first frame draws any.
    try {
      await Promise.race([document.fonts.load('10px "Pixelify Sans"'), new Promise((r) => setTimeout(r, 1200))])
    } catch {
      /* fall back to monospace */
    }
    phase = 'playing'
    game = startGame(stageEl, session)
  }

  function requestNew(): void {
    if (hasSave) confirm = 'new'
    else void startFresh()
  }

  async function startFresh(): Promise<void> {
    confirm = null
    session?.destroy(true)
    session = new Session(createNewGame())
    hasSave = false
    ui.vitalsSource = 'demo'
    ui.importedProfile = null
    void session.save()
    await begin()
  }

  async function copyRawSave(): Promise<void> {
    if (!recovery?.raw) return
    try {
      await navigator.clipboard.writeText(recovery.raw)
    } catch {
      /* text stays visible in the details box */
    }
    rawCopied = true
  }

  async function discardAndReset(): Promise<void> {
    confirm = null
    await clearSave()
    window.location.reload()
  }

  /** Explicit overwrite of a corrupt record with a fresh demo save. */
  async function overwriteAndStart(): Promise<void> {
    confirm = null
    const { saveGame } = await import('./lib/save')
    await saveGame(createNewGame(), { overwriteCorrupt: true })
    window.location.reload()
  }

  $effect(() => {
    uiState.panelOpen = panel !== null || ui.endingOpen
  })

  function toggle(p: Exclude<Panel, null>): void {
    const next = panel === p ? null : p
    sfx(next ? 'open' : 'close')
    panel = next
  }

  /**
   * Single owner of panel open/close keys (J / C / Escape). Panels mount
   * already-open and close only through this state — their overlays and
   * uiState.panelOpen can never drift apart. Key events coming from text
   * fields (credentials, import codes) are ignored so typing never toggles.
   */
  function onKeyGlobal(e: KeyboardEvent): void {
    if (phase !== 'playing' || ui.dialogueOpen || ui.cinematic || confirm) return
    const t = e.target as HTMLElement | null
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    // Typing J/C in a text field must never toggle panels — but Escape always
    // closes (standard dismiss UX, including from a focused field).
    if (typing && e.code !== 'Escape') return
    if (ui.endingOpen) return
    if (e.code === 'KeyJ') toggle('journal')
    else if (e.code === 'KeyC') toggle('character')
    else if (e.code === 'Escape') {
      if (panel) {
        sfx('close')
        panel = null
      } else {
        toggle('menu')
      }
    }
  }

  const showPrompt = $derived(!!ui.prompt.label && !ui.dialogueOpen && panel === null && !ui.cinematic && !ui.endingOpen)
</script>

<svelte:window onkeydown={onKeyGlobal} />

<main>
  <div class="stage" bind:this={stageEl}></div>

  {#if phase === 'playing' && session}
    <Hud onJournal={() => toggle('journal')} onCharacter={() => toggle('character')} onMenu={() => toggle('menu')} />
    {#if showPrompt}
      <div class="prompt" class:touch>
        {#if !touch}<span class="kbd">E</span>{/if}
        <span>{ui.prompt.label}</span>
      </div>
    {/if}
    <DialoguePanel />
    <TouchControls />
    <Banners />
    <Toasts />
    <Moments {session} />
    {#if panel === 'journal'}
      <JournalPanel onClose={() => toggle('journal')} />
    {:else if panel === 'character'}
      <CharacterPanel {session} onClose={() => toggle('character')} onMenu={() => (panel = 'menu')} />
    {:else if panel === 'menu'}
      <MenuPanel {session} onClose={() => toggle('menu')} />
    {/if}
  {/if}

  {#if phase !== 'playing'}
    <div class="title-screen">
      <img class="bg" src="/assets/fingersnap/fingersnap-village.png" alt="" />
      <div class="shade" aria-hidden="true"></div>
      <div class="fireflies" aria-hidden="true">
        {#each Array.from({ length: 16 }) as _, i}
          <span style={`--x:${(i * 61) % 100}%; --y:${(i * 37) % 100}%; --d:${6 + (i % 5) * 1.7}s; --delay:${-(i * 0.9)}s`}></span>
        {/each}
      </div>

      <div class="title-col">
        <div class="logo">
          <span class="lamp"><Icon name="lantern" size={34} /></span>
          <h1>Fingersnap</h1>
          <p class="tagline">Relight the old lantern road.</p>
        </div>

        {#if phase === 'recovery' && recovery}
          <div class="panel card">
            <h2 class="err">This save got a little scrambled.</h2>
            <p class="fine">We couldn’t read your journey, but nothing has been deleted. You can try again, keep a copy of the data, or begin fresh.</p>
            <p class="tech">{recovery.message}</p>
            <div class="choices">
              <button type="button" class="primary" onclick={() => window.location.reload()}>Try again</button>
              {#if recovery.raw}
                <button type="button" onclick={copyRawSave}>{rawCopied ? 'Copied (also shown below)' : 'Copy the scrambled data'}</button>
              {/if}
              <button type="button" onclick={() => (confirm = 'overwrite')}>Start a new journey</button>
              <button type="button" class="ghost" onclick={() => (confirm = 'discard')}>Delete it and reload</button>
            </div>
            {#if recovery.raw}
              <details>
                <summary>Show the scrambled data</summary>
                <textarea readonly rows="6">{recovery.raw}</textarea>
              </details>
            {/if}
          </div>
        {:else if phase === 'loading'}
          <p class="status"><span class="spark"></span> Lighting the lamps…</p>
        {:else}
          <div class="actions">
            {#if hasSave && saveSummary}
              <button type="button" class="primary continue" onclick={begin}>
                <span class="big">Continue</span>
                <span class="meta"><Icon name="lantern" size={12} /> {saveSummary.place} · {saveSummary.time}</span>
                <span class="goal">{saveSummary.goal}</span>
              </button>
              <button type="button" class="secondary" onclick={requestNew}>New journey</button>
            {:else}
              <button type="button" class="primary continue" onclick={begin}>
                <span class="big">Begin your journey</span>
                <span class="meta">A short, cozy adventure · saves as you go</span>
              </button>
            {/if}
          </div>
          {#if !touch}
            <p class="keys">
              <span><span class="kbd">WASD</span> walk</span>
              <span><span class="kbd">E</span> talk · act</span>
              <span><span class="kbd">F</span> ability</span>
              <span><span class="kbd">Esc</span> menu</span>
            </p>
          {/if}
        {/if}
        <p class="fineprint">Plays right here in your browser. Your saves stay on this device.</p>
      </div>
    </div>
  {/if}

  {#if confirm === 'new'}
    <ConfirmDialog
      title="Start a new journey?"
      body="Your current journey will be replaced. Copy a save code from the Menu first if you might want it back."
      confirmLabel="Start fresh"
      danger
      onConfirm={startFresh}
      onCancel={() => (confirm = null)}
    />
  {:else if confirm === 'discard'}
    <ConfirmDialog
      title="Delete the scrambled save?"
      body="It will be gone for good. If you might want it, copy the data first."
      confirmLabel="Delete it"
      danger
      onConfirm={discardAndReset}
      onCancel={() => (confirm = null)}
    />
  {:else if confirm === 'overwrite'}
    <ConfirmDialog
      title="Begin fresh?"
      body="A brand-new journey replaces the scrambled save — it won’t be recoverable afterwards."
      confirmLabel="Begin fresh"
      danger
      onConfirm={overwriteAndStart}
      onCancel={() => (confirm = null)}
    />
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
    bottom: max(30px, calc(env(safe-area-inset-bottom) + 30px));
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px 7px 8px;
    font-family: var(--font-display);
    font-size: 15px;
    color: #fff6dc;
    background: rgba(36, 28, 40, 0.9);
    border: 2px solid rgba(255, 210, 74, 0.6);
    border-radius: 999px;
    box-shadow: 0 6px 16px rgba(10, 6, 12, 0.4);
    z-index: 22;
    pointer-events: none;
    white-space: nowrap;
    animation: prompt-in 0.18s ease-out;
  }
  .prompt .kbd {
    font-size: 12px;
  }
  .prompt.touch {
    bottom: max(170px, calc(env(safe-area-inset-bottom) + 170px));
    padding-left: 14px;
  }
  @keyframes prompt-in {
    from { opacity: 0; transform: translate(-50%, 6px); }
  }

  /* ---- title screen ---- */

  .title-screen {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom))
      max(20px, env(safe-area-inset-left));
    overflow: hidden;
  }
  .bg {
    position: absolute;
    inset: -2%;
    width: 104%;
    height: 104%;
    object-fit: cover;
    image-rendering: auto;
    animation: drift 40s ease-in-out infinite alternate;
  }
  .shade {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at 50% 45%, rgba(20, 14, 30, 0.35) 0%, rgba(20, 14, 30, 0.85) 75%),
      linear-gradient(180deg, rgba(20, 14, 30, 0.2), rgba(20, 14, 30, 0.75));
  }
  .fireflies span {
    position: absolute;
    left: var(--x);
    top: var(--y);
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #ffe48a;
    box-shadow: 0 0 10px 3px rgba(255, 210, 74, 0.6);
    animation: float var(--d) ease-in-out var(--delay) infinite;
    opacity: 0;
  }
  .title-col {
    position: relative;
    width: min(440px, 100%);
    max-height: 100%;
    overflow-y: auto;
    display: grid;
    justify-items: center;
    gap: 18px;
    text-align: center;
  }
  .logo {
    display: grid;
    justify-items: center;
    gap: 2px;
  }
  .lamp {
    color: var(--gold);
    filter: drop-shadow(0 0 12px rgba(255, 210, 74, 0.9));
    animation: flicker 3s ease-in-out infinite;
  }
  h1 {
    margin: 4px 0 0;
    font-size: clamp(44px, 11vw, 72px);
    line-height: 1;
    letter-spacing: 0.04em;
    color: #fff3c4;
    text-shadow: 0 4px 0 #6b3a12, 0 0 30px rgba(255, 190, 80, 0.55), 0 0 2px #2b1d1a;
  }
  .tagline {
    margin: 6px 0 0;
    font-size: 18px;
    font-style: italic;
    color: #f4e4c1;
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
  }
  .actions {
    width: 100%;
    display: grid;
    gap: 10px;
    justify-items: center;
  }
  .continue {
    width: min(360px, 100%);
    display: grid;
    gap: 2px;
    padding: 12px 18px 14px;
    border-width: 3px;
    border-radius: 14px;
    box-shadow: 0 5px 0 #5a3410, 0 0 40px rgba(255, 210, 74, 0.35);
  }
  .continue .big {
    font-size: 24px;
  }
  .continue .meta {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #6b3f12;
  }
  .continue .goal {
    font-family: var(--font-body);
    font-size: 13px;
    font-weight: 600;
    color: #5a3a14;
    opacity: 0.85;
  }
  .secondary {
    background: rgba(36, 28, 40, 0.75);
    color: #f4e4c1;
    border-color: rgba(244, 228, 193, 0.6);
    box-shadow: 0 3px 0 rgba(0, 0, 0, 0.5);
  }
  .secondary:hover:not(:disabled) {
    background: rgba(56, 44, 60, 0.85);
  }
  .keys {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px 14px;
    margin: 0;
    font-size: 13px;
    color: #e9dcc0;
  }
  .keys .kbd {
    margin-right: 4px;
    font-size: 12px;
  }
  .fineprint {
    margin: 0;
    font-size: 12px;
    color: rgba(244, 228, 193, 0.7);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display);
    font-size: 17px;
    color: #f4e4c1;
  }
  .spark {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--gold);
    box-shadow: 0 0 12px 4px rgba(255, 210, 74, 0.6);
    animation: flicker 1s ease-in-out infinite;
  }
  .card {
    width: 100%;
    padding: 18px 20px;
    text-align: left;
    user-select: text;
    -webkit-user-select: text;
  }
  .err {
    margin: 0 0 6px;
    font-size: 20px;
    color: var(--danger);
  }
  .tech {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--text-faint);
    word-break: break-word;
  }
  .choices {
    display: grid;
    gap: 8px;
    margin-top: 10px;
  }
  details {
    margin-top: 10px;
  }
  summary {
    font-size: 13px;
    color: var(--text-soft);
    cursor: pointer;
  }
  textarea {
    width: 100%;
    margin-top: 6px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    border: 2px solid var(--wood);
    border-radius: 8px;
    padding: 8px;
    background: #fffbef;
  }

  @keyframes drift {
    from { transform: scale(1) translate(0, 0); }
    to { transform: scale(1.06) translate(-1.5%, -1%); }
  }
  @keyframes float {
    0% { opacity: 0; transform: translate(0, 0); }
    20% { opacity: 0.9; }
    50% { transform: translate(14px, -22px); }
    80% { opacity: 0.7; }
    100% { opacity: 0; transform: translate(-8px, -44px); }
  }
  @keyframes flicker {
    0%, 100% { opacity: 1; }
    45% { opacity: 0.82; }
    50% { opacity: 1; }
    70% { opacity: 0.9; }
  }
</style>
