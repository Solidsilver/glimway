/**
 * Village life, game side: today's date in Hearthwick, the world's village
 * projects (and the papers and visible changes they bring), and the
 * homestead's workshop goods: storage, crafting and mail. No Phaser here;
 * the scene (src/game/entities/festivals.ts, village changes) and the panels
 * read it and hear about changes on the bus.
 *
 * The calendar comes from the server (its clock rules), falling back to the
 * local computation when it can't be reached; everything else needs a world.
 */
import { calendarAt, type CalendarDay } from '../lib/calendar.ts'
import { blankProjects, emptyCounts, papersDue } from '../lib/village.ts'
import type { Asset, AssetCounts, ChestId, ContributeResponse, CraftResponse, DeskCopyResponse, HearthCraftResponse, Mail, MailActionResponse, MendResponse, MendResult, ProjectView, ProjectsView, RepairsView, ShelfActionResponse, ShelfView, StorageMoveResponse, WoodpileActionResponse, WoodpileView, WorkshopView } from '../lib/api/types.ts'
import type { Refusal, Result } from '../lib/api/errors.ts'
import { villageErrorText } from '../content/errors.ts'
import { paperFlag } from '../content/papers.ts'
import { bus, EV, type MutationResolvedPayload } from './events.ts'
import { clockMoved, gameNow, setGameNow } from './clock.ts'
import { grantPaper } from './papers.ts'
import { calendarFind } from '../lib/wilds/stories.ts'
import { homesteadsFor } from './homestead.ts'
import type { Session } from './session.ts'

export type VillagePanel = 'board' | 'chest' | 'bench' | 'mail' | 'hearth' | 'desk' | 'woodpile' | 'shelf'

export type Status = 'idle' | 'loading' | 'ready' | 'offline'


export class Village {
  calendar: CalendarDay
  /** Calendar came from the server or this device (offline). */
  calendarSource: 'server' | 'local' = 'local'
  projects: ProjectView[] = blankProjects()
  worldFlags: string[] = []
  projectsStatus: Status
  repairs: RepairsView = { open: [], mended: [], worldFlags: [], history: [] }
  repairsStatus: Status
  inventory: AssetCounts | null = null
  storage: AssetCounts | null = null
  /** Your own small chest at home (goes with you if you leave the deed). */
  personal: AssetCounts | null = null
  /** The shared chest and bench: 'open', or why not ('not-a-member', 'tier-required'). */
  shared: string = 'open'
  mail: Mail[] = []
  mailStatus: Status
  private grantable: string[] = []

  private readonly session: Session

  /** Every one of these calls needs the world's link (there is no guest play). */
  private get link(): NonNullable<Session['link']> {
    return this.session.link!
  }

  constructor(session: Session) {
    this.session = session
    bus.on(EV.mutationResolved, (p) => {
      if (current?.village === this) void this.onResolved(p)
    })
    // Reading a notice board after you have seen the outer Wilds turn (with
    // the road lit): the old notices, kept on one rusted nail.
    bus.on(EV.villageOpen, (p) => {
      if (current?.village !== this || p.panel !== 'board') return
      const s = this.session.state
      const paper = calendarFind('board', { flags: s.flags, late: s.quest === 'complete', mark: null })
      if (paper) grantPaper(this.session, paper)
    })
    this.calendar = calendarAt(this.now())
    this.projectsStatus = 'idle'
    this.repairsStatus = 'idle'
    this.mailStatus = 'idle'
  }

  now(): number {
    return gameNow()
  }

