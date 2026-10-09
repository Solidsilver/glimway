# 0.5 Crafts

Status: **design, confirmed by the owner**, 2026-10-09 (all eight defaults in section 11 taken). Written from the code at `1bbb7c7` on
`exp/design-05`, which is `expansion`: 0.4 plus One schema. The owner's earlier decisions are in
[plan.md](plan.md) (the 0.5 row, "One schema", "Art, by release"), [pets.md](pets.md),
[magic.md](magic.md) and [fishing.md](fishing.md), each dated there. Everything here follows
[server-first.md](server-first.md): the server owns state and rules, the client predicts and
draws, and operations are idempotent. Defaults for anything still open are in section 11.

**The aim.** Your Habitica companions get somewhere to live and something to do: a pet you choose
walks with you, three more live at home, and a stable at home is where your mount stands and where
riding starts. Heroes learn their craft by level: the four signatures stay, a second combat move
arrives at level 20, and heroes without a class fight with what's in hand. And there's a quiet bank
at the mill pond, a rod from Finn, a fish, and a supper Hazel shows you how to make.

**Four rules for this release:**

1. **The game shows Habitica's companions; it never makes or grants them.** Every pet and mount
   key is checked against the owner's latest owned list when someone looks.
2. **Whatever is shared is the server's.** The stalls, which mount is out, the fish in the pond
   and the mana a move costs are server state. Where a pet wanders, how fast a mount runs and how a
   fight goes stay on the screen, as they are today.
3. **Time is worked out, never ticked.** Fish recovery, a cast's bite, a yard pet's wander and a
   lapsed choice are functions of the clock, computed when someone looks.
4. **One new shared table, with its first writer.** The world-changes table the plan put in 0.5
   arrives with the mill pond's stock. Nothing else in 0.5 writes to it.

---

## 1. Scope

### In 0.5

| Piece | From | Notes |
|---|---|---|
| Pets 1: fixes and friends | pets.md build step 1 | The `-1` ownership fix, the follower's motion (hop, turn, sit, settle), friends' pets and mounts drawn |
| Pets 2: Companions | pets.md step 2 | A Companions tab in the Character panel: choose your follower from owned pets once you have a homestead |
| Pets 3: yard pets | pets.md step 3 | Up to 3 per member, wandering and napping inside lamplight; pet any pet |
| The stable and riding | pets.md steps 4 and 5 | The stable with stall 1, stalls up to 6, shared on a joint deed, mounts in the stall, on the lead and ridden. Riding moves behind the stable |
| Magic groundwork | magic.md build step 1 | The ability table in `content/`, the highest-level mark on `PlayerState`, classless heroes lose Fingersnap |
| Level-20 combat | magic.md step 4 | Stand, Kindle, Ward-light, Echo; the second ability button; client-side fights, mana bounded by the report |
| Fishing at the mill pond | fishing.md build steps 1 and 2 | One curated fishery, one rod, one species (the mill roach), Keep/Release, one hearth recipe; the mill-race bank open all year |
| World changes with expiry | plan.md "Shared foundations" | The table, with the mill pond's stock as its first row |
| A small crafts quest | new here | *A Line in the Race*: Finn's rod, your first roach, Hazel's recipe card (section 5.8). It opens the Quests page's Crafts shelf |
| Art round | plan.md "Art, by release" | Section 9 |

### Left for later, on purpose

Nothing from the brainstorms is dropped; each later stage has a home.

- **Pets 6, residents notice** (lines by species family, Hollis and the fox). Small, mostly writing;
  it can ride along with any later release.
- **Pets, parked:** B "companions with a nose" and C "the way back" (pets.md). The fish-to-a-pet
  idea (fishing.md "Possible pet interaction") waits on B.
- **Magic steps 2, 3 and 5:** the level-10 and level-15 workings, and the capstones. They need
  obstacles the server generator places, so they follow the open map and lake country; Name a lamp
  and the Old ways land with Lamps. Brace, Sense the turning and the Mended glade come after. The
  ability table holds only combat rows in 0.5; workings join it with the release that builds them
  (the same rule 0.4 used for the `world` and `project` gates).
- **Magic in shared fights:** combat abilities applied by the server in server rooms (Shared fights).
- **The mage bolt's name:** stays Fingersnap (plan.md, open questions).
- **Fishing 3 onwards:** guests fishing waits for guest accounts (standalone); generated waters,
  habitats, more species and the stray fish come with lake country; home water at 0.9 or later;
  docks and ice fishing are unscheduled; a fish journal and more recipes follow lake country.
- **Ways home without a mage** (the homing turncap, the lamp-ash pouch): Lamps.
- **Decorating the stable** (tack on the walls, a name board): with the player-decorating release.

---

## 2. Companions: pets that follow and pets at home

### 2.1 What the player sees

**Before a homestead** nothing changes but the charm: your Habitica current pet follows you, and it
moves like an animal now.

- **It hops in time with your steps** (a 2 px bounce on the step frames), **turns to face where
  it's going** (a flip on x, since Habitica pets are one still frame), **sits when you sit** (a
  squash and a drop to the seat's side) and, after about 6 seconds of you standing still,
  **settles** beside you, on the side away from the camera's edge.
- **Friends' pets follow them.** Every player in your room is drawn with their follower, and with
  their mount if it's out (section 3).
- **Pet a pet.** Stand next to any pet, yours or a friend's or a yard pet, and the action button
  says **Pet**: a small heart rises and the pet hops. Nothing is earned, and only you see it.

**With a homestead** (any tier, the campsite included), the Character panel gets a Companions tab.

```
┌ Character ────────────────────────────────────────────┐
│  Hero   [ Companions ]                                │
│                                                       │
│ WHO COMES WITH YOU                                    │
│  [fox]  Golden Fox                       [ Change ]   │
│         ● Chosen here   ○ Habitica's current pet      │
│                                                       │
│ AT HOME                       up to three, in the yard│
│  [cat]  [owl]  [ + ]                                  │
│                                                       │
│ THE STABLE                                            │
│  Stall 1   [wolf] Shade Wolf · out with you  [Change] │
│  Stall 2   [lion] Golden Lion · Ivy's                 │
│  Stall 3   empty                             [Choose] │
│                                       Build a stall ▸ │
└───────────────────────────────────────────────────────┘
```

- **Change** opens the pet picker: every pet you own on Habitica, grouped by species (Habitica's
  keys are `Species-Potion`, so `Fox-Golden` sits under Fox), with a search field and a row of
  species chips. The first entry is always **Habitica's current pet**, which is also the default.
- **At home** shows three spots; tapping one opens the same picker, with **Leave empty**.
- **The stable** section appears once a stable stands (section 3). Without a homestead the tab
  shows your Habitica current pet and one line: *"Once you've a place of your own, you can choose
  who comes along."*
- Choices take effect at once and hold across sessions and devices. Changing them in Glimway never
  changes Habitica's current pet.

**Yard pets** live on your homestead. They wander slowly inside your lamplight, nap in the shade
of a tree or the cottage wall, and come over to you, or to a visitor, who walks up within about
three tiles: they trot over, sit facing you, and go back to their wander when you leave. Visitors
see the same pets in the same places, because where a yard pet is comes from the homestead's seed
and the clock (2.3). On a joint deed each member keeps their own three, so a deed of two can have
six.

### 2.2 The rules

What the server stores (pets.md "Rules and data", trimmed to what 0.5 needs):

- **Per account:** `follow_pet` (an owned pet key, or empty for Habitica's current pet) and
  `yard_pets` (up to 3 owned keys, in slot order). Both are kept in `player_companions` and
  `yard_pets` (migration 030).
- **Every key is checked when someone looks.** The server reads the account's owned list from its
  stored profile (the `profile` operation refreshes it at each sync). A key that's no longer owned
  falls back quietly: the follower to Habitica's current pet, a yard spot to empty. The stored row
  isn't rewritten until the player next changes it, so nothing needs a job and a pet that comes back
  (a re-hatch) comes back to its place.
- **A homestead in this world gates the choices.** `follow_pet` and `yard_pets` hold while the
  account is on a deed in its current world. Without one (a fresh world, a deed left), the follower
  reads as Habitica's current pet and the yard is empty; the stored choice waits, unchanged, for
  the next deed.
- **Guests and `profile_source: none`** get none of this (boundary rule 7). The tab isn't shown.

**The `-1` fix.** Habitica stores a pet raised into a mount as `-1`, and both mappers count it as
owned. A pet is owned when its value is a number **greater than 0**; a mount when its value is
`true`. Fix `owned()` in `server/internal/habitica/client.go:244` and `readKeyList` in
`src/lib/habitica/mapping.ts:124` in one change, and turn `TestMapNullablePetAndMountOwnership`
(`client_test.go:113`) around: today it asserts the bug.

### 2.3 Where a yard pet is

A pure function in `src/lib/yard-pets.ts`, client-only, because no server rule reads a yard pet's
position:

```
yardPetAt(home, petKey, slot, now) → { x, y, facing, pose: 'walk' | 'stand' | 'nap' }
```

- Time is cut into **segments** of 30 to 90 seconds, lengths drawn from
  `hash(home.landSeed, petKey, slot, segmentIndex)`. Each segment picks a target tile from the
  homestead's **lit, walkable** tiles (the client already has the land, the light and the placed
  pieces), and one segment in four is a **nap**: the target is a lit tile beside a tree or the
  cottage, and the pet lies there (a squash, a slow breathing scale, a small "z" made in code).
