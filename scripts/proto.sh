#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# npm's lockfile pins Buf and protobuf-es; go.mod pins the Go compiler tool
# alongside its runtime. Normal builds consume the committed generated files.
#
# proto/buf/validate/validate.proto is vendored from the BSR module
# buf.build/bufbuild/protovalidate v1.2.0 (the schema protovalidate-go v1.4.0
# pins): `buf export buf.build/bufbuild/protovalidate:v1.2.0 -o proto` keeps
# generation offline and reproducible; no buf deps, no BSR fetch at build
# time. buf.yaml ignores it in lint (upstream's package is unversioned) and
# in breaking (neither it nor the content schemas are a wire contract); code
# generation is restricted to glimway packages in buf.gen.yaml.
node_modules/.bin/buf lint
node_modules/.bin/buf generate --path proto/glimway
