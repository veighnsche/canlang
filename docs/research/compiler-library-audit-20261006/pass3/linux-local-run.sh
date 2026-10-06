#!/bin/sh
set -eu
mkdir -p /scratch/results
uname -sm > /scratch/results/uname.txt
rustc -vV > /scratch/results/rustc.txt
cargo -V > /scratch/results/cargo.txt
cargo build --locked --offline --manifest-path /source/compiler/Cargo.toml --target-dir /scratch/target --release > /scratch/results/release.log 2>&1
cargo test --locked --offline --manifest-path /source/compiler/Cargo.toml --target-dir /scratch/target --lib > /scratch/results/lib.log 2>&1
cargo test --locked --offline --manifest-path /source/compiler/Cargo.toml --target-dir /scratch/target --test analysis c03_url_owner_admission_and_source_anchors > /scratch/results/analysis.log 2>&1
for source in /scratch/probes/*.can; do
  name=$(basename "$source" .can)
  set +e
  /scratch/target/release/can check --format=json --catalog /source/packages/values/dist/catalog.json "$source" > "/scratch/results/$name.json" 2> "/scratch/results/$name.stderr"
  result=$?
  set -e
  printf '%s\n' "$result" > "/scratch/results/$name.exit"
done
sha256sum /scratch/target/release/can > /scratch/results/binary-sha256.txt
wc -c < /scratch/target/release/can > /scratch/results/binary-size.txt
