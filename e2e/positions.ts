import hearthwickLayout from '../content/layouts/hearthwick.json' with { type: 'json' }
import { ROOMS } from '../src/lib/rooms.ts'
import { PLACES } from '../src/lib/places.ts'
import { anchor as libAnchor } from '../src/lib/location.ts'
import { PAPERS } from '../src/content/papers.ts'

export interface TilePoint {
  area: string
  tx: number
  ty: number
}

export interface ContentObject {
  id: string
  area: string
  tx: number
  ty: number
  tw: number
  th: number
  label?: string
}

export interface ContentExit extends ContentObject {
  to: string
  entry: { tx: number; ty: number }
}

const hearthwickOrigin = PLACES.fixed.find((f) => f.id === 'hearthwick')?.origin ?? { tx: -24, ty: 24 }

/** An anchor ("hearthwick:arch", "hearthwick:east-road") as a world TilePoint. */
export function anchorPoint(id: string): TilePoint {
  const a = libAnchor(id)
  if (!a) throw new Error(`unknown anchor ${id}`)
  return { area: a.space, tx: Math.floor(a.x / 16), ty: Math.floor(a.y / 16) }
}

/** Resident's post authored in Hearthwick content, in world tiles. */
export function postOf(npc: string): TilePoint {
  const norm = npc.toLowerCase().replace(/^npc:/, '')
  const obj = hearthwickLayout.objects.find(
    (o) => o.kind === 'npc-post' && o.id === `npc:${norm}`
  )
  if (!obj) throw new Error(`no content post for npc ${npc} in Hearthwick layout`)
  return { area: 'outdoors', tx: obj.tx + hearthwickOrigin.tx, ty: obj.ty + hearthwickOrigin.ty }
}

/**
 * A collision-free stand tile beside a resident's post that safely triggers their
 * talk prompt without competing against higher-ranked props (e.g. the village bench).
 */
export function talkSpotOf(npc: string): TilePoint {
  const p = postOf(npc)
  const norm = npc.toLowerCase().replace(/^npc:/, '')
  // Hazel stands at (9, 63); south is (9, 64) which is the patched bench, so north at (9, 62) avoids the bench.
  if (norm === 'hazel') return { area: 'outdoors', tx: p.tx, ty: p.ty - 1 }
  // All other residents have open ground one tile south of their post.
  return { area: 'outdoors', tx: p.tx, ty: p.ty + 1 }
}

/** An authored object in Hearthwick content, in world tiles. */
export function objectOf(id: string): ContentObject {
  const aliases: Record<string, string> = {
    signpost: 'trail-sign',
    bench: 'patched-bench',
    board: 'town-board',
    well: 'town-well',
    'pond-ice': 'gather:pond-ice:0',
    flowers: 'garden:planter-west',
  }
  const targetId = aliases[id] ?? id
  const obj = hearthwickLayout.objects.find(
    (o) => o.id === targetId || o.id === id
  )
  if (!obj) throw new Error(`no content object matching ${id} in Hearthwick layout`)
  return {
    id: obj.id,
    area: 'outdoors',
    tx: obj.tx + hearthwickOrigin.tx,
    ty: obj.ty + hearthwickOrigin.ty,
    tw: 'tw' in obj && typeof obj.tw === 'number' ? obj.tw : 1,
    th: 'th' in obj && typeof obj.th === 'number' ? obj.th : 1,
    ...('label' in obj && typeof obj.label === 'string' ? { label: obj.label } : {}),
  }
}

/**
 * A reachable stand tile beside an authored object to interact with it.
 */
