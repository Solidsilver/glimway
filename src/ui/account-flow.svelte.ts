/**
 * Connected play, from the title to the world and between worlds: is there
 * a Glimway server and are we signed in; the first sign-in's world and
 * origin choices; the lease (playing here, or on another device); moving
 * between worlds; logging out.
 *
 * App.svelte owns the screen (the title, the game, the panels) and hands
 * this the few things it does there (`AccountHost`); everything else comes
 * in through `AccountDeps`, so the flow runs in node tests with a fake API
 * and fake sessions (tests/account-flow.test.ts).
 */
import type { ApiClient } from '../lib/api/client.ts'
import type { ConnectedCache } from '../lib/api/cache.ts'
import { errorCode, isUnreachable } from '../lib/api/errors.ts'
import type { Snapshot, WorldChoice, WorldMoveResponse, WorldRef, WorldView } from '../lib/api/types.ts'
import type { HabiticaProfile, VitalsSource } from '../lib/habitica/types.ts'
import { accountCopy, leaseCopy } from '../content/connected.ts'
import { firstWorldCopy, worldCopy } from '../content/world-moves.ts'

/** What the flow needs of a session's link (src/game/link.ts). */
export interface FlowLink {
  readonly status: 'online' | 'offline' | 'superseded' | 'signed-out'
  readonly accountId: string
  readonly dirty: boolean
  reconnect(takeOver: boolean): Promise<void>
  takeOver(): Promise<void>
  flush(): Promise<void>
  keepForNextSignIn(): Promise<void>
}

/** What the flow needs of a session (src/game/session.ts). */
export interface FlowSession {
  readonly link: FlowLink | null
  readonly vitalsSource: VitalsSource
  destroy(skipSave?: boolean): void
}

/** The server probe at load (src/ui/account.ts probeServer). */
export type Probe =
  | { kind: 'signed-in'; snapshot: Snapshot }
  /** Signed in, but the first sign-in's world choice is still open (asked again). */
  | { kind: 'choose-world'; choice: WorldChoice }
  | { kind: 'signed-out' }
  /** The server refused this client's contract: the title shows the reload notice. */
  | { kind: 'reload-needed' }
  | { kind: 'unavailable' }

export type AccountApi = Pick<ApiClient, 'state' | 'worldChoice' | 'worldChoose' | 'world' | 'worldNotice' | 'logout'>

/** The interface store's fields the flow writes (src/ui/store.svelte.ts). */
export interface AccountUi {
  server: 'unknown' | 'available' | 'unavailable'
  account: { accountId: string; name: string } | null
  link: unknown
  toast(payload: { text: string; icon?: string; kind?: 'info' | 'error' }): void
}

/** What App.svelte does for the flow on the screen it owns. */
export interface AccountHost<S extends FlowSession> {
  /** The session running now (null until a connected one plays). */
  session(): S | null
  /** A game is being started (a double click on Continue mustn't start two). */
  starting(): boolean
  /** Play this connected session: swap it in for the running one and start (or restart) the game. */
  play(next: S): Promise<void>
  /** Close whatever panel is open: the next step takes the screen. */
  closePanel(): void
  /** Leaving a world: forget what was read in it (the Wilds, the mailbox badge). */
  leaveWorld(): void
  /** The game can't go on in this page: stop it and show the title. */
  toTitle(): void
  reload(): void
}

export interface AccountDeps<S extends FlowSession> {
  api: AccountApi
  probe(): Promise<Probe>
  cache: {
    load(accountId: string): Promise<ConnectedCache | null>
    latest(): Promise<ConnectedCache | null>
    save(cache: ConnectedCache): Promise<unknown>
    clear(accountId: string): Promise<unknown>
  }
  /** A connected session, not yet holding the lease (src/ui/account.ts connectedSession). */
  connect(opts: { snapshot: Snapshot | null; cache: ConnectedCache | null; name: string }): Promise<S>
  /** The display name for an account (src/ui/account.ts accountName). */
  nameOf(snapshot: Snapshot | null, cache: ConnectedCache | null): string
  ui: AccountUi
  host: AccountHost<S>
  /** How long logging out waits for the last upload. */
  logoutWaitMs?: number
}

/** A step between signing in and playing: the world choice or the lease. */
export type Gate =
  | { kind: 'world'; choice: WorldChoice; busy: boolean; error: string; picked: 'party' | 'own' | null }
  | { kind: 'elsewhere'; busy: boolean; error: string }

/** The move screen: from the party prompt or the Menu; `arriving` once it landed and the new world is opening. */
export interface Moving {
  target: WorldRef
  home: boolean
  view: WorldView | null
  arriving: boolean
  leave?: boolean
}

