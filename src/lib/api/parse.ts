/**
 * Response validation. The server is trusted for bookkeeping, but its JSON
 * still goes through the same validators as a save, so a malformed answer
 * can never reach the running game (and unknown fields are dropped).
 */
import { decodePlayerState } from './state-contract.ts';
import { gameStateOf, profileOf } from './predict.ts';
import { validateSave } from '../state.ts';
import { validateHabiticaProfile } from '../habitica/mapping.ts';
import { ApiError } from './errors.ts';
import type {
  PlayResponse,
  ProgressResponse,
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

// The homestead and item routes moved to the generated schema (homestead.ts,
// items.ts); their parsers are re-exported here for the one import site.
export { parseHome, parseHomeAction, parseShelf, parseShelfAction, parseWoodpileRead, parseWoodpileAction } from './homestead.ts';
export { parseItems, parseItemsAction, parseItemsResult } from './items.ts';

// The worlds (world.ts) and the village domains (village.ts) decode through
// the generated messages.
export { parseWorld, parseWorldChoice, parseWorldMove } from './world.ts';
export { parseStorage, parseStorageMove, parseCraft, parseHearthCraft, parseDeskCopy, parseMail, parseMailAction, parseCommons, parseProjects, parseContribute, parseRepairs, parseMend } from './village.ts';

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

// TODO(C2): remove the retained domain document projection with the old Link.
export function parseSnapshot(raw: unknown): Snapshot {
  const o = obj(raw);
  // The typed server state: the link adopts it, the game reads its projection.
  if (typeof o.state === 'object' && o.state !== null && 'account' in o.state) {
    try {
      const p = decodePlayerState(o.state);
      const importedProfile = profileOf(p);
      return { state: gameStateOf(p), player: p, rev: p.version, accountId: p.account!.accountId, displayName: p.account!.displayName, habiticaPartyId: p.account!.partyId ?? null, worldId: p.account!.worldId, vitalsSource: importedProfile ? 'imported' : 'demo', pending: p.embers!.pending, verifiedXp: p.embers!.verifiedXp, flagged: p.account!.flagged, ...(importedProfile ? { importedProfile } : {}) };
    } catch { throw new ApiError('bad-response'); }
  }
  let state;
  let importedProfile;
  try {
    state = validateSave(o.state);
    importedProfile = o.importedProfile == null ? undefined : validateHabiticaProfile(o.importedProfile);
  } catch {
    throw new ApiError('bad-response');
  }
  const rev = num(o.version);
  if (!Number.isInteger(rev) || rev < 0) throw new ApiError('bad-response');
  const vitalsSource = o.vitalsSource === 'imported' ? 'imported' : 'demo';
  const snapshot: Snapshot = {
    state,
    rev,
    vitalsSource,
    accountId: str(o.accountId),
    displayName: typeof o.displayName === 'string' ? o.displayName.slice(0, 128) : '',
    habiticaPartyId: typeof o.habiticaPartyId === 'string' ? o.habiticaPartyId : null,
    worldId: typeof o.worldId === 'string' ? o.worldId : '',
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

export { parseCreatedInvite, parseInviteList } from './invites.ts';

// ------------------------------------------------------------- worlds

/** A held first sign-in's question (`{ worldChoice }`), or null when the answer is something else. */
// ------------------------------------------------------------- the Wilds

const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Materials map: the four known ids, nonnegative, unknown ids dropped. */
function parseMaterials(raw: unknown): WildsMaterials {
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

function parseLoot(raw: unknown): WildsLoot {
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
  if (r.wardenSliverFound !== undefined && typeof r.wardenSliverFound !== 'boolean') throw new ApiError('bad-response');
  if (r.stormDropFound !== undefined && typeof r.stormDropFound !== 'boolean') throw new ApiError('bad-response');
  return {
    ...parseSnapshot(raw),
    result: {
      epoch: str(r.epoch),
      entity: parseEntity(r.entity),
      loot: parseLoot(r.loot),
      materials: parseMaterials(r.materials),
      ...(typeof r.wardenSliverFound === 'boolean' ? { wardenSliverFound: r.wardenSliverFound } : {}),
      ...(typeof r.stormDropFound === 'boolean' ? { stormDropFound: r.stormDropFound } : {}),
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

function int(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new ApiError('bad-response');
  return v;
}

export { parseCalendar } from './calendar.ts';