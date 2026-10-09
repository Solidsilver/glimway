/**
 * The village domains — the Hearthwick Library, mail, the Workshop's storage
 * and crafting, the Commons, projects and repairs — decoded through the
 * generated messages (village_pb.ts). Reads answer `{ state, result }`
 * (flattened by mixedRead); keyed answers carry their result in the
 * Envelope's oneof case. The projected types keep the JSON-shaped views the
 * game reads; the goods views themselves (Asset, counts, instances, the
 * home and workshop views) stay in types.ts until the homestead and items
 * lanes land theirs.
 */
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import {
  LibraryDonateResultSchema,
  MailReadResultSchema, MailSendResultSchema, MailActionResultSchema, MailRecallResultSchema, type MailView as GeneratedMailView,
  WorkshopViewSchema, CraftResultSchema, HearthCraftResultSchema, DeskCopyResultSchema,
  type WorkshopView as GeneratedWorkshopView,
  CommonsResultSchema, type GateView as GeneratedGateView,
  ProjectsResultSchema, ContributeResultSchema, type ProjectView as GeneratedProjectView,
  RepairsResultSchema, MendResultSchema, type ChoreView as GeneratedChoreView, type RepairsResult as GeneratedRepairsResult,
} from '../gen/glimway/v1/village_pb.js';
import {
  type Asset as GeneratedAsset, type AssetCounts as GeneratedAssetCounts,
  type HomeView as GeneratedHomeView,
} from '../gen/glimway/v1/goods_pb.js';
import { ApiError } from './errors.ts';
import { projectHome, type HomeMember, type HomeView } from './homestead.ts';
import { projectAsset, projectCounts, projectItemsView } from './items.ts';
import type { Asset, AssetCounts, Snapshot } from './types.ts';
import { parseSnapshot } from './parse.ts';

type Json = Record<string, unknown>;

/**
 * The workshop: your pack, your own chest (always reachable: it goes with
 * you), and, with a Workshop home, that home and its shared chest. Without
 * one, home and storage are null and `shared` says why.
 */
export interface WorkshopView {
  home: HomeView | null;
  inventory: AssetCounts;
  storage: AssetCounts | null;
  personal: AssetCounts;
  shared: 'open' | 'not-a-member' | 'tier-required' | string;
}

function obj(raw: unknown): Json {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('bad-response');
  return raw as Json;
}

function decode<T>(read: () => T): T {
  try { return read(); } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('bad-response');
  }
}

/** The keyed answer's result, carried under the Envelope's case name (protojson). */
function envelopeResult(raw: unknown, caseName: string): unknown {
  const value = obj(raw)[caseName];
  if (value === undefined || value === null) throw new Error(`missing ${caseName} result`);
  return value;
}

// ------------------------------------------------------------- goods views

// The goods views (Asset, counts, instances) are the items lane's
// projectors, shared now that the messages live in goods.proto; the home is
// the homestead lane's.
function asset(raw: GeneratedAsset | undefined): Asset {
  const out = projectAsset(raw);
  if (!out) throw new Error('missing asset');
  return out;
}

function home(raw: GeneratedHomeView | undefined): HomeView | null {
  return raw ? projectHome(raw) : null;
}

function workshop(raw: GeneratedWorkshopView | undefined): WorkshopView {
  if (!raw) throw new Error('missing workshop view');
  return workshopFields(raw);
}

/** The craft answers repeat the workshop view's fields (village.proto). */
function workshopFields(out: Partial<Pick<GeneratedWorkshopView, 'home' | 'inventory' | 'storage' | 'personal' | 'shared'>>): WorkshopView {
  const shared = out.shared;
  return {
    home: home(out.home),
    inventory: projectCounts(out.inventory),
    storage: out.storage ? projectCounts(out.storage) : null,
    personal: projectCounts(out.personal),
    // An older server without `shared` says why like its answers did.
    shared: shared || (out.home ? 'open' : 'not-a-member'),
  };
}

// ------------------------------------------------------------- the library

type LibraryShelfEntry = { paperId: string; donatedBy: string | null; donatedAt: string | null };

/** POST /api/library/donate: the paper just shelved, beside the snapshot. */
export function parseLibraryDonate(raw: unknown): Snapshot & { result: { entry: LibraryShelfEntry } } {
  return decode(() => {
    const out = fromJson(LibraryDonateResultSchema, envelopeResult(raw, 'libraryDonate') as JsonValue, { ignoreUnknownFields: true });
    if (!out.entry) throw new Error('missing shelf entry');
    // Empty names and dates read as null, as the read's rows always have.
    const entry: LibraryShelfEntry = { paperId: out.entry.paperId, donatedBy: out.entry.donatedBy || null, donatedAt: out.entry.donatedAt || null };
    return { ...parseSnapshot(raw), result: { entry } };
  });
}

// ------------------------------------------------------------- mail

function mailView(m: GeneratedMailView) {
  const reason = m.returnReason;
  const out = {
    id: m.id,
    worldId: m.worldId,
    fromId: m.fromId,
    toId: m.toId,
    fromName: m.fromName,
    toName: m.toName,
    asset: asset(m.asset),
    sentAt: m.sentAt,
    claimedAt: m.claimedAt ?? null,
    returnedAt: m.returnedAt ?? null,
    returnReason: reason === 'recalled' || reason === 'expired' || reason === 'recipient-removed' ? reason : null,
  } as Mail;
  return out;
}

function mailList(mail: readonly GeneratedMailView[]): Mail[] {
  return mail.map(mailView);
}

export type Mail = {
  id: string;
  worldId: string;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  asset: Asset;
  sentAt: number;
  claimedAt: number | null;
  /** Set when it went back to the sender (recall, 30-day return, recipient removed). */
  returnedAt?: number | null;
  returnReason?: 'recalled' | 'expired' | 'recipient-removed' | null;
};

export type MailResponse = Snapshot & {
  mail: Mail[];
  /** History continues at `?cursor=` (opaque); pending mail repeats on every page. */
  nextCursor?: string | null;
  /** Only for legacy pending backlogs past the current caps: `?pendingCursor=`. */
  nextPendingCursor?: string | null;
  /** What the caller carries, so a sender without a Workshop knows what they can send. */
  inventory?: AssetCounts;
};

export type MailActionResponse = Snapshot & {
  result: {
    mailId: string;
    mail: Mail[];
    inventory: AssetCounts;
    /** Claim and recall only: the parcel just moved. */
    asset?: Asset;
  };
};

/** POST /api/mail, /api/mail/:id/claim, /api/mail/:id/recall: each answer's
 * own result message (the Envelope's cases resolve by type name), one
 * projection. Claim and recall also carry the parcel just moved. */
function mailAnswer(raw: unknown, result: { mailId: string; mail: GeneratedMailView[]; nextCursor?: string; nextPendingCursor?: string; inventory?: GeneratedAssetCounts; asset?: GeneratedAsset }): MailActionResponse {
  return {
    ...parseSnapshot(raw),
    result: {
      mailId: result.mailId,
      mail: mailList(result.mail),
      inventory: projectCounts(result.inventory),
      ...(result.asset && result.asset.id ? { asset: asset(result.asset) } : {}),
    },
  };
}

export function parseMail(raw: unknown): MailResponse {
  return decode(() => {
    const out = fromJson(MailReadResultSchema, obj(raw) as JsonValue, { ignoreUnknownFields: true });
    return {
      ...parseSnapshot(raw),
      mail: mailList(out.mail),
      nextCursor: out.nextCursor ?? null,
      nextPendingCursor: out.nextPendingCursor ?? null,
      inventory: projectCounts(out.inventory),
    };
  });
}

export function parseMailSend(raw: unknown): MailActionResponse {
  return decode(() => mailAnswer(raw, fromJson(MailSendResultSchema, envelopeResult(raw, 'mailSend') as JsonValue, { ignoreUnknownFields: true })));
}

export function parseMailClaim(raw: unknown): MailActionResponse {
  return decode(() => mailAnswer(raw, fromJson(MailActionResultSchema, envelopeResult(raw, 'mailClaim') as JsonValue, { ignoreUnknownFields: true })));
}

export function parseMailRecall(raw: unknown): MailActionResponse {
  return decode(() => mailAnswer(raw, fromJson(MailRecallResultSchema, envelopeResult(raw, 'mailRecall') as JsonValue, { ignoreUnknownFields: true })));
}

// ------------------------------------------------------------- storage and crafting

/** Which chest at home: the shared one, or the caller's own small one. */
export type ChestId = 'shared' | 'personal';

export type StorageResponse = Snapshot & WorkshopView;

export type StorageMoveResponse = Snapshot & { result: WorkshopView };

export type CraftResponse = Snapshot & {
  result: WorkshopView & { recipeId: string; output: Asset; instanceIds: string[] };
};

/** Made at the cottage hearth (food, remedies, oils): the workshop view plus what the batch made. */
export type HearthCraftResponse = Snapshot & {
  result: WorkshopView & { recipeId: string; output: Asset };
};

