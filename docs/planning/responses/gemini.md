# Glimway Planning Response (`docs/planning/responses/gemini.md`)

*Revised after repo verification, cross-agent review, and owner decisions.*

## 1. Summary

1. **Finish the persistence and building backbone across 0.12–0.14 (Holds & Lot Lanterns $\rightarrow$ Three-Tier Lamps & Desire Paths $\rightarrow$ Building, Hearths & Trading), then freeze contracts.**
2. **Keep `0.12` player-focused:** ship Holds and Lot Lanterns first alongside SQLite backups and E2E flake fixes, leaning on the existing `(realm, layer, cx, cy)` `WildsChunkKey` rather than building cave generators early.
3. **Replace punishing upkeep chores with organic presence and zero-loss recovery:** evaluated once a week at the turning, common paths stay open via a single weekly visit ("desire paths"), and lapsed claims pack 100% of placed items into a recovery crate at Pell's office.
4. **Adopt lasting macro geography with turning living details:** the physical shape of the world (lakes, rivers, ridges) endures while unobserved woods, creatures, and paths shift each wick until anchored by lamplight or footsteps.
5. **Combine a "two minutes on a Tuesday" habit loop with multi-pillar weekend play**, keeping Habitica strictly behind its package seam so a commercial Standalone edition can share the exact same world later.

---

## 2. Vision

In six months, Glimway feels like a living, storybook diorama where the ancient shape of the land—its lakes, rivers, and ridges—stands firm, while the untamed woods shift in an unstable superposition until lived in and remembered by your friends. Whether someone logs in for two minutes on a Tuesday to tend their light and check their market stall, or plays for two hours on a weekend, the world carries their history. Hearthwick is a bustling, lag-free hub surrounded by well-worn desire paths leading out to solo way-lamp camps, co-signed forest hamlets, and restored spans. An explorer returning from a Lake Country delve brings rare clay and reeds to a friend who fires pottery and tiles at Aldo's kiln, which a builder arranges inside a custom cottage or trades at a town stall. Under the hood, persistent world schemas are frozen and backed up, supporting both a free Habitica companion for small friend groups and a future standalone commercial RPG.

---

## 3. Next Releases

1. **0.12 — Holds, Lot Lanterns & Safe Keeping (Backbone Part 1)**
   * **Theme:** The first held land—keeping the woods behind your Hearthwick lot across weekly turnings.
   * **Player payoff:** Light your lot lantern with Wick Tree sap oil to hold your backland across the weekly turning, with faster scene arrivals and rock-solid world saves.
   * **Main work:**
     * **Holds Engine:** Chunk metadata pinning `WildsChunkKey` `(realm, layer, cx, cy)` to a saved wick epoch across turnings.
     * **Lot Lanterns & Backland:** Feed your lot lantern sap oil to hold the chunk behind your Hearthwick home (`hearthwick-2.md` §6).
     * **Lasting Macro Geography:** Separate the stable macro landform seed (lakes, river bends, uplands stay put) from the weekly turning seed (trees, plants, creatures, and unheld paths reshuffle).
     * **Backups & Felt Debt:** Automated SQLite backup/restore verification before persistent building lands; fix the two flaky E2E tests (T3, T4), remove `exp/*` from the 45-minute CI trigger if present, and fix the ~680 ms arrival hitch.
   * **Dependencies:** Builds directly on `0.11.2` and existing `WildsChunkKey`.

