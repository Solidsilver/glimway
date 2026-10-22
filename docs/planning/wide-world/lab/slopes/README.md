# Slopes 2a evidence

Source: [CI run 39834935093](https://github.com/Solidsilver/glimway/actions/runs/39834935093),
commit `044da89c`. All 39 slopes frames were inspected with the lab HUD and overlays
hidden. These 24 selected PNGs are copied unchanged; adjacent JSON records position,
height, kind and settings. [2a-evidence.json](2a-evidence.json) lists all inspected
frames and hashes the selected originals. Older shade/contours/lift frames here
are round 1; the preset-named files below are round 2a.

| Preset | Hills | Saddle | Rocky path |
|---|---|---|---|
| Shading baseline | [frame](baseline-hills.png) | [frame](baseline-pass-top.png) | [frame](baseline-rocky-path.png) |
| Sparse contours | [frame](sparse-hills.png) | [frame](sparse-pass-top.png) | [frame](sparse-rocky-path.png) |
| Small terraces | [frame](terraces-hills.png) | [frame](terraces-pass-top.png) | [frame](terraces-rocky-path.png) |
| Moderate lift | [frame](moderate-hills.png) | [frame](moderate-pass-top.png) | [frame](moderate-rocky-path.png) |
| Full lift reference | [frame](full-hills.png) | [frame](full-pass-top.png) | [frame](full-rocky-path.png) |

Additional comparisons:

- Cliff join and talus: [Moderate lift](moderate-outcrop-cliff.png), [Full lift reference](full-outcrop-cliff.png).
- Far side: [Moderate lift](moderate-pass-north.png), [Full lift reference](full-pass-north.png).
- Fog off: [Shading baseline](baseline-fog-off-pass-top.png), [Moderate lift](moderate-fog-off-pass-top.png).
- [Phone approach](phone-moderate-pass-mid.png), [hidden hero silhouette](full-behind-plateau.png), [stopped at scree](baseline-steep-walk-stopped.png).

[2a-timing.json](2a-timing.json) contains raw browser frame intervals, browser long
tasks, deterministic field runs, and lab paint/upload/update distributions.
[2a-timing-before-final-batching.json](2a-timing-before-final-batching.json) is from
[run 39833333045](https://github.com/Solidsilver/glimway/actions/runs/39833333045),
commit `eca853bc`: it preserves the earlier 2.17 s sparse-switch gap and upload tails.
[2a-spots.json](2a-spots.json) has the fixture coordinates; the old spots.json belongs
to round 1. See [the walk guide and observations](../../slopes-lab-notes.md).
