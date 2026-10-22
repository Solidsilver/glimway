# Slopes 2b: sunlight and feel

Source: [CI run 39871217203](https://github.com/Solidsilver/glimway/actions/runs/39871217203),
commit `5d551760`. Browser tests: **13 passed, 0 flaky, 0 failed, 0 helper retries**.
All 52 slope frames were inspected. These 13 selected PNGs are unchanged originals;
[evidence.json](evidence.json) lists every inspected slope frame and hashes the
selected PNGs and their state JSON.

The 2b capture uses **Shading baseline** (Facing shade Restrained, contours Off,
terraces Off, lift None), 12% uphill / 0% downhill, Slope gait On, Sun strength
100%, medium fog, and the easing camera. The lab HUD and diagnostic overlays
are hidden. Each original PNG has a matching JSON with field position, settings,
height, kind, tint, shadow model and frame diagnostics. NPCs continue their
normal loops, so an off/on pair holds the hero and camera fixed but does not
freeze every other actor.

| Stop | Sunlight Off | Sunlight On | What to judge |
|---|---|---|---|
| Hills | [Off](2b-off-hills.png) | [On](2b-on-hills.png) | Hero, trees and boulder contact across gentle hills |
| Sunny knoll | [Off](2b-off-knoll-sunny.png) | [On](2b-on-knoll-sunny.png) | Warm sprite and shortened SE shadow |
| Shaded knoll | [Off](2b-off-knoll-shaded.png) | [On](2b-on-knoll-shaded.png) | Cool bounded tint and longer shadow, readable feet |
| Saddle | [Off](2b-off-pass-top.png) | [On](2b-on-pass-top.png) | Feet and open route between scree shoulders |
| Outcrop approach | [Off](2b-off-outcrop-slope.png) | [On](2b-on-outcrop-slope.png) | Hero standing on the gentle climb, with feet central |
| Rocky path | [Off](2b-off-rocky-path.png) | [On](2b-on-rocky-path.png) | Walkable slabs beside scree, boulder shadow |

[Phone, sunlight On](2b-phone-on-hills.png) is 390×844. It proves framing and
legibility, not a measured mobile frame budget.

[Final raw timing](timing.json) and [first-pass raw timing](timing-first-pass.json)
record rAF intervals, long tasks,
scene paint/upload/update samples, field runs at 0/0, 12/0, 24/6 and 40/20 in
every drawing preset, and actual-key gait samples. The first outcrop camera was
replaced after review because it put the feet near the bottom edge. The
[walk notes](../../../slopes-lab-notes.md) explain the controls, measurements,
implementation choice and remaining limits.

The repeated sample contains an unresolved 1.93 s frame gap with sunlight Off,
confirmed by a 1.944 s main-thread task. Sunlight On had a 33.3 ms maximum.
Both samples and the attribution limits are reported in the walk notes.
