/** Schema-validated shipped items shape, below cross-catalog domain rules. */
import raw from '../../content/items.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { ItemsSchema } from './gen/glimway/content/v1/items_pb.js';
export const ITEMS_SHAPE = decodeContent(ItemsSchema, raw, 'items', ['items', 'pickups', 'sellers']);
