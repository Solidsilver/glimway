# Art request: the playtest-1 pass (village ground, walking people, a base body)

For the image-generation agent. You already know the existing packs under
`assets/generated/` (expansion, runtime-pass, commons-pass, items-pass) and the art
direction in `assets/generated/README.md`.

## Why

The owner's first real playtest: the village and Commons ground tiles and the NPCs look
very blocky next to the hero, the trees and the Tangle. The owner likes the Tangle's
hybrid look best (code-drawn ground with ragged painted edges, 1 px dark outlines, lit from
the upper left, crisp nearest-neighbour; see `src/game/wilds/tangle-art.ts`) and wants
everything to match it.

Most of the blockiness is ours, not the art's: the game packs every source frame down to a
16 px world tile (a 314 px terrain painting becomes 32 px, then shows on a 16 px grid; an
NPC drawn at about 237×452 px becomes 16×16). We're changing the game to keep **4×
density**: **64 texture pixels per 16 px world tile**, drawn at the same world size. So the
existing originals will already look much better. Please make only what that can't fix,
below, at that density.

## Global spec

- **Density:** 64 px per world tile. A tile is 64×64; a person is about 64×96
  (1 tile wide, 1.5 tall) including feet; a frame is 64×128 if you need headroom.
- **Style:** the Tangle's: cute, lived-in woodland fantasy, a three-quarter top-down view
  (no isometric diamond grid), 1 px dark outlines at the 64 px density, light from the
  upper left, emerald foliage with teal shadows, amber lanterns, russet wood and roofs,
  golden weathered stone. Crisp pixels: no blur, no anti-aliased soft edges, no
  gradients smoother than about 4 steps.
- **Transparent PNG** sheets with a clear grid and an atlas JSON (frame name → x, y, w, h,
  and the foot point for sprites), as in the earlier passes. Put them in
  `assets/generated/playtest1-pass/`, with a README and `prompts.json`.

## 1. Village and Commons ground (seamless tiles)

The current terrain frames are small paintings, not tileable textures, so they show as a
grid of repeated squares. Make **seamless 64×64 tiles** that tile with no visible seams:
- grass (4 variants), flowered grass (2), forest moss (2), packed dirt path (3), the old
  cobbled road (3), farmland rows (2), the village square's flagstones (2), sand by water (2),
  water (4-frame gentle animation).
- **Transitions** between grass and each of dirt path, road, flagstones, sand and water: a
  standard 16-piece corner set (or a 47-piece blob set if you can) with **ragged, painted
  edges** like the Tangle's paths, not straight lines.

## 2. The residents walking

The village people at the new density, each with **4 directions** (down, up, left, right
or left mirrored) × **idle (2 frames, a slow breath, no bobbing)** and **walk (4 frames)**:
Mara, Pip, Orrin, Silas, Elara Quill, Finn Tolley, Hazel Penhallow, Ada Cooley. Keep each
one's look from the existing portraits and `fingersnap-residents-v2.png` (names, ages and
roles are in `docs/lore/chronicle.md`, "The People of Hearthwick Today"). Add a **sit**
pose (facing down) for each.

## 3. A base body for the player (palette-swappable)

Habitica avatars only face forward, so the hero floats and can't turn. Make a plain base
body the game recolours from the player's Habitica look:
- **4 directions** × idle (2 frames, breathing) × walk (4 frames) × **sit** (facing down and
  sideways) × a **swing** (3 frames, for an axe, pick or blade).
- **Separate layers**, each drawn in **flat index colours** so the game can recolour them:
  skin, hair (short, long, tied back, curly, bald: 5 styles), shirt, trousers or skirt,
  boots. Use exactly 3 shades per layer (light, mid, shadow) and list the index colours in
  the README.
- Keep it simple and readable at game zoom; it should sit well beside the residents.

## 4. Hand items (for the new held-tool mechanic)

Small held versions, drawn at the hand, in 4 directions: bench axe, felling axe, pick,
spade, stave bucket, watering can, a short blade, a carter's lantern. Each about 32×32,
with the hand anchor point in the atlas JSON.

## Order of value

1 and 2 first (they fix what the owner noticed most), then 3, then 4.
