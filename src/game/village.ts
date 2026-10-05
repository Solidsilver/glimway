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
import { blankProjects, papersDue } from '../lib/village'
import { MAIL } from '../lib/mail'
import type { Asset, AssetCounts, ContributeResponse, CraftResponse, Mail, MailActionResponse, ProjectView, ProjectsView, StorageMoveResponse } from '../lib/api/types'
import type { ApiErrorCode } from '../lib/api/errors'
import { paperFlag } from '../content/papers'
import { bus, EV } from './events'
import type { MutationOp } from './link'
import { grantPaper } from './papers'
import { homesteadsFor } from './homestead'
import type { Session } from './session'

export const VILLAGE_EV = {
  /** Something here changed: { what: 'calendar' | 'projects' | 'goods' | 'mail' }. */
  changed: 'village:changed',
  /** Open a panel: { panel: 'board' | 'chest' | 'bench' | 'mail', to?: string }. */
  open: 'ui:village-open'
} as const

export type VillagePanel = 'board' | 'chest' | 'bench' | 'mail'

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
    case 'recall-unsupported':
      return 'Your world’s post office can’t recall parcels yet.'
    case 'offline':
      return 'Needs a connection. Nothing changed — try again when you’re back online.'
    case 'superseded':
      return 'Another device took over this journey.'
    case 'busy':
      return 'Hold on — the last one is still on its way.'
    case 'pending':
      return 'No answer yet — it may have gone through. We’ll find out when the connection is back; nothing will be taken twice.'
    case 'guest':
      return 'That needs a world. Sign in to your world from the Menu.'
    default:
      return 'That didn’t go through. Nothing changed — try again in a moment.'
  }
}

/** Dev/playtest override of "now" (seconds), so festivals can be seen any day. */
let devNow: number | null = null

export class Village {
  calendar: CalendarDay
  /** Calendar came from the server (connected) or this device (guest/offline). */
  calendarSource: 'server' | 'local' = 'local'
  projects: ProjectView[] = blankProjects()
  worldFlags: string[] = []
  projectsStatus: Status
  inventory: AssetCounts | null = null
  storage: AssetCounts | null = null
  mail: Mail[] = []
  mailStatus: Status
  /** The server answered "no recall here" once: stop offering it. */
  recallUnsupported = false
  private grantable: string[] = []

  constructor(private session: Session) {
    bus.on(EV.mutationResolved, (p: { op: MutationOp; outcome: 'landed' | 'refused' }) => {
      if (current?.village === this) void this.onResolved(p)
    })
    this.calendar = calendarAt(this.now())
    this.projectsStatus = session.link ? 'idle' : 'guest'
    this.mailStatus = session.link ? 'idle' : 'guest'
  }

  now(): number {
    return devNow ?? Math.floor(Date.now() / 1000)
  }

  /** One of ours whose answer was lost is now known: re-read and say so. */
  private async onResolved(p: { op: MutationOp; outcome: 'landed' | 'refused' }): Promise<void> {
    const k = p.op.kind
    if (k === 'home') return
    if (k === 'contribute') await this.loadProjects()
    else if (k === 'storage' || k === 'craft') await this.loadStorage()
    else await this.loadMail()
    const what = k === 'contribute' ? 'gift to the project' : k === 'craft' ? 'work at the bench' : k === 'storage' ? 'trip to the chest' : 'parcel'
    bus.emit(EV.toast, { text: p.outcome === 'landed' ? `Your last ${what} went through after all.` : `Your last ${what} didn’t go through. Nothing changed.`, icon: 'scroll' })
  }

  // ------------------------------------------------------------ calendar

  /** Today, from the server when connected (its clock rules), else locally. */
  async loadCalendar(): Promise<CalendarDay> {
    const link = this.session.link
    if (link && devNow === null) {
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

  private calendarLoaded = false

  /** The first read this session (server when connected); later, only when stale. */
  ensureCalendar(): void {
    if (!this.calendarLoaded) {
      this.calendarLoaded = true
      void this.loadCalendar()
    } else this.refreshIfStale()
  }

  /** Re-read when the day has turned (cheap: compares against the next midnight UTC). */
  refreshIfStale(): void {
    const now = this.now()
    if (now >= this.calendar.startsAt + this.calendar.day * 86400 || now < this.calendar.startsAt) void this.loadCalendar()
  }

  setDevNow(unix: number | null): void {
    devNow = unix
    void this.loadCalendar()
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
    return this.worldFlags.includes(flag)
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
    homesteadsFor(this.session).materials = r.res.result.materials
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
    this.adoptHome(r.value.home)
    this.emit('goods')
    return { ok: true, value: undefined }
  }

  async move(direction: 'deposit' | 'withdraw', asset: Asset): Promise<VillageResult> {
    const link = this.session.link
    if (!link) return fail('guest')
    const r = await link.mutate<StorageMoveResponse>({ kind: 'storage', fields: { direction, asset } })
    if (!r.ok) return fail(r.code)
    this.inventory = r.res.result.inventory
    this.storage = r.res.result.storage
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
    this.adoptHome(r.res.result.home)
    this.emit('goods')
    return { ok: true, value: r.res.result.output }
  }

  private adoptHome(home: import('../lib/api/types').HomeView): void {
    const homes = homesteadsFor(this.session)
    homes.homes.set(home.ownerId, home)
    if (this.inventory) homes.materials = { ...this.inventory.materials }
    bus.emit('home:changed', { reason: 'goods' })
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
      homesteadsFor(this.session).materials = { ...r.value.inventory.materials }
      this.emit('goods')
    }
    this.mailStatus = 'ready'
    this.emit('mail')
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
    homesteadsFor(this.session).materials = { ...res.inventory.materials }
    this.mailStatus = 'ready'
    this.emit('mail')
    this.emit('goods')
    void this.loadHomeAfterMail()
  }

  /** Decorations moved by mail change what can be placed: refresh the home. */
  private async loadHomeAfterMail(): Promise<void> {
    const homes = homesteadsFor(this.session)
    const me = this.session.link?.habiticaId
    if (me) await homes.fetchHome(me)
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
