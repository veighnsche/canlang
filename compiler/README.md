# Compiler scaffold

A dependency-free Rust binary named `can`. Help and version output work;
`compile`, `lint` and `fmt` are reserved and exit with a nonzero error.
There is no parser, code generation or compilation implementation yet.

Run from this directory with `cargo run -- --help`. Check with `cargo check`
and `cargo fmt --check`. Local build output in `target/` is ignored.
