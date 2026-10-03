# M3 implementation record — import foundation + shared gameplay/art handoff

Date: 2026-10-03. Implements the M3 fixes and shared foundation assigned to
the shared-logic agent. Runtime-facing contract: `docs/import-contract.md`.
Asset/gear catalog provenance: `docs/habitica-assets.md` + `ASSETS.md`
(snap_assets). No Habitica writes anywhere; no live credentials used.

## 1. maxHealth projected-payload bug (m3-review F1) — fixed

- `mapping.ts` now derives `maxHp` from the official shared constant
  `MAX_HEALTH = 50` (`website/common/script/constants.js`, verified
  2026-10-03; schema stores only `stats.hp` defaulting to `shared.maxHealth`;
  `stats.maxHealth` exists only as a computed field injected when
  `userFields` projection is absent — `website/server/libs/user/index.js:28`).
- Projection preserved (`USER_FIELDS`), so live responses no longer fail
  mapping. A payload that does carry `stats.maxHealth` (legacy/unprojected)
  is still honored. Fixtures no longer fabricate computed stats.
- Regression: `tests/habitica-mapping.test.ts` "projected payloads without
  stats.maxHealth map to the shared maxHealth constant".

## 2. Client projection + default gear catalog

- `USER_FIELDS` now includes `items.gear.costume`, `items.currentPet`,
  `items.currentMount` (companions/costume reach real imports) alongside
  `stats, items.gear.equipped, items.pets, items.mounts, preferences,
  profile.name, flags.classSelected`.
- `createHabiticaClient` defaults `gearStats` to `gearStatsFor` from
  `src/lib/habitica/gear.ts` (snap_assets catalog: 1860 gear items with
  klass/specialClass, source revision + license split in `CATALOG`).
  Passing `gearStats` still overrides (tests pin both paths).

## 3. Profile shape (snap_assets avatar contract)

New optional, backward-compatible `HabiticaProfile` fields (sanitized, with
defaults `{}` / `false` / `null` / `null` for legacy saves):

- `costume?: Record<string, string | null>` (items.gear.costume)
- `useCostume?: boolean` (preferences.costume)
- `selectedPet?: string | null` (items.currentPet, '' → null)
- `selectedMount?: string | null` (items.currentMount, '' → null)

Optional appearance hair slots added for avatar layering:
`hairBangs` / `hairMustache` / `hairBeard` / `hairFlower`
(preferences.hair.*; 0 = none).

**Costume is visuals only.** Effective stats read `equipped` exclusively;
`useCostume` selects which map the avatar layers read, never the stat source.

## 4. Effective stats / class bonus

Formula (verified against `statsComputed.js`, 2026-10-03):

```
effective(stat) = base + buff + Σ_items item[stat]           (equipped, once each)
                + Σ_{matching items} item[stat]              (class bonus, once)
                + floor(min(lvl, 100) / 2)
maxMp           = 2 * effective(int) + 30
```

"Class bonus once": a class-matching item (`klass` **or** `specialClass`
equals the profile class) contributes exactly one extra add — verified by
regression test ("class bonus is applied exactly once per matching item",
klass+specialClass double-match → one add). Matching items total 2× their
stat, which is Habitica's own class-gear affinity, not a double-count of two
sources. Kept documented deviation: classless profiles (`class: null`) skip
the class bonus entirely.

## 5. Reconciliation model (approved health policy, 2026-10-03)

All in `src/lib/habitica/sync.ts` (pure; no network):

- **Village only.** `syncProfile` requires `state.area === 'village'`;
  `opts.atSafeBoundary` can only further restrict — it can never grant a
  non-village sync (regression pinned).
- **First import** (`applyImportedProfile`) replaces demo vitals with
  imported ones at the village; outside it throws `SyncRejectedError` and
  the save is untouched.
- **Later syncs, same account:** positive external HP/MP deltas vs the saved
  baseline credit **once** (baseline then advances). Capped deltas still
  advance the baseline — damage followed by an identical sync cannot
  re-credit (regression: "capped delta still advances the baseline"). Lower
  external HP/MP clamps local values down. An unchanged profile never
  refills. Name/class/stats/gear/costume/companion-only changes update the
  stored profile without moving vitals (regression).
- **Rejected syncs** (non-village, account switch) return the ENTIRE save
  unchanged — baseline changes are not consumed.
- **Reload preserves baseline** (baseline lives in save format 2);
  level-ups raise maxima without refilling currents.
- **Defeat recovery:** demo keeps the M2 full-restore; imported wakes at
  `min(last imported HP, ceil(maxHp * 0.25))` HP and
  `min(last imported MP, ceil(maxMana * 0.5))` mana — **zero stays zero**,
  baseline preserved. Provisional caps exported as `IMPORTED_RECOVERY` for
  later adjustment (user-approved for now).
- **No passive village HP refill for imported vitals** (`passiveRegenAllowed`:
  demo true, imported false). Mana regen is a local resource rule and stays.

## 6. Save format 2: baseline clearing

- `SaveGameOptions.importedProfile` is now `HabiticaProfile | null`:
  `undefined` preserves the stored baseline, **`null` explicitly clears it**
  (demo rollback), a profile object replaces it.
- Reset to demo provenance (`{ vitalsSource: 'demo' }`) also clears a stale
  baseline even without an explicit null. Runtime: pass
  `importedProfile: null` whenever `session.importedProfile` is null on a
  save (defense in depth).

## 7. Combat contract (`src/lib/combat.ts`)

`getCombatKit(profile | null): CombatKit` — class kits (warrior→cleave,
mage→bolt, rogue→dash, healer→heal), classless/`null` starter keeps the
existing demo bolt (manaCost 15). Numbers use hyperbolic diminishing returns
so extreme imports stay bounded (regression: 100k stats stay under the
ceilings). **Healer signature is a damaging pulse PLUS a heal** — both
`signatureDamage` and `healAmount` are live numbers (runtime applies both).

## 8. Test/verification status

- Final coordinator verification: `npm run verify` passes TypeScript,
  Svelte (0 errors/warnings), all 135 tests, and the production build.
- Runtime browser checks include delayed network and native IndexedDB put
  completion during Disconnect, Reset, and Restore, with saved results checked
  after reload. See `docs/playtest-m3.md` for scenarios, screenshots, and limits.

## 9. Open items (not in this slice)

- Real-account authentication and payload verification remain untested; no
  real token was supplied. Current browser checks use intercepted fixtures.
- The art cache is a supported subset; uncached layers have visible fallback
  notices. Additional NPC/guardian art and audio remain polish work.
- Creator identity, runtime regen/reconciliation, and explicit baseline
  clearing are now implemented. The imported-health policy was approved by
  the user; caps remain configurable via `IMPORTED_RECOVERY`.
