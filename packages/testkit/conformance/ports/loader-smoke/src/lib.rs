//! Tiny precompiled binding for the C04.1 loader smoke fixture.
//!
//! ABI proof only: two sync exports over the raw Wasm boundary, zero
//! dependencies, no arithmetic/validation/work semantics anywhere.
//! `smoke_version` returns the transport major (v0 -> 0); `smoke_add`
//! wraps on overflow so every input pair has a deterministic result.
//! C04.1 acceptance drives this binding through the raw Wasm boundary;
//! `host.mjs` is the Node/Bun half.

/// Transport major version carried by this binding (v0).
pub const SMOKE_ABI_VERSION: u32 = 0;

/// Report the binding ABI version. Must equal 0 (transport v0).
#[no_mangle]
pub extern "C" fn smoke_version() -> u32 {
    SMOKE_ABI_VERSION
}

/// Deterministic wrapping add. No traps, no host calls.
#[no_mangle]
pub extern "C" fn smoke_add(a: i32, b: i32) -> i32 {
    a.wrapping_add(b)
}

