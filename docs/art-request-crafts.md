# Art request: the 0.5 crafts pass

For the image-generation round. Follow the format and density of `docs/art-request-indoors.md` and its delivered pass. This request implements section 9 of `docs/design/crafts.md`.

## Global spec

- **Density:** 64 texels per 16 px world tile. Use the listed texel canvases exactly; every piece records its tile footprint (when it has one) and its bottom-centre foot point (or hand point for the held rod).
- **View and style:** crisp, stepped pixel art in the existing cozy woodland RPG style; three-quarter top-down for world pieces; 1 px dark warm-brown outlines at this density; upper-left light; warm russet timber, hay gold, pond silver-blue and class-specific ability colors. No blur, antialiasing, painterly texture or soft gradients.
- **Delivery:** transparent backgrounds for sprites and effects. Animated assets are horizontal strips, frames left to right, with identical canvas and foot/hand point per frame. The icons are individually framed 64×64 cells in cohesive category sheets. No fake checkerboard pixels.
- **Stable:** front-facing timber and thatch in the Commons house style, still by default. Draw as a back layer (walls, hay rack, bay rear) and a front layer (posts and half door), leaving an empty bay interior. It repeats east. Fit the measured largest Habitica mount canvas, about 33×33 game px (132×132 texels) at game scale, in the bay. The half door is about chest height on a person. Do not draw any mount or pet.
- **Effects:** lie flat on the ground and remain readable over grass and the Tangle floor. Keep all animation frames aligned.

### Mount-fit measurement

`src/game/entities/avatar.ts` scales both 135×135 Habitica mount layers by `AVATAR_DISPLAY / AVATAR_CANVAS` = 22/90. Each full layer canvas therefore draws at 33×33 game px, or 132×132 texels at this art density. The bundled Wolf-Base body and head together have a visible alpha union of 99×84 source pixels, which draws at about 24.2×20.5 game px (97×82 texels). The 2×3 stall footprint is 32×48 game px (128×192 texels), and its 128×320 art canvas is 32×80 game px; the visible mount fits inside, with its head able to rise over the half door. No 9.2 canvas change is needed.

## 1. Ability icons and effects

| Piece | Canvas | Frames | Notes |
|---|---:|---:|---|
| Ability icons (20) | 64×64 each | 1 | Five per class: warrior Cleave, Heave, Pin, Stand, Brace; mage Fingersnap, Name a lamp, Read a route stone, Kindle, Old ways; healer Mend, Mend (working), Settle, Ward-light, Mended glade; rogue Shadowstep, Read the drift, Walk a blind route, Echo, Sense the turning. Only Cleave, Stand, Fingersnap, Kindle, Mend, Ward-light, Shadowstep and Echo ship in 0.5. Keep a shared frame and palette family within each class; make each symbol legible at 16×16 display size. No text or letters. |
| Stand ground ring | 128×64 | 4 | Pressed earth and small stones at the feet; planting then held. |
| Kindle hollow light | 192×128 | 4 | Loop, about 3 tiles across; pale hollow-gold flames low to the ground, explicitly magical light rather than fire. |
| Ward-light circle | 160×96 | 4 | One base plus three pulse frames; about 2.5 tiles across, green-gold ground rim, brighter ring moving outwards. |
| Echo | — | — | No image; made in code from the hero's tinted, half-transparent layers. |

## 2. Stable

| Piece | Footprint | Canvas | States | Notes |
|---|---:|---:|---|---|
| Stable west end, tack room and stall 1 | 4×3 | 256×320 | 1 each for back and front | Rises 2 tiles. Tack room door, saddle peg and lantern hook; stall bay occupies east half. The two layers must share an exact anchor. |
| Repeating stall bay | 2×3 | 128×320 | 1 back + 2 front | Front states are half-door shut/open. Repeats east one to five times. Keep clear of the inside mount standing area. |
| East gable end | — | 32×320 | 1 | Overlay closing the final bay's roof line. |
| Placement ghost | — | — | — | Code tint; no image. |

## 3. Fishing

| Piece | Canvas | Frames | Notes |
|---|---:|---:|---|
| Willow rod icon | 64×64 | 1 | Inventory and belt; willow rod, cork grip and wound line. |
| Rod held | 128×128 | 2 | Raised cast and held-out poses; anchor is the hand. Never covers worn gear. |
| Float | 32×32 | 6 | Four idle-bob frames and two bite-dip frames. Red and cream quill float. |
| Water rings | 64×32 | 3 | Loop around float; bank variant also reads as healthy water. |
| Landing splash | 64×64 | 4 | Small readable splash. |
| Mill roach icon | 64×64 | 1 | Silver body, red fins; also used for the fish's landing arc. |
| Miller's fry icon | 64×64 | 1 | Two small floured fish in a pan with a sprig. |
| Recipe card: Miller's fry | 64×64 | 1 | Match Hazel's existing recipe-card style, no extra lettering. |

## 4. HUD and small things

| Piece | Canvas | Frames | Notes |
|---|---:|---:|---|
| Companions tab | 64×64 | 1 | Paw print on a small tag. |
| Saddle (Ride / Get down) | 64×64 | 1 | One saddle icon for both labels. |
| Go home | 64×64 | 1 | Horseshoe above a little roof. |
| Pet heart | 32×32 | 3 | Small warm heart rising; no heart among the current emotes. |
| Lead rope | — | — | Code-drawn slack curve from hand to mount head. |
| Yard pet nap “z” | — | — | Code-drawn. |

## Delivery and review

Deliver all requested art except code-drawn effects to `assets/generated/crafts-pass/`, with `manifest.json`, `atlas.json`, `README.md` and `prompts.json`. Record source sheets, crop rectangles, exact canvas, footprint, foot/hand point, animation groups and which eight abilities ship in 0.5. Check each crop against its canvas, footprint and anchor; check that all frames in a strip share the same silhouette, palette and anchor; check the four ability palette families. Keep art generation and atlas packing separate from game wiring.
