/**
 * Village life, game side: today's date in Hearthwick, the world's village
 * projects (and the papers and visible changes they bring), and the
 * homestead's workshop goods: storage, crafting and mail. No Phaser here;
 * the scene (src/game/entities/festivals.ts, village changes) and the panels
 * read it and hear about changes on the bus.
 *
 * Guests get the calendar computed locally from content/calendar.json (the
 * same function the server uses); everything else needs a world.
 */
import { calendarAt, type CalendarDay } from '../lib/calendar'
import { blankProjects, emptyCounts, papersDue } from '../lib/village'
import { MAIL } from '../lib/mail'
import type { Asset, AssetCounts, ChestId, ContributeResponse, CraftResponse, DeskCopyResponse, HearthCraftResponse, Mail, MailActionResponse, MendResponse, MendResult, ProjectView, ProjectsView, RepairsView, ShelfActionResponse, ShelfView, StorageMoveResponse, WoodpileActionResponse, WoodpileView, WorkshopView } from '../lib/api/types'
import type { ApiErrorCode } from '../lib/api/errors'
import { paperFlag } from '../content/papers'
import { bus, EV } from './events'
import { clockMoved, gameNow, setGameNow } from './clock'
import type { MutationOp } from './link'
import { grantPaper } from './papers'
import { calendarFind } from '../lib/wilds/stories'
import { homesteadsFor } from './homestead'
import type { Session } from './session'

export const VILLAGE_EV = {
  /** Something here changed: { what: 'calendar' | 'projects' | 'goods' | 'mail' }. */
  changed: 'village:changed',
  /** Open a panel: { panel: 'board' | 'chest' | 'bench' | 'mail' | 'hearth' | 'desk' | 'woodpile' | 'shelf', to?: string, gate?: number }. */
  open: 'ui:village-open'
} as const

export type VillagePanel = 'board' | 'chest' | 'bench' | 'mail' | 'hearth' | 'desk' | 'woodpile' | 'shelf'

export type Status = 'guest' | 'idle' | 'loading' | 'ready' | 'offline'

export type VillageResult<T = undefined> = { ok: true; value: T } | { ok: false; code: string; text: string }

/** Player-facing words for phase-5 refusals. */
export function villageErrorText(code: ApiErrorCode | string): string {
  switch (code) {
    case 'tier-required':
      return 'That needs the workshop. Silas can build it on.'
    case 'insufficient-materials':
      return 'You don’t have enough materials for that.'
    case 'insufficient-items':
      return 'You don’t have that many to move. Anything set out has to be put away first.'
    case 'insufficient-storage':
      return 'The chest doesn’t hold that many.'
    case 'chest-full':
      return 'Your own chest is full. It’s a small one.'
    case 'not-a-member':
      return 'That’s for the folk on this deed.'
    case 'already-taken-today':
      return 'One gift from this shelf each day. Walk by again tomorrow.'
    case 'slot-occupied':
      return 'Something is already in that slot.'
    case 'slot-empty':
      return 'That slot is empty.'
    case 'not-giveable':
      return 'Only giveable things may go on the shelf.'
    case 'shelf-not-placed':
      return 'There is no gift shelf set out at this gate.'
    case 'item-not-available':
      return 'That piece isn’t free to move just now.'
    case 'invalid-quantity':
      return 'That’s not an amount Silas would write down.'
    case 'self-mail':
      return 'You can’t post something to yourself.'
    case 'recipient-not-found':
    case 'world-access-denied':
      return 'They aren’t in your world any more.'
    case 'mail-not-found':
    case 'mail-access-denied':
      return 'That parcel isn’t yours to open.'
    case 'already-claimed':
      return 'That parcel has already been collected.'
    case 'already-returned':
      return 'That parcel has already gone back to its sender.'
    case 'recipient-unavailable':
      return 'They can’t take parcels just now: they’re not admitted to your world.'
    case 'mail-sender-limit':
      return `You have ${MAIL.maxOutstandingSent} parcels waiting to be collected already. Wait for some to be collected, or recall one.`
    case 'mail-recipient-limit':
      return 'Their mailbox is full. They need to collect some parcels first.'
    case 'mail-rate-limited':
      return 'The post rider needs a moment. Try again in a minute.'
    case 'project-complete':
      return 'That project is finished. Thank you!'
    case 'project-overfilled':
      return 'That’s more than the project still needs. Give a little less.'
    case 'invalid-contribution':
      return 'That project doesn’t take that material.'
    case 'project-not-found':
      return 'Mara can’t find that project in the ledger.'
    case 'repair-not-found':
      return 'There’s no such chore on the board.'
    case 'repair-not-open':
      return 'That chore isn’t open in this world yet.'
    case 'already-mended':
      return 'It’s mended already. Someone got there first.'
    case 'recall-unsupported':
      return 'Your world’s post office can’t recall parcels yet.'
    case 'invalid-recipe':
      return 'That isn’t a recipe anyone keeps here.'
    case 'recipe-unknown':
      return 'You never learned that recipe. Its page teaches it, once you find it.'
    case 'craft-only':
      return 'Silas doesn’t sell that piece. It’s made at the bench, or given.'
    case 'desk-required':
      return 'That needs a writing desk set out at home.'
    case 'woodpile-required':
      return 'That needs a woodpile set out at home.'
    case 'invalid-page':
      return 'That isn’t a page the desk can copy.'
    case 'page-not-held':
      return 'You don’t hold that page. The desk copies pages you carry.'
    case 'nothing-ready':
      return 'Nothing on the pile has seasoned yet. Green wood takes a real day.'
    case 'invalid-action':
      return 'That’s not something a woodpile does.'
    case 'offline':
      return 'Needs a connection. Nothing changed — try again when you’re back online.'
    case 'superseded':
      return 'Another device took over this journey.'
    case 'busy':
      return 'Hold on — the last one is still on its way.'
    case 'resolved':
      return 'Your last request went through after all. Check what you have before trying again.'
    case 'pending':
      return 'No answer yet — it may have gone through. We’ll find out when the connection is back; nothing will be taken twice.'
    case 'guest':
      return 'That needs a world. Sign in to your world from the Menu.'
    default:
      return 'That didn’t go through. Nothing changed — try again in a moment.'
  }
}


