import { expect, type Page } from './fixtures'
import { readDialogue, settled, waitForLive } from './helpers'
import { moveServerClock } from './connected'

/**
 * Rooms (docs/design/indoors.md 2): front doors on the village map, the
 * room view the dev hooks give, and the library's shelves (the panel opens
 * from inside the reading room now, not at its door).
 */

export type RoomId = 'in:village:bakery' | 'in:village:mill' | 'in:village:mill:2' | 'in:village:library'

/** Each front door's doorstep in the village (the tile you press the door from). */
export const DOORSTEP: Readonly<Record<string, [number, number]>> = {
  'in:village:bakery': [7, 8],
  'in:village:mill': [29, 23],
  'in:village:library': [4, 18]
}

export type RoomView = {
  areaId: string
  room: { id: string; name: string; arrive: { tx: number; ty: number } } | null
  zoom: number
  facing: { x: number; y: number }
  props: { art: string; frame: string; tx: number; ty: number; tw: number; th: number }[]
  spots: string[]
  lights: { kind: string; visible: boolean }[]
  houses: { room: string; window: boolean; smoke: boolean }[]
}

export async function roomView(page: Page): Promise<RoomView> {
  return page.evaluate(() => (window as unknown as { __fsRoom: () => RoomView }).__fsRoom())
}

/** The scene playing a room: settled in it. */
export async function inRoom(page: Page, area: string): Promise<void> {
  await settled(page, { area })
}

/** Stand on a front door's doorstep in the village and go in (E, or the touch button). */
export async function goIn(page: Page, room: string, opts: { touch?: boolean; prompt?: RegExp } = {}): Promise<void> {
  const [tx, ty] = DOORSTEP[room]
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevWarp: (a: string, x: number, y: number) => void }).__fsDevWarp('village', x, y), [tx, ty] as const)
  await settled(page, { area: 'village' })
  await expect(page.locator('.prompt')).toContainText(opts.prompt ?? /Go into|Knock at/)
  await waitForLive(page)
  if (opts.touch) await page.locator('.controls .act').tap()
  else await page.keyboard.press('e')
  await inRoom(page, room)
}

/** Into the reading room and up to the tall shelves: the library panel opens. */
export async function openLibraryShelves(page: Page, opts: { touch?: boolean } = {}): Promise<void> {
  await goIn(page, 'in:village:library', opts)
  await page.evaluate(() => (window as unknown as { __fsDevWarp: (a: string, x: number, y: number) => void }).__fsDevWarp('in:village:library', 3, 2))
  await inRoom(page, 'in:village:library')
  const act = () => (opts.touch ? page.locator('.controls .act').tap() : page.keyboard.press('e'))
  // Past the opening, while A Seat by the Lamp's `browse-shelf` step is next,
  // the shelves tell the step first ("Browse the tall shelves"); the next use opens the panel.
  await expect(page.locator('.prompt')).toContainText(/Browse the (tall )?shelves/)
  await waitForLive(page)
  if (/tall shelves/.test((await page.locator('.prompt').textContent()) ?? '')) {
    await act()
    await expect(page.getByRole('dialog', { name: /Conversation with/ })).toBeVisible()
    await readDialogue(page)
    await expect(page.locator('.prompt')).toContainText('Browse the shelves')
    await waitForLive(page)
  }
  await act()
}

/**
 * The next `minute` past an hour from `now` (Unix seconds), a few seconds
 * in: the residents' cycle runs on the UTC hour (content: Hazel 40 in and
 * 20 out, Finn offset 20; docs/design/indoors.md 4).
 */
export function nextMinute(now: number, minute: number, second = 5): number {
  const hour = now - (now % 3600)
  const t = hour + minute * 60 + second
  return t > now ? t : t + 3600
}

/**
 * Set the hour so the residents stand where a spec expects them, on both
 * clocks: the game's (the dev clock) and, with `server`, the world's (moved
 * forward to the same moment: a sale or a quest step asks the server where
 * they are). Default :57, when Hazel is in the square and Finn at his mill
 * door. Returns the moment.
 */
export async function setHour(page: Page, opts: { minute?: number; second?: number; server?: boolean } = {}): Promise<number> {
  const minute = opts.minute ?? 57
  let at = nextMinute(Math.floor(Date.now() / 1000), minute, opts.second)
  if (opts.server) {
    at = nextMinute(await moveServerClock(page, 0), minute, opts.second)
    await moveServerClock(page, at)
  }
  await page.evaluate((t) => {
    const w = window as unknown as { __fsDevCalendar: (t: number) => void; __fsDevCycleCheck?: () => void }
    w.__fsDevCalendar(t)
    w.__fsDevCycleCheck?.()
  }, at)
  return at
}

/** Hazel in the square and Finn at his door (:57): for specs that meet them outside. */
export const residentsOut = (page: Page, opts: { server?: boolean } = {}) => setHour(page, { minute: 57, ...opts })
