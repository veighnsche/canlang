#!/bin/sh
set -eu
export CARGO_HOME=/cargo-home
export CARGO_BUILD_JOBS=1
{
 uname -sm
 cat /etc/os-release
 rustc --version --verbose
 cargo --version
} > /profile/linux-host.txt
for snapshot in current; do
 cargo build --offline --locked --release --manifest-path /profile/$snapshot/compiler/Cargo.toml --target-dir /profile/$snapshot-linux-target > /profile/$snapshot-linux-release.log 2>&1
 /profile/$snapshot-linux-target/release/can --version > /profile/$snapshot-linux-version.txt
 stat --format='%s' /profile/$snapshot-linux-target/release/can > /profile/$snapshot-linux-bytes.txt
 sha256sum /profile/$snapshot-linux-target/release/can > /profile/$snapshot-linux-sha256.txt
done
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /profile/current-linux-target --lib -- --nocapture > /profile/current-linux-lib.log 2>&1
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /profile/current-linux-target --test typed_artifact --test typed_artifact_consumer --test typed_bdd --test typed_descriptors --test typed_diagnostics_cli --test typed_explain --test typed_fixes --test typed_fixes_cli --test typed_json --test typed_policy --test typed_references -- --nocapture > /profile/current-linux-typed.log 2>&1