- Inside a segment the pet walks from the last target to the next at a slow pace (about 30 px/s),
  then stands. Pets aren't solid and don't path-find; a straight walk over a stump is fine.
- **Coming over** is local only: when a hero is within 3 tiles, that screen walks the pet to them
  and sits it. Each screen does this for its own hero; two visitors each see the pet come to them.
- Visitors agree because they share the land, the seed and the server time (0.4's server-time
  offset in `src/game/clock.ts`). Unit tests check that the function is deterministic and that a
  pet never targets an unlit or solid tile.

### 2.4 Server and client

| | Server | Client |
|---|---|---|
| Choosing | `companions` operation (6.2): checks the profile source, a deed in this world, each key owned, at most 3 yard pets, no repeats; writes the rows; bumps the version | Predicts the new follower and yard at once; can queue offline in curated areas, like `mark` |
| Showing | `PlayerState.companions` (resolved: a lapsed key reads as its fallback); `HomeView.yard_pets` for the homestead's members, resolved the same way, so visitors see them | Draws the follower from `companions.follow_pet` (or the profile's current pet), the yard from `HomeView` |
| Presence | Fills `PresenceAvatar.selected_pet` with the **resolved follower** (not Habitica's current pet); sends `PresenceAvatarChange` to the room after a `companions` commit | `loadPresenceAvatar` (`src/game/avatar-render.ts:182`) stops blanking `selectedPet`; remote players get a follower |
| Petting | Nothing | An interactable per pet in reach, rank below Talk |

The follower's motion lives in `src/game/entities/avatar.ts` (`buildPetFollower` and the follow in
`update()`), split into a small `pet-follower.ts` that both the hero and remote players use.

---

## 3. The stable and riding

### 3.1 What the player sees

**Riding needs a stable.** Pressing M with no mount out says: *"Your mount needs somewhere to stand
at home first. A stable, maybe."* The "What's new" card says riding moved (6.6).

**Building it.** After the Workshop (tier 2), the homestead's build list offers **the stable**: 30
embers, timber 16, stone 8, fiber 6. It's bought and placed like any outdoor piece, in placement
mode, on cleared, lit ground. It comes with stall 1: a small tack room on its west end and one bay.

**Stalling a mount.** Walk up to an empty stall and the action button says **Choose a mount**; it
opens the Companions tab at the stable, where any owned mount can go in. A stalled mount stands in
its bay, head over the half-door, and visitors see it.

**Setting out.** At your stalled mount the action button says **Saddle up**: you're on it and it's
out with you. From then on:

| State | What it means | How you get there |
|---|---|---|
| **In its stall** | Stands at home; visitors see it | The default, or after it's sent home |
| **Ridden** | You're on it, faster outdoors (155 against 110 on foot, as today) | Saddle up at the stall, or M while it's on the lead |
| **On the lead** | Walks behind you, beside your pet, a rope from your hand to its head | M while riding |
| **Going home** | Walks off the edge of the screen, then it's back in its stall | **Go home** (H, or the button) while you're off it |

- **The village** stays a no-ride zone: at the gate you get down and lead it through, as the gate
  toast already says.
- **Rooms:** a mount doesn't come indoors. It waits on the doorstep outside and is there when you
  come out (drawing only; reloading inside leaves it waiting at that door).
- **Fighting, sitting, chopping, fishing** with the mount on the lead: it stops where it is and
  comes on again when you move off. Enemies ignore it.
- **A new session starts with it at home.** If you leave while it's out, it finds its own way
  back. Nothing is lost.
- **Saddle up on another mount** while one is out sends the first one home.

**More stalls.** At the stable, **Build a stall** adds a bay on its east side, up to 6 stalls. The
*n*th extra stall costs timber 8 + 4(*n*−1), stone 4 + 2(*n*−1), fiber 2 (pets.md, first guesses).
The two tiles east of the last bay must be cleared, buildable and lit; if they aren't, the answer
says so: *"Clear and light the ground east of the stable first."* A stall can stand empty, and
emptying one refunds nothing.

**Joint deeds share the stable.** Partners each put their own mounts into free stalls. Nobody can
move a partner's mount out of its stall, and only a mount's owner can saddle it or lead it.
Partners and visitors see every stalled mount.

### 3.2 One building that grows

The stable is **one placed piece whose footprint grows east** with its stalls: 4 × 3 tiles with
stall 1 (the tack room 2 wide, the bay 2 wide), plus 2 × 3 for each extra stall, 14 × 3 at six.
This keeps every existing placement path:

- **Placing and moving** use `validatePlacement` (`server/internal/api/home_placement.go:124`) with
  the footprint from the stall count. Moving the stable moves its bays and the mounts in them.
- **One per homestead**, refused at `buy` with `stable-full`.
- **Removing** is allowed only when every stall is empty and no stalled mount is out
  (`stalls-in-use`); the stable returns to the member's pack with its stall count, as any removed
  piece returns.
- **Building a stall** is a new operation, `stable-extend`, because it changes a placed piece's
  footprint and spends growth-priced materials, which `buy` and `place` don't do.

