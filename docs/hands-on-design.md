# Hands-on world: homesteads, items, and things to touch

Status: agreed with the owner 2026-10-05; building now. Extends
`docs/expansion-design.md` (sections 2–3) and the canon in
`docs/lore/chronicle.md`.

## Goals

- Building a home is something to dig into for players who love it, and a reason
  to go into the Tangle. Fighting and loot stay rewarding for everyone else.
  Neither is required.
- The world is something you handle: pick things up, use them, sit, smell, fix.
- Any number of players, and partners who build one home together.

## 1. Homesteads, second version

### The Commons is a lane of gates

- Each homestead has a **gate and signpost** on the Commons lane. Walking
  through a gate leads to that homestead: **its own map**, seeded per plot.
- The lane always shows **a couple of spare "unclaimed land" gates** beyond the
  claimed ones, so there's always somewhere to settle. More players simply
  lengthen the lane.
- **Visiting** is walking through a friend's gate. Read-only for visitors.

### Your land

- Each homestead starts as **wild land**, seeded per plot: trees, stumps, a
  boulder or two, sometimes a stream bend or a slope. You can clear it, build
  around it, plant, or chop. Every homestead grows into a different shape.
- **Expansion by lantern light** (canon: Silas's deed measures land "in
  lantern-light instead of yards"; land only stays put where a named lamp holds
  it). Set a new **lantern post** at your edge and **name it**: the ground within
  its light becomes part of your homestead. Posts cost timber, stone and a little
  amber oil, more for each post. Optional; the long-term building goal.
- The cottage tiers, decorations, placement, storage, crafting and mail from
  phases 3 and 5 carry over onto the new land.

### Claiming, sharing and leaving

- **One homestead per player, always.** Everything else follows from that.
- **Claiming:** walk the lane, read the signs, choose an unclaimed gate, and buy
  the deed from Silas (the first deed is free; see "lost deeds" for later ones).
  After the deed, the journal and a marker lead you to your gate.
- **A joint deed (partners):** a member invites another player; to join, **both
  stand at Silas's table at the same time** (both present in the Commons, near
  Silas, via presence) and confirm. Silas amends the deed with both names. Two or
  more players can share a homestead this way.
- **Everyone on a deed is equal:** all can build, place, expand and use the home's
  shared chest.
- **Personal chest:** each member also has a small personal chest at home that
  goes with them if they leave.
- **Leaving:** you take only what's on you (your pack) and your personal chest;
  placed furniture, the shared chest and lantern posts stay with the homestead.
  You can then claim or join another.
- **Lost deeds:** a homestead with no members grows **desolate** (overgrowth,
  dark windows, the sign weathering) and after a while its **deed is lost**: the
  land returns to unclaimed, its contents gone, and the deed must be bought from
  Silas again by whoever settles there next.

## 2. Items and inventory

- One **inventory** (I key and a HUD button) with tabs: **Tools**, **Supplies**
  (materials and one-use things), **Keepsakes**, **Home goods** (decorations),
  **Papers**. New-item dots; icons from the art pack.
- Every item has a **kind** and its own rules, stated in its description:
  - **Tools** (axe, spade, pick, bucket, watering can…) **wear with use**. Some are
    **repairable** (heirloom quality: at zero they're blunt or cracked until
    mended at the workshop bench or by Orrin/Silas); cheap ones **break** and are
    gone.
  - **Consumables** are one-time (Hazel's twists, Elara's tea, salves): small
    effects like restoring mana or easing the drift.
  - **Keepsakes** (trinkets): some give a small help (Hollis's fox makes papers
    glint brighter), some are only for display.
  - **Materials** and **home goods** as today.
- **Picking things up:** more of the world can be picked up (a coil of rope, a
  lost glove, a dropped bucket), fitting the canon that the woods give things back.

## 3. Things to touch

- **Flavor:** smell flower pots, draw water from the well (fills a bucket), sit on
  benches and chairs (sit pose, slow regen), ring a bell, read signs.
- **Repairs:** small breakages around the village (the well's rotten rope, a fallen
  fence rail, a leaking roof) each need an item (rope from fiber, a rail, a
  shingle). Fixing one changes the village and people notice. A **village chores**
  list on the notice board points to them, beside the bigger projects.

## 4. Gathering

- **Chop trees in the Tangle** with an axe; trees regrow when you leave and come
  back (the drift). **Stone** from boulders with a pick; **seeds and saplings** with
  the spade, to plant at home.
- Trees are client-side scenery, so the server **caps gathering** per area visit
  and per day rather than validating each tree (the invite-only trust model).

## 5. Later: old ways

Two lamps given **the same naming** become one place: step through one and come out
at the other. A late reward: crafted with storm-grade amber, or a broken one found
in the Whitequiet and restored. The homestead design must not block it.

## Build order

1. Homesteads v2 (this section 1).
2. Items and inventory (section 2).
3. Things to touch (section 3).
4. Gathering (section 4).
5. Old ways, later.

Nobody plays on a server yet, so homestead data can be reset rather than migrated.
