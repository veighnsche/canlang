#!/bin/zsh
set -eu
cd /Users/vince/Projects/canlang
receipt=docs/research/compiler-library-audit-20261006/pass9/icu
scratch=/private/tmp/canlang-pass9-icu
mkdir -p "$scratch"
tar -xzf "$receipt/owner-snapshot.tar.gz" -C "$scratch"
cp "$receipt/parity.mjs" "$receipt/structure.mjs" "$receipt/render.mjs" "$receipt/hook.mjs" "$receipt/hook-built.mjs" "$scratch/"
# Supply an exact original executable if the retained scratch baseline is absent.
if [[ ! -f "$scratch/pinned/compiler/target/debug/can" ]]; then
  mkdir -p "$scratch/pinned/compiler/target/debug"
  cp "${ICU_BASELINE_BINARY:-compiler/target/debug/can}" "$scratch/pinned/compiler/target/debug/can"
fi
binary_hash=$(shasum -a 256 "$scratch/pinned/compiler/target/debug/can" | cut -d ' ' -f 1)
[[ "$binary_hash" == a15411ee7f24cdaf429cfebf8370d127fcafb5f3d2175dda759dfc0c7fd40ded ]] || { print 'Baseline executable hash differs; obtain the pinned baseline before replay.' >&2; exit 1; }
node --experimental-transform-types --import "$scratch/hook.mjs" "$scratch/parity.mjs" > "$receipt/type-parity.json"
node --experimental-transform-types --import "$scratch/hook-built.mjs" "$scratch/parity.mjs" > "$receipt/type-parity-built.json"
node --experimental-transform-types --import "$scratch/hook.mjs" "$scratch/structure.mjs" > "$receipt/structure-parity.json"
node --experimental-transform-types --import "$scratch/hook-built.mjs" "$scratch/structure.mjs" > "$receipt/structure-parity-built.json"
node --experimental-transform-types --import "$scratch/hook.mjs" "$scratch/render.mjs" > "$receipt/render-results.json"
node "$receipt/verify-results.mjs" > "$receipt/verification.json"