  /** One of ours whose answer was lost is now known: re-read and say so. */
  private async onResolved(p: MutationResolvedPayload): Promise<void> {
    const k = p.op.kind
    if (k === 'home' || k === 'items') return
    // Re-read everything the operation could have changed before saying so.
    if (k === 'contribute') {
      await this.loadProjects()
      await this.loadMail() // carried counts
    } else if (k === 'mend') {
      this.repairsStatus = 'idle'
      await this.loadRepairs()
    } else if (k === 'storage' || k === 'craft' || k === 'hearth' || k === 'desk' || k === 'woodpile') await this.loadStorage()
    else {
      await this.loadMail()
      await this.loadHomeAfterMail() // a piece sent, claimed or recalled
    }
    const what = k === 'contribute' ? 'gift to the project' : k === 'mend' ? 'repair' : k === 'craft' ? 'work at the bench' : k === 'hearth' ? 'batch at the hearth' : k === 'desk' ? 'copy at the desk' : k === 'woodpile' ? 'trip to the woodpile' : k === 'storage' ? 'trip to the chest' : 'parcel'
    bus.emit(EV.toast, { text: p.outcome === 'landed' ? `Your last ${what} went through after all.` : `Your last ${what} didn’t go through. Nothing changed.`, icon: 'scroll' })
  }

  // ------------------------------------------------------------ carried goods

  /** What the caller carries, by material (missing = 0). */
  carriedMaterials(): Record<string, number> {
    return this.inventory?.materials ?? {}
  }

  /** Adopt authoritative material balances (any server answer that carries them). */
  setCarriedMaterials(m: Record<string, number>): void {
    const inv = this.inventory ?? emptyCounts()
    this.inventory = { ...inv, materials: { ...m } }
    this.emit('goods')
  }

  // ------------------------------------------------------------ calendar

  private calendarRead: Promise<CalendarDay> | null = null
  private dayTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Today, from the server when connected (its clock rules), else locally.
   * Concurrent calls share one read; each read schedules the next at the
   * coming UTC day boundary, so the date turns without leaving the scene.
   */
  loadCalendar(): Promise<CalendarDay> {
    if (this.calendarRead) return this.calendarRead
    this.calendarRead = this.readCalendar().finally(() => {
      this.calendarRead = null
      this.scheduleDayTurn()
    })
    return this.calendarRead
  }

  private async readCalendar(): Promise<CalendarDay> {
    const link = this.session.link
    if (link && !clockMoved()) {
      try {
        const served = await this.link.api.calendar()
        // The dev clock moved while the read was out: the server's today is
        // not the moved one, so the local calendar answers instead.
        if (!clockMoved()) {
          this.calendar = served
          this.calendarSource = 'server'
          this.emit('calendar')
          return this.calendar
        }
      } catch {
        /* fall back to the local calendar */
      }
    }
    this.calendar = calendarAt(this.now())
    this.calendarSource = 'local'
    this.emit('calendar')
    return this.calendar
  }

  /** Seconds until the current calendar day ends (UTC midnight; also the Turning's notice window). */
  private secondsLeftToday(): number {
    return this.calendar.startsAt + this.calendar.day * 86400 - this.now()
  }

  private scheduleDayTurn(): void {
    if (this.dayTimer !== null) clearTimeout(this.dayTimer)
    if (current?.village !== this) return
    // A little past the boundary; never a tight loop if a server clock lags.
    const ms = Math.max(5_000, (this.secondsLeftToday() + 1) * 1000)
    this.dayTimer = setTimeout(() => {
      this.dayTimer = null
      if (current?.village === this) void this.loadCalendar()
    }, Math.min(ms, 6 * 3600 * 1000))
  }

  private calendarLoaded = false

