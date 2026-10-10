import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import './helpers/svelte-runes.ts'

const { purseUi } = await import('../src/ui/purse.svelte.ts')
const { connectSession, disconnectSession } = await import('../src/ui/habitica-local.ts')
const { bus, EV } = await import('../src/game/events.ts')
const { purseCopy } = await import('../src/content/purse.ts')
const { TOP_UP_POLL_MS } = await import('../src/lib/purse.ts')

/** The press happens at 1000 s on this device's clock. */
const NOW_MS = 1_000_000

type Row = { id: string; amount: number; state: string; goldBefore?: number; goldAfter?: number; startedAt: number; settledAt?: number; leftover: boolean; note: string }
const row = (over: Partial<Row> = {}): Row => ({ id: 'tu-1', amount: 50, state: 'working', startedAt: 1000.2, leftover: false, note: '', ...over })
const moved = (over: Partial<Row> = {}): Row => row({ state: 'moved', goldBefore: 80, goldAfter: 30, settledAt: 1004, ...over })

type TopUpAnswer = { ok: true; topUp: ReturnType<typeof view> } | { ok: false; code: string; sent?: false }
const view = (r: Row) => ({ ...r, goldBefore: r.goldBefore ?? null, goldAfter: r.goldAfter ?? null, settledAt: r.settledAt ?? null })

/** A scripted link: the top-up's one answer, then what each purse read finds. */
function scripted(answer: TopUpAnswer, reads: (n: number) => { topUps: Row[]; working?: Row | null }) {
  const calls = { topUp: [] as { token: string; amount: number }[], reads: 0 }
  const link = {
    async topUp(token: string, amount: number) {
      calls.topUp.push({ token, amount })
      return answer
    },
    async purseRead() {
      const r = reads(calls.reads++)
      return { ok: true, value: { purse: { gold: 0, topUpsLeft: 1, working: r.working ?? undefined }, topUps: r.topUps, lines: [] } }
    }
  }
  return { session: { link } as never, calls }
}

function setup(t: TestContext): { toasts: { text: string; kind?: string }[] } {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW_MS })
  purseUi.reset()
  connectSession('player-1', 'test-token')
  const toasts: { text: string; kind?: string }[] = []
  const onToast = (p: { text: string; kind?: string }) => toasts.push(p)
  bus.on(EV.toast, onToast)
  t.after(() => {
    bus.off(EV.toast, onToast)
    purseUi.reset()
    disconnectSession()
  })
  return { toasts }
}

/** Let the awaited answers in. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** One poll: the timer fires, the read answers. */
async function nextPoll(t: TestContext): Promise<void> {
  t.mock.timers.tick(TOP_UP_POLL_MS)
  await settle()
}

async function toConsent(amount: string): Promise<void> {
  await purseUi.start(async () => ({ ok: true, gold: 80 }))
  assert.equal(purseUi.phase, 'consent')
  assert.equal(purseUi.amount, '', 'the field starts empty')
  purseUi.amount = amount
}

test('Move sends the one request, follows the top-up, and says how it came out', async (t) => {
  const { toasts } = setup(t)
  const { session, calls } = scripted({ ok: true, topUp: view(row()) }, (n) => (n === 0 ? { topUps: [row()], working: row() } : { topUps: [moved()] }))
  await toConsent('50')
  await purseUi.confirm(session)
  assert.deepEqual(calls.topUp, [{ token: 'test-token', amount: 50 }])
  assert.equal(purseUi.phase, 'checking')
  await nextPoll(t)
  assert.equal(purseUi.phase, 'checking', 'still working')
  await nextPoll(t)
  assert.equal(purseUi.phase, 'idle')
  assert.equal(purseUi.amount, '')
  const line = purseCopy.moved(50, 80, 30)
  assert.deepEqual(purseUi.outcome, { text: line, ok: true })
  assert.equal(toasts.at(-1)?.text, line)
  assert.equal(calls.topUp.length, 1)
  assert.equal(calls.reads, 2)
  await nextPoll(t)
  assert.equal(calls.reads, 2, 'no reads once it settled')
})

