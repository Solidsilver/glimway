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
# time. buf lint skips it (upstream's package is unversioned); code
# generation is restricted to glimway packages in buf.gen.yaml.
node_modules/.bin/buf lint --exclude-path proto/buf/validate
node_modules/.bin/buf generate --path proto/glimway
