//! No-unit-test enforcement (AGENTS.md); see tools/unitban/build_impl.rs.
include!("../../tools/unitban/build_impl.rs");

fn main() {
    println!(
        "cargo:rerun-if-changed={}/tools/unitban/build_impl.rs",
        env!("CARGO_MANIFEST_DIR")
    );
    deny_unit_tests();
}