/** A recipe page copied at the writing desk: the workshop view plus the copies. */
export type DeskCopyResponse = Snapshot & {
  result: WorkshopView & { pageId: string; qty: number };
};

export function parseStorage(raw: unknown): StorageResponse {
  return decode(() => {
    const v = fromJson(WorkshopViewSchema, obj(raw) as JsonValue, { ignoreUnknownFields: true });
    return { ...parseSnapshot(raw), ...workshop(v) };
  });
}

export function parseStorageMove(raw: unknown): StorageMoveResponse {
  return decode(() => ({ ...parseSnapshot(raw), result: workshop(fromJson(WorkshopViewSchema, envelopeResult(raw, 'storageMove') as JsonValue, { ignoreUnknownFields: true })) }));
}

export function parseCraft(raw: unknown): CraftResponse {
  return decode(() => {
    const out = fromJson(CraftResultSchema, envelopeResult(raw, 'craft') as JsonValue, { ignoreUnknownFields: true });
    return { ...parseSnapshot(raw), result: { ...workshopFields(out), recipeId: out.recipeId, output: asset(out.output), instanceIds: [...out.instanceIds] } };
  });
}

export function parseHearthCraft(raw: unknown): HearthCraftResponse {
  return decode(() => {
    const out = fromJson(HearthCraftResultSchema, envelopeResult(raw, 'hearthCraft') as JsonValue, { ignoreUnknownFields: true });
    return { ...parseSnapshot(raw), result: { ...workshopFields(out), recipeId: out.recipeId, output: asset(out.output) } };
  });
}

export function parseDeskCopy(raw: unknown): DeskCopyResponse {
  return decode(() => {
    const out = fromJson(DeskCopyResultSchema, envelopeResult(raw, 'deskCopy') as JsonValue, { ignoreUnknownFields: true });
    return { ...parseSnapshot(raw), result: { ...workshopFields(out), pageId: out.pageId, qty: out.qty } };
  });
}

// ------------------------------------------------------------- the Commons

/** One gate on the Commons lane. */
export type GateInfo = {
  gate: number;
  homeId: string | null;
  names: string[];
  members: HomeMember[];
  tier: number;
  desolate: boolean;
  mine: boolean;
  /** Unclaimed: what the deed costs the caller in embers. */
  price: number | null;
  /** The caller was on this empty home's deed and can take it back, free, until the deed is lost. */
  reclaim: boolean;
  shelf?: boolean;
  shelfStocked?: boolean;
};

/** A joint-deed invitation the caller is part of. */
export type DeedInvite = {
  homeId: string;
  gate: number;
  from: { id: string; name: string };
  to: { id: string; name: string };
  expiresAt: number;
  fromConfirmedAt: number | null;
  toConfirmedAt: number | null;
};

export type CommonsResponse = Snapshot & {
  gates: GateInfo[];
  gateCount: number;
  mine: { homeId: string; gate: number } | null;
  invites: DeedInvite[];
};

function gateInfo(g: GeneratedGateView): GateInfo {
  return {
    gate: g.gate,
    homeId: g.homeId ?? null,
    names: [...g.names],
    members: g.members.map((m): HomeMember => ({ id: m.id, displayName: m.displayName })),
    tier: g.tier,
    desolate: g.desolate,
    mine: g.mine,
    price: g.price ?? null,
    reclaim: g.reclaim,
    shelf: g.shelf,
    shelfStocked: g.shelfStocked,
  };
}

export function parseCommons(raw: unknown): CommonsResponse {
  return decode(() => {
    const out = fromJson(CommonsResultSchema, obj(raw) as JsonValue, { ignoreUnknownFields: true });
    return {
      ...parseSnapshot(raw),
      gates: out.gates.map(gateInfo),
      gateCount: out.gateCount,
      mine: out.mine ? { homeId: out.mine.homeId, gate: out.mine.gate } : null,
      invites: out.invites.map((i) => ({
        homeId: i.homeId,
        gate: i.gate,
        from: { id: i.from?.id ?? '', name: i.from?.name ?? '' },
        to: { id: i.to?.id ?? '', name: i.to?.name ?? '' },
        expiresAt: i.expiresAt,
        fromConfirmedAt: i.fromConfirmedAt ?? null,
        toConfirmedAt: i.toConfirmedAt ?? null,
      })),
    };
  });
}

// ------------------------------------------------------------- projects

export type ProjectView = {
  id: string;
  name: string;
  stage: 'open' | 'in-progress' | 'complete';
  required: Record<string, number>;
  contributed: Record<string, number>;
  /** Mine is the caller's own running contribution per material. */
  mine: Record<string, number>;
  completedAt: number | null;
  worldFlag: string | null;
  grantablePapers: string[];
};

