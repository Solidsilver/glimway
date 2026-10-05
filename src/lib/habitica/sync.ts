import { HOME_AREA_RE, recoverFromDefeat, validateSave, type GameState } from '../state.ts';
import { validateHabiticaProfile } from './mapping.ts';
import { creditXp, grantEmbers, grantWelcome, lifetimeXp } from '../embers.ts';
import type {
  HabiticaProfile,
  LoadedSave,
  SyncRejectReason,
  SyncStatus,
  VitalsSource,
} from './types.ts';

/**
 * Reconciliation model for Habitica imports (docs/m3-implementation.md,
 * approved health policy 2026-10-03).
 *
 * Pure logic only — no network, no Habitica writes, ever. Sync is explicit,
 * user-triggered and only in a safe area (Hearthwick or the Commons). The imported profile in the save is the
 * baseline that makes external healing creditable exactly once; a rejected
 * sync leaves the ENTIRE save (including that baseline) unchanged.
 */
export type SyncedSave = LoadedSave;

export interface SyncResult {
  status: SyncStatus;
  /** Present when status === 'rejected'. */
  reason?: SyncRejectReason;
  /** Unchanged input save for 'rejected' and 'unchanged'. */
  save: SyncedSave;
  notes: string[];
  /** Embers credited by this sync: from Habitica XP since the baseline, plus
   *  the one-off welcome gift on a first import. */
  embers?: { xp: number; gained: number; welcome: number };
}

/**
 * Imported defeat recovery is provisional and adjustable: wake with at most
 * 25% of max HP (and never more than the last imported HP — zero stays zero)
 * and at most 50% of max mana (never more than last imported mana).
 */
export const IMPORTED_RECOVERY = {
  hpMaxFraction: 0.25,
  manaMaxFraction: 0.5,
} as const;

export class SyncRejectedError extends Error {
  readonly reason: SyncRejectReason;

  constructor(reason: SyncRejectReason) {
    super(
      reason === 'account-switch'
        ? 'This save is tied to a different Habitica account. Start a new journey to import another account.'
        : 'Sync only applies in Hearthwick or the Commons (safe areas). The save is unchanged.',
    );
    this.name = 'SyncRejectedError';
    this.reason = reason;
  }
}

/**
 * Safe areas, where syncs (and rests) may happen: Hearthwick village,
 * Hearthwick Commons, and every homestead's land behind its gates (`home:<g>`).
 * Matches the server's `rules.IsSafeArea`. A cottage is part of its
 * homestead (the save keeps saying `home:<g>` inside one).
 */
export const SAFE_AREAS: readonly string[] = ['village', 'commons'];

export function isSafeArea(area: string): boolean {
  return SAFE_AREAS.includes(area) || HOME_AREA_RE.test(area);
}

export function isSafeBoundary(state: GameState): boolean {
  return isSafeArea(state.area);
}

/**
 * Approved health policy: no passive HP refill for imported vitals (demo keeps
 * its M2 village-rest rule). Mana is a local ability resource and regenerates
 * for both.
 */
export function passiveRegenAllowed(source: VitalsSource): boolean {
  return source === 'demo';
}

/** Field-exact profile comparison (both sides sanitized). */
function profilesEqual(
  a: HabiticaProfile | undefined | null,
  b: HabiticaProfile,
): boolean {
  if (!a) return false;
  return (
    JSON.stringify(validateHabiticaProfile(a)) === JSON.stringify(validateHabiticaProfile(b))
  );
}

/**
 * First import only: replaces demo vitals with imported ones, and only at the
 * safe boundary. Throws SyncRejectedError otherwise — the save is untouched.
 */
export function applyImportedProfile(current: GameState, profile: HabiticaProfile): SyncedSave {
  const state = validateSave(current);
  if (!isSafeBoundary(state)) {
    throw new SyncRejectedError('not-at-safe-boundary');
  }
  const p = validateHabiticaProfile(profile);
  const next = validateSave({
    ...state,
    hp: Math.min(p.hp, p.maxHp),
    maxHp: p.maxHp,
    mana: Math.min(p.mp, p.maxMp),
    maxMana: p.maxMp,
    // Past XP is not paid: the import marks today's lifetime XP as paid.
    emberXp: Math.max(state.emberXp, creditXp(undefined, p).mark ?? 0),
  });
  return { state: next, vitalsSource: 'imported', importedProfile: p };
}

/**
 * Explicit user-triggered sync against a freshly fetched profile.
 *
 * Rules:
 * - Safe areas only (Hearthwick or the Commons). The caller cannot override
 *   this: opts.atSafeBoundary may only further restrict, never grant a sync
 *   elsewhere. Outside the safe
 *   boundary the ENTIRE save is returned unchanged — baseline changes are not
 *   consumed (they credit later).
 * - Account id switches are rejected: another account needs a new journey.
 * - First import (demo provenance) replaces demo vitals (applyImportedProfile).
 * - Later syncs credit positive external HP/MP deltas vs the saved baseline
 *   exactly once (the baseline then advances), clamp current values DOWN when
 *   external HP/MP fell, and never refill from an unchanged profile. The new
 *   baseline is persisted even when a positive delta caps at full local
 *   HP/mana, so damage followed by an identical sync cannot re-credit it.
 * - Name/class/stats/gear/costume/companion-only changes update the stored
 *   profile even when vitals do not move.
 * - Maxima always track the profile; raising maxima (e.g. level-up) never
 *   refills current HP/mana.
 */
