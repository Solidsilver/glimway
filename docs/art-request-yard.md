# Art request: the 0.7 Yard pass

For the image-generation agent. Follow the style of `docs/art-request-indoors.md` and section 2.8
of `docs/design/silas-yard.md`. Deliver to `assets/generated/yard-pass/` with source sheets,
per-frame canvases, a source manifest and atlas, prompts, README, contact sheet and a builder that
recreates frame crops and metadata from the source sheets.

## Global spec

- **Density:** 64 texels per 16 px world tile. Use each listed canvas exactly; record its tile
  footprint and the bottom-centre foot point. For placeable art, collision sits at the base.
- **View and style:** three-quarter top-down RPG view, not isometric; crisp pixel art, 1 px
  dark warm-brown outlines at this density; light from the upper left; warm lived-in woodland
  palette; no blur, antialiasing, or soft gradients. Scale props beside existing Commons furniture
  and people.
- **Delivery:** transparent backgrounds; aspect-contained crops on native-size transparent
  canvases; preserve the source art and record crops. In-room work should feel used and practical.
  Match the indoors kit's timber and plaster character.

## Silas's shop, `in:commons:yard`

| Key | Footprint | Canvas | Notes |
|---|---:|---:|---|
| `yard-counter` | 3×1 | 192×128 | Kit counter dressed with plot book, pencil, row of carved foxes, and a tin. |
| `yard-timber-rack` | 3×2 | 192×192 | Against the back wall; cut boards, stone stack, and tied fibre bundles. |
| `yard-mending-bench` | 1×2 | 64×192 | Side-on; a vice, hung felling-axe shape, oil, and rags. |
| `kit-side-doorway` | 1×2 | 64×128 | Inner doorway in a side wall; match the indoors kit and leave a usable passage. |

The display corner and dressing reuse home goods and the kit from section 2.3; they need no new art.

## Pell's deed office, `in:commons:yard:deeds`

| Key | Footprint | Canvas | Notes |
|---|---:|---:|---|
| `deeds-pigeonholes` | 3×2 | 192×192 | Rolled deeds in pigeonholes; pin the Commons plot map above, with lane and gates. |
| `deeds-clerk-desk` | 1×1 | 64×128 | Tall standing desk, inkwell, and ledger. |
| `deeds-table` | 3×2 | 192×128 | Table set for signing; leave space for the kit chairs placed beside it. |

## Exterior and resident

| Key | Footprint / canvas | Notes |
|---|---|---|
| `cottage-silas` | Existing 96×92 canvas | Redraw the current cottage at exactly its existing footprint. Add a hanging sign showing a fox and a saw. Draw the front door as usable. |
| `pell-idle-0`, `pell-idle-1` | 186×283 per frame | Front-facing idle pair on the current Commons resident canvas and scale. Same thick outline and soft chunky shading as the live resident sheet; Pell is a careful clerk with sleeve-guards and ink on one finger. No walk frames or other facings. |
| `portrait-pell` | 64×64 | Dialogue bust matching the Commons residents' portrait sheet in canvas, crop, and style. |

Keep the ambience modest and lived-in. Use the other residents' scale and the portrait sheet's square
bust framing. Preserve a clear walkable threshold at Silas's front door.
