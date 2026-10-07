set -eu
rustc -Vv
cat /etc/os-release
cargo build --offline --locked --release --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --lib --test json_input_contract --test catalog_input_contract --test catalog_producer_runtime --test lsp_admission -- --nocapture
