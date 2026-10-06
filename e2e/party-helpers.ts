import { expect, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, serverState, setHabitica, sql, TOKEN, waitForWorld } from './connected'

/** Players for the party-world playtests (party-worlds*.spec.ts). */

/** Olive signs in from the title, the first of a fresh party: she lands in the party's new world. */
export async function partyOwner(page: Page): Promise<{ olive: string; party: string; world: string }> {
  const olive = newUser()
  const party = newUser()
  allow(olive)
  await setHabitica(olive, { name: 'Olive', party })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, olive)
  await waitForWorld(page)
  return { olive, party, world: (await serverState(page)).body.worldId }
}

/** A player who settled in a world of their own (signed in and started, by the API). */
export async function settledElsewhere(browser: Browser, baseURL: string, name: string): Promise<{ id: string; world: string }> {
  const id = newUser()
  allow(id)
  await setHabitica(id, { name })
  const ctx = await browser.newContext({ baseURL })
  const signIn = await ctx.request.post('/api/session', { data: { userId: id, token: TOKEN } })
  expect(signIn.ok()).toBe(true)
  const started = await ctx.request.post('/api/origin', { data: { choice: 'fresh', key: 'origin' } })
  expect(started.ok()).toBe(true)
  const world = (await started.json()).worldId as string
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

/** Sign in from the title as an existing player and play (`touch`: a phone with a touchscreen). */
export async function signInPage(
  browser: Browser,
  baseURL: string,
  id: string,
  viewport = { width: 1200, height: 760 },
  touch = false
): Promise<{ ctx: BrowserContext; other: Page }> {
  const ctx = await browser.newContext({ baseURL, viewport, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  await pasteAndConnect(other, id)
  await waitForWorld(other)
  return { ctx, other }
}

