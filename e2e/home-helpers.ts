import { expect, type Page } from './fixtures'
import type { Locator } from '@playwright/test'
import { accountOf, allow, CONTRACT, newUser, openTitleGuide, pasteAndConnect, pastOpening, routeHabitica, setHabitica, sql, syncFromMenu, waitForWorld, served } from './connected'
import { landFromCells, type Land } from '../src/lib/homestead-land.ts'
import { dialogueState, frames, readDialogue, settled, waitForArea, waitForLive, expectToast, SERVER_ANSWER_MS } from './helpers'
import { setHour } from './room-helpers'
import { residentAt } from '../src/lib/residents.ts'

/**
 * Helpers for the homestead and village-life playtests (real Go server).
 * SCREENS=1 makes `shot` save desktop + phone screenshots to .agent/screens/.
 */

const OUT = '.agent/screens'
export type Area = 'village' | 'woodland' | 'ruin' | 'commons' | 'in:commons:yard' | 'in:commons:yard:deeds' | `in:home:${number}` | `home:${number}`

type Item = { id: string; itemDef: string; scene: string | null; x: number | null; y: number | null; rotation: number | null; name?: string | null }
export interface Home {
  id: string
  gate: number
  tier: number
  members: { id: string; displayName: string }[]
  member: boolean
  desolate: boolean
  landSeed: number
  cleared: [number, number][]
  postsBought: number
  nextPost: Record<string, number>
  items: Item[]
}
export interface HomesView {
  status: string
  claimed: boolean
  myGate: number | null
  gateCount: number
  gates: { gate: number; homeId: string | null; names: string[]; tier: number; desolate: boolean; mine: boolean; price: number | null; shelf?: boolean }[]
  invites: { homeId: string; gate: number; from: { id: string; name: string }; to: { id: string; name: string } }[]
  mine: Home | null
  here: Home | null
  goal: string | null
  slots: { gate: number; tx: number; ty: number; side: 'west' | 'east'; sign: { tx: number; ty: number }; entry: { tx: number; ty: number } }[]
  features: { silas: { tx: number; ty: number } } | null
  land: { gate: number; door: { tx: number; ty: number }; doorstep: { tx: number; ty: number }; mailbox: { tx: number; ty: number }; site: { x: number; y: number; w: number; h: number }; desolate: boolean } | null
  guide: { x: number; y: number; arrow: boolean } | null
  placing: boolean
  /** The mounts standing in their bays on screen (the stable's drawing). */
  stalled: string[]
  placement: { selected: string | null; problem: string | null; spot: { x: number; y: number } | null; clearing: { x: number; y: number } | null; message: { text: string } | null } | null
}

export const homes = (page: Page) => page.evaluate(() => (window as unknown as { __fsHomes: () => HomesView }).__fsHomes())
export const area = (page: Page) => page.evaluate(() => (window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId)
export const hurt = (page: Page, n: number) => page.evaluate((d) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(d), n)
export const place = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(px, py), [x, y] as const)

