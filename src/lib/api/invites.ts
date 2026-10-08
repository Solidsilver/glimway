import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import {
  CreateInviteResponseSchema, ListInvitesResponseSchema,
  type InviteMetadata, type CreateInviteResponse, type ListInvitesResponse,
} from '../gen/glimway/v1/invites_pb.js';
import { ApiError } from './errors.ts';

type Fields<T> = Omit<T, '$typeName' | '$unknown'>;
export type InviteInfo = Fields<InviteMetadata>;
export type CreatedInvite = Fields<CreateInviteResponse>;
export type InviteList = Omit<Fields<ListInvitesResponse>, 'invites'> & { invites: InviteInfo[] };

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid invite object');
  return raw as Record<string, unknown>;
}
function metadata(raw: unknown): void {
  const input = object(raw);
  if (typeof input.id !== 'string' || typeof input.used !== 'boolean') throw new Error('invalid invite metadata');
  for (const key of ['createdAt', 'expiresAt']) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error('invalid invite time');
  }
}
function fields<T extends { $typeName: string; $unknown?: unknown }>(message: T): Fields<T> {
  const { $typeName, $unknown, ...out } = message;
  return out;
}

export function parseCreatedInvite(raw: unknown): CreatedInvite {
  try {
    metadata(raw);
    if (typeof object(raw).code !== 'string') throw new Error('missing raw invite code');
    return fields(fromJson(CreateInviteResponseSchema, raw as JsonValue, { ignoreUnknownFields: true }));
  } catch { throw new ApiError('bad-response'); }
}

export function parseInviteList(raw: unknown): InviteList {
  try {
    const input = object(raw);
    if (!Array.isArray(input.invites)) throw new Error('missing invite list');
    input.invites.forEach(metadata);
    for (const key of ['remaining', 'outstandingLimit']) {
      const n = input[key];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 2147483647) throw new Error('invalid invite quota');
    }
    if (typeof input.partyWorld !== 'boolean' || typeof input.partyAdmitted !== 'boolean') throw new Error('invalid party admission');
    const response = fromJson(ListInvitesResponseSchema, raw as JsonValue, { ignoreUnknownFields: true });
    return { ...fields(response), invites: response.invites.map(fields) };
  } catch { throw new ApiError('bad-response'); }
}
