// Registered pure decision candidates. Production producer, transport,
// backend, Wasm, and installed-consumer joins retain their own release gates.

#[path = "../decisions/lib.rs"]
pub mod decisions;

#[cfg(test)]
#[path = "../conformance/registered-native.rs"]
mod registered_conformance;

/// Kernel version; must match package.json and src/index.ts.
pub const WORK_KERNEL_VERSION: &str = "0.1.0";