2. **0.13 — Dimming Lamps, Desire Paths & The Three Land Tiers (Backbone Part 2)**
   * **Theme:** Social light, organic roads, and zero-loss recovery across the open map.
   * **Player payoff:** Walk laid trails with friends to naturally keep common roads open across turnings; set out and name way-lamps in the Wilds (including solo hermit camps) with clear map boundaries showing held, common, and turning land.
   * **Main work:**
     * Rewrite `lamps.md` around the three land tiers (`Wild`, `Common`, `Built`) evaluated strictly once a week at the wick turning.
     * **Common Land ("Desire Paths"):** Laid paths and communal way-lamps record presence during the week—any single visit/use ($\ge 1$) during the wick keeps the path through the turning.
     * **Built Land, Oil Buffer & Zero-Loss Recovery:** Way-lamps and claims use a 2–3 wick oil store with a full wick of dimming warning and communal tending; if a claim finally lapses, the land returns to the turning Wilds while all player-placed items pack into a recovery crate at Pell's office.
     * **Map Layer Clarity:** Show held, common, and turning boundaries clearly on the map (`world-map.md`).
   * **Dependencies:** `0.12` Holds engine.

3. **0.14 — Hearths, Station Chains & Market Stalls (Backbone Complete + Contract Freeze)**
   * **Theme:** Deep home-building, multi-step crafting, player trading, and co-signed Wilderness Hearths.
   * **Player payoff:** Furnish rooms and build custom cottages/gardens (Tier 1 & 2), refine materials across multi-step stations, co-sign a shared hamlet charter in the Wilds, and trade specialized goods at market stalls.
   * **Main work:**
     * **Building Tier 1 (arrange props/furniture) & Tier 2 (compose walls, roofs, windows, floors, gardens)** where every kit piece is crafted (`Craft, then place`).
     * **Station-Chain Crafting:** `Gather → Mill / Kiln → Bench`, unlocked via found library papers.
     * **Wilderness Hearths:** An additional unlockable charter (so Hearthwick lots stay full) requiring 2+ co-signers on multiplayer servers (or 1 player on a solo server) to establish a shared woodland hamlet.
     * **Two-Way Trading:** Resident buyers and async player market stalls (setting the stage for specialized craft systems later), plus per-chunk gathering performance cleanup.
     * **Contract Freeze:** Lock persistent world schemas.
   * **Dependencies:** `0.13` zero-loss recovery crate and three-tier land rules.

4. **0.15 — Chapter 2: Dorrit's Span & The First Expedition**
   * **Theme:** A shared restoration project, unified world lore, and a server-run boss encounter.
   * **Player payoff:** Work together (sync or async) to rebuild Dorrit's Span, follow a deepened lore trail about the Turning and memory, and defeat the first shared boss for unique keepsakes and recipes.
   * **Main work:** Authored drop-in site for Dorrit's Span (generalizing Hearthwick's location hooks where touched); communal material drop-off project; 1 server-run boss with readable telegraphs and non-destructive failure (costs time and glim tool repair, never equipped items).
   * **Dependencies:** `0.12–0.14` backbone and the owner's unified lore pass during `0.13`/`0.14`.

5. **0.16 — Lake Country: Kilns, Reeds & Wild Waters**
   * **Theme:** A complete vertical place expanding crafting, fishing, and shallow delves.
   * **Player payoff:** Explore permanent Lake Country shores, fish in generated waters, descend into shallow $z = -1$ reed-and-clay delves, and fire pottery and new building tiles at Aldo's kiln.
   * **Main work:** Lake Country biome generation, wild fishing nodes (`fishing.md` step 4), Aldo's kiln + pottery/tile recipes (`world.md` steps 3–4), and the first $z = -1$ pocket delves using the existing `layer` field in `WildsChunkKey`.
   * **Dependencies:** `0.14` station chains and `0.12` lasting macro geography.

---

## 4. Answers to Planning Questions

