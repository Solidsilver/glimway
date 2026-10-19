import test from 'node:test'
import assert from 'node:assert/strict'
import './helpers/svelte-runes.ts'
import { createNewGame } from '../src/lib/state.ts'
import type { Snapshot } from '../src/lib/api/types.ts'
import type { AccountApi, FlowLink, FlowLoading, FlowSession } from '../src/ui/account-flow.svelte.ts'

const { AccountFlow } = await import('../src/ui/account-flow.svelte.ts')

/**
 * Continue under the loading screen (src/ui/account-flow.svelte.ts): the
 * connect stage begins, fails, or gives way to the lease question; Retry and
 * Back abandon the attempt so its session never plays, and a late answer
 * to the abandoned attempt changes nothing.
 */

class Link implements FlowLink {
  status: FlowLink['status'] = 'offline'
  dirty = false
  accountId = 'h1'
  /** Resolves this link's reconnect (the test holds it, like a slow /play). */
  release!: () => void
  readonly answered: Promise<void>
  private after: FlowLink['status']
  constructor(after: FlowLink['status']) {
    this.after = after
    this.answered = new Promise((r) => (this.release = r))
  }
  async reconnect(): Promise<void> {
    await this.answered
    this.status = this.after
  }
  async takeOver(): Promise<void> {}
  async flush(): Promise<void> {}
  async keepForNextSignIn(): Promise<void> {}
}

class Session implements FlowSession {
  destroyed: boolean | null = null
  vitalsSource = 'demo' as const
  readonly link: Link
  constructor(link: Link) {
    this.link = link
  }
  destroy(skipSave = false): void {
    this.destroyed = skipSave
  }
}

function setup(opts: { connect?: () => Promise<Session> } = {}) {
  const log: string[] = []
  const loading: FlowLoading = {
    begin: (kind, stage) => void log.push(`begin ${kind} ${stage}`),
    fail: () => void log.push('fail'),
    cancel: (outcome = 'cancelled') => void log.push(`cancel ${outcome}`),
  }
  const made: Session[] = []
  const played: Session[] = []
  let status: FlowLink['status'] = 'online'
  const flow = new AccountFlow<Session>({
    api: {} as AccountApi,
    probe: async () => ({ kind: 'signed-in', snapshot: { accountId: 'h1', displayName: 'Tansy', state: createNewGame(), worldId: 'w1' } as unknown as Snapshot }),
    cache: { load: async () => null, latest: async () => null, save: async () => undefined, clear: async () => undefined },
    connect:
      opts.connect ??
      (async () => {
        const s = new Session(new Link(status))
        made.push(s)
        return s
      }),
    nameOf: () => 'Tansy',
    ui: { server: 'unknown', account: null, link: null, toast: () => undefined },
    host: {
      session: () => played.at(-1) ?? null,
      starting: () => false,
      play: async (s) => void played.push(s),
      closePanel: () => undefined,
      leaveWorld: () => undefined,
      toTitle: () => undefined,
      reload: () => undefined,
    },
    loading,
  })
  return { flow, log, made, played, setStatus: (s: FlowLink['status']) => (status = s) }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('Continue begins the connect stage; the world plays once the lease answers', async () => {
  const { flow, log, made, played } = setup()
  await flow.init()
  const going = flow.continue()
  await tick()
  assert.deepEqual(log, ['begin enter connect'])
  made[0]!.link.release()
  await going
  assert.deepEqual(played, [made[0]])
  assert.equal(flow.busy, false)
})

test('Retry while /play hangs: the attempt’s session ends unsaved and never plays; the fresh one does', async () => {
  const { flow, log, made, played } = setup()
  await flow.init()
  const first = flow.continue()
  await tick()
  const retried = flow.retry()
  await tick()
  assert.equal(made.length, 2)
  assert.equal(made[0]!.destroyed, true, 'the abandoned attempt ends without a save of its own')
  assert.deepEqual(log, ['begin enter connect', 'cancel retry', 'begin retry connect'])
  // The old answer lands late: nothing comes of it.
  made[0]!.link.release()
  await first
  assert.deepEqual(played, [])
  made[1]!.link.release()
  await retried
  assert.deepEqual(played, [made[1]])
  assert.equal(flow.busy, false)
})

test('a session made after its attempt was abandoned is ended at once', async () => {
  let release!: (s: Session) => void
  const late = new Promise<Session>((r) => (release = r))
  const { flow, played } = setup({ connect: () => late })
  await flow.init()
  const going = flow.continue()
  await tick()
  flow.backToTitle()
  assert.equal(flow.busy, false, 'Continue works again at the title')
  const s = new Session(new Link('online'))
  release(s)
  await going
  assert.equal(s.destroyed, true)
  assert.deepEqual(played, [])
})

test('a failed connect is the loading screen’s failure, not an unhandled error', async () => {
  const { flow, log } = setup({ connect: async () => Promise.reject(new Error('IndexedDB is gone')) })
  await flow.init()
  await flow.continue()
  assert.deepEqual(log, ['begin enter connect', 'fail'])
  assert.equal(flow.busy, false)
  flow.backToTitle()
  assert.deepEqual(log.at(-1), 'cancel title')
})

test('the lease question takes the screen from the loading screen', async () => {
  const { flow, log, made, setStatus } = setup()
  setStatus('superseded')
  await flow.init()
  const going = flow.continue()
  await tick()
  made[0]!.link.release()
  await going
  assert.equal(flow.gate?.kind, 'elsewhere')
  assert.deepEqual(log, ['begin enter connect', 'cancel cancelled'])
})
