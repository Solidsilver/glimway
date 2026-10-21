# Terrain regions: fields, regions and the three biomes (lane B) — notes

*exp/terrain-regions, 2026-10-21. Built by Argon, finished by Claude Opus 5.5. From the owner's
calls in [terrain-decisions.md](terrain-decisions.md), Sol's §1 and §3
([terrain-sol.md](responses/terrain-sol.md)) and Argon's §1
([terrain-argon.md](responses/terrain-argon.md)). World lab only: nothing the game serves changes
(GenerateV3, LandformV1 and GeneratorV3 are untouched).*

## Short answer

- **Five lasting fields** (upland, relief, wetness, warmth, quiet), pure integer functions of the
  world seed and tile, never the weekly seed (`server/internal/wilds/fields.go`).
- **Regions about 32 chunks across**: one jittered site per 32-chunk lattice cell (±10 chunks),
  plain nearest-site distance after a bounded two-octave warp (up to 6 chunks), stable ids
  `r:<rx>:<ry>`, negative coordinates, ties by signed (ry, rx), a border-distance band
  (`regions.go`). The round land cells inside the woods are unchanged (call 1).
- **Three biomes**: `hearthwick-woods@1` (today's woods and meadow), `tops@1`, `whitequiet@1`.
  Area on the `map` seed's 256×256-chunk atlas: **66.3% woods, 23.7% Tops, 10.0% Whitequiet**.
  Over four more seeds (512×512 chunks each): woods 59–68%, Tops 20–28%, Whitequiet 8–13%.
  Whitequiet is 92–99% north of home.
- **From home** (Chebyshev chunks from chunk 0,0, `map`): woods at 0; **Whitequiet at 2** (the
  region holding the named Whitequiet place starts just north of the Tangle); **Tops at 8–9**
  (north-east, past the low shoulders). On the other seeds Tops is 4–12 chunks out.
- **Height stays world-wide.** Biomes pick ground and cover only; Upland is one field everywhere.
  Near home: flat for a chunk past Town and the Tangle, low shoulders 3–6 chunks out, the cap
  lifting over 6–9 chunks, then real mountains (call 7). The envelope is continuous (a test checks
  neighbouring tiles never differ by more than 40‰), so later height can't step at a ring.
- **Pins are a disposable manifest only** (no migration, no database): a region pins when a chunk
  in it is generated, plus "support" pins for neighbours whose blend band reaches that chunk.

## What each image shows

All in [lab/terrain-regions/](lab/terrain-regions/), seed `map`, each with its stats as `.json`.
Atlases are 256×256 chunks (−128..127) at 3 px a chunk; crops are 32×32 chunks at a pixel a tile.

| Image | Shows |
|---|---|
| `atlas-country.png` | The first biome look. Woods and meadow green as today; Tops rust moor, olive turf, pine valleys, scree and pale crag up high; Whitequiet ivory with grey-soil hollows and pale stone. Three kinds of country, in irregular regions. |
| `atlas-regions-biomes.png` | Region borders (dotted), sites (+) and `r:rx:ry biome@1` labels over the biome tint. Adjacent same-biome regions join into larger country. |
| `atlas-blend-pins.png` | Blend bands (gold), three-way junctions (magenta) and the regions the home frontier pins (gold diamonds). |
| `atlas-field-*.png` | The five fields. Upland: ridged chains, the flat home basin at the centre. Relief: dissection. Wetness: basins. Warmth: cooler north and up high. Quiet: leans north. |
| `region-home-*.png` | Chunks −16..15 around home. Town (hatched), the Tangle kept woods, the named Whitequiet place inside its own pale region, Tops beyond it to the north-east. The overlay version shows the band and a three-way junction east of Town. |
| `region-home-field-upland.png` | The home envelope at tile scale: flat apron, shoulders, mountains rising smoothly from 6 chunks. |
| `region-junction-*.png` | Chunks −108..−77, −55..−24: Whitequiet, woods and Tops meet at one point (negative coordinates). |
| `region-negative-*.png` | Chunks −112..−81, −128..−97: high Whitequiet beside Tops crag, in deep negative coordinates. High pale ground keeps ivory between stone outcrops. |

## How it works

**Fields** are permille values (0–1000) from integer value noise on two lattices (one rotated by a
3-4-5 triangle so there are no axis streaks), with `floorDiv` so nothing kinks at zero. Upland is
macro + ridged meso + local; wetness leans to low ground; warmth cools north and with height;
quiet leans north and is boosted around the named Whitequiet place.

**Regions.** `RegionAt` warps the tile, then takes the nearest three sites from a 5×5 window. The
exact distance to the primary/secondary bisector gives the band: 10 tiles each side, 5 when
Whitequiet is on either side so its pale edge stays crisp (Sol §1). Within the band, coherent
3–6-tile patches take the neighbour's biome, up to 48% at the line itself (32% for a third
region at a junction).

