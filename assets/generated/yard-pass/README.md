# 0.7 Silas's Yard art pass

Built with the built-in `image_gen` tool from `docs/art-request-yard.md` and design section 2.8.
`jobs.json` records source crops, native canvas sizes, footprints and destination boxes;
`build_frames.py` rebuilds all frame PNGs, `manifest.json`, `atlas.json` and the true-size
`contact-sheet.png` from the preserved source sheets. The contact sheet keeps the finished frame
canvases at 1×, with labels and a checker backing for transparent edges. The current Pell pair has
one `pell-breathing` loop at 1.5 fps, matching the residents sheet.

## Frames

- `yard-counter` — front-facing counter with plot book, pencil, carved foxes, tin; 192×128, 3×1.
- `yard-timber-rack` — front-facing rack flat against the back wall, with cut boards, stone stack, tied fibre; 192×192, 3×2.
- `yard-mending-bench` — side-on vertical mending station with hung axe, vice, oil and rags; 64×192, 1×2.
- `kit-side-doorway` — inner wall opening and threshold; 64×128, 1×2.
- `deeds-pigeonholes` — rolled deeds and Commons lane map; 192×192, 3×2.
- `deeds-clerk-desk` — standing desk, ledger and inkwell; 64×128, 1×1.
- `deeds-table` — open ledger, deed papers, quill and inkwell; 192×128, 3×2.
- `cottage-silas` — shop face at its existing 96×92 canvas, with fox-and-saw hanging sign and openable-looking door.
- `pell-idle-0` and `pell-idle-1` — front-facing resident frames, each exactly 186×283, matching the in-game Commons resident sheet. Pell does not walk.
- `portrait-pell` — dialogue bust; 64×64.

## Simplification review

Round 2 aligned the counter and timber rack with the indoors kit’s straight-on furniture view. The counter faces the room; the rack sits flat against the back wall. The mending bench remains side-on.


`contact-sheet.png` shows all 11 finished frames at their native canvas dimensions.
`compare-kit.png` places each placeable prop beside two interiors-kit frames at native scale, then
compares Pell with Silas and Hazel and compares the portraits. Review found the Yard props and new
side-wall doorway close to the kit's outline weight and upper-left light; the busy carving and fine
map/ledger marks on `yard-counter`, `deeds-pigeonholes`, and `deeds-clerk-desk` are the main details
that could be simplified later. Pell's two idle frames now match the resident sheet's chunky scale,
soft shading, and thick outline. The cottage sign carries readable “Silas's Yard” above the fox and
saw; the deed table has no chairs so kit chairs can sit beside it.

The art pass does not wire assets into the game. `manifest.json` contains the exact native canvas,
source crop, destination rectangle, footprint, bottom-centre foot point and origin for each frame.
Pell uses the current residents' 186×283 canvas and floor baseline; cottage art occupies the same 71×66
rectangle at [12, 26] inside its unchanged 96×92 canvas as today's cottage atlas entry.

## Source material

- `sheets/` contains all generated full-resolution source sheets, retained for reproducible crops.
- `frames/` contains the aspect-contained, nearest-neighbour native canvases.
- `compare-kit.png` is rebuilt with the frame crops and the indoors/Commons references.
- `prompts.json` records prompts and generation file IDs.
- Rebuild with `python3 assets/generated/yard-pass/build_frames.py`.
