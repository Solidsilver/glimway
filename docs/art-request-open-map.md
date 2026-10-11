# Art request: the 0.8 open map pass

For the image-generation agent. Follow the style of `docs/art-request-playtest1.md` and
`assets/generated/playtest1-pass/` (the Tangle's outdoor props), and section 5 of
`docs/design/open-map.md`. Deliver to `assets/generated/open-map-pass/` with:

- source sheets and per-frame canvases;
- a source manifest and an atlas;
- prompts, a README and a contact sheet;
- a builder that recreates the frame crops and metadata from the source sheets.

## What the game paints itself

The ground is painted by code (`src/game/wilds/tangle-art.ts`): woods floor, meadow grass,
water, banks and the joins between them. This pass is the pieces the painter can't make well:
props, the river's stones, laid-path and road tiles, the lamp stone and the drift. Match the
painter's palette (`src/game/wilds/wilds-looks.ts`) so pieces sit on the painted ground.

## Global spec

- **Density:** 64 texels per 16 px world tile. Use each listed canvas exactly. Record each
  piece's tile footprint and its bottom-centre foot point. For props, collision sits at the base,
  never the whole picture.
- **View and style:**
  - Straight-on, front-facing props in the three-quarter top-down view the residents use. No
    in-between angles (indoors.md 7.0; the 0.7 look fixes redrew every angled prop).
  - Ground tiles (paths, road, ford stones) are seen from above, flat, and must tile edge to edge
    with their own variants.
  - Crisp pixel art with 1 px dark warm-brown outlines at this density. Light from the upper
    left. No blur, antialiasing or soft gradients.
- **Palette:**
  - The meadow: warm, open greens with straw in them, a step lighter than the Tangle's floor;
    wildflowers in small, muted points (no saturated rainbow).
  - The Wend: dark, slow water, grey-green at the banks; stones grey-gold as in the Tangle set.
  - Laid stone: the grey-gold stone, set by hand, a little uneven. Laid plank: iron-oak timber.
  - The Lantern Road: older, paler, worn paving with moss in the joints.
- **Delivery:** transparent backgrounds for props; ground tiles fully opaque. Aspect-contained
  crops on native-size canvases. Keep the source art and record the crops. Props are still; only
  the listed loops move (indoors.md 7.0, rule 7).
- **No placeholders.** Every listed piece and frame is final art.

## Meadow props

| Key | Footprint | Canvas | Notes |
|---|---:|---:|---|
| `meadow-grass-0..2` | 1×1 | 64×64 ×3 | Tall grass clumps, three variants; walkable decor |
| `meadow-flowers-0..2` | 1×1 | 64×64 ×3 | Low wildflower patches, three variants; walkable decor |
| `meadow-outcrop-0..1` | 2×2 | 128×160 ×2 | A grey-gold stone outcrop breaking the grass, lichen on top; solid. Two variants |
| `meadow-oak` | 2×1 | 160×256 | A lone, broad meadow oak; its crown well above, its trunk solid at the base. Not iron-oak: rounder, lighter |
| `meadow-stone-0..1` | 1×1 | 64×64 ×2 | A single fallen stone in the grass; solid |

## The Wend

| Key | Footprint | Canvas | Notes |
|---|---:|---:|---|
| `bank-stones-0..2` | 1×1 | 64×64 ×3 | A few wet stones at the water's edge, to scatter along painted banks; walkable decor |
| `ford-h-0..2` | 3×1 | 192×64 ×3 | Flat stepping stones across shallow water, for a route crossing left to right; three frames of a slow ripple loop around them |
| `ford-v-0..2` | 1×3 | 64×192 ×3 | The same for a crossing top to bottom |

## Laid paths and the road (ground tiles, from above)

| Key | Footprint | Canvas | Notes |
|---|---:|---:|---|
| `path-stone-0..3` | 1×1 | 64×64 ×4 | Hand-laid flat stones with soil between; four variants that tile together. The painter softens the edges where they meet grass or woods floor |
| `path-plank-h-0..1` | 1×1 | 64×64 ×2 | Planks laid across, for a path running up and down; two variants |
| `path-plank-v-0..1` | 1×1 | 64×64 ×2 | Planks laid along, for a path running left and right; two variants |
| `road-paving-0..3` | 1×1 | 64×64 ×4 | The Lantern Road's old paving: larger, paler, worn stones, moss in the joints; four variants that tile together |
| `road-verge-0..1` | 1×1 | 64×64 ×2 | A broken paving edge sinking into grass, for the road's sides; two variants |

## The lamp stone and the drift

Moved here from the lamps request (`docs/art-request-lamps.md`), because 0.8 places them.

| Key | Footprint | Canvas | Notes |
|---|---:|---:|---|
| `lamp-stone-dark` | 1×1 | 64×128 | An old road lamp stone: a cut stone pillar about waist-to-chest high, with a lamp niche near the top and soot on its lip. Weathered, standing, whole. Kin to `world-old-lamp-stone-intact-weathered`. 0.9's relit and named states must match it |
| `frontier-veil-0..3` | 3×1 | 192×64 ×4 | The drift closing the way at the frontier's edge: pale threads across the ground, a few turncaps leaning back the way you came. Loops; tiles edge to edge along a long boundary. Colours from the Turning's veil |

## UI

| Key | Canvas | Notes |
|---|---:|---|
| `icon-map-tab` | 32×32 | A tiny folded map with a path drawn on it, for the journal's Map tab; same frame and weight as the other tab icons |

Reused, no new art: the Tangle's woods pieces (`playtest1-pass`), the Whitequiet's birch and pine,
nodes, camps and chests, and the `glow` image.