The stall count lives on the placed instance (`HomeInstance.stalls`). Stalls are numbered 1 to 6
from the west; the row that says who's in them is `homestead_stalls(homestead_id, stall,
mount_key, owner_id)`.

### 3.3 The rules

- **Per account:** `mount_out` (a mount key, or empty) and `mount_home` (the homestead it came
  from), in `player_companions`. The server **doesn't** store ridden or led: that's movement, which
  the screen owns, like speed. pets.md listed `{key, state}`; the state turned out to have no rule
  that reads it, so it travels in presence instead (3.4).
- **`mount_out` is valid only while** a stall on `mount_home` holds that key with this account as
  owner, the account is on that deed, the key is in its owned mounts, and the account's world is
  that homestead's world. Otherwise it reads as empty. Worked out when someone looks.
- **A new lease clears it.** `POST /api/play` issuing a **new** lease (not a same-tab resume) sets
  `mount_out` to empty, so each session starts with the mount at home. A world move clears it too.
- **What the server checks:** `stall` (who's in a stall), `mount-out` (saddling up at the stall),
  `mount-home` and `stable-extend`, each in 6.2. Speed stays client-side under the invite-only trust
  model; the server only checks that you have a stable, a stalled mount you own, and that it's the
  one out.
- **The village no-ride rule** stays in the client, where it is today (`avatar.ts:188-270`).

### 3.4 Server and client

| | Server | Client |
|---|---|---|
| Building | `buy`/`place`/`move`/`remove` with the stable's rules; `stable-extend` | Placement mode draws the growing footprint; the Build a stall prompt at the stable |
| Stalls | `stall` and `HomeView.stalls` (index, mount, owner, owner's name, out) | The stable scene: each bay draws its back layer, the Habitica mount (body and head layers, no rider) and the front rail, so the mount stands inside |
| Out and home | `mount-out`, `mount-home`, `PlayerState.companions.mount_out` | `toggleRide` (`avatar.ts:188`) reads `mount_out` instead of Habitica's `selectedMount`; the lead rope drawn in code from the hand to the mount's head; the walk-off on Go home is drawing only |
| Presence | `PresenceAvatar.selected_mount` carries the mount that's out (empty when none); `PresenceAvatarChange` after `mount-out` and `mount-home`. `PresencePosition.pose` carries `riding` | Remote players draw a ridden mount (today's mount layers) or a led one behind them, from `selected_mount` and `pose` |

The hero's speed is unchanged: `hero.ts:229` reads `riding ? 155 : PLAYER_SPEED`; lane E makes 155 a
named constant beside `PLAYER_SPEED`.

---

## 4. Magic: groundwork and the level-20 moves

### 4.1 The ability table

A new content file, `content/abilities.json`, with its schema `proto/glimway/content/v1/abilities.proto`,
read by Go and TypeScript through the One schema loaders. It holds what both sides need: who has
the move, from which level, what it costs, how often it can be used, and its numbers.

```json
{
  "abilities": [
    { "id": "cleave", "name": "Cleave", "class": "warrior", "kind": "signature", "level": 10,
      "mana": 12, "cooldownSeconds": 1, "icon": "ability-cleave" },
    { "id": "stand", "name": "Stand", "class": "warrior", "kind": "combat", "level": 20,
      "mana": 14, "cooldownSeconds": 4, "icon": "ability-stand",
      "numbers": { "durationSeconds": 1.5, "staggerSeconds": 0.8 } },
    { "id": "fingersnap", "name": "Fingersnap", "class": "mage", "kind": "signature", "level": 10,
      "mana": 15, "cooldownSeconds": 1, "icon": "ability-fingersnap" },
    { "id": "kindle", "name": "Kindle", "class": "mage", "kind": "combat", "level": 20,
      "mana": 16, "cooldownSeconds": 5, "icon": "ability-kindle",
      "numbers": { "durationSeconds": 6, "radiusTiles": 1.5, "slow": 0.6, "reachTiles": 2 } },
    { "id": "shadowstep", "name": "Shadowstep", "class": "rogue", "kind": "signature", "level": 10,
      "mana": 10, "cooldownSeconds": 1, "icon": "ability-shadowstep" },
    { "id": "echo", "name": "Echo", "class": "rogue", "kind": "combat", "level": 20,
      "mana": 12, "cooldownSeconds": 6, "icon": "ability-echo",
      "numbers": { "durationSeconds": 3 } },
    { "id": "mend", "name": "Mend", "class": "healer", "kind": "signature", "level": 10,
      "mana": 18, "cooldownSeconds": 1, "icon": "ability-mend" },
    { "id": "ward-light", "name": "Ward-light", "class": "healer", "kind": "combat", "level": 20,
      "mana": 20, "cooldownSeconds": 8, "icon": "ability-ward-light",
      "numbers": { "durationSeconds": 5, "radiusTiles": 1.25, "pulses": 3, "pulseHealFraction": 0.4 } }
  ]
}
```

- **Field rules in the schema** (protovalidate): `class` is one of the four, `kind` is `signature`
  or `combat` (`working` joins the enum with the first working; until then the loader refuses it),
  `level` is 10, 15, 20 or 30, `mana` and `cooldownSeconds` are positive, a signature's
  `cooldownSeconds` is exactly 1 (the report's signature budget, server-first.md 2.2), `slow` and
  `pulseHealFraction` are in (0, 1].
- **Rules across entries, in code once:** each class has exactly one signature at level 10 and at
  most one combat move; ids are unique; every `icon` is in the art manifest (a test, not the
  loader).
- **`combat.json` shrinks.** Each class's `castCost` moves to its signature's `mana` here; the
  `combat.classes` rule drops `cast_cost`. `combat.json` keeps the basic attack's cooldowns and the
  heal formula. The client's hard-coded `CAST_COST` and the `STARTER` numbers
  (`src/lib/combat.ts:73`) go.
- **Signature ids change** from the client's internal `bolt`, `cleave`, `dash`, `heal` to the
  table's `fingersnap`, `cleave`, `shadowstep`, `mend`. Nobody plays yet, so this is a rename, not a
  mapping.

### 4.2 Who has what: the level mark and the class

- **The level mark already exists.** `sync_baselines.verified_high_level` is the highest level a
  verified login has seen; today only rebirth detection reads it (`rules.IsRebirth`). 0.5 makes it
  magic's mark:
  - the `profile` operation raises it too (with `MAX`), once the synced profile has passed today's
    plausibility checks;
  - it goes on `PlayerState` as `magic.level_mark`.
- **The class mark** (new, `sync_baselines.class_mark`) is the last class a sync saw. A hero has
  their craft when the profile has a class, or when it has none but the level mark is 10 or more
  and a class mark exists (a rebirth; section 11, question 4). A hero who never had a class has
  none.
- **What unlocks:** a move is yours when its `class` is your craft and its `level` is at most your
  level mark. Veterans above 20 get both at once, with no ceremony (owner, 2026-10-07).
- **Unlock notice.** When an adopted state's level mark crosses 10 or 20 compared with the one the
  client held (not on first load), a toast: *"New at level 20: Kindle. It's on R, and the second ✦
  on phones."* The Character panel's Abilities section lists the basic attack, the signature and
  the level-20 move, with a locked line for any move still ahead (*"At level 20: Ward-light"*).

**Heroes without a craft** (under level 10, or never chose a class) fight with what's in hand: the
basic attack, no F, no ✦ (magic.md "Classless players and guests"). `getCombatKit`
(`src/lib/combat.ts:88`) returns a kit with no signature; the HUD and the phone controls hide the
buttons when the kit has none. The server already allows no casts without a class
(`report.go:14`).

The checks magic.md asked for, against today's code:

- **The finger-wisp** (4 HP) is made for the basic attack alone.
- **The Warden** takes no damage from anything; three spoken namings settle it, through the action
  button. Unchanged.
- **The Tangle's wisps (10 HP) and beetles (18 HP)** lose the starter's ranged option. Melee is
  enough but slower; the owner's playtest on a fresh low-level account is the check (lane F's e2e
  covers the finger-wisp and the Warden).
- `tests/combat.test.ts:15,97` assert the classless kit and change with it.

### 4.3 The four moves

All four are client-side, like today's signatures: the fight runs on your screen, and the server
bounds the mana and the healing (4.4). None of them touches the Warden, so the story fight stays as
it is. Numbers are magic.md's first guesses, now in the table.

| Move | Class | What it does on screen | Where it hooks in |
|---|---|---|---|
| **Stand** | warrior | Plant your feet for 1.5 s (no movement). An enemy whose lunge would reach you stops short and staggers for 0.8 s. No damage reduction | The lunge contact branch in `enemies.ts:221-241`; beetles use their existing `stunned` state (which also takes 1.5× damage), hoppers stop for the stagger |
| **Kindle** | mage | A patch of hollow light 3 tiles across, 2 tiles ahead in your facing, for 6 s. Enemies inside move at 60 % | A speed multiplier where creatures set velocity (`creatures.ts:41-105`) |
| **Ward-light** | healer | A still circle 2.5 tiles across at your feet for 5 s, pulsing three small heals at 1, 2.5 and 4 s to **anyone** inside, other players included. Each pulse is 0.4 of your Mend | A pulse like Mend's (`hero.ts:399-422`); the heal on others goes through presence (4.5) |
| **Echo** | rogue | Leave a faded copy of yourself where you stand; enemies aim at it for 3 s while you move away | A decoy target passed into `enemies.update` and `lockAim` (`enemies.ts:189,427`); the copy is the hero's layers, tinted and half transparent, made in code |

**The second button.** Desktop: **R**, a second slot on the action bar beside F with its mana
cost. Phones: a second round ✦ button in the touch cluster beside the first (`TouchControls.svelte`
`.col`), the same size, with its cost badge (section 8). Cooldown and affordability show the same
way as the signature's: `ui.ability` (`store.svelte.ts:108`) becomes a pair of slots, keyed by
ability id.

**Others see them.** A cast sends a presence event (4.5), so friends see your Kindle patch, your
Echo, your Stand ring and your Ward-light circle. Only the Ward-light changes anything on their
screen.

### 4.4 The report: one budget per move

Today `ReportRequest.casts` counts signature casts, and `boundReport` (`report.go:14`) allows them
against one cooldown (`cast_ready_at`) and the class's cost. 0.5 widens it:

- `ReportRequest` keeps `casts` for the signature and gains `ability_casts`, a map from a combat
  ability id to its count.
- Each move has **its own cooldown budget**: `Vitals.ability_ready_at` (a map, persisted in
  `player_ability_ready`), with the same allowance as the signature's,
  `max(0, 1 + floor((now − ready) / cooldown))`, and the same persistence rule.
- **Mana is one budget.** Moves are allowed in table order (signature first): each takes
  `min(reported, its cooldown allowance, floor(mana left / its cost))`, and the mana left goes down
  by what it took. The final mana is still
  `max(0, min(maxMana, stored + regenCap × elapsed − total cost))`.
- **Moves need their level.** The signature needs the craft; a combat move also needs the level
  mark at its `level`. Otherwise its count is allowed as 0, like a classless cast today.
- **HP may rise** by the healer's accepted Mends (today's rule), plus accepted Ward-lights ×
  `pulses` × the pulse heal (the caster stands in their own circle), plus **ward credit** from
  other healers (4.5). Every amount is the server's own formula from the caster's stats.
- `ReportResult` echoes `ability_casts` as accepted, and `ally_heal`, the ward credit used.

The partition fixtures in server-first.md 2.2 extend to a second move: splitting or coalescing
casts of two moves gives the same budget, and a move's cooldown debt survives a refill.

### 4.5 Presence for the moves

Two additions to `glimway.v2` presence (`proto/glimway/v2/presence.proto`):

- **`PresenceAbility { ability, x, y, account_id }`.** The client sends it when it casts a
  combat move (or a signature, so friends see a Fingersnap too), without `account_id`. The hub
  checks that the ability is in the table, that the sender's class and level mark allow it (read
  from the account's state at auth and refreshed on the hub's existing revalidation,
  `revalidateMs`), and a per-ability cooldown it keeps in memory; then it relays the event to the
  room with `account_id` filled. Anything else is dropped, like an emote over its cooldown.
- **Ward credit.** For a `ward-light`, the hub schedules three pulse checks (`time.AfterFunc` at 1,
  2.5 and 4 s). At each one it takes the room members whose **last known position** is inside the
  circle, other than the caster, and adds one pulse of the caster's heal to each one's credit. The
  credit is held in memory per account for 60 seconds, and the next accepted report from that
  account may raise HP by up to it (and uses it up). A restart loses unspent credit, which costs at
  most one ward's heal.

On a friend's screen the pulses heal locally at the same moments (from the relayed event), so their
HP bar rises when they see the pulse, and their next report is allowed it.

Under the friends-on-invites trust model, a modified client could send `PresenceAbility` without
paying in its report. The hub's cooldown bounds that to one ward every 8 seconds, the same as an
honest healer; nothing better is promised until shared fights.

---

## 5. Fishing at the mill pond

### 5.1 The bank, the visit

The village pond: water at tiles (33–38, 19–22) with its sandy rim along row 18 and column 32,
and the mill-race cut through the rim at (32, 20–22), where Finn's wheel turns
(`src/game/worlds.ts:313-419`). It's one fishery, **`water:village:mill-pond`**: 24 pond tiles and
3 race tiles, still water, 27 tiles in all.

**Banks** are tiles you stand on, each facing water. A bank is a server-known row (5.4), so the
server can check where you cast from.

| Bank | Stand on | Facing | Open |
|---|---|---|---|
| `north` | the sand at (34–38, 18) | south | Not in the Quiet (the pond is iced) |
| `east` | the grass at (39, 19–22) | west | Not in the Quiet |
| `race` | the sand at (32, 19), above the wheel | south, down the race | All year (fishing.md decision 6) |

Lane G checks the race bank against the wheel's art and moves it a tile if the wheel covers it.
In the Quiet the rest of the pond keeps its ice and frost-glass (`pond-ice` gathering at (34, 19),
(37, 19), (38, 21)); both are the same water, so the race bank adds no second stock.

**A visit** (fishing.md "The shared bank"):

1. Pick the rod from your belt (a new belt kind, `fish`) and walk to a bank. The bank reads the
   water, from its band (5.3): *"Little rings among the reeds."*
2. The action button says **Cast**. The line goes out, the float lands and bobs.
3. About ten seconds later in healthy water (thirty when it's low, up to a minute when it's very
   low) the float dips with a soft sound and the button says **Reel**.
4. One press: a short landing, the roach arcs out of the water, and two big buttons ask **Keep**
   or **Let it go**.
5. Keep, and it's in your pack. Let it go, and it's back in the pond; nothing is paid.

There's no failure window: once the float dips, the fish waits for you. Walking more than a tile
from the bank pulls the line in (the cast is cancelled and the fish stays in the water). Two
players can fish side by side; nobody claims a seat.

When the water is very low the bank says so before you cast: *"Very still here. Try another bank,
or let it rest."* An empty pond can't be cast into (`water-still`); there's no countdown to a refill.

### 5.2 The rod, the fish and the supper

| Item | Kind | Numbers | Where it comes from |
|---|---|---|---|
| **Willow rod** (`willow-rod`) | tool, grade `cheap`, action `fish` | 20 uses; one use per **kept** fish. Release and a cancelled cast don't wear it | Finn gives the first (5.8); Finn sells another, 2 embers, wherever he is; the bench makes one (timber 1, fiber 2) for anyone with a Workshop |
| **Mill roach** (`mill-roach`) | material, Supplies tab | Stacks; doesn't rot; giftable and mailable | The mill pond |
| **Miller's fry** (`millers-fry`) | consumable, marked | Restores 18 HP and 6 mana. Refused at 0 HP, like all food | Hearth recipe: 1 mill roach, 1 flour → 1 fry |
| **Recipe card: Miller's fry** (`recipe-card-millers-fry`) | paper | Hazel's card; the hearth recipe needs it held | Hazel, at the end of the quest (5.8) |

- The fry is useful to every hero, with or without a class: HP first, a little mana. Against
  today's food, Keeper's Twists give 10 HP each (four from 2 flour and a honey); the fry is a fish's
  wait and a sack of flour for 18 HP and 6 mana. First guesses; tune in the playtest.
- **The species roll** stays in the design even with one species: a cast rolls from the water's
  species table, weighted by habitat and fullness (fishing.md "Angling"), seeded by the account's
  cast sequence. The pond's table has one row in 0.5; lake country adds rows, not code.

### 5.3 Stock: the water remembers

The numbers are fishing.md's proposals, for a medium water (24–63 tiles):

| Knob | 0.5 value |
|---|---|
| Capacity | 12 fish |
| Recovery | 1 fish per 10 minutes, fractional, up to capacity |
| Bands (fullness, after reserved fish) | **healthy** ≥ 50 % · **low** 20–49 % · **very low** under 20 % but at least one fish · **still**: none |
| Wait to a bite | healthy 10 s · low 30 s · very low 60 s |
| A ready fish waits | 10 minutes after the bite, then slips off and goes back to the water |
| Cast spacing | one active cast per account, across devices and worlds; a new cast starts at least 8 s after the last one started, and cancelling doesn't reset that |

- **Stock is shared** by everyone in the world. Separate worlds have separate ponds. There's no
  personal daily quota (fishing.md decision 7).
- **Reads compute, writes store.** Stock now is `recovered(stored, 1/600, capacity, at, now)`,
  the 0.3 clock helper (`content/clock.go:111`, `src/lib/clock.ts:50`), whose first production
  caller this is. A read doesn't write, so looking can't speed recovery or lose it. Every
  operation that changes stock stores the recovered value and the time together.
- **A cast reserves its fish.** Accepting a cast takes one fish from the stock into `reserved`, so
  a friend can't take it during the wait. Keep consumes it; Release, Cancel and a lapsed hold give
  it back. Fullness for the band and the wait is computed **before** the reservation. A reserved
  fish counts against capacity, so recovery can't overfill around it.
- **The band and wait are frozen** on the cast at acceptance: cancelling, reloading or retrying
  can't reroll them.

### 5.4 The rules on the server

**`content/fishing.json`** (schema `proto/glimway/content/v1/fishing.proto`):

```json
{
  "bands": [
    { "id": "healthy", "atLeastPercent": 50, "waitSeconds": 10, "line": "Little rings among the reeds." },
    { "id": "low", "atLeastPercent": 20, "waitSeconds": 30, "line": "A ring now and then, out by the wheel." },
    { "id": "very-low", "atLeastPercent": 0, "waitSeconds": 60, "line": "Very still here. Try another bank, or let it rest." }
  ],
  "holdSeconds": 600,
  "castSpacingSeconds": 8,
  "reachTiles": 1.5,
  "waters": [
    {
      "id": "water:village:mill-pond", "area": "village", "habitat": "still",
      "tiles": 27, "capacity": 12, "recoverySeconds": 600,
      "banks": [
        { "id": "north", "tiles": [[34,18],[35,18],[36,18],[37,18],[38,18]], "facing": "south", "closedIn": ["Quiet"] },
        { "id": "east", "tiles": [[39,19],[39,20],[39,21],[39,22]], "facing": "west", "closedIn": ["Quiet"] },
        { "id": "race", "tiles": [[32,19]], "facing": "south", "closedIn": [] }
      ],
      "species": [ { "item": "mill-roach", "weight": 1 } ]
    }
  ]
}
```

The "still" band (no fish) has no row: an empty water refuses. Field rules are protovalidate
constraints (ids, positive numbers, `closedIn` naming a mark, at least one bank and one species,
items that exist is a cross-file check in code). Text lines live here because the server sends
the band id and the client shows the line; the server never needs the words, but one file keeps
the water's numbers and voice together. (If the lane prefers, the lines move to
`src/content/fishing.ts` and the file keeps ids only.)

**The operations** (6.2), each keyed and idempotent through `keyedOp`:

- **`fish-cast {water, bank, rod, where}`.** Checks, in order: the rod instance is in your pack and
  has the `fish` action and uses left (`useTool`'s checks without the wear, `item_wear.go:94`);
  the bank is on that water, open in today's mark (`CalendarAt`), and `where` is in `village`
  within `reachTiles` of one of its tiles; no cast of yours is open (`already-casting`); at least
  `castSpacingSeconds` since your last start (`cast-too-soon`); the water has a free fish
  (`water-still`). Then: freeze the band and wait, roll the species with
  `hash(account, cast_seq)`, reserve the fish, write the cast, bump `cast_seq` and `last_start`.
  Result: the cast (id, water, bank, `started_at`, `ready_at`, `hold_until`, species) and the band.
- **`fish-settle {cast, keep, where}`.** The cast is yours and open (`no-cast`), and `now` is at
  least `ready_at` (`not-yet`) and before `hold_until` (after it the cast has lapsed: `no-cast`).
  **Keep:** wear the cast's rod by one use (`wrong-tool` if it's left your pack), put the fish in
  your pack (`packPut`, reason `fish`), consume the reservation. **Release:** return the
  reservation. Either way the cast closes. Result: kept or not, the item, the wear, the new band.
- **`fish-cancel {cast}`.** Closes an open cast and returns its reservation. Cancelling a cast
  that's already closed answers its stored result (it's idempotent by key) or `no-cast`.
- **Lapsing is lazy.** A cast past `hold_until` is closed, and its fish returned, by the next
  operation or read that touches that water or that account. A world move closes an open cast in
  the same transaction.
- **Rate limits** beyond the spacing are the existing per-route limits; the spacing and the one
  open cast bound yield (fishing.md "Abuse and interruptions").

**A read:** `GET /api/fishing/waters?area=village` answers each water's band (and nothing else:
no counts, no countdown). The client reads it on entering the village and after each settle or
cancel. A cast's result carries the band too.

**Where the stock lives: the world-changes table.** The plan's foundation, built here with its
first writer (plan.md "Shared foundations"; server-first.md 5 deferred it to 0.5):

```sql
CREATE TABLE world_changes (
  world_id   TEXT NOT NULL REFERENCES worlds(id),
  realm      TEXT NOT NULL,          -- a curated area id, or a generated realm
  layer      INTEGER NOT NULL,       -- 0 on the surface
  chunk      TEXT NOT NULL,          -- '' for curated places
  epoch      TEXT NOT NULL,          -- '' for curated places, which don't turn
  entity     TEXT NOT NULL,          -- 'water:village:mill-pond'
  kind       TEXT NOT NULL,          -- 'fishery' in 0.5
  state      TEXT NOT NULL,          -- ProtoJSON of the kind's state message
  changed_at INTEGER NOT NULL,
  changed_by TEXT REFERENCES players(account_id),
  ends_at    INTEGER,                -- NULL: never; else the turning or the chunk's turn
  PRIMARY KEY(world_id, realm, layer, chunk, epoch, entity)
);
```

- **No row means untouched:** a pond nobody has fished is full.
- **Reads ignore a row whose `ends_at` has passed,** so nothing cleans up on a timer. The mill
  pond's row has `ends_at` NULL: a curated water never turns.
- **The `state` for a fishery** is `FisheryState { stock, reserved, at }` (a message in
  `proto/glimway/v1/fishing.proto`, stored as ProtoJSON). Stock is a double, so fractional
  recovery survives between writes.
- **One Go package,** `server/internal/worldchange`, with `Get`, `Put` (in the caller's
  transaction) and the expiry rule, and tests for the key, expiry and the absent row. The fishing
  handlers use it; the first working uses it later with `ends_at` = the next turning.

Casts aren't world changes (they're one account's): `fishing_casts` and `player_fishing` (6.4).

### 5.5 The client

- **The banks register on the interactions path** (`src/game/entities/interactables.ts`, one
  `register` call), as gathering does (`gathering.ts:131`): available while the rod is held, the
  bank is open in today's mark and no cast is out; the label is the band's line, the verb Cast.
- **Prediction.** Cast shows the line and the float at once, with the bite predicted from the
  band's wait; the server's `ready_at` corrects it when the answer comes. Keep predicts the fish in
  your pack and the rod's wear. A refusal rolls back and says why in plain words.
- **Reload and devices.** `PlayerState.fishing.cast` holds the open cast, so a reload at the bank
  puts the float back (and a ready one says *"Something's on your line"*). A cast out on another
  device shows on this one too, since it's the account's.
- **Offline:** fishing shows **Needs a connection** (shared stock), like spends.
- **Presence:** `PresencePosition.pose` carries `fishing` while a line is out, so friends see you
  with a rod and a float (no bite on their screen).
- **Reduced motion:** the float doesn't bob; the bite is a ring and the word Reel. Sound is
  optional and goes through `sound.ts`.

### 5.6 Habitat, stock and guests later

Nothing in 0.5 assumes the mill pond is the only water: banks, species tables and bands are rows,
the stock is a world change keyed the way generated waters will be, and casts carry the water id.
Lake country adds generated fishery descriptors (world.md "Water for fishing") and rows in the
same tables. Guests get all of it the day guest accounts land: no rule here reads the profile
source.

### 5.7 Where fishing touches existing code

| File | Change |
|---|---|
| `proto/glimway/content/v1/items.proto:170` | `fish` joins the tool actions |
| `src/lib/belt.ts:15,18` | `fish` joins `BeltKind` and `BELT_ORDER`, after `dig`; `KIND_WORDS` gains "Fish" |
| `server/internal/api/market.go:19` | Selling an instanced item (the rod) grants an instance, as `questGive` already does (`quest_rules.go:256`); today `marketBuy` only puts stacks |
| `content/items.json` | The four items; Finn's seller row gains the rod |
| `content/crafting.json` | `craft-willow-rod` (bench) and `hearth-millers-fry` (hearth, page `recipe-card-millers-fry`) |
| `server/internal/api/world_*` (world move) | Closes an open cast |

### 5.8 *A Line in the Race*

A small quest on the Quests page's **Crafts** shelf (empty and hidden in 0.4), after the opening.
It hands you the rod, teaches the bank and sends you to Hazel. The lines are writing suggestions
for lane G, not canon.

| Step | Do | `at` | Gate | Grants |
|---|---|---|---|---|
| `hear-finn-line` | `talk: finn` | — | `with: finn` | `give: willow-rod ×1` |
| `first-catch` | `carry: mill-roach` | — | | |
| `show-hazel` | `talk: hazel` | — | `with: hazel`, `item: mill-roach ×1, keep: false` | `give: recipe-card-millers-fry ×1`, embers 1, note *"Miller's fry"* |

Finn, starting it: *"Roach come up to the wheel for the meal dust. Race runs all year, even when
the pond's glass. There's a rod on the hook by my door, take it, it only gets looked at."* Hazel,
taking the roach: *"Oh, that's a good one. Flour, a hot pan, and don't fuss it. Here, have the card.
I'll keep this one to check the card's right."* The note: *"Hazel kept the fish. To check the card
was right, she said, and ate it standing up."*

It proves nothing new on the server (`with`, `item`, `give` and `carry` are 0.4's), which is the
point: a crafts quest is data.

---

## 6. Operations, content and migrations

### 6.1 Protos

All in one change on the integration branch (lane A). Field numbers checked against `1bbb7c7`:
`PlayerState` ends at `embers = 7`; `Vitals` at `cast_ready_at = 10`; `ReportRequest` at
`generation = 9`; `ReportResult` at `place_ignored = 8`; the `Envelope` oneof at `mend = 31`;
`HomeView` at `items = 17`; `HomeInstance` at `name = 7`; the last error is
`ERROR_CODE_NEEDS_HABITICA = 210`; presence v2's oneof ends at `witness = 10`, `PresencePosition`
at `account_id = 5`.

```proto
// glimway/v1/companions.proto (new)
message Companions {
  string follow_pet = 1;          // resolved: empty means Habitica's current pet
  repeated string yard_pets = 2;  // resolved, slot order, at most 3
  string mount_out = 3;           // resolved: empty when every mount is in its stall
  string mount_home = 4;          // the homestead id the mount came from
}
message CompanionsRequest { OpHeader op = 1; string follow_pet = 2; repeated string yard_pets = 3; }
message CompanionsResult { Companions companions = 1; }
message StallRequest { OpHeader op = 1; Where where = 2; string home_id = 3; int32 stall = 4; string mount = 5; }
message StallResult { HomeView home = 1; }
message MountOutRequest { OpHeader op = 1; Where where = 2; string home_id = 3; int32 stall = 4; }
message MountOutResult { Companions companions = 1; }
message MountHomeRequest { OpHeader op = 1; }
message MountHomeResult { Companions companions = 1; }
message StableExtendRequest { OpHeader op = 1; Where where = 2; string home_id = 3; }
message StableExtendResult { HomeView home = 1; map<string, int32> materials = 2; }

