/** Schema-derived requests/results for Link's existing typed durable operations.
 * This builds a fresh request; it never rewrites an existing outbox body.
 */
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { operationBody, operationRoutes } from './operation-routes.ts';
import type { Envelope } from '../gen/glimway/v1/state_pb.js';
import type { WhereJson } from './predict.ts';
import type { ApiErrorCode } from './errors.ts';

export type QueuedOperationKind = Exclude<keyof typeof operationRoutes, 'report' | 'profile' | 'purse-top-up' | 'wardrobe-check'>;
type Schema<K extends QueuedOperationKind> = (typeof operationRoutes)[K]['schema'];
export type OperationFields<K extends QueuedOperationKind> = K extends unknown ? Omit<MessageInitShape<Schema<K>>, 'op' | 'where'> : never;
export type OperationValue<K extends QueuedOperationKind> = Extract<Envelope['result'], { case: (typeof operationRoutes)[K]['result'] }> extends { value: infer V } ? V : never;
export type OperationOutcome<T> = { ok: true; value: T } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' };

export function operationHasPlace(kind: QueuedOperationKind): boolean {
  return operationRoutes[kind].schema.fields.some(field => field.name === 'where');
}

export function queuedRequest<K extends QueuedOperationKind>(kind: K, fields: OperationFields<K>, key: string, where?: WhereJson): { key: string; path: string; body: Record<string, unknown> } {
  const definition = operationRoutes[kind];
  // The generic schema selects the concrete request shape; fields are checked
  // against that shape at each caller, and the shared header/place are added here.
  const init = { op: { lease: '', key }, ...(operationHasPlace(kind) ? { where } : {}), ...fields } as unknown as MessageInitShape<Schema<K>>;
  const message = create<Schema<K>>(definition.schema, init);
  return { key, path: definition.path, body: operationBody<Schema<K>>(definition, message) as Record<string, unknown> };
}

/** The case is checked before narrowing the already-decoded Envelope value. */
export function queuedResult<K extends QueuedOperationKind>(kind: K, raw: unknown): OperationValue<K> | null {
  const result = raw as { case?: string; value?: OperationValue<K> } | null;
  return result?.case === operationRoutes[kind].result && result.value ? result.value : null;
}
