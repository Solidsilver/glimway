import test from 'node:test'
import assert from 'node:assert/strict'
import './helpers/svelte-runes.ts'
import { ApiError } from '../src/lib/api/errors.ts'
import { createNewGame } from '../src/lib/state.ts'
import { accountCopy, leaseCopy } from '../src/content/connected.ts'
import { firstWorldCopy, worldCopy } from '../src/content/world-moves.ts'
import type { ConnectedCache } from '../src/lib/api/cache.ts'
import type { Snapshot, WorldChoice, WorldView } from '../src/lib/api/types.ts'
import type { AccountApi, FlowLink, FlowSession, Probe } from '../src/ui/account-flow.svelte.ts'

const { AccountFlow } = await import('../src/ui/account-flow.svelte.ts')

type Status = FlowLink['status']

class FakeLink implements FlowLink {
  status: Status = 'offline'
  dirty = false
  reconnects = 0
  kept = false
  accountId: string
  /** The status after reconnect / takeOver. */
  after: { reconnect?: Status; takeOver?: Status }
  constructor(accountId: string, after: { reconnect?: Status; takeOver?: Status } = {}) {
    this.accountId = accountId
    this.after = after
  }
  async reconnect(): Promise<void> {
    this.reconnects += 1
    this.status = this.after.reconnect ?? 'online'
  }
  async takeOver(): Promise<void> {
    this.status = this.after.takeOver ?? 'online'
  }
  async flush(): Promise<void> {}
  async keepForNextSignIn(): Promise<void> {
    this.kept = true
  }
}

class FakeSession implements FlowSession {
  destroyed: boolean | null = null
  vitalsSource = 'demo' as const
  link: FakeLink | null
  state = createNewGame()
  constructor(link: FakeLink | null) {
    this.link = link
  }
  destroy(skipSave = false): void {
    this.destroyed = skipSave
  }
}

const snap = (over: Partial<Snapshot> = {}): Snapshot =>
  ({ accountId: 'h1', displayName: 'Tansy', importedProfile: null, saveOrigin: 'fresh', state: createNewGame(), rev: 1, vitalsSource: 'demo', worldId: 'w1', ...over }) as unknown as Snapshot

const choice = (over: Partial<WorldChoice> = {}): WorldChoice => ({ habiticaId: 'h1', displayName: 'Tansy', ...over }) as unknown as WorldChoice

/** A flow over fakes. `api` methods throw unless the test gives them. */
function setup(opts: { probe?: Probe; api?: Partial<Record<keyof AccountApi, (...a: never[]) => Promise<unknown>>>; guest?: FakeSession | null; link?: { reconnect?: Status; takeOver?: Status }; cache?: ConnectedCache | null } = {}) {
  const calls: string[] = []
  const toasts: string[] = []
  const played: FakeSession[] = []
  const caches = new Map<string, ConnectedCache>()
  if (opts.cache) caches.set(opts.cache.accountId, opts.cache)
  const nope = (name: string) => async () => {
    throw new Error(`unexpected api.${name}`)
  }
  const api = new Proxy({} as AccountApi, {
    get: (_t, name: string) => {
      const fn = opts.api?.[name as keyof AccountApi]
      return async (...args: never[]) => {
        calls.push(name)
        return fn ? fn(...args) : nope(name)()
      }
    }
  })
  let session: FakeSession | null = opts.guest === undefined ? new FakeSession(null) : opts.guest
  const ui = {
    server: 'unknown' as 'unknown' | 'available' | 'unavailable',
    account: null as { accountId: string; name: string } | null,
    link: null as unknown,
    toast: (p: { text: string }) => void toasts.push(p.text)
  }
  const host = {
    titled: false,
    reloaded: false,
    left: 0,
    panelClosed: 0,
    session: () => session,
    starting: () => false,
    play: async (next: FakeSession) => {
      played.push(next)
      session = next
    },
    closePanel: () => void (host.panelClosed += 1),
    leaveWorld: () => void (host.left += 1),
    toTitle: () => void (host.titled = true),
    reload: () => void (host.reloaded = true)
  }
  const connected: { snapshot: Snapshot | null; name: string }[] = []
  const flow = new AccountFlow<FakeSession>({
    api,
    probe: async () => opts.probe ?? { kind: 'signed-out' },
    cache: {
      load: async (id) => caches.get(id) ?? null,
      latest: async () => opts.cache ?? null,
      save: async (c) => void caches.set(c.accountId, c),
      clear: async (id) => void caches.delete(id)
    },
    connect: async ({ snapshot, cache, name }) => {
      connected.push({ snapshot, name })
      return new FakeSession(new FakeLink(snapshot?.accountId ?? cache!.accountId, opts.link))
    },
    nameOf: (s, c) => s?.displayName || c?.name || 'Your hero',
    ui,
    host,
    logoutWaitMs: 10
  })
  return { flow, ui, host, calls, toasts, played, connected, caches, session: () => session }
}

