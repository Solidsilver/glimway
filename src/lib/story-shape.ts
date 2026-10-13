/** Schema-validated shipped story shape, below cross-catalog domain rules. */
import raw from '../../content/story.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { StorySchema } from './gen/glimway/content/v1/story_pb.js';
export const STORY_SHAPE = decodeContent(StorySchema, raw, 'story', ['namespaces']);
