#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Generation alone installs compilers. Ordinary npm, Docker and Nix builds
# consume the checked-in output and require neither buf nor protoc.
BUF_VERSION=1.73.0
mkdir -p .cache/proto/bin
if command -v buf >/dev/null 2>&1 && [ "$(buf --version)" = "$BUF_VERSION" ]; then
  BUF=buf
else
  BUF="$PWD/.cache/proto/bin/buf"
  if [ ! -x "$BUF" ] || [ "$("$BUF" --version)" != "$BUF_VERSION" ]; then
    case "$(uname -s)" in
      Darwin|Linux) platform=$(uname -s) ;;
      *) echo 'protobuf generation requires Darwin or Linux' >&2; exit 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) arch=aarch64 ;;
      x86_64) arch=x86_64 ;;
      *) echo 'unsupported protobuf compiler architecture' >&2; exit 1 ;;
    esac
    curl --fail --location --silent --show-error \
      "https://github.com/bufbuild/buf/releases/download/v$BUF_VERSION/buf-$platform-$arch" \
      -o "$BUF.tmp"
    chmod +x "$BUF.tmp"
    test "$("$BUF.tmp" --version)" = "$BUF_VERSION"
    mv "$BUF.tmp" "$BUF"
  fi
fi
GOBIN="$PWD/.cache/proto/bin" go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
"$BUF" lint
"$BUF" generate
