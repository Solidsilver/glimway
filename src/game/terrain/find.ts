/** Dev terrain navigation; positions and destinations are world tiles. */
export const FEATURE_LABELS = {
  pass: 'Pass', crest: 'Range crest (walkable shoulder)', spire: 'Spire view',
  'outcrop-top': 'Outcrop top', 'outcrop-foot': 'Outcrop foot (below the cliff)',
  hills: 'Hills', tunnel: 'Tunnel candidate'
} as const
export type FeatureKind = keyof typeof FEATURE_LABELS
export interface TerrainFeature {
  kind: FeatureKind
  target: [number, number]
  stand: [number, number]
  level: number
  owner: [number, number]
}
export interface FeatureReply { recipe: string; owners: number; features: TerrainFeature[] }

export async function nearestFeatures(x: number, y: number, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<FeatureReply> {
  const res = await fetcher(`/api/dev/terrain/features?x=${Math.floor(x)}&y=${Math.floor(y)}`, { credentials: 'same-origin', signal })
  if (!res.ok) throw new Error(`Could not find terrain features (${res.status}).`)
  return res.json() as Promise<FeatureReply>
}

export function featureLabel(f: TerrainFeature, x: number, y: number): string {
  const dx = f.target[0] - x, dy = f.target[1] - y
  const n = Math.round(Math.hypot(dx, dy) / 24)
  const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']
  const direction = dirs[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8]
  return `${FEATURE_LABELS[f.kind]}, ${n} chunks ${direction}, level ${f.level.toFixed(1)}`
}
