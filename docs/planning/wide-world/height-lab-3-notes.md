# Height lab, round 3: notes

*exp/height-lab-3, 2026-10-20. Lane agent: Claude Opus 5.5.*

## Short answer

- **What was wrong.** Round 2's cave light was mostly right as data and broken on screen:
  1. The dark was drawn through a Phaser render texture that put **one row of the dark map** over the
     whole view. The owner's black valley in `owner-4` came from this. A node dump of round 2's map
     showed the valley clear and the bands matching row 71 (the lintel row).
  2. The **hard vertical bands** in `owner-2`/`owner-3` were the cave layer's **rock walls** of the
     tunnel, painted over the sunny cliff face and the mountain as the cave's view faded in.
  3. The surface was faded by a screen-wide "daylight here" amount, so sunny land went dark with
     you. The cave's view came in over a single tile.
  4. Crystals' glows were sprites above the dark, so a crystal looked lit while the floor round it
     wasn't lit the same way. The hero's light was an erase brush inside the same broken texture.
- **What changed.** The lab now has **one lighting system** (`src/game/height-lab/lighting.ts`, design
  below), the first version the game's lamps, rooms and windows could move onto. The light is the
  place's ambient plus every source, shadowed by rock. It's one image over the view, multiplied over
  the world. No render texture and no shader, so it works the same in WebGL and Canvas.
- **Seen on CI.** A new spec (`e2e/height-lab-screens.spec.ts`) puts the hero at set spots and saves
  screenshots. Three CI runs; I downloaded and looked at every image in each. Run 1 found four more
  problems, run 2 one more, and run 3 is what's below.

## The lighting system

**Model.** `light = ambient(place) + Σ source × falloff × visibility`, clamped to 1 per channel. The
screen is the world multiplied by it.

- **Ambient per place** is a field on the tile grid, per layer: daylight on the surface. In a cave
  it's a low cave dark, plus daylight spilling in through each mouth and fading along the walked floor
  over the "daylight reaches" setting (3/6/10 tiles). Add open air (the land you see out of a mouth,
  and the cliff faces above it) at full daylight, and the hill over your head at none. Open air
  reaches 16 walked tiles from a mouth and is gone 6 further on, so land over a cave's far rooms isn't
  sunny from inside. Indoors would be a dim ambient. Night is the surface ambient in another colour.
- **A source is data:** `{ id, x, y, layer, z, color, radius, inner, intensity, moving }`.
  Crystals, lamps, lanterns, hearths and windows differ only in their numbers. The hero's light and
  Wren's lantern are `moving: true`.
- **Shadows:** a "stops light" grid per layer (rock). A source lights a tile if a straight line to it
  stays over clear tiles. The end tile may be the wall itself, so a wall facing a light is lit.
  Visibility is per tile, sampled bilinearly between tile middles, which gives a soft half-tile edge.
  A level of height difference counts as two tiles of distance.
- **Where the work is:** still sources and the ambient are baked once into a texel map per layer (a
  texel is 4 px). Adding or removing a still light re-stamps only its box. Moving sources work out
  their tile visibility again only when they cross a tile. Each frame, the view's texels (about
  110×70) are copied, the moving lights added over their boxes, and the result written to one small
  canvas texture. That texture is drawn once with MULTIPLY, linear-filtered and texel-aligned to the
  world, so it never swims.
