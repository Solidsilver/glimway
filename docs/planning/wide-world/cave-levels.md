# Cave levels and the mouth: what the owner decided

*2026-10-20. From [cave-levels-sol.md](responses/cave-levels-sol.md) (Sol) and
[cave-levels-argon.md](responses/cave-levels-argon.md) (Argon), both answering the owner's three
points on height lab round 3: the HUD, the mouth's floor from outside, and ghosting where a cave
changes level. Argon's build order is the base; Sol's cautions are folded in.*

## They agree on

- **The HUD** says "level" with two decimals in caves too. Cave walking is already smooth (the
  same `zAt`/`zIn` as the surface); only the HUD hid it. Owner: option 1.
- **Ghosting comes from translucent cave floors.** Depth fog lowers each cave slice's alpha, and
  since round 3 the surface ground, faces and trees stay drawn at full alpha underneath, so they
  show through (brighter in a lantern). Cave material must stay opaque.
- **One cave layer** with the shared edge-height rules. A layer per depth fixes nothing here.
- **Both slope styles in the lab:** cut stairs in built caves, rough ribs or scree in natural
  ones, with lips and toe shadows where a slope meets a flat floor. Real drops keep their faces.

## The owner's calls

1. **Depth is brightness only.** Levels above and below the hero's are darker, never tinted.
   Remove the baked cool-by-depth stone tint (`art.ts`); the owner is fine without it.
   Crystals, lanterns and the stone types still bring colour.
2. **The mouth floor gets live light.** From outside, show the real cave floor through the
   mouth, clipped to the opening and lit by the cave's own light at that place (daylight reach,
   lanterns, Wren, the sliders), not a baked patch. Stone stays stone across the portal; no grass
   under the arch; the lintel still covers the hero; buried rooms stay hidden.
3. **Darkness strength is a dev-panel slider,** defaulting near Argon's 55–65% cap.

## Also found

- **A second ghosting bug (Argon):** `sunnyFaceRock`/`openAir` mark the rock south of the
  shoulder's east tunnel (rows 22–24) as sunny, so its south wall isn't painted and the surface
  cliff and a pine show through (owner images 1 and 2).
- **Smooth light heights cost (Sol):** passing a continuous `z` to `Lighting.move` rebuilds
  visibility every frame on a ramp. Smooth the height penalty apart from the occlusion cache, and
  measure.
- **Where to darken:** inside the one lighting pass (Argon), so movers on other levels darken too
  and it fits the unified lighting system.

## Later, for iteration 2

- **Mouth direction (owner, 2026-10-20):** mouths have identity, bounds and an orientation (Sol).
  Built and planned caves face south, toward the camera, where the arch and stonework read.
  Natural caves mostly face south, sometimes east or west (side-on art, rarer). Nothing opens
  north: it would hide behind the hill. Where a north opening would go, natural caves use a
  **sink**, a hole in flat ground or a slope with a rough ramp down, readable from any side.
- **Ramp length (owner, 2026-10-20):** multi-level ramps are allowed (no one-level cap). Long
  straight staircases and square spiral stairs fit built caves; natural caves may wander down for
  a while, or split before reaching a larger room (if they reach one at all). Landings and bends
  are still welcome where they help, but they aren't a rule.
- Both responses' iteration 2 lists (bounded plans and halos, roof clearance, float light heights,
  chunk caches, visibility vs light vs access) feed that brief.

## The way in and the light you carry (owner, 2026-10-21, after playtesting round 4b)

- **The way in is Even (round 4)**: the least flashy, it "just works". Iris looked the most
  striking but would wear thin by the hundredth cave; Longer, eased and Dark first were only ok.
- **The cave's view comes in over 3 tiles**, which feels smooth. It becomes a notched slider
  (1 to 4 tiles) for more playtesting.
- **The three own-light modes all stay**, each tied to what the hero carries: **None** (just a faint
  glow round the hero) with no light source; **Close** for unshaped light such as a torch or a
  candle; **Wide** for a lantern, or a candle with a reflector behind it.
- **Bug:** hugging the cave wall beside the mouth and stepping out, the screen flicks to black for
  a step just as the fade is nearly done, then clears. It happens with every way in, and only
  right against the wall.

## Paused (owner, 2026-10-21)

The owner is very happy with the cave interaction after round 4c, and the caves and height
experiment is **paused** until real terrain generation exists. Then it opens again, with the
"Later, for iteration 2" list above as its start.

- **What the game should copy:** Even (round 4) as the way in; the cave's view over 3 tiles;
  opaque caves darkened by depth (no tint); the mouth floor seen from outside, lit live; built
  and rough slopes; the corner-distance fix from round 4c. Rounds 4 to 4c are written up in
  [height-lab-4-notes.md](height-lab-4-notes.md).
- **Kept in the lab's dev panel on purpose,** for when it opens again: the four ways in, the 1 to
  4 tile fade slider, own light None/Close/Wide (these become the light the hero carries),
  daylight reach, the darkness slider, slope styles and the levels overlay. Don't strip them in
  cleanup lanes.
