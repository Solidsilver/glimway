/**
 * Response validation. The server is trusted for bookkeeping, but its JSON
 * still goes through the same validators as a save, so a malformed answer
 * can never reach the running game (and unknown fields are dropped).
 */
import { validateSave } from '../state.ts';
import { validateHabiticaProfile } from '../habitica/mapping.ts';
import { ApiError } from './errors.ts';
import type {
  CommonsResponse,
  HomeActionResponse,
  HomeResponse,
  HomeView,
  PlotBounds,
  PlotInfo,
  CreatedInvite,
  InviteInfo,
  InviteList,
  PlayResponse,
  ProgressResponse,
  SaveOrigin,
  Snapshot,
  StateResponse,
  SpendResponse,
  SyncResponse,
} from './types.ts';

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ApiError('bad-response');
  return v as Obj;
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new ApiError('bad-response');
  return v;
}

function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError('bad-response');
  return v;
}

export function parseSnapshot(raw: unknown): Snapshot {
  const o = obj(raw);
  let state;
  let importedProfile;
  try {
    state = validateSave(o.state);
    importedProfile = o.importedProfile == null ? undefined : validateHabiticaProfile(o.importedProfile);
  } catch {
    throw new ApiError('bad-response');
  }
  const rev = num(o.rev);
  if (!Number.isInteger(rev) || rev < 0) throw new ApiError('bad-response');
  const vitalsSource = o.vitalsSource === 'imported' ? 'imported' : 'demo';
  const origin = o.saveOrigin;
  if (origin !== null && origin !== undefined && origin !== 'fresh' && origin !== 'migrated') throw new ApiError('bad-response');
  const snapshot: Snapshot = {
    state,
    rev,
    vitalsSource,
    habiticaId: str(o.habiticaId),
    displayName: typeof o.displayName === 'string' ? o.displayName.slice(0, 128) : '',
    habiticaPartyId: typeof o.habiticaPartyId === 'string' ? o.habiticaPartyId : null,
    worldId: typeof o.worldId === 'string' ? o.worldId : '',
    saveOrigin: (origin ?? null) as SaveOrigin | null,
    pending: typeof o.pending === 'number' && Number.isFinite(o.pending) ? o.pending : 0,
    verifiedXp: typeof o.verifiedXp === 'number' && Number.isFinite(o.verifiedXp) ? o.verifiedXp : 0,
    flagged: o.flagged === true,
  };
  if (importedProfile) snapshot.importedProfile = importedProfile;
  return snapshot;
}

export function parseState(raw: unknown): StateResponse {
  const lease = obj(raw).leaseActive;
  const out: StateResponse = parseSnapshot(raw);
  if (typeof lease === 'boolean') out.leaseActive = lease;
  return out;
}

export function parsePlay(raw: unknown): PlayResponse {
  return { ...parseSnapshot(raw), lease: str(obj(raw).lease) };
}

export function parseProgress(raw: unknown): ProgressResponse {
  const status = obj(raw).status;
  if (status !== 'current' && status !== 'stale') throw new ApiError('bad-response');
  return { ...parseSnapshot(raw), status };
}

export function parseSync(raw: unknown): SyncResponse {
  const o = obj(raw);
  if (o.status !== 'synced' && o.status !== 'unchanged') throw new ApiError('bad-response');
  const credit = obj(o.vitalsCredit);
  return { ...parseSnapshot(raw), status: o.status, vitalsCredit: { hp: num(credit.hp), mana: num(credit.mana) } };
}

export function parseSpend(raw: unknown): SpendResponse {
  const o = obj(raw);
  return { ...parseSnapshot(raw), outcome: typeof o.outcome === 'string' ? o.outcome : '' };
}

export function parseInvite(raw: unknown): InviteInfo {
  const o = obj(raw);
  return { id: str(o.id), createdAt: num(o.createdAt), expiresAt: num(o.expiresAt), used: o.used === true };
}

export function parseCreatedInvite(raw: unknown): CreatedInvite {
  return { ...parseInvite(raw), code: str(obj(raw).code) };
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;

export function parseInviteList(raw: unknown): InviteList {
  const o = obj(raw);
  if (!Array.isArray(o.invites)) throw new ApiError('bad-response');
  const out: InviteList = { invites: o.invites.map(parseInvite) };
  const remaining = count(o.remaining);
  const outstandingLimit = count(o.outstandingLimit);
  if (remaining !== undefined) out.remaining = remaining;
  if (outstandingLimit !== undefined) out.outstandingLimit = outstandingLimit;
  return out;
}

// ------------------------------------------------------------ homesteads

const SCENES = ['indoor', 'outdoor'];
const ROTATIONS = [0, 90, 180, 270];

function int(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new ApiError('bad-response');
  return v;
}

function bounds(v: unknown): PlotBounds | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return { x: num(o.x), y: num(o.y), width: num(o.width), height: num(o.height) };
}

function plotIndex(v: unknown): number | null {
  return v === null || v === undefined ? null : int(v);
}

function name(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 64) : '';
}

export function parseHomeView(raw: unknown): HomeView {
  const o = obj(raw);
  if (!Array.isArray(o.items)) throw new ApiError('bad-response');
  const items = o.items.map((row) => {
    const r = obj(row);
    const placed = r.scene !== null && r.scene !== undefined;
    if (placed && (!SCENES.includes(r.scene as string) || !ROTATIONS.includes(r.rotation as number))) throw new ApiError('bad-response');
    return {
      id: str(r.id),
      itemDef: str(r.itemDef),
      scene: placed ? (r.scene as 'indoor' | 'outdoor') : null,
      x: placed ? int(r.x) : null,
      y: placed ? int(r.y) : null,
      rotation: placed ? (r.rotation as 0 | 90 | 180 | 270) : null,
    };
  });
  const indoor = o.indoor === null || o.indoor === undefined ? null : { width: int(obj(o.indoor).width, 1), height: int(obj(o.indoor).height, 1) };
  return {
    ownerId: str(o.ownerId),
    displayName: name(o.displayName),
    worldId: typeof o.worldId === 'string' ? o.worldId : '',
    plotIndex: plotIndex(o.plotIndex),
    tier: int(o.tier),
    bounds: bounds(o.bounds),
    indoor,
    items,
  };
}

function materials(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out[k] = n;
  return out;
}

export function parseHome(raw: unknown): HomeResponse {
  const o = obj(raw);
  return { ...parseSnapshot(raw), home: parseHomeView(o.home), materials: materials(o.materials) };
}

export function parseCommons(raw: unknown): CommonsResponse {
  const o = obj(raw);
  if (!Array.isArray(o.plots)) throw new ApiError('bad-response');
  const plots: PlotInfo[] = o.plots.map((row) => {
    const r = obj(row);
    return { ownerId: str(r.ownerId), displayName: name(r.displayName), tier: int(r.tier), plotIndex: plotIndex(r.plotIndex), bounds: bounds(r.bounds) };
  });
  return { ...parseSnapshot(raw), plots };
}

export function parseHomeAction(raw: unknown): HomeActionResponse {
  const r = obj(obj(raw).result);
  return {
    ...parseSnapshot(raw),
    result: { home: parseHomeView(r.home), materials: materials(r.materials), ...(typeof r.itemId === 'string' ? { itemId: r.itemId } : {}) },
  };
}
