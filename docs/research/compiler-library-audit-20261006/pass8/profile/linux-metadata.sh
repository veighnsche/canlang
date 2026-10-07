set -eu
cargo metadata --offline --locked --filter-platform x86_64-unknown-linux-gnu --format-version 1 --manifest-path /profile/current/compiler/Cargo.toml > /profile/metadata-linux.json