/** Desktop and phone screenshots of the same moment (names end -desktop / -phone). */
export async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  const base = name.replace(/-desktop$/, '')
  const size = page.viewportSize()!
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${base}-desktop.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${base}-phone.png` })
  await page.setViewportSize(size)
  await page.waitForTimeout(400)
}

/** Dev warp, for any area id (the Commons included). */
export async function go(page: Page, to: string, tx: number, ty: number): Promise<void> {
  // The warp starts the transition at once (a refused warp leaves us here).
  await page.evaluate(([a, x, y]) => (window as unknown as { __fsDevWarp: (a: string, x: number, y: number) => void }).__fsDevWarp(a as string, x as number, y as number), [to, tx, ty] as const)
  await waitForArea(page, to as Area)
}

/** Conversations opened on a page before its latest talk() (readOn looks after it). */
const talkedFrom = new WeakMap<Page, number>()

/** Talk at the prompt; pick the choice named `pick` (if any), and read to the end. */
export async function talk(page: Page, prompt: RegExp, pick?: RegExp): Promise<void> {
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  // With a reply to pick: someone not ready yet ("Hold on, I'm finding your
  // page") is asked again, as a player would.
  for (let attempt = 1; ; attempt++) {
    await expect(page.locator('.prompt')).toContainText(prompt)
    await waitForLive(page)
    const mark = (await dialogueState(page)).opened
    talkedFrom.set(page, mark)
    await page.keyboard.press('e')
    await expect(dialogue).toBeVisible()
    let picked = false
    await readDialogue(page, { pick, picked: () => (picked = true) })
    // A word more the world adds straight away is read too (as a person
    // would); one that comes later is readOn's.
    for (let i = 0; i < 5; i++) {
      await frames(page, 8)
      const d = await dialogueState(page)
      if (!d.open) break
      await readDialogue(page)
    }
    await expect.poll(async () => (await dialogueState(page)).opened).toBeGreaterThan(mark)
    if (!pick || picked) return
    if (attempt >= 3) throw new Error(`no reply matching ${pick} was offered at ${prompt}`)
    await frames(page, 30)
  }
}

/** Sign in from the title as a new allowlisted player. */
/**
 * A new account in the village. Past the opening by default (as migration
 * 029 leaves every account that played before it), so a spec starts where
 * the lantern road does; `{ opening: true }` keeps the first morning.
 */
export async function freshPlayer(page: Page, name = 'Tansy', invite?: string, opts: { opening?: boolean; lvl?: number; class?: string | null } = {}): Promise<string> {
  const id = newUser()
  if (!invite) allow(id)
  // `lvl`/`class`: the Habitica hero's level and class (the default is a level-2 warrior: no moves yet).
  await setHabitica(id, { name, ...(opts.lvl !== undefined ? { lvl: opts.lvl } : {}), ...(opts.class !== undefined ? { class: opts.class } : {}) })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, id, invite ? { invite } : {})
  await waitForWorld(page)
  if (!opts.opening) await pastOpening(page, id)
  return id
}

/** Two syncs: the welcome, then a big Habitica day (three levels: about 30 glims). */
export async function earnGlims(page: Page, id: string): Promise<void> {
  let balance = 0
  for (const [lvl, exp, toast] of [[2, 20, /glims into your hand/], [5, 100, /glims caught the light/]] as const) {
    await setHabitica(id, { lvl, exp })
    balance = await syncGlimBalance(page)
    await expectToast(page, toast)
    await page.getByRole('button', { name: 'Back to the road' }).click()
  }
  expect(balance).toBeGreaterThanOrEqual(20)
}

/**
 * Confirm the real server's balance from the sync that earned it. A separate
 * page.request read can spend the whole poll budget resolving localhost even
 * after the browser has received the successful sync and shown its toast.
 */
async function syncGlimBalance(page: Page): Promise<number> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/profile') && r.request().method() === 'POST'),
    syncFromMenu(page)
  ])
  expect(response.ok()).toBe(true)
  // An operation envelope: the state is the server's PlayerState.
  return (await response.json()).state.glims.balance as number
}

/** Read an open conversation (one the world opened on its own) to its end. */
export async function readOn(page: Page, says: RegExp, opts: { timeout?: number } = {}): Promise<void> {
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  // The talk loop may already have read it (it follows the answer closely):
  // wait until a conversation saying it has opened since the last talk(),
  // whether or not it is still on screen.
  const from = talkedFrom.get(page) ?? 0
  await expect
    .poll(async () => {
      const d = await dialogueState(page)
      return d.seen.some((x, i) => d.opened - d.seen.length + i >= from && says.test(x.text))
    }, { message: `a conversation saying ${says}`, ...(opts.timeout ? { timeout: opts.timeout } : {}) })
    .toBe(true)
  if (!(await dialogueState(page)).open) return
  // The open one is it (its whole text: the typewriter may still be going).
  expect((await dialogueState(page)).said.join('\n')).toMatch(says)
  await readDialogue(page)
  await expect(dialogue).toBeHidden()
}

/** Silas's spot in his yard, by the sawhorse (the Commons map; his cycle's yard spot). */
/** The Yard's shop and Pell's office (content/rooms.json). */
export const YARD = 'in:commons:yard'
export const DEEDS = 'in:commons:yard:deeds'
/** In front of Silas's counter (the shop): where you talk to him while his hour has him inside. */
export const AT_COUNTER = { tx: 7, ty: 4 }
/** Left of Pell's desk (Pell stands at its right), at the deed table's corner: where Pell talks across the desk, and where a deed is signed. */
export const AT_PELL = { tx: 5, ty: 3 }
/** Up behind Pell, by the back wall: Pell talks from here, but the deed table is out of reach. */
export const BY_DESK = { tx: 8, ty: 2 }

/** Whether Silas is drawn in this scene now (his cycle's phase here; false while he walks or is away). */
export async function silasPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __fsNpcs: () => { id: string; present: boolean }[] }).__fsNpcs().find((n) => n.id === 'silas')?.present ?? false)
}

/**
 * Pin Silas's schedule, then stand at his known position. Behavior tests
 * shouldn't spend separate polling budgets guessing which side of his route
 * the resident renderer has reached.
 */
export async function bySilas(page: Page): Promise<void> {
  const at = residentAt('silas', await setHour(page, { minute: 10, server: true }))
  if (!at) throw new Error('Silas has no scheduled position at minute 10')
  await go(page, at.area as Area, at.tx, at.ty + 1)
  await expect.poll(() => silasPresent(page), {
    timeout: 5_000,
    message: `Silas should be present at his minute-10 position (${at.area}, ${at.tx}, ${at.ty}); prompt=${await page.locator('.prompt').textContent().catch(() => '(unavailable)')}`
  }).toBe(true)
  await expect(page.locator('.prompt')).toContainText('Talk to Silas')
}

export async function silasSays(page: Page, pick?: RegExp): Promise<void> {
  await bySilas(page)
  await talk(page, /Talk to Silas/, pick)
}

/** Into Pell's office, beside the desk (and the deed table), and talk; pick `pick` if given. */
export async function pellSays(page: Page, pick?: RegExp): Promise<void> {
  await go(page, DEEDS, AT_PELL.tx, AT_PELL.ty)
  await talk(page, /Talk to Pell/, pick)
}

/** Pell's Manage your deed panel, opened from Pell's talk (you must be on a deed). */
export async function manageDeed(page: Page): Promise<Locator> {
  await pellSays(page, /Manage your deed/)
  const deed = page.getByRole('dialog', { name: 'Your deed' })
  await expect(deed).toBeVisible()
  return deed
}

/**
 * Give up your place on the deed from the Manage your deed panel: Pell's
 * confirm (`says`, if given, is checked against it), then off the deed.
 */
export async function giveUpPlace(page: Page, says?: string | RegExp): Promise<void> {
  const deed = await manageDeed(page)
  await deed.getByTestId('deed-give-up').click()
  const confirm = page.getByRole('alertdialog', { name: /Give up your place/ })
  if (says) await expect(confirm).toContainText(says)
  await confirm.getByRole('button', { name: 'Strike my name' }).click()
  await expect.poll(async () => (await lane(page)).mine, { timeout: SERVER_ANSWER_MS }).toBeNull()
  await expect(deed).toHaveCount(0)
  await expectToast(page, /One line through it/)
}

/** Silas's Yard panel, opened from his talk ("See the Yard"). */
export async function seeTheYard(page: Page): Promise<Locator> {
  await silasSays(page, /See the Yard/)
  const yard = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await expect(yard).toBeVisible()
  return yard
}

/**
 * Raise the cottage (or build on the workshop) from the Yard panel's Build
 * tab, read Silas's word on it, and close the panel. The tier is the
 * server's once it answers.
 */
export async function yardBuild(page: Page, what: 'cottage' | 'workshop'): Promise<void> {
  const yard = await seeTheYard(page)
  await yard.getByRole('tab', { name: 'Build' }).click()
  await yard.getByTestId(what === 'cottage' ? 'raise-cottage' : 'build-workshop').click()
  await expect(yard.locator('.msg.ok')).toContainText(what === 'cottage' ? /Steady as a route stone/ : /Deep eaves/, { timeout: SERVER_ANSWER_MS })
  await yard.getByRole('button', { name: 'Close Silas’s yard' }).click()
  await expect(yard).toBeHidden()
}

/** Glims without a top-up or a sync (both sides of the ledger, never XP-earned). */
export function seedGlims(habiticaId: string, glims: number): void {
  const a = accountOf(habiticaId)
  sql(`UPDATE balances SET glims = glims + ${glims} WHERE account_id = '${a}';
       INSERT INTO ledger (account_id, currency, delta, earned_delta, reason, ref, created_at)
       VALUES ('${a}', 'glims', ${glims}, 0, 'test-grant', 'e2e', unixepoch());
       UPDATE players SET version = version + 1 WHERE account_id = '${a}';`)
}

/** The homestead behind a gate, as the server tells this player (null: unclaimed). */
export async function homeAt(page: Page, gate: number): Promise<Home | null> {
  const res = await page.request.get(`/api/homestead/gate/${gate}`, CONTRACT)
  expect(res.ok()).toBe(true)
  // The schema serves tile pairs as {x, y} objects (homestead.proto's Coord);
  // these helpers read the [x, y] pairs they always did.
  const home = (await served(res)).home as (Home & { cleared?: unknown[]; stumps?: unknown[] }) | null
  if (!home) return home
  const pair = (c: unknown): [number, number] => (Array.isArray(c) ? [c[0], c[1]] : [(c as { x: number; y: number }).x, (c as { x: number; y: number }).y])
  return { ...home, cleared: (home.cleared ?? []).map(pair), stumps: (home.stumps ?? []).map(pair) } as Home
}

/** A gate's land grid as the server serves it. */
export async function landOf(page: Page, gate: number): Promise<Land> {
  const res = await page.request.get(`/api/homestead/land/${gate}`, CONTRACT)
  expect(res.ok()).toBe(true)
  return landFromCells(await res.json())
}

/** The Commons lane as the server tells this player. */
export async function lane(page: Page): Promise<{ gates: HomesView['gates']; gateCount: number; mine: { homeId: string; gate: number } | null; invites: HomesView['invites'] }> {
  const res = await page.request.get('/api/commons', CONTRACT)
  expect(res.ok()).toBe(true)
  return served(res)
}

/** Your own homestead (the server's word). The id argument is accepted for older call sites. */
export async function myHome(page: Page, _id?: string): Promise<Home> {
  const l = await lane(page)
  expect(l.mine).not.toBeNull()
  return (await homeAt(page, l.mine!.gate))!
}

/** Walk through gate g from the lane in front of it, onto its land. */
export async function throughGate(page: Page, gate: number): Promise<void> {
  // The lane's slots are the Commons scene's (from the Yard, say, step out first).
  if ((await area(page)) !== 'commons') await go(page, 'commons', 23, 19)
  const v = await homes(page)
  const slot = v.slots.find((s) => s.gate === gate)!
  await go(page, 'commons', slot.entry.tx, slot.entry.ty)
  const key = slot.side === 'west' ? 'ArrowLeft' : 'ArrowRight'
  await page.keyboard.down(key)
  await waitForArea(page, `home:${gate}` as Area)
  await page.keyboard.up(key)
}


/**
 * Test-only lever: put goods straight into a player's pack in the e2e
 * database (nothing in the client gathers them yet). The server reads
 * balances from the item tables on every request. Materials and items are
 * unmarked stacks unless a maker is given. `id` is the Habitica subject
 * freshPlayer returned; the item tables key on the server's account id.
 */
export function fund(habiticaId: string, goods: { materials?: Record<string, number>; items?: Record<string, number>; maker?: string; personal?: Record<string, number> }): void {
  const id = accountOf(habiticaId)
  const esc = (v: string) => v.replace(/'/g, "''")
  const maker = goods.maker ? esc(accountOf(goods.maker)) : ''
  const statements: string[] = []
  const put = (location: string, def: string, n: number, by: string) =>
    statements.push(`INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES('${location}','${esc(id)}','${esc(def)}','${by}',${n}) ON CONFLICT(location,owner,item_def,maker_id) DO UPDATE SET qty=excluded.qty;`)
  for (const [m, n] of Object.entries(goods.materials ?? {})) put('pack', m, n, '')
  for (const [i, n] of Object.entries(goods.items ?? {})) put('pack', i, n, maker)
  for (const [i, n] of Object.entries(goods.personal ?? {})) put('personal', i, n, '')
  sql(statements.join('\n'))
}

/**
 * Test-only lever: one tool (or other instance) straight into a pack, with
 * `uses` uses left (full when omitted). Story heirlooms have no gameplay
 * source yet. Returns the instance id.
 */
export function giveInstance(habiticaId: string, def: string, opts: { uses?: number; max: number; maker?: string }): string {
  const instance = `${def}-${Math.random().toString(36).slice(2, 10)}`
  const condition = opts.uses === undefined ? opts.max : opts.uses * 3
  const maker = opts.maker ? accountOf(opts.maker) : ''
  sql(`INSERT INTO item_instances(id,item_def,location,owner,condition,max_condition,maker_id,created_at) VALUES('${instance}','${def}','pack','${accountOf(habiticaId)}',${condition},${opts.max},'${maker}',0);`)
  return instance
}

/** Three syncs: the welcome, then two big Habitica days (enough glims for a workshop). */
export async function earnPlenty(page: Page, id: string): Promise<void> {
  await earnGlims(page, id)
  await setHabitica(id, { lvl: 9, exp: 100 })
  const balance = await syncGlimBalance(page)
  await expectToast(page, /glims caught the light/)
  await page.getByRole('button', { name: 'Back to the road' }).click()
  expect(balance).toBeGreaterThanOrEqual(60)
}

/** Claim the first unclaimed gate on the lane from Pell (read the reply), then step back out onto the lane; returns the gate. */
export async function claimDeed(page: Page): Promise<number> {
  await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status, { timeout: SERVER_ANSWER_MS }).toBe('ready')
  const free = (await homes(page)).gates.find((g) => g.homeId === null)!
  await pellSays(page, new RegExp(`The deed to Lot ${free.gate + 1}`))
  await expect.poll(async () => (await homes(page)).myGate, { timeout: SERVER_ANSWER_MS }).toBe(free.gate)
  // Pell answers once the server has the claim: read it (it would hold the screen).
  await readOn(page, DEED_BOUGHT)
  // Back out on the lane, as a deed bought from Silas used to leave you.
  await go(page, 'commons', 23, 19)
  return free.gate
}

/** Pell's word on a deed bought (src/content/pell.ts PELL_DEED.bought). */
export const DEED_BOUGHT = /Entered: Lot|received and logged/

/** Through your own gate onto your land; the land's fixed spots (door, doorstep, mailbox, site). */
export async function toMyLand(page: Page): Promise<NonNullable<HomesView['land']>> {
  const gate = (await lane(page)).mine!.gate
  if ((await area(page)) !== 'commons') await go(page, 'commons', 23, 19)
  await expect.poll(async () => (await homes(page)).status, { timeout: SERVER_ANSWER_MS }).toBe('ready')
  await throughGate(page, gate)
  await expect.poll(async () => (await homes(page)).land, { timeout: SERVER_ANSWER_MS }).not.toBeNull()
  return (await homes(page)).land!
}

/** Stand at a tile of your land (relative to the doorstep). */
export async function onMyLand(page: Page, dx = 0, dy = 0): Promise<NonNullable<HomesView['land']>> {
  const land = await toMyLand(page)
  await go(page, `home:${land.gate}`, land.doorstep.tx + dx, land.doorstep.ty + dy)
  return land
}

/** Into your own cottage (it must be built). */
export async function intoCottage(page: Page): Promise<void> {
  await onMyLand(page)
  await expect(page.locator('.prompt')).toContainText('Go inside')
  await waitForLive(page)
  await page.keyboard.press('e')
  await settled(page, { prefix: 'in:home:' })
}

/** Stand at your mailbox (on your land). */
export async function atMyMailbox(page: Page): Promise<void> {
  const land = await toMyLand(page)
  await go(page, `home:${land.gate}`, land.mailbox.tx, land.mailbox.ty + 1)
}