export function syncProfile(
  save: SyncedSave,
  profile: HabiticaProfile,
  opts: { atSafeBoundary?: boolean } = {},
): SyncResult {
  const atSafeBoundary = isSafeBoundary(save.state) && opts.atSafeBoundary !== false;
  const p = validateHabiticaProfile(profile);

  if (!atSafeBoundary) {
    return {
      status: 'rejected',
      reason: 'not-at-safe-boundary',
      save,
      notes: ['sync rejected: outside the village; save and baseline unchanged'],
    };
  }

  if (save.vitalsSource === 'demo') {
    const imported = applyImportedProfile(save.state, p);
    // The import itself only sets the XP baseline; past XP is not paid out.
    const welcome = grantWelcome(imported.state);
    return {
      status: 'imported',
      save: { ...imported, state: welcome.state },
      notes: ['first import: demo vitals replaced by imported vitals at the village'],
      embers: { xp: 0, gained: welcome.granted, welcome: welcome.granted },
    };
  }

  const baseline = save.importedProfile;
  if (baseline && baseline.id !== p.id) {
    return {
      status: 'rejected',
      reason: 'account-switch',
      save,
      notes: ['sync rejected: different account id; start a new journey'],
    };
  }

  const state = validateSave(save.state);
  const maxHp = p.maxHp;
  const maxMana = p.maxMp;
  let hp = Math.min(state.hp, maxHp);
  let mana = Math.min(state.mana, maxMana);
  const notes: string[] = [];

  if (baseline) {
    const dHp = p.hp - baseline.hp;
    const dMp = p.mp - baseline.mp;
    if (dHp > 0) {
      hp = Math.min(hp + dHp, maxHp);
      notes.push(`external HP +${dHp} credited once`);
    } else if (p.hp < baseline.hp) {
      hp = Math.min(hp, Math.min(maxHp, p.hp));
      notes.push(`external HP fell; local HP clamped to ${hp}`);
    }
    if (dMp > 0) {
      mana = Math.min(mana + dMp, maxMana);
      notes.push(`external MP +${dMp} credited once`);
    } else if (p.mp < baseline.mp) {
      mana = Math.min(mana, Math.min(maxMana, p.mp));
      notes.push(`external MP fell; local MP clamped to ${mana}`);
    }
  } else {
    notes.push('baseline established; no vitals credited');
  }

  // XP earned in Habitica becomes embers exactly once: credit is measured
  // against the highest lifetime XP ever paid (state.emberXp), which never
  // falls — so XP lost and regained (an unchecked-then-rechecked task)
  // cannot pay twice. Saves from before the mark fall back to the baseline.
  const priorMark =
    state.emberXp > 0
      ? state.emberXp
      : baseline?.exp !== undefined
        ? lifetimeXp(baseline.level, baseline.exp)
        : undefined;
  const earned = creditXp(priorMark, p);
  const emberXp = Math.max(state.emberXp, earned.mark ?? 0);
  if (earned.embers > 0) notes.push(`+${earned.xp} XP since last sync credited as ${earned.embers} embers`);

  // The profile itself is the new baseline even when local vitals did not
  // move (capped delta, clamped already equal, or appearance/stat/gear-only
  // changes) — otherwise a later sync would re-credit the same delta.
  const profileChanged = !profilesEqual(baseline, p);
  const changed =
    profileChanged ||
    hp !== state.hp ||
    mana !== state.mana ||
    maxHp !== state.maxHp ||
    maxMana !== state.maxMana ||
    emberXp !== state.emberXp;

  if (!changed) {
    return {
      status: 'unchanged',
      save,
      notes: ['profile unchanged; no refill applied'],
    };
  }

  return {
    status: 'synced',
    save: {
      state: grantEmbers(validateSave({ ...state, hp, maxHp, mana, maxMana, emberXp }), earned.embers, { fromXp: true }),
      vitalsSource: 'imported',
      importedProfile: p,
    },
    notes,
    embers: { xp: earned.xp, gained: earned.embers, welcome: 0 },
  };
}

/**
 * Demo defeat recovery vs imported defeat recovery:
 * - demo: the M2 rule — full demo vitals in Hearthwick, story kept.
 * - imported: wake at min(last imported HP, hpMaxFraction * maxHp) — zero
 *   stays zero — and min(last imported MP, manaMaxFraction * maxMana), story
 *   kept, imported baseline preserved. Provisional; adjust via
 *   IMPORTED_RECOVERY. Never a Habitica operation either way.
 */
export function resolveDefeatRecovery(save: SyncedSave): SyncedSave {
  const state = validateSave(save.state);
  if (save.vitalsSource === 'demo') {
    return { state: recoverFromDefeat(state), vitalsSource: 'demo' };
  }
  const baselineHp = save.importedProfile?.hp ?? 0;
  const baselineMp = save.importedProfile?.mp ?? 0;
  const recovered = validateSave({
    ...recoverFromDefeat(state),
    hp: Math.min(baselineHp, Math.ceil(state.maxHp * IMPORTED_RECOVERY.hpMaxFraction)),
    mana: Math.min(baselineMp, Math.ceil(state.maxMana * IMPORTED_RECOVERY.manaMaxFraction)),
  });
  return {
    state: recovered,
    vitalsSource: save.vitalsSource,
    importedProfile: save.importedProfile,
  };
}

/** Provenance display label for the UI. */
export function vitalsSourceLabel(source: VitalsSource): string {
  return source === 'imported' ? 'Imported adventurer' : 'Demo adventurer';
}
