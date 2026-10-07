set -eu
rustc -Vv
cargo -V
cat /etc/os-release
cargo build --offline --locked --release --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target
/linux-target/release/can --version
cargo tree --offline --locked -e features --manifest-path /profile/current/compiler/Cargo.toml
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --lib lsp -- --nocapture
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --test ide --test lsp_admission --test b3_s4 --test b3_authoring_join --test lsp_typed_output -- --nocapture