/** A world reference with nothing known about it yet ("a world made for you"). */
const NO_WORLD: WorldRef = { id: '', ownerId: '', ownerName: '', members: 0, ownerHere: false, party: false }

const isWorldChoice = (v: Snapshot | WorldChoice): v is WorldChoice => !('state' in v)

export class AccountFlow<S extends FlowSession> {
  /** Latest server snapshot for the signed-in account (null when offline or signed out). */
  snapshot = $state<Snapshot | null>(null)
  /** Signed in for the first time, the world not chosen yet (the server holds the sign-in). */
  pendingSubject = $state<string | null>(null)
  choice = $state<WorldChoice | null>(null)
  /** The device's connected cache (offline copy, revision, lease). */
  cache = $state<ConnectedCache | null>(null)
  /** Signed in earlier, but no server answered at load: play from the cache. */
  offline = $state(false)
  /** The title's Continue is opening the world. */
  busy = $state(false)
  /** The title's line about what went wrong. */
  error = $state('')
  gate = $state<Gate | null>(null)
  /** The in-play lease screen (taken over elsewhere, or signed out). */
  leaseBusy = $state(false)
  leaseError = $state('')
  /** Your party plays in a world that isn't yours: the one-time prompt. */
  partyPrompt = $state<WorldView | null>(null)
  moving = $state<Moving | null>(null)
  /** Left the party whose world you live in (or were moved out of it): said once a sign-in. */
  leaverNotice = $state<WorldView | null>(null)
  /** A connected session waiting for the player to take over the lease. */
  private pending: S | null = null
  private deps: AccountDeps<S>

  constructor(deps: AccountDeps<S>) {
    this.deps = deps
  }

  private get ui(): AccountUi {
    return this.deps.ui
  }

  private get host(): AccountHost<S> {
    return this.deps.host
  }

  /**
   * Is there a Glimway server, and are we signed in? A valid session cookie
   * means signed in even with no remembered Habitica token. No server means
   * the title says so — except that a device with a connected cache can keep
   * playing offline.
   */
  async init(): Promise<Probe> {
    const probe = await this.deps.probe()
    if (probe.kind === 'signed-in') {
      const cache = await this.deps.cache.load(probe.snapshot.accountId)
      this.cache = cache
      this.ui.server = 'available'
      this.snapshot = probe.snapshot
      this.ui.account = { accountId: probe.snapshot.accountId, name: this.deps.nameOf(probe.snapshot, cache) }
    } else if (probe.kind === 'choose-world') {
      // A first sign-in whose world is still to choose (a reload, a closed tab): Continue asks again.
      this.ui.server = 'available'
      this.choice = probe.choice
      this.pendingSubject = probe.choice.habiticaId
      this.ui.account = null
    } else if (probe.kind === 'signed-out') {
      this.ui.server = 'available'
    } else if (probe.kind === 'reload-needed') {
      this.ui.server = 'available'
    } else {
      this.ui.server = 'unavailable'
      // No server can say who is signed in: offer the latest account played here.
      const cache = await this.deps.cache.latest()
      this.cache = cache
      if (cache) {
        this.offline = true
        this.ui.account = { accountId: cache.accountId, name: cache.name || 'Your hero' }
      }
    }
    return probe
  }

  /** Title: Continue in your world. */
  async continue(): Promise<void> {
    if (this.busy || this.host.starting() || (!this.ui.account && !this.choice)) return
    this.busy = true
    this.error = ''
    try {
      if (this.choice) {
        await this.openWorldChoice(this.choice)
        return
      }
      const s = await this.deps.connect({ snapshot: this.snapshot, cache: await this.deps.cache.load(this.ui.account!.accountId), name: this.ui.account!.name })
      await s.link!.reconnect(false)
      await this.settle(s)
    } finally {
      this.busy = false
    }
  }

  /** The guide signed in to the server (or the world choice was just answered). */
  async signedIn(answer: Snapshot | WorldChoice, profile: HabiticaProfile | null): Promise<void> {
    this.ui.server = 'available'
    this.offline = false
    if (isWorldChoice(answer)) {
      // Signed in, but where to live comes first.
      this.choice = answer
      this.snapshot = null
      this.pendingSubject = answer.habiticaId
      this.ui.account = null
      this.host.closePanel()
      this.gate = { kind: 'world', choice: answer, busy: false, error: '', picked: null }
      return
    }
    const snapshot = answer
    this.pendingSubject = null
    this.choice = null
    this.snapshot = snapshot
    const name = snapshot.displayName || snapshot.importedProfile?.name || profile?.name || this.ui.account?.name || 'Your hero'
    this.ui.account = { accountId: snapshot.accountId, name }
    // Signed in from the Menu: the next step (the lease question) takes the screen.
    this.host.closePanel()
    this.cache = await this.deps.cache.load(snapshot.accountId)
    await this.startAccount(snapshot, name)
  }

