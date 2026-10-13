/** Schema-validated shipped residents shape, below cross-catalog domain rules. */
import raw from '../../content/residents.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { ResidentsSchema } from './gen/glimway/content/v1/residents_pb.js';
export const RESIDENTS_SHAPE = decodeContent(ResidentsSchema, raw, 'residents', ['residents']);
