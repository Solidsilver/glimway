/**
 * The keyed domain requests, built from the generated ones (the "One
 * schema" brief): the game's action unions — what a caller means — become
 * their generated request messages and are serialized through the
 * generated schemas once, here, the way `operations.ts` builds the typed
 * operations. The hand-written request shapes are gone: a schema change
 * that outdates a request no longer compiles.
 *
 * Replays go through the same schemas (`dispatchMutation` reads a frozen
 * body back into the message before the raw transport serializes it).
 */
import { create, toJson, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { OpHeaderSchema, WhereSchema } from '../gen/glimway/v1/op_pb.js';
import { HomesteadRequestSchema, ShelfRequestSchema } from '../gen/glimway/v1/homestead_pb.js';
import { ItemsRequestSchema, type ItemsRequest } from '../gen/glimway/v1/items_pb.js';
import { ContributeRequestSchema, CraftRequestSchema, DeskCopyRequestSchema, HearthCraftRequestSchema, MailKeyedRequestSchema, MailSendRequestSchema, StorageMoveRequestSchema } from '../gen/glimway/v1/village_pb.js';
import type { WhereJson } from './predict.ts';
import type { HomeAction } from './homestead.ts';
import type { Asset, ChestId } from './types.ts';

/** The header and place every keyed domain request carries (link.mutate fills them). */
export interface Keyed {
  lease: string;
  key: string;
  where: WhereJson;
}

/** A domain's op-specific fields, typed by the generated request (op and where aside). */
type Fields<M> = Omit<M, '$typeName' | '$unknown' | 'op' | 'where'>;

/**
 * The game-side action unions (the call sites keep their own words).
 * `direction` and `chest` narrow the wire strings; `asset` is the
 * JSON-shaped asset the game already builds.
 */
export type StorageMoveAction = { direction: 'deposit' | 'withdraw'; asset: Asset; chest?: ChestId };
export type ShelfAction = { action: 'stock' | 'take'; gate: number; slot: number; asset?: Asset };
export type MailSendAction = { toId: string; asset: Asset };
/** What an item mutation carries: any of the grab-bag request's fields but the header. */
export type ItemsFields = Partial<Fields<ItemsRequest>>;

/** `create` + `toJson` in one step: the wire JSON, empty fields emitted (the server reads ProtoJSON). */
function wire<D extends DescMessage>(schema: D, keyed: Keyed, fields: Record<string, unknown>): Record<string, unknown> {
  const message = create(schema, {
    op: create(OpHeaderSchema, { lease: keyed.lease, key: keyed.key }),
    where: create(WhereSchema, keyed.where),
    ...fields,
  } as unknown as MessageShape<D>);
  return toJson(schema, message, { alwaysEmitImplicit: true }) as Record<string, unknown>;
}

/** A homestead mutation (claim, buy, place, …, joint, leave). */
export function homesteadRequest(keyed: Keyed, action: HomeAction): Record<string, unknown> {
  const { op, ...fields } = action;
  return wire(HomesteadRequestSchema, keyed, fields);
}

/** A gate-shelf mutation (stock or take). */
export function shelfRequest(keyed: Keyed, action: ShelfAction): Record<string, unknown> {
  return wire(ShelfRequestSchema, keyed, { ...action, ...(action.asset ? { asset: action.asset } : {}) });
}

/** A storage move between the pack and a chest at home. */
export function storageRequest(keyed: Keyed, action: StorageMoveAction): Record<string, unknown> {
  return wire(StorageMoveRequestSchema, keyed, { direction: action.direction, chest: action.chest ?? '', asset: action.asset });
}

function qtyRequest<D extends DescMessage>(schema: D, keyed: Keyed, id: string, qty: number): Record<string, unknown> {
  return wire(schema, keyed, { recipeId: id, qty } as never);
}

/** Craft at the Workshop bench. */
export const craftRequest = (keyed: Keyed, recipeId: string, qty: number) => qtyRequest(CraftRequestSchema, keyed, recipeId, qty);

/** Make food, remedies and oils at the cottage hearth. */
export const hearthCraftRequest = (keyed: Keyed, recipeId: string, qty: number) => qtyRequest(HearthCraftRequestSchema, keyed, recipeId, qty);

/** Copy a recipe page at the writing desk. */
export function deskCopyRequest(keyed: Keyed, pageId: string, qty: number): Record<string, unknown> {
  return wire(DeskCopyRequestSchema, keyed, { pageId, qty });
}

/** Send a parcel. */
export function mailSendRequest(keyed: Keyed, action: MailSendAction): Record<string, unknown> {
  return wire(MailSendRequestSchema, keyed, action);
}

/** Claim or recall a parcel (POST /api/mail/:id/{claim,recall}). */
export function mailKeyedRequest(keyed: Keyed): Record<string, unknown> {
  return wire(MailKeyedRequestSchema, keyed, {});
}

/** Contribute materials to a village project. */
export function contributeRequest(keyed: Keyed, materials: Record<string, number>): Record<string, unknown> {
  return wire(ContributeRequestSchema, keyed, { materials });
}

/** A keyed item mutation (use, repair, fit, …, buy). */
export function itemsRequest(keyed: Keyed, fields: ItemsFields): Record<string, unknown> {
  return wire(ItemsRequestSchema, keyed, fields as Record<string, unknown>);
}
