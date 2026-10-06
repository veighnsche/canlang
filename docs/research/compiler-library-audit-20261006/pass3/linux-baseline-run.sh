#!/bin/sh
set -eu
cargo build --locked --offline --manifest-path /scratch/source-baseline/compiler/Cargo.toml --target-dir /scratch/target-baseline --release > /scratch/results/release-baseline.log 2>&1
sha256sum /scratch/target-baseline/release/can > /scratch/results/baseline-binary-sha256.txt
wc -c < /scratch/target-baseline/release/can > /scratch/results/baseline-binary-size.txt