test('a lost answer is never sent again: the purse read finds the working top-up', async (t) => {
  setup(t)
  const { session, calls } = scripted({ ok: false, code: 'offline' }, (n) =>
    n === 0 ? { topUps: [row()], working: row() } : { topUps: [moved()] }
  )
  await toConsent('50')
  await purseUi.confirm(session)
  assert.equal(purseUi.phase, 'checking')
  await nextPoll(t)
  await nextPoll(t)
  assert.equal(purseUi.phase, 'idle')
  assert.deepEqual(purseUi.outcome, { text: purseCopy.moved(50, 80, 30), ok: true })
  assert.equal(calls.topUp.length, 1)
})

test('after a lost answer, an older top-up or another amount is not taken for this one', async (t) => {
  const { toasts } = setup(t)
  const older = moved({ id: 'tu-0', startedAt: 990 })
  const otherAmount = moved({ id: 'tu-2', amount: 20, startedAt: 1000.5 })
  const { session, calls } = scripted({ ok: false, code: 'offline' }, () => ({ topUps: [otherAmount, older] }))
  await toConsent('50')
  await purseUi.confirm(session)
  for (let i = 0; i < 3; i++) await nextPoll(t)
  assert.equal(purseUi.phase, 'checking', 'nothing of ours yet')
  await nextPoll(t)
  // Nothing started: it gives up, saying so, and never sends it again.
  assert.equal(purseUi.phase, 'idle')
  assert.deepEqual(purseUi.outcome, { text: purseCopy.lost, ok: false })
  assert.equal(toasts.at(-1)?.kind, 'error')
  assert.equal(calls.topUp.length, 1)
  const reads = calls.reads
  await nextPoll(t)
  assert.equal(calls.reads, reads, 'the polling stopped')
})

test('a top-up never sent says Needs a connection at once, and reads nothing', async (t) => {
  setup(t)
  const { session, calls } = scripted({ ok: false, code: 'offline', sent: false }, () => ({ topUps: [] }))
  await toConsent('50')
  await purseUi.confirm(session)
  assert.equal(purseUi.phase, 'consent', 'the card stays, to try again')
  assert.equal(purseUi.error, purseCopy.notSent)
  await nextPoll(t)
  assert.equal(calls.reads, 0)
})

test('a refusal says why on the card', async (t) => {
  setup(t)
  const { session, calls } = scripted({ ok: false, code: 'top-up-limit' }, () => ({ topUps: [] }))
  await toConsent('50')
  await purseUi.confirm(session)
  assert.equal(purseUi.phase, 'consent')
  assert.ok(purseUi.error.length > 0)
  assert.notEqual(purseUi.error, purseCopy.notSent)
  await nextPoll(t)
  assert.equal(calls.reads, 0)
})

test('Move sends nothing without a whole amount or a token', async (t) => {
  setup(t)
  const { session, calls } = scripted({ ok: true, topUp: view(moved()) }, () => ({ topUps: [] }))
  await toConsent('')
  await purseUi.confirm(session)
  purseUi.amount = '81'
  await purseUi.confirm(session)
  assert.equal(calls.topUp.length, 0, 'more than Habitica has')
  purseUi.amount = '50'
  disconnectSession()
  await purseUi.confirm(session)
  assert.equal(calls.topUp.length, 0)
  assert.equal(purseUi.error, purseCopy.connectFirst)
})

test('Not now and closing the card send nothing and forget the amount', async (t) => {
  setup(t)
  const { session, calls } = scripted({ ok: true, topUp: view(moved()) }, () => ({ topUps: [] }))
  await toConsent('50')
  purseUi.cancel()
  assert.equal(purseUi.phase, 'idle')
  assert.equal(purseUi.sheet, null)
  assert.equal(purseUi.amount, '')
  await toConsent('30')
  purseUi.closeSheet()
  assert.equal(purseUi.phase, 'idle')
  assert.equal(purseUi.amount, '')
  await purseUi.confirm(session)
  assert.equal(calls.topUp.length, 0)
})

test('a sync that stops shows no card', async (t) => {
  setup(t)
  await purseUi.start(async () => ({ ok: false }))
  assert.equal(purseUi.phase, 'idle')
  assert.equal(purseUi.sheet, null)
})

test('signing out stops following a top-up', async (t) => {
  setup(t)
  const { session, calls } = scripted({ ok: true, topUp: view(row()) }, () => ({ topUps: [row()], working: row() }))
  await toConsent('50')
  await purseUi.confirm(session)
  assert.equal(purseUi.phase, 'checking')
  purseUi.reset()
  await nextPoll(t)
  assert.equal(calls.reads, 0)
  assert.equal(purseUi.phase, 'idle')
})
