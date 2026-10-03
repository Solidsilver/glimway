# M3 playtest — import, avatar rendering, class combat (October 3, 2026)

Tester: snap_runtime via Playwright (Chromium) against the dev server
(localhost:5173) and the production preview (localhost:4173). Movement, combat,
panel open/close, and touch were driven with **real keyboard presses, held
keys, and pointer/touch presses**. The only network interception was the
`GET /api/v3/user` endpoint (fulfilled with fixture payloads modeled on
`src/lib/habitica/fixtures.ts` — realistic projected `/user` data, **no real
credentials, no real Habitica requests**) and, in two labeled scenarios,
`/assets/habitica/*` (blocked to simulate an empty art cache). Map fixtures
were seeded through the **normal Restore UI** (valid format-2 save documents
pasted into the Character panel's import box) at known open-ground positions —
recorded per scenario below. `__fsPlayer` / `__fsEnemies` / `__fsSafety` /
`__fsDebug` are read-only handles (positions/hp/kit/flags — nothing mutated).

Verify status at time of writing: `npm run verify` green — typecheck clean,
svelte-check 0/0, **135/135 tests pass**, production build succeeds.

## Import & health policy (all via real UI: Connect → Sync)

| Check | Result |
|---|---|
| First import (village, warrior fixture) | ✅ HP 41/50, MP 20/46, name/level/class shown, kit switches from starter to warrior (Slash ~11 / Cleave ~14.67 / cost 12 / guard 7%) |
| Repeat sync, unchanged profile, after damage | ✅ "Profile unchanged — no refill applied."; HP stayed 20/50 (damage taken in Brackenwood first) |
| Reload after damage | ✅ HP persisted lower (29 ≤ 36 — extra hits before the decrease-save; reload never healed); credentials wiped on reload by design (pagehide) |
| Genuine external heal, credited once | ✅ profile hp 41→45 vs baseline: "external HP +4 credited once" (20→24) |
| Re-sync same healed profile | ✅ "Profile unchanged" — the advanced baseline cannot re-credit |
| Over-max external heal (hp 60) | ✅ "+15 credited once" applied up to the headroom (24→39), baseline advanced |
| Sync outside the village | ✅ "Return to Hearthwick to sync." — no request applied |
| Wrong account id | ✅ "That Habitica account is a different character…" — save untouched |
| Disconnect DURING delayed sync (4 s) | ✅ Disconnect visible and enabled mid-flight; after the response resolved: "That sync was cancelled (the journey changed). Nothing was applied." — a full-heal payload was NOT applied |
| Reset demo DURING delayed sync (4 s) | ✅ reload landed on a clean demo save (40/40 demo vitals, "Demo adventurer") — the in-flight import never resurrected || Imported defeat cap | ✅ (live, mid-test) dying to wisps woke at the village well with **13/50** = min(last imported 24, 25%·50) — zero stays zero, story kept |
| Zero imported HP | ✅ HUD banner "Too injured to adventure — village activities only…"; expeditions gated (6 s of pushing west stayed in the village); Mara dialogue opened at 0 HP; sync stays available |
| Zero-HP boundary behavior | ✅ fixed during this playtest: the blocked exit no longer permits off-map wandering — the player is held at the world bounds (x=6), hero visible, no softlock |

### Delayed persistence (real IndexedDB delay, staged in-browser)

For these three the harness wrapped `IDBObjectStore.prototype.put` for the next
`current`-save request: the native write lands on disk immediately but the
`saveGame` promise settles **1500 ms late** (deferred `onsuccess`) — a genuine
delayed-persistence window (no production code involved; hook restored after
each use). The import write was observed landing (`putStarted: true`) with the
RAM state still demo:

| Action during the 1500 ms window | Disk truth after settle + reload |
|---|---|
| **Disconnect** | ✅ RAM never committed (40/40 demo); the stale path DURABLY re-persisted the current intent over the already-landed import write — disk ends "Demo adventurer" 40/40 |
| **Reset demo** | ✅ the reset's fresh demo save (queued last) wins — disk "Demo adventurer" 40/40, no stale baseline |
| **Restore from code** (healer doc, hp 27) | ✅ the restored document wins — disk "Imported adventurer" hp 27/50 healer |

## Class kits (fixture-seeded via Restore UI; real key presses)

| Class | Basic | Signature |
|---|---|---|
| Mage | ✅ ranged Bolt: killed a wisp at range (10→1→dead; no contact) | ✅ Fingersnap bolt cast (mana 90→75, cost 15); damage path shared with the verified bolt |
| Rogue | kit shown (Stab ~9.8 / crit 19%) — same melee pipeline as the verified slash | ✅ Shadowstep dash: 57 px displacement, clean stop, mana −10; **fixed during playtest**: ordinary movement no longer cancels the dash velocity |
| Healer | kit shown (Tap ~9.8) — same melee pipeline | ✅ Mend: killed the touching wisp with the pulse AND healed +13 (12→25) in one cast |
| Warrior | ✅ Slash killed the touching wisp (10 ≤ ~11) | ✅ Cleave cast (mana −12); single wisp in reach, damage path shared |

Panel ability labels/credits: kit names, damage, mana, cooldown, guard %, crit
%, and heal are shown for the live provenance (starter vs imported class); the
panel credits Habitica art (CC BY-NC-SA 3.0) and the gear catalog (GPL v3).

## Avatar rendering (screenshots in docs/screenshots/m3/)

| Check | Result |
|---|---|
| Layered avatar composition | ✅ per snap_assets' source-backed verdict (avatar.vue/sprites.css @789bbe4a): all layer canvases share a TOP-LEFT origin; mount canvases shift +18 grid px DOWN, X unchanged — implemented here as mount-center at (+22.5, +40.5)·s from the shared center. Verified visually after the fix: the rider SITS on the wolf's back, wolf head forward-left, mount canvas overhangs right/down (mounted-seat-fix.png). Center-aligning the 135 px canvas (the first attempt) put the hero beside the wolf — wrong, corrected. |
| Pet follower | ✅ separate trailing sprite at avatar scale; petless states clear the old follower (no duplicates) |
| Costume visuals | ✅ useCostume renders the costume weapon (visuals only; stats still read equipped) |
| Mount riding outdoors | ✅ M grants riding ONLY when body+head layers load (speed 156 px/s observed); village M is refused ("No riding in the village…") |
| Village auto-dismount | ✅ "You dismount at the village gates." |
| Uncached layer (yeti weapon, upstream-only) | ✅ honest notice "Some Habitica layers are not in the local art cache — they are skipped from this avatar."; avatar still composed from cached layers |
| Full fallback (all art blocked) | ✅ "Placeholder avatar — official layers unavailable…" and the demo hero is RESTORED visible (alpha 1 — no disappearing hero) |
| Static bob, no walk claim | ✅ avatar is static with a restrained bob; walking animations remain the demo hero's |

## Panel keyboard regression (root-caused and fixed this session)

The panel's own C/Escape listeners only toggled a LOCAL flag: the overlay hid
while App's `characterOpen` (and `uiState.panelOpen`) stayed true — the world
stayed paused with an invisible panel, and J had the same latent bug in
JournalPanel (whose overlay could never show at all). Fixed: App owns J/C/
Escape globally (ignoring text-field targets for J/C so typing credentials
never toggles; Escape always closes, even from a focused field), panels mount
already-open and close only through App state. Verified: C opens, Escape
closes, movement resumes after close (66 px walked), C toggles closed,
Journal opens VISIBLE and Escape closes it, typing `abcCJe123` in the User ID
field types every character (including C, J, e — Phaser's key capture no
longer eats them) and toggles nothing, Escape from the focused field closes.

## Production preview (built bundle, localhost:4173)

✅ Connect → Sync → first import on the production bundle: HP 41/50, MP 30/90,
mage kit, layered avatar + pet follower composed (`avatar: true, pet: true`).
No dev-only source paths involved.

## Phone layout (390×844, touch emulation)

✅ D-pad ("Move up/left/right/down") + "Action" / "Cast ability" buttons
visible; a real touch press-and-hold on "Move right" drove the hero (~69 px,
stopped by the well collision as expected). Screenshot: phone-layout.png.

## Honest limits

- **No real account**: every /user response was an intercepted fixture. No
  token was supplied, so live-endpoint behavior (auth, rate limits, real
  payloads beyond fixtures) is unverified.
- **Delayed persistence** was then closed with a real IndexedDB put-hook (see
  table above): Disconnect / Reset / Restore all exercised during a genuinely
  delayed save completion, with disk truth verified after reload. No
  production code was changed for this.
- The full-cap case (delta capped exactly at max HP) is pinned by shared unit
  tests ("capped delta still advances the baseline"); live checks covered the
  headroom and baseline-advance paths.
- Warrior Cleave and mage Fingersnap damage values were not directly observed
  hit-by-hit in-world (no second creature in reach at cast time); their cast,
  mana cost, and the shared damage pipeline were verified, and the numbers are
  unit-pinned in tests/combat.test.ts.
- Console showed the expected loader errors only in the deliberate
  art-blocked fallback scenario (one per aborted image).
- Screenshots: docs/screenshots/m3/ (import-panel-warrior, warrior-combat,
  imported-defeat-cap, zerohp-village, zerohp-npc-dialogue,
  zerohp-gated-at-boundary, pet-follower-costume, mounted-woodland,
  mounted-seat-fix, village-auto-dismount, partial-cache-avatar,
  full-fallback-hero, phone-layout, phone-touch-drive,
  production-preview-import, production-preview-avatar).
