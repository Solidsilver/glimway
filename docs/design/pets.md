# Pets and mounts: design

Status: agreed with the owner 2026-10-07, ready for briefs. Numbers are first guesses for
playtesting. Parked directions are at the end.
Topic from [ideas.md](../ideas.md) ("A pet overhaul"). Check every rule here against
[habitica-boundary.md](../habitica-boundary.md).

## Conclusions

- **Pets are about presence and charm** for now. Making them useful is parked.
- **Pets open in tiers.** Before a homestead, your Habitica current pet follows you. With a
  homestead, you pick any pet you own to follow you (from anywhere) and up to 3 yard pets
  that live at home.
- **Riding needs a stable.** Building one at home opens riding with one stall; more stalls
  come as the homestead grows, up to 6. Every mount rides at the same speed.
- **You set out with your mount from home.** Get down and it follows on a lead; tell it to
  go home and it walks back to its stall. Each new session starts with it at home.
- **Joint deeds share stalls,** and only a mount's owner rides it.
- **Charm:** the follower hops, turns and sits; friends' pets are drawn; yard pets wander
  and nap; you can pet any pet; residents remark on yours.
- **Habitica:** read only, nothing written, nothing granted, only what you own is shown, no
  new fields. Built on a general companion layer so a Habitica-free spin-off stays possible.
- **Riding changes for today's players:** it stops until they build a stable, so the
  "What's new" card says so.

## How it works today

- **What we read.** The server and client fetch `items.pets`, `items.mounts`,
  `items.currentPet` and `items.currentMount` (`server/internal/habitica/client.go`,
  `src/lib/habitica/client.ts`). The owned lists are stored on the profile and
  validated, and nothing uses them.
- **The pet.** Your Habitica current pet is one static image that trails 14 px behind
  the hero with a soft follow (`src/game/entities/avatar.ts`, `buildPetFollower`). It
  doesn't animate, react, sit or notice anything. No current pet on Habitica means no
  pet here.
- **The mount.** M rides your Habitica current mount outdoors: 155 speed against 110 on
  foot (about 1.4×) and a slightly faster dodge. The village is a no-ride zone, and you
  dismount on entering it. Riding is only allowed when both mount layers load.
- **Other players.** Presence sends each hero's current pet and mount, but other
  players' pets aren't drawn, so you never see a friend's pet.
- **Changing pets.** Only on Habitica, then a sync.
- **Guests.** No pet or mount, which is correct under boundary rule 7.
- **Art.** Habitica pets and mounts are single still frames from Habitica's sprite host
  (1248 pet keys, 1178 mount keys, catalogued in `content/habitica-gear.json`). Any
  motion has to come from code: a bob, a hop, a flip.
- **Small bug.** Habitica stores a pet that's been raised into a mount as `-1`. The
  server's `v != 0` check counts it as owned, so the owned pet list includes pets the
  player no longer has.

## The heart of it

Right now the pet is a sticker that follows you. The overhaul makes your real
Habitica companion feel present: it has somewhere to live, it notices the world, and
having it with you matters a little. The game never raises, feeds or grants one.

## Direction so far

**(agreed)** Start with the stable idea (A): a simple way to manage pets, unlocked in tiers.
Pets are about presence and charm for now. Helps in play (B) and the way back (C) stay
parked as later ideas.

**(agreed)** The game may show a pet other than your Habitica current one, picked from
pets you own, with no write to Habitica. Boundary rules 1 and 2 still hold: only pets you
really own, never a stand-in.

### Tiers (agreed in outline)

1. **No homestead.** Your Habitica current pet follows you, as today. No riding.
2. **A homestead.** Pet management opens. It defaults to your Habitica current pet, and you
   can pick any pet you own to follow you instead, from anywhere, in a **Companions** tab
   in the Character panel. **(agreed)** Up to **3 yard pets** (owned, your pick)
   live at home, where visitors see them. **(agreed)**
3. **A stable built at home.** Riding opens. The first stable has **one stall**; you choose
   which owned mount stands in it, and that's the mount you ride. **(agreed)**
4. **More stalls.** Add stalls as the homestead grows, one mount each. Every stalled mount
   stands at home, and you choose among them which one to ride. **(agreed in outline)**

**Why riding is gated (owner).** Getting your mount straight away feels too strong, and
building toward it gives players more to do.

**What this changes today.** Any Habitica hero with a current mount can ride outdoors with M
right now. With this design, riding stops until they build a stable. Players will notice,
so say so in the "What's new" card, and give M a friendly line when it's pressed without a
stable ("Your mount needs somewhere to stand at home first. A stable, maybe.").

### Setting out with your mount (agreed)

You don't summon a mount. You fetch it from its stall at home and set out with it.

| State | What it means | How you get there |
|---|---|---|
| **In its stall** | Stands at home; visitors see it | Default; or after it's sent home |
| **Ridden** | You're on it, faster outdoors | Saddle up at the stall, or press M while it's on the lead |
| **On the lead** | Walks behind you, beside your pet | Press M to get down and keep it with you |
| **Going home** | Walks off the edge of the screen, then it's back in its stall | "Go home" when you're off it |

- **Getting down:** M gets you down with the mount on the lead, ready to ride again. "Go
  home" is a separate button (on phones, in the action bar while a mount is out).
- **The village** stays a no-ride zone: you lead your mount through it, as the gate toast
  already says.
- **Fighting, sitting, chopping:** a mount on the lead stops and waits where it is, and
  comes on again when you move off. Enemies ignore it.
- **Going home is instant in the rules.** The walk off the screen is only for show. The
  server only needs to know which mount is out (if any) and who has it.
- **A new session starts with the mount at home.** **(agreed)** If you leave while it's
  out, it finds its own way back to its stall. Nothing is lost; you fetch it again next
  time.