const err = (code: ConstructorParameters<typeof ApiError>[0]) => () => Promise.reject(new ApiError(code))

test('the probe at load: signed in, choosing, signed out, or no server with an account played here', async () => {
  const a = setup({ probe: { kind: 'signed-in', snapshot: snap() } })
  await a.flow.init()
  assert.equal(a.ui.server, 'available')
  assert.deepEqual(a.ui.account, { accountId: 'h1', name: 'Tansy' })
  assert.equal(a.flow.snapshot?.accountId, 'h1')

  const b = setup({ probe: { kind: 'choose-world', choice: choice({ displayName: '' }) } })
  await b.flow.init()
  assert.equal(b.flow.choice?.habiticaId, 'h1')
  assert.equal(b.ui.account, null)
  assert.equal(b.flow.pendingSubject, 'h1')

  const cache = { accountId: 'h9', name: 'Wren', dirty: true } as unknown as ConnectedCache
  const c = setup({ probe: { kind: 'unavailable' }, cache })
  await c.flow.init()
  assert.equal(c.ui.server, 'unavailable')
  assert.equal(c.flow.offline, true)
  assert.deepEqual(c.ui.account, { accountId: 'h9', name: 'Wren' })
})

test('Continue with a journey: connect, take the lease, play, then the party prompt', async () => {
  const view = { movedOutAt: 0, leaver: null, prompt: true, partyWorld: { id: 'p' } } as unknown as WorldView
  const t = setup({ probe: { kind: 'signed-in', snapshot: snap() }, api: { world: async () => view } })
  await t.flow.init()
  await t.flow.continue()
  assert.equal(t.played.length, 1)
  assert.equal(t.played[0].link?.reconnects, 1)
  assert.equal(t.flow.busy, false)
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(t.flow.partyPrompt, view)
})

test('a first sign-in: the world question, then straight into the world', async () => {
  const t = setup({ api: { worldChoose: async () => snap(), world: async () => ({}) } })
  await t.flow.signedIn(choice(), null)
  assert.equal(t.flow.gate?.kind, 'world')
  assert.equal(t.host.panelClosed, 1)
  await t.flow.chooseWorld('own')
  // The world answers, the session starts, and the party prompt is asked.
  assert.deepEqual(t.calls, ['worldChoose', 'world'])
  assert.equal(t.flow.gate, null)
  assert.equal(t.played.length, 1)
})

test('chosen already elsewhere: the world question steps straight into that world', async () => {
  const t = setup({ api: { worldChoose: err('world-chosen'), state: async () => snap(), world: async () => ({}) } })
  t.flow.gate = { kind: 'world', choice: choice(), busy: false, error: '', picked: null }
  await t.flow.chooseWorld('party')
  assert.equal(t.played.length, 1)
  assert.equal(t.flow.choice, null)
})

test('the party’s world is gone: asked again with what is left', async () => {
  const fresh = choice({ displayName: 'again' })
  const t = setup({ api: { worldChoose: err('party-closed'), worldChoice: async () => fresh } })
  t.flow.gate = { kind: 'world', choice: choice(), busy: false, error: '', picked: null }
  await t.flow.chooseWorld('party')
  const g = t.flow.gate as { kind: 'world'; choice: WorldChoice; error: string; busy: boolean; picked: unknown }
  assert.equal(g.error, firstWorldCopy.partyGone)
  assert.deepEqual(g.choice, fresh)
  assert.equal(g.busy, false)
  assert.equal(g.picked, null)
})

test('a sign-in the server forgot ends at the title, saying so', async () => {
  const t = setup({ api: { worldChoice: err('unauthorized') } })
  t.ui.account = { accountId: 'h1', name: 'Tansy' }
  t.flow.choice = choice()
  await t.flow.continue()
  assert.equal(t.ui.account, null)
  assert.equal(t.flow.error, accountCopy.signInEnded)

  const s = setup({ link: { reconnect: 'signed-out' } })
  s.ui.account = { accountId: 'h1', name: 'Tansy' }
  s.flow.snapshot = snap()
  await s.flow.continue()
  assert.equal(s.played.length, 0)
  assert.equal(s.flow.error, accountCopy.signInEnded)
})

