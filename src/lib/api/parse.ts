/**
 * Response validation. The server is trusted for bookkeeping, but its JSON
 * still goes through the same validators as a save, so a malformed answer
 * can never reach the running game (and unknown fields are dropped).
 */
import { validateSave } from '../state.ts';
import { validateHabiticaProfile } from '../habitica/mapping.ts';
import { ApiError } from './errors.ts';
import type {
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
  WildsClaimResponse,
  WildsDefeatResponse,
  WildsEntityState,
  WildsEntityView,
  WildsEpoch,
  WildsLanternResponse,
  WildsLanternView,
  WildsLoot,
  WildsMaterials,
  WildsRegionResponse,
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

// ------------------------------------------------------------- the Wilds

const int = (v: unknown): number => {
  const n = num(v);
  if (!Number.isInteger(n)) throw new ApiError('bad-response');
  return n;
};

const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Materials map: the four known ids, nonnegative, unknown ids dropped. */
export function parseMaterials(raw: unknown): WildsMaterials {
  const o = raw === null || raw === undefined ? {} : obj(raw);
  const out: WildsMaterials = { timber: 0, stone: 0, fiber: 0, amber: 0 };
  for (const key of Object.keys(out) as (keyof WildsMaterials)[]) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = Math.floor(v);
  }
  return out;
}

function parseEpoch(raw: unknown): WildsEpoch {
  const o = obj(raw);
  return {
    worldSeed: str(o.worldSeed),
    regionId: str(o.regionId),
    generatorVersion: int(o.generatorVersion),
    season: str(o.season),
    id: str(o.id),
    startsAt: int(o.startsAt),
    endsAt: o.endsAt === null || o.endsAt === undefined ? null : int(o.endsAt),
  };
}

const ENTITY_STATES = ['available', 'cleared', 'harvested', 'charted'];

function parseEntity(raw: unknown): WildsEntityView {
  const o = obj(raw);
  const state = str(o.state) as WildsEntityState;
  if (!ENTITY_STATES.includes(state)) throw new ApiError('bad-response');
  return {
    id: str(o.id),
    kind: str(o.kind) as WildsEntityView['kind'],
    tx: int(o.tx),
    ty: int(o.ty),
    enemies: Array.isArray(o.enemies) ? o.enemies.filter((e): e is string => typeof e === 'string') : [],
    material: typeof o.material === 'string' ? o.material : '',
    tier: int(o.tier),
    poi: typeof o.poi === 'string' ? o.poi : '',
    cycle: int(o.cycle),
    state,
    available_at: int(o.available_at),
    by: nullableStr(o.by),
    at: o.at === null || o.at === undefined ? null : int(o.at),
  };
}

export function parseLoot(raw: unknown): WildsLoot {
  const o = obj(raw);
  const materials = Array.isArray(o.materials) ? o.materials : [];
  return {
    materials: materials.map((m) => {
      const e = obj(m);
      return { id: str(e.id), qty: Math.max(0, int(e.qty)) };
    }),
    trinket: nullableStr(o.trinket),
  };
}

function parseLantern(raw: unknown): WildsLanternView {
  const o = obj(raw);
  return {
    id: str(o.id),
    ownerId: str(o.ownerId),
    displayName: typeof o.displayName === 'string' ? o.displayName : '',
    x: int(o.x),
    y: int(o.y),
    litBy: nullableStr(o.litBy),
    at: int(o.at),
    litAt: o.litAt === null || o.litAt === undefined ? null : int(o.litAt),
  };
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseWildsRegion(raw: unknown): WildsRegionResponse {
  const o = obj(raw);
  return {
    ...parseSnapshot(raw),
    epoch: parseEpoch(o.epoch),
    entities: arr(o.entities).map(parseEntity),
    personalClaims: arr(o.personalClaims).map((c) => {
      const e = obj(c);
      return { entityId: str(e.entityId), at: int(e.at) };
    }),
    discoveries: arr(o.discoveries).map((d) => {
      const e = obj(d);
      return {
        entityId: str(e.entityId),
        poiId: str(e.poiId),
        discovererId: str(e.discovererId),
        displayName: typeof e.displayName === 'string' ? e.displayName : '',
        at: int(e.at),
      };
    }),
    lanterns: arr(o.lanterns).map(parseLantern),
    materials: parseMaterials(o.materials),
  };
}

export function parseWildsClaim(raw: unknown): WildsClaimResponse {
  const o = obj(raw);
  const r = obj(o.result);
  return {
    ...parseSnapshot(raw),
    result: {
      epoch: str(r.epoch),
      entity: parseEntity(r.entity),
      loot: parseLoot(r.loot),
      materials: parseMaterials(r.materials),
    },
  };
}

export function parseWildsDefeat(raw: unknown): WildsDefeatResponse {
  const o = obj(raw);
  const r = obj(o.result);
  return {
    ...parseSnapshot(raw),
    result: { epoch: str(r.epoch), lanternId: str(r.lanternId), lanterns: arr(r.lanterns).map(parseLantern) },
  };
}

export function parseWildsLantern(raw: unknown): WildsLanternResponse {
  const o = obj(raw);
  const r = obj(o.result);
  return {
    ...parseSnapshot(raw),
    result: {
      epoch: str(r.epoch),
      rewarded: r.rewarded === true,
      loot: parseLoot(r.loot),
      materials: parseMaterials(r.materials),
      lanterns: arr(r.lanterns).map(parseLantern),
    },
  };
}
