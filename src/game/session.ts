/**
 * Session owns the live GameState, applies quest events through the shared
 * state module, and persists at meaningful boundaries (never per frame).
 *
 * Rules from the demo design:
 * - Damage, position, and enemy defeats persist across reloads. A reload must
 *   never act as a heal: vitals decreases schedule an immediate save.
 * - Quest transitions are gated against the expected source stage before
 *   calling advanceQuest, because the shared logic rejects illegal or
 *   repeated transitions.
 * - Save failures surface to the interface, not only to the console.
 */
import { profileFor } from '../lib/profile.ts'
import type { GameState, QuestEvent, QuestStage } from '../lib/state.ts'
import { advanceQuest, questObjective, questShortGoal } from '../lib/state.ts'
import type { HabiticaProfile, LoadedSave, VitalsSource } from '../lib/habitica/types.ts'
import { resolveDefeatRecovery } from '../lib/habitica/sync.ts'
import { checkSpend, grantEmbers, questEmbers, spendEmbers, type EmberSpend, type SpendCheck, type SpendReason } from '../lib/embers.ts'
import { saveCurrent, saveGame } from '../lib/save.ts'
import { bus, EV, type StatsPayload, type ToastPayload } from './events.ts'
import type { Link } from './link.ts'
import { DEFEATED, FOUND, isClientMark } from '../lib/api/predict.ts'
import { displayArea } from '../content/world.ts'
import { foundPapers, paperFlag } from '../content/papers.ts'
import { announcePaper } from './papers.ts'

/** advanceQuest is only called when the current stage matches this gate. */
const QUEST_GATE: Record<QuestEvent, QuestStage> = {
  accept: 'new',
  'find-clue': 'accepted',
  'defeat-guardian': 'clue-found',
  'light-lantern': 'guardian-defeated',
  'return-village': 'lantern-lit'
}

export class Session {
  state: GameState
  /** Save provenance (format 2): governs defeat recovery and sync rules. */
  vitalsSource: VitalsSource
  private profile: HabiticaProfile | null = null
  get importedProfile(): HabiticaProfile | null {
    return profileFor({ profileSource: this.profile ? 'habitica' : 'none', profile: this.profile })
  }
  set importedProfile(value: HabiticaProfile | null) { this.profile = value }
  private saveTimer: number | null = null
  private autosaveTimer: number | null = null
  private destroyed = false
  /** Increments on reset/teardown; stale async syncs compare and abort. */
  private generation = 0
  /** True while a sync persistence is in flight — ordinary saves defer. */
  private syncInFlight = false
  /**
   * Connected play: the server link. Null for guests, whose saves stay on
   * this device exactly as before. With a link, saves go to the connected
   * cache and the server, spends and syncs go through the server, and quest
   * embers arrive from the server instead of being granted here.
   */
  readonly link: Link | null
  /** A server spend or sync is out: the world waits for its answer. */
  remoteBusy = false

  constructor(
    state: GameState,
    provenance?: { vitalsSource?: VitalsSource; importedProfile?: HabiticaProfile | null },
    link: Link | null = null
  ) {
    this.state = state
    this.vitalsSource = provenance?.vitalsSource ?? 'demo'
    this.importedProfile = provenance?.importedProfile ?? null
    this.link = link
    link?.attach(this)
  }

  get currentGeneration(): number {
    return this.generation
  }

  /** True while a sync persistence owns the save file, or a reload is
   * saving. The world freezes its resource/combat mutations for the (brief)
   * write so a mid-flight enemy hit or regen tick cannot be reverted by the
   * committed snapshot. */
  get persistenceInFlight(): boolean {
    return this.syncInFlight || this.remoteBusy || this.frozen
  }

  /** A reload is saving (settle): the world holds still, as for a sync. */
  private frozen = false

  /** Saving for a reload: the scene stops outright (physics, timers, the play clock). */
  get reloading(): boolean {
    return this.frozen
  }

