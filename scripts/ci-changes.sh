#!/bin/sh
# Whether a push changes anything but docs (ci.yml's `changes` job). Prints
# what changed and ends with `code=true` or `code=false`.
#
# Usage: ci-changes.sh EVENT BEFORE SHA
#
# Only a push whose every changed path is under docs/ or ends in .md counts as
# docs. CHANGELOG.md is not docs: the build reads it for the "What's new" card.
# Anything in doubt (a new branch, a force push whose old head can't be
# fetched, a pull request, a manual run) counts as code.
#
# --no-renames: a detected rename lists only its destination, so moving a
# source file into docs/ would look like a docs-only change (review R1). With
# renames off, the deleted source path is listed as well.
set -u
event=$1 before=$2 sha=$3
code=true
case "$event:$before" in
  push:|push:0000000000000000000000000000000000000000) echo "a new branch: everything runs" ;;
  push:*)
    if { git cat-file -e "$before^{commit}" 2>/dev/null || git fetch --no-tags --depth=1 origin "$before"; } &&
      files=$(git diff --no-renames --name-only "$before" "$sha"); then
      printf 'changed:\n%s\n' "$files"
      others=$(printf '%s\n' "$files" | grep -Ev '^docs/|\.md$' || true)
      if [ -n "$files" ] && [ -z "$others" ] && ! printf '%s\n' "$files" | grep -qx 'CHANGELOG.md'; then code=false; fi
    else
      echo "the previous head isn't reachable: everything runs"
    fi ;;
  *) echo "$event: everything runs" ;;
esac
echo "code=$code"
