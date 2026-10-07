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
  import { RESIDENT_EV, type ResidentsMetPayload } from './game/residents'
  import { uiState } from './game/input'
  import { sfx, unlockAudio } from './game/sfx'
  import { isTouchFirst } from './ui/device'
  import Hud from './ui/Hud.svelte'
  import DialoguePanel from './ui/DialoguePanel.svelte'
  import JournalPanel from './ui/JournalPanel.svelte'
  import LibraryPanel from './ui/LibraryPanel.svelte'
  import { PAPER_EV } from './game/papers'
  import { HOME_EV, homesteadsFor, type ArrangeView, type NamePrompt as NamePromptView, type PlacementView } from './game/homestead'
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
  import { VILLAGE_EV, villageFor, type VillagePanel } from './game/village'
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
  import { accountName, api, connectedSession, isWorldChoice, probeServer } from './ui/account'
  import { prepareWilds, resetWilds } from './game/wilds/store'
  import { clearCache, loadCache, loadLatestCache, saveCache, type ConnectedCache } from './lib/api/cache'
  import { newKey } from './lib/api/client'
  import { errorCode, isUnreachable } from './lib/api/errors'
  import { hasProgress } from './lib/api/progress'
  import type { Snapshot, WorldChoice, WorldMoveResponse, WorldRef, WorldView } from './lib/api/types'
  import type { HabiticaProfile } from './lib/habitica/types'
  import OriginChoice from './ui/OriginChoice.svelte'
  import WorldChoiceGate from './ui/WorldChoiceGate.svelte'
  import LinkGate from './ui/LinkGate.svelte'
  import LinkNotice from './ui/LinkNotice.svelte'
  import UpdateNotice from './ui/UpdateNotice.svelte'
  import { update, watchForUpdates } from './ui/update.svelte'
  import PartyPrompt from './ui/PartyPrompt.svelte'
  import LeaverNotice from './ui/LeaverNotice.svelte'
  import WorldMove from './ui/WorldMove.svelte'
  import { firstWorldCopy, worldCopy } from './content/world-moves'
  import EmotePicker from './ui/EmotePicker.svelte'
  import { presence, startPresence, stopPresence } from './game/presence'
  import { EMOTES } from './content/presence'
  import { accountCopy, leaseCopy, originCopy } from './content/connected'
  import { setPlayInsets } from './game/viewport'
  import { pinnedProgress, recordGuideSteps, setPinned, usePinFor } from './game/guide-pin'

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

  // ---- connected play (Glimway server) ----
  /** Latest server snapshot for the signed-in account (null when offline or signed out). */
  let accountSnapshot = $state<Snapshot | null>(null)
  /** Signed in for the first time, the world not chosen yet (the server holds the sign-in). */
  let accountChoice = $state<WorldChoice | null>(null)
  /** The device's connected cache (offline copy, revision, lease). */
  let accountCache = $state<ConnectedCache | null>(null)
  /** Signed in earlier, but no server answered at load: play from the cache. */
  let accountOffline = $state(false)
  let accountBusy = $state(false)
  let accountError = $state('')
  type Gate =
    | { kind: 'world'; choice: WorldChoice; busy: boolean; error: string; picked: 'party' | 'own' | null }
    | { kind: 'origin'; name: string; local: GameState; key: string; busy: boolean; error: string }
    | { kind: 'elsewhere'; busy: boolean; error: string }
  /** A step between signing in and playing: the world choice, the origin choice or the lease. */
  let gate = $state<Gate | null>(null)
  /** A connected session waiting for the player to take over the lease. */
  let pending: Session | null = null
  /** In-play lease screen (taken over elsewhere, or signed out). */
  let leaseBusy = $state(false)
  let leaseError = $state('')
  let confirmLogout = $state(false)
  /** Your party plays in a world that isn't yours: the one-time prompt. */
  let partyPrompt = $state<WorldView | null>(null)
  /** The move confirmation (from the prompt or the Menu); `arriving` once it landed and the new world is opening. */
  let moving = $state<{ target: WorldRef; home: boolean; view: WorldView | null; arriving: boolean; leave?: boolean } | null>(null)
  /** Left the party whose world you live in (or were moved out of it): said once a sign-in. */
  let leaverNotice = $state<WorldView | null>(null)

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

  /** Save preview for the title screen's Continue card. */
  const saveSummary = $derived.by(() => {
    if (!hasSave || !session) return null
    const s = session.state
    const mins = Math.floor(s.playSeconds / 60)
    return {
      place: areaInfo(displayArea(s)).name,
      goal: questObjective(s.quest),
      time: mins < 1 ? 'just started' : mins < 60 ? `${mins} min played` : `${Math.floor(mins / 60)}h ${mins % 60}m played`
    }
  })

  /** The signed-in account's Continue card on the title screen. */
  const accountSummary = $derived.by(() => {
    if (!ui.account) return null
    if (accountChoice) return { place: 'Your world', time: '', goal: firstWorldCopy.titleGoal }
    if (accountSnapshot && accountSnapshot.saveOrigin === null) {
      return { place: 'Your world', time: '', goal: 'Choose how to begin.' }
    }
    const cached = accountCache && accountCache.habiticaId === ui.account.habiticaId ? accountCache : null
    const st = cached && (cached.dirty || !accountSnapshot) ? cached.state : accountSnapshot?.state
    if (!st) return null
    const mins = Math.floor(st.playSeconds / 60)
    return {
      place: areaInfo(displayArea(st)).name,
      goal: questObjective(st.quest),
      time: mins < 1 ? 'just started' : mins < 60 ? `${mins} min played` : `${Math.floor(mins / 60)}h ${mins % 60}m played`
    }
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
    const onArea = (p: AreaPayload) => {
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
      sfx('discover')
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
        .then((snap) => afterMove(snap, worldCopy.landed))
        .catch(() => ui.toast({ text: worldCopy.landed, icon: 'world' }))
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
    const pairs: [string, (...args: never[]) => void][] = [
      [EV.stats, onStats],
      [EV.quest, onQuest],
      [EV.area, onArea],
      [EV.prompt, onPrompt],
      [EV.goalDir, onGoalDir],
      [EV.toast, onToast],
      [EV.defeat, onDefeat],
      [EV.ability, onAbility],
      [EV.rolled, onRolled],
      [EV.cinematic, onCinematic],
      [EV.portraits, onPortraits],
      [RESIDENT_EV.met, onResidentsMet],
      [EV.artIcons, onArtIcons],
      [EV.discovery, onDiscovery],
      [EV.link, onLink],
      [EV.presence, onPresence],
      [EV.linkNotice, onLinkNotice],
      [EV.mutationResolved, onResolved],
      [EV.wilds, onWilds],
      [PAPER_EV.openLibrary, onOpenLibrary],
      [HOME_EV.openShop, onOpenShop],
      [HOME_EV.arrange, onArrange],
      [HOME_EV.placement, onPlacement],
      [HOME_EV.thumbs, onThumbs],
      [HOME_EV.namePrompt, onNamePrompt],
      [HOME_EV.confirmLeave, onConfirmLeave],
      [HOME_EV.goal, onHomeGoal],
      [HOME_EV.room, onRoom],
      [VILLAGE_EV.open, onVillageOpen],
      [VILLAGE_EV.changed, onVillageChanged]
    ]
    for (const [ev, fn] of pairs) bus.on(ev, fn)
    return () => {
      for (const [ev, fn] of pairs) bus.off(ev, fn)
    }
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
        void initServer()
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
    unlockAudio()
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
  }

  // ------------------------------------------------------------ connected play

  /**
   * Is there a Glimway server, and are we signed in? A valid session
   * cookie means signed in even with no remembered Habitica token. No server
   * (a guest-only build, or offline) leaves guest play exactly as it was,
   * except that a device with a connected cache can keep playing offline.
   */
  async function initServer(): Promise<void> {
    const probe = await probeServer()
    if (probe.kind === 'signed-in') {
      const cache = await loadCache(probe.snapshot.habiticaId)
      accountCache = cache
      ui.server = 'available'
      accountSnapshot = probe.snapshot
      ui.account = { habiticaId: probe.snapshot.habiticaId, name: accountName(probe.snapshot, cache) }
    } else if (probe.kind === 'choose-world') {
      // A first sign-in whose world is still to choose (a reload, a closed tab): Continue asks again.
      ui.server = 'available'
      accountChoice = probe.choice
      ui.account = { habiticaId: probe.choice.habiticaId, name: probe.choice.displayName || 'Your hero' }
    } else if (probe.kind === 'signed-out') {
      ui.server = 'available'
    } else {
      ui.server = 'unavailable'
      // No server can say who is signed in: offer the latest account played here.
      const cache = await loadLatestCache()
      accountCache = cache
      if (cache) {
        accountOffline = true
        ui.account = { habiticaId: cache.habiticaId, name: cache.name || 'Your hero' }
      }
    }
  }

  /** Title: Continue in your world. */
  async function continueAccount(): Promise<void> {
    if (accountBusy || starting || !ui.account) return
    accountBusy = true
    accountError = ''
    try {
      if (accountChoice) {
        await openWorldChoice(accountChoice)
        return
      }
      if (accountSnapshot && accountSnapshot.saveOrigin === null) {
        openOrigin(ui.account.name)
        return
      }
      const s = await connectedSession({ snapshot: accountSnapshot, cache: await loadCache(ui.account.habiticaId), name: ui.account.name })
      await s.link!.reconnect(false)
      await settle(s)
    } finally {
      accountBusy = false
    }
  }

  /** The guide signed in to the server (or the world choice was just answered). */
  async function onSignedIn(answer: Snapshot | WorldChoice, profile: HabiticaProfile | null): Promise<void> {
    ui.server = 'available'
    accountOffline = false
    if (isWorldChoice(answer)) {
      // Signed in, but where to live comes first.
      accountChoice = answer
      accountSnapshot = null
      ui.account = { habiticaId: answer.habiticaId, name: answer.displayName || profile?.name || 'Your hero' }
      panel = null
      gate = { kind: 'world', choice: answer, busy: false, error: '', picked: null }
      return
    }
    const snapshot = answer
    accountChoice = null
    accountSnapshot = snapshot
    const name = snapshot.displayName || snapshot.importedProfile?.name || profile?.name || ui.account?.name || 'Your hero'
    ui.account = { habiticaId: snapshot.habiticaId, name }
    // Signed in from the Menu: the next step (origin, lease) takes the screen.
    panel = null
    accountCache = await loadCache(snapshot.habiticaId)
    if (snapshot.saveOrigin === null) {
      const guest = session && !session.link ? session : null
      if (guest && hasProgress(guest.state)) openOrigin(name)
      else await chooseOrigin('fresh', name)
      return
    }
    // The account already has a journey: this device's guest save stays put.
    if (session && !session.link && hasProgress(session.state)) ui.toast({ text: originCopy.alreadySet })
    await startAccount(snapshot, name)
  }

  /** Ask (again) where to live: the server's question, fresh, so the party's head count is current. */
  async function openWorldChoice(known: WorldChoice): Promise<void> {
    let choice = known
    try {
      choice = await api.worldChoice()
      accountChoice = choice
    } catch (err) {
      const code = errorCode(err)
      if (code === 'world-chosen') {
        // Chosen on another device meanwhile: carry on into that world.
        accountChoice = null
        const snap = await api.state()
        await onSignedIn(snap, null)
        return
      }
      if (code === 'unauthorized') {
        accountChoice = null
        ui.account = null
        accountError = 'Your sign-in ended. Sign in again to play in your world.'
        return
      }
      // Offline: ask with what we know; choosing will say if it can't reach the server.
    }
    gate = { kind: 'world', choice, busy: false, error: '', picked: null }
  }

  /** First sign-in: the party's world, or one of your own. The same sign-in carries on. */
  async function chooseWorld(pick: 'party' | 'own'): Promise<void> {
    const g = gate?.kind === 'world' ? gate : null
    if (!g || g.busy) return
    g.busy = true
    g.error = ''
    g.picked = pick
    try {
      const snap = await api.worldChoose(pick)
      gate = null
      await onSignedIn(snap, null)
    } catch (err) {
      const code = errorCode(err)
      if (code === 'world-chosen') {
        gate = null
        accountChoice = null
        try {
          await onSignedIn(await api.state(), null)
        } catch {
          accountError = firstWorldCopy.offline
        }
        return
      }
      if (code === 'unauthorized') {
        gate = null
        accountChoice = null
        ui.account = null
        accountError = 'Your sign-in ended. Sign in again to play in your world.'
        return
      }
      g.busy = false
      g.picked = null
      if (code === 'party-closed' || code === 'party-open-denied' || code === 'no-party') {
        // The party's world can't be had now: ask again with what's left,
        // or (nothing left to ask) step into the world of their own made for them.
        try {
          g.choice = accountChoice = await api.worldChoice()
        } catch (again) {
          if (errorCode(again) === 'world-chosen') {
            gate = null
            accountChoice = null
            try {
              await onSignedIn(await api.state(), null)
            } catch {
              accountError = firstWorldCopy.offline
            }
            return
          }
          /* keep the old question */
        }
        g.error = firstWorldCopy.partyGone
        return
      }
      g.error = isUnreachable(err) ? firstWorldCopy.offline : firstWorldCopy.failed
    }
  }

  function openOrigin(name: string): void {
    const local = session && !session.link ? session.state : createNewGame()
    gate = { kind: 'origin', name, local, key: newKey(), busy: false, error: '' }
  }

  /** First sign-in for the account: bring this device's journey, or start fresh. */
  async function chooseOrigin(choice: 'migrate' | 'fresh', fallbackName?: string): Promise<void> {
    const g = gate?.kind === 'origin' ? gate : null
    if (g?.busy) return
    const key = g?.key ?? newKey()
    const name = g?.name ?? fallbackName ?? ui.account?.name ?? 'Your hero'
    if (g) {
      g.busy = true
      g.error = ''
    }
    const guest = session && !session.link ? session : null
    try {
      const snap = await api.origin({
        choice,
        key,
        ...(choice === 'migrate' && guest ? { save: { state: guest.state, vitalsSource: guest.vitalsSource } } : {})
      })
      accountSnapshot = snap
      gate = null
      await startAccount(snap, snap.displayName || snap.importedProfile?.name || name)
      if (choice === 'migrate' && session?.link) ui.toast({ text: 'Your journey came with you into your world.', icon: 'lantern' })
    } catch (err) {
      if (errorCode(err) === 'already-set') {
        // Chosen already (another device, a race): keep the local save as a
        // guest save on this device and load the account.
        gate = null
        try {
          const snap = await api.state()
          accountSnapshot = snap
          ui.toast({ text: originCopy.alreadySet })
          await startAccount(snap, snap.displayName || snap.importedProfile?.name || name)
        } catch {
          accountError = originCopy.offline
        }
        return
      }
      const error = isUnreachable(err) ? originCopy.offline : originCopy.failed
      if (g) {
        g.busy = false
        g.error = error
      } else {
        gate = { kind: 'origin', name, local: guest?.state ?? createNewGame(), key, busy: false, error }
      }
    }
  }

  async function startAccount(snapshot: Snapshot, name: string): Promise<void> {
    if (ui.account) ui.account = { ...ui.account, name }
    const s = await connectedSession({ snapshot, cache: await loadCache(snapshot.habiticaId), name })
    await s.link!.reconnect(false)
    await settle(s)
  }

  /** After the first lease attempt: play, ask to take over, or step back. */
  async function settle(s: Session): Promise<void> {
    const status = s.link!.status
    if (status === 'superseded') {
      pending = s
      gate = { kind: 'elsewhere', busy: false, error: '' }
      return
    }
    if (status === 'signed-out') {
      s.destroy(true)
      ui.link = null
      ui.account = null
      accountSnapshot = null
      accountError = 'Your sign-in ended. Sign in again to play in your world.'
      return
    }
    // Online, or offline (the link keeps retrying and the world plays on).
    await enterSession(s)
  }

  async function takeOverPending(): Promise<void> {
    const g = gate?.kind === 'elsewhere' ? gate : null
    if (!pending || !g || g.busy) return
    g.busy = true
    g.error = ''
    await pending.link!.takeOver()
    if (pending.link!.status === 'superseded') {
      g.busy = false
      g.error = leaseCopy.failed
      return
    }
    const s = pending
    pending = null
    await settle(s)
  }

  function dropPending(): void {
    pending?.destroy(true)
    pending = null
    gate = null
    ui.link = null
  }

  /** Swap the running session for a connected one (title or mid-game). */
  async function enterSession(next: Session): Promise<void> {
    gate = null
    pending = null
    const prev = session
    session = next
    accountOffline = next.link?.status === 'offline'
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
    void checkPartyPrompt(next)
  }

  /**
   * Your party has a world and you live elsewhere: say so once (the server remembers it
   * was shown; the Menu keeps the offer). Reads need only the session.
   */
  async function checkPartyPrompt(s: Session): Promise<void> {
    if (!s.link || s.link.status !== 'online') return
    try {
      const v = await api.world()
      // PartyPrompt records it as shown when it is really on screen.
      if (session !== s) return
      if (v.movedOutAt > 0 || v.leaver) leaverNotice = v
      else if (v.prompt && v.partyWorld) partyPrompt = v
    } catch {
      /* the Menu still offers it */
    }
  }

  function openMove(target: WorldRef, home: boolean, view: WorldView | null, leave = false): void {
    panel = null
    partyPrompt = null
    leaverNotice = null
    moving = { target, home, view, arriving: false, leave }
  }

  /** "Leave now": to your own world, or one made for you (the move screen, no cooldown). */
  function openLeave(view: WorldView): void {
    openMove(view.ownWorld ?? { id: '', ownerId: '', ownerName: '', members: 0, ownerHere: false, party: false }, true, view, true)
  }

  /** The "you were moved out" notice was seen: the server stops reporting it. */
  function closeLeaverNotice(): void {
    if (leaverNotice && leaverNotice.movedOutAt > 0) void api.worldNotice().catch(() => undefined)
    leaverNotice = null
  }

  /**
   * After a move: a fresh connected session from the server's answer, so
   * every per-world view (the lane, homesteads, the village, the Wilds, the
   * mailbox badge) starts over in the new world. The lease is the same one:
   * this page and this sign-in still hold it. The move screen stays up
   * ("Arriving…"), freezing the old scene, until the new world is open.
   */
  async function afterMove(snapshot: Snapshot, line: string): Promise<void> {
    if (moving) moving.arriving = true
    else moving = { target: { id: snapshot.worldId, ownerId: '', ownerName: '', members: 0, ownerHere: false, party: false }, home: false, view: null, arriving: true }
    partyPrompt = null
    leaverNotice = null
    const prev = session
    try {
      // Its link already adopted the move's answer; nothing is left to upload.
      prev?.destroy(true)
      resetWilds()
      villageUi.waiting = 0
      const name = ui.account?.name ?? snapshot.displayName
      const s = await connectedSession({ snapshot, cache: null, name })
      await s.link!.reconnect(false)
      await settle(s)
      moving = null
      ui.toast({ text: line, icon: 'world' })
    } catch {
      // The move stands on the server; this page couldn't open the new
      // world. Back to the title, where Continue steps in.
      moving = null
      stopPresence()
      stopGame(game)
      game = null
      areaShown = false
      accountSnapshot = snapshot
      accountError = worldCopy.arriveFailed
      phase = 'title'
    }
  }

  function onMoved(res: WorldMoveResponse): void {
    const m = moving
    const v = res.result.world
    void afterMove(
      res,
      m?.leave && !m.target.id ? worldCopy.done(worldCopy.newWorld.toLowerCase()) : m?.home ? worldCopy.doneHome : worldCopy.done(worldCopy.place(m?.target ?? v.world, m ? true : v.partyHome))
    )
  }

  /** Already in that world (another device moved first): step in. */
  function onHere(): void {
    void api
      .state()
      .then((snap) => afterMove(snap, worldCopy.landed))
      .catch(() => {
        moving = null
        ui.toast({ text: worldCopy.offline, kind: 'error' })
      })
  }

  async function takeOverInPlay(): Promise<void> {
    if (!session?.link || leaseBusy) return
    leaseBusy = true
    leaseError = ''
    await session.link.takeOver()
    leaseBusy = false
    if (session.link.status === 'superseded') leaseError = leaseCopy.failed
  }

  /**
   * Log out of the world: upload what's pending, end the session, back to
   * guest play. The account's cache is cleared only when the server has
   * everything; unsent progress (a refused or slow upload, offline play from
   * an earlier visit) stays on this device for the next sign-in.
   */
  async function logout(): Promise<void> {
    confirmLogout = false
    const link = session?.link
    const habiticaId = link?.habiticaId ?? ui.account?.habiticaId
    let keep = false
    if (link) {
      await Promise.race([link.flush().catch(() => undefined), new Promise((r) => setTimeout(r, 4000))])
      keep = link.dirty
      if (keep) await link.keepForNextSignIn()
    } else if (habiticaId) {
      const cache = await loadCache(habiticaId)
      keep = cache?.dirty === true
      if (cache && keep) await saveCache({ ...cache, loggedOut: true })
    }
    try {
      await api.logout()
    } catch {
      /* the cookie expires on its own */
    }
    if (habiticaId && !keep) await clearCache(habiticaId)
    if (link) session?.destroy(true)
    window.location.reload()
  }

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

  /** A confirmed new journey: nothing is written until the player picks a way to play. */
  function showChoice(): void {
    confirm = null
    if (starting) return
    if (hasSave) {
      session?.destroy(true)
      session = new Session(createNewGame())
      hasSave = false
      ui.vitalsSource = 'demo'
      ui.importedProfile = null
    }
    titleView = 'choice'
  }

  /** Guest path: today's demo start. */
  async function startFresh(): Promise<void> {
    confirm = null
    if (starting) return
    session?.destroy(true)
    session = new Session(createNewGame())
    hasSave = false
    ui.vitalsSource = 'demo'
    ui.importedProfile = null
    void session.save()
    await begin()
  }

  /** Habitica path: a fresh game whose connect guide runs before Mara's first line. */
  function startHabitica(): void {
    if (starting) return
    session?.destroy(true)
    session = new Session(createNewGame())
    hasSave = false
    ui.vitalsSource = 'demo'
    ui.importedProfile = null
    void session.save()
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

  $effect(() => {
    uiState.panelOpen = panel !== null || ui.endingOpen || gate !== null || leaseBlock !== null || home.namePrompt !== null || home.leaveAsk !== null || moving !== null
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
    if (phase !== 'playing' || ui.dialogueOpen || ui.cinematic || confirm || gate || leaseBlock || moving) return
    const t = e.target as HTMLElement | null
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    // Typing J/C in a text field must never toggle panels — but Escape always
    // closes (standard dismiss UX, including from a focused field).
    if (typing && e.code !== 'Escape') return
    if (ui.endingOpen) return
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

  /**
   * Measure what the interface covers while playing: the HUD along the top,
   * the touch buttons along the bottom. The camera keeps the hero out of it
   * (src/game/viewport.ts), and the cards and toasts sit under the HUD
   * (--hud-bottom). On a phone the prompt docks beside the action button.
   */
  let promptDock = $state<{ right: number; bottom: number } | null>(null)
  /** Touch: px from the screen's bottom to just above the action buttons (the Arrange button docks there). */
  let controlsDock = $state<number | undefined>(undefined)
  $effect(() => {
    if (phase !== 'playing') return
    let raf = 0
    const measure = () => {
      raf = 0
      const vh = window.innerHeight
      const vw = window.innerWidth
      // Layout boxes, not painted ones: a hidden HUD (a cinematic) or hidden
      // controls (a conversation) keep their place, so the camera never
      // slides when a dialogue opens and closes.
      const hud = document.querySelector<HTMLElement>('.hud')
      const hudBottom = hud
        ? Math.max(0, ...[...hud.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains('why') && !c.classList.contains('sr')).map((c) => hud.offsetTop + c.offsetTop + c.offsetHeight))
        : 0
      const root = document.documentElement.style
      root.setProperty('--hud-bottom', `${Math.round(hudBottom)}px`)
      if (!touch) {
        // Desktop: the HUD is a corner card on a wide screen; the camera centres as before.
        setPlayInsets({ top: 0, right: 0, bottom: 0, left: 0 })
        // The action bar and the prompt tag on it.
        root.setProperty('--dock-bottom', '128px')
        return
      }
      // The buttons at the bottom right always; the joystick at the bottom left when it's fixed there.
      const box = (sel: string) => {
        const el = document.querySelector<HTMLElement>(`.controls ${sel}`)
        // Hidden controls only fade (opacity): their boxes stay where they are laid out.
        return el && el.offsetHeight > 0 ? el.getBoundingClientRect() : null
      }
      // The cluster: the action button and the roll/cast column. The belt's
      // small buttons arc above it as an overlay: the docks keep clear of
      // them, the camera only in landscape (where the hero walks beside them).
      const union = (rs: (DOMRect | null)[]) => {
        const r = rs.filter((x): x is DOMRect => !!x)
        return r.length ? { top: Math.min(...r.map((x) => x.top)), left: Math.min(...r.map((x) => x.left)) } : null
      }
      const cluster = union([box('.act'), box('.col')])
      const ring = union([...document.querySelectorAll<HTMLElement>('.controls .belt .bslot')].map((el) => (el.offsetHeight > 0 ? el.getBoundingClientRect() : null)))
      const pad = box('.pad')
      if (vw > vh) {
        // Landscape: the thumbs sit at the sides, so the hero keeps to the middle band.
        const left = Math.min(cluster?.left ?? vw, ring?.left ?? vw)
        setPlayInsets({ top: hudBottom, right: cluster ? vw - left : 0, bottom: 0, left: pad ? pad.right : 0 })
      } else {
        const tops = [cluster?.top, pad?.top].filter((t): t is number => t !== undefined)
        setPlayInsets({ top: hudBottom, right: 0, bottom: tops.length ? vh - Math.min(...tops) : 0, left: 0 })
      }
      controlsDock = cluster ? Math.round(vh - Math.min(cluster.top, ring?.top ?? vh) + 10) : undefined
      // The prompt sits just above the cluster and its belt (and the Arrange button, when it's out), right-aligned with the action button.
      const act = box('.act')
      const arrange = document.querySelector<HTMLElement>('[data-testid="arrange"]')?.getBoundingClientRect()
      const above = Math.min(cluster?.top ?? vh, ring?.top ?? vh, arrange && arrange.height > 0 ? arrange.top : vh)
      promptDock = act && cluster ? { right: Math.round(vw - act.right), bottom: Math.round(vh - above + 8) } : null
      // Cards and notices that sit low keep above the buttons and the prompt tag on them.
      root.setProperty('--dock-bottom', `${Math.round(vh - above + 8 + (promptDock ? 48 : 0))}px`)
    }
    const soon = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    const ro = new ResizeObserver(soon)
    // Only the HUD, the controls and the Arrange button matter: watch them,
    // and re-attach when one of them mounts or unmounts.
    const mo = new MutationObserver(soon)
    const top = new MutationObserver(() => watch())
    const watch = () => {
      ro.disconnect()
      mo.disconnect()
      for (const el of document.querySelectorAll('.hud, .hud > *, .controls, .controls .actions, .controls .act, .controls .col, .controls .pad, .controls .belt, [data-testid="arrange"]')) ro.observe(el)
      for (const el of document.querySelectorAll('.hud, .controls')) mo.observe(el, { childList: true, subtree: true })
      soon()
    }
    const main = document.querySelector('main')
    if (main) top.observe(main, { childList: true })
    window.addEventListener('resize', soon)
    watch()
    return () => {
      ro.disconnect()
      mo.disconnect()
      top.disconnect()
      window.removeEventListener('resize', soon)
      if (raf) cancelAnimationFrame(raf)
      setPlayInsets({ top: 0, right: 0, bottom: 0, left: 0 })
    }
  })

  /** Nothing else is asking for the player's attention: the party prompt may show. */
  const promptClear = $derived(
    !moving &&
      !ui.linkNotice &&
      panel === null &&
      !ui.cinematic &&
      !ui.dialogueOpen &&
      !ui.endingOpen &&
      !leaseBlock &&
      !gate &&
      !confirm &&
      !confirmLogout &&
      !home.placement &&
      !home.namePrompt &&
      !home.leaveAsk &&
      !ui.bannerUp
  )
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

  const showPrompt = $derived(!!ui.prompt.label && !ui.dialogueOpen && panel === null && !ui.cinematic && !ui.endingOpen && !home.placement)
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
    <HomeBar hidden={panel !== null || ui.dialogueOpen || ui.cinematic || gate !== null || leaseBlock !== null} dockBottom={controlsDock} />
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
    {#if partyPrompt?.partyWorld && promptClear}
      {@const pw = partyPrompt.partyWorld}
      <PartyPrompt world={pw} onJoin={() => openMove(pw, false, partyPrompt)} onLater={() => (partyPrompt = null)} />
    {:else if leaverNotice && promptClear}
      {@const lv = leaverNotice}
      <LeaverNotice view={lv} onLeave={() => openLeave(lv)} onClose={closeLeaverNotice} />
    {:else if update.ready && (promptClear || update.reloading)}
      <UpdateNotice onReload={reloadForUpdate} />
    {/if}
    {#if moving}
      <WorldMove {session} target={moving.target} home={moving.home} leave={moving.leave ?? false} view={moving.view} arriving={moving.arriving} {onMoved} {onHere} onCancel={() => (moving = null)} />
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
          void continueAccount()
        }}
        onMove={openMove}
        onLeave={openLeave}
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
              <button type="button" class="primary continue" onclick={continueAccount} disabled={accountBusy} data-testid="continue-world">
                <span class="big">{accountBusy ? 'Opening your world…' : 'Continue'}</span>
                <span class="meta"><Icon name="person" size={12} /> {ui.account.name} · {accountSummary.place}{accountSummary.time ? ` · ${accountSummary.time}` : ''}</span>
                <span class="goal">{accountSummary.goal}</span>
              </button>
              <p class="world-chip" class:off={accountOffline}>
                <Icon name={accountOffline ? 'cloud' : 'lantern'} size={12} />
                {accountOffline ? accountCopy.titleChipOffline : accountCopy.titleChip}
              </p>
              {#if accountError}<p class="title-error" role="alert">{accountError}</p>{/if}
              {#if !accountOffline}
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
        {#if accountError && !(ui.account && accountSummary)}<p class="title-error" role="alert">{accountError}</p>{/if}
        <p class="fineprint">
          {ui.account ? 'Plays right here in your browser. Your journey saves to your world.' : 'Plays right here in your browser. Your saves stay on this device.'}
        </p>
      </div>
    </div>
  {/if}

  {#if gate?.kind === 'world'}
    <WorldChoiceGate
      choice={gate.choice}
      busy={gate.busy}
      error={gate.error}
      picked={gate.picked}
      onChoose={(c) => void chooseWorld(c)}
      onCancel={() => (gate = null)}
    />
  {:else if gate?.kind === 'origin'}
    <OriginChoice
      name={gate.name}
      local={gate.local}
      busy={gate.busy}
      error={gate.error}
      onChoose={(c) => void chooseOrigin(c)}
      onCancel={() => (gate = null)}
    />
  {:else if gate?.kind === 'elsewhere'}
    <LinkGate kind="elsewhere" busy={gate.busy} error={gate.error} onTakeOver={takeOverPending} onBack={dropPending} />
  {/if}

  {#if leaseBlock && !gate}
    <LinkGate
      kind={leaseBlock}
      busy={leaseBusy}
      error={leaseError}
      onTakeOver={takeOverInPlay}
      onBack={() => window.location.reload()}
      backLabel={leaseCopy.toTitle}
    />
  {/if}

  {#if confirmLogout && accountCache?.dirty && accountCache.habiticaId === ui.account?.habiticaId}
    <!-- Progress from an earlier visit hasn't reached the world: upload it first. -->
    <ConfirmDialog
      title={accountCopy.logoutTitle}
      body={accountCopy.logoutDirty}
      confirmLabel={accountCopy.uploadFirst}
      onConfirm={() => {
        confirmLogout = false
        void continueAccount()
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
        bus.emit(HOME_EV.named, { name })
      }}
      onCancel={() => {
        home.namePrompt = null
        bus.emit(HOME_EV.named, { name: null })
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
        bus.emit(HOME_EV.action, { action: 'home:leave-confirmed' })
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
    background: rgba(47, 127, 122, 0.55);
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
    color: #f4e4c1;
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
