#!/bin/sh
# File gate for the AGENTS.md unit-test ban: every TypeScript test file in the
# working tree (tracked or untracked-but-not-ignored) must be listed in
# tools/unitban/allow-ts.txt. Add genuine integration/e2e tests to the
# allowlist as part of the same change; the diff below is the review surface.
set -eu
cd "$(dirname "$0")/.."
allow=tools/unitban/allow-ts.txt
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT INT TERM
{ git ls-files '*.test.ts'; git ls-files --others --exclude-standard '*.test.ts'; } \
  | LC_ALL=C sort -u > "$tmp"
if cmp -s "$tmp" "$allow"; then
  echo "no-unit-tests file gate: OK ($(wc -l < "$tmp" | tr -d ' ') allowed test files)"
else
  echo "no-unit-tests file gate FAILED: *.test.ts files differ from $allow" >&2
  echo "--- regenerate with:" >&2
  echo "  { git ls-files '*.test.ts'; git ls-files --others --exclude-standard '*.test.ts'; } | LC_ALL=C sort -u > $allow" >&2
  echo "--- diff (< allowlist, > working tree):" >&2
  diff "$allow" "$tmp" >&2 || true
  exit 1
fi
