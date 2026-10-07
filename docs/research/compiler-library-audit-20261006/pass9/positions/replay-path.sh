#!/bin/sh
set -eu
out=docs/research/compiler-library-audit-20261006/pass9/positions
tmp=/private/tmp/canlang-pass9-positions
mkdir -p "$tmp"
rustc --crate-name path_clean --crate-type rlib "$out/path-clean-1.0.1-lib.rs" -o "$tmp/libpath_clean.rlib"
rustc --edition=2024 "$out/path-adapter.rs" --extern "path_clean=$tmp/libpath_clean.rlib" -o "$tmp/path-adapter"
"$tmp/path-adapter" > "$out/path-candidate-results.txt"
