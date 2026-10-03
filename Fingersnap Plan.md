# Fingersnap — Game Plan

Status: Planning; implementation has not started  
Date: October 2, 2026

## Vision

Fingersnap is a free, web-based RPG in which players explore a rich, cute, lived-in world as their Habitica character. Real-world task completion drives character power and earns the Habitica gold that can optionally fund adventures. The game gives that progress somewhere meaningful to go.

The world should feel like people lived here before the player arrived: repaired buildings, local traditions, unfinished projects, family stories, abandoned roads, and places whose appearance reflects their history. Warmth and curiosity guide the tone, with occasional danger and mystery.

## Agreed direction

- Name the world **Fingersnap**.
- Use Svelte, TypeScript, Phaser, and Vite.
- Target browsers first, designing for desktop and phone play from the beginning.
- Make exploration cozy, with light real-time combat and short expeditions.
- Import Habitica character stats, class, equipment, appearance, pets, mounts, and relevant collections.
- Make Habitica task completion the main source of character progression. Combat does not award Habitica or independent character XP.
- Allow adventure-earned utility items and persistent story progress within Fingersnap.
- Use actual Habitica assets where suitable, observing their individual licenses.
- Prefer optional, explicitly confirmed Habitica gold purchases over health writeback.
- Let current Habitica HP affect starting adventure health; keep combat damage and healing local to the RPG.
- Consider checkpoint rewind after the first playable version.

## Core loop

1. Complete tasks in Habitica to improve the character and earn gold.
2. Open Fingersnap and sync the character.
3. Visit the village, talk to residents, choose a quest, and prepare.
4. Optionally purchase provisions or special passage using Habitica gold.
5. Explore, solve small problems, fight creatures, and discover local history.
6. Return with RPG materials, utility items, discoveries, and story progress.
7. Stronger Habitica stats and equipment make later expeditions more approachable.

Free exploration remains available. The first core quest must be playable without spending Habitica gold. Purchases enhance preparation or optional adventures rather than charging for every attempt.

## World and storytelling

### First region

Build one village, a woodland route, and a small ruin. Aim for a coherent 15–20 minute first adventure, with enough detail to invite a return visit.

Working premise: Fingersnap was built through many small acts of care. An old network of lanterns once connected its settlements, but some paths have gone dark and the village remembers only fragments of their purpose. The player helps residents restore a nearby connection and learns why it was abandoned.

This premise is a starting point, not final lore. Avoid making every conversation a productivity lesson; residents should have ordinary lives, disagreements, humor, and interests.

### Environmental storytelling

- Show history through objects: a patched roof, old bridge foundations, a faded route marker, or a garden growing over a former workshop.
- Give recurring residents relationships and small concerns beyond the main quest.
- Change dialogue and visible repairs after quests.
- Let optional discoveries explain the region without requiring long exposition.
- Use a journal for remembered clues, people, and places.
- Prefer a small number of distinct, developed locations over a large sparse map.

### First quest outline

Meet a village resident who needs help reaching an old lantern shrine. Learn basic movement and interaction in town, follow the woodland route, encounter a few creatures, find a clue in the ruin, overcome one guardian, and restore the lantern. Returning to town changes a resident's dialogue and one visible part of the village.

## Character and combat

| Habitica feature | Fingersnap interpretation |
|---|---|
| Level | Adventurer rank and a contributor to combat capability |
| Class | Ability kit: warrior, mage, rogue, or healer |
| STR | Physical strength and melee effectiveness |
| INT | Spell effectiveness and magical interactions |
| CON | Resilience and mitigation |
| PER | Critical opportunities and discovering details or secrets |
| Equipped gear | Starting loadout, appearance, and relevant combat effects |
| Costume/appearance | Preserve the distinction between visual outfit and effective equipment |
| Pets | Selected companion; utility effects introduced gradually |
| Mounts | Outdoor riding and travel |
| Achievements | Recognition and optional dialogue or discoveries |
| Inventory | Collection display plus explicitly supported gameplay uses |

Import broadly, but do not imply every collectible has a unique ability at launch. Identify supported effects in the character sheet. Never consume Habitica inventory when using an RPG interpretation of an item.

Use diminishing returns to keep very different accounts playable while preserving character strengths. Balance exact formulas through playtesting. Avoid counting equipment and buffs twice when calculating effective stats.

Each class gets a distinct basic action and one signature ability in the first playable version. Provide a sensible starter kit for characters that have not selected a class. Encounters should have readable warnings and simple patterns, with forgiving targeting suitable for touch input.

### Health and mana