export function standOf(id: string): TilePoint {
  const o = objectOf(id)
  switch (o.id) {
    case 'patched-bench':
      // Stand south of the bench, facing up into it.
      return { area: 'outdoors', tx: o.tx, ty: o.ty + 1 }
    case 'trail-sign':
      // Stand south of the signpost, facing up.
      return { area: 'outdoors', tx: o.tx, ty: o.ty + 1 }
    case 'town-board':
      // Stand south of the notice board.
      return { area: 'outdoors', tx: o.tx, ty: o.ty + 1 }
    case 'town-well':
      // Stand south-east of the well body.
      return { area: 'outdoors', tx: o.tx + 1, ty: o.ty + 1 }
    case 'garden:planter-west':
    case 'garden:planter-east':
      // Stand south of the flower planter in the garden.
      return { area: 'outdoors', tx: o.tx, ty: o.ty + 1 }
    case 'gather:pond-ice:0':
    case 'gather:pond-ice:1':
    case 'gather:pond-ice:2':
      // Stand on the grass bank north of the pond ice.
      return { area: 'outdoors', tx: o.tx, ty: o.ty - 1 }
    case 'hearth':
      // Stand west of the village hearth stone.
      return { area: 'outdoors', tx: o.tx - 1, ty: o.ty }
    default:
      return { area: 'outdoors', tx: o.tx, ty: o.ty + o.th }
  }
}

/** An exit defined in Hearthwick content, in world tile coordinates. */
export function exitOf(to: string): ContentExit {
  const obj = hearthwickLayout.objects.find(
    (o) => o.kind === 'exit' && 'exit' in o && (o.exit?.to === to || o.id === `exit:${to}`)
  )
  if (!obj || !('exit' in obj) || !obj.exit) throw new Error(`no content exit to ${to} in Hearthwick layout`)
  return {
    id: obj.id,
    to: obj.exit.to,
    area: 'outdoors',
    tx: obj.tx + hearthwickOrigin.tx,
    ty: obj.ty + hearthwickOrigin.ty,
    tw: 'tw' in obj && typeof obj.tw === 'number' ? obj.tw : 1,
    th: 'th' in obj && typeof obj.th === 'number' ? obj.th : 1,
    entry: { tx: obj.exit.entryTx, ty: obj.exit.entryTy },
    ...('label' in obj && typeof obj.label === 'string' ? { label: obj.label } : {}),
  }
}

/** The placed position of a collectible paper from content. */
export function paperOf(id: string): TilePoint {
  const p = PAPERS.find((x) => x.id === id)
  if (!p || p.source.kind !== 'placed') throw new Error(`no placed paper matching ${id}`)
  return { area: p.source.area, tx: p.source.tx, ty: p.source.ty }
}

/** The stone warden's post in the Ruin area. */
export function wardenPost(): TilePoint {
  return { area: 'ruin', tx: 18, ty: 14 }
}

/** Front door or entry for a room from rooms.json. */
export function doorOf(roomOrAlias: string, side: 'outside' | 'entry' = 'entry'): TilePoint {
  const norm = roomOrAlias.toLowerCase()
  const room = ROOMS.rooms.find(
    (r) => r.id === norm || r.id === `in:village:${norm}` || r.id === `in:commons:${norm}` || r.id.endsWith(`:${norm}`)
  )
  if (!room || !room.doors?.[0]) throw new Error(`no room door matching ${roomOrAlias} in rooms.json`)
  const d = room.doors[0]
  const pt = side === 'outside' ? d.outside : d.entry
  if (!pt) throw new Error(`door ${d.id} has no ${side} point`)
  return { area: 'outdoors', tx: pt.tx, ty: pt.ty }
}

/** An authored spot inside a room. */
export function roomSpot(roomOrAlias: string, spot: string): TilePoint {
  const norm = roomOrAlias.toLowerCase()
  const room = ROOMS.rooms.find(
    (r) => r.id === norm || r.id === `in:village:${norm}` || r.id === `in:commons:${norm}` || r.id.endsWith(`:${norm}`)
  )
  const s = room?.spots?.[spot]
  if (!room || !s || s.tx === undefined || s.ty === undefined) throw new Error(`no spot ${spot} in room ${roomOrAlias}`)
  return { area: room.id, tx: s.tx, ty: s.ty }
}