test('playing on another device: the lease question, a failed take-over, then a good one', async () => {
  const t = setup({ link: { reconnect: 'superseded', takeOver: 'superseded' }, api: { world: async () => ({}) } })
  t.ui.account = { accountId: 'h1', name: 'Tansy' }
  t.flow.snapshot = snap()
  await t.flow.continue()
  assert.equal(t.flow.gate?.kind, 'elsewhere')
  await t.flow.takeOverPending()
  assert.equal((t.flow.gate as { error: string }).error, leaseCopy.failed)
  // The other device lets go.
  ;(t.flow as unknown as { pending: FakeSession }).pending.link!.after.takeOver = 'online'
  await t.flow.takeOverPending()
  assert.equal(t.flow.gate, null)
  assert.equal(t.played.length, 1)
})

test('stepping back from the lease question drops the waiting session', async () => {
  const t = setup({ link: { reconnect: 'superseded' } })
  t.ui.account = { accountId: 'h1', name: 'Tansy' }
  t.flow.snapshot = snap()
  await t.flow.continue()
  const pending = (t.flow as unknown as { pending: FakeSession }).pending
  t.flow.dropPending()
  assert.equal(pending.destroyed, true)
  assert.equal(t.flow.gate, null)
})

test('a move that lands opens the new world; one that can’t open goes back to the title', async () => {
  const t = setup({ api: { world: async () => ({}) } })
  t.ui.account = { accountId: 'h1', name: 'Tansy' }
  const old = t.session()!
  t.flow.openMove({ id: 'w2', ownerId: '', ownerName: 'Ada', members: 2, ownerHere: false, party: true }, false, null)
  await t.flow.afterMove(snap({ worldId: 'w2' }), 'Welcome.')
  assert.equal(old.destroyed, true)
  assert.equal(t.host.left, 1)
  assert.equal(t.flow.moving, null)
  assert.deepEqual(t.toasts, ['Welcome.'])

  const f = setup()
  f.ui.account = { accountId: 'h1', name: 'Tansy' }
  await f.flow.afterMove(snap({ worldId: 'w3' }), 'Welcome.') // connect works, but world() isn't given…
  assert.equal(f.flow.moving, null)
  // …which only skips the party prompt: the move itself opened.
  assert.equal(f.host.titled, false)
  const g = setup()
  ;(g as unknown as { flow: { deps: { connect: () => Promise<never> } } }).flow.deps.connect = () => Promise.reject(new Error('no'))
  await g.flow.afterMove(snap({ worldId: 'w4' }), 'Welcome.')
  assert.equal(g.host.titled, true)
  assert.equal(g.flow.error, worldCopy.arriveFailed)
  assert.equal(g.flow.snapshot?.worldId, 'w4')
})

test('logging out keeps unsent progress for the next sign-in, and clears a cache the server has', async () => {
  const dirty = setup({ api: { logout: async () => undefined } })
  const link = new FakeLink('h1')
  link.dirty = true
  const s = new FakeSession(link)
  dirty.host.session = () => s
  dirty.caches.set('h1', { accountId: 'h1' } as ConnectedCache)
  await dirty.flow.logout()
  assert.equal(link.kept, true)
  assert.ok(dirty.caches.has('h1'), 'kept')
  assert.equal(s.destroyed, true)
  assert.equal(dirty.host.reloaded, true)

  const clean = setup({ api: { logout: err('network') } })
  const s2 = new FakeSession(new FakeLink('h1'))
  clean.host.session = () => s2
  clean.caches.set('h1', { accountId: 'h1' } as ConnectedCache)
  await clean.flow.logout()
  assert.ok(!clean.caches.has('h1'), 'cleared')
  assert.equal(clean.host.reloaded, true)
})

test('the moved-out notice tells the server once it is seen', async () => {
  const t = setup({ api: { worldNotice: async () => ({}) } })
  t.flow.leaverNotice = { movedOutAt: 5 } as WorldView
  t.flow.closeLeaverNotice()
  assert.equal(t.flow.leaverNotice, null)
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(t.calls, ['worldNotice'])
})