  /** True when the given generation is still the live one. */
  isCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.generation
  }

  /** True when imported vitals have hit zero: combat and expeditions are
   * locked (village-bound, no auto revival) — sync still works there and
   * credits genuine external healing. Movement and village activities stay. */
  get zeroHpLocked(): boolean {
    return this.vitalsSource === 'imported' && this.state.hp <= 0
  }

  /**
   * Apply a synced save (import or reconciliation) from the shared logic.
   * Persistence-first: the snapshot + provenance are saved successfully
   * BEFORE the runtime commits them — a failed save leaves the old state
   * untouched (no silent success). Pass the generation captured when the
   * sync started; stale syncs (reset/disconnect/newer sync in between) abort.
   */
  async applySynced(save: LoadedSave, generation: number): Promise<'committed' | 'stale' | 'save-failed'> {
    if (!this.isCurrent(generation)) return 'stale'
    this.syncInFlight = true
    let outcome: 'committed' | 'stale' | 'save-failed' = 'stale'
    try {
      try {
        await saveGame(save.state, {
          vitalsSource: save.vitalsSource,
          importedProfile: save.importedProfile ?? null
        })
      } catch (err) {
        console.warn('[glimway] sync save failed', err)
        bus.emit(EV.toast, {
          text: 'Your character arrived, but this browser wouldn\u2019t let us save it. Nothing changed.',
          kind: 'error'
        })
        outcome = 'save-failed'
        return outcome
      }
      // Post-save generation check: a reset/teardown during the awaited write
      // means this result must not enter RAM. The write itself cannot linger
      // on disk: the shared save queue is FIFO, and a reset always writes its
      // own fresh save afterwards, so the newest intent lands last.
      if (!this.isCurrent(generation)) {
        // The synced write may have landed on disk before the reset/disconnect
        // was noticed. When this session still owns persistence, restore the
        // current intent durably so stale imported state never lingers.
        if (!this.destroyed) {
          this.syncInFlight = false
          await this.save()
        }
        outcome = 'stale'
        return outcome
      }
      this.state = save.state
      this.vitalsSource = save.vitalsSource
      this.importedProfile = save.importedProfile ?? null
      this.emitStats()
      bus.emit(EV.profileChanged, { profile: this.importedProfile })
      outcome = 'committed'
      return outcome
    } finally {
      this.syncInFlight = false
      if (this.pendingSave || outcome === 'committed') {
        this.pendingSave = false
        this.saveSoon()
      }
    }
  }

  get questStage(): QuestStage {
    return this.state.quest
  }

  /**
   * Apply a quest event and notify the UI. Connected: a `quest-step`
   * operation, shown at once as predicted (the server grants the step's
   * items, marks and gifts, and the answer's state carries them).
   */
  applyQuestEvent(event: QuestEvent): void {
    if (this.destroyed) return
    const expected = QUEST_GATE[event]
    if (this.state.quest !== expected) return // illegal or repeated transition
    if (this.link) {
      this.link.questStep(event)
      this.emitQuest()
      return
    }
    try {
      this.state = advanceQuest(this.state, event)
    } catch (err) {
      console.warn('[glimway] advanceQuest rejected event', event, err)
      const toast: ToastPayload = { text: 'The story hiccupped — that step didn\u2019t take. Try again?', kind: 'error' }
      bus.emit(EV.toast, toast)
      return
    }
    this.emitQuest()
    const reward = questEmbers(event)
    if (reward > 0) this.addEmbers(reward, `+${reward} embers — a little warmth from the road.`)
    this.saveSoon()
  }

  /** Credit embers locally (quest beats). Habitica-earned embers arrive via
   *  applySynced, already folded into the synced state. Never for connected
   *  play: balances are server-owned. */
  addEmbers(n: number, toast?: string): void {
    if (this.destroyed || n <= 0 || this.link) return
    this.state = grantEmbers(this.state, n)
    this.emitStats()
    if (toast) bus.emit(EV.toast, { text: toast, icon: 'ember' })
    this.saveSoon()
  }

  /**
   * Record a one-way story flag (once) and save soon. Connected: a `mark`
   * for the client namespaces, `take-paper` for a paper; every other
   * namespace is written by the server only (design 2.2) and never here.
   */
  addFlag(flag: string): void {
    if (this.destroyed || this.state.flags.includes(flag)) return
    if (this.link) {
      if (flag.startsWith('paper:')) this.link.takePaper(flag.slice('paper:'.length))
      else if (isClientMark(flag)) this.link.mark(flag)
      else console.warn('[glimway] a server-written mark is not the client\u2019s to add', flag)
      return
    }
    this.state = { ...this.state, flags: [...this.state.flags, flag] }
    this.saveSoon()
  }

  checkSpend(spend: EmberSpend): SpendCheck {
    return checkSpend(this.state, spend, { imported: this.vitalsSource === 'imported' })
  }

  /** Spend embers via the shared rules. Returns null on success, or why it
   *  was refused (and nothing changed). Saved promptly: it is a purchase. */
  spend(spend: EmberSpend): null | 'busy' | SpendReason {
    if (this.destroyed || this.syncInFlight || this.link) return 'busy'
    const ctx = { imported: this.vitalsSource === 'imported' }
    const check = checkSpend(this.state, spend, ctx)
    if (!check.ok) return check.reason
    this.state = spendEmbers(this.state, spend, ctx)
    this.emitStats()
    this.saveSoon()
    return null
  }

  /**
   * Connected play: show the link's view (the adopted server state with the
   * outbox predicted on top). The live place, vitals and play time stay
   * this page's own unless `relocate` (the server or a fall moved the hero)
   * or `vitals` (the link's combat overlay moved them). `quiet`: the scene
   * already moves the hero itself (a fall's walk home).
   */
  applyServer(
    view: GameState,
    provenance: { vitalsSource: VitalsSource; importedProfile: HabiticaProfile | null },
    opts: { relocate?: boolean; vitals?: { hp: number; mana: number }; quiet?: boolean } = {}
  ): void {
    if (this.destroyed) return
    const prev = this.state
    const relocate = opts.relocate === true
    const profileChanged = JSON.stringify(provenance.importedProfile) !== JSON.stringify(this.importedProfile)
    const next: GameState = {
      ...view,
      area: relocate ? view.area : prev.area,
      position: relocate ? { ...view.position } : prev.position,
      hp: Math.min(Math.max(opts.vitals?.hp ?? prev.hp, 0), view.maxHp),
      mana: Math.min(Math.max(opts.vitals?.mana ?? prev.mana, 0), view.maxMana),
      playSeconds: Math.max(prev.playSeconds, view.playSeconds)
    }
    const region = relocate ? view.wildsRegion : prev.wildsRegion
    if (region) next.wildsRegion = region
    else delete next.wildsRegion
    if (prev.outerSeason) next.outerSeason = prev.outerSeason
    this.state = next
    this.vitalsSource = provenance.vitalsSource
    this.importedProfile = provenance.importedProfile
    this.emitStats()
    if (prev.quest !== next.quest) this.emitQuest()
    // Papers the server granted on its own (a quest step's, a claim's).
    for (const id of foundPapers(next.flags)) if (!prev.flags.includes(paperFlag(id))) announcePaper(this, id)
    if (profileChanged) bus.emit(EV.profileChanged, { profile: this.importedProfile })
    // Balances and paid outcomes change what markers and lanterns show.
    bus.emit(EV.worldRefresh)
    if (relocate && !opts.quiet && (prev.area !== next.area || Math.hypot(prev.position.x - next.position.x, prev.position.y - next.position.y) > 4)) {
      bus.emit(EV.relocate, { area: next.area, x: next.position.x, y: next.position.y })
    }
  }

  emitQuest(): void {
    bus.emit(EV.quest, {
      stage: this.state.quest,
      objective: questObjective(this.state.quest),
      short: questShortGoal(this.state.quest)
    })
  }

  emitStats(): void {
    const s = this.state
    const payload: StatsPayload = {
      hp: Math.max(0, Math.ceil(s.hp)),
      maxHp: s.maxHp,
      mana: Math.floor(s.mana),
      maxMana: s.maxMana,
      embers: s.embers
    }
    bus.emit(EV.stats, payload)
  }

  emitArea(): void {
    bus.emit(EV.area, { areaId: displayArea(this.state) })
  }

  /**
   * Damage/heal and resource changes (local only, never Habitica).
   * Any decrease schedules a save so a quick reload cannot restore the lost
   * vitals (reload-as-heal is forbidden).
   */
  setVitals(hp: number, mana: number): void {
    const prevHp = this.state.hp
    const prevMana = this.state.mana
    this.state.hp = Math.min(Math.max(hp, 0), this.state.maxHp)
    this.state.mana = Math.min(Math.max(mana, 0), this.state.maxMana)
    if (this.state.hp !== prevHp || this.state.mana !== prevMana) this.emitStats()
    if (this.state.hp < prevHp || this.state.mana < prevMana) this.saveSoon()
  }

  /** A cast that the server's cast budget counts (a signature skill). */
  noteCast(): void {
    this.link?.noteCast()
  }

  recordDefeat(enemyId: string): void {
    if (this.link) {
      if (!this.state.defeatedEnemies.includes(enemyId)) this.link.mark(`${DEFEATED}${enemyId}`)
      return
    }
    if (!this.state.defeatedEnemies.includes(enemyId)) {
      this.state.defeatedEnemies.push(enemyId)
      this.saveSoon()
    }
  }

  recordDiscovery(discoveryId: string, label: string): boolean {
    if (this.state.discoveries.includes(discoveryId)) return false
    if (this.link) this.link.mark(`${FOUND}${discoveryId}`)
    else this.state.discoveries.push(discoveryId)
    bus.emit(EV.discovery, { id: discoveryId, label })
    this.saveSoon()
    return true
  }

  tickPlaySeconds(dtSec: number): void {
    this.state.playSeconds += dtSec
  }

  /**
   * Defeat recovery via the shared rule set: demo vitals wake fully in
   * Hearthwick; imported vitals wake at the provisional imported rate
   * (25% HP / 50% mana). Story progress is kept and Habitica is never
   * touched either way — this label must stay visible to the player.
   */
  defeat(): void {
    if (this.link) {
      // The fall is an operation: recovery and the walk home are predicted now.
      this.link.fall()
      this.emitStats()
      return
    }
    const synced = resolveDefeatRecovery({
      state: this.state,
      vitalsSource: this.vitalsSource,
      importedProfile: this.importedProfile ?? undefined
    })
    this.state = synced.state
    this.vitalsSource = synced.vitalsSource
    this.importedProfile = synced.importedProfile ?? null
    this.emitStats()
    this.saveSoon()
  }

  /** Debounced save — bursts coalesce into one write. While a sync
   * persistence owns the disk, the request is remembered and flushed when
   * the sync settles (all outcomes), so decreases are never swallowed. */
  private pendingSave = false

  saveSoon(): void {
    if (this.destroyed) return
    if (this.syncInFlight) {
      this.pendingSave = true
      return
    }
    if (this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 350)
  }

  startAutosave(intervalMs = 15000): void {
    this.stopAutosave()
    this.autosaveTimer = window.setInterval(() => {
      void this.save()
    }, intervalMs)
  }

  /** Bump on disconnect so an in-flight sync does not commit afterwards;
   * durable current intent is re-persisted by the applySynced stale path. */
  markReset(): void {
    this.generation += 1
  }

  stopAutosave(): void {
    if (this.autosaveTimer !== null) {
      window.clearInterval(this.autosaveTimer)
      this.autosaveTimer = null
    }
  }

  /**
   * Ordinary saves pass explicit provenance (defense in depth — save.ts
   * would preserve the stored values anyway) and are skipped while a sync
   * persistence owns the disk. After a completed-but-rejected sync write,
   * the session's current intent is re-persisted so stale imported state
   * never lingers.
   */
  async save(): Promise<boolean> {
    if (this.destroyed) return false
    if (this.link) {
      await this.link.persist()
      return true
    }
    if (this.syncInFlight) {
      this.pendingSave = true
      return false
    }
    try {
      await saveGame(this.state, {
        vitalsSource: this.vitalsSource,
        // null is meaningful: it explicitly CLEARS a stored imported profile
        // (demo rollback). undefined would preserve it.
        importedProfile: this.importedProfile
      })
      return true
    } catch (err) {
      console.warn('[glimway] save failed', err)
      bus.emit(EV.toast, {
        text: 'Couldn\u2019t save just now — your latest steps may not stick.',
        kind: 'error'
      })
      return false
    }
  }

  /**
   * Before a reload for a new version: hold the world still, then save
   * until the stored copy is the live game. Guests: the browser write,
   * repeated if the game changed during it. Connected: the link writes and
   * drains everything in flight (Link.settle). Bounded by `timeoutMs`. On
   * 'saved' the world stays frozen for the reload; otherwise play resumes.
   */
  async settle(timeoutMs = 8000): Promise<'saved' | 'offline' | 'unsaved'> {
    if (this.destroyed) return 'unsaved'
    this.frozen = true
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const link = this.link
    let timer = 0
    const timeout = new Promise<'unsaved'>((r) => (timer = window.setTimeout(() => r('unsaved'), timeoutMs)))
    const work = link ? link.settle() : this.settleGuest()
    let result = await Promise.race([work.catch(() => 'unsaved' as const), timeout])
    window.clearTimeout(timer)
    if (result === 'saved') return result
    if (link) {
      link.cancelSettle()
      if (link.status === 'offline') result = 'offline'
    }
    this.frozen = false
    return result
  }

  private async settleGuest(): Promise<'saved' | 'unsaved'> {
    // A sync owns the save file: its own write lands first. Try again in a moment.
    if (this.syncInFlight) return 'unsaved'
    const live = () => ({ state: this.state, vitalsSource: this.vitalsSource, importedProfile: this.importedProfile })
    return (await saveCurrent(live)) ? 'saved' : 'unsaved'
  }

  /**
   * Immediate save — used at hard boundaries. `leaving` is for pagehide: a
   * connected upload may then skip the queue. A tab that is only hidden
   * (visibilitychange) keeps the queue's order.
   */
  flushSync(leaving = false): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // Connected: the upload starts before the cache write, so a closing tab
    // still sends it.
    if (this.link && !this.destroyed) void this.link.persist({ urgent: true, leaving })
    else void this.save()
  }

  /**
   * Teardown. By default writes a final save of the current state (page hide);
   * pass skipSave when the session is being deliberately discarded (new game),
   * so a stale state cannot overwrite the fresh save afterwards.
   */
  destroy(skipSave = false): void {
    if (this.destroyed) return
    this.stopAutosave()
    this.generation += 1 // invalidate any in-flight syncs
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const finalState = this.state
    const finalVitalsSource = this.vitalsSource
    const finalProfile = this.importedProfile
    if (this.link) {
      const link = this.link
      const last = skipSave ? Promise.resolve() : link.persist({ urgent: true, leaving: true })
      this.destroyed = true
      void last.finally(() => link.stop())
      return
    }
    this.destroyed = true
    if (skipSave) return
    void saveGame(finalState, {
      vitalsSource: finalVitalsSource,
      importedProfile: finalProfile
    }).catch((err) => {
      console.warn('[glimway] final save failed', err)
    })
  }
}
