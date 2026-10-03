# M3 status review — import foundation ("Make it your character")

Read-only review, 2026-10-03. Code inspected: `src/lib/habitica/*`, `src/lib/save.ts`,
`src/game/session.ts`, `src/game/scenes/WorldScene.ts`, `src/ui/habitica-local.ts`,
`src/ui/CharacterPanel.svelte`. No live API calls, no credentials used.
Baseline verified by coordinator: 81/81 tests, typecheck/build green.

## Status summary

Foundation (client, mapping, fixtures, save v2, sync rules) is implemented and
wired; UI import/sync exists behind the `?habitica-ui=preview` flag. **Live
import is currently non-functional**: the mapping rejects real projected
`/user` responses (F1). Health reconciliation rules exist in `src/lib` but the
UI bypasses them (F2), so sync behaves as a free heal. Credential handling is
sound except the X-Client identity rule (F5).

## Findings (prioritized)

### F1 (critical) — live import broken: `stats.maxHealth` is required but never present

- `src/lib/habitica/mapping.ts:168` — `requireNumber(statsRaw.maxHealth, …)`
  hard-requires the field.
- All fixtures fabricate it (`src/lib/habitica/fixtures.ts`, `userFixture`
  writes `maxHealth`), so 81/81 green masks the incompatibility. Root
  reproduced: a projected fixture without `maxHealth` → error.
- Primary sources (2026-10-03): the official user schema
  (`website/server/models/user/schema.js`) has **no** `stats.maxHealth`
  (`stats.hp` defaults to the `shared.maxHealth` constant), and
  `website/server/libs/user/index.js:28` adds computed stats **only when
  `!req.query.userFields`** —
  https://github.com/HabitRPG/habitica/blob/develop/website/server/libs/user/index.js#L28
- Our client always projects: `src/lib/habitica/client.ts` (`USER_FIELDS`,
  `?userFields=` on every request). So every live `fetchProfile()` maps to
  `invalid-response` and no character can ever import.
- Fix needs a decision: derive `maxHp` (like `maxMp` from effective INT),
  drop/adjust the projection to keep computed stats, or map a different
  field. Fixtures must stop fabricating the missing field once fixed.

### F2 (high) — every sync free-heals; `reconcileVitals` and safe-boundary rules unused

- `src/ui/CharacterPanel.svelte:113-130` — `syncCharacter` always calls
  `applyImportedProfile(session.state, profile)` (full vitals reset) and
  never `reconcileVitals` (which prevents healing outside a safe boundary,
  but still does not prevent repeated healing at a safe boundary).
- No `atSafeBoundary` check anywhere in UI/game code — sync works
  mid-expedition and restores HP/MP to profile values on **every** press.
- Root reproduced: re-applying an unchanged profile heals hp 1 → 41.
- Calling `reconcileVitals` with that same unchanged profile at a safe
  boundary also heals hp 1 → 41. Wiring this function alone will not fix
  repeated-sync healing; reconciliation needs to compare against the prior
  imported profile and distinguish genuine external healing from unchanged
  Habitica vitals.
- Violates the plan rule "Manual sync must not heal the player repeatedly or
  reset combat; reconcile at safe boundaries".

### F3 (high) — vitals regeneration ignores provenance; imported low-HP difficulty erodes

- `src/game/scenes/WorldScene.ts:771` — mana regen (+5/s) unconditional.
- `src/game/scenes/WorldScene.ts:774` — village HP regen (+1.2/s) whenever
  `hp > 0`, no `vitalsSource` check. Imported 3.2/50 HP quietly climbs in
  town and mana refills everywhere; combined with F2, imported difficulty is
  cosmetic. Rule needed: what imported vitals may regenerate locally
  (`Session` now tracks provenance — `src/game/session.ts:49-60`).

### F4 (medium) — effective stats computed but unused in gameplay; gear always 0

- `src/game/scenes/WorldScene.ts:575-579` — `getDemoStats` reads the
  `demoStats` registry (`DEMO_CHARACTER`) for cast scaling; the mapped
  `HabiticaProfile.stats` (statsComputed formula, `mapping.ts:64-97`) never
  reaches combat or abilities.
