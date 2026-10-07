#!/bin/sh
set -eu
# Run only after the parent releases the exact production binary.
ROOT=/Users/vince/Projects/canlang
TEMP=/private/tmp/canlang-pass10-consumers
OUT=$ROOT/docs/research/compiler-library-audit-20261006/pass10/consumers
BIN=${1:?final production binary required}
python3 "$OUT/probe.py" "$BIN"
node "$OUT/artifact-probe.mjs" current "$ROOT" "$TEMP/artifact.json" "$TEMP/wire.can" "$ROOT" > "$OUT/current-artifact.stdout" 2> "$OUT/current-artifact.stderr"
cd "$TEMP/installed"
TMPDIR="$TEMP" bun install --offline --ignore-scripts --cache-dir "$TEMP/cache" > "$OUT/install.stdout" 2> "$OUT/install.stderr"
cp "$OUT/artifact-probe.mjs" "$TEMP/installed/probe.mjs"
node --permission --allow-fs-read="$TEMP" --allow-fs-write="$TEMP" "$TEMP/installed/probe.mjs" installed "$TEMP/installed" "$TEMP/artifact.json" "$TEMP/wire.can" "$ROOT" > "$OUT/installed-artifact.stdout" 2> "$OUT/installed-artifact.stderr"