export class Village {
  calendar: CalendarDay
  /** Calendar came from the server (connected) or this device (guest/offline). */
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
  /** The server answered "no recall here" once: stop offering it. */
  recallUnsupported = false
  private grantable: string[] = []

  constructor(private session: Session) {
    bus.on(EV.mutationResolved, (p: { op: MutationOp; outcome: 'landed' | 'refused' }) => {
      if (current?.village === this) void this.onResolved(p)
    })
    // Reading a notice board after you have seen the outer Wilds turn (with
    // the road lit): the old notices, kept on one rusted nail.
    bus.on(VILLAGE_EV.open, (p: { panel: VillagePanel }) => {
      if (current?.village !== this || p.panel !== 'board') return
      const s = this.session.state
      const paper = calendarFind('board', { flags: s.flags, late: s.quest === 'complete', mark: null })
      if (paper) grantPaper(this.session, paper)
    })
    this.calendar = calendarAt(this.now())
    this.projectsStatus = session.link ? 'idle' : 'guest'
    this.repairsStatus = session.link ? 'idle' : 'guest'
    this.mailStatus = session.link ? 'idle' : 'guest'
  }

  now(): number {
    return gameNow()
  }

  /** One of ours whose answer was lost is now known: re-read and say so. */
  private async onResolved(p: { op: MutationOp; outcome: 'landed' | 'refused' }): Promise<void> {
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
        this.calendar = await link.api.calendar()
        this.calendarSource = 'server'
        this.emit('calendar')
        return this.calendar
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
    bus.emit(EV.clock, {})
  }

  // ------------------------------------------------------------ projects

  async loadProjects(): Promise<void> {
    const link = this.session.link
    if (!link) {
      this.projectsStatus = 'guest'
      return
    }
    this.projectsStatus = 'loading'
    const r = await link.readWith((raw) => raw.projects())
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
    const link = this.session.link
    if (!link) {
      this.repairsStatus = 'guest'
      return
    }
    if (this.repairsStatus === 'ready') return
    this.repairsStatus = 'loading'
    const r = await link.readWith((raw) => raw.repairs())
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
    bus.emit(VILLAGE_EV.changed)
  }

