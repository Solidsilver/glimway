import { expect, test, type Page } from './fixtures'
import { dialogueState, openTalk, readDialogue, untilChoices, waitForArea, waitForLive, warp } from './helpers'
import { reenter } from './connected'
import { freshPlayer } from './home-helpers'
import { GREETINGS, TALK_COPY } from '../src/content/talk'
import { dialogueFor } from '../src/content/world'

/**
 * Talk that doesn't repeat itself: a person's lines play in full once; the
 * next talk is a greeting and the choices, with "Hear it again"; a quest
 * step's new lines play in full the first time.
 */
const said = async (page: Page) => (await dialogueState(page)).said

async function talk(page: Page, who: RegExp, opts: { pick?: RegExp } = {}): Promise<string[]> {
  await waitForLive(page)
  await openTalk(page, who)
  await readDialogue(page, opts)
  return said(page)
}

test('a story is told once; then a greeting, the choices and "Hear it again"', async ({ page }) => {
  await freshPlayer(page)
  const pipNew = dialogueFor('pip', 'new').lines
  await warp(page, 'village', 28, 16)

  // First talk: everything Pip has to say.
  expect(await talk(page, /Talk to Pip/)).toEqual(pipNew)

  // Second: a greeting, and the choice to hear it again or go.
  await waitForLive(page)
  await openTalk(page, /Talk to Pip/)
  const choices = await untilChoices(page)
  const s = await dialogueState(page)
  expect(GREETINGS.pip).toContain(s.said[0])
  expect(s.said).toHaveLength(1)
  expect(choices.map((c) => c.text)).toEqual([TALK_COPY.again, TALK_COPY.leave])
  // "Hear it again" plays the whole of it, then the talk ends (a goodbye alone isn't asked).
  await readDialogue(page, { pick: /Hear it again/ })
  expect((await said(page)).slice(1)).toEqual(pipNew)
  expect((await dialogueState(page)).open).toBe(false)

  // Or just go.
  await waitForLive(page)
  await openTalk(page, /Talk to Pip/)
  await untilChoices(page)
  await readDialogue(page, { pick: /Be on my way/ })
  expect(await said(page)).toHaveLength(1)
})

test('a quest step plays in full; the new stage’s lines play in full the first time', async ({ page }) => {
  await freshPlayer(page)
  await warp(page, 'village', 16, 14)
  // Mara's first talk moves the quest: always in full.
  const first = await talk(page, /Talk to Mara/)
  expect(first.slice(0, 3)).toEqual(dialogueFor('mara', 'new').lines)
  // The next stage: her new lines, in full, once.
  expect(await talk(page, /Talk to Mara/)).toEqual(dialogueFor('mara', 'accepted').lines)
  await waitForLive(page)
  await openTalk(page, /Talk to Mara/)
  await untilChoices(page)
  expect(GREETINGS.mara).toContain((await dialogueState(page)).said[0])
  await readDialogue(page, { pick: /Be on my way/ })
  // Remembered in the world: a reload (and Continue) still greets.
  await reenter(page)
  await warp(page, 'village', 16, 14)
  await waitForLive(page)
  await openTalk(page, /Talk to Mara/)
  await untilChoices(page)
  expect(GREETINGS.mara).toContain((await dialogueState(page)).said[0])
})
