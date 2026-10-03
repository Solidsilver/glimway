# Runtime import notes — consuming HabiticaProfile in the game runtime

Owner: game-runtime agent (snap_runtime). Current state of the M3 wiring
("Make it your character") against the shared foundation
(`src/lib/habitica/*`, contract: `docs/import-contract.md`). No preview flag:
the connect UI is part of the normal Character panel.

## Wired now

- **Connect panel** (`src/ui/CharacterPanel.svelte` + `src/ui/habitica-local.ts`):
  credentials → `HabiticaCredentials` with `clientTag
  '<creatorId>-fingersnap'` where `<creatorId>` is the fixed PUBLIC creator id
  `5abfd539-22eb-457f-8e2a-9fb3d66731f1` (built-in default, overridable via
  `VITE_HABITICA_CREATOR_ID`; never the player's id — that travels in
  `x-api-user`) → `createHabiticaClient({ credentials })` (bundled 1860-item
  gear catalog is the client default) → one explicit `fetchProfile()` per
  button press. Credential fields are wiped after connect; credentials live
  only in the module's in-memory holder until Disconnect or page unload.
- **Sync flow** (one click = one GET): `syncProfile(save, profile,
  { atSafeBoundary: true })` from shared logic handles first import, delta
  crediting, rejections, and unchanged profiles. The UI applies the result via
  `session.applySynced(save, generation)` — **persistence-first**: the save is
  written to IndexedDB BEFORE the runtime commits state, so a failed save
  leaves the old state untouched. Outcomes: `committed`, `stale`
  (journey changed mid-flight), `save-failed` (all surfaced in the UI).
- **Cancellation**: Disconnect (available DURING a sync) and Reset/Restore
  bump the session generation; an in-flight sync's guard aborts before commit,
  and a write that already landed triggers a durable re-save of the current
  intent (applySynced stale path). Reset/Restore also `session.destroy(true)`
  BEFORE replacing persistence — a concurrent sync cannot resurrect old state.
- **Provenance UI**: boot uses `loadSaveRecord()`; the panel labels demo vs
  imported (`vitalsSourceLabel`) and shows the imported name/class. Export
  codes carry provenance via `exportSave(state, session extras)` — the session
  is the source of truth, never UI state.
- **Errors** map to friendly static copy per `HabiticaApiError.kind` (auth /
  rate-limited / timeout / network / invalid-response / http) — never raw
  bodies, never token material. Save failures are explicitly messaged
  ("world kept its previous state"), not silent.

## Invariant first: ordinary gameplay causes zero Habitica writes

- Combat damage, healing, mana, defeat, and quest progress mutate only the
  local `GameState` (IndexedDB). Nothing in `Session`, `WorldScene`, or any UI
  flow calls Habitica on gameplay events — the adapter is reachable only from
  the explicit Sync button.
- Manual sync is **one GET per explicit press** ("Sync character"), gated by a
  safety snapshot (`__fsSafety`, read-only) — refused outside the village,
  during scene transitions, dialogue, or with creatures near. The same gate
  applies to the offline sample import. One sync at a time (shared busy
  guard); its persistence is awaited, never dangling.
- No account writes exist anywhere in M3 (custom-reward purchases are M4 and
  out of scope).

## Imported vitals (`vitalsSource: 'imported'`)

- First import replaces demo vitals at the village (`applyImportedProfile`);
  outside it the shared logic rejects and nothing changes.
- **No passive HP refill anywhere for imported vitals** —
  `WorldScene.movePlayer` gates village regen with
  `passiveRegenAllowed(vitalsSource)`. Mana regen is a local ability resource
  and stays for both provenances; sync and reload never reset it.
- Later syncs credit genuine external HP/MP deltas **exactly once** against
  the saved baseline (the stored `importedProfile`); capped deltas still
  advance the baseline (damage + identical sync cannot re-credit); lower
  external vitals clamp local values down; unchanged profiles never refill;
  appearance/stat/gear-only changes update the baseline without moving
  vitals.
- **Zero HP (imported)**: an explanatory lock — expeditions are gated from the
  village, attacks and casts refuse, but village life (NPCs, journal, sync)
  keeps working so a genuine external heal can be synced in. A legacy zero-HP
  save found outside the village may still walk home. No auto revival.

## Defeat recovery vs imported health

- Demo provenance: the M2 rule — full demo vitals in Hearthwick, story kept.
- Imported provenance: the shared provisional rule — wake at
  `min(last imported HP, 25% maxHp)` HP and `min(last imported MP, 50% mana)`
  — zero stays zero, baseline preserved, story kept. Both are local
  operations; there is no Habitica death, revival, or HP write, and a reload
  never heals.

## Class abilities (wired)

- `getCombatKit(profile)` (`src/lib/combat.ts`) derives the kit; the scene
  implements effects: warrior → Slash + Cleave arc, mage → ranged Bolt basic +
  Fingersnap bolt signature, rogue → Stab + Shadowstep dash, healer → Tap +
  Mend (damaging pulse PLUS self-heal — both live numbers). Classless/null
  profiles keep the demo starter (melee slash + bolt).
- Damage and mitigation read the kit only (no scene-side stat math):
  mitigation is a **fraction** (0–0.45, hyperbolic in CON) applied as
  `amount * (1 - mitigation)`, never a flat subtraction. Extreme imports stay
  bounded by the shared diminishing-returns curves.
- The Character panel shows the live kit (ability names, damage, mana cost,
  cooldown, guard %, crit %, heal) plus asset credits.

## Appearance rendering (`src/game/avatar-render.ts` + WorldScene)

- Imported characters render as a STATIC layered Habitica avatar (restrained
  code-driven bob — no walking sprites are claimed for it); the demo hero
  keeps its animated placeholder. Layers follow the official order from
  `avatarLayersFor`; only same-origin cached art (`assetSourceFor ===
  'local'`) becomes Phaser textures — upstream-only layers are skipped and
  reported honestly (toast), never invented or fetched cross-origin.
- Composition: all layers are center-aligned at one uniform scale
  (22px display over the 90px Habitica sprite grid). Mount layers ship on a
  larger 135px canvas with the same art scale, so center alignment reproduces
  the official stacking for the mixed-canvas case — scaling by the first
  layer's height would wrongly shrink the avatar when a mount layer comes
  first.
- Walking layer stack EXCLUDES pet/mount (`visualProfile` clone); a selected
  pet follows as a separate sprite at the avatar scale, and a petless sync
  clears the old follower (no duplicates).
- **Mount riding** (M key, outdoors only; the village auto-dismounts) is
  granted ONLY when both mount layers (body + head) actually load — an
  uncached mount is refused with a clear toast and never becomes an invisible
  speed boost. Dismount and fallback (zero layers load) restore the visible
  hero (alpha 1) — no disappearing hero.
- Rebuilds are epoch-guarded (`avatarBuildToken`): overlapping sync commits,
  ride toggles, and scene shutdowns invalidate older completions so nothing
  composes into a dead scene or double-composes.

## What remains open (not M3)

1. Live-credential validation against the real endpoint (Node-side `.env`)
   once the test account arrives; no real token was used for any of this work.
2. M4: explicit, confirmed custom-reward purchases (the only planned writes).
3. Checkpoint rewind (local-only, outside Habitica).