- **Joint deeds:** partners share the stalls. Each partner stalls their own mounts, and
  only a mount's owner can ride or lead it. Partners and visitors can see every stalled
  mount. **(agreed)** That keeps boundary rule 1: nobody rides a mount they didn't earn
  on Habitica.

### Stable and stall numbers (agreed as first guesses, tune in playtest)

- **Stable:** a homestead building on the outdoor plot, after the Workshop tier (it's
  timber work). It comes with stall 1. Cost: 30 embers, timber 16, stone 8, fiber 6.
- **Each extra stall:** an add-on beside the stable. Cost grows like lantern posts. For the
  *n*th extra stall: timber 8 + 4(*n*−1), stone 4 + 2(*n*−1), fiber 2.
- **Cap:** 6 stalls per homestead (shared on a joint deed), which also bounds how many
  mount sprites a homestead draws.
- A stall can stand empty. Emptying one doesn't refund anything.
- Ride speed stays as today (155 against 110 on foot). Every mount rides the same, so a
  rare or gem-bought mount is never faster.

## Charm (agreed)

Pets stay about presence and charm for now. All five, cheapest first:

- **Motion from code.** The follower hops in time with your steps, turns to face where it's
  going, sits when you sit and settles beside you when you stand still for a while.
- **Friends' pets.** Draw other players' followers and mounts. Presence already sends them.
- **Yard pets wander.** The 3 yard pets wander slowly inside your lamplight, nap in the
  shade, and come over when you or a visitor walk up. Where they wander comes from a seed
  and the clock, so nothing is stored or ticked.
- **Pet a pet.** Tap or press E next to a pet (yours or a friend's): a little heart and a
  hop. Nothing is earned.
- **Residents notice.** A few residents remark on your companion now and then, by a handful
  of species families (canines, cats, birds, dragons, the odd ones like Cactus), with a
  plain fallback for the rest. Hollis-and-the-fox canon gives the fox lines.

## Rules and data

What the server stores (the Habitica lists already arrive with each sync):

- **Per player:** `followPet` (an owned pet key, or empty for "Habitica's current pet"),
  `yardPets` (up to 3 owned keys), and `mountOut` (`{key, state: ridden | led}` or none,
  cleared when a new session starts).
- **Per homestead:** `stable` (built or not) and `stalls` (up to 6 entries of
  `{mountKey, owner}`, empty allowed).
- **Every key is checked against the owner's latest owned list.** If a pet or mount drops
  out of that list (raised into a mount, or a fresh account), the choice quietly falls back:
  the follower to Habitica's current pet, a yard spot or stall to empty. Worked out when
  someone looks, never by a background job.
- **Speed is client-side,** as it is today (the invite-only trust model). The server only
  checks you have a stable, a stalled mount you own, and that it's the one out.
- **Presence** sends the follower you chose (not just Habitica's current pet), plus the
  mount and whether it's ridden or led.
- **Guests** get none of this (boundary rule 7).

## How it fits Habitica

- **Read only.** No writes. Choosing a follower or a stalled mount in Glimway never changes
  Habitica's current pet or mount.
- **Show only what you own.** No stand-ins, no game creatures, no hatching, feeding or
  raising.
- **No new Habitica fields.** `items.pets`, `items.mounts`, `currentPet` and `currentMount`
  are already read. Fix the `-1` check first.
- **Earning stays in Habitica.** Collecting pets and mounts is still something you do
  there; Glimway gives them a place to live. The stable gates *riding in Glimway*, not
  anything Habitica grants.
- **Backups (the standing goal).** Build this on a general companion layer: a key, a kind
  (pet or mount) and an art source. Habitica is the only source today. A Habitica-free
  spin-off could plug in its own companions later without changing the stable, the stalls
  or the follower. We make none of our own now (boundary rule 2).

## Art needed

- **The stable** (a homestead building, timber and thatch, in the house style) with
  **stall bays** as add-on pieces, 1 to 6 side by side. Front and empty-stall states.
- **A lead rope** drawn by code from the hero's hand to the mount's head. No new art.
- **Icons:** "Go home" and "Companions" for the HUD and the action bar.
- **Pets and mounts** themselves are Habitica's sprites; motion comes from code. Check that
  a mount's body and head layers look right with no rider (Habitica's own stable shows them
  that way, so they should).

## Build order (small shippable steps)

1. **Fixes and friends.** The `-1` check, the follower's motion (hop, turn, sit), and
   drawing friends' pets. Small; no new state.
2. **Companions panel.** With a homestead, choose your follower from owned pets; presence
   sends it. Small to medium: one server field, one panel.
3. **Yard pets.** Up to 3 at home, wandering and pettable. Medium: homestead scene work.
4. **The stable and riding.** The stable building with stall 1, mount states (ridden, led,
   going home), and riding gated behind it. The "What's new" card says riding moved. Medium
   to large: the biggest change to today's code (`toggleRide`, presence, homestead
   placement, the action bar).
5. **More stalls and shared stalls.** Small once step 4 is in.
6. **Residents notice.** Lines by species family. Small, mostly writing.

## Parked directions

**B. Companions with a nose.** Pets do small things in the world, grouped by Habitica
species, not by rarity: noses find glints (papers, forage), ears hear the drift or a
beetle coming, wings spot from above. Each gives one small help, like a keepsake. Risk:
premium pets bought with gems must not come out ahead.

**C. The way back.** Lore hook: the fox's long ear listens behind. Your companion
remembers the road and can lead you home from deep in the Wilds. That answers the "way
back" the exploration ideas need before anything opens past the Tangle. It depends on
systems that aren't built yet.

## Open questions

None blocking. Tune the stable and stall costs, and the 6-stall cap, in playtest.
