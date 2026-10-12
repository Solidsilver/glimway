import raw from '../../content/enemies.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { EnemiesSchema, type EnemiesValid } from './gen/glimway/content/v1/enemies_pb.js';

export function validateEnemies(value: unknown): EnemiesValid {
  return decodeContent(EnemiesSchema, value, 'enemies', []) as EnemiesValid;
}
const data = validateEnemies(raw);
export const ENEMY_TUNING = { wisp: data.wisp, beetle: data.beetle, guardian: data.guardian };
export const KNOCK = data.knock;