  /** The server no longer knows this sign-in: back to the title's sign-in, saying why. */
  private signedOut(): void {
    this.pendingSubject = null
    this.choice = null
    this.ui.account = null
    this.error = accountCopy.signInEnded
  }

  /** Chosen already (another device, a race): carry on into that world. */
  private async alreadyChosen(): Promise<void> {
    this.gate = null
    this.pendingSubject = null
    this.choice = null
    try {
      await this.signedIn(await this.deps.api.state(), null)
    } catch {
      this.error = firstWorldCopy.offline
    }
  }

  /** Ask (again) where to live: the server's question, fresh, so the party's head count is current. */
  async openWorldChoice(known: WorldChoice): Promise<void> {
    let choice = known
    try {
      choice = await this.deps.api.worldChoice()
      this.choice = choice
    } catch (err) {
      const code = errorCode(err)
      if (code === 'world-chosen') {
        // Chosen on another device meanwhile: carry on into that world.
        this.pendingSubject = null
    this.choice = null
        await this.signedIn(await this.deps.api.state(), null)
        return
      }
      if (code === 'unauthorized') {
        this.signedOut()
        return
      }
      // Offline: ask with what we know; choosing will say if it can't reach the server.
    }
    this.gate = { kind: 'world', choice, busy: false, error: '', picked: null }
  }