1. **Next releases:** Covered in §3 (`0.12` Holds/Lot Lanterns $\rightarrow$ `0.13` Lamps/Desire Paths $\rightarrow$ `0.14` Building/Hearths/Stalls $\rightarrow$ `0.15` Dorrit's Span & Boss $\rightarrow$ `0.16` Lake Country & Kiln).
2. **Core loop and spine:** The spine has two gears: a **2-minute weekday habit loop** ("tend the light, walk the road, check the stall") and an **interdependent weekend loop** where Explorers/Fighters gather rare materials from delves and bosses, Makers/Fishers refine them through specialized stations, and Builders/Traders turn them into homes, hamlets, and market goods.
3. **Upkeep pressure and loss:** **World impermanence, never item loss.** Judge all upkeep once a week at the wick turning—never on a ticking active-time or calendar-time clock. Keep `Common` roads open whenever any player walks them once during the week, buffer `Built` land with 2–3 wicks of oil and communal tending, and pack 100% of items from lapsed claims into a recovery crate at Pell's office.
4. **Wider or deeper:** Finish the persistence and building depth first (`0.12–0.14`), then expand via **complete places** (`0.15` Span expedition, `0.16` Lake Country shore + kiln + shallow $z = -1$ delves) rather than empty horizontal sprawl.
5. **Using Habitica:** Keep Habitica as **pacing and celebratory reflection** (streaks and achievements shown modestly in-world). Every in-game activity must pass the *"fun with zero XP?"* test so visiting friends, organizing your home, or walking common trails is always free.
6. **Playing together:** Design for **async-first co-op** that scales down to 1 player:
   * One player walking a common trail during the week keeps the desire path open for everyone.
   * Anyone can top up a friend's lamp oil or drop materials into a shared restoration project (Dorrit's Span).
   * Wilderness Hearth charters bring 2+ friends together to co-sign a shared hamlet (while solo players on multiplayer servers can still hold their Lot Backland or a personal Way-Lamp camp, and 1-player servers allow solo charters).
7. **Standalone:** Build **one world with two editions**. Enforce Standing Decision 7 as a strict review rule now ("no new Habitica calls outside `habitica/`") and implement the Standalone economy mode (daily town requests, boss bounties, and market trade with a Rested Glim curve) once the `0.14–0.16` gameplay loops are proven. Keep the Svelte 5 + Phaser 3 client and wrap it in Tauri/Capacitor when ready for Steam/mobile.
8. **What to stop or cut:**
   * **Cut Tier 3 terrain painting/excavation** (stop at Tier 1 props + Tier 2 walls/roofs/floors/gardens + trails).
   * **Cut $z > 0$ bridges (`layers.md` Direction C) and sprawling underground continents** (keep bridges on layer $0$, and use layer $-1$ for focused biome delves in `0.16+`).
   * **Park Baking for a future tactile simulation slice** (rather than shipping a shallow 1-click button now; when it ships later as an engaging sub-system, specialists can bake and sell to friends via `0.14` market stalls).
   * **Park "The Old Ways" (level-30 mage capstone), broad class-locked magic, Habitica party goals, and weekly wick reports.**
   * **Prune stale docs:** Delete `plan.md`'s release table, fold `build-status.md` into `CHANGELOG.md`, and rewrite `lamps.md`.
9. **Process:** Ship **one primary player-facing promise per release** (`0.12` backland holds, `0.13` way-lamps & desire paths, `0.14` building & stalls), fold felt tech debt and backups inside feature releases, reinstate the mandatory step-back review after each release, and keep a docs lane one release ahead (starting with the `lamps.md` rewrite during `0.12`).

---

## 5. Disagreements with Written Roadmap & Standing Assumptions

