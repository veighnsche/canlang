//! Tiny precompiled binding for the C04.1 loader smoke fixture.
//!
//! ABI proof only: two sync exports over the raw Wasm boundary, zero
//! dependencies, no arithmetic/validation/work semantics anywhere.
//! `smoke_version` returns the transport major (v0 -> 0); `smoke_add`
//! wraps on overflow so every input pair has a deterministic result.
//! Native unit tests below are the "native executes" half of C04.1
//! acceptance; `host.mjs` is the Node/Bun half.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_transport_v0() {
        assert_eq!(smoke_version(), 0);
        assert_eq!(SMOKE_ABI_VERSION, 0);
    }

    #[test]
    fn add_basics() {
        assert_eq!(smoke_add(40, 2), 42);
        assert_eq!(smoke_add(-1, 1), 0);
    }

    #[test]
    fn add_wraps_deterministically() {
        assert_eq!(smoke_add(i32::MAX, 1), i32::MIN);
        assert_eq!(smoke_add(i32::MIN, -1), i32::MAX);
    }
}
