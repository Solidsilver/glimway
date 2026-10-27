#!/bin/sh
set -eu
# In nix develop. Supply the before binary built before editing the recipe,
# or build the current recipe and render the after set.
phase=${1:-after}
bin=${2:-/tmp/worldlab-walkable}
if [ "$#" -lt 2 ]; then go build -p 2 -o "$bin" ./server/cmd/worldlab; fi
out=docs/planning/wide-world/lab/terrain-walkable
for view in kinds reach height; do
 "$bin" region --slopes "$view" --slope-recipe slopes-gen@2 --seed map --rect=-24,-24,23,23 --scale 1 "$out/$phase-atlas-$view.png" >/dev/null
 "$bin" region --slopes "$view" --slope-recipe slopes-gen@2 --seed map --rect=3,5,20,22 --scale 2 "$out/$phase-range-$view.png" >/dev/null
done
