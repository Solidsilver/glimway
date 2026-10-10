# The Habitica boundary

See also [habitica-policy.md](habitica-policy.md): Habitica's rules for third-party tools and our plan for telling them.

Status: agreed with the owner 2026-10-07. Use this doc to check every feature
that touches Habitica data, or that adds an item, slot or currency.

## The principle

**Habitica is who you are. Glimway is what you do in the world.**

Your look, your class, your gear, your companions, your gold and your record
of showing up all belong to Habitica, and you earn them there. Glimway
shows the real ones and never hands out its own. The game fills the gaps:
work tools, materials, crafted goods, homes, keepsakes and embers, which
Habitica doesn't have. Keeping the earning in Habitica keeps the reason to
open Habitica.

## Rules

1. The game never grants a Habitica item, pet, mount, background or currency.
2. The game never makes its own copy of something Habitica has. If Habitica
   has it, show the player's real one. If the player doesn't own it, show
   nothing, not a stand-in.
3. Game items fill gaps. A Glimway item must be something Habitica has no
   version of, or must do a job (chop, dig, carry, light) that Habitica gear
   doesn't do.
4. Habitica gear decides how you look. Glimway items never draw over the
   hero's worn Habitica gear, and Habitica gear never works as a Glimway
   tool.
5. Any write to Habitica needs explicit consent each time, says what it will
   change in Habitica's own words ("this spends 120 of your Habitica gold"),
   and is logged in-game where the player can read it.
6. Value flows into the game only. Nothing in Glimway pays out to Habitica
   (no gold, gems, items or XP).
7. Guests have no Habitica self. The guest hero (Wren, classless, default
   look) is a stand-in for "no account", not a copy of anyone's things. Rules
   1 to 4 apply to connected heroes.

## What comes from where

What the game uses today, from `USER_FIELDS` in `src/lib/habitica/client.ts`
and `server/internal/habitica/client.go`, plus what's planned.

### From Habitica (mirrored, never granted)

