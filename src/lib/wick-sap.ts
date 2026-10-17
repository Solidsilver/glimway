/**
 * The Wick Tree's weekly sap (lamps.md 2.5). Once a calendar wick anyone
 * may tap the tree in Hearthwick for a jar of sap; the chandler refines a
 * jar into hearth oil for nothing. The server keeps the one-a-wick rule
 * (api/wick_sap.go); this is the words and the choices.
 */
import { HOMESTEAD_DATA } from './homestead.ts'
import { calendarAt } from './clock.ts'
import { itemDef } from './items.ts'

export const WICK_SAP = HOMESTEAD_DATA.wickSap

/** What the tree says as you tap it: the whole story the first time, a short line after. */
export function tapLines(first: boolean): string[] {
  if (!first) return ['You tap the Wick Tree. A jar of sap for this wick.']
  const oil = itemDef(WICK_SAP.oil)?.name.toLowerCase() ?? 'hearth oil'
  return [
    'You tap the Wick Tree and a jar fills, slow and gold.',
    `The tree gives everyone one jar of sap a wick, free. Take it to the chandler, who refines it into ${oil} for nothing: enough to keep a lot lantern burning a wick.`
  ]
}

/** Already tapped this wick: when the tree gives again, in days, never a countdown. */
export function alreadyTappedLine(now: number): string {
  now = Math.floor(now)
  const day = calendarAt(now)
  const next = calendarAt(day.nextTurning).wick
  const days = Math.max(1, Math.ceil((day.nextTurning - now) / 86_400))
  const when = days === 1 ? 'within the day' : `in ${days} days`
  return `You’ve had the tree’s sap this wick. It gives again when ${next}-wick comes in, ${when}.`
}

/** The chandler's refining choice, when you carry sap. */
export function refineChoice(sap: number): { text: string; action: string } | null {
  if (sap < 1) return null
  return { text: `Refine your sap into hearth oil · free${sap > 1 ? ` (${sap} jars)` : ''}`, action: 'sap:refine' }
}

/** The chandler's words as the oil changes hands. */
export const REFINED_LINE = 'There. Good sap, good oil. Bring me the tree’s next jar when it comes.'
