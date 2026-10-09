#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
BUF=node_modules/.bin/buf

# Protobuf breaking checks run against two baselines (docs/proto-migration.md,
# "Compatibility"): origin/main (the branch's own contract) and the latest
# release tag (the contract the last release shipped — main may already have
# moved past what players run).
#
# A message moved between two files of the same package reads the same on the
# wire (its name, fields and numbers are unchanged), but buf's FILE rule
# reports the move as a deletion from the old file. A move is accepted
# explicitly, by buf's exact line, here and in docs/proto-migration.md; the
# entry is dropped once a release ships the move (the moved-to file then sits
# on the tag baseline and the line matches nothing).
accepted=$(mktemp)
trap 'rm -f "$accepted"' EXIT
cat >"$accepted" <<'EOF'
proto/glimway/v1/state.proto:1:1:Previously present message "WorldChoice" was deleted from file.
proto/glimway/v1/state.proto:1:1:Previously present message "WorldRef" was deleted from file.
EOF

check() {
  against="$1"
  echo "buf breaking against $against"
  out="$(GIT_LFS_SKIP_SMUDGE=1 "$BUF" breaking --against "$against" 2>&1 || true)"
  # Whatever the comparison reports beyond the accepted moves is a break.
  rest="$(printf '%s\n' "$out" | grep -Fvx -f "$accepted" | sed '/^$/d' || true)"
  if [ -n "$rest" ]; then
    printf '%s\n' "$out" >&2
    echo "breaking changes against $against (accepted moves: docs/proto-migration.md)" >&2
    exit 1
  fi
}

if git rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1 && git cat-file -e refs/remotes/origin/main:buf.yaml 2>/dev/null; then
  check '.git#ref=refs/remotes/origin/main'
else
  echo "No protobuf schema on origin/main yet; establishing the initial contract."
fi

tag=$(git describe --abbrev=0 --match 'v*' --tags 2>/dev/null || true)
if [ -n "$tag" ] && git cat-file -e "$tag:buf.yaml" 2>/dev/null; then
  check ".git#ref=$tag"
else
  echo "No release tag with a schema yet; the tag baseline starts at the next release."
fi
