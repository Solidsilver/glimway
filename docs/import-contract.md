# Fingersnap import contract (M3 — "Make it your character")

Source of truth for the read-only Habitica import foundation shared between
the shared-logic modules and the runtime UI.

**`src/lib/habitica/types.ts` is published first and is the mirror point.**
`snap_runtime` should mirror its types when wiring the CharacterPanel import
UI; do not fork or re-declare them. Runtime-facing behavior notes for the
same UI are appended at the end of this file.

## Ownership

| Path | Owner |
|---|---|
| `src/lib/`, `src/content/`, `tests/`, `docs/`, `ASSETS.md` | shared-logic agent |
| scaffold, `package.json`, build config, `src/game/`, `src/ui/`, `src/App.svelte`, `docs/runtime-asset-spec.md` | runtime agent |

## Security invariants (non-negotiable)

- **Read-only**: `HabiticaClient` has exactly one method, `fetchProfile()`.
  Fingersnap never scores tasks, spends gold, changes stats, equips items,
  casts spells, or consumes Habitica possessions. Ordinary gameplay causes
  zero Habitica requests; sync is one explicit `GET /user` per user action.
- **Token in memory only, unless the player opts in**: `HabiticaCredentials`
  lives in a JS variable for the session. It is never written to GameState,
  IndexedDB saves, save exports, logs, error messages, URLs, or source
  control. Save validation (`validateSave`, `validateHabiticaProfile`) strips
  unknown fields, so a stray token cannot ride along even if handed in.
  **On the device, the one exception** is the connect guide's **Remember on
  this device** box (off by default). When ticked, the User ID and token are
  stored in IndexedDB in their own database (`fingersnap-credentials`, see
  `src/lib/habitica/remembered.ts`), separate from the `fingersnap` save
  database. They are still never put in GameState, saves, save exports, logs
  or error messages. A visible **Forget** button deletes them, and Disconnect
  asks whether to forget too. The exposure is stated in the UI: a script
  injection on the Fingersnap origin could read a remembered token, and that
  token can write to the Habitica account. All storage access is wrapped in
  try/catch; the game works when IndexedDB is unavailable.
- **On the Fingersnap server**: the raw token exists only during one login
  proof request (`POST /api/session`). It is never stored in files, the
  database, backups, logs or responses. Server logging excludes bodies,
  headers and unrecognized paths/query strings. Syncs go from the browser to
  Habitica directly; the server only records the reported profile.
- **`.env` is dev-only**: `HABITICA_USER_ID` / `HABITICA_API_TOKEN` (see
  `.env.example`, gitignored) prefill credentials for local live checks and
  tests run in Node. They are read via `process.env` in dev/test tooling.
- **Vite env caveat**: only `VITE_`-prefixed vars are embedded into the
  client bundle. **Never** name the token variable `VITE_HABITICA_API_TOKEN`
  (or any `VITE_*` secret) — it would be compiled into public JS. In
  production builds there is no credential path in the bundle at all: the
  player pastes credentials into the connect guide (title screen or Menu) and
  they stay in memory unless Remember on this device is ticked.
- Errors from the client are typed and carry status codes only — never
  credentials or response bodies that might echo them.

## Embers (added 2026-10-03)

Embers turn Habitica XP into an in-game currency without any write path:

- **Source**: `syncProfile` computes lifetime XP (`level` + `exp`, on
  Habitica's level curve) and credits `floor(now / 10) - floor(mark / 10)`
  embers, where `GameState.emberXp` is the highest lifetime XP ever paid. The
  mark only rises, so XP lost and regained (unchecking and re-checking a task,
  or a Habitica death followed by recovery) never pays twice. The import sets
  the mark to the account's current XP (past XP is not paid). Rejected syncs
  (outside the village, account switch) credit nothing and keep the mark.
  XP loss never removes embers. Saves from before the mark fall back to the
  saved profile's XP once. Habitica's "Fix Character Values" can still set
  XP directly; a read-only client cannot tell that apart from earned XP.
- **First import**: pays a one-off `WELCOME_EMBERS` gift, guarded by a save
  flag so disconnecting and reconnecting cannot repeat it. Past XP is not paid.
- **Earned vs gifted**: `GameState.xpEmbers` counts embers that came from XP.
  Ordinary spends use gifted (welcome/quest) embers first.
- **Guest spending** is local (`spendEmbers`); connected spending uses the
  server transaction and ledger: a warm rest restores local HP and
  mana. For an imported hero at 0 HP it lifts the zero-HP lock only when paid
  with XP-earned embers (`needs-earned` otherwise), so the welcome gift can't
  bypass the lock. Lit road lanterns restore mana for everyone but HP only for
  demo vitals (no passive HP refill for imported heroes). The chest grants the
  Ember Charm. None of these touch the Habitica account.
- **Save shape**: `embers`, `flags`, `emberXp` and `xpEmbers` are optional on
  load (older saves read as 0 / `[]`), so `SAVE_VERSION` stays 1.

## Module API

### `src/lib/habitica/types.ts` (mirror this)

```ts
type HabiticaClass = 'warrior' | 'mage' | 'rogue' | 'healer'
interface EffectiveStats { str; int; con; per }           // effective stats
interface HabiticaCredentials { userId; apiToken; clientTag }  // in-memory only
interface HabiticaProfile {
  id; name; class: HabiticaClass | null; level;
  hp; maxHp; mp; maxMp; stats: EffectiveStats;
  equipped: Record<string, string | null>; pets: string[]; mounts: string[];
  appearance: { size; shirt; skin; hairColor; hairStyle; background;
    hairBangs?; hairMustache?; hairBeard?; hairFlower? };
  costume?: Record<string, string | null>;   // visuals only, never stats
  useCostume?: boolean;
  selectedPet?: string | null;               // items.currentPet
  selectedMount?: string | null;             // items.currentMount
}
interface HabiticaClient { fetchProfile(): Promise<HabiticaProfile> }  // no writes
interface GearItemStats { str?; int?; con?; per?; klass?; specialClass? }
type GearStatsLookup = (itemKey: string) => GearItemStats | undefined
type VitalsSource = 'demo' | 'imported'
type SignatureAbility = 'bolt' | 'cleave' | 'dash' | 'heal'
interface CombatKit {
  class; name; basicName; signatureName; signature: SignatureAbility;
  meleeDamage; signatureDamage; mitigation; critChance;
  manaCost; cooldown; healAmount
}
type SyncRejectReason = 'not-at-safe-boundary' | 'account-switch'
type SyncStatus = 'imported' | 'synced' | 'unchanged' | 'rejected'
interface SaveExtras { vitalsSource: VitalsSource; importedProfile?: HabiticaProfile }
interface SaveDocumentV2 { kind: 'fingersnap-save'; version: 1; saveFormat: 2;
  exportedAt; state: GameState; vitalsSource; importedProfile? }
interface SaveGameOptions {
  overwriteCorrupt?
  vitalsSource?
  importedProfile?: HabiticaProfile | null  // null = CLEAR baseline; undefined = preserve
}
interface LoadedSave { state: GameState; vitalsSource; importedProfile? }
```

### `src/lib/habitica/client.ts`

```ts
createHabiticaClient(options: {
  credentials: HabiticaCredentials
  gearStats?: GearStatsLookup   // defaults to gearStatsFor (bundled catalog)
  fetchImpl?: typeof fetch       // injectable for tests
  baseUrl?: string               // default 'https://habitica.com'
  timeoutMs?: number             // default 15000
  maxRateLimitRetries?: number   // default 3
  sleep?: (ms: number) => Promise<void>  // injectable for tests
}): HabiticaClient               // fetchProfile only

class HabiticaApiError extends Error {
  kind: 'auth' | 'rate-limited' | 'timeout' | 'network' | 'http' | 'invalid-response'
  status?: number
  retryAfterMs?: number
}
USER_FIELDS  // minimal ?userFields projection actually sent
             // includes items.gear.costume, items.currentPet, items.currentMount
```

Behavior: `GET {baseUrl}/api/v3/user?userFields=…` with `x-api-user`,
`x-api-key`, `x-client` headers (guidelines: `X-Client` = `UserID-appname` —
the **tool creator's** user id, i.e.
`5abfd539-22eb-457f-8e2a-9fb3d66731f1-fingersnap`, not the player's).
401/403 → `auth` error (message names the status only). `429` → sleep for
`Retry-After` (seconds; default 1000 ms if absent) and retry up to
`maxRateLimitRetries`, then throw `rate-limited`. Abort/timeout → `timeout`;
other fetch failures → `network`; non-2xx → `http`; unparseable body →
`invalid-response`. Credentials never appear in URLs or messages.

### `src/lib/habitica/mapping.ts`

```ts
MAX_LEVEL = 100                          // Habitica constants.js (verified)
MAX_HEALTH = 50                          // shared.maxHealth; source of maxHp
                                         // for projected payloads (schema
                                         // stores no stats.maxHealth)
toHabiticaProfile(user: unknown, gearStats?: GearStatsLookup): HabiticaProfile
validateHabiticaProfile(data: unknown): HabiticaProfile   // sanitize for saves
effectiveStatsFor(base, buffs, level, equipped, class, gearStats): EffectiveStats
class InvalidHabiticaUserError extends Error { path: string }
```

Effective-stat formula (docs/habitica-foundations.md, `statsComputed.js`):

```
effective(stat) = base + buff + gearBonus + classBonus + floor(min(lvl, MAX_LEVEL) / 2)
maxMp           = 2 * effective(int) + 30
```

- `base` = `user.stats.{str,int,con,per}` (base only — never add gear twice).
- `buff` = `user.stats.buffs.{str,int,con,per}` (defaults 0).
- `gearBonus` = Σ `item[stat]` over `items.gear.equipped` keys (once each).
- `classBonus` = Σ `item[stat]` **once** for items whose `klass`/`specialClass`
  matches the character class (class bonus applied once per matching item).
- Costume gear NEVER contributes stats (visuals only).
- Unknown/uncatalogued gear keys contribute 0 (the `/user` payload carries
  keys only; stat values come from `GearStatsLookup`, defaulting to the
  bundled catalog's `gearStatsFor`).

**Documented deviation** from `statsComputed`: when `flags.classSelected` is
false the profile is classless (`class: null`) and the class-match bonus is
skipped. Habitica's formula matches `stats.class` unconditionally; Fingersnap
treats "no class selected" as no class bonus (plan: sensible classless
starter kit). This is a deliberate import-mapping rule, not balance advice.

Field paths are verified against `src/lib/habitica/fixtures.ts`, not live.

### `src/lib/habitica/sync.ts` (pure logic, no network)

```ts
interface SyncResult { status: SyncStatus; reason?: SyncRejectReason; save: SyncedSave; notes: string[] }
interface SyncedSave { state: GameState; vitalsSource; importedProfile? }

applyImportedProfile(current: GameState, profile: HabiticaProfile): SyncedSave
  // first import; throws SyncRejectedError outside the village
syncProfile(save: SyncedSave, profile: HabiticaProfile,
  opts?: { atSafeBoundary?: boolean }): SyncResult
resolveDefeatRecovery(save: SyncedSave): SyncedSave
passiveRegenAllowed(source: VitalsSource): boolean
isSafeBoundary(state: GameState): boolean
IMPORTED_RECOVERY = { hpMaxFraction: 0.25, manaMaxFraction: 0.5 }  // adjustable
class SyncRejectedError { reason: SyncRejectReason }
```

Reconciliation model (approved health policy 2026-10-03; full rationale in
docs/m3-implementation.md):

- **Explicit, manual, conservative**: one `fetchProfile` per player action.
  Never per frame, per combat event, or on a timer. All syncs are
  **village-only**; `opts.atSafeBoundary` can only further restrict, never
  grant a non-village sync.
- **First import** replaces demo vitals at the village (`applyImportedProfile`).
  Outside the village it throws `SyncRejectedError` and the save is untouched.
- **Later syncs (same account)**: positive external HP/MP deltas vs the saved
  baseline (the stored `importedProfile`) credit **exactly once** — the
  baseline advances even when the delta caps at full local HP/mana, so
  damage + identical sync can never re-credit. Lower external HP/MP clamps
  local values down. An unchanged profile never refills. Profile-only changes
  (name/class/stats/gear/costume/companion) update the stored baseline
  without moving vitals. Maxima track the profile; level-ups never refill.
- **Rejected syncs** (non-village, account id switch) return the entire save
  unchanged — baseline changes are not consumed. Switching accounts requires
  a new journey.
- **Defeat recovery**: demo = M2 full restore; imported =
  `min(last imported HP, 25% maxHp)` / `min(last imported MP, 50% maxMana)`,
  zero stays zero, baseline preserved. Provisional caps (`IMPORTED_RECOVERY`)
  pending final HP policy.
- **No passive village HP refill** for imported vitals — gate scene regen
  with `passiveRegenAllowed(session.vitalsSource)`. Mana regen (local
  resource) stays for both.
- Importing is read-only: these functions only reshape local `GameState`.

### `src/lib/save.ts` (format 2; v1 loads keep working)

```ts
loadGame(): Promise<GameState | null>                       // unchanged contract
loadSaveRecord(): Promise<LoadedSave | null>                // NEW: state + provenance
saveGame(state, options?: SaveGameOptions): Promise<void>   // options NEW
exportSave(state, extras?: SaveExtras): string              // extras NEW
importSave(json: string): GameState                         // unchanged contract
importSaveDocument(json: string): LoadedSave                // NEW: full document
clearSave(): Promise<void>
CorruptSaveError; InvalidSaveError; MAX_IMPORT_LENGTH
```

- Stored records and export documents are **format 2**:
  `{ saveFormat: 2, state, vitalsSource, importedProfile? }`.
  Format 1 (v1) records/documents load fine and migrate to
  `vitalsSource: 'demo'` with no imported profile.
  `SaveDocumentV2.version` stays `1` (that is the GameState schema version).
- `saveGame` without `vitalsSource`/`importedProfile` **preserves** the
  provenance already stored — ordinary gameplay saves cannot downgrade an
  imported save back to demo. `importedProfile: null` **explicitly clears**
  the baseline (demo rollback); an explicit `{ vitalsSource: 'demo' }` reset
  also clears it. Pass `importedProfile: null` whenever the session's
  imported profile is null.
- Corrupt-save protection is unchanged: corrupt records throw
  `CorruptSaveError` and are never silently overwritten
  (`{ overwriteCorrupt: true }` only after explicit player confirmation).
- Credentials can never appear in saves/exports: only `validateSave`d state
  and `validateHabiticaProfile`d profiles are serialized.

## Fixtures (tests run with no network, no credentials)

`src/lib/habitica/fixtures.ts` — realistic `GET /user` `data` payloads with
hand-computed expected effective stats:

| key | Proves |
|---|---|
| `lowLevel` | level bonus floor(lvl/2), class-matching gear counted twice |
| `highLevel` | buffs, cap `MAX_LEVEL`, heavy INT gear → derived `maxMp` |
| `classless` | `flags.classSelected: false` → `class: null`, no class bonus |
| `lowHp` | fractional imported HP (expedition difficulty source) |
| `variedEquipment` | mixed klass/specialClass/unknown keys; no double-counting |

## Tooling

- Tests: `npm test` (`node --test tests/*.test.ts`) — all network mocked.
- Typecheck: `npm run typecheck`.
- Live credentials (when the test account arrives): Node-side only, via
  `.env` → `process.env`; see security invariants above.

## Notes for snap_runtime (CharacterPanel import UI)

1. Mirror `src/lib/habitica/types.ts`; import types from
   `../lib/habitica/types` (or re-export) — do not redefine shapes.
2. Suggested flow: player pastes user id + API token into fields → build
   `HabiticaCredentials` (clientTag `5abfd539-22eb-457f-8e2a-9fb3d66731f1-fingersnap`
   — the **creator** id + app name, not the player's) in a local
   variable → `createHabiticaClient({ credentials })` (gear catalog is the
   default) → `fetchProfile()` → first import via
   `syncProfile({ state, vitalsSource }, profile)` (or
   `applyImportedProfile`) → persist via
   `saveGame(state, { vitalsSource: 'imported', importedProfile: profile })`.
   Clear the credential fields afterwards; never store them.
3. Surface `HabiticaApiError` with friendly copy per `kind` (auth vs
   rate-limited vs timeout); include `retryAfterMs` when present. Never echo
   the raw error if it might contain user input beyond our own messages.
4. Sync button = one click → one `fetchProfile` → `syncProfile(save, profile)`
   (village-only; handle `status: 'rejected'` with the reason). Disable while
   in flight (no concurrent syncs). Sync is optional; demo play continues to
   work with zero requests.
5. `loadSaveRecord()` gives you `vitalsSource`/`importedProfile` on boot;
   show provenance ("Demo adventurer" vs imported name/class) in the panel.
6. Export/import should use `exportSave(state, extras)` /
   `importSaveDocument(json)` so provenance travels with backups.
7. Combat: use `getCombatKit(sessionProfile)` from `src/lib/combat.ts`;
   the healer signature applies `signatureDamage` AND `healAmount`.
8. Village HP regen must check `passiveRegenAllowed(vitalsSource)` (no
   passive HP refill for imported vitals).
9. Demo rollback / "reset to demo": `saveGame(state,
   { vitalsSource: 'demo', importedProfile: null })` — never leave a stale
   baseline.

## Connected saves (phase 2 backend)

The browser still fetches Habitica profiles directly for explicit syncs. The
server calls Habitica only for `POST /api/session`, to verify the account,
with at most one retry after 429. For connected saves the server owns the HP/MP
baseline, XP high-water mark, earned/gifted balances, paid outcomes and bought
inventory. Guests retain all existing local rules above.

`content/economy.json` is canonical for both languages; `content/vectors/`
contains outputs of the real TypeScript functions replayed by Go tests.
Connected reported profiles receive extra shape/curve/vitals/death-loss checks.
At most 200 unverified XP-earned embers can be paid above the latest verified
checkpoint; repeating syncs cannot increase that allowance. Excess credit is
held in lots tagged with the XP at which it was reported. A verified login pays
lots whose reported XP it reaches; a plausible death keeps unconfirmed lots
pending. Reports/checkpoints compare XP losses against the last accepted
profile, with a one-death allowance; a level-1 rebirth is accepted and audited.
Only an implausibly low verified checkpoint flags the player and drops pending. The XP mark never
falls, and login does not consume the gameplay healing baseline.

An accepted upload grants the two story gifts once per account. A stale upload
merges only story progress; the server retains health, mana, area and position.
Syncs and spends require a current revision and play lease and commit their
carried progress atomically. All uploads ignore balances, maxima, paid flags
and purchased items. Migration is once per account, carries at most 30 gifted
embers, and never trusts local XP marks or earned provenance. The complete
phase-2 wire contract and validation decisions are in `.agent/REPORT.md`.