// glimway/v1/fishing.proto (new)
message FishingCast {
  string id = 1; string water = 2; string bank = 3; string species = 4;
  double started_at = 5; double ready_at = 6; double hold_until = 7; string band = 8;
}
message FishingState { FishingCast cast = 1; double next_cast_at = 2; }   // cast absent when none is open
message FisheryState { double stock = 1; double reserved = 2; double at = 3; }   // stored, not served
message FishCastRequest { OpHeader op = 1; Where where = 2; string water = 3; string bank = 4; string rod = 5; }
message FishCastResult { FishingCast cast = 1; string band = 2; }
message FishSettleRequest { OpHeader op = 1; Where where = 2; string cast = 3; bool keep = 4; }
message FishSettleResult { string cast = 1; bool kept = 2; string item = 3; WearResult wear = 4; string band = 5; }
message FishCancelRequest { OpHeader op = 1; string cast = 2; }
message FishCancelResult { string cast = 1; string band = 2; }
message WaterView { string id = 1; string band = 2; }
message FishingWaters { repeated WaterView waters = 1; }   // GET /api/fishing/waters?area=

// state.proto
message Magic { double level_mark = 1; google.protobuf.StringValue class_mark = 2; }
message PlayerState { /* 1–7 as today */ Companions companions = 8; Magic magic = 9; FishingState fishing = 10; }
message Envelope { oneof result { /* 10–31 as today */
  CompanionsResult companions = 32; StallResult stall = 33; MountOutResult mount_out = 34;
  MountHomeResult mount_home = 35; StableExtendResult stable_extend = 36;
  FishCastResult fish_cast = 37; FishSettleResult fish_settle = 38; FishCancelResult fish_cancel = 39; } }

