import type { ChunkLandStatus, MapLamp } from '../gen/glimway/v1/wilds_pb.js'
import { MAP_LAMPS } from '../../content/map-lamps.ts'
import { gateTile } from './map-model.ts'

export function landLabel(land: ChunkLandStatus): string {
  if (land.tier === 'built') return land.dimming ? MAP_LAMPS.builtDimming : MAP_LAMPS.held
  if (land.tier === 'common') return land.visited ? MAP_LAMPS.common : MAP_LAMPS.needsVisit
  return land.tier === 'permanent' ? MAP_LAMPS.permanent : land.tier === 'still' ? MAP_LAMPS.still : MAP_LAMPS.wild
}
export function turningLabel(land: ChunkLandStatus): string {
  return ({ released: MAP_LAMPS.released, turns: MAP_LAMPS.dimming, dimming: MAP_LAMPS.dims, held: MAP_LAMPS.holds, carries: MAP_LAMPS.carries, 'paths-turn': MAP_LAMPS.pathsTurn, 'lamps-carry': MAP_LAMPS.lampsCarry, 'lamps-turn': MAP_LAMPS.lampsTurn } as Record<string, string>)[land.nextTurning] ?? ''
}

/** Straight-line distance from the Commons arch, in world tiles. */
export function distanceFromTown(x: number, y: number): number {
  const town = gateTile() ?? { tx: 0, ty: 0 }
  return Math.round(Math.hypot(x-town.tx,y-town.ty))
}

/** Newest first, with an id tie-break so equal timestamps never jump about. */
export function lampLedger(lamps: readonly MapLamp[]): { lamp: MapLamp; name: string; distance: number }[] {
  return [...lamps].sort((a,b) => b.at - a.at || a.id.localeCompare(b.id)).map((lamp) => ({
    lamp, name: lamp.name || MAP_LAMPS.names[lamp.kind] || 'Lamp',
    distance: distanceFromTown(lamp.x,lamp.y),
  }))
}

/** The Lamps layer's state-specific mark (ui.artIcons, src/ui/ArtIcon.svelte). */
export const MAP_LAMP_ICON = { lit: 'map-lamp-lit', dimming: 'map-lamp-dimming' } as const

export function mapLampMark(lamp: Pick<MapLamp, 'land'>): { art: string; dimming: boolean } {
  const dimming = lamp.land?.dimming ?? false
  return { art: dimming ? MAP_LAMP_ICON.dimming : MAP_LAMP_ICON.lit, dimming }
}
