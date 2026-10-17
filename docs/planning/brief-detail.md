# Glimway planning brief (2026-10-16, dev at fe0aab12)

Paths are relative to the repo root. CL = CHANGELOG.md.

## 1. What's shipped

- **0.1** (10-07): the lantern road quest, telegraphed combat, guest or Habitica play with embers from XP, invite worlds, homesteads on the Commons, the shared Tangle, gathering and crafting, the calendar and festivals, 52 papers, phone controls.
- **0.2** (10-08): versioning, the "What's new" card, a reload prompt for new versions, steadier prompts.
- **0.3+0.4** (10-09; 0.3 only went out as pre-releases): the server owns the world, Habitica-only sign-in, an offline outbox, sound, full-resolution phones, walk-in interiors (Hazel, Finn's mill and loft, the library, your cottage), resident hours, a Quests page with a pin, a new opening.
- **0.5** (10-09): companion and yard pets, the stable and riding, level-20 second moves, Fingersnap becomes mage-only, fishing at the mill pond.
- **0.6 / 0.6.1** (10-10): the Habitica gold purse, priced gate shelves, gold in letters, the Habitica wardrobe. In 0.6.1, glims replace both embers and gold.
- **0.7** (10-10): Silas's Yard becomes a walk-in shop, and Pell's office handles deeds.
- **0.8** (10-11): the open map. Seamless Wilds, meadow, the Wend and its fords, the Lantern Road with dark lamp stones, wick turning, the drift frontier, laid paths and named ways, landmarks, first finders, Elara's rumour.
- **0.9 / 0.9.1** (10-13): the server runs camp fights shared between players. Full-screen map on M, riding moves to V, beetles scuttle, camps leash.
- **0.10** (10-14): the Commons and the Tangle are one walk, with safe ground.
- **0.11 / .1 / .2** (10-15/16): Hearthwick is one seamless market town round the Wick Tree, with eight lots at the woods' edge. Then a smaller source archive, and stepping stones on bent fords.

## 2. Roadmap as written (agreed, not built), in order

The current order is in `docs/design/location-seam.md` §0 #5: join (done in 0.10) → one town (done in 0.11) → **holds engine → dimming Lamps → hearths**. After that comes plan.md's "Then, as revisions" list.

1. **Holds engine**: a "held" chunk source that keeps one epoch across turnings (location-seam §0 #2). *It has no design doc of its own.*
2. **Lot lanterns and backland**: a lit lantern holds the chunk behind your lot, fed by Wick Tree sap oil (`docs/design/hearthwick-2.md` §6, §9 #1). It waits on holds.
3. **Lamps**: the Keeper's hand, way-lamps, Name a lamp, the turncap and the ash pouch (`docs/design/lamps.md`). **Stale:** still titled "0.9", with owner questions Q1–11 unanswered. Its Q7 ("for good inside lamplight") is overridden by dimming lamps with oil upkeep (location-seam §0 #6). Its Journal tab became a map layer (`docs/design/world-map.md` §6). Its coordinates, homing target and migration/contract numbers predate one town. plan.md's table still lists Lamps as 0.10.
4. **Hearths**: a home's hearth holds its plot, and a household can later move its deed to a Wilds site (location-seam §0 #7, `docs/design/one-town.md` §3.3, seamless-world H3). *Not designed.*
5. **Chapter 2, Dorrit's span**: lamps.md Q10 puts it straight after Lamps (`docs/design/quests.md`, "Chapter 2"). The docs disagree on where the crossing stands: lamps.md says it stays in the Tangle, quests.md says fixed open-map coordinates. The quests build-order table still says 0.3/0.6/0.8.
6. **Lake country**: water, reed and clay, Aldo's kiln and pottery, fishing in generated waters, level-10 workings on an obstacle catalogue (`docs/design/world.md` build steps 3–4 and 6, `docs/design/magic.md` step 2, `docs/design/fishing.md` step 4). The release numbers are stale: fishing says 0.6, and magic puts Name a lamp in 0.8.
7. **The rest of Lamps**: the Old ways (mage level 30) and the clay base (lamps.md §6, magic.md step 5).
8. **Caves and the next lands** (`docs/design/layers.md` steps 7–8, world.md steps 7–8).
9. **Standalone, later**: guest steps 3, 5 and 6 (`docs/design/guests.md`), done as a server mode rather than a fork (`docs/standalone-clients.md`).

Also: plan.md's "step back after each release" has no review in `docs/reviews/` for 0.10 or 0.11 (the newest is 10-13), and magic.md still lists the bolt's name as open though plan.md settled it.

## 3. Parked ideas (maybe / later)

- **Habitica and economy** (`docs/ideas.md`): streaks and achievements in the world; party goals fed by Habitica tasks; more making and mending at home; human-made art and our own versions of Habitica's.
- **Story and world:** chapters 3 and on, with Sallow Ford (quests.md); more resident routines; a second settlement or west destination (`docs/design/seamless-world.md` D, `continuous-village.md` §10); Brackenwood and Ashwatch as Wilds outposts (location-seam §0 #9); a Wick Tree lantern per completion (hearthwick-2 §9 #3); the Tops and creatures by land (`docs/design/open-map.md` §7).
- **Fights** (`docs/design/shared-fights.md` §5): enemies that cross chunks, bosses, more cheat-proofing.
- **Pets** (`pets.md`, `crafts.md`): "companions with a nose", a pet that leads you home, residents who notice pets, stable decorating.
- **Fishing** (fishing.md): home water and ponds, docks, ice fishing, a fish journal.
- **Magic** (magic.md, lamps.md §6): level-15 workings; Brace, Sense the turning and the Mended glade; two-player naming; cracked lamps; lamps in caves.
- **Social** (ideas.md): a party board, who's online and where, gifts flagged for the party, a Commons stall.
- **UI** (world-map.md §6): a desktop minimap; pins, party marks and a forecast layer.
- **Platform:** error reporting, metrics and DB backups ("agreed" in ideas.md, in no release); WebP; WebTransport; `docs/scaling.md` steps; native clients (`docs/standalone-clients.md`).

## 4. Open design questions

- **Lamps:** Q1–11 (lamps.md §0), plus the dimming numbers: oil burn, the oil store, and how much land upkeep allows (location-seam §7 #7, "Open").
- **Built things under dimming:** plan.md disagreement #1 says what's built with materials in lamplight lasts for good. Does that survive dimming?
- **Housing:** hearth plot size, lot count, outposts (location-seam §7 #7); growth past eight homes (§0 #10); remote claims when a deed lapses, whether they need public light, and whether all members must approve a move (seamless-world, "Recommendation").
- **The next settlement:** an outpost or a town, and what the west road leads to (continuous-village §10).
- **A non-Habitica economy:** glims without Habitica (ideas.md, quests.md Q1, standalone-clients.md).
- **world.md's questions:** kiln firing time, how difficulty and lamp cost grow with distance, the other lands.
- **Smaller:** Unmoored starts too close to town (open-map §7); map behaviour in a fight, the carter's map, minimap default (world-map §11); whether a menu should stop local hurt (step-back, rejected findings); where chapter 2's crossing stands.

## 5. Tech debt and backlog

- **Flaky E2E:** onboarding remember/forget (T3) and an inventory focus escape (T4) have unknown causes; 0.9's green CI needed three retry passes (`docs/reviews/2026-10-13-step-back.md`). The full E2E job now takes up to 45 minutes (CL 0.11.0).
- **Refactor plan stages 7–14 not done** (0.10 shipped "stages 1–6, first slices"): story/placement sharing, typed refusals, a backend domain extraction, the queue's owner, Inventory/HUD/App extractions, folders (`docs/reviews/2026-10-13-refactor-plan.md`). Its four clean breaks were approved on 10-13; whether they're done isn't recorded.
- **Duplicated rules:** prediction rules still live in both Go and TS (standalone-clients.md).
- **Performance:** gathering re-registers every chunk change (~4 ms, odd frames over 50 ms; open-map §7); phone scene build 0.4–0.5 s (ideas.md); a first-pass texture hitch (one-town §7.2); reloads can put you about 1 s back.
- **Look and feel left from 0.8** (open-map §7): tall lamp stones, ford shallows, the Whitequiet's straight edge. Check whether these were fixed.
- **Not applied:** off-hand `light`, `wisps-keep-off` and `compass` exist in content only (lamps.md §6).
- **Scaling:** one SQLite connection, `synchronous=FULL`, a 128-connection cap; only fights load-tested (scaling.md).
- **Trust gaps:** Unmoored runs on the client, story flags are client-writable, no wall checks on movement, hurt judged on the player's screen (shared-fights §5).
- **Stale docs:** `docs/build-status.md`, world.md's "Today", lamps.md, plan.md's table, and the release numbers in fishing, magic and quests.

## 6. My read: the biggest forks (opinion)

1. **Holds and dimming Lamps next, or content first** (chapter 2, town life). Lamps make the land-keeping loop the spine of the game. Content first gives friends more to do sooner. Lamps also need their doc rewritten before any lane starts.
2. **Upkeep pressure or cozy permanence.** Dimming lamps and lapsing holds bring chores and loss into a cozy game. Deciding how harsh upkeep is sets the game's whole character.
3. **Wider or deeper.** Lake country, caves and the Tops spread effort across the map. Residents, quests and the one town make a small place richer, and that suits small invite worlds.
4. **Habitica companion or standalone game.** A server mode with its own economy, then native clients, is a product change. Staying Habitica-only keeps the boundary simple and the audience tiny.
5. **Players before systems.** Only the owner plays (memory, and plan.md item 8). Bringing in the friend group now would test the social and shared systems (fights, shelves, holds) before more get built on them. It would also end the cheap clean breaks.
