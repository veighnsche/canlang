#!/bin/sh
set -eu
repo=/Users/vince/Projects/canlang
evidence="$repo/docs/research/compiler-library-audit-20261006/pass9/graphs"
scratch=/private/tmp/canlang-pass9-graphs
shared=/private/tmp/canlang-pass5-profile/current-native-target
mkdir -p "$scratch/src"
cp "$evidence/candidate.Cargo.toml" "$scratch/Cargo.toml"
cp "$evidence/candidate.Cargo.lock" "$scratch/Cargo.lock"
cp "$evidence/graph_probe.rs" "$scratch/src/main.rs"
CARGO_TARGET_DIR="$shared" CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo build --offline --locked --manifest-path "$scratch/Cargo.toml"
# This probe is optimized; dependency rlibs are from the recorded dev build.
set -- "$shared"/debug/deps/libpetgraph-*.rlib
[ "$#" = 1 ] || { echo 'Expected one petgraph rlib; use pins.json to choose the qualified one' >&2; exit 1; }
rustc --edition=2024 -O "$evidence/graph_probe.rs" -L dependency="$shared/debug/deps" --extern "petgraph=$1" -o /private/tmp/canlang-pass9-graphs-optimized
/private/tmp/canlang-pass9-graphs-optimized
rustc --edition=2024 "$evidence/compiler_probe.rs" -L "dependency=$repo/compiler/target/debug/deps" --extern "canlang_compiler=$repo/compiler/target/debug/deps/libcanlang_compiler-7ac8439fc564dd9b.rlib" -o /private/tmp/canlang-pass9-graphs-compiler
/private/tmp/canlang-pass9-graphs-compiler
