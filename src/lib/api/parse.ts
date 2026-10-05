/**
 * Response validation. The server is trusted for bookkeeping, but its JSON
 * still goes through the same validators as a save, so a malformed answer
 * can never reach the running game (and unknown fields are dropped).
 */
import { validateSave } from '../state.ts';
import { validateHabiticaProfile } from '../habitica/mapping.ts';
import { ApiError } from './errors.ts';
import type {
  Asset,
  AssetCounts,
  CalendarResponse,
  ContributeResponse,
  CraftResponse,
  Mail,
  MailActionResponse,
  MailResponse,
  ProjectView,
  ProjectsResponse,
  ProjectsView,
  StorageMoveResponse,
  StorageResponse,
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

// ------------------------------------------------------------ phase 5

const ASSET_KINDS = ['material', 'item', 'decoration'];

function countMap(v: unknown): Record<string, number> {
  return materials(v);
}

export function parseAsset(raw: unknown): Asset {
  const o = obj(raw);
  if (!ASSET_KINDS.includes(o.kind as string)) throw new ApiError('bad-response');
  return { kind: o.kind as Asset['kind'], id: str(o.id), qty: int(o.qty, 0) };
}

export function parseCounts(raw: unknown): AssetCounts {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { materials: countMap(o.materials), items: countMap(o.items), decorations: countMap(o.decorations) };
}

export function parseCalendar(raw: unknown): CalendarResponse {
  const o = obj(raw);
  return {
    wick: str(o.wick),
    wickNumber: num(o.wickNumber),
    year: num(o.year),
    day: int(o.day, 1),
    mark: str(o.mark),
    festival: typeof o.festival === 'string' ? o.festival : null,
    startsAt: num(o.startsAt),
    nextTurning: num(o.nextTurning),
    notice: typeof o.notice === 'string' ? o.notice : null,
    wickDays: int(o.wickDays, 1),
  };
}

export function parseStorage(raw: unknown): StorageResponse {
  const o = obj(raw);
  return { ...parseSnapshot(raw), home: parseHomeView(o.home), inventory: parseCounts(o.inventory), storage: parseCounts(o.storage) };
}

export function parseStorageMove(raw: unknown): StorageMoveResponse {
  const r = obj(obj(raw).result);
  return { ...parseSnapshot(raw), result: { home: parseHomeView(r.home), inventory: parseCounts(r.inventory), storage: parseCounts(r.storage) } };
}

export function parseCraft(raw: unknown): CraftResponse {
  const r = obj(obj(raw).result);
  return {
    ...parseSnapshot(raw),
    result: {
      home: parseHomeView(r.home),
      inventory: parseCounts(r.inventory),
      storage: parseCounts(r.storage),
      recipeId: str(r.recipeId),
      output: parseAsset(r.output),
      instanceIds: Array.isArray(r.instanceIds) ? r.instanceIds.filter((v): v is string => typeof v === 'string') : [],
    },
  };
}

function optTime(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseMailEntry(raw: unknown): Mail {
  const o = obj(raw);
  const m: Mail = {
    id: str(o.id),
    worldId: typeof o.worldId === 'string' ? o.worldId : '',
    fromId: str(o.fromId),
    toId: str(o.toId),
    fromName: name(o.fromName),
    toName: name(o.toName),
    asset: parseAsset(o.asset),
    sentAt: num(o.sentAt),
    claimedAt: optTime(o.claimedAt),
  };
  if ('returnedAt' in o) m.returnedAt = optTime(o.returnedAt);
  if (o.returnReason === 'recalled' || o.returnReason === 'expired' || o.returnReason === 'recipient-removed') m.returnReason = o.returnReason;
  else if ('returnReason' in o) m.returnReason = null;
  return m;
}

function mailList(v: unknown): Mail[] {
  if (!Array.isArray(v)) throw new ApiError('bad-response');
  return v.map(parseMailEntry);
}

export function parseMail(raw: unknown): MailResponse {
  const o = obj(raw);
  const out: MailResponse = { ...parseSnapshot(raw), mail: mailList(o.mail) };
  if (o.inventory) out.inventory = parseCounts(o.inventory);
  out.nextCursor = typeof o.nextCursor === 'string' ? o.nextCursor : null;
  out.nextPendingCursor = typeof o.nextPendingCursor === 'string' ? o.nextPendingCursor : null;
  return out;
}

export function parseMailAction(raw: unknown): MailActionResponse {
  const r = obj(obj(raw).result);
  return {
    ...parseSnapshot(raw),
    result: {
      mailId: typeof r.mailId === 'string' ? r.mailId : '',
      mail: Array.isArray(r.mail) ? mailList(r.mail) : [],
      inventory: parseCounts(r.inventory),
      ...(r.asset ? { asset: parseAsset(r.asset) } : {}),
    },
  };
}

function parseProject(raw: unknown): ProjectView {
  const o = obj(raw);
  if (!['open', 'in-progress', 'complete'].includes(o.stage as string)) throw new ApiError('bad-response');
  return {
    id: str(o.id),
    name: str(o.name),
    stage: o.stage as ProjectView['stage'],
    required: countMap(o.required),
    contributed: countMap(o.contributed),
    mine: countMap(o.mine),
    completedAt: optTime(o.completedAt),
    worldFlag: typeof o.worldFlag === 'string' ? o.worldFlag : null,
    grantablePapers: Array.isArray(o.grantablePapers) ? o.grantablePapers.filter((v): v is string => typeof v === 'string') : [],
  };
}

export function parseProjectsView(o: Record<string, unknown>): ProjectsView {
  if (!Array.isArray(o.projects)) throw new ApiError('bad-response');
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { projects: o.projects.map(parseProject), worldFlags: strings(o.worldFlags), grantablePapers: strings(o.grantablePapers) };
}

export function parseProjects(raw: unknown): ProjectsResponse {
  return { ...parseSnapshot(raw), ...parseProjectsView(obj(raw)) };
}

export function parseContribute(raw: unknown): ContributeResponse {
  const r = obj(obj(raw).result);
  return { ...parseSnapshot(raw), result: { ...parseProjectsView(r), projectId: str(r.projectId), materials: countMap(r.materials) } };
}