export type ProjectsView = {
  projects: ProjectView[];
  worldFlags: string[];
  grantablePapers: string[];
};

export type ProjectsResponse = Snapshot & ProjectsView;

export type ContributeResponse = Snapshot & {
  result: ProjectsView & { projectId: string; materials: Record<string, number> };
};

function projectView(p: GeneratedProjectView): ProjectView {
  return {
    id: p.id,
    name: p.name,
    stage: p.stage as ProjectView['stage'],
    required: { ...p.required },
    contributed: { ...p.contributed },
    mine: { ...p.mine },
    completedAt: p.completedAt ?? null,
    worldFlag: p.worldFlag ?? null,
    grantablePapers: [...p.grantablePapers],
  };
}

function projectsFields(out: { projects: readonly GeneratedProjectView[]; worldFlags: readonly string[]; grantablePapers: readonly string[] }): ProjectsView {
  return { projects: out.projects.map(projectView), worldFlags: [...out.worldFlags], grantablePapers: [...out.grantablePapers] };
}

export function parseProjects(raw: unknown): ProjectsResponse {
  return decode(() => ({ ...parseSnapshot(raw), ...projectsFields(fromJson(ProjectsResultSchema, obj(raw) as JsonValue, { ignoreUnknownFields: true })) }));
}

export function parseContribute(raw: unknown): ContributeResponse {
  return decode(() => {
    const out = fromJson(ContributeResultSchema, envelopeResult(raw, 'contribute') as JsonValue, { ignoreUnknownFields: true });
    return { ...parseSnapshot(raw), result: { ...projectsFields(out), projectId: out.projectId, materials: { ...out.materials } } };
  });
}

// ------------------------------------------------------------- repairs

/** One open chore: what broke, where, and what mends it. */
export type ChoreView = {
  id: string;
  name: string;
  part: string;
  area: string;
  target: string;
  pos: { tx: number; ty: number };
  resident: string;
  hint: string;
  description: string;
};

export type MendedView = {
  repairId: string;
  mendedBy: string;
  displayName: string;
  mendedAt: number;
};

export type ChoreHistoryView = {
  id: string;
  repairId: string;
  repairName: string;
  mendedBy: string;
  displayName: string;
  mendedAt: number;
};

export type RepairsView = {
  open: ChoreView[];
  mended: MendedView[];
  worldFlags: string[];
  history: ChoreHistoryView[];
};

export type RepairsResponse = Snapshot & RepairsView;

export type MendResult = {
  repairs: RepairsView;
  mended: string;
  reaction: string;
  gift?: { kind: string; id: string; qty: number };
  items: import('./types.ts').ItemsView;
};

export type MendResponse = Snapshot & { result: MendResult };

function chore(c: GeneratedChoreView): ChoreView {
  return { id: c.id, name: c.name, part: c.part, area: c.area, target: c.target, pos: { tx: c.pos?.tx ?? 0, ty: c.pos?.ty ?? 0 }, resident: c.resident, hint: c.hint, description: c.description };
}

function repairsFields(out: GeneratedRepairsResult): RepairsView {
  return {
    open: out.open.map(chore),
    mended: out.mended.map((m) => ({ repairId: m.repairId, mendedBy: m.mendedBy, displayName: m.displayName, mendedAt: m.mendedAt })),
    worldFlags: [...out.worldFlags],
    history: out.history.map((h) => ({ id: h.id, repairId: h.repairId, repairName: h.repairName, mendedBy: h.mendedBy, displayName: h.displayName, mendedAt: h.mendedAt })),
  };
}

export function parseRepairs(raw: unknown): RepairsResponse {
  return decode(() => ({ ...parseSnapshot(raw), ...repairsFields(fromJson(RepairsResultSchema, obj(raw) as JsonValue, { ignoreUnknownFields: true })) }));
}

export function parseMend(raw: unknown): MendResponse {
  return decode(() => {
    const out = fromJson(MendResultSchema, envelopeResult(raw, 'mend') as JsonValue, { ignoreUnknownFields: true });
    if (!out.repairs || !out.items) throw new Error('missing mend view');
    const result: MendResult = { repairs: repairsFields(out.repairs), mended: out.mended, reaction: out.reaction, items: projectItemsView(out.items) };
    if (out.gift) result.gift = { kind: out.gift.kind, id: out.gift.id, qty: out.gift.qty };
    return { ...parseSnapshot(raw), result };
  });
}