- **Cost:** about 0.5 ms a frame on CI (the HUD's "light" figure, `states.json`): the close or wide
  light plus Wren, two views mixed. Node on this host: 0.4 ms a frame, 52 ms to build the mountain's
  light. The upload is about 30 KB a frame. A phone should be around 1–2 ms; the phone screenshots ran
  at 0.41 ms with CPU unthrottled.
- **Why not a shader yet:** this runs the same in WebGL and Canvas (no fallback to write), node tests
  read every number, and the GPU does one multiply a pixel. Shadows at tile resolution suit pixel art.
  The limits: the soft edges are a quarter tile at best, and each moving light costs CPU. If either
  matters later, the same interface moves to a shader: the baked map becomes a texture, moving lights
  become uniforms, occluders a texture. Callers don't change.
- **Fog by level** stays per-object alpha this round. It belongs in the same pass as the light
  eventually (a shader would do both), but it's per level, not per place.

**Interface** (pure, no Phaser):

```ts
const lights = new Lighting({ w, h, tile: 16, res: 4, layers: 2 })
lights.setAmbient(layer, rgbPerTile)      // Float32Array(w*h*3)
lights.setOccluders(layer, stopsPerTile)  // Uint8Array(w*h), 1 stops light
lights.setLevels(layer, levelPerTile)     // Int8Array(w*h)
lights.add(source); lights.move(id, x, y, layer?, z?); lights.set(id, change); lights.remove(id)
lights.at(layer, x, y)                    // [r, g, b]
lights.fill(rect, rgbaOut, [{ layer, weight }, …])  // the frame's texels
```

**How the game would move onto it:** road lanterns (`src/game/area/lanterns.ts`) become still
sources added when lit. The glow sprite can stay as the flame. Rooms (`room-art.ts`) get a dim warm
ambient, lamps and hearths as sources, and walls as occluders. Windows (`house-lights.ts`) become
small sources outside the wall at night. Day and night set the surface ambient from the clock. The
game streams chunks, so the baked map would be per chunk (24×24 tiles is 96×96 texels), baked as a
chunk arrives.

## The transition

The cave's view comes in over **3 walked tiles** by default (1 is still in the dev panel). Its light
mixes in over the surface's by the same amount. The surface stays drawn, and the light decides what
of it shows: open air stays lit, and the hill over you goes dark. The cave's floors fade in. The hero
always gets a small light: "None" is a faint 22 px glow that shows the hero, not the floor.

## Screenshots (CI run 39488715808, `lab/height-3/`, 3/4 size)

| Image | What it shows |
|---|---|
| `m01-approach` | The valley in front of the mountain's east mouth, on the surface: no light layer drawn. |
| `m03-one-in` | One tile into the arch: the cave's view a third of the way in, everything still sunny, the cliff clean round the arch (no bands). |
| `m04-two-in` | Two in: the mountain over you dimming, the valley and the cliff face bright, daylight on the tunnel floor ahead. |
| `m05-three-in` | Three in: the cave's view fully in. The hill over you is dark, the valley behind is bright, and the lit floor ahead fades into dark. |
| `m07-mid-tunnel` | Down the ramp, floor −1: the hero's close light round them; ahead, a crystal lights its corridor blue, and the corridor's walls stop it. |
| `m08-none-crystal-in-corridor` | Own light None, two tiles from that crystal: its light fills the corridor and stops at the rock. The hero shows in a faint glow. |
| `m11-two-crystals-overlap` | The cavern (−4): teal and purple crystals overlap and add up between them. Blue reaches from the west. |
| `m12-west-tunnel-looking-out` | The west tunnel, looking back out: the valley and the cliff face bright beyond the mouth. |
| `m14-none-cavern` | The cavern with own light None: the crystals' light alone, the hero readable. |
| `s05-chamber` | The shoulder's chamber: three crystals, rock dark between them, the land outside the second mouth at the right edge. |
| `p02-mid-tunnel` | A 390×844 phone at 3×: the same tunnel. (The phone's HUD covers the lab's line; that's the game's HUD, not this lane.) |

`states.json` has the lab's state at each shot: layer, floor, daylight, how far the cave's view is
in, the light at the hero, and the light's time per frame. The spec saves 29 shots in all. CI keeps
them for 7 days in the run's `e2e-full-evidence` artifact, under `height-lab/`.

**How to get them:** the spec runs on the GPU E2E job whenever `src/game/height-lab/**` changes
(`e2e/changed-map.json`), on dev and main full runs, and on any manual full run
(`gh workflow run ci.yml --ref <branch> -f full=true`). Then
`gh run download <run> -n e2e-full-evidence`.

## What to look at (owner)

1. Walk into the mountain's east mouth slowly. Over three steps the mountain above should go dark
   while the valley behind stays sunny. Daylight should lie on the tunnel floor and fade into dark.
2. Stand three tiles in and look back (the camera shows the valley): it should be bright.
3. Go down to the first crystal: the corridor is lit blue whether you're near it or not, and the
   light stops at the walls. Switch your own light to None: the corridor stays as lit. You stay
   visible.
4. In the cavern: the crystals' colours overlap. Wren's lantern lights the floor round them as they
   walk by. The light doesn't follow you.
5. Daylight reaches 3/6/10 and the 1-tile view change still work from the dev panel.

## Left for later

- Fog by level into the same pass as the light (a shader would do both).
- Sub-tile shadow edges, if tile-soft ones look too blocky round thin pillars (`m09-ledge` in the
  artifact shows the stair steps of a cave's outline in crystal light).
- The game's lamps, rooms and windows on this system (not in this lane, as asked).
