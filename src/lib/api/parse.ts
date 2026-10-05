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
  GateInfo,
  DeedInvite,
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

// ------------------------------------------------------------ homesteads

const SCENES = ['indoor', 'outdoor'];
const ROTATIONS = [0, 90, 180, 270];

function int(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new ApiError('bad-response');
  return v;
}

function name(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 64) : '';
}

function nullableInt(v: unknown): number | null {
  return v === null || v === undefined ? null : int(v);
}

export function parseHomeView(raw: unknown): HomeView {
  const o = obj(raw);
  if (!Array.isArray(o.items) || !Array.isArray(o.members)) throw new ApiError('bad-response');
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
      name: typeof r.name === 'string' && r.name ? r.name.slice(0, 80) : null,
    };
  });
  const indoor = o.indoor === null || o.indoor === undefined ? null : { width: int(obj(o.indoor).width, 1), height: int(obj(o.indoor).height, 1) };
  const cleared = Array.isArray(o.cleared)
    ? o.cleared.map((c): [number, number] => {
        if (!Array.isArray(c) || c.length !== 2) throw new ApiError('bad-response');
        return [int(c[0]), int(c[1])];
      })
    : [];
  return {
    id: str(o.id),
    gate: int(o.gate),
    worldId: typeof o.worldId === 'string' ? o.worldId : '',
    tier: int(o.tier),
    members: o.members.map((m) => ({ id: str(obj(m).id), displayName: name(obj(m).displayName) })),
    member: o.member === true,
    desolate: o.desolate === true,
    vacantSince: nullableInt(o.vacantSince),
    landSeed: int(o.landSeed),
    cleared,
    postsBought: int(o.postsBought ?? 0),
    nextPost: materials(o.nextPost),
    indoor,
    items,
  };
}

function materials(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out[k] = n;
  return out;
}

function maybeHome(v: unknown): HomeView | null {
  return v === null || v === undefined ? null : parseHomeView(v);
}

export function parseHome(raw: unknown): HomeResponse {
  const o = obj(raw);
  return { ...parseSnapshot(raw), gate: int(o.gate), landSeed: int(o.landSeed), home: maybeHome(o.home), materials: materials(o.materials) };
}

function person(v: unknown): { id: string; name: string } {
  const o = obj(v);
  return { id: str(o.id), name: name(o.name) };
}

export function parseCommons(raw: unknown): CommonsResponse {
  const o = obj(raw);
  if (!Array.isArray(o.gates)) throw new ApiError('bad-response');
  const gates: GateInfo[] = o.gates.map((row) => {
    const r = obj(row);
    return {
      gate: int(r.gate),
      homeId: typeof r.homeId === 'string' && r.homeId ? r.homeId : null,
      names: Array.isArray(r.names) ? r.names.map(name) : [],
      members: Array.isArray(r.members) ? r.members.map((m) => ({ id: str(obj(m).id), displayName: name(obj(m).displayName) })) : [],
      tier: int(r.tier ?? 0),
      desolate: r.desolate === true,
      mine: r.mine === true,
      price: nullableInt(r.price),
    };
  });
  const mine = o.mine && typeof o.mine === 'object' ? { homeId: str(obj(o.mine).homeId), gate: int(obj(o.mine).gate) } : null;
  const invites: DeedInvite[] = (Array.isArray(o.invites) ? o.invites : []).map((row) => {
    const r = obj(row);
    return {
      homeId: str(r.homeId),
      gate: int(r.gate),
      from: person(r.from),
      to: person(r.to),
      expiresAt: num(r.expiresAt),
      fromConfirmedAt: nullableInt(r.fromConfirmedAt),
      toConfirmedAt: nullableInt(r.toConfirmedAt),
    };
  });
  return { ...parseSnapshot(raw), gates, gateCount: int(o.gateCount ?? gates.length), mine, invites };
}

export function parseHomeAction(raw: unknown): HomeActionResponse {
  const r = obj(obj(raw).result);
  return {
    ...parseSnapshot(raw),
    result: {
      home: maybeHome(r.home),
      materials: materials(r.materials),
      ...(typeof r.itemId === 'string' ? { itemId: r.itemId } : {}),
      ...(r.status === 'joined' || r.status === 'waiting' ? { status: r.status } : {}),
    },
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
  return { ...parseSnapshot(raw), home: parseHomeView(o.home), inventory: parseCounts(o.inventory), storage: parseCounts(o.storage), personal: parseCounts(o.personal) };
}

export function parseStorageMove(raw: unknown): StorageMoveResponse {
  const r = obj(obj(raw).result);
  return { ...parseSnapshot(raw), result: { home: parseHomeView(r.home), inventory: parseCounts(r.inventory), storage: parseCounts(r.storage), personal: parseCounts(r.personal) } };
}

export function parseCraft(raw: unknown): CraftResponse {
  const r = obj(obj(raw).result);
  return {
    ...parseSnapshot(raw),
    result: {
      home: parseHomeView(r.home),
      inventory: parseCounts(r.inventory),
      storage: parseCounts(r.storage),
      personal: parseCounts(r.personal),
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
