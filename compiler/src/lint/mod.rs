//! Lint driver and first rule set (lane-01 lints).
//!
//! [`driver::lint_program`] is the entry point: it lints every source
//! in the session over a [`CheckedProgram`](crate::analysis::CheckedProgram)
//! plus the reparsed CST. [`driver::RuleSet`] selects rules,
//! [`driver::LintConfig`] carries the fix flag and the optional
//! deprecated-builtin snapshot, and [`driver::collect_fixes`] /
//! [`driver::apply_fix`] / [`driver::apply_fixes`] implement the
//! version-checked safe-fix contract. [`rules::RULES`] is the rule
//! table (id, code, title, rationale, basis).
//!
//! Design notes (see the driver docs for the code allocation):
//!
//! - Findings are warnings/informational only and never block output;
//!   severities follow the normative `DIAGNOSTICS.md` severity table.
//! - Shadowing (`W2001`) is opt-in until the coordinator promotes it.
//! - Every rule skips already-erroring subtrees and documents the
//!   cases it deliberately leaves out.

pub mod driver;
pub mod rules;

pub use driver::{
    DeprecatedSet, FixRejected, LintConfig, LintFix, RuleSet, apply_fix, apply_fixes,
    collect_fixes, lint_program,
};
pub use rules::RULES;
