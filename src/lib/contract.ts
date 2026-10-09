import raw from '../../content/contract.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { ContractSchema, type ContractValid } from './gen/glimway/content/v1/contract_pb.js';

/**
 * The API contract number: bumped when an old client must reload before
 * using the API. Read through the schema (proto/glimway/content/v1/
 * contract.proto); there are no rules left in code.
 */
export function validateContract(value: unknown): ContractValid {
  return decodeContent(ContractSchema, value, 'contract', []);
}
export const CONTRACT = validateContract(raw);
export const CONTRACT_NUMBER = CONTRACT.number;
