import { toJson } from '@bufbuild/protobuf';
import type { PlayerState } from './gen/glimway/v1/state_pb.js';
import { HabiticaProfileSchema } from './gen/glimway/v1/profile_pb.js';
import { validateHabiticaProfile } from './habitica/mapping.ts';
import type { HabiticaProfile } from './habitica/types.ts';

export type ProfileSource = 'habitica' | 'none';
export interface ProfileAccount { profileSource: ProfileSource; profile?: HabiticaProfile | null }

/** Account readers use this seam before reading class, look, stats or companions. */
export function profileFor(account: ProfileAccount): HabiticaProfile | null {
  return account.profileSource === 'habitica' ? account.profile ?? null : null;
}
export function earnsXP(account: Pick<ProfileAccount, 'profileSource'>): boolean {
  return account.profileSource === 'habitica';
}

/** Typed server states use the same boundary as local combat and avatar readers. */
export function profileForState(state: PlayerState): HabiticaProfile | null {
  const source = state.account?.profileSource;
  if (source === 'none') return null;
  if (source !== 'habitica' || !state.profile) throw new Error('missing account profile');
  return profileFor({ profileSource: source, profile: validateHabiticaProfile(toJson(HabiticaProfileSchema, state.profile, { alwaysEmitImplicit: true })) });
}
