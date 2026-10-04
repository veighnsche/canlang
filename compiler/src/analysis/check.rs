//! PR5 check driver: aggregation policy, dedup, ordering, readiness.
//!
//! [`check_program`](super::check_program) runs parse, resolve, types,
//! effects and examples and merges every diagnostic through this
//! module before returning:
//!
//! - [`dedup_diagnostics`] drops duplicate findings across passes by
//!   `(file, start, end, code, message)`, keeping the earliest pass's
//!   report (parse, then resolve, types, effects, examples);
//! - [`sort_diagnostics`] restores the deterministic
//!   `(file, start, code)` order `check_program` has always produced;
//! - [`has_errors`]/[`exit_code`] pin the warning policy: warnings
//!   never block, so check-like commands exit 0 when clean or
//!   warnings-only and 10 when any error is present;
//! - [`readiness`] is the `complete=true` gate: empty exactly when the
//!   resolve, types, effects and examples passes all ran. Callers set
//!   `DiagnosticResult.complete` from its emptiness; codegen refuses
//!   `complete=false` (its `E6005` gate) without a test-only
//!   acknowledgement.
//!
//! A missing pass is reported as `E7006` (coordinator-owned tool
//! range). The gate trusts its input flags: production pipelines run
//! every pass and claim so, leaving the gate empty by construction. It
//! documents the completeness contract rather than enforcing it — a
//! refactor that drops a pass without updating its claim would stay
//! silent (deriving the flags from actual execution is future work).

use std::collections::HashSet;

use crate::diagnostic::{Diagnostic, Severity};
use crate::source::Span;

/// Which analysis passes produced their tables for this check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompleteInputs {
    /// The resolve pass (`E2xxx`) ran.
    pub resolve: bool,
    /// The types pass (`E3xxx`) ran.
    pub types: bool,
    /// The effects pass (`E4xxx`) ran.
    pub effects: bool,
    /// The examples pass (`E5xxx`) ran.
    pub examples: bool,
    /// Anchor for incompleteness diagnostics: an empty span at the
    /// start of the first analyzed file, mirroring catalog faults
    /// (which likewise name no analyzed source range).
    pub primary: Span,
}

impl CompleteInputs {
    /// Every pass ran: the production pipeline claim.
    pub fn all(primary: Span) -> Self {
        Self {
            resolve: true,
            types: true,
            effects: true,
            examples: true,
            primary,
        }
    }

    /// No pass ran: the empty-pipeline claim (tests only).
    pub fn none(primary: Span) -> Self {
        Self {
            resolve: false,
            types: false,
            effects: false,
            examples: false,
            primary,
        }
    }
}

/// The `complete=true` readiness gate: empty exactly when the resolve,
/// types, effects and examples passes all ran, otherwise one `E7006`
/// per missing pass.
pub fn readiness(program_tables_available: CompleteInputs) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (ran, name) in [
        (program_tables_available.resolve, "resolve"),
        (program_tables_available.types, "types"),
        (program_tables_available.effects, "effects"),
        (program_tables_available.examples, "examples"),
    ] {
        if !ran {
            out.push(Diagnostic::error(
                "E7006",
                format!("analysis incomplete: the {name} pass did not run"),
                program_tables_available.primary,
            ));
        }
    }
    out
}

/// Drop duplicate diagnostics across passes by
/// `(file, start, end, code, message)`, keeping the first occurrence.
///
/// Pass outputs merge in pipeline order (parse, resolve, types,
/// effects, examples), so the earliest pass's wording wins and later
/// repeats of the same finding vanish. Findings sharing
/// `(file, start, code)` but differing in end or message are distinct
/// and all survive.
pub fn dedup_diagnostics(diagnostics: Vec<Diagnostic>) -> Vec<Diagnostic> {
    let mut seen: HashSet<(crate::source::SourceId, u32, u32, &'static str, String)> =
        HashSet::new();
    diagnostics
        .into_iter()
        .filter(|d| {
            seen.insert((
                d.primary.file,
                d.primary.start,
                d.primary.end,
                d.code,
                d.message.clone(),
            ))
        })
        .collect()
}

/// Sort diagnostics into `check_program` order: `(file, start, code)`.
pub fn sort_diagnostics(diagnostics: &mut [Diagnostic]) {
    diagnostics.sort_by(|a, b| {
        (a.primary.file, a.primary.start, &a.code).cmp(&(b.primary.file, b.primary.start, &b.code))
    });
}

/// Whether any error-severity diagnostic is present. Warnings (and
/// info) never block output.
pub fn has_errors(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(|d| d.severity == Severity::Error)
}

/// Exit code for a finished check: 0 when clean or warnings-only, 10
/// when any error is present.
pub fn exit_code(diagnostics: &[Diagnostic]) -> i32 {
    if has_errors(diagnostics) {
        crate::exit::DIAGNOSTICS
    } else {
        crate::exit::OK
    }
}
