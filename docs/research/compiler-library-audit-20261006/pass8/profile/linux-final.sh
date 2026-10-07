set -eu
rustc -Vv
cargo -V
cat /etc/os-release
cargo build --offline --locked --release --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target
/linux-target/release/can --version
cargo tree --offline --locked -e features --manifest-path /profile/current/compiler/Cargo.toml
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --lib codegen -- --nocapture
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --test codegen --test b1_join --test b3_migrate --test typed_artifact -- --nocapture