- `src/ui/habitica-local.ts:38-44` — `emptyGearStats` makes every effective
  stat gear-less (documented in-UI), so even displayed stats undercount vs
  `statsComputed`. Class kit/abilities from `profile.class` not implemented.
- Partial: "Make it your character" still needs imported stats/class to
  drive combat, plus a gear-stat catalog snapshot.

### F5 (medium) — X-Client tag uses the player's id, not the tool creator's

- `src/ui/habitica-local.ts:27` — `clientTag: \`${userId}-${CLIENT_APP_NAME}\``
  where `userId` is the authenticated player's. API usage guidelines require
  the **tool creator's** Habitica user id + app name. Harmless while the only
  user is the developer's test account; wrong (and possibly blocked) once
  others use the tool. Needs a fixed creator id in config.

### F6 (medium) — after a successful sync, Sync button silently no-ops

- `src/ui/CharacterPanel.svelte:129` — `forgetCredentials()` on success while
  `connection` stays `'connected'`; `syncCharacter` (`:113-114`) then
  `return`s silently when credentials are gone. No re-auth prompt, no error —
  "Sync" appears connected but does nothing. Root confirmed.

### F7 (low) — zero imported HP has no explanatory state or adventure gate

- `applyImportedProfile` (`sync.ts:25-35`) permits `hp = 0`; plan requires an
  explanatory zero-HP state and keeping only village activities available
  when too injured. No gate found in `WorldScene` (defeat recovery triggers
  only on new damage, `WorldScene.ts:600`) and no UI state for it.

## Verified good (no action)

- **Credential boundaries**: in-memory only (`habitica-local.ts:17-37`),
  cleared on sync success/disconnect, input fields wiped on connect
  (`CharacterPanel.svelte:108-110`), static error copy (`habitica-local.ts:47-66`),
  saves/exports sanitize profiles via the gear-slot whitelist
  (`mapping.ts:sanitizeStringMap`), `overwriteCorrupt` now wired
  (`CharacterPanel.svelte:86`).
- **Zero Habitica writes**: `HabiticaClient` is `fetchProfile`-only
  (`client.ts`); one GET per press with in-flight guard
  (`CharacterPanel.svelte:113-117`); no per-frame/event requests anywhere.
- **Defeat recovery is wired correctly**: `session.ts:145-156` uses
  `resolveDefeatRecovery` — imported saves get the 25% HP / 50% mana rule,
  demo saves full restore. (Not a gap.)
- **Save v2**: provenance persistence, v1 migration, provenance preservation
  on gameplay saves (`save.ts`), import/export round-trip with profiles —
  implemented and used by the panel (`CharacterPanel.svelte:49-70`).
- **429 backoff / timeout / typed errors**: implemented (`client.ts`), UI
  copy mapped per kind (`habitica-local.ts:47-66`).

## Remaining M3 work (not started or partial)

1. F1 mapping fix + fixture correction (blocker for everything live).
2. F2/F3: wire `reconcileVitals` + safe boundary into sync; provenance-aware
   regen policy in `WorldScene`.
3. F4: imported stats/class drive combat and abilities; gear-stat catalog.
4. F5/F6: fixed creator X-Client id; post-sync re-auth UX (or hold
   credentials for the connected session and only clear on Disconnect).
5. Character identity rendering: `profile.name`/class/appearance, equipment
   appearance, pet/mount display (currently `DEMO_CHARACTER.name` label,
   `CharacterPanel.svelte:149`).
6. F7 zero-HP explanatory state + adventure gating.
7. Exit the preview flag (`?habitica-ui=preview`, `habitica-local.ts:71-75`)
   once 1–4 land.

## Evidence notes

- Primary-source check for F1: official `website/server/models/user/schema.js`
  (no `stats.maxHealth`) and `website/server/libs/user/index.js:28` (computed
  stats only when `userFields` absent) — confirmed against downloaded sources,
  URL above. No live account requests were made.
- F2 reproduced by Root with unchanged-profile reapply (hp 1 → 41).
- Test baseline: 81/81 green (fixtures include fabricated `maxHealth`, see F1).
