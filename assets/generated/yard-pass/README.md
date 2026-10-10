# 0.7 Silas's Yard art pass

The original pass used `image_gen` from `docs/art-request-yard.md` and design section 2.8; round 3 and round 4 playtest redraw sheets are hand-authored pixel art.
`jobs.json` records source crops, native canvas sizes, footprints and destination boxes;
`build_frames.py` rebuilds all frame PNGs, `manifest.json`, `atlas.json` and the true-size
`contact-sheet.png` from the preserved source sheets. The contact sheet keeps the finished frame
canvases at 1×, with labels and a checker backing for transparent edges. The current Pell pair has
one `pell-breathing` loop at 1.5 fps, matching the residents sheet.

## Frames

- `yard-counter` — front-facing counter with plot book, pencil, carved foxes, tin; 192×128, 3×1.
- `yard-timber-rack` — front-facing rack flat against the back wall, with cut boards, stone stack, tied fibre; 192×192, 3×2.
- `yard-mending-bench` — straight-on bench flat against the back wall, with hung axe, vice, oil and rags; 192×192, 2×2.
- `kit-side-doorway` — top-down gap in the edge-on side-wall band, with the floor running through; 64×128, 1×2.
- `deeds-pigeonholes` — straight-on back-wall pigeonholes, rolled deeds and Commons lane map; 192×192, 3×2.
- `deeds-clerk-desk` — front-facing standing desk with sloped writing top, ledger and inkwell; 64×128, 1×1.
- `deeds-table` — open ledger, deed papers, quill and inkwell; 192×128, 3×2.
- `cottage-silas` — shop face at its existing 96×92 canvas, with fox-and-saw hanging sign and openable-looking door.
- `pell-idle-0` and `pell-idle-1` — front-facing resident frames, each exactly 186×283, matching the in-game Commons resident sheet. Pell does not walk.
- `portrait-pell` — dialogue bust; 64×64.

## Simplification review

Round 2 aligned the counter and timber rack with the indoors kit’s straight-on furniture view. The counter faces the room; the rack sits flat against the back wall. The mending bench is straight-on against the back wall and occupies a 2×2 footprint. Round 4 adds richer warm timber finish, carved edges, strong upper-left highlights and lived-in details to the three furnishings while retaining their front views. The side doorway is drawn edge-on in the side-wall band, with floor visible through the gap and posts finished in outlined wood.


`contact-sheet.png` shows all 11 finished frames at their native canvas dimensions.
`compare-kit.png` places each placeable prop beside two interiors-kit frames at native scale, then
compares Pell with Silas and Hazel and compares the portraits. Review found the Yard props and new
side-wall doorway close to the kit's outline weight and upper-left light; the busy carving and fine
map/ledger marks on `yard-counter`, `deeds-pigeonholes`, and `deeds-clerk-desk` are the main details
that could be simplified later. Pell's two idle frames now match the resident sheet's chunky scale,
soft shading, and thick outline. The cottage sign carries readable “Silas's Yard” above the fox and
saw; the deed table has no chairs so kit chairs can sit beside it.

The art pass does not wire assets into the game. The 2×2 mending-bench footprint also needs to be applied to the game furnishing lane when integrated. `manifest.json` contains the exact native canvas,
source crop, destination rectangle, footprint, bottom-centre foot point and origin for each frame.
Pell uses the current residents' 186×283 canvas and floor baseline; cottage art occupies the same 71×66
rectangle at [12, 26] inside its unchanged 96×92 canvas as today's cottage atlas entry.

## Source material

- `sheets/` contains all generated full-resolution source sheets, retained for reproducible crops. The `round3-*` and `round4-*` sheets preserve the playtest redraw iterations.
- `frames/` contains the aspect-contained, nearest-neighbour native canvases.
- `compare-kit.png` is rebuilt with the frame crops and the indoors/Commons references.
- `prompts.json` records prompts and generation file IDs.
- Rebuild with `python3 assets/generated/yard-pass/build_frames.py`.