  /** First sign-in: the party's world, or one of your own. The same sign-in carries on. */
  async chooseWorld(pick: 'party' | 'own'): Promise<void> {
    const g = this.gate?.kind === 'world' ? this.gate : null
    if (!g || g.busy) return
    g.busy = true
    g.error = ''
    g.picked = pick
    try {
      const snap = await this.deps.api.worldChoose(pick)
      this.gate = null
      await this.signedIn(snap, null)
    } catch (err) {
      const code = errorCode(err)
      if (code === 'world-chosen') {
        await this.alreadyChosen()
        return
      }
      if (code === 'unauthorized') {
        this.gate = null
        this.signedOut()
        return
      }
      g.busy = false
      g.picked = null
      if (code === 'party-closed' || code === 'party-open-denied' || code === 'no-party') {
        // The party's world can't be had now: ask again with what's left,
        // or (nothing left to ask) step into the world of their own made for them.
        try {
          g.choice = this.choice = await this.deps.api.worldChoice()
        } catch (again) {
          if (errorCode(again) === 'world-chosen') {
            await this.alreadyChosen()
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

  private async startAccount(snapshot: Snapshot, name: string): Promise<void> {
    if (this.ui.account) this.ui.account = { ...this.ui.account, name }
    const s = await this.deps.connect({ snapshot, cache: await this.deps.cache.load(snapshot.accountId), name })
    await s.link!.reconnect(false)
    await this.settle(s)
  }

  /** After the first lease attempt: play, ask to take over, or step back. */
  private async settle(s: S): Promise<void> {
    const status = s.link!.status
    if (status === 'superseded') {
      this.pending = s
      this.gate = { kind: 'elsewhere', busy: false, error: '' }
      return
    }
    if (status === 'signed-out') {
      s.destroy(true)
      this.ui.link = null
      this.snapshot = null
      this.signedOut()
      return
    }
    // Online, or offline (the link keeps retrying and the world plays on).
    await this.enter(s)
  }

  /** The lease question at sign-in: take over from the other device. */
  async takeOverPending(): Promise<void> {
    const g = this.gate?.kind === 'elsewhere' ? this.gate : null
    const pending = this.pending
    if (!pending || !g || g.busy) return
    g.busy = true
    g.error = ''
    await pending.link!.takeOver()
    if (pending.link!.status === 'superseded') {
      g.busy = false
      g.error = leaseCopy.failed
      return
    }
    this.pending = null
    await this.settle(pending)
  }

  /** …or step back to the title. */
  dropPending(): void {
    this.pending?.destroy(true)
    this.pending = null
    this.gate = null
    this.ui.link = null
  }

  /** Play a connected session (from the title or mid-game). */
  private async enter(next: S): Promise<void> {
    this.gate = null
    this.pending = null
    this.offline = next.link?.status === 'offline'
    await this.host.play(next)
    void this.checkPartyPrompt(next)
  }

  /**
   * Your party has a world and you live elsewhere: say so once (the server
   * remembers it was shown; the Menu keeps the offer). Reads need only the session.
   */
  private async checkPartyPrompt(s: S): Promise<void> {
    if (!s.link || s.link.status !== 'online') return
    try {
      const v = await this.deps.api.world()
      // PartyPrompt records it as shown when it is really on screen.
      if (this.host.session() !== s) return
      if (v.movedOutAt > 0 || v.leaver) this.leaverNotice = v
      else if (v.prompt && v.partyWorld) this.partyPrompt = v
    } catch {
      /* the Menu still offers it */
    }
  }

  openMove(target: WorldRef, home: boolean, view: WorldView | null, leave = false): void {
    this.host.closePanel()
    this.partyPrompt = null
    this.leaverNotice = null
    this.moving = { target, home, view, arriving: false, leave }
  }

  /** "Leave now": to your own world, or one made for you (the move screen, no cooldown). */
  openLeave(view: WorldView): void {
    this.openMove(view.ownWorld ?? NO_WORLD, true, view, true)
  }

  /** The "you were moved out" notice was seen: the server stops reporting it. */
  closeLeaverNotice(): void {
    if (this.leaverNotice && this.leaverNotice.movedOutAt > 0) void this.deps.api.worldNotice().catch(() => undefined)
    this.leaverNotice = null
  }

  /**
   * After a move: a fresh connected session from the server's answer, so
   * every per-world view (the lane, homesteads, the village, the Wilds, the
   * mailbox badge) starts over in the new world. The lease is the same one:
   * this page and this sign-in still hold it. The move screen stays up
   * ("Arriving…"), freezing the old scene, until the new world is open.
   */
  async afterMove(snapshot: Snapshot, line: string): Promise<void> {
    if (this.moving) this.moving.arriving = true
    else this.moving = { target: { ...NO_WORLD, id: snapshot.worldId }, home: false, view: null, arriving: true }
    this.partyPrompt = null
    this.leaverNotice = null
    try {
      // Its link already adopted the move's answer; nothing is left to upload.
      this.host.session()?.destroy(true)
      this.host.leaveWorld()
      const name = this.ui.account?.name ?? snapshot.displayName
      const s = await this.deps.connect({ snapshot, cache: null, name })
      await s.link!.reconnect(false)
      await this.settle(s)
      this.moving = null
      this.ui.toast({ text: line, icon: 'world' })
    } catch {
      // The move stands on the server; this page couldn't open the new
      // world. Back to the title, where Continue steps in.
      this.moving = null
      this.host.toTitle()
      this.snapshot = snapshot
      this.error = worldCopy.arriveFailed
    }
  }

  /** The move screen's answer landed. */
  onMoved(res: WorldMoveResponse): void {
    const m = this.moving
    const v = res.result.world
    void this.afterMove(
      res,
      m?.leave && !m.target.id ? worldCopy.done(worldCopy.newWorld.toLowerCase()) : m?.home ? worldCopy.doneHome : worldCopy.done(worldCopy.place(m?.target ?? v.world, m ? true : v.partyHome))
    )
  }

  /** Already in that world (another device moved first): step in. */
  onHere(): void {
    void this.deps.api
      .state()
      .then((snap) => this.afterMove(snap, worldCopy.landed))
      .catch(() => {
        this.moving = null
        this.ui.toast({ text: worldCopy.offline, kind: 'error' })
      })
  }

  /** The in-play lease screen: take this journey back from the other device. */
  async takeOverInPlay(): Promise<void> {
    const link = this.host.session()?.link
    if (!link || this.leaseBusy) return
    this.leaseBusy = true
    this.leaseError = ''
    await link.takeOver()
    this.leaseBusy = false
    if (link.status === 'superseded') this.leaseError = leaseCopy.failed
  }

  /**
   * Log out of the world: upload what's pending, end the session, back to
   * the title. The account's cache is cleared only when the server has
   * everything; unsent progress (a refused or slow upload, offline play from
   * an earlier visit) stays on this device for the next sign-in.
   */
  async logout(): Promise<void> {
    const session = this.host.session()
    const link = session?.link
    const accountId = link?.accountId ?? this.ui.account?.accountId
    let keep = false
    if (link) {
      await Promise.race([link.flush().catch(() => undefined), new Promise((r) => setTimeout(r, this.deps.logoutWaitMs ?? 4000))])
      keep = link.dirty
      if (keep) await link.keepForNextSignIn()
    } else if (accountId) {
      const cache = await this.deps.cache.load(accountId)
      keep = cache?.dirty === true
      if (cache && keep) await this.deps.cache.save({ ...cache, loggedOut: true })
    }
    try {
      await this.deps.api.logout()
    } catch {
      /* the cookie expires on its own */
    }
    if (accountId && !keep) await this.deps.cache.clear(accountId)
    if (link) session?.destroy(true)
    this.host.reload()
  }
}
