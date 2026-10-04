# Habitica gear catalog & asset helpers (M3)

Owner: `snap_assets`. Scope: `src/lib/habitica/gear.ts`,
`src/lib/habitica/avatar.ts`, `content/habitica-gear.json`,
`tests/habitica-assets.test.ts`, `public/assets/habitica/*`, this file,
`ASSETS.md`. Peer modules (`types.ts`, `mapping.ts`, `sync.ts`, `client.ts`,
`save.ts`) are snap_state; game/UI consumption is snap_runtime.

Date: 2026-10-03. No account credentials were used or stored.

## Sources and provenance

| What | Source | Revision / retrieval | License |
|---|---|---|---|
| Gear numerics (`content/habitica-gear.json`) | `GET https://habitica.com/api/v3/content` (public static content, x-client header only, no auth) | source tree `HabitRPG/habitica` `develop` @ `789bbe4ab779febbed92d92b533c70f41b9f7b09` (2026-10-02T16:07:04Z); retrieved 2026-10-03 | Item stat definitions derived from Habitica content data — **GPL v3** |
| Sprite naming / layer order | `website/client/src/components/avatar.vue`, `website/client/src/components/ui/sprite.vue`, `website/client/src/assets/css/sprites/spritesmith-main.css`, `website/common/script/content/constants/gifSprites.js` (same revision) | retrieved 2026-10-03 | GPL v3 (code); naming facts |
| Sprite art (`public/assets/habitica/*`) | `https://habitica-assets.s3.amazonaws.com/mobileApp/images/{name}.png` | retrieved 2026-10-03 | **CC BY-NC-SA 3.0** (HabitRPG / Weirdly Wonderful art) |

Modifications: the catalog is flattened to per-key numeric stats; i18n
`text`/`notes` strings are omitted; **no numeric values were changed**.
Cached art files are byte-identical copies (sha256 recorded in
`public/assets/habitica/manifest.json`).

Attribution text for the UI credits line is in `ASSETS.md`.

## Catalog shape (`content/habitica-gear.json`)

- `provenance` — endpoint, project, revision + date, retrieval date,
  x-client tag used, auth note, license split, counts, modification note.
- `gear` — all **1860** official items: `type, klass, specialClass?,
  index, set, str, int, con, per, value, twoHanded?, last?, mystery?,
  season?, event?, gearSet?`. Keys are upstream flat keys
  (`weapon_warrior_1`, `armor_special_yeti`, `headAccessory_mystery_202401`, …).
  `specialClass` carries the real class for `klass` `'special' | 'mystery' |
  'armoire'` items (e.g. `weapon_special_yeti`: klass `special`,
  specialClass `warrior`).
- `pets` (1248) / `mounts` (1178) — every official key (drop, premium,
  quest, special, wacky).
- `gifSprites` (43) — sprite names that are animated upstream (`.gif`,
  not `.png`).
- `appearances` — official key lists for `size` (slim, broad), `skin`,
  `shirt`, `hair.{color,bangs,base,mustache,beard,flower}`, `chair`.
- `spritelessGear` — the 8 `*_base_0` "none" pieces (Habitica's unequipped
  slot placeholders): no sprite exists, they render no layer.
- `localSprites` — sprite name → extension for the bundled same-origin
  cache (41 files).

## `gear.ts` API

```ts
gearStatsFor(key: string): GearItemStats | undefined   // GearStatsLookup-compatible
gearItemFor(key) / isKnownGearKey(key) / isTwoHanded(key) / isNonePiece(key)
isPetKey(key) / isMountKey(key) / companionSpriteNames(key, kind)
isGifSprite(name)
CATALOG                                                // typed snapshot + provenance
```

