set -eu
rustc -Vv
cargo -V
cat /etc/os-release
uname -m
printf 'CARGO_BUILD_JOBS=%s CARGO_INCREMENTAL=%s CARGO_HOME=%s\n' "$CARGO_BUILD_JOBS" "$CARGO_INCREMENTAL" "$CARGO_HOME"
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --test check icu_ -- --nocapture
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --lib lexical_normalize -- --nocapture
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --test ide --test docs -- --nocapture
