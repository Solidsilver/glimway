/**
 * The top-up and the Glim log, interface side (silas-yard.md 1.5;
 * purse-and-wardrobe.md 2.1, 2.2): Turn gold into glims syncs first, then
 * shows the consent card; Get sends the one request that carries the token; a top-up still working is polled on the
 * purse read every few seconds until it settles; every outcome is one line,
 * in the card and as a toast. It lives outside the Menu so a closed card
 * still hears how its top-up came out.
 *
 * The token is read from the tab's memory for the request and handed
 * straight to it; nothing here keeps it.
 */
import type { Session } from '../game/session.ts'
import { bus, EV } from '../game/events.ts'
import { purseCopy } from '../content/purse.ts'
import { purseErrorText } from '../content/errors.ts'
import { GLIMS_PER_DAY, goldFor, maxGlims, parseAmount, purseLog, settled, topUpMoved, topUpOutcome, topUpView, TOP_UP_POLL_LIMIT_MS, TOP_UP_POLL_MS, type LogEntry, type TopUpView } from '../lib/purse.ts'
import { memoryCredentials } from './habitica-local.ts'

/** What the sync before a top-up found: Habitica's gold (display only), or why it stopped (it says so itself). */
export type SyncForTopUp = { ok: true; gold: number } | { ok: false }

type Phase = 'idle' | 'syncing' | 'consent' | 'moving' | 'checking'

/** How far apart this device's clock and the server's may be, in seconds (both keep network time). */
const CLOCK_SKEW_S = 1

class PurseUi {
  phase = $state<Phase>('idle')
  /** The gold the sync just read on Habitica (the consent card's line). */
  habiticaGold = $state(0)
  /** Glims top-ups can still bring today, as the purse said when the card opened (the server checks again). */
  glimsLeft = $state(GLIMS_PER_DAY)
  /** The consent card's field, in glims: empty at first, every time. */
  amount = $state('')
  /** The last outcome, in the card (it's a toast too). */
  outcome = $state<{ text: string; ok: boolean } | null>(null)
  /** Why the consent card can't go on (a refusal, no connection). */
  error = $state('')
  /** Which sheet is open over the Menu. */
  sheet = $state<'consent' | 'log' | null>(null)
  log = $state<LogEntry[] | null>(null)
  logStatus = $state<'idle' | 'loading' | 'ready' | 'offline'>('idle')
  /** The top-up being followed (its row id). */
  private following: string | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  /** The most glims this top-up can get: Habitica's gold at two a glim, within today's cap (**Max**). */
  get max(): number {
    return maxGlims(this.habiticaGold, this.glimsLeft)
  }

  /** The glims as a number, or null while it isn't a whole number from 1 to `max`. */
  get parsed(): number | null {
    return parseAmount(this.amount, this.max)
  }

  get busy(): boolean {
    return this.phase === 'syncing' || this.phase === 'moving' || this.phase === 'checking'
  }

  /** Turn gold into glims: sync first (the sync's own safe places and messages), then the consent card. */
  async start(sync: () => Promise<SyncForTopUp>, glimsLeft: number): Promise<void> {
    if (this.busy) return
    this.outcome = null
    this.error = ''
    this.phase = 'syncing'
    let r: SyncForTopUp = { ok: false }
    try {
      r = await sync()
    } finally {
      if (this.phase === 'syncing') this.phase = 'idle'
    }
    if (!r.ok) return
    this.habiticaGold = r.gold
    this.glimsLeft = glimsLeft
    this.amount = ''
    this.phase = 'consent'
    this.sheet = 'consent'
  }

  /** Not now: nothing is sent, nothing remembered. */
  cancel(): void {
    if (this.phase === 'consent') this.phase = 'idle'
    this.amount = ''
    this.error = ''
    this.sheet = null
  }

  /** Close the sheet; a top-up on its way keeps going and says how it went in a toast. */
  closeSheet(): void {
    if (this.phase === 'consent') return this.cancel()
    this.sheet = null
  }

