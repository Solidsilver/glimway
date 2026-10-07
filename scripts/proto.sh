#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# npm's lockfile pins Buf and protobuf-es; go.mod pins the Go compiler tool
# alongside its runtime. Normal builds consume the committed generated files.
node_modules/.bin/buf lint
node_modules/.bin/buf generate