// op.proto
message Vitals { /* 1–10 as today */ map<string, double> ability_ready_at = 11; }

// operations.proto
message ReportRequest { /* 1–9 as today */ map<string, double> ability_casts = 10; }
message ReportResult { /* 1–8 as today */ map<string, double> ability_casts = 9; double ally_heal = 10; }

// goods.proto
message HomeInstance { /* 1–7 */ google.protobuf.Int32Value stalls = 8; }   // the stable only
message Stall { int32 stall = 1; string mount = 2; string owner_id = 3; string owner_name = 4; bool out = 5; }
message YardPet { string owner_id = 1; string pet = 2; int32 slot = 3; }
message HomeView { /* 1–17 */ repeated Stall stalls = 18; repeated YardPet yard_pets = 19; }

// glimway/v2/presence.proto
message PresenceMessage { oneof event { /* 1–10 */ PresenceAbility ability = 11; PresenceAvatarChange avatar_change = 12; } }
message PresenceAbility { string ability = 1; double x = 2; double y = 3; optional string account_id = 4; }
message PresenceAvatarChange { string account_id = 1; PresenceAvatar avatar = 2; }
message PresencePosition { /* 1–5 */ optional string pose = 6; }   // "riding" | "fishing"; absent on foot
```

- **`PresenceAvatar.selected_pet` and `selected_mount` keep their numbers and change meaning:**
  the resolved follower, and the mount that's out. The server is their only writer.
- **New error codes**, appended as 211–219: `companion-not-owned` (a pet or mount the account doesn't own; `item-not-owned` stays for items),
  `no-stable`, `stall-taken` (a partner's mount is in it), `stalls-in-use`, `stable-full` (six
  stalls, or a second stable), `already-casting`, `cast-too-soon`, `water-still`, `no-cast`.
  `not-yet` (208), `homestead-not-found`, `wrong-tool`, `too-far-away`, `short` and the placement codes (`land-blocked`, `placement-overlap`, `unlit`, `invalid-placement`) are reused.
- **The contract number** goes from 4 to 5 (`content/contract.json`): the report, presence and
  the state all change shape, so 0.4 tabs get the reload notice.
- **Presence's subprotocol stays `glimway.presence.v2`.** The additions are new oneof cases and an
  optional field; the server only sends `ability` and `avatar_change` to clients of contract 5, which
  the HTTP contract gate already guarantees for any tab that got a lease.

### 6.2 The operations

| Operation | Route · result | Server checks and does | Client predicts | Refusal |
|---|---|---|---|---|
| **companions** | `POST /api/companions` · `companions` | Profile source `habitica`; a deed in this world (`homestead-not-found`); each key owned (`companion-not-owned`); ≤ 3 yard pets, no repeats; writes `player_companions`, `yard_pets`; avatar change to the room | New follower and yard | Choice rolls back |
| **stall** | `POST /api/stable/stall` · `stall` | Member of `home_id`'s deed; the stable exists with that stall (`no-stable`); `mount` owned (`companion-not-owned`) or empty; the stall is empty or holds your own mount (`stall-taken`); the same mount moves from another of your stalls here rather than standing twice | Stall shows the mount | Stall rolls back |
| **mount-out** | `POST /api/stable/out` · `mount_out` | `where.area` is `home:<gate>` of that homestead and within 2 tiles of the stall; the stall holds your mount; sets `mount_out`, `mount_home`; avatar change | You're riding it | `too-far-away` / `no-stable` / `companion-not-owned` |
| **mount-home** | `POST /api/stable/home` · `mount_home` | Always succeeds; clears `mount_out`; avatar change | It walks off | — |
| **stable-extend** | `POST /api/stable/extend` · `stable_extend` | Member; stable placed; fewer than 6 stalls (`stable-full`); the 2 × 3 tiles east are inside the land, clear, buildable and lit (`land-blocked`, `placement-overlap`, `unlit`); materials by the growth rule (`short`) | New bay | Bay rolls back |
| **fish-cast** | `POST /api/fishing/cast` · `fish_cast` | 5.4 | Float out | 5.4's codes |
| **fish-settle** | `POST /api/fishing/settle` · `fish_settle` | 5.4 | Fish in the pack, rod wear | `no-cast` / `not-yet` / `wrong-tool` |
| **fish-cancel** | `POST /api/fishing/cancel` · `fish_cancel` | 5.4 | Line in | `no-cast` |
| **report** (grown) | as today | 4.4 | As today | As today |
| **profile** (grown) | as today | Raises the level mark and class mark | — | As today |
| **play** (grown) | as today | A new lease clears `mount_out` | — | As today |
| **buy/place/move/remove** (grown) | as today | The stable's rules (3.2) | As today | As today |

**Offline**, in curated areas: `companions` and `mount-home` queue in the outbox (both are
predictable and can't fail on shared state); `mount-out`, `stall`, `stable-extend` and the fishing
operations show **Needs a connection**.

### 6.3 Content files

| File | Change | Lane |
|---|---|---|
| `content/abilities.json` + `abilities.proto` + Go/TS loaders | New (4.1); vectors in `content/vectors/abilities.json` | A |
| `content/combat.json` + `combat.proto` | `castCost` moves to the ability table | A |
| `content/fishing.json` + `fishing.proto` (content) + loaders | New (5.4); vectors in `content/vectors/fishing.json` | A |
| `content/items.json` + `items.proto` | `fish` action; `willow-rod`, `mill-roach`, `millers-fry`, `recipe-card-millers-fry`; Finn's seller row sells the rod | A (schema and rows) |
| `content/crafting.json` | `craft-willow-rod`, `hearth-millers-fry` | A |
| `content/furnishings.json`, `content/homestead.json` + protos | The `stable` piece (furnishing art, footprint, base) and its home-item row (minTier 2, price); a `stable` section: `{ "item": "stable", "maxStalls": 6, "stallCost": { "timber": 8, "stone": 4, "fiber": 2 }, "growth": { "timber": 4, "stone": 2 } }` | A |
| `content/quests.json` | *A Line in the Race*, line `crafts` | G (data, after A) |
| `content/contract.json` | 5 | A |

### 6.4 Migration 030 `crafts`

0.4 ended at 029 (`029_quest_tree.sql`), so 0.5 starts at **030**, one migration, lane A:

| Table | What |
|---|---|
| `player_companions` | `account_id` PK (FK players), `follow_pet TEXT NOT NULL DEFAULT ''`, `mount_out TEXT NOT NULL DEFAULT ''`, `mount_home TEXT` |
| `yard_pets` | `(account_id, slot)` PK, slot 1–3, `pet_key TEXT NOT NULL` |
| `homestead_stalls` | `(homestead_id, stall)` PK, stall 1–6, `mount_key TEXT NOT NULL`, `owner_id` FK players |
| `homestead_items` | gains `stalls INTEGER` (NULL except the stable) |
| `sync_baselines` | gains `class_mark TEXT` |
| `player_ability_ready` | `(account_id, ability)` PK, `ready_at REAL NOT NULL` |
| `world_changes` | 5.4 |
| `fishing_casts` | `id` PK, `account_id`, `world_id`, `water`, `bank`, `rod`, `species`, `band`, `seq`, `started_at`, `ready_at`, `hold_until`, `state` (`open`, `kept`, `released`, `cancelled`, `lapsed`), `closed_at`; a unique partial index on `account_id` where `state = 'open'` |
| `player_fishing` | `account_id` PK, `cast_seq INTEGER NOT NULL DEFAULT 0`, `last_start REAL` |

No backfill: no rows means Habitica's current pet, an empty yard, no stable and a full pond. The
level mark is already populated; the class mark fills at the next sync. Upgrade tests use 0.4's
fixture pattern: the owner's account loads, its follower is Habitica's current pet, riding is off
until a stable, and ledger sums are unchanged.

### 6.5 What the client keeps and predicts

- `src/lib/abilities.ts` (loader) and `getCombatKit` from the table, the class, the level mark.
- `src/lib/fishing.ts` (loader, the band from a stock for previews, bank lookup).
- `src/lib/yard-pets.ts` (2.3).
- `predict.ts` gains the eight operations; `link.ts`'s `TYPED` registry and the outbox kinds
  gain them (`src/lib/api/operations.ts`, `outbox.ts`).

### 6.6 "What's new"

Under `[Unreleased] → ### For players` in `CHANGELOG.md`, in this order:

