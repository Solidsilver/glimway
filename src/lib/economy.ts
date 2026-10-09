/**
 * The shared economy contract (content/economy.json): ember pricing, sync
 * credit, invites and the Wilds' rate limits. Validated against the schema
 * (proto/glimway/content/v1/economy.proto) the same way the Go loader is.
 */
import raw from '../../content/economy.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { EconomySchema, type EconomyValid } from './gen/glimway/content/v1/economy_pb.js';

export type Economy = EconomyValid;

/** Throws on anything content/embed.go would refuse. */
export function validateEconomy(value: unknown): Economy {
  return decodeContent(EconomySchema, value, 'economy', []) as Economy;
}
export const ECONOMY = validateEconomy(raw);
