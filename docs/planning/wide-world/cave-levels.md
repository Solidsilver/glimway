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

- **Mouth direction:** Argon wants every mouth to face south (a notch on other flanks); Sol wants
  mouths to have identity, bounds and orientation. Owner to decide when iteration 2 is briefed.
- **Ramp length:** Argon would cap a generated ramp at one level with a landing between. Owner to
  decide then.
- Both responses' iteration 2 lists (bounded plans and halos, roof clearance, float light heights,
  chunk caches, visibility vs light vs access) feed that brief.
