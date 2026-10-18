/**
 * The HUD's land chip (lamps.md 1.1): the land underfoot in a word, the
 * sentence on hover or tap. And the notice when a light you keep starts
 * dimming, told once (server/internal/api/lamp_notices.go). Plain words,
 * no countdown: the turning is the only clock (lamps.md 2.5).
 */
export const LAND_CHIP = {
  held: (whose: string) => `Held · ${whose}`,
  dimming: (whose: string) => `Dimming · ${whose}`,
  /** One word each, for a phone's narrow strip (the whole line on tap). */
  short: { held: 'Held', dimming: 'Dimming', common: 'Common', turning: 'Turning' },
  common: 'Common',
  turning: 'Turning',
  whose: {
    yourCamp: 'your camp',
    camp: (keeper: string) => `${keeper}’s camp`,
    friendsCamp: 'a friend’s camp',
    yourLot: 'your lot',
    lot: 'a lot',
    land: 'lamplit',
  },
  why: {
    held: 'Lamplight holds this land: it carries across the turning as it is.',
    lastWick: 'The lamp here is on its last wick of oil. Fill it to keep this land as it is; left empty, it gutters for a wick after the turning, and then the land turns.',
    guttering: 'The lamp here is guttering. Unless someone fills it, this land turns at the next turning. Nothing set out here is lost.',
    released: 'The lamp that held this land is gone. It turns at the next turning.',
    common: 'Common land, kept by visits: its paths and lamps carry across the turning while someone walks by each wick. You being here counts.',
    turning: 'Wild land. Its trees and finds change at the next turning; the lie of the land stays.',
  },
} as const

/** Said once when a light you keep starts dimming: its last wick of oil (lamp_notices.go). */
export const LAMP_NOTICE = {
  wayLamp: (name: string) => name ? `Your way-lamp, ${name}, is dimming. A flask of oil keeps the camp lit.` : 'Your way-lamp is dimming. A flask of oil keeps the camp lit.',
  lotLantern: 'The lantern behind your lot is dimming. A flask of oil keeps the woods out back.',
} as const
