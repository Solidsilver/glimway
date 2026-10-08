<script lang="ts">
  import { onMount } from 'svelte'
  import type Phaser from 'phaser'
  import {
    bus,
    EV,
    listen,
    type AbilityPayload,
    type AreaPayload,
    type CinematicPayload,
    type DefeatPayload,
    type DiscoveryPayload,
    type GoalDirPayload,
    type LinkPayload,
    type PresencePayload,
    type PortraitsPayload,
    type PromptPayload,
    type QuestPayload,
    type StatsPayload,
    type ToastPayload,
    type WildsPayload
  } from './game/events'
  import { ui } from './ui/store.svelte'
  import { Session } from './game/session'
  import { createNewGame, questObjective, type GameState, type QuestStage } from './lib/state'
  import { clearSave, loadSaveRecord } from './lib/save'
  import { discoveryInfo, areaInfo, displayArea } from './content/world'
  import { startGame, stopGame } from './game/main'
  import { type ResidentsMetPayload } from './game/residents'
  import { uiState } from './game/input'
  import { sfx } from './game/sfx'
  import { isTouchFirst } from './ui/device'
  import Hud from './ui/Hud.svelte'
  import DialoguePanel from './ui/DialoguePanel.svelte'
  import JournalPanel from './ui/JournalPanel.svelte'
  import LibraryPanel from './ui/LibraryPanel.svelte'
  import { homesteadsFor, type ArrangeView, type NamePrompt as NamePromptView, type PlacementView } from './game/homestead'
  import NamePrompt from './ui/NamePrompt.svelte'
  import { HOMESTEAD_DATA } from './lib/homestead'
  import { home } from './ui/home.svelte'
  import SilasShop from './ui/SilasShop.svelte'
  import NoticeBoard from './ui/NoticeBoard.svelte'
  import WorkshopPanel from './ui/WorkshopPanel.svelte'
  import HearthPanel from './ui/HearthPanel.svelte'
  import DeskPanel from './ui/DeskPanel.svelte'
  import WoodpilePanel from './ui/WoodpilePanel.svelte'
  import GateShelfPanel from './ui/GateShelfPanel.svelte'
  import MailPanel from './ui/MailPanel.svelte'
  import { villageFor, type VillagePanel } from './game/village'
  import { villageUi } from './ui/village.svelte'
  import HomeBar from './ui/HomeBar.svelte'
  import CharacterPanel from './ui/CharacterPanel.svelte'
  import InventoryPanel from './ui/InventoryPanel.svelte'
  import { inventory } from './ui/inventory.svelte'
  import { inventoryEntries, unseen } from './lib/inventory'
  import MenuPanel from './ui/MenuPanel.svelte'
  import TouchControls from './ui/TouchControls.svelte'
  import Toasts from './ui/Toasts.svelte'
  import Banners from './ui/Banners.svelte'
  import Moments from './ui/Moments.svelte'
  import ConfirmDialog from './ui/ConfirmDialog.svelte'
  import Icon from './ui/Icon.svelte'
  import ConnectGuide from './ui/ConnectGuide.svelte'
  import { loadRemembered } from './lib/habitica/remembered'
  import { XP_PER_EMBER } from './lib/embers'
  import { emberLine, titleChoice } from './content/connect-guide'
  import { connectSession, isConnected } from './ui/habitica-local'
  import { accountName, api, connectedSession, probeServer } from './ui/account'
  import { AccountFlow } from './ui/account-flow.svelte'
  import { prepareWilds, resetWilds } from './game/wilds/store'
  import { clearCache, loadCache, loadLatestCache, saveCache } from './lib/api/cache'
  import type { Snapshot, WorldChoice } from './lib/api/types'
  import type { HabiticaProfile } from './lib/habitica/types'
  import OriginChoice from './ui/OriginChoice.svelte'
  import WorldChoiceGate from './ui/WorldChoiceGate.svelte'
  import LinkGate from './ui/LinkGate.svelte'
  import LinkNotice from './ui/LinkNotice.svelte'
  import UpdateNotice from './ui/UpdateNotice.svelte'
  import WhatsNew from './ui/WhatsNew.svelte'
  import { whatsNew } from './ui/whats-new.svelte'
  import { update, watchForUpdates } from './ui/update.svelte'
  import PartyPrompt from './ui/PartyPrompt.svelte'
  import LeaverNotice from './ui/LeaverNotice.svelte'
  import WorldMove from './ui/WorldMove.svelte'
  import { firstWorldCopy, worldCopy } from './content/world-moves'
  import EmotePicker from './ui/EmotePicker.svelte'
  import { presence, startPresence, stopPresence } from './game/presence'
  import { EMOTES } from './content/presence'
  import { accountCopy, leaseCopy } from './content/connected'
  import { watchPlayInsets, type Docks } from './ui/play-insets'
  import { pinnedProgress, recordGuideSteps, setPinned, usePinFor } from './game/guide-pin'
  import { BLOCKS, blocked, layersUp } from './ui/layers'

  type Phase = 'loading' | 'title' | 'playing' | 'recovery'
  type Panel = 'journal' | 'character' | 'inventory' | 'menu' | 'library' | 'shop' | VillagePanel | null

  let phase = $state<Phase>('loading')
  let hasSave = $state(false)
  let panel = $state<Panel>(null)
  /** Mail panel opened at a neighbour's mailbox: who to send to. */
  let mailTo = $state<string | null>(null)
  /** Shelf panel opened at a Commons gate: which gate. */
  let shelfGate = $state(0)
  /** Which chest the workshop opens on (the inventory's "your own chest" asks for the personal one). */
  let chestPick = $state<'shared' | 'personal'>('shared')
  let recovery = $state<{ message: string; raw: string } | null>(null)
  let rawCopied = $state(false)
  let confirm = $state<'new' | 'discard' | 'overwrite' | null>(null)
  /** New-game flow on the title screen: pick a way to play, or walk the connect guide. */
  let titleView = $state<'choice' | 'guide'>('choice')

  /** The log-out confirm on the title screen. */
  let confirmLogout = $state(false)

  let stageEl: HTMLDivElement
  let game: Phaser.Game | null = null
  let session = $state<Session | null>(null)
  const touch = isTouchFirst()

  /** Quest beats: the ribbon that celebrates each step of the story. */
  const QUEST_BEATS: Partial<Record<QuestStage, { eyebrow: string; title: string }>> = {
    accepted: { eyebrow: 'Quest accepted', title: 'The Lantern Road' },
    'clue-found': { eyebrow: 'Clue found', title: 'The Closure Mark' },
    'guardian-defeated': { eyebrow: 'Settled', title: 'The Warden Rests' },
    'lantern-lit': { eyebrow: 'The light returns', title: 'A Flame on the Hill' }
  }

  /** A journey's line on a title-screen Continue card: where, what next, how long played. */
  function journeyLine(s: GameState): { place: string; goal: string; time: string } {
    const mins = Math.floor(s.playSeconds / 60)
    return {
      place: areaInfo(displayArea(s)).name,
      goal: questObjective(s.quest),
      time: mins < 1 ? 'just started' : mins < 60 ? `${mins} min played` : `${Math.floor(mins / 60)}h ${mins % 60}m played`
    }
  }

  /** Save preview for the title screen's Continue card. */
  const saveSummary = $derived(hasSave && session ? journeyLine(session.state) : null)

  /** The signed-in account's Continue card on the title screen. */
  const accountSummary = $derived.by(() => {
    if (!ui.account) return null
    if (account.choice) return { place: 'Your world', time: '', goal: firstWorldCopy.titleGoal }
    if (account.snapshot && account.snapshot.saveOrigin === null) {
      return { place: 'Your world', time: '', goal: 'Choose how to begin.' }
    }
    const cached = account.cache && account.cache.habiticaId === ui.account.habiticaId ? account.cache : null
    const st = cached && (cached.dirty || !account.snapshot) ? cached.state : account.snapshot?.state
    return st ? journeyLine(st) : null
  })

  /** Connected play can't go on here: taken over elsewhere, or signed out. */
  const leaseBlock = $derived(
    phase === 'playing' && !!session?.link && (ui.link?.status === 'superseded' || ui.link?.status === 'signed-out')
      ? (ui.link.status === 'superseded' ? 'elsewhere' : 'signed-out')
      : null
  )

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
      if (beat) ui.banner({ kind: 'quest', eyebrow: beat.eyebrow, title: beat.title, body: p.short ?? p.objective })
    }
    const onArea = (p: Pick<AreaPayload, 'areaId'>) => {
      const info = areaInfo(p.areaId)
      const moved = ui.area.areaId !== p.areaId || !areaShown
      // A homestead's land and its cottage announce themselves (whose place, in words).
      const homestead = /^home:\d+$/.test(p.areaId) || p.areaId === 'cottage'
      // A new place waits for its own announcement; until then it's "Lot 4", never the last place's name.
      if (ui.area.areaId !== p.areaId) roomName = null
      ui.area = { areaId: p.areaId, name: homestead && roomName ? roomName : info.name, description: info.description }
      if (phase === 'playing' && moved && !homestead) {
        areaShown = true
        // The storybook card is for a first visit; after that the HUD's place
        // name changes over on its own (src/ui/Hud.svelte).
        if (firstVisit(placeKey(p.areaId))) ui.banner({ kind: 'area', eyebrow: info.eyebrow, title: info.name, body: info.tagline })
      }
    }
    const onWilds = (p: WildsPayload) => {
      ui.materials = p.materials
    }
    const onGoalDir = (p: GoalDirPayload) => {
      ui.goalDir = p
    }
    const onPrompt = (p: PromptPayload) => {
      // Every prompt gets a verb for its button: "Copy the naming…" → Copy.
      ui.prompt = p.label ? { ...p, verb: p.verb ?? verbOf(p.label) } : p
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
    const onRolled = (p: { cooldown: number }) => {
      ui.roll = { readyAt: performance.now() + p.cooldown * 1000, cooldown: p.cooldown }
    }
    const onCinematic = (p: CinematicPayload) => {
      ui.cinematic = p.active
    }
    const onPortraits = (p: PortraitsPayload) => {
      ui.portraits = { ...ui.portraits, ...p }
    }
    const onResidentsMet = (p: ResidentsMetPayload) => {
      ui.residentsMet = [...p.journalFlags]
    }
    const onArtIcons = (p: Record<string, string>) => {
      ui.artIcons = { ...ui.artIcons, ...p }
    }
    const onDiscovery = (p: DiscoveryPayload) => {
      ui.toast({ text: `New in your journal: ${discoveryInfo(p.id).name}`, icon: 'scroll' })
    }
    const onPresence = (p: PresencePayload) => {
      ui.presence = p
      if (p.status !== 'live') ui.emoteOpen = false
    }
    const onLink = (p: LinkPayload) => {
      ui.link = p
    }
    const onResolved = (p: { op: { kind: string }; outcome: string }) => {
      if (p?.op?.kind !== 'world-move' && p?.op?.kind !== 'world-leave') return
      // A move whose answer was lost, replayed: it never went through…
      if (p.outcome !== 'landed') {
        ui.toast({ text: worldCopy.replayRefused, icon: 'world' })
        return
      }
      // …or it did. Mid-play, step into the new world; while signing in, the
      // session being built already holds it.
      if (phase !== 'playing' || !session?.link) {
        ui.toast({ text: worldCopy.landed, icon: 'world' })
        return
      }
      void api
        .state()
        .then((snap) => account.afterMove(snap, worldCopy.landed))
        .catch(() => ui.toast({ text: worldCopy.landed, icon: 'world' }))
    }
    const onUnmoored = (p: { active: boolean }) => {
      ui.unmoored = p.active
    }
    const onLinkNotice = () => {
      ui.linkNotice = 'played-elsewhere'
    }
    const onOpenLibrary = () => {
      if (panel === null) toggle('library')
    }
    const onOpenShop = () => {
      if (panel === null) toggle('shop')
    }
    const onArrange = (v: ArrangeView) => {
      home.arrange = v
    }
    const onPlacement = (v: PlacementView | null) => {
      home.placement = v
    }
    const onThumbs = (v: Record<string, string>) => {
      home.thumbs = { ...home.thumbs, ...v }
    }
    const onNamePrompt = (v: NamePromptView) => {
      home.namePrompt = v
    }
    const onConfirmLeave = (v: { place: string; shared: boolean }) => {
      home.leaveAsk = v
    }
    const onHomeGoal = (v: { text: string | null }) => {
      home.goal = v?.text ?? null
    }
    const onVillageOpen = (v: { panel: VillagePanel; to?: string; gate?: number }) => {
      if (panel !== null) return
      mailTo = v.to ?? null
      shelfGate = v.gate ?? 0
      toggle(v.panel)
    }
    const onVillageChanged = () => {
      if (!session) return
      const v = villageFor(session)
      villageUi.calendar = v.calendar
      villageUi.waiting = v.waitingCount()
    }
    const onRoom = (v: { key: string; eyebrow: string; title: string; body: string }) => {
      if (phase !== 'playing') return
      // The HUD names the place the way its card does ("Your land", "Ada's Place").
      roomName = v.title
      if (/^home:\d+$/.test(ui.area.areaId) || ui.area.areaId === 'cottage') ui.area = { ...ui.area, name: v.title }
      if (firstVisit(v.key)) ui.banner({ kind: 'area', eyebrow: v.eyebrow, title: v.title, body: v.body })
    }
    return listen({
      [EV.stats]: onStats,
      [EV.quest]: onQuest,
      [EV.area]: onArea,
      [EV.prompt]: onPrompt,
      [EV.goalDir]: onGoalDir,
      [EV.toast]: onToast,
      [EV.defeat]: onDefeat,
      [EV.ability]: onAbility,
      [EV.rolled]: onRolled,
      [EV.cinematic]: onCinematic,
      [EV.portraits]: onPortraits,
      [EV.residentsMet]: onResidentsMet,
      [EV.artIcons]: onArtIcons,
      [EV.discovery]: onDiscovery,
      [EV.link]: onLink,
      [EV.presence]: onPresence,
      [EV.linkNotice]: onLinkNotice,
      [EV.unmoored]: onUnmoored,
      [EV.mutationResolved]: onResolved,
      [EV.wilds]: onWilds,
      [EV.libraryOpen]: onOpenLibrary,
      [EV.homeShop]: onOpenShop,
      [EV.homeArrange]: onArrange,
      [EV.homePlacement]: onPlacement,
      [EV.homeThumbs]: onThumbs,
      [EV.homeNamePrompt]: onNamePrompt,
      [EV.homeConfirmLeave]: onConfirmLeave,
      [EV.homeGoal]: onHomeGoal,
      [EV.homeRoom]: onRoom,
      [EV.villageOpen]: onVillageOpen,
      [EV.villageChanged]: onVillageChanged
    })
  }
  /** The action button's word for a prompt without one: its first word ("Pick up" keeps its particle). */
  function verbOf(label: string): string {
    const words = label.replace(/·.*$/, '').trim().split(/\s+/)
    const particle = ['up', 'in', 'out', 'down', 'on', 'off', 'back']
    return words.length > 1 && particle.includes(words[1].toLowerCase()) ? `${words[0]} ${words[1]}` : words[0]
  }

  let areaShown = false
  /** The last homestead place announced (its HUD name). */
  let roomName: string | null = null
  let pendingStats: StatsPayload | null = null

  /**
   * The place a title card is about: the area, or for the Wilds the region
   * (a Turning has its own moment).
   */
  function placeKey(areaId: string): string {
    if (areaId === 'wilds') return `wilds:${session?.state.wildsRegion ?? 'inner-1'}`
    // Wilds chunks ("chunk:outer-1:3:-2"): one card per region, not per chunk.
    const chunk = /^chunk:([^:]+):/.exec(areaId)
    return chunk ? `wilds:${chunk[1]}` : areaId
  }

  /**
   * True the first time the player arrives somewhere (remembered in the save
   * as a `seen:` flag). Waking after a fall never counts as arriving: the
   * wake-up card already says where you are.
   */
  function firstVisit(key: string): boolean {
    if (!session) return false
    const flag = `seen:${key}`
    if (session.state.flags.includes(flag)) return false
    session.addFlag(flag)
    return ui.defeat === 'none'
  }

  onMount(() => {
    const cleanupBus = wireBus()
    const stopUpdates = watchForUpdates()

    // Hidden: save now, in queue order. Leaving (pagehide): the last upload
    // may skip a busy queue, since the page won't wait for it.
    const onHide = () => session?.flushSync(true)
    const onVisibility = () => {
      if (document.hidden) session?.flushSync(false)
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
        void account.init()
        // Opt-in remembered credentials: connect without a paste. Storage
        // trouble just means "nothing remembered".
        void loadRemembered().then((creds) => {
          if (!creds) return
          ui.remembered = true
          if (!isConnected()) connectSession(creds.userId, creds.apiToken)
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        const raw = err && typeof err === 'object' && 'raw' in err && err.raw != null ? JSON.stringify((err as { raw: unknown }).raw, null, 1) : ''
        console.warn('[glimway] save could not be loaded', err)
        recovery = { message, raw }
        phase = 'recovery'
      })

    return () => {
      // Presence first: its socket, link poll and bus listener go with the App.
      stopPresence()
      cleanupBus()
      stopUpdates()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHide)
      session?.destroy()
      stopGame(game)
      game = null
    }
  })

  /** Set synchronously so a double click / Enter can't start two games. */
  let starting = false

  async function begin(): Promise<void> {
    if (!session || !stageEl || phase !== 'title' || starting) return
    starting = true
    sfx('open')
    // The Wilds need their region before the first chunk builds: guests get
    // the local epoch, connected players the world's frozen one.
    await prepareWilds(session)
    // The Commons builds for the lane as the server holds it: reading the
    // lane here, before the scene builds, saves a rebuild (a second ground
    // repaint) when the scene's own read arrives and the lane has grown.
    await homesteadsFor(session).load().catch(() => {})
    // World text (damage numbers, exit labels) uses the display font: make
    // sure it is ready before the first frame draws any.
    try {
      await Promise.race([document.fonts.load('10px "Pixelify Sans"'), new Promise((r) => setTimeout(r, 1200))])
    } catch {
      /* fall back to monospace */
    }
    phase = 'playing'
    game = startGame(stageEl, session)
    whatsNew.start()
  }

  // ------------------------------------------------------------ connected play

  /** Connected play's state machine (src/ui/account-flow.svelte.ts); App owns the screen it runs on. */
  const account = new AccountFlow<Session>({
    api,
    probe: probeServer,
    cache: { load: loadCache, latest: loadLatestCache, save: saveCache, clear: clearCache },
    connect: connectedSession,
    nameOf: (snapshot, cache) => accountName(snapshot, cache),
    ui,
    host: {
      session: () => session,
      starting: () => starting,
      play: enterSession,
      closePanel: () => (panel = null),
      leaveWorld: () => {
        resetWilds()
        villageUi.waiting = 0
      },
      toTitle: () => {
        stopPresence()
        stopGame(game)
        game = null
        areaShown = false
        phase = 'title'
      },
      reload: () => window.location.reload()
    }
  })

  /** Swap the running session for a connected one (title or mid-game). */
  async function enterSession(next: Session): Promise<void> {
    const prev = session
    session = next
    ui.vitalsSource = next.vitalsSource
    ui.importedProfile = next.importedProfile
    ui.questKnown = false // a different journey: its first quest reading is not a change
    hasSave = true
    // The guest journey saves itself one last time and stays on this device.
    if (prev && prev !== next) prev.destroy()
    // Presence follows connected play (and its lease); guests have none.
    if (next.link) startPresence(next.link)
    else stopPresence()
    if (phase === 'playing') {
      panel = null
      stopGame(game)
      areaShown = false
      await prepareWilds(next)
      // The new world's lane may count different gates: read it before the
      // scenes build (see begin()).
      await homesteadsFor(next).load().catch(() => {})
      game = startGame(stageEl, next)
    } else {
      await begin()
    }
  }

  function logout(): void {
    confirmLogout = false
    void account.logout()
  }

  const onSignedIn = (answer: Snapshot | WorldChoice, profile: HabiticaProfile | null) => account.signedIn(answer, profile)

  /**
   * The new-version notice's Reload: everything saved first (the browser,
   * then the server), and only then the reload. If something won't save,
   * the notice says so and the page stays.
   */
  async function reloadForUpdate(): Promise<void> {
    if (update.reloading) return
    update.reloading = true
    update.held = null
    const result = session ? await session.settle() : 'saved'
    if (result === 'saved') {
      window.location.reload()
      return
    }
    update.reloading = false
    update.held = result
  }

  function requestNew(): void {
    if (hasSave) confirm = 'new'
    else showChoice()
  }

  /** A fresh guest journey in place of this one (the old one is dropped, not saved). */
  function resetGuest(): void {
    session?.destroy(true)
    session = new Session(createNewGame())
    hasSave = false
    ui.vitalsSource = 'demo'
    ui.importedProfile = null
  }

  /** A confirmed new journey: nothing is written until the player picks a way to play. */
  function showChoice(): void {
    confirm = null
    if (starting) return
    if (hasSave) resetGuest()
    titleView = 'choice'
  }

  /** Guest path: today's demo start. */
  async function startFresh(): Promise<void> {
    confirm = null
    if (starting) return
    resetGuest()
    void session?.save()
    await begin()
  }

  /** Habitica path: a fresh game whose connect guide runs before Mara's first line. */
  function startHabitica(): void {
    if (starting) return
    resetGuest()
    void session?.save()
    titleView = 'guide'
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

  /** What is up over the world, top first; src/ui/layers.ts says what each holds back. */
  const layers = $derived(
    layersUp({
      gate: account.gate !== null,
      lease: leaseBlock !== null,
      move: account.moving !== null,
      confirm: confirm !== null,
      logout: confirmLogout,
      naming: home.namePrompt !== null,
      'leave-deed': home.leaveAsk !== null,
      panel: panel !== null,
      ending: ui.endingOpen,
      dialogue: ui.dialogueOpen,
      cinematic: ui.cinematic,
      placement: !!home.placement,
      'link-notice': !!ui.linkNotice,
      banner: ui.bannerUp,
      reloading: update.reloading
    })
  )

  $effect(() => {
    uiState.panelOpen = blocked(layers, BLOCKS.worldInput)
  })

  // The pack lives on the (non-reactive) save; mirror it for the HUD's bag
  // dot. Cheap: syncPack only reassigns when something changed.
  $effect(() => {
    if (phase !== 'playing' || !session) return
    const s = session
    inventory.syncPack(s.state.inventory)
    const t = setInterval(() => inventory.syncPack(s.state.inventory), 1500)
    return () => clearInterval(t)
  })
  const inventoryNew = $derived(unseen(inventoryEntries({ pack: inventory.pack, materials: ui.materials }), inventory.seenSet).length)

  function toggle(p: Exclude<Panel, null>): void {
    // Saving for a reload: nothing opens (a panel could start a write).
    if (update.reloading) return
    if (session) inventory.syncPack(session.state.inventory)
    const next = panel === p ? null : p
    sfx(next ? 'open' : 'close')
    panel = next
  }

  /**
   * Single owner of panel open/close keys (J / C / I / Escape). Panels mount
   * already-open and close only through this state — their overlays and
   * uiState.panelOpen can never drift apart. Key events coming from text
   * fields (credentials, import codes) are ignored so typing never toggles.
   */
  function onKeyGlobal(e: KeyboardEvent): void {
    if (phase !== 'playing' || blocked(layers, BLOCKS.appKeys)) return
    const t = e.target as HTMLElement | null
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    // Typing J/C in a text field must never toggle panels — but Escape always
    // closes (standard dismiss UX, including from a focused field).
    if (typing && e.code !== 'Escape') return
    // Placement mode owns its keys (Escape steps back out of it).
    if (home.placement && !panel) return
    // One owner per key: anything handled here is marked, so the world
    // (placement mode included) doesn't act on the same press.
    if (['KeyJ', 'KeyC', 'KeyI', 'Escape'].includes(e.code)) (e as KeyboardEvent & { fsConsumed?: boolean }).fsConsumed = true
    // Emotes: G opens the picker; 1–5 pick while it is open.
    if (ui.emoteOpen && !panel && /^Digit[1-9]$/.test(e.code)) {
      // The picker owns this digit: the belt mustn't also take it (src/game/scenes/WorldScene.ts onBeltKey).
      ;(e as KeyboardEvent & { fsConsumed?: boolean }).fsConsumed = true
      const pick = EMOTES[Number(e.code.slice(5)) - 1]
      if (pick) sendEmote(pick.id)
      return
    }
    if (e.code === 'KeyG' && !panel) {
      if (ui.presence.status === 'live') ui.emoteOpen = !ui.emoteOpen
      return
    }
    if (e.code === 'KeyJ') toggle('journal')
    else if (e.code === 'KeyC') toggle('character')
    else if (e.code === 'KeyI') toggle('inventory')
    else if (e.code === 'Escape') {
      if (ui.emoteOpen && !panel) {
        ui.emoteOpen = false
      } else if (panel === 'character' && characterFromBag) {
        closeCharacter()
      } else if (panel) {
        sfx('close')
        panel = null
      } else {
        toggle('menu')
      }
    }
  }

  /** Send an emote through the presence feed (the picker closes after a pick). */
  function sendEmote(id: string): void {
    const feed = presence()
    if (!feed || !feed.emote(id)) return
    ui.emoteOpen = false
  }

  /** Phones: the prompt docks beside the action button, the Arrange button above the cluster (src/ui/play-insets.ts). */
  let promptDock = $state<Docks['prompt']>(null)
  let controlsDock = $state<Docks['controls']>(undefined)
  $effect(() => {
    if (phase !== 'playing') return
    return watchPlayInsets(touch, (d) => {
      promptDock = d.prompt
      controlsDock = d.controls
    })
  })

  /** Nothing else is asking for the player's attention: a notice (the party prompt…) may show. */
  const promptClear = $derived(!blocked(layers, BLOCKS.notices))
  /** The journal page to open on (the HUD's pinned goal opens "How do I…?"). */
  let journalTab = $state<'road' | 'papers' | 'guides'>('road')
  $effect(() => {
    if (panel !== 'journal') journalTab = 'road'
  })

  /**
   * The pinned guide's step on the goal line, kept current (the item and
   * home models change under it). A finished guide says so and unpins.
   */
  $effect(() => {
    if (phase !== 'playing' || !session) return
    const s = session
    usePinFor(s)
    const read = () => {
      recordGuideSteps(s)
      const p = pinnedProgress(s)
      if (p && p.done) {
        ui.toast({ text: `Done: ${p.guide.title}.`, icon: 'check' })
        setPinned(null)
        return
      }
      const next = p && !p.locked && p.current !== null
        ? { id: p.guide.id, title: p.guide.title, step: p.steps[p.current].text, index: p.current, count: p.steps.length }
        : null
      if (JSON.stringify(next) !== JSON.stringify(ui.goalLine.guide)) ui.goalLine = { guide: next }
    }
    read()
    const t = setInterval(read, 1000)
    bus.on(EV.guidePin, read)
    return () => {
      clearInterval(t)
      bus.off(EV.guidePin, read)
    }
  })

  /** Character opened from the bag's hero row: closing it goes back to the bag. */
  let characterFromBag = false
  function closeCharacter(): void {
    if (characterFromBag && panel === 'character') {
      characterFromBag = false
      sfx('close')
      panel = 'inventory'
      return
    }
    toggle('character')
  }
  $effect(() => {
    if (panel !== 'character') characterFromBag = false
  })

  const showPrompt = $derived(!!ui.prompt.label && !blocked(layers, BLOCKS.actionPrompt))
</script>

<svelte:window onkeydown={onKeyGlobal} />

<main>
  <div class="stage" bind:this={stageEl}></div>

  {#if phase === 'playing' && session}
    <Hud
      onJournal={() => toggle('journal')}
      onCharacter={() => toggle('character')}
      onInventory={() => toggle('inventory')}
      {inventoryNew}
      onMenu={() => toggle('menu')}
      onEmote={() => (ui.emoteOpen = !ui.emoteOpen)}
      onGuides={() => {
        journalTab = 'guides'
        if (panel !== 'journal') toggle('journal')
      }}
      prompt={showPrompt && !touch ? ui.prompt.label : null}
    />
    {#if ui.emoteOpen && ui.presence.status === 'live' && !panel}
      <EmotePicker onPick={sendEmote} onClose={() => (ui.emoteOpen = false)} />
    {/if}
    {#if showPrompt && touch}
      <!-- Phones: the prompt sits beside the action button that does it. -->
      <div class="prompt touch" class:docked={!!promptDock} style={promptDock ? `right:${promptDock.right}px;bottom:${promptDock.bottom}px` : ''}>
        <span>{ui.prompt.label}</span>
      </div>
    {/if}
    <DialoguePanel />
    {#if !home.placement}<TouchControls />{/if}
    <HomeBar hidden={blocked(layers, BLOCKS.homeBar)} dockBottom={controlsDock} />
    <Banners />
    <Toasts />
    <Moments {session} />
    {#if ui.linkNotice && session.link}
      <LinkNotice
        onDismiss={() => {
          ui.linkNotice = null
          session?.link?.dismissRecovery()
        }}
      />
    {/if}
    {#if whatsNew.shown && promptClear}
      <WhatsNew releases={whatsNew.shown} onClose={() => whatsNew.close()} />
    {:else if account.partyPrompt?.partyWorld && promptClear}
      {@const pw = account.partyPrompt.partyWorld}
      {@const view = account.partyPrompt}
      <PartyPrompt world={pw} onJoin={() => account.openMove(pw, false, view)} onLater={() => (account.partyPrompt = null)} />
    {:else if account.leaverNotice && promptClear}
      {@const lv = account.leaverNotice}
      <LeaverNotice view={lv} onLeave={() => account.openLeave(lv)} onClose={() => account.closeLeaverNotice()} />
    {:else if update.ready && (promptClear || update.reloading)}
      <UpdateNotice onReload={reloadForUpdate} />
    {/if}
    {#if account.moving}
      {@const m = account.moving}
      <WorldMove {session} target={m.target} home={m.home} leave={m.leave ?? false} view={m.view} arriving={m.arriving} onMoved={(res) => account.onMoved(res)} onHere={() => account.onHere()} onCancel={() => (account.moving = null)} />
    {/if}
    {#if panel === 'journal'}
      <JournalPanel {session} onClose={() => toggle('journal')} initialTab={journalTab} />
    {:else if panel === 'library'}
      <LibraryPanel {session} onClose={() => toggle('library')} />
    {:else if panel === 'shop'}
      <SilasShop {session} onClose={() => toggle('shop')} />
    {:else if panel === 'board'}
      <NoticeBoard {session} onClose={() => toggle('board')} />
    {:else if panel === 'chest' || panel === 'bench'}
      <WorkshopPanel {session} mode={panel} initialChest={chestPick} onClose={() => ((panel = null), (chestPick = 'shared'))} />
    {:else if panel === 'hearth'}
      <HearthPanel {session} onClose={() => (panel = null)} />
    {:else if panel === 'desk'}
      <DeskPanel {session} onClose={() => (panel = null)} />
    {:else if panel === 'woodpile'}
      <WoodpilePanel {session} onClose={() => (panel = null)} />
    {:else if panel === 'shelf'}
      <GateShelfPanel {session} gate={shelfGate} onClose={() => (panel = null)} />
    {:else if panel === 'mail'}
      <MailPanel {session} to={mailTo} onClose={() => toggle('mail')} />
    {:else if panel === 'character'}
      <CharacterPanel {session} onClose={closeCharacter} onMenu={() => (panel = 'menu')} onInventory={() => (panel = 'inventory')} />
    {:else if panel === 'inventory'}
      <InventoryPanel
        {session}
        onClose={() => toggle('inventory')}
        onCharacter={() => {
          characterFromBag = true
          panel = 'character'
        }}
        onOwnChest={session?.link
          ? () => {
              chestPick = 'personal'
              panel = 'chest'
            }
          : undefined}
      />
    {:else if panel === 'menu'}
      <MenuPanel
        {session}
        onClose={() => toggle('menu')}
        {onSignedIn}
        onLogout={logout}
        onEnterWorld={() => {
          panel = null
          void account.continue()
        }}
        onMove={(target, home, view) => account.openMove(target, home, view)}
        onLeave={(view) => account.openLeave(view)}
        onWhatsNew={() => {
          panel = null
          whatsNew.openLatest()
        }}
      />
    {/if}
  {/if}

  {#if phase !== 'playing'}
    <div class="title-screen">
      <img class="bg" src="/assets/fingersnap/packed/fingersnap-village.webp" alt="" />
      <div class="shade" aria-hidden="true"></div>
      <div class="fireflies" aria-hidden="true">
        {#each Array.from({ length: 16 }) as _, i}
          <span style={`--x:${(i * 61) % 100}%; --y:${(i * 37) % 100}%; --d:${6 + (i % 5) * 1.7}s; --delay:${-(i * 0.9)}s`}></span>
        {/each}
      </div>

      <div class="title-col">
        <div class="logo">
          <span class="lamp"><Icon name="lantern" size={34} /></span>
          <h1>Glimway</h1>
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
            {#if ui.account && accountSummary && titleView !== 'guide'}
              <button type="button" class="primary continue" onclick={() => account.continue()} disabled={account.busy} data-testid="continue-world">
                <span class="big">{account.busy ? 'Opening your world…' : 'Continue'}</span>
                <span class="meta"><Icon name="person" size={12} /> {ui.account.name} · {accountSummary.place}{accountSummary.time ? ` · ${accountSummary.time}` : ''}</span>
                <span class="goal">{accountSummary.goal}</span>
              </button>
              <p class="world-chip" class:off={account.offline}>
                <Icon name={account.offline ? 'cloud' : 'lantern'} size={12} />
                {account.offline ? accountCopy.titleChipOffline : accountCopy.titleChip}
              </p>
              {#if account.error}<p class="title-error" role="alert">{account.error}</p>{/if}
              {#if !account.offline}
                <button type="button" class="secondary small" onclick={() => (confirmLogout = true)}>{accountCopy.logout}</button>
              {/if}
            {:else if titleView === 'guide' && session}
              <div class="panel guide-card">
                <h2 class="guide-title"><Icon name="person" size={18} /> {hasSave ? 'Sign in to your world' : titleChoice.habitica}</h2>
                <ConnectGuide {session} mode="title" onBack={() => (titleView = 'choice')} onReady={begin} {onSignedIn} />
              </div>
            {:else if hasSave && saveSummary}
              <button type="button" class="primary continue" onclick={begin}>
                <span class="big">Continue</span>
                <span class="meta"><Icon name="lantern" size={12} /> {saveSummary.place} · {saveSummary.time}</span>
                <span class="goal">{saveSummary.goal}</span>
              </button>
              <button type="button" class="secondary" onclick={requestNew}>New journey</button>
              {#if ui.server === 'available' && !ui.account}
                <!-- A returning player whose sign-in ended: the guest journey stays, nothing is replaced. -->
                <button type="button" class="ghost signin" onclick={() => (titleView = 'guide')}>
                  <Icon name="lantern" size={12} /> Sign in to your world
                </button>
              {/if}
            {:else}
              <div class="choice-col">
                <button type="button" class="primary continue" onclick={startHabitica}>
                  <span class="big">{titleChoice.habitica}</span>
                  <span class="meta">{emberLine(XP_PER_EMBER)}</span>
                </button>
                <button type="button" class="secondary guest" onclick={startFresh}>
                  <span class="big">{titleChoice.guest}</span>
                  <span class="gmeta">{titleChoice.guestMeta}</span>
                </button>
              </div>
            {/if}
          </div>
          {#if !touch}
            <p class="keys">
              <span><span class="kbd">WASD</span> walk</span>
              <span><span class="kbd">E</span> talk · act</span>
              <span><span class="kbd">F</span> ability</span>
              <span><span class="kbd">Shift</span> roll</span>
              <span><span class="kbd">Esc</span> menu</span>
            </p>
          {/if}
        {/if}
        {#if account.error && !(ui.account && accountSummary)}<p class="title-error" role="alert">{account.error}</p>{/if}
        <p class="fineprint">
          {ui.account ? 'Plays right here in your browser. Your journey saves to your world.' : 'Plays right here in your browser. Your saves stay on this device.'}
        </p>
      </div>
    </div>
  {/if}

  {#if account.gate?.kind === 'world'}
    {@const gate = account.gate}
    <WorldChoiceGate
      choice={gate.choice}
      busy={gate.busy}
      error={gate.error}
      picked={gate.picked}
      onChoose={(c) => void account.chooseWorld(c)}
      onCancel={() => (account.gate = null)}
    />
  {:else if account.gate?.kind === 'origin'}
    {@const gate = account.gate}
    <OriginChoice
      name={gate.name}
      local={gate.local}
      busy={gate.busy}
      error={gate.error}
      onChoose={(c) => void account.chooseOrigin(c)}
      onCancel={() => (account.gate = null)}
    />
  {:else if account.gate?.kind === 'elsewhere'}
    <LinkGate kind="elsewhere" busy={account.gate.busy} error={account.gate.error} onTakeOver={() => account.takeOverPending()} onBack={() => account.dropPending()} />
  {/if}

  {#if leaseBlock && !account.gate}
    <LinkGate
      kind={leaseBlock}
      busy={account.leaseBusy}
      error={account.leaseError}
      onTakeOver={() => account.takeOverInPlay()}
      onBack={() => window.location.reload()}
      backLabel={leaseCopy.toTitle}
    />
  {/if}

  {#if confirmLogout && account.cache?.dirty && account.cache.habiticaId === ui.account?.habiticaId}
    <!-- Progress from an earlier visit hasn't reached the world: upload it first. -->
    <ConfirmDialog
      title={accountCopy.logoutTitle}
      body={accountCopy.logoutDirty}
      confirmLabel={accountCopy.uploadFirst}
      onConfirm={() => {
        confirmLogout = false
        void account.continue()
      }}
      altLabel={accountCopy.logoutAnyway}
      onAlt={logout}
      onCancel={() => (confirmLogout = false)}
    />
  {:else if confirmLogout}
    <ConfirmDialog
      title={accountCopy.logoutTitle}
      body={accountCopy.logoutBody}
      confirmLabel={accountCopy.logout}
      onConfirm={logout}
      onCancel={() => (confirmLogout = false)}
    />
  {/if}

  {#if home.namePrompt}
    <NamePrompt
      title={home.namePrompt.title}
      body={home.namePrompt.body}
      placeholder={home.namePrompt.placeholder}
      max={home.namePrompt.max}
      onName={(name) => {
        home.namePrompt = null
        bus.emit(EV.homeNamed, { name })
      }}
      onCancel={() => {
        home.namePrompt = null
        bus.emit(EV.homeNamed, { name: null })
      }}
    />
  {/if}

  {#if home.leaveAsk}
    <ConfirmDialog
      title="Give up your place on the deed?"
      body={home.leaveAsk.shared
        ? `Silas strikes your name from ${home.leaveAsk.place}. You keep your pack and your own chest; everything set out, the lantern posts and the home chest stay with the others.`
        : `Silas strikes your name from ${home.leaveAsk.place}. You keep your pack and your own chest; everything set out, the lantern posts and the home chest stay with the land. With nobody on the deed it goes wild after ${HOMESTEAD_DATA.desolation.desolateAfterDays} days, and after ${HOMESTEAD_DATA.desolation.deedLostAfterDays} days the deed is lost. Until then Silas will give it back to you, as it stands.`}
      confirmLabel="Strike my name"
      danger
      onConfirm={() => {
        home.leaveAsk = null
        bus.emit(EV.homeAction, { action: 'home:leave-confirmed' })
      }}
      onCancel={() => (home.leaveAsk = null)}
    />
  {/if}

  {#if confirm === 'new'}
    <ConfirmDialog
      title="Start a new journey?"
      body="Your current journey will be replaced. Copy a save code from the Menu first if you might want it back."
      confirmLabel="Start fresh"
      danger
      onConfirm={showChoice}
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
  .prompt.touch {
    bottom: max(170px, calc(env(safe-area-inset-bottom) + 170px));
    padding-left: 14px;
  }
  /* Docked: a tag just above the action buttons, right-aligned with the big one. */
  .prompt.touch.docked {
    left: auto;
    /* Over a title card or quest ribbon (36): what the button does stays readable. */
    z-index: 37;
    max-width: min(70vw, 360px);
    transform: none;
    border-radius: 12px;
    white-space: normal;
    line-height: 1.2;
    animation: prompt-dock-in 0.18s ease-out;
  }
  @keyframes prompt-dock-in {
    from { opacity: 0; transform: translateY(6px); }
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
    grid-template-columns: minmax(0, 1fr);
    padding: 4px 6px 10px;
    box-sizing: border-box;
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
    white-space: nowrap;
    font-size: clamp(40px, 11vw, 60px);
    line-height: 1;
    letter-spacing: 0.04em;
    color: #fff3c4;
    text-shadow: 0 4px 0 #6b3a12, 0 0 30px rgba(255, 190, 80, 0.55), 0 0 2px var(--outline);
  }
  .tagline {
    margin: 6px 0 0;
    font-size: 18px;
    font-style: italic;
    color: var(--paper);
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
    box-shadow: 0 5px 0 #5a3410, 0 0 40px var(--gold-glow);
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
  .choice-col {
    width: min(380px, 100%);
    display: grid;
    gap: 12px;
  }
  .choice-col .continue {
    width: 100%;
  }
  .choice-col .continue .meta {
    text-align: center;
    line-height: 1.35;
  }
  .guest {
    display: grid;
    gap: 2px;
    padding: 10px 16px 12px;
  }
  .guest .big {
    font-family: var(--font-display);
    font-size: 19px;
  }
  .guest .gmeta {
    font-family: var(--font-body);
    font-size: 12.5px;
    font-weight: 600;
    opacity: 0.8;
  }
  .guide-card {
    box-sizing: border-box;
    width: min(440px, 100%);
    padding: 14px 18px 16px;
    text-align: left;
    user-select: text;
    -webkit-user-select: text;
  }
  .guide-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 4px;
    font-size: 20px;
  }
  .secondary {
    background: rgba(36, 28, 40, 0.75);
    color: var(--paper);
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
  .world-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: -2px 0 0;
    padding: 3px 10px;
    border-radius: 999px;
    font-family: var(--font-display);
    font-size: 12.5px;
    color: #fff3c4;
    background: var(--ok-tint);
    border: 1.5px solid rgba(143, 220, 210, 0.55);
  }
  .world-chip.off {
    background: rgba(79, 134, 214, 0.35);
    border-color: rgba(143, 184, 255, 0.55);
  }
  .ghost.signin {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    font-size: 14px;
    color: var(--paper);
    text-decoration: underline;
    text-decoration-color: rgba(244, 228, 193, 0.4);
    text-underline-offset: 4px;
  }
  .ghost.signin:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
  }
  .secondary.small {
    padding: 5px 14px;
    font-size: 14px;
  }
  .title-error {
    margin: 0;
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 13.5px;
    color: #ffe1d6;
    background: rgba(196, 82, 58, 0.45);
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
    color: var(--paper);
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
    background: var(--cream-hi);
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