**Selection** reads the mean of 25 field samples around the site: Whitequiet where quiet is high
and an eligibility draw passes (much likelier north), else Tops where upland (plus a little
relief) is high, else woods. Home sits where four lattice cells meet; among those four, the one
holding the named Whitequiet place is Whitequiet, at least one other is Tops, and at least one is
woods. Which one holds Town isn't forced (call 7). The Tangle and Town always show as woods and
the named Whitequiet place as Whitequiet.

**Pins** (`RegionPin` in `biomes.go`): world seed, region id and site, biome and its version,
fields and landform versions, a recipe digest, the chunk that triggered it, and whether it's a
direct or support pin. The lab makes a fresh manifest for every render; the order chunks arrive
in doesn't change it (a test pins in reverse, concurrently). For the real table later (calls 4 and
8), a pin needs two more things: the catalogue revision it was made under, and the update turning
it was made in. At the next update turning, pins on land that isn't held are dropped, so those
regions take whatever the new catalogue gives them. Pins under held land, fixed places and the
routes into them stay, along with the generator code they name.

**The look** (`BiomeTileLook`, `BiomeAtlasColour`) only recolours ground and thins or adds cover
in the lab: Tops trees thin as you climb (rule 15): valley pines, scattered wind-bent pines on the
moor, rare boulders on scree, bare crag. Whitequiet has sparse pale birch and snags in small
stands, warm ivory grass, grey soil, and pale stone outcrops up high (call 6: pale, not snowy). In
the woods' half of a band, the thicket maze thins toward the neighbour.

## What the owner should look at in the world lab

1. **Atlas, Terrain / biome**, zoomed out from home: do the three kinds of country read, and are
   the regions shaped well (not boxes, not circles)?
2. **Overlays → Regions, Biomes, Blend, Pins**: region ids and biome@1 per region; the band and
   junctions.
3. **Region view around home**: Whitequiet two chunks north past the Tangle, Tops to the
   north-east. Is that the right walk?
4. **Field heatmap** chips (upland especially): the home basin, shoulders and first mountains.
5. **Tap a tile**: region, biome@version, border distance and blend partner, the five field
   values, and its pin.
6. **Whitequiet up close** (e.g. chunks −110..−80, −125..−95): is it pale enough, and not snowy?

## What I changed from Argon's work, and why

- **Removed the home site nudging.** Argon moved the four home regions' sites by hand so Town
  and the Tangle sat in a valley region. That isn't plain nearest-site, and the home 2×2 rule
  already guarantees all three biomes near home.
- **Wider jitter and warp** (±6 → ±10 chunks; warp 4 → 6 chunks). With Sol's ±6 the atlas showed
  a near-square grid of regions; now they're irregular polygons with bent borders. Still plain
  nearest-site with a bounded warp, as the owner chose.
- **The named Whitequiet place's region is Whitequiet**, not "whichever northern cell is
  quieter". Before, the place was a hard ivory square inside Tops moor; now it seeds its own
  neighbourhood, as Sol §1 asks.
- **Restored the Tangle and named-place overrides** that Argon's last edit dropped. Without them
  the Tangle could turn into Tops or Whitequiet ground.
- **A continuous upland envelope.** Argon's version mixed warped and unwarped distances, so
  upland jumped from 580 to about 760 at the 6-chunk ring: a future cliff. Now the cap and the
  shoulder floor ease in and out smoothly, and a test checks it.
- **Whitequiet palette back to warm ivory.** Argon's last pass had moved it to frost-blue greys,
  which read as snowy. I also made high ground ivory with stone outcrops and cut the grey soil, so
  ivory dominates.
- **Atlas without speckle:** the Whitequiet atlas colours use a 4-chunk patch field instead of
  the 5-tile one, which looked like noise at chunk scale.
- **Retuned the mix** (Tops and Whitequiet had drifted to 30% and 14%), and **added tests**: the
  mix across four more seeds, envelope continuity, and the named-place rule. One lab test assumed
  at least four home pins; it now asks for some pins, but fewer than the regions shown.
- Kept Argon's uncommitted work otherwise: Tops/Whitequiet cover by fields, woods feathering in
  the band, the wider band, the atlas border blend, the Hermite ramps, and the viewer's pin types
  (they now match the Go JSON, which the committed TypeScript didn't).

## Open questions

- Tops reaches about 8 chunks from home on `map` but 4 on three other seeds. If the owner wants
  Tops always a set distance out, that's a rule to add, not a tuning.
- The band is narrow next to the woods' thicket maze: the maze still ends fairly sharply against
  Tops. Wider feathering could come with the real cover work.
- Pins here record only direct and band-support regions. Sol suggests pinning the containing
  region's eight neighbours too until the support bound is proven.
