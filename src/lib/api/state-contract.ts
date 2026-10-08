import { toJson } from '@bufbuild/protobuf';
import { PlayerStateSchema, type PlayerState } from '../gen/glimway/v1/state_pb.js';
import { HabiticaProfileSchema } from '../gen/glimway/v1/profile_pb.js';
import { validateHabiticaProfile } from '../habitica/mapping.ts';
import { decodeWire } from './wire.ts';

export function validatePlayerState(state: PlayerState): PlayerState {
  const { account, vitals, place, story, embers } = state;
  if (!account || !vitals || !place || !story || !embers || !account.accountId || !account.worldId) throw new Error('incomplete state');
  if (!['habitica', 'none'].includes(account.profileSource)) throw new Error('unknown profile source');
  for (const n of [state.version, vitals.reportSeq, vitals.vitalsSetVersion, place.placeSetVersion, embers.balance, embers.xpEarned, embers.pending]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid state counter');
  }
  if (place.placeSetVersion > state.version || vitals.vitalsSetVersion > state.version || embers.xpEarned > embers.balance || vitals.hp < 0 || vitals.hp > vitals.maxHp || vitals.mana < 0 || vitals.mana > vitals.maxMana || vitals.maxHp <= 0 || vitals.maxMana <= 0 || !place.area) throw new Error('invalid state bounds');
  if (embers.xpMark < 0 || embers.verifiedXp < 0 || story.playSeconds < 0) throw new Error('invalid state totals');
  for (const values of [story.marks, story.discoveries, story.defeated, story.questItems]) {
    if (values.length > 4096 || values.some(v => !v || new TextEncoder().encode(v).length > 256)) throw new Error('invalid story');
  }
  if (account.profileSource === 'habitica') {
    if (!state.profile) throw new Error('missing profile');
    validateHabiticaProfile(toJson(HabiticaProfileSchema, state.profile, { alwaysEmitImplicit: true }));
  } else if (state.profile) throw new Error('unexpected profile');
  return state;
}
export function decodePlayerState(raw: unknown): PlayerState {
  return validatePlayerState(decodeWire(PlayerStateSchema, raw));
}
