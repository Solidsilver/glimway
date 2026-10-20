/**
 * Lot lanterns (roadmap 0.12; docs/design/hearthwick-2.md §6). Each lot's
 * lantern hangs on a stake of its back line. Filled with hearth oil it
 * lights and holds the backland behind the lot through the turning; a wick
 * of oil burns at each turning, then it dims for a wick, then goes dark and
 * the backland turns (pieces set out there go home). A member lights it;
 * anyone may top it up. The server judges all of it (api/lot_lanterns.go).
 */
import type { LotLanternState } from './api/types.ts'

export type LanternLook = 'dark' | 'lit' | 'dimming'

/** Dimming once its oil is gone: on its last wick, or guttering (map-lamps.ts landDimming, owner 2026-10-17). */
export function lanternLook(l: LotLanternState | null | undefined): LanternLook {
  return !l?.lit ? 'dark' : l.dimming || l.oil === 0 ? 'dimming' : 'lit'
}

/** The stake's frame for a look (the Hearthwick 2 pass: dark, lit, guttering). */
export function lanternFrame(look: LanternLook): string {
  return look === 'dark' ? 'lantern-stake-0' : look === 'dimming' ? 'lantern-stake-2' : 'lantern-stake-1'
}

/** The readout at the stake: the wicks of oil left, and what the next turning brings. */
export function lanternLines(l: LotLanternState | null | undefined, maxWicks: number, lot: string): string[] {
  const look = lanternLook(l)
  if (look === 'dark') return [`The lantern is dark. Fill it with hearth oil and the woods behind ${lot} hold still through the turning.`]
  const oil = l!.oil
  const wicks = `${oil} of ${maxWicks} ${maxWicks === 1 ? 'wick' : 'wicks'} of oil`
  if (look === 'dimming' && l!.dimming) return [`The lantern is guttering: ${wicks}. Unless it's filled, it goes dark at the turning and the woods behind ${lot} turn with it. Anything set out there goes home.`]
  if (look === 'dimming') return [`The lantern is dimming: the oil’s gone, and it’s on its last wick. Fill it to keep the woods behind ${lot}; left empty, it gutters for a wick after the turning, then goes dark.`]
  return [`The lantern burns, ${wicks} left. The woods behind ${lot} hold while it does.`]
}

/** Whether one more flask fits. */
export function lanternHasRoom(l: LotLanternState | null | undefined, maxWicks: number, wicksPerOil: number): boolean {
  return (l?.lit ? l.oil : 0) + wicksPerOil <= maxWicks
}
