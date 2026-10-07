# Fingersnap NPC, guardian, and class-effect pass

Made for this repository, following `docs/runtime-asset-spec.md`. Original art generated with the built-in image generation tool on October 3, 2026. Generation and cleanup prompts are in `prompts.json`.

## Delivered sprites

| Set | Frames | Native runtime texture | Origin |
|---|---:|---|---|
| Mara | 2 front-facing breathing poses | 16×16 | (0.5, 1) |
| Pip | 2 front-facing breathing poses | 16×16 | (0.5, 1) |
| Orrin | 2 front-facing breathing poses | 16×16 | (0.5, 1) |
| Stone guardian | idle, windup, lunge, hurt, defeat | 24×24 | (0.5, 1) |
| Cleave | 4 stages, facing right | 18×18 | (0.5, 0.5) |
| Magic bolt | 4 flicker stages, facing right | 8×8 | (0.5, 0.5) |
| Dash trail | 4 stages, trails left behind rightward motion | 18×18 | (0.5, 0.5) |
| Healing pulse | 4 expanding/fading stages | 32×32 | (0.5, 0.5) |

Dash trail and healing pulse dimensions are proposed slots because the supplied spec does not define them. Character and guardian sizes, cleave/slash size, and bolt size follow the spec. Effects use a center anchor for rotation/expansion, not a foot anchor.

Mara follows the existing auburn hair, blue dress, and cream apron. Pip is the smaller rose-pink messenger. Orrin wears brown work clothes with grey hair and beard. The guardian preserves the existing low quadruped silhouette, now rendered as mossy stone with cyan eyes. It faces right and can be flipped.

## Source images versus native textures

The PNGs are high-resolution source sheets, not evenly spaced native spritesheets. `manifest.json` supplies individually measured source rectangles and destination rectangles. `integration.js` creates exact 16×16/24×24/etc canvas textures with nearest-neighbor sampling and stable foot placement. Source PNGs are never overwritten or pre-scaled.

Use the helper instead of loading the source with `frameWidth: 16`. All NPCs use one common scale to preserve Pip's smaller stature. Guardian poses also share a common scale, so its collapsed pose stays smaller instead of being enlarged to fill the slot. Native canvas bounds and origins stay fixed between animation frames. Avoid adding the existing bob animation on top of breathing unless intentionally desired.

The sources have genuine alpha transparency. Hidden RGB color in fully transparent pixels can include the original backdrop; those pixels do not render. Use the cleaned sheets and do not flatten them against black.

## Runtime handoff

Copy the three PNGs and `manifest.json` into `public/assets/fingersnap/runtime-pass/`. Put `integration.js` in the game source (convert to TypeScript if desired).

```js
// BootScene.preload:
preloadRuntimeArt(this);

// After preload, before WorldScene starts:
createRuntimeArt(this);

// Optional: after fallback textures exist, explicitly replace supported keys.
installRuntimeAliases(this, { replaceExisting: true });
```

Compatibility aliases: `mara`, `pip`, `orrin`, `guardian0` (idle), `guardian1` (lunge), `slash` (cleave peak), and `bolt` (first projectile frame). The helper leaves existing aliases alone by default. Call replacement only in boot setup, before dependent sprites are created.

Breathing animation keys: `mara-breathing`, `pip-breathing`, `orrin-breathing` (two frames, 1.5 fps, looping). These use the newly created per-frame texture keys. Optional aliases provide static art to unchanged scenes; the runtime agent must wire breathing and new guardian states explicitly.

Guardian keys: `guardian-idle`, `guardian-windup`, `guardian-lunge`, `guardian-hurt`, `guardian-defeat`. Select them from the combat state machine; do not loop all five as a walk animation. Code tinting, timers, death handling, physics bodies, and quest events remain runtime responsibilities.

Effect animation keys: `effect-cleave`, `effect-magic-bolt`, `effect-dash-trail`, `effect-healing-pulse`. Cleave, dash, and healing sequences are one-shot at 12 fps; bolt loops at 12 fps. Rotate centered effects according to facing. Position the cleave canvas center at the attacker; position the trail center at its emission point. Effects are cosmetic and do not define hit areas or healing radius.

Preserve explicitly authored NPC 10×8 and guardian 20×10 foot collision bodies. Do not infer collision from the source alpha or visual bounds.

## Preview and validation

Serve this folder with a local HTTP server and open `preview.html`. It previews native textures enlarged 6×, with an animation pause control and foot baseline. No game credentials or Habitica calls are involved.

Verified: transparent image channels; source/destination rectangles in bounds; 27 nonempty source frames; animation and alias references; native rendering and stable baseline in the browser preview. The preview uses the same destination rectangles as the runtime helper. New art has not been wired into the actual game or used to replace its placeholders by this task.

The native pass is deliberately small and loses some source-sheet detail. Final timing and readability should be assessed in the actual map. This original generated pack does not inherit Habitica's artwork license; maintain separate provenance and choose a distribution license before public release.