| What | Habitica field | Used today for | Status |
|---|---|---|---|
| Who you are | `_id`, `profile.name` | Account key, name tags | OK |
| Appearance | `preferences` (size, shirt, skin, hair, background, costume flag) | Hero and presence avatars | OK |
| Class | `stats.class`, `flags.classSelected` | Combat kit, off-hand affinity | OK. The kits (bolt, cleave, dash, heal) are Glimway's own moves, not copies of Habitica skills |
| Worn gear | `items.gear.equipped`, `items.gear.costume` | Avatar layers; gear stats feed combat | OK |
| Owned gear | `items.gear.owned` | Not read | **Changing in 0.6:** the wardrobe, cosmetic only, read by the server only (sign-in, a top-up, "Check for new gear"); see [design/purse-and-wardrobe.md](design/purse-and-wardrobe.md) |
| Pets and mounts | `items.pets` (value > 0), `items.mounts` (value `true`), `currentPet`, `currentMount` | Since 0.5: the follower (any owned pet chosen in the Companions tab, Habitica's current pet by default), up to three yard pets, mounts stalled in the stable and ridden or led from there; friends' pets and mounts drawn. Nothing is written to Habitica, and `currentMount` no longer decides riding | OK |
| Level, attributes | `stats.lvl`, `str/int/con/per`, `buffs` | Combat stats | OK |
| XP | `stats.exp` | Embers: every 10 XP earned becomes 1 ember | OK. Read only, and each XP pays once |
| Health and mana | `stats.hp`, `stats.mp`, `maxHealth` | Imported once, then game-local vitals | OK, with a note below |
| Gold | `stats.gp` | Fetched inside `stats`, ignored | **Changing in 0.6:** the purse, moved in with consent each top-up, read by the server only for the move; see [design/purse-and-wardrobe.md](design/purse-and-wardrobe.md) and [habitica-gold.md](habitica-gold.md) |
| Party | `party._id` | Party worlds and admission | OK |
| Streaks, achievements | not read | | Planned: in-world recognition (plaques, a stable) |
| Habitica art | Habitica's sprite host | Avatar layers, cached by the server | OK. Non-commercial and attribution-bound (`ASSETS.md`) |

Health note. Rests, road lanterns and the hearth refill in-game health and
mana without touching Habitica, and Habitica damage reaches the game only as
a genuine external change at sync. That's fine under the rules: the game
never writes HP back and never lets a rest stand in for a Habitica heal at
0 HP (that still needs embers earned from XP, or a real heal on Habitica).

### From Glimway only

| What | Examples (`content/items.json`) |
|---|---|
| Embers | Earned from Habitica XP, spent only in the game |
| Tools | Bench axe, pick and spade, stave bucket, watering can, heirlooms, the oak-mark punch |
| Carried things | Carter's lantern, whistles, turncap jar, salve satchel |
| Carry gear | Forager's satchel, work apron, carting coat (a second pocket; not drawn on the hero) |
| Materials and supplies | Timber, stone, fiber, oils, remedies, seeds, fittings |
| Crafted goods | Bench and hearth recipes, each with a maker's mark |
| Homestead | Cottage, workshop, furniture, home goods, the door-fox carving |
| Keepsakes | Whittled fox, river-glass bead, tin whistle, the Ember Charm |
| Papers | Found texts, recipe pages |
| Purse gold (0.6) | Moved in from Habitica with consent; never back out; moves between players on shelves, in letters and by hand |

## Where today's game is close to the line

Nothing in the game grants a Habitica item or writes to Habitica today. Four
things sit near the line.

1. **The off hand overlaps Habitica's shield slot.** Habitica's `shield` slot
   is the off hand, and the avatar already draws it. `OffHandVisual`
   (`src/game/entities/off-hand.ts`) draws Glimway's carried thing at the
   hero's side too, so a hero with a Habitica Mystic Lamp equipped can show
   two lights in two hands. The game even uses Habitica's word for the slot,
   "the off hand" (it opens when you take a class,
   `server/internal/api/items.go` `offHandOpen`). Fix: rename it to
   something Habitica doesn't have ("at your belt", "carried"), and draw the
   carried thing at the belt or hip, never in the shield's hand position.
2. **Some tools share a name or idea with Habitica Armoire gear.** Habitica
   has a Lamplighter weapon (with a Lamplighter's Greatcoat and Top Hat), a
   Gardener's Spade, a Mining Pickax, a Battle Axe, a Bucket, a Mystic Lamp,
   a Lifeguard Whistle, and several aprons and coats. Glimway has Nan's
   lamplighter pole, Ada's garden spade, Orrin's mason pick, the bench axe,
   the stave bucket, Carter's lantern, whistles, the work apron and the
   carting coat. Under rule 3 these pass, because they're working tools with
   wear and actions, and Habitica's versions are worn gear with stats. They
   become violations if the game ever draws them as worn clothing or gives
   them combat stats. Nan's lamplighter pole is the closest; keep it a tool.
3. **Carry gear could turn into armor.** The satchel, apron and coat live
   only in the inventory today. If they're ever drawn on the hero, they cover
   Habitica's `armor` and `back` slots. Keep them undrawn, or show them only
   in the inventory.
4. **The README promises no writes.** README "Your Habitica character
   (read-only)", `docs/import-contract.md` (`HabiticaClient` has one method),
   and the connect guide's "The game limits itself to reading"
   (`src/content/connect-guide.ts`) are all true today. The gold purse breaks
   them. Rewrite all three in the same change that ships the purse.

The fox carvings (door-fox, whittled fox, mirror-wise fox) are objects, not
pets. Keep them still. When companions arrive they must be the player's real
Habitica pets, so no game creature follows the hero.

## Checklist for a new feature

Answer each before a brief goes out:

- [ ] Does Habitica already have this thing, or one that looks like it
      (gear, pet, mount, background, quest, skill, currency)? If yes, show the
      player's real one, or leave it out.
- [ ] Does the feature grant, unlock or earn anything that Habitica grants?
      It must not.
- [ ] Does a Glimway item draw on the hero where Habitica gear is drawn
      (head, body, armor, back, weapon, shield, eyewear, headAccessory, pet,
      mount)? It must not.
- [ ] Does it write to Habitica? Then: explicit consent each time, the exact
      change in Habitica's terms, a line in the in-game log, the token used
      for that one request and never kept, and a README and connect-guide
      update.
- [ ] Does value leave the game for Habitica? It must not.
- [ ] Does it read a new Habitica field? Add it to `USER_FIELDS` (client and
      server) only when the feature ships, and check it against a real
      account (`docs/habitica-foundations.md`).
- [ ] Does it give the player a reason to skip Habitica (earning in the game
      what they'd earn there)? Redesign it.
- [ ] Does it still work for a guest, with a stand-in that isn't a copy?

## Open questions

- **Streaks and achievements.** What can recognition be (plaques, titles,
  a line from an NPC) without becoming a reward that pays in game items?
- **Habitica gold beyond the purse.** Could a later feature buy Habitica
  gear for the player from inside Glimway? That's a Habitica purchase
  made from the game; the rules say no until the owner says otherwise.
- **The off-hand placement.** The name is settled (below); drawing the
  carried thing at the belt or hip, away from the shield's hand, is still
  open (item 1 above).

## Answered

- **Companions** (0.5, [design/crafts.md](design/crafts.md) §2): any owned
  pet the player picks in-game, without a write to Habitica. The game may
  show a different pet than Habitica does.
- **Mounts** (0.5, crafts.md §3): faster, every mount the same speed, and
  only from a stable.
- **The wardrobe** (0.6, [design/purse-and-wardrobe.md](design/purse-and-wardrobe.md)
  §4): a player can wear a different outfit in Glimway, chosen per slot from
  gear they own, without a write to Habitica. Stats still come from the
  battle gear.
- **The off-hand name** (owner, 2026-10-09): Glimway's off hand becomes "at
  your belt" in the copy, with 0.6; the wardrobe calls Habitica's slot
  "Shield".