- Import current Habitica HP as the starting-health constraint for an expedition. Low HP should meaningfully increase difficulty.
- Combat damage, RPG healing, and ability-resource use stay local. They never update Habitica HP or MP.
- Define and explain the conversion between imported health and combat health before implementation; do not obscure low imported health through normalization.
- Do not offer a free reset that repeatedly replenishes expedition resources. Save active expedition health across reloads.
- Manual sync must not heal the player repeatedly or reset combat. Specify reconciliation at safe boundaries and test how genuine Habitica healing, level-ups, and other changes are applied.
- Free village activities remain available when the character is too injured to adventure. Show an explanatory state for zero imported HP rather than attempting any Habitica death or revival operation.

## Account interaction and purchases

### Boundary

Habitica owns character progression and its gold balance. Fingersnap owns maps, quests, adventure inventory, local health, and story state.

The only planned write integration is optional custom Reward setup and redemption for clearly described purchases. Never automatically score habits, dailies, or to-dos, change stats, equip items, cast Habitica spells, or consume Habitica possessions.

### Purchase candidates

- Expedition provisions.
- Passage to an optional island or remote ruin.
- A specialist adventure tool.
- A contribution toward a village restoration project.

These are candidates, not all required launch features. Start with one provision purchase to validate the integration. Prices need playtesting because players' gold balances and earning rates differ significantly. Do not automatically scale prices to a player's balance.

### Explicit consent for every account change

Use Habitica's custom Rewards mechanism rather than directly assigning a new gold balance, subject to verification of the current API behavior. Let a player select an existing suitable Reward or explicitly approve creating a Fingersnap Reward.

Before creating a Reward, show its name, purpose, and cost. Before redeeming it, show the item received, Habitica gold cost, current balance, and expected balance after the purchase. Use a specific action label such as **Spend 10 Habitica gold** and offer Cancel. No remembered blanket approval or silent background spending.

Afterward, show a receipt with the actual result. Prices and balance displayed before confirmation must be refreshed or revalidated when necessary.

### Reliability requirements

- Purchases require connectivity and sufficient funds, with verified server-side behavior.
- Prevent double submission and concurrent local purchase attempts.
- Persist a purchase journal before making a request.
- Grant a local entitlement only when the redemption is confirmed; preserve recovery information if local delivery fails afterward.
- Do not automatically retry a redemption with an uncertain outcome.
- Investigate whether the API supplies enough history or identifiers for reliable reconciliation. If it does not, stop and explain the uncertainty instead of claiming an exactly-once transaction guarantee.
- If reliable integration cannot be established, keep the playable game read-only until the purchase design is resolved.

## Checkpoint rewind — later feature

The player may rewind to an earlier checkpoint after losing too much RPG health. Restoring the checkpoint restores its RPG health and resources, while discarding subsequent RPG progress.

Checkpoints should capture the player position, health, ability resources, local inventory, enemies, quest flags, world changes, and relevant random state. The interface should explain what will be lost before the player rewinds.

**Habitica is outside the rewind.** A rewind never restores Habitica gold, changes Habitica HP, or repeats a purchase request. External purchases remain in a durable ledger outside checkpoint snapshots.

Before implementing this feature, define how purchased provisions behave when rewinding across their acquisition or consumption. A preferred starting rule is to purchase at safe locations and establish a new checkpoint there, so rewinds cannot duplicate paid goods or erase an entitlement. Test this explicitly.

Checkpoint rewind is deferred. The first playable version needs a simple local defeat/recovery rule, selected during combat prototyping, that does not spend Habitica resources.

## Technical architecture

| Layer | Choice | Responsibility |
|---|---|---|
| Game runtime | Phaser | Scenes, rendering, movement, collisions, combat, animation, audio |
| Interface | Svelte | Dialogue panels, character sheet, inventory, journal, settings, purchase confirmation |
| Shared logic | TypeScript | Character mapping, quest state, combat rules, item definitions |
| Tooling | Vite | Development and production bundling |
| Maps | Tiled-compatible JSON | Terrain, objects, collisions, interactions, scene transitions |
| Content | Structured data files | Dialogue, quests, item effects, NPC definitions, lore |
| Persistence | IndexedDB | Versioned local saves and purchase journal |
| Backup | Export/import | Portable saves, excluding credentials |
| Integration | Habitica adapter | Narrow reads, validated character mapping, approved Reward operations |

Keep the frame-by-frame game loop in Phaser. Send meaningful state changes to Svelte rather than copying every movement update into interface state. Keep story content separate from engine code.

Start without game accounts or a database server. Verify direct browser access to Habitica, including CORS and required headers, before committing to this architecture. Introduce a narrowly scoped backend only if necessary, with an explicit credential-storage design.

Keep API tokens in memory by default. Never embed them in code, URLs, logs, analytics, save exports, or source control. The token has broader access than our read-mostly game needs; enforce the intended boundary in the adapter and do not describe the credential itself as read-only.

Use minimal user fields, an appropriate X-Client identifier, manual or conservative sync, rate-limit handling, and backoff. Avoid per-frame or combat-event API requests.

### Mobile considerations