  /** The first read this session (server when connected); later, only when stale. */
  ensureCalendar(): void {
    if (!this.calendarLoaded) {
      this.calendarLoaded = true
      void this.loadCalendar()
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && current?.village === this) this.refreshIfStale()
        })
      }
    } else this.refreshIfStale()
  }

  /** Re-read when the day has turned (cheap: compares against the next midnight UTC). */
  refreshIfStale(): void {
    const now = this.now()
    if (this.secondsLeftToday() <= 0 || now < this.calendar.startsAt) void this.loadCalendar()
  }

  /** Dev/playtest clock: pretend it is `unix` now, and let time run on from there. */
  setDevNow(unix: number | null): void {
    setGameNow(unix)
    void this.loadCalendar()
    bus.emit(EV.clock)
  }

  // ------------------------------------------------------------ projects

  async loadProjects(): Promise<void> {
    this.projectsStatus = 'loading'
    const r = await this.link.readWith((raw) => raw.projects())
    if (!r.ok) {
      this.projectsStatus = 'offline'
      this.emit('projects')
      return
    }
    this.adoptProjects(r.value)
  }

  private adoptProjects(v: ProjectsView): void {
    this.projects = v.projects
    this.worldFlags = v.worldFlags
    this.grantable = v.grantablePapers
    this.projectsStatus = 'ready'
    this.deliverPapers()
    this.emit('projects')
  }

  /** Completed projects you helped with hand you their papers (late ones wait for the lit road). */
  deliverPapers(): string[] {
    const s = this.session
    const due = papersDue(this.grantable, (id) => s.state.flags.includes(paperFlag(id)), s.questStage === 'complete')
    for (const id of due) grantPaper(s, id)
    return due
  }

  hasWorldFlag(flag: string): boolean {
    return this.worldFlags.includes(flag) || (this.repairs?.worldFlags.includes(flag) ?? false)
  }

  async loadRepairs(): Promise<void> {
    if (this.repairsStatus === 'ready') return
    this.repairsStatus = 'loading'
    const r = await this.link.readWith((raw) => raw.repairs())
    if (!r.ok) {
      this.repairsStatus = 'offline'
      return
    }
    this.adoptRepairs(r.value)
  }

  private adoptRepairs(v: RepairsView): void {
    this.repairs = v
    this.repairsStatus = 'ready'
    this.emit('repairs')
    bus.emit(EV.villageChanged)
  }

  async mend(repairId: string): Promise<Result<MendResult>> {
    const r = await this.link.mutate<MendResponse>({ kind: 'mend', id: repairId })
    if (!r.ok) return fail(r.code)
    this.adoptRepairs(r.res.result.repairs)
    return { ok: true, value: r.res.result }
  }

  async contribute(projectId: string, materials: Record<string, number>): Promise<Result<{ completed: boolean }>> {
    const given = Object.fromEntries(Object.entries(materials).filter(([, n]) => n > 0))
    if (Object.keys(given).length === 0) return fail('invalid-contribution')
    const before = this.projects.find((p) => p.id === projectId)?.stage
    const r = await this.link.mutate<ContributeResponse>({ kind: 'contribute', id: projectId, fields: { materials: given } })
    if (!r.ok) return fail(r.code)
    this.adoptProjects(r.res.result)
    this.setCarriedMaterials(r.res.result.materials)
    const completed = before !== 'complete' && r.res.result.projects.find((p) => p.id === projectId)?.stage === 'complete'
    return { ok: true, value: { completed } }
  }

  // ------------------------------------------------------------ storage & crafting

  async loadStorage(): Promise<Result> {
    const r = await this.link.readWith((raw) => raw.storage())
    if (!r.ok) return fail(r.code)
    this.inventory = r.value.inventory
    this.storage = r.value.storage
    this.personal = r.value.personal
    this.shared = r.value.shared
    this.adoptHome(r.value.home)
    this.emit('goods')
    return { ok: true, value: undefined }
  }

  /** Move goods between your pack and a chest at home (the shared one, or your own). */
  async move(direction: 'deposit' | 'withdraw', asset: Asset, chest: ChestId = 'shared'): Promise<Result> {
    const r = await this.link.mutate<StorageMoveResponse>({ kind: 'storage', fields: { direction, asset, chest } })
    if (!r.ok) return fail(r.code)
    this.inventory = r.res.result.inventory
    this.storage = r.res.result.storage
    this.personal = r.res.result.personal
    this.shared = r.res.result.shared
    this.adoptHome(r.res.result.home)
    this.emit('goods')
    return { ok: true, value: undefined }
  }

  async craft(recipeId: string, qty: number): Promise<Result<Asset>> {
    const r = await this.link.mutate<CraftResponse>({ kind: 'craft', fields: { recipeId, qty } })
    if (!r.ok) return fail(r.code)
    this.inventory = r.res.result.inventory
    this.storage = r.res.result.storage
    this.personal = r.res.result.personal
    this.shared = r.res.result.shared
    this.adoptHome(r.res.result.home)
    this.emit('goods')
    return { ok: true, value: r.res.result.output }
  }

  /** Cook food, remedies and oils at the cottage hearth. Everything made carries your maker's mark. */
  async hearthCraft(recipeId: string, qty: number): Promise<Result<Asset>> {
    const r = await this.link.mutate<HearthCraftResponse>({ kind: 'hearth', fields: { recipeId, qty } })
    if (!r.ok) return fail(r.code)
    this.adoptWorkshop(r.res.result)
    return { ok: true, value: r.res.result.output }
  }

  /** Copy a recipe page you hold at the writing desk, to give away. */
  async deskCopy(pageId: string, qty: number): Promise<Result<{ pageId: string; qty: number }>> {
    const r = await this.link.mutate<DeskCopyResponse>({ kind: 'desk', fields: { pageId, qty } })
    if (!r.ok) return fail(r.code)
    this.adoptWorkshop(r.res.result)
    return { ok: true, value: { pageId: r.res.result.pageId, qty: r.res.result.qty } }
  }

  /** The woodpile's stacks and how far each has seasoned. */
  async loadWoodpile(): Promise<Result<WoodpileView>> {
    const r = await this.link.readWith((raw) => raw.woodpile())
    if (!r.ok) return fail(r.code)
    return { ok: true, value: r.value.woodpile }
  }

  /** Stack green timber on the woodpile, or collect the seasoned timber. */
  async woodpile(action: 'stack' | 'collect', qty = 1, stackId?: string): Promise<Result<{ woodpile: WoodpileView; collectedQty?: number }>> {
    const r = await this.link.mutate<WoodpileActionResponse>({ kind: 'woodpile', fields: { action, qty, stackId } })
    if (!r.ok) return fail(r.code)
    this.adoptWorkshop(r.res.result)
    return { ok: true, value: { woodpile: r.res.result.woodpile, collectedQty: r.res.result.collectedQty } }
  }

  /** Read the gift shelf at a Commons gate. */
  async loadShelf(gate: number): Promise<Result<ShelfView>> {
    const r = await this.link.readWith((raw) => raw.shelf(gate))
    if (!r.ok) return fail(r.code)
    return { ok: true, value: r.value.shelf }
  }

  /** Stock or take from the gift shelf. */
  async shelfAction(req: { op: 'stock' | 'take'; gate: number; slot: number; asset?: Asset }): Promise<Result<ShelfActionResponse>> {
    const r = await this.link.mutate<ShelfActionResponse>({ kind: 'shelf', fields: req })
    if (!r.ok) return fail(r.code)
    if (r.res.inventory) {
      this.inventory = r.res.inventory
      this.emit('goods')
    }
    return { ok: true, value: r.res }
  }

  private adoptWorkshop(w: WorkshopView): void {
    this.inventory = w.inventory
    this.storage = w.storage
    this.personal = w.personal
    this.shared = w.shared
    this.adoptHome(w.home)
    this.emit('goods')
  }

  private adoptHome(home: import('../lib/api/types').HomeView | null): void {
    if (home) homesteadsFor(this.session).adoptHome(home)
  }

  // ------------------------------------------------------------ mail

  async loadMail(): Promise<Result> {
    this.mailStatus = 'loading'
    const r = await this.link.readWith((raw) => raw.mail())
    if (!r.ok) {
      this.mailStatus = 'offline'
      this.emit('mail')
      return fail(r.code)
    }
    const before = new Map(this.mail.map((m) => [m.id, m]))
    this.mail = r.value.mail
    this.mailCursor = r.value.nextCursor ?? null
    // Legacy pending backlogs past the current caps come in further pages.
    let pending = r.value.nextPendingCursor ?? null
    for (let i = 0; pending && i < 10; i++) {
      const more = await this.link.readWith((raw) => raw.mail({ pendingCursor: pending! }))
      if (!more.ok) break
      this.upsertMail(more.value.mail)
      pending = more.value.nextPendingCursor ?? null
    }
    if (r.value.inventory) {
      this.inventory = r.value.inventory
      this.emit('goods')
    }
    this.mailStatus = 'ready'
    this.emit('mail')
    // A read can settle decoration mail (claimed elsewhere, returned after
    // 30 days, recipient removed): the pieces move, so the home must follow.
    const moved = this.mail.some((m) => {
      if (m.asset.kind !== 'decoration') return false
      const was = before.get(m.id)
      return !was || was.claimedAt !== m.claimedAt || (was.returnedAt ?? null) !== (m.returnedAt ?? null)
    })
    if (moved && before.size > 0) await this.loadHomeAfterMail()
    return { ok: true, value: undefined }
  }

  /** Where older settled mail continues (null: there is no more). */
  mailCursor: string | null = null

  /** The next page of settled mail (pending mail repeats; upserted by id). */
  async loadOlderMail(): Promise<Result> {
    if (!this.mailCursor) return { ok: true, value: undefined }
    const cursor = this.mailCursor
    const r = await this.link.readWith((raw) => raw.mail({ cursor }))
    if (!r.ok) return fail(r.code)
    this.upsertMail(r.value.mail)
    this.mailCursor = r.value.nextCursor ?? null
    this.emit('mail')
    return { ok: true, value: undefined }
  }

  private upsertMail(rows: Mail[]): void {
    const byId = new Map(this.mail.map((m) => [m.id, m]))
    for (const m of rows) byId.set(m.id, m)
    this.mail = [...byId.values()].sort((a, b) => b.sentAt - a.sentAt || (a.id < b.id ? 1 : -1))
  }

  /** Parcels addressed to you, not yet collected. */
  waitingCount(): number {
    const me = this.session.link?.accountId
    return this.mail.filter((m) => m.toId === me && m.claimedAt === null && !m.returnedAt).length
  }

  async send(toId: string, asset: Asset): Promise<Result> {
    const r = await this.link.mutate<MailActionResponse>({ kind: 'mail-send', fields: { toId, asset } })
    if (!r.ok) return fail(r.code)
    this.adoptMail(r.res.result)
    return { ok: true, value: undefined }
  }

  async claim(id: string): Promise<Result<Asset | undefined>> {
    const r = await this.link.mutate<MailActionResponse>({ kind: 'mail-claim', id })
    if (!r.ok) return fail(r.code)
    this.adoptMail(r.res.result)
    return { ok: true, value: r.res.result.asset }
  }

  async recall(id: string): Promise<Result> {
    const r = await this.link.mutate<MailActionResponse>({ kind: 'mail-recall', id })
    if (!r.ok) return fail(r.code)
    this.adoptMail(r.res.result)
    return { ok: true, value: undefined }
  }

  private adoptMail(res: { mail: Mail[]; inventory: AssetCounts }): void {
    // A mutation returns the first page: merge it, keeping older history.
    this.upsertMail(res.mail)
    this.inventory = res.inventory
    this.mailStatus = 'ready'
    this.emit('mail')
    this.emit('goods')
    void this.loadHomeAfterMail()
  }

  /** Decorations moved by mail change what can be placed: refresh the home. */
  private async loadHomeAfterMail(): Promise<void> {
    const homes = homesteadsFor(this.session)
    const gate = homes.myGate
    if (gate !== null) await homes.fetchHome(gate)
  }

  private emit(what: string): void {
    bus.emit(EV.villageChanged, { what })
  }
}

function fail(code: string): Refusal {
  return { ok: false, code, text: villageErrorText(code) }
}

let current: { session: Session; village: Village } | null = null

/** The village state for this session (made on first use). */
export function villageFor(session: Session): Village {
  if (!current || current.session !== session) current = { session, village: new Village(session) }
  return current.village
}