  /** Get: the one request that carries the token. It asks for the gold, two for each glim. */
  async confirm(session: Session): Promise<void> {
    const glims = this.parsed
    const link = session.link
    if (this.phase !== 'consent' || glims === null || !link) return
    const amount = goldFor(glims)
    const creds = memoryCredentials()
    if (!creds) {
      this.error = purseCopy.connectFirst
      return
    }
    this.error = ''
    this.phase = 'moving'
    const pressedAt = Date.now() / 1000
    const r = await link.topUp(creds.apiToken, amount)
    if (r.ok) {
      this.follow(session, r.topUp)
      return
    }
    if (r.code === 'offline' && r.sent === false) {
      // Never sent: nothing can have started, so say so now.
      this.phase = 'consent'
      this.error = purseCopy.notSent
      return
    }
    if (r.code === 'offline') {
      // Sent, but no answer: it may have started. The purse read says.
      this.phase = 'checking'
      this.following = null
      this.poll(session, { since: pressedAt, amount }, Date.now())
      return
    }
    this.phase = 'consent'
    this.error = purseErrorText(r.code)
  }

  private follow(session: Session, t: TopUpView): void {
    if (settled(t)) return this.finish(t)
    this.phase = 'checking'
    this.following = t.id
    this.poll(session, { since: t.startedAt, amount: t.amount }, Date.now())
  }

  /**
   * After a lost answer, the top-up that is ours: the one still working, or
   * else a row for the same amount started at or after the press. The press
   * is this device's clock and the row the server's; both keep network time,
   * so one second covers the difference. An older row is another tab's, or
   * an earlier top-up.
   */
  private ours(rows: TopUpView[], working: TopUpView | null, press: { since: number; amount: number }): TopUpView | null {
    const fits = (t: TopUpView) => t.amount === press.amount && t.startedAt >= press.since - CLOCK_SKEW_S
    if (working && fits(working)) return working
    return rows.find(fits) ?? null
  }

  /** Read the purse every few seconds until the top-up settles (or the worker's limit has long passed). */
  private poll(session: Session, press: { since: number; amount: number }, began: number): void {
    this.stopPolling()
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      const link = session.link
      if (!link) return this.give(purseCopy.lost)
      const r = await link.purseRead()
      if (r.ok) {
        const rows = r.value.topUps.map(topUpView)
        const working = r.value.purse?.working ? topUpView(r.value.purse.working) : null
        const mine = this.following
          ? (rows.find((t) => t.id === this.following) ?? (working?.id === this.following ? working : null))
          : this.ours(rows, working, press)
        if (mine) {
          this.following = mine.id
          if (settled(mine)) return this.finish(mine)
        } else if (!this.following && Date.now() - began > TOP_UP_POLL_MS * 3) {
          // Nothing started: the request never reached the world.
          return this.give(purseCopy.lost)
        }
      }
      if (Date.now() - began > TOP_UP_POLL_LIMIT_MS) return this.give(purseCopy.lost)
      this.poll(session, press, began)
    }, TOP_UP_POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private finish(t: TopUpView): void {
    const text = topUpOutcome(t) ?? purseCopy.lost
    const ok = topUpMoved(t)
    this.outcome = { text, ok }
    this.phase = 'idle'
    this.following = null
    this.amount = ''
    bus.emit(EV.toast, { text, icon: 'glim', art: 'glims-few', ...(ok ? {} : { kind: 'error' as const }) })
    // An open log gains the new line.
    if (this.sheet === 'log' && this.lastSession) void this.openLog(this.lastSession)
  }

  private give(text: string): void {
    this.stopPolling()
    this.outcome = { text, ok: false }
    this.phase = 'idle'
    this.following = null
    bus.emit(EV.toast, { text, icon: 'glim', kind: 'error' })
  }

  private lastSession: Session | null = null

  /** The Glim log sheet: the last 50 lines, newest first. */
  async openLog(session: Session): Promise<void> {
    this.lastSession = session
    this.sheet = 'log'
    const link = session.link
    if (!link) {
      this.logStatus = 'offline'
      return
    }
    if (!this.log) this.logStatus = 'loading'
    const r = await link.purseRead()
    if (!r.ok) {
      this.logStatus = 'offline'
      return
    }
    this.log = purseLog(r.value)
    this.logStatus = 'ready'
  }

  /** Signed out, or another account: forget everything shown. */
  reset(): void {
    this.stopPolling()
    this.phase = 'idle'
    this.amount = ''
    this.outcome = null
    this.error = ''
    this.sheet = null
    this.log = null
    this.logStatus = 'idle'
    this.following = null
    this.lastSession = null
  }
}

export const purseUi = new PurseUi()
