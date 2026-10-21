/**
 * The world lab's routes (dev builds only): /api/dev/worldlab/ on a dev
 * server (server/internal/worldlab/lab.go), for an account the server's
 * dev mode gives the lab. Every render runs in a worker process there;
 * edited rules travel with each request and never change the server's.
 */
import { CONTRACT_NUMBER } from '../../../lib/contract.ts'
import type { Limits, Plan } from './lab-view.ts'

const BASE = '/api/dev/worldlab/'

export interface LabState {
  seed: string
  epoch: string
  defaultEpoch: string
  overlays: string[]
  chunkSize: number
  limits: Limits
  /** The server's embedded content/wilds.json, as text. */
  rules: string
  rulesSHA256: string
  /** The caller's own world: its seed and the wick season now (null: unknown). */
  here: { seed: string; epoch: string } | null
}

export interface Stats {
  terrain?: { strategies: Record<string, { certificate: { strandedTiles: number; strandedComponents: number }; ramps: number; geometrySHA256: string }> }
  content: string
  contentSHA256: string
  view: string
  seed: string
  epoch: string
  rect: [number, number, number, number]
  chunkSize: number
  chunks: number
  generatedChunks: number
  fixedChunks: number
  landShareByChunkCentre: Record<string, number>
  groundShare?: Record<string, number>
  solidShare?: number
  campsPer100Chunks?: number
  placesPer100Chunks?: number
  longestAxialLandRunChunks: number
  unreachableWalkableTiles?: number
  generationMs: number
  note: string
}

export interface Comparison {
  a: Stats
  b: Stats
  changedUnits: number
  changedShare: number
  unit: string
  totalMs: number
}

export interface Rendered {
  png: string
  stats: Stats
  comparison?: Comparison
  width: number
  height: number
  scale: number
}

interface Marked {
  kind?: string
  id?: string
  tx: number
  ty: number
  [k: string]: unknown
}

export interface TileInfo {
  tile: [number, number]
  chunk: [number, number]
  local: [number, number]
  land: string
  chunkLand: string
  ground: string
  solid: boolean
  entitiesOnTile: Marked[]
  chunkEntities: Marked[] | null
  sitesOnTile: Marked[]
  placesOnTile: Marked[]
  fixed?: string
  /** The nearest open tile in the chunk, to arrive on. */
  stand?: [number, number]
  /** The caller's world lets a hero stand in this chunk (unknown: absent). */
  onGrid?: boolean
}

/** One version of the world: a seed and its rules (empty: the server's own). */
export interface Version {
  seed: string
  rules: string
}

export type Answer<T> = { ok: true; value: T; cached: boolean } | { ok: false; status: number; text: string }

async function ask<T>(name: string, body: unknown, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Answer<T>> {
  let res: Response
  try {
    res = await fetcher(BASE + name, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Glimway-Contract': String(CONTRACT_NUMBER) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    return { ok: false, status: 0, text: 'The server didn’t answer.' }
  }
  if (res.status === 404) return { ok: false, status: 404, text: 'This server has no world lab for you (dev mode’s world_lab is off, or not yours).' }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    parsed = undefined
  }
  if (!res.ok) {
    const text = (parsed as { error?: string } | undefined)?.error ?? `The lab said no (${res.status}).`
    return { ok: false, status: res.status, text }
  }
  return { ok: true, value: parsed as T, cached: res.headers.get('X-Worldlab-Cache') === 'hit' }
}

export function labState(fetcher?: typeof fetch): Promise<Answer<LabState>> {
  return ask<LabState>('state', undefined, undefined, fetcher)
}

/** The request for a render of version a (and b beside it, for a diff). */
export function renderBody(p: Plan, epoch: string, overlays: string[], a: Version, b: Version | null): Record<string, unknown> {
  const body: Record<string, unknown> = { view: p.view, seed: a.seed, epoch, rect: p.rect, scale: p.scale, overlays: overlays.join(',') }
  if (a.rules) body.rules = a.rules
  if (b) body.b = { seed: b.seed, ...(b.rules ? { rules: b.rules } : {}) }
  return body
}

export function labRender(body: Record<string, unknown>, signal?: AbortSignal, fetcher?: typeof fetch): Promise<Answer<Rendered>> {
  return ask<Rendered>('render', body, signal, fetcher)
}

export function labTile(v: Version, epoch: string, tx: number, ty: number, signal?: AbortSignal, fetcher?: typeof fetch): Promise<Answer<TileInfo>> {
  return ask<TileInfo>('tile', { seed: v.seed, epoch, at: [tx, ty], ...(v.rules ? { rules: v.rules } : {}) }, signal, fetcher)
}

export function labCheck(rules: string, signal?: AbortSignal, fetcher?: typeof fetch): Promise<Answer<{ ok: true }>> {
  return ask<{ ok: true }>('check', { rules }, signal, fetcher)
}
