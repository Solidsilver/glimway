import { expect, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { allow, linkStatus, newUser, openTitleGuide, pasteAndConnect, routeHabitica, serverState, setHabitica, sql, TOKEN, waitForWorld, CONTRACT } from './connected'

/** Players for the party-world playtests (party-worlds*.spec.ts). */

/**
 * A first sign-in may be asked where to live (a party with a world here, or
 * one this account may open): answer it, then wait for the world. Settled
 * players and newcomers with no party go straight in.
 */
async function answerWorldChoice(page: Page, choice: 'party' | 'own' = 'party'): Promise<void> {
  const gate = page.getByTestId('world-choice')
  await expect.poll(async () => (await gate.isVisible()) || (await linkStatus(page)) === 'online', { timeout: 20_000 }).toBe(true)
  if (await gate.isVisible()) await gate.getByTestId(choice === 'party' ? 'world-choice-party' : 'world-choice-own').click()
  await waitForWorld(page)
}

/** Olive signs in from the title, the first of a fresh party: she opens the party's world and lands in it. */
export async function partyOwner(page: Page): Promise<{ olive: string; party: string; world: string }> {
  const olive = newUser()
  const party = newUser()
  allow(olive)
  await setHabitica(olive, { name: 'Olive', party })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, olive)
  await answerWorldChoice(page, 'party')
  return { olive, party, world: (await serverState(page)).body.worldId }
}

/** A player who settled in a world of their own (signed in and started, by the API). */
export async function settledElsewhere(browser: Browser, baseURL: string, name: string): Promise<{ id: string; world: string }> {
  const id = newUser()
  allow(id)
  await setHabitica(id, { name })
  const ctx = await browser.newContext({ baseURL })
  const signIn = await ctx.request.post('/api/session', { data: { userId: id, token: TOKEN }, ...CONTRACT })
  expect(signIn.ok(), `sign-in: ${signIn.status()} ${await signIn.text()}`).toBe(true)
  // An allowlisted newcomer's own world is made at sign-in (the origin
  // choice is gone); the state's snapshot names it.
  const body = await signIn.json()
  const world = body.state?.account?.worldId as string | undefined
  if (!world) throw new Error(`sign-in gave no world for ${id}: ${JSON.stringify(body).slice(0, 600)}`)
  await ctx.close()
  return { id, world }
}

/**
 * Test lever: the player alone on a deed at lot 3 of their world (as if
 * they had bought it from Silas), so a move leaves the land to go quiet.
 */
export function homesteadAlone(id: string, world: string): void {
  const home = `home-${id}`
  const now = Math.floor(Date.now() / 1000)
  sql(`INSERT INTO homesteads(id,world_id,gate,tier,posts_bought,claimed_at) VALUES('${home}','${world}',2,1,0,${now});
INSERT INTO homestead_members VALUES('${id}','${home}',${now});
INSERT INTO player_deeds VALUES('${id}',1);`)
}

/** Sign in from the title and play (`touch`: a phone with a touchscreen; `choice`: a newcomer's answer, if asked). */
export async function signInPage(
  browser: Browser,
  baseURL: string,
  id: string,
  viewport = { width: 1200, height: 760 },
  touch = false,
  choice: 'party' | 'own' = 'party'
): Promise<{ ctx: BrowserContext; other: Page }> {
  const ctx = await browser.newContext({ baseURL, viewport, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  await pasteAndConnect(other, id)
  await answerWorldChoice(other, choice)
  return { ctx, other }
}

