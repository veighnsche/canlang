set -eu
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --test ide --test lsp_admission --test b3_s4 --test b3_authoring_join --test lsp_typed_output -- --nocapture
