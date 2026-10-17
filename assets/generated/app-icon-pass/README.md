# Glimway app icon pass

The master is a built-in `image_gen` rendering of the game's Wick Tree, using
`wick-tree-quiet` and `wick-tree-amberfall` as visual references. Its prompts
are retained in `prompts.json` and its generated source in
`wick-tree-generated.png`.

`build_icon.py` isolates the tree from the generated dusk backdrop, replaces
the backdrop with the site's exact `#241f31`, fits the tree inside a central
80% safe area, and reduces it to a 32×32 native pixel grid. Public sizes are
scaled from that grid with nearest-neighbour resampling. The maskable variant
uses a smaller tree silhouette for circular cropping.

Rebuild from the repository root with:

```sh
nix develop -c nix-shell -p 'python314.withPackages (ps: [ps.pillow])' --run 'python assets/generated/app-icon-pass/build_icon.py'
```
