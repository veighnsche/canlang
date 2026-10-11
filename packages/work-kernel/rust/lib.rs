// Registered pure decision candidates plus the selected synchronous recovery
// ABI. Original installed-consumer adoption and activation retain their gates.

#[path = "../decisions/lib.rs"]
pub mod decisions;

mod recovery_scan_abi;

#[cfg(test)]
#[path = "../conformance/registered-native.rs"]
mod registered_conformance;

/// Kernel version; must match package.json and src/index.ts.
pub const WORK_KERNEL_VERSION: &str = "0.1.0";