- Riding has moved home. Build a stable after the Workshop, stall a mount, and set out from there:
  M to ride or get down, and it follows you on a lead through the village.
- Choose which of your pets walks with you, and up to three to live at home, in the Character
  panel's new Companions tab. Friends' pets follow them now too, and you can pet any of them.
- At level 20 each class learns a second move: Stand, Kindle, Ward-light or Echo. It's on R, and
  the second ✦ on phones.
- Heroes without a class fight with what's in hand. Fingersnap is the mage's.
- Fishing at the mill pond. Ask Finn about the rod by his door.

---

## 7. The Habitica boundary

Checked against [habitica-boundary.md](../habitica-boundary.md), rule by rule.

**Mirrored from Habitica (read, never written, never granted):**

| What | Habitica field | Used for |
|---|---|---|
| Owned pets | `items.pets` (value > 0) | The follower picker, yard pets, the checks |
| Owned mounts | `items.mounts` (value `true`) | Stalls, the checks |
| Current pet | `items.currentPet` | The default follower, and the fallback |
| Current mount | `items.currentMount` | **No longer used for riding.** Kept in the profile; nothing reads it in 0.5 |
| Class | `stats.class`, `flags.classSelected` | The craft (and the class mark) |
| Level | `stats.lvl` | The level mark |
| Pet and mount art | Habitica's sprite host | Followers, yard pets, stalled, led and ridden mounts |

No new Habitica fields: these are all in `USER_FIELDS` already.

**The game's own:**

