#!/bin/sh
set -eu
# Run from the repository root: nix develop -c nice -n 10 sh <this script>
export GOMAXPROCS=2
terrain_lab_bin=$(mktemp /tmp/glimway-terrain-lab.XXXXXX)
trap 'rm -f "$terrain_lab_bin"' EXIT
go build -p 2 -o "$terrain_lab_bin" ./server/cmd/worldlab
out=docs/planning/wide-world/lab/terrain-ranges
mkdir -p "$out"
render() {
 recipe=$1
 seed=$2
 view=$3
 layer=$4
 rect=$5
 scale=$6
 name=$7
 "$terrain_lab_bin" "$view" --slopes "$layer" --slope-recipe "$recipe" --seed "$seed" --rect="$rect" --scale "$scale" "$out/$name.png" > /dev/null
 echo "$name"
}
render slopes-gen@1 map atlas height -24,-24,23,23 8 map-v1-atlas
render slopes-gen@2 map atlas height -24,-24,23,23 8 map-v2-atlas
render slopes-gen@1 map region height -24,-24,23,23 1 map-v1-height
render slopes-gen@2 map region height -24,-24,23,23 1 map-v2-height
render slopes-gen@1 map region height 3,5,20,22 2 map-v1-range
render slopes-gen@2 map region height 3,5,20,22 2 map-v2-range
render slopes-gen@2 map region routes -24,-24,23,23 1 map-v2-routes
render slopes-gen@2 map region reach -24,-24,23,23 1 map-v2-reach
render slopes-gen@2 map region tunnels 3,5,20,22 2 map-v2-tunnels
render slopes-gen@2 map region kinds 9,10,12,13 6 map-v2-pass
render slopes-gen@2 map region height 15,16,17,18 6 map-v2-spire
render slopes-gen@2 map region kinds 4,15,6,19 6 map-v2-outcrop
render slopes-gen@2 map region height -2,-23,4,-18 4 map-v2-hills
render slopes-gen@2 slopes-17 atlas height -24,-24,23,23 8 slopes-17-v2-atlas
render slopes-gen@2 slopes-991 atlas height -24,-24,23,23 8 slopes-991-v2-atlas
