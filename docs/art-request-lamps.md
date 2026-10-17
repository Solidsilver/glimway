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
| `icon-lamps-tab` | 32×32 | A tiny way-lamp, lit, for the journal's Lamps tab; same frame and weight as the other tab icons |
| `item-bench-trowel` | 64×64 (16×16 in the pack) | Drawn (items pass, `item-bench-trowel-whole` and `-worn`). A short hand trowel: pale pine grip, a small dull scrap-iron blade, a little earth on the tip. Same weight as the bench spade's icon. Two frames like the other bench tools (whole, worn). |

Reused, no new art: Mara's portrait, the naming slip (`item-naming-slip`), Name a lamp's ability
icon (`crafts-pass`), the lamp head, wick and hearth oil icons, and the `glow` image.