- The **choice** of follower and yard pets, the **stable** and its stalls (a building, like the
  Workshop), **which mount is out**, the lead.
- The **abilities**, mana and Glimway's health. Ward-light heals Glimway health only, never
  Habitica's; Stand isn't Defensive Stance (no damage reduction), and none of the four copies a
  Habitica class skill (magic.md "Habitica boundary notes").
- The **rod**, the **roach**, the **fry** and the recipe card.

**The rules, one by one:**

1. *Never grants a Habitica item, pet or mount.* Nothing here grants one. The stable gates riding
   in Glimway, not anything Habitica grants (pets.md).
2. *No copies.* No stand-in pet or mount anywhere: an empty stall is drawn empty, and a hero with
   no pets has no follower. The mill roach is a cooking ingredient with its own species name, not
   Habitica's "Fish" pet food; it feeds nobody and can't be fed to a companion (fishing.md "What
   fish are for").
3. *Game items fill gaps.* The rod is a working tool with wear and an action, like the axe and the
   spade. Lane A checks its name against the Armoire list before the art round, as was done for the
   axe and the pick.
4. *Gear decides the look.* The rod is drawn held at the hero's side while fishing and never as
   worn gear; the lead rope and the stable draw nothing on the hero.
5. *Writes need consent.* There are none. Choosing a follower or a stalled mount never changes
   Habitica's current pet or mount.
6. *Value flows in only.* Nothing pays out.
7. *Guests.* No companions; magic follows their lack of class; fishing works for them unchanged
   when guest accounts arrive.

**Answers this release gives the boundary doc's open questions** (update its "Open questions" when
0.5 ships): *Companions* — any owned pet the player picks in-game, without a write (pets.md,
agreed). *Mounts* — faster, every mount the same (155), and only from a stable.

---

## 8. Phones

Every new interaction works with touch, through the controls phones already have: the joystick,
the big action button, the ✦ cluster and the panel buttons. Targets are at least 44 CSS px.

| Interaction | On a phone |
|---|---|
| Choosing a follower, yard pets, stalls | The Character panel's Companions tab (tabs at the top, as the journal's). The picker is a full-height sheet: a search field, species chips that scroll sideways, a grid of pets three or four across; tap to choose |
| Petting a pet | The action button says **Pet** near one |
| Choosing a mount for a stall, Saddle up, Build a stall | The action button at the stall, as at any piece |
| Riding and getting down | A saddle button appears in the touch cluster while a mount is out (Ride / Get down), with a small **Go home** beside it (pets.md "Getting down") |
| The second move | A second round ✦ in the cluster beside the first, with its own cost badge and cooldown ring |
| Kindle's aim | No aiming: 2 tiles ahead in your facing, the same on every device |
| Fishing | Hold the rod from the belt ring; the action button says **Cast**, then **Pull in** while you wait (it cancels), then **Reel**; Keep and Let it go are two big buttons over the action corner. A joystick nudge doesn't cancel: only leaving the bank by more than a tile does |
| Notices | Toasts, as today |

The touch cluster gets crowded: the second ✦ and the saddle button are new. Lane F owns
`TouchControls.svelte` and `Hud.svelte` and adds a small **context buttons** row to them (a store
the game pushes entries into: saddle, Go home, Keep/Let it go), so lanes E and G add buttons
without editing those files. Keyboard: R for the second move, H for Go home (both free in
`src/content/controls.ts`), and the controls list's M row gains its touch line.

---

## 9. Art list

One request for the image-generation round; `docs/art-request-crafts.md` is written from this
list when the round starts. Same direction as `docs/art-request-indoors.md`: **64 texels per 16 px
world tile**, 1 px dark warm-brown outlines at that density, light from the upper left, crisp
pixels, no soft gradients, three-quarter top-down view, transparent backgrounds. Deliver into
`assets/generated/crafts-pass/` with `manifest.json`, `atlas.json`, README and `prompts.json`
notes. Every sprite lists its footprint, canvas and foot point; animated pieces are horizontal
strips, frames left to right, same canvas each.

**The style rules from 0.4 (indoors.md 7.0) apply to the stable** though it stands outdoors: four
facings only (the stable faces front), scaled to the people **and to the mounts** (a stall's half
door comes to a person's chest; the bay is tall enough for the largest Habitica mount drawn at game
scale, lane E measures it from `avatar-render.ts` before the round), the same pixel density as the
residents, collision at the base, no baked backgrounds, still by default.

**No pets or mounts are drawn.** They're Habitica's sprites; an empty stall is empty.

### 9.1 Ability icons and effects

| Piece | Canvas (texels) | Frames | Notes |
|---|---|---|---|
| Ability icons, 20 | 64 × 64 each | 1 | Five per class (magic.md): warrior Cleave, Heave, Pin, Stand, Brace; mage Fingersnap, Name a lamp, Read a route stone, Kindle, Old ways; healer Mend, Mend (working), Settle, Ward-light, Mended glade; rogue Shadowstep, Read the drift, Walk a blind route, Echo, Sense the turning. Only 8 ship in 0.5; the rest wait in the atlas for their release. Same frame and palette family per class |
| Stand: a ground ring | 128 × 64 | 4 (planting, then held) | A ring of pressed earth and small stones at the feet, warm brown |
| Kindle: a patch of hollow light | 192 × 128 | 4 (loop) | About 3 tiles across, ground-level, pale hollow-gold flames low to the ground, not fire; readable over grass and the Tangle's floor |
| Ward-light: a still circle | 160 × 96 | 1 base + 3 (a pulse) | About 2.5 tiles across, soft green-gold rim on the ground; the pulse is a brighter ring moving outwards |
| Echo | — | — | Made in code from the hero's own layers (tinted, half transparent). No art |

### 9.2 The stable

