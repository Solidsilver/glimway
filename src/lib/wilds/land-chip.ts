import type { ChunkLandStatus } from '../gen/glimway/v1/wilds_pb.js'
import type { LampNotice } from '../gen/glimway/v1/camps_pb.js'
import { LAMP_NOTICE, LAND_CHIP } from '../../content/land-chip.ts'
import { landDimming } from './map-lamps.ts'

/**
 * The land underfoot as the HUD's chip (lamps.md 1.1): held (and whose),
 * dimming, common (kept by visits), wild, or turning (released). Town and the still Tangle
 * sit outside upkeep and get no chip. Read from the near read's status of
 * the occupied chunk (store.ts), so it changes only when the chunk or its
 * status does.
 */
export type LandChipState = 'held' | 'dimming' | 'common' | 'wild' | 'turning'

export interface LandChip {
  state: LandChipState
  /** The words on the chip. */
  text: string
  /** Its one word, for a narrow strip. */
  short: string
  /** The sentence, on hover or tap and for screen readers. */
  why: string
}

type LandFields = Pick<ChunkLandStatus, 'tier' | 'dimming' | 'reserve' | 'nextTurning' | 'claimId' | 'keeper' | 'yours'>

/** Whose a Built claim is, to the reader: your camp, Ana's camp, your lot, a lot. */
export function landWhose(land: Pick<LandFields, 'claimId' | 'keeper' | 'yours'>): string {
  const kind = land.claimId.slice(0, land.claimId.indexOf(':'))
  const w = LAND_CHIP.whose
  if (kind === 'way-lamp') return land.yours ? w.yourCamp : land.keeper ? w.camp(land.keeper) : w.friendsCamp
  if (kind === 'lot-lantern') return land.yours ? w.yourLot : w.lot
  return w.land
}

export function landChip(land: LandFields | null | undefined): LandChip | null {
  if (!land) return null
  const why = LAND_CHIP.why
  const chip = (state: LandChipState, text: string, sentence: string): LandChip => ({ state, text, short: LAND_CHIP.short[state], why: sentence })
  switch (land.tier) {
    case 'built': {
      if (land.nextTurning === 'released') return chip('turning', LAND_CHIP.turning, why.released)
      const whose = landWhose(land)
      // Out of oil, on its last wick or guttering (landDimming, as the map says it).
      if (landDimming(land)) return chip('dimming', LAND_CHIP.dimming(whose), land.nextTurning === 'turns' ? why.guttering : why.lastWick)
      return chip('held', LAND_CHIP.held(whose), why.held)
    }
    case 'common':
      return chip('common', LAND_CHIP.common, why.common)
    case 'wild':
      return chip('wild', LAND_CHIP.wild, why.wild)
    default:
      return null
  }
}

/** Two chips say the same: the HUD is told only of a change. */
export function sameChip(a: LandChip | null, b: LandChip | null): boolean {
  return a === b || (!!a && !!b && a.state === b.state && a.text === b.text && a.why === b.why)
}

/** A dimming notice in words (lamp_notices.go); null for a kind this client doesn't know. */
export function lampNoticeText(n: Pick<LampNotice, 'kind' | 'name'>): string | null {
  if (n.kind === 'way-lamp') return LAMP_NOTICE.wayLamp(n.name)
  if (n.kind === 'lot-lantern') return LAMP_NOTICE.lotLantern
  return null
}