1. **Lasting Macro Geography (Overturning Open-Map Decision 18 "Everything turns"):** The physical shape of the world (lakes, rivers, ridges) stays put across turnings while unobserved living details (trees, forage, creatures, unheld paths) exist in shifting potential until anchored by lamplight or footsteps. This gives both gameplay (lakeside hamlets, mountain trails) and lore a cohesive foundation.
2. **Desire Paths + Weekly Turning Judgment + Zero-Loss Crates (vs. `lamps.md` oil-loss):** Judging upkeep once a week at the turning settles the calendar-vs-active clock split, `Common` roads kept alive by a single weekly footstep prevent upkeep chores, and packing lapsed `Built` items into Pell's crate prevents cozy players from ever losing crafted work.
3. **Additive, Co-Signed Wilderness Hearths (vs. Hearth H3 moving your town deed):** Moving a deed out of Hearthwick empties the town hub in a small group. Making a Wilderness Hearth an additional charter co-signed by 2+ players (or 1 on a solo server) preserves a lively town while making wilderness hamlets a true group project.
4. **Splitting Chapter 2 / Expedition (`0.15`) from Lake Country (`0.16`):** Rather than gating Dorrit's Span behind all of Lamps and The Old Ways, or cramming the Span, a boss, and Lake Country into one mega-release, split them into two tight vertical slices after `0.14`.

---

## 6. Risks

* **Desire-path decay in quiet weeks:** If nobody walks a path during a busy real-life week, it turns. Mitigation: require only a single visit ($\ge 1$ step) during the week for `Common` paths, and allow players to pin key crossroads with a tended way-lamp (2–3 wick buffer).
* **Economy inflation between Habitica XP and player stalls:** High-XP Habitica players could flood stalls with glims. Mitigation: use market stall listing fees, building upgrades, and delve tool repair costs as natural glim sinks.
* **Speculative refactoring slowing down features:** Generalizing Hearthwick's ~10 Go files too early could stall `0.12`. Mitigation: defer region-stamp extraction until `0.15` when Dorrit's Span / the first Wilds outpost actually touches those files.

---

## 7. Resolved Owner Decisions (Locked In)

1. **Lasting macro geography:** **Approved.** Major lakes, rivers, and ridges stay put across weekly turnings while living details, plants, creatures, and unheld paths reshuffle ("the shape of the earth endures; unobserved history shifts until lived in").
2. **Release order:** **Approved.** `0.12` (Holds, Lot Lanterns, Backups, Flaky Tests) $\rightarrow$ `0.13` (Dimming Lamps, Desire Paths, Zero-Loss Crates) $\rightarrow$ `0.14` (Building Tiers 1–2, Station Chains, Wilderness Hearths, Market Stalls) $\rightarrow$ `0.15` (Dorrit's Span & Boss) $\rightarrow$ `0.16` (Lake Country, Kiln & Shallow Delves).
3. **Wilderness Hearth charters:** **2+ co-signers on multiplayer servers (1 on solo worlds).** Solo hermits on multiplayer servers still have their Lot Backland (`0.12`) and personal Way-Lamps (`0.13`) to hold a quiet camp in the woods.
4. **Lore pass:** **Scheduled as a dedicated owner pass before `0.15`.** Will weave the existing world concepts together more tightly around memory, light, and the Turning without throwing out established foundations.
5. **Baking & tactile craft sub-systems:** **Parked for a dedicated simulation slice.** Rather than shipping baking as a simple click-to-craft button now, it will come later as an interactive simulation system that specialists can master and trade via `0.14` market stalls.

---

## 8. Sources

* `docs/planning/direction-overview.md`
* `docs/planning/brief-detail.md`
* `wishlist.md` (Owner workshop synthesis across Claude, Sol, and MiMo)
* Cross-agent code verification (`ci.yml`, `proto/glimway/v1/wilds.proto`, `docs/design/layers.md`)
* Referenced design docs via brief: `CHANGELOG.md`, `docs/design/location-seam.md`, `docs/design/lamps.md`, `docs/design/hearthwick-2.md`, `docs/design/one-town.md`, `docs/design/seamless-world.md`, `docs/design/open-map.md`, `docs/design/world-map.md`, `docs/design/shared-fights.md`, `docs/design/quests.md`, `docs/design/world.md`, `docs/design/magic.md`, `docs/design/fishing.md`, `docs/standalone-clients.md`, `docs/reviews/2026-10-13-step-back.md`, `docs/reviews/2026-10-13-refactor-plan.md`