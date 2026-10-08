import { expect, test, type Page } from './fixtures'
import { residentsOut } from './room-helpers'
import { dialogueState, readDialogue, warp, waitForLive, expectToast } from './helpers'
import { freshPlayer, shot } from './home-helpers'
import { reenter, seedStory, serverState } from './connected'

/**
 * The residents (src/content/residents.ts): Hazel in the square, Finn by the
 * pond, Ada under her window, Elara at her camp by the Commons' Wilds arch.
 * Meeting each one introduces them and writes their journal entry; Elara's
 * line about the day follows the calendar (the dev clock). Screens go to
 * .agent/screens/ with SCREENS=1 (desktop and phone).
 */

const EPOCH = Date.parse('2026-01-05T00:00:00Z') / 1000
const DAY = 86400

type Area = Parameters<typeof warp>[1]

const RESIDENTS = [
  { id: 'hazel', name: 'Hazel', full: 'Hazel Penhallow', area: 'village', stand: [11, 15], intro: /Hazel Penhallow/ },
  { id: 'finn', name: 'Finn', full: 'Finn Tolley', area: 'village', stand: [31, 23], intro: /Finn Tolley, the miller/ },
  { id: 'ada', name: 'Ada', full: 'Ada Cooley', area: 'village', stand: [34, 8], intro: /Ada Cooley\./ },
  { id: 'elara', name: 'Elara', full: 'Elara Quill', area: 'commons', stand: [25, 5], intro: /Elara Quill: forager/ }
] as const

/** Set Hearthwick's clock (dev hook) and wait for the village to read it (at :57, when Hazel and Finn are out). */
async function setDay(page: Page, wick: number, day: number): Promise<void> {
  await page.evaluate((t) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(t), EPOCH + (wick * 7 + day - 1) * DAY + 3600 + 57 * 60)
  await page.waitForFunction(
    ([w, d]) => {
      const v = (window as unknown as { __fsVillage?: () => { calendar: { wickNumber: number; day: number } } }).__fsVillage?.()
      return !!v && (v.calendar.wickNumber - 1) % 12 === w && v.calendar.day === d
    },
    [wick, day] as const
  )
}

/**
 * Open the conversation at the prompt and read every line through, returning
 * them. `snap` takes the in-dialogue screens on the first line.
 */
async function converse(page: Page, name: string, snap?: string, opts: { bust?: boolean; toast?: string } = {}): Promise<string[]> {
  await expect(page.locator('.prompt')).toContainText(`Talk to ${name}`)
  await waitForLive(page)
  await page.keyboard.press('e')
  const dialogue = page.getByRole('dialog', { name: `Conversation with ${name}` })
  await expect(dialogue).toBeVisible()
  // The delivered 64-px dialogue bust (Commons pass).
  if (opts.bust) await expect(dialogue.locator('.portrait.bust img')).toBeVisible()
  // A first meeting notes them in the journal (the toast lasts a few seconds).
  if (opts.toast) await expectToast(page, opts.toast)
  if (snap && process.env.SCREENS) {
    // The first line, typed out.
    await page.waitForFunction(() => !(window as unknown as { __fsDialogue: () => { typing: boolean } }).__fsDialogue().typing)
    await shot(page, snap)
  }
  await readDialogue(page)
  const lines = (await dialogueState(page)).said.map((l) => l.trim())
  await expect(dialogue).toBeHidden()
  return lines
}

test('meeting each resident: an introduction, their portrait, and a journal entry', async ({ page }) => {
  test.setTimeout(180_000)
  await freshPlayer(page)
  // The hour Hazel is in the square and Finn at his door.
  await residentsOut(page)
  for (const r of RESIDENTS) {
    await warp(page, r.area as Area, r.stand[0], r.stand[1])
    // Let a new area's title card clear before the screen.
    if (process.env.SCREENS) await page.waitForTimeout(r.area === 'commons' ? 4000 : 600)
    await shot(page, `resident-${r.id}-in-place-desktop`)
    const lines = await converse(page, r.name, `resident-${r.id}-dialogue-desktop`, { bust: true, toast: `${r.full}: noted in your journal.` })
    expect(lines.join(' ')).toMatch(r.intro)
    await expect.poll(async () => (await serverState(page)).body.state.flags, { timeout: 10_000 }).toContain(`met:${r.id}@new`)
    // The second time: not the introduction again, but the stage line (and the day).
    const again = await converse(page, r.name)
    expect(again.join(' ')).not.toMatch(r.intro)
    expect(again.length).toBeGreaterThan(0)
  }
  // All four are in the journal's notes.
  await page.keyboard.press('j')
  const journal = page.getByRole('dialog', { name: 'Journal' })
  await expect(journal).toBeVisible()
  for (const r of RESIDENTS) await expect(journal.locator('article h4', { hasText: r.full })).toBeVisible()
  await shot(page, 'resident-journal-desktop')
  await journal.locator('article').last().scrollIntoViewIfNeeded()
  await shot(page, 'resident-journal-notes-desktop')
  await page.keyboard.press('Escape')
})

test('Elara’s line follows the calendar: the wick, the Mark, and the day before a Turning', async ({ page }) => {
  test.setTimeout(120_000)
  await freshPlayer(page)
  // The last day of Amber-wick: she has posted the Turning for tomorrow.
  await setDay(page, 8, 7)
  await warp(page, 'commons', 25, 5)
  const first = await converse(page, 'Elara')
  expect(first.join(' ')).toMatch(/Elara Quill: forager/)
  expect(first.at(-1)).toMatch(/^Dark of Amber-wick tomorrow: the outer Wilds turn\. I’ve posted it\./)
  // An ordinary day of Sap-wick: the wick by name, and the Mark.
  await setDay(page, 7, 2)
  await expect(page.locator('.prompt')).toContainText('Talk to Elara')
  const later = await converse(page, 'Elara', 'resident-elara-calendar-desktop')
  expect(later[0]).toMatch(/^You’ve only just come up the Low Road/)
  expect(later.at(-1)).toMatch(/^Sap-wick, Amberfall/)
  // A festival outranks the notice: Closure Night is the Quiet's last day.
  await setDay(page, 11, 7)
  const closure = await converse(page, 'Elara')
  expect(closure.at(-1)).toMatch(/road left dark on purpose/)
})

test('once the road is lit, Hazel hands over her own recipe card', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page)
  // Set to Rise done too: while its ask is open, Hazel's talk is the ask, not her road lines.
  await seedStory(id, { quest: 'complete', quests: { 'set-to-rise': 'let-it-rise' }, marks: ['met:hazel@new'] })
  await reenter(page)
  await residentsOut(page)
  await warp(page, 'village', 11, 15)
  const lines = await converse(page, 'Hazel', 'resident-hazel-late-desktop')
  expect(lines.join(' ')).toMatch(/My brother Joss was a runner/)
  expect(lines.join(' ')).toMatch(/Take the card off my wall/)
  await expect.poll(async () => (await serverState(page)).body.state.flags, { timeout: 10_000 }).toContain('paper:keepers-twists-recipe-card')
  // Pip no longer has it to give.
  await warp(page, 'village', 28, 16)
  const pip = await converse(page, 'Pip')
  expect(pip.join(' ')).not.toMatch(/card off the bakery wall/)
})