| Piece | Footprint | Canvas | States | Notes |
|---|---|---|---|---|
| Stable, west end (tack room and stall 1) | 4 × 3 | 256 × 320 | 1 | Timber and thatch in the house style; the tack room's door, a saddle peg and a lantern hook; stall 1's bay on its east half. Rises 2 tiles. Drawn in two layers: **back** (walls, hay rack, the bay's back) and **front** (the half door and posts) so a mount stands inside |
| Stall bay | 2 × 3 | 128 × 320 | front: 2 (half door shut, half door open) | Repeats east, 1 to 5 times; back and front layers as above. Open when the stall is empty or its mount is out |
| East gable end | — | 32 × 320 | 1 | Overlay on the last bay's east edge, closing the roof line |
| Placement ghost | — | — | — | Code tints the art, as for other pieces |

### 9.3 Fishing

| Piece | Canvas | Frames | Notes |
|---|---|---|---|
| Willow rod icon | 64 × 64 | 1 | Inventory and belt; a plain willow rod with a cork grip and a wound line |
| Rod held | 128 × 128 | 2 (raised for the cast, held out) | Drawn at the hero's side, never over the hero's worn gear; the foot point is the hand. The line is drawn in code |
| Float | 32 × 32 | 4 idle bob + 2 bite (a dip) | Red and cream quill float |
| Water rings | 64 × 32 | 3 (loop) | Around the float, and on the bank when the water's healthy |
| Landing splash | 64 × 64 | 4 | |
| Mill roach icon | 64 × 64 | 1 | Silver with red fins; also arcs out of the water on landing |
| Miller's fry icon | 64 × 64 | 1 | Two small floured fish in a pan, a sprig on top |
| Recipe card: Miller's fry | 64 × 64 | 1 | In the style of Hazel's existing recipe cards |

### 9.4 HUD and small things

| Piece | Canvas | Notes |
|---|---|---|
| Companions tab icon | 64 × 64 | A paw print on a small tag |
| Saddle (Ride / Get down) | 64 × 64 | A saddle; the same icon for both, the label changes |
| Go home | 64 × 64 | A horseshoe over a little roof |
| Pet heart | 32 × 32, 3 frames rising | Small and warm; there's no heart among the emotes today |
| Lead rope | — | Code: a slack curve from the hand to the mount's head |
| Yard pet nap "z" | — | Code |

---

## 10. Lanes

**One integration branch,** `exp/crafts`, cut from `expansion` once One schema is merged there
(it is, at `1bbb7c7`). Lanes merge into it, each keeps `go test`, `npm run verify` and its unit
tests green, runs only its own changed e2e specs at the end, and the full suite runs once at the
integration gate (e2e load: the machine bogs down otherwise).

| Lane | What | Owns (files) | Depends on | Size | Kind | Model |
|---|---|---|---|---|---|---|
| **A. Contracts** (merges first) | Every proto change in 6.1 and the generated code; contract 5; error codes 211–219; `abilities` and `fishing` content schemas, loaders both sides, vectors; `combat.json` shrink; the items, crafting, furnishings and homestead rows of 6.3; migration 030 (schema only); the `worldchange` package with its tests | `proto/**`, generated code, `content/{abilities,fishing,combat,contract,items,crafting,furnishings,homestead}.*`, `content/vectors/{abilities,fishing}.json`, `src/lib/{abilities,fishing}.ts` loaders, `server/internal/store/migrations/030_*`, `server/internal/worldchange/**` | `expansion` at `1bbb7c7` | **M** | backend | MiMo |
| **B. Companions and the stable, server** | The `-1` fix (Go and TS mappers, the test turned around); `companions`, `stall`, `mount-out`, `mount-home`, `stable-extend`; the stable's placement rules; `HomeView.stalls` and `yard_pets`; lazy validity; new lease and world move clear `mount_out`; presence avatar fields and `PresenceAvatarChange` | `server/internal/api/{companions,stable}*.go` (new), `home_placement.go`, `home_deeds.go`, `presence_auth.go`, `sessions.go`/play, `server/internal/habitica/**`, `src/lib/habitica/mapping.ts`, `server/internal/store/**` for its tables | A | **M–L** | backend | GLM 5.3 Flash; Opus reviews |
| **C. Magic, server** | The level mark on `profile` and `PlayerState.magic`; the class mark; per-ability report bounds (4.4) with the partition fixtures; `PresenceAbility` checks and relay; ward credit | `server/internal/api/{report,profile_report}.go`, `presence_socket.go` (its event switch), a new `presence_abilities.go`, `server/internal/rules/**` | A | **M** | backend, correctness-heavy | MiMo; Sol reviews |
| **D. Fishing, server** | The three fishing operations and the read; stock through `worldchange`; lapse rules; world move closes a cast; `marketBuy` grants instances | `server/internal/api/fishing*.go` (new), `market.go`, the world-move handler, `server/internal/store/**` for its tables | A | **M** | backend | GLM 5.3 Flash or MiMo; Opus reviews |
| **E. Companions and riding, in the game** | The follower's motion (`pet-follower.ts`); friends' pets and mounts (`loadPresenceAvatar`, remote players, the lead); the Character panel split into Hero and Companions tabs; the picker; yard pets (`yard-pets.ts`) on the homestead scene; Pet; the stable scene (bays in two layers, mounts inside, Saddle up, Choose a mount, Build a stall); placement mode with the growing footprint; `toggleRide` on `mount_out`; the doorstep wait; the predictions for B's operations | `src/game/entities/{avatar,remote-players,homestead*}.ts`, `src/game/entities/pet-follower.ts`, `src/lib/yard-pets.ts`, `src/game/avatar-render.ts`, `src/ui/CharacterPanel.svelte` and new `src/ui/Companions*.svelte`, `src/lib/presence-codec.ts`, `src/lib/presence.ts` | A (fixtures before B merges) | **L** | UI/game | Opus |
| **F. Abilities, in the game** | `getCombatKit` from the table and the level mark; the classless kit; Stand, Kindle, Ward-light, Echo in `hero.ts`, `enemies.ts`, `creatures.ts`, `fx.ts`; the second slot (R, the second ✦); `ui.ability` as two slots; the report's `ability_casts`; sending and drawing `PresenceAbility`, the ward pulses on others; the unlock toast; the Abilities section (a component inside E's Hero tab); the **context buttons** row in the HUD and touch controls | `src/lib/combat*.ts`, `src/game/entities/{hero,enemies,creatures,fx,warden}.ts`, `src/game/link.ts` report fields, `src/lib/api/reports.ts`, `src/ui/{Hud,TouchControls}.svelte`, `src/ui/AbilitiesSection.svelte` (new), `src/ui/store.svelte.ts`, `src/content/controls.ts`, `tests/combat.test.ts` | A | **M–L** | UI/game | Opus |
| **G. Fishing, in the game** | The banks on the interactions path; Cast, Pull in, Reel, Keep and Let it go; the float, rings, splash, sound and reduced motion; the band lines and the waters read; `pose: fishing`; the rod on the belt (`belt.ts`); *A Line in the Race* data and lines; the "What's new" lines for the release | `src/game/entities/fishing.ts` (new), `src/lib/fishing.ts` (beyond A's loader), `src/lib/belt.ts`, `src/game/worlds.ts` (the village's bank data only), `src/content/quests/a-line-in-the-race.ts`, quest data in `content/quests.json`, `CHANGELOG.md` | A | **M** | UI/game | Opus |
| **H. Art** | Section 9 as one request; delivered, checked against footprints, with prompts and notes | `assets/generated/crafts-pass/**`, `docs/art-request-crafts.md` | nothing | **M** | art | Luna |

**Order:**

1. **H starts at once**: art takes longest and needs no code. E, F and G use placeholders until it
   lands (a coloured box for the stable, the existing class effects for the moves, a dot for the
   float).
2. **A merges** (a day or two). It fixes the files every other lane reads.
3. **B, C, D (server) and E, F, G (game) run in parallel.** Each game lane works against fixtures
   from A until its server lane merges.
4. **The seams, each with one owner:**
   - `CharacterPanel.svelte`: E splits it into tabs first (a small change, merged early); F's
     Abilities section is its own component placed in the Hero tab.
   - `Hud.svelte` and `TouchControls.svelte`: F owns them and lands the context-buttons row early;
     E and G push entries into its store.
   - `link.ts`'s `TYPED` registry and `predict.ts`: each lane appends its own operations; nobody
     edits another's entries.
   - The presence codec: E owns it; F's ability event is a small request to E, or E adds both
     events at once from A's protos.
5. **E and F wire H's pack** when it arrives (`atlas-plan.ts`).
6. **The integration gate:** the full e2e suite, then the owner's playtest (6 below).
7. After the release, the review round (plan.md, "Stepping back between releases").

**e2e,** run only by their lane until the gate: the follower choice surviving a reload (E); a
friend's pet drawn (E, two players); building a stable, stalling, Saddle up, M down and up, Go
home, the village lead (E); a classless hero beating the finger-wisp and settling the Warden (F);
a level-20 hero casting the second move with mana going down on the next report (F); two players,
one Ward-light, the other's HP rising (F, C's credit); cast to Keep at the north bank, cast to
Let it go, a reload with a line out, the race bank in the Quiet (G, dev clock); *A Line in the
Race* end to end (G).

**The owner's playtest:** pick a follower and three yard pets and see them from a friend's visit;
build the stable and two stalls, saddle up, ride out to the Tangle and back through the village on
the lead; a classless fight; a level-20 fight with the second move; fish the pond with a friend
until it goes quiet, and come back later; cook the fry.

---

## 11. Open questions, with defaults

**Confirmed, 2026-10-09:** the owner took every default below. They chose 3, 5 and 6 directly, and
also chose to run the three game lanes (E, F, G) in parallel. Only real choices are here; everything
the earlier docs decided is taken as decided.

1. **The world-changes table now, with fishing as its first writer.** *Default: yes,* as plan.md
   and server-first.md say. The alternative, a `fishery_stock` table of its own, is simpler today,
   but then the first working (lake country) would either build the table anyway or add a third
   shape. Fish keep their own recovery inside the row's state; the row's `ends_at` is what generated
   waters will use when their chunk turns.
2. **The server doesn't store ridden or led.** *Default: only which mount is out.* pets.md listed a
   `{key, state}`; no rule reads the state (speed is client-side), so it goes in presence as a
   pose. If shared fights later want mounted rules, the state can move to the server then.
3. **Ward-light heals others in 0.5.** *Default: yes, through the presence hub's ward credit*
   (4.5), as magic.md's build order says ("goes through presence"). It's the only server work the
   level-20 moves need beyond the report. If lane C finds it costs more than a few days, the
   fallback is a Ward-light that heals only its caster in 0.5, with others drawn but not healed,
   and the credit added with shared fights.
4. **Rebirth and the class.** *Default: remember the last class seen and keep the craft while
   Habitica reports no class and the level mark is 10 or more.* magic.md promises rebirth never
   takes magic away, but the craft follows the current class, and a reborn hero may come back
   classless until they choose again. Lane C checks what a reborn account really returns against a
   real account (`docs/habitica-foundations.md`); if Habitica keeps the class through a rebirth, the
   class mark is just never used.
5. **The stable grows as one building.** *Default: one placed piece whose footprint grows east by 2
   tiles a stall* (3.2). Separate bay pieces that snap to the stable would let a player arrange
   them, but need a new "attached to" placement rule and rules for moving a stable with bays
   around it. One building keeps placement, moving and removing as they are.
6. **More stalls and shared stalls (pets step 5) in 0.5.** *Default: yes.* The plan's row says "the
   stable and riding"; pets.md calls step 5 small once step 4 is in, and a joint deed needs a stall
   rule on day one anyway.
7. **Where the first rod comes from.** *Default: Finn gives it in A Line in the Race, sells
   another for 2 embers, and the bench makes one for Workshop owners.* fishing.md wanted a rod
   without needing a workshop; a quest gift puts a person behind it and teaches the bank, and the
   seller row keeps fishing open after a rod breaks.
8. **A ready fish waits 10 minutes, through a reload.** *Default: yes,* then it slips off and goes
   back. fishing.md left the hold open; ten minutes covers a closed tab and a cup of tea without
   letting reservations block the pond for long; with one open cast per account, the fish held never
   outnumber the people at the bank.

**Tuning, not decisions** (playtest them, change data): capacity 12 and one fish per 10 minutes;
the band thresholds and waits; the rod's 20 uses; the fry's 18 HP and 6 mana; the stable's 30
embers and materials and the stall growth; the four moves' costs, cooldowns and sizes; the yard
pets' segment lengths.
