#!/bin/sh
set -eu
uname -sm > /scratch/results/uname.txt
cat /etc/os-release > /scratch/results/os-release.txt
rustc -vV > /scratch/results/rustc.txt
cargo -V > /scratch/results/cargo.txt
cargo build --locked --offline --manifest-path /source/compiler/Cargo.toml --target-dir /scratch/target --release > /scratch/results/release.log 2>&1
cargo test --locked --offline --manifest-path /source/compiler/Cargo.toml --target-dir /scratch/target --lib source::tests -- --nocapture > /scratch/results/source-tests.log 2>&1
sha256sum /scratch/target/release/can > /scratch/results/binary-sha256.txt
wc -c < /scratch/target/release/can > /scratch/results/binary-size.txt
