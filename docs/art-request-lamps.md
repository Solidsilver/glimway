# Art request: the 0.9 Lamps pass

For the image-generation agent. Follow the style of `docs/art-request-playtest1.md` and
`assets/generated/playtest1-pass/` (the Tangle's outdoor props), and section 3 of
`docs/design/lamps.md`. Deliver to `assets/generated/lamps-pass/` with:

- source sheets and per-frame canvases;
- a source manifest and an atlas;
- prompts, a README and a contact sheet;
- a builder that recreates the frame crops and metadata from the source sheets.

## Global spec

- **Density:** 64 texels per 16 px world tile. Use each listed canvas exactly. Record each
  piece's tile footprint and its bottom-centre foot point. For placeable art, collision sits at
  the base, never the whole picture.
- **View and style:**
  - Straight-on, front-facing props in the three-quarter top-down view the residents use. No
    in-between angles (indoors.md 7.0; the 0.7 look fixes redrew every angled prop).
  - Crisp pixel art with 1 px dark warm-brown outlines at this density. Light from the upper
    left. No blur, antialiasing or soft gradients.
  - Scale against the Commons residents and the hero: a way-lamp's head is a head taller than a
    resident.
- **Palette:**
  - Iron-oak timber and grey-gold stone, as in the Tangle set.
  - A **warm amber** flame for a way-lamp (`world-lantern-post-lit-warm-amber`'s hue).
  - A **cooler, paler gold** for a lamp lit by a mage's naming, so the two read differently at a
    glance.
- **Delivery:** transparent backgrounds. Aspect-contained crops on native-size transparent
  canvases. Keep the source art and record the crops. Props are still by default; only the flame
  may have a slow loop (indoors.md 7.0, rule 7).
- **No placeholders.** Every listed state is final art.

## Lamps in the Wilds

`lamp-stone-dark` and `frontier-veil-0..3` moved to the open map's request
(`docs/art-request-open-map.md`), because 0.8 places them. The relit and named stones below must
match that dark stone.

| Key | Footprint | Canvas | Notes |
|---|---:|---:|---|
| `way-lamp-unlit` | 1×1 | 96×192 | A Keeper's way-lamp, front-on: a squat footing of packed stones, an iron-oak post, a bracket and the lamp head (glass panes, iron cap). Dark glass. The old `world-lantern-post-*` (16×32, items pass) gives the shape; this is that post grown up and redrawn at the new density |
| `way-lamp-lit-0..2` | 1×1 | 96×192 ×3 | The same, lit warm amber; three flame frames for a slow loop. The light sits in the head, not painted on the ground (the game adds its glow) |
| `lamp-stone-relit-0..2` | 1×1 | 64×128 ×3 | The dark lamp stone with a wick burning warm amber in the niche; three flame frames |
| `lamp-stone-named-0..2` | 1×1 | 64×128 ×3 | The dark lamp stone lit by a mage's naming: paler, cooler gold, a little steadier. Three frames |
| `route-stone-dark` | 2×1 | 128×128 | The far route stone: the road lamp stone with a flat cut panel beside it, lines of carved text that read as writing (not real letters), moss in the cuts |
| `route-stone-relit-0..2` | 2×1 | 128×128 ×3 | The same, its niche lit warm amber; three flame frames |

## Items and UI

| Key | Canvas | Notes |
|---|---:|---|
| `item-lamp-ash` | 64×64 | A pinch of grey ash with one warm fleck still glowing |
| `item-lamp-ash-pouch` | 64×64 | A small drawstring pouch in ash-grey cloth, a little ash at the neck |
| `item-homing-turncap` | 64×64 | A turncap set in a bead of amber, its stem leaning one way |
| `icon-lamps-tab` | 32×32 | Retired: the Journal has no Lamps tab (lamps.md Q9). The map's Lamps layer takes its place; see below |
| `item-bench-trowel` | 64×64 (16×16 in the pack) | Drawn (items pass, `item-bench-trowel-whole` and `-worn`). A short hand trowel: pale pine grip, a small dull scrap-iron blade, a little earth on the tip. Same weight as the bench spade's icon. Two frames like the other bench tools (whole, worn). |

Reused, no new art: Mara's portrait, the naming slip (`item-naming-slip`), Name a lamp's ability
icon (`crafts-pass`), the lamp head, wick and hearth oil icons, and the `glow` image.

## As delivered and wired (0.13)

The open-map pass (`assets/generated/open-map-pass/`) delivered the Wilds rows above as
`lamp-stone-relit-0..2`, `route-stone-dark`, `route-stone-relit-0..2` and `way-lamp-0..2`
(64×96: dark, lit, dimming). The game draws:

- **Relit stones:** `lamp-stone-relit-*` as a slow loop over the dark stone, with the game's warm
  glow on the niche. The three flame frames differ by a few texels inside a 10×20-texel niche, and
  the flame is pale, so at play zoom the glow does the reading and the loop barely shows. A
  brighter, larger flame with more movement between frames would help.
- **Route stone:** the Keeper's-hand quest stone (the first Lantern Road stone past the
  Whitequiet) is drawn as `route-stone-dark`, and `route-stone-relit-*` once lit. The cut
  panel stands on the tile east of the stone.
- **Way-lamps:** `way-lamp-1` (lit) and `way-lamp-2` (dimming) for camps and communal posts.
  `way-lamp-0` (dark) has no state to show: a camp is lit or dimming, then lapses, and a post is
  lit or waits at Pell's.
- **Not delivered:** `lamp-stone-named-0..2`. Not needed yet: the mage's naming is parked (lamps.md Q6).

## The map's Lamps layer

The world map marks each lamp where it stands while its Lamps layer is on, and the layer's toggle
carries the same icon. For now both use the items pass's `item-way-lamp` (a 16-px inventory icon:
a tall, thin post that loses its lamp at map scale), on a cream disc. Wanted:

| Key | Canvas | Notes |
|---|---:|---|
| `map-lamp-lit` | 64×64 (16×16 in the pack) | A map mark, not a prop: a small lamp head (iron cap, glass, warm amber flame, `world-lantern-post-lit-warm-amber`'s hue), front-on and squat, filling most of the cell. Strong 1 px dark warm-brown outline so it reads on green, grey-gold and water. No post or footing. |
| `map-lamp-dimming` | 64×64 (16×16 in the pack) | The same head, guttering: a low, smaller flame, the glass mostly dark, a little more orange. It must read as the same lamp, weaker, beside the lit one. |

- **Match the map's marks:** the map draws flat cream label chips (`#fff5dc`, outline `#84734e`),
  a 12-px red "you" dot with a cream ring, and amber (`#ffe4a1`) for dimming. The icon sits on a
  20-px cream disc, so keep its edges inside the cell with 1–2 texels' margin.
- **Crisp pixel art,** light from the upper left, no glow painted outside the head. The map adds
  nothing round it.
- **Deliver** with the open-map pass's `icon-map-tab` (`assets/generated/open-map-pass/`,
  manifest, atlas, frames and contact sheet). The game then adds both keys to
  `openMapIconUrls` and points `MAP_LAMP_ICON` (`src/lib/wilds/map-lamps.ts`) at them.