  async mend(repairId: string): Promise<VillageResult<MendResult>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<MendResponse>({ kind: 'mend', id: repairId })
    if (!r.ok) return fail(r.code)
    this.adoptRepairs(r.res.result.repairs)
    return { ok: true, value: r.res.result }
  }

  async contribute(projectId: string, materials: Record<string, number>): Promise<VillageResult<{ completed: boolean }>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const given = Object.fromEntries(Object.entries(materials).filter(([, n]) => n > 0))
    if (Object.keys(given).length === 0) return fail('invalid-contribution')
    const before = this.projects.find((p) => p.id === projectId)?.stage
    const r = await link.mutate<ContributeResponse>({ kind: 'contribute', id: projectId, fields: { materials: given } })
    if (!r.ok) return fail(r.code)
    this.adoptProjects(r.res.result)
    this.setCarriedMaterials(r.res.result.materials)
    const completed = before !== 'complete' && r.res.result.projects.find((p) => p.id === projectId)?.stage === 'complete'
    return { ok: true, value: { completed } }
  }

  // ------------------------------------------------------------ storage & crafting

  async loadStorage(): Promise<VillageResult> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.readWith((raw) => raw.storage())
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
  async move(direction: 'deposit' | 'withdraw', asset: Asset, chest: ChestId = 'shared'): Promise<VillageResult> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<StorageMoveResponse>({ kind: 'storage', fields: { direction, asset, chest } })
    if (!r.ok) return fail(r.code)
    this.inventory = r.res.result.inventory
    this.storage = r.res.result.storage
    this.personal = r.res.result.personal
    this.shared = r.res.result.shared
    this.adoptHome(r.res.result.home)
    this.emit('goods')
    return { ok: true, value: undefined }
  }

  async craft(recipeId: string, qty: number): Promise<VillageResult<Asset>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<CraftResponse>({ kind: 'craft', fields: { recipeId, qty } })
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
  async hearthCraft(recipeId: string, qty: number): Promise<VillageResult<Asset>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<HearthCraftResponse>({ kind: 'hearth', fields: { recipeId, qty } })
    if (!r.ok) return fail(r.code)
    this.adoptWorkshop(r.res.result)
    return { ok: true, value: r.res.result.output }
  }

  /** Copy a recipe page you hold at the writing desk, to give away. */
  async deskCopy(pageId: string, qty: number): Promise<VillageResult<{ pageId: string; qty: number }>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<DeskCopyResponse>({ kind: 'desk', fields: { pageId, qty } })
    if (!r.ok) return fail(r.code)
    this.adoptWorkshop(r.res.result)
    return { ok: true, value: { pageId: r.res.result.pageId, qty: r.res.result.qty } }
  }

  /** The woodpile's stacks and how far each has seasoned. */
  async loadWoodpile(): Promise<VillageResult<WoodpileView>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.readWith((raw) => raw.woodpile())
    if (!r.ok) return fail(r.code)
    return { ok: true, value: r.value.woodpile }
  }

  /** Stack green timber on the woodpile, or collect the seasoned timber. */
  async woodpile(action: 'stack' | 'collect', qty = 1, stackId?: string): Promise<VillageResult<{ woodpile: WoodpileView; collectedQty?: number }>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<WoodpileActionResponse>({ kind: 'woodpile', fields: { action, qty, stackId } })
    if (!r.ok) return fail(r.code)
    this.adoptWorkshop(r.res.result)
    return { ok: true, value: { woodpile: r.res.result.woodpile, collectedQty: r.res.result.collectedQty } }
  }

  /** Read the gift shelf at a Commons gate. */
  async loadShelf(gate: number): Promise<VillageResult<ShelfView>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.readWith((raw) => raw.shelf(gate))
    if (!r.ok) return fail(r.code)
    return { ok: true, value: r.value.shelf }
  }

  /** Stock or take from the gift shelf. */
  async shelfAction(req: { op: 'stock' | 'take'; gate: number; slot: number; asset?: Asset }): Promise<VillageResult<ShelfActionResponse>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<ShelfActionResponse>({ kind: 'shelf', fields: req })
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

  async loadMail(): Promise<VillageResult> {
    const link = this.session.link
    if (!link) return fail('guest')
    this.mailStatus = 'loading'
    const r = await link.readWith((raw) => raw.mail())
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
      const more = await link.readWith((raw) => raw.mail({ pendingCursor: pending! }))
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
  async loadOlderMail(): Promise<VillageResult> {
    const link = this.session.link
    if (!link) return fail('guest')
    if (!this.mailCursor) return { ok: true, value: undefined }
    const cursor = this.mailCursor
    const r = await link.readWith((raw) => raw.mail({ cursor }))
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
    const me = this.session.link?.habiticaId
    return this.mail.filter((m) => m.toId === me && m.claimedAt === null && !m.returnedAt).length
  }

  async send(toId: string, asset: Asset): Promise<VillageResult> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<MailActionResponse>({ kind: 'mail-send', fields: { toId, asset } })
    if (!r.ok) return fail(r.code)
    this.adoptMail(r.res.result)
    return { ok: true, value: undefined }
  }

  async claim(id: string): Promise<VillageResult<Asset | undefined>> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<MailActionResponse>({ kind: 'mail-claim', id })
    if (!r.ok) return fail(r.code)
    this.adoptMail(r.res.result)
    return { ok: true, value: r.res.result.asset }
  }

  async recall(id: string): Promise<VillageResult> {
    const link = this.session.link
    if (!link) return fail('guest')
    if (this.recallUnsupported) return fail('recall-unsupported')
    const r = await link.mutate<MailActionResponse>({ kind: 'mail-recall', id })
    if (!r.ok) {
      // An older server has no recall route: a 404 that isn't "mail-not-found".
      if (r.code === 'unavailable' || r.code === 'not-found' || r.code === 'unknown') {
        this.recallUnsupported = true
        this.emit('mail')
        return fail('recall-unsupported')
      }
      return fail(r.code)
    }
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
    bus.emit(VILLAGE_EV.changed, { what })
  }
}

function fail(code: string): { ok: false; code: string; text: string } {
  return { ok: false, code, text: villageErrorText(code) }
}

let current: { session: Session; village: Village } | null = null

/** The village state for this session (made on first use). */
export function villageFor(session: Session): Village {
  if (!current || current.session !== session) current = { session, village: new Village(session) }
  return current.village
}
