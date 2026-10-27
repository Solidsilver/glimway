#!/bin/sh
set -eu
# From the repository root, in nix develop. Overlay avoids adding 80 owners
# to every normal Go test run while keeping this finite probe reproducible.
terrain_owner_overlay=$(mktemp /tmp/glimway-range-overlay.XXXXXX)
trap 'rm -f "$terrain_owner_overlay"' EXIT
node --input-type=module - "$terrain_owner_overlay" <<'JS'
import fs from 'node:fs'
const root = process.cwd()
fs.writeFileSync(process.argv[2], JSON.stringify({ Replace: {
  [root + '/server/internal/wilds/walkable_probe_test.go']:
    root + '/docs/planning/wide-world/lab/terrain-walkable/owner-probe_test.go.txt'
} }))
JS
GOMAXPROCS=2 go test -p 2 -overlay "$terrain_owner_overlay" -run TestWalkableExtraOwners -v ./server/internal/wilds