`gearStatsFor` is a drop-in lookup for `toHabiticaProfile(user,
gearStatsFor)` and returns `{str,int,con,per,klass,specialClass?}` exactly
as `effectiveStatsFor`'s class-match rule expects (`item.klass === cls ||
item.specialClass === cls` — Habitica's intentional double contribution,
not double-counting). Unknown keys return `undefined` — never guessed.

## `avatar.ts` API

```ts
avatarLayersFor(profile): AssetRef[]                   // {key, url}[] bottom→top
avatarLayerReport(profile): { layers, skipped[], remoteOnly[] }
companionAssetFor(key, 'pet' | 'mount'): AssetRef | null
companionLayersFor(key, kind): AssetRef[]              // mounts: body + head
assetSourceFor(name): 'local' | 'remote' | null
spriteUrlFor(name) / upstreamSpriteUrl(name) / localSpriteUrl(name)
```

### Layer order (verified against `avatar.vue`)

`Mount_Body_X` → `hair_flower_N` (early copy) → `chair_*` (see limits) →
back gear → `skin_X` → `{size}_shirt_X` → `head_0` → `{size}_{armorKey}` →
back_collar gear → hair bangs → hair base → hair mustache → hair beard →
body gear → eyewear gear → head gear → headAccessory gear →
`hair_flower_N` (top copy) → shield gear → weapon gear → `Mount_Head_X` →
`Pet-X`.

Naming facts (verified HTTP 200 / 403 probes against upstream):

- Armor sprites are **size-prefixed**: `slim_armor_warrior_1`,
  `broad_armor_warrior_1`; a bare `armor_warrior_1` 403s. All other gear
  uses the bare key as the sprite name.
- Pets: `Pet-{key}` (hyphen). Mounts need **both** `Mount_Body_{key}` and
  `Mount_Head_{key}`.
- `gifSprites` entries use `.gif`; everything else `.png`.
- Hair: `hair_{slot}_{style}_{color}` with exact appearance keys (colors
  include odd ones like `TRUred`). Style `0` = none (no sprite).
  `hair_flower_0` and `chair_none` likewise have no sprite.
- Every catalog gear key except the 8 `*_base_0` none-pieces has an
  upstream sprite (cross-checked against spritesmith CSS + gifSprites).
- Two-handed weapons suppress the shield layer (upstream `hideGear` rule;
  74 items, incl. all wizard weapons).

### Costume vs effective gear

`equipped` is the **only** combat-stat source. When `useCostume === true`,
visuals read the `costume` slot map instead (upstream `preferences.costume`
behavior). `avatarLayersFor` implements exactly this split.

### Fidelity — read this before claiming anything in UI copy

- **Base hair only** until snap_state adds the optional appearance slots
  (`hairBangs`, `hairMustache`, `hairBeard`, `hairFlower` — structurally
  already consumed by `avatar.ts` via `HairSlotExtras`). Until then bangs,
  mustache, beard, and flower layers are skipped and **reported** in
  `avatarLayerReport().skipped`.
- `chair_*`, visual buffs (snowball/ghost/floral/seafoam), and `zzz` are
  out of the supported subset and are skipped/reported.
- Unknown skins/shirts/sizes/gear/pet/mount keys are skipped and reported —
  **never renamed or invented** ("no silent wrong names").
- Recommend UI copy like "composed from official Habitica art" — not
  "exact character".

## Assets and CORS (evidence)

- Upstream individual sprites: `https://habitica-assets.s3.amazonaws.com/
  mobileApp/images/{name}.{png|gif}` — probed with `Origin:
  http://localhost:5173`: responses carry **no
  `Access-Control-Allow-Origin`** (headers: `x-amz-*`, `ETag`,
  `Content-Type: image/png`, `Server: AmazonS3`). Therefore remote art is
  **not Phaser-WebGL-safe** (texture upload from a tainted image fails).
  Fine for `<img>`/CSS display only.
- Same-origin cache: `public/assets/habitica/` (41 PNGs, ~73 KB total) —
  `head_0`, 4 skins, 8 shirts (4 colors × slim/broad), 12 hair pieces
  (black/brown), flowers 1–3, warrior/wizard tier-0–1 gear (weapons,
  heads, shield_warrior_1, size-prefixed armors), `Pet-Wolf-Base`,
  `Pet-Wolf-White`, `Mount_Body_Wolf-Base`, `Mount_Head_Wolf-Base`.
  Served as `/assets/habitica/{name}.png` — WebGL-safe.
  `manifest.json` lists each file's upstream URL, sha256 (16), and size.
- `assetSourceFor(name)` reports `'local' | 'remote' | null` so the
  runtime can enforce the boundary. URL builders apply
  `encodeURIComponent` to sprite names.

## Tests

`tests/habitica-assets.test.ts` (15 tests): catalog provenance/completeness,
lookup + `specialClass` + class-bonus integration with `effectiveStatsFor`,
none-pieces/two-handed, official layer order (warrior stack), mage
two-handed shield suppression, costume split, optional hair-stack order,
skip-and-report for unknown pieces, companion validation (`null` for empty/
unknown keys), gif/png extension rules, URL percent-encoding + secret-free
URLs, local-cache shape, remote-only flagging.

Run: `npm test` (all suites) or `node --test tests/habitica-assets.test.ts`.

## Limitations / open items

1. Appearance is partial (base hair only) until the optional hair slots
   land in `HabiticaProfile` — coordinated with snap_state 2026-10-03.
2. Remote sprite URLs are display-only (no CORS); the local cache covers
   the demo subset only. Imported characters with uncached gear will show
   `remoteOnly` layers the WebGL runtime must skip or handle with a
   non-WebGL fallback.
3. The catalog is a snapshot (`789bbe4a`); gear released upstream after
   that revision maps as "unknown key" (skipped + reported), not wrong art.
4. `background_*` sprites exist upstream and are listed under
   `appearances` usage in the review, but background rendering is
   runtime/UI's call; not part of the composed layer list.
5. Redistribution status: this workspace is **not** a git repository and no
   public source distribution exists — do not claim licensing compliance via
   "public source" anywhere. CC BY-NC-SA 3.0 art permits non-commercial
   share-alike use with attribution, but the bundled GPL v3-derived catalog
   obliges source availability for the derived data if it ships in a
   redistributed artifact. Until corresponding source is published (repo
   included), treat public deployment/redistribution as blocked; see
   `ASSETS.md` "Third-party use boundaries".
