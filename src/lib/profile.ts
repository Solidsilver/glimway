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
