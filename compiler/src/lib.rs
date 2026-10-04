//! CanLang compiler library: one language model shared by compilation,
//! checking, linting, formatting and editor diagnostics.
//!
//! Binary dispatch lives in the `cli` module (`main.rs` is a thin entry
//! point); this crate owns source management, syntax, analysis, emission
//! and authoring tools.

pub mod analysis;
pub mod cli;
pub mod codegen;
pub mod diagnostic;
pub mod explain;
pub mod format;
pub mod ide;
pub mod json;
pub mod lint;
pub mod lsp;
pub mod source;
pub mod syntax;

/// Language version analyzed and emitted, e.g. `1.0`.
pub const LANGUAGE_VERSION: &str = "1.0";

/// Diagnostic envelope schema version.
pub const SCHEMA_VERSION: u32 = 1;

/// Process exit codes for the `can` binary.
pub mod exit {
    /// Success; for check-like commands also means "no diagnostics".
    pub const OK: i32 = 0;
    /// Tool failure (bad arguments, unreadable input, internal error).
    pub const TOOL_FAILURE: i32 = 2;
    /// Completed analysis that reported errors. Warnings alone exit 0:
    /// they never block output (DIAGNOSTICS.md).
    pub const DIAGNOSTICS: i32 = 10;
}