Design touch controls alongside keyboard controls. Keep dialogue readable, account for screen edges and safe areas, pause on interruptions, and save at important transitions. Test performance on a real phone early.

Desktop and mobile browsers are the first targets. Installable web-app behavior, offline asset caching, and native mobile packaging are later decisions. Local saves do not automatically sync across devices; explain that limitation and provide backups.

## Artwork and distribution

Plan a free, noncommercial release using suitable existing Habitica artwork. Free access alone does not settle every noncommercial-license question; revisit licensing before advertising, sponsorship, monetization, or commercial partnerships.

- Habitica source code: GPL v3.
- Original Habitica artwork/content: CC BY-NC-SA 3.0.
- BrowserQuest-derived artwork/content: CC BY-SA 3.0.

Maintain an asset register with source, license, attribution, and modifications. Keep notices and license links available in credits and the repository. Adapted assets retain the applicable share-alike conditions. Choose a license for our own code separately; do not assume the art is GPL or that its license automatically defines the code license.

Inventory existing sprites before promising directional walking or attack animations. Avatar layers may need composition and restrained animation; additional terrain and animation work may be necessary. Track original and third-party additions individually.

Plan publicly reviewable source for use by others, as required by Habitica's API guidelines. Present Fingersnap as an independent project without implying official endorsement.

## Build milestones

### 1. Verify foundations

Verify browser API access, character-field interpretation, asset availability and licenses, sprite composition, and custom Reward semantics. Prototype one rendered character and movement with a demo profile. Record unresolved purchase risks before enabling writes.

Exit: a technically grounded integration design and a controllable character in the browser.

### 2. Build a playable world slice

Create the village, woodland route, and ruin with scene transitions, collisions, interaction, one quest, readable dialogue, and one visible persistent world change. Add local saves and a demo mode that needs no Habitica credentials.

Exit: the first quest can be played from start to finish and resumed after reload.

### 3. Make it your character

Add real Habitica import, class abilities, stat mapping, equipment appearance, a selected pet follower, and outdoor mount riding. Implement combat, a few enemies, one guardian, imported starting health, local defeat recovery, and sync reconciliation.

Exit: different classes and builds feel different, and ordinary gameplay causes no Habitica writes.

### 4. Add one deliberate purchase

Implement approved Reward linking/setup, one provision purchase, clear confirmation, receipts, and the purchase recovery journal. Keep read-only play available.

Exit: cancellation changes nothing; confirmed purchases charge and deliver correctly; uncertain outcomes do not trigger silent retries.

### 5. Polish and release

Improve art cohesion, sound, feedback, environmental details, mobile controls, loading/error states, backups, credits, and onboarding. Publish a free playable version with publicly reviewable source once the required checks pass.

Exit: the complete first adventure is usable on desktop and phone, with clear account boundaries and no unresolved asset notices.

### Later

Checkpoint rewind, additional regions and quests, deeper pet utility, more collection-specific interactions, optional task-linked bonuses, installable/offline support, and cross-device saves. Multiplayer and native app-store releases are outside the first version.

## Verification priorities

- Full quest completion, reload/resume, and save migration.
- Representative low-level, high-level, classless, low-HP, and varied-equipment profiles.
- Stats and buffs counted correctly; imported gear not consumed or changed.
- No writes during sync, combat, defeat, healing, or demo play.
- Purchase cancellation, insufficient funds, stale balance/price, repeated clicks, timeouts, and failed local delivery.
- Credentials excluded from logs and exports.
- Keyboard and touch play, phone performance, screen interruption, and readable menus.
- Rewind snapshot consistency and purchase isolation when the later feature is introduced.

## Remaining design decisions

Resolve these during prototyping rather than adding a new approval round for every implementation choice:

- Exact health/stat curves, ability costs, and imported-health reconciliation.
- The first version's local defeat/recovery rule.
- Initial purchase price and which Reward setup path is most understandable.
- Available avatar animation and terrain assets.
- Final village name, residents, region history, and quest dialogue.

## Reference sources

- [Habitica API documentation](https://apidoc.habitica.com/)
- [Habitica API usage guidelines](https://github.com/HabitRPG/habitica/wiki/API-Usage-Guidelines)
- [Habitica code and asset licenses](https://github.com/HabitRPG/habitica/blob/develop/LICENSE)
- [CC BY-NC-SA 3.0 terms](https://creativecommons.org/licenses/by-nc-sa/3.0/)
- [Habitica reward-scoring implementation](https://github.com/HabitRPG/habitica/blob/develop/website/common/script/ops/scoreTask.js)
- [Official Phaser/Svelte/TypeScript/Vite template](https://github.com/phaserjs/template-svelte)
- [Tiled custom properties](https://doc.mapeditor.org/en/stable/manual/custom-properties/)

API and license details must be verified against the assets and endpoints actually used during implementation.
