#!/bin/sh
# Isolated fake accounts, authenticated sockets, real hub/sim/SQLite. No live server.
set -eu
cd "$(dirname "$0")/.."
export GLIMWAY_FIGHT_LOAD=1
# GOMAXPROCS=1 isolates the per-core budget; raise groups to find saturation.
: "${GOMAXPROCS:=1}"
export GOMAXPROCS
go test -count=1 -timeout=15m -run '^TestFightBotLoad$' -v ./server/internal/api
