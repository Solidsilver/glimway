/** Schema-validated shipped papers shape, below cross-catalog domain rules. */
import raw from '../../content/papers.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { PapersSchema } from './gen/glimway/content/v1/papers_pb.js';
export const PAPERS_SHAPE = decodeContent(PapersSchema, raw, 'papers', ['papers']);
