//! Code-action fixes honoring the DIAGNOSTICS fix contract.
//!
//! A fix carries an id, title, kind, safe-or-review applicability and
//! edits guarded by the expected content hash plus byte ranges. Stale
//! edits are rejected and recomputed; diagnostics never carry
//! executable commands. Only meaning-preserving fixes ship: anything
//! needing an authored decision (permission grants, guard removal,
//! business defaults, identity changes, destructive migrations) is
//! deliberately unfixed (see [`fixes_for`]).
//!
//! Shipped fixes today: none. No emitted diagnostic currently has a
//! mechanical meaning-preserving repair (unused-import removal awaits
//! an unused-import diagnostic; every other candidate needs UX or
//! semantic judgment). [`fixes_for`] therefore maps every code to an
//! empty list, and [`apply_fix`] enforces the contract machinery
//! (hash gate, range validation, overlap rejection) so the first real
//! fix plugs straight in.

use crate::diagnostic::Diagnostic;
use crate::source::sha256_hex;

/// One byte-range edit within a fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixEdit {
    /// Inclusive start byte offset.
    pub start: u32,
    /// Exclusive end byte offset.
    pub end: u32,
    /// Replacement text for `[start, end)`.
    pub new_text: String,
}

/// One code action: applicability plus guarded edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticFix {
    /// Stable fix id, e.g. `remove-unused-import`.
    pub id: &'static str,
    /// Human title, e.g. `Remove unused import`.
    pub title: String,
    /// LSP kind, e.g. `quickfix`.
    pub kind: &'static str,
    /// Whether the fix preserves meaning without review.
    pub safe: bool,
    /// Lowercase hex SHA-256 of the bytes the ranges apply to.
    pub expected_sha256: String,
    /// Edits in any order; applied atomically or not at all.
    pub edits: Vec<FixEdit>,
}

/// Why a fix was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixError {
    /// The text no longer matches `expected_sha256`.
    StaleContent,
    /// A range is inverted, out of bounds or splits a scalar.
    BadRange,
    /// Two edits overlap.
    Overlap,
}

impl std::fmt::Display for FixError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FixError::StaleContent => write!(f, "content changed since the fix was computed"),
            FixError::BadRange => write!(f, "fix range is invalid for this text"),
            FixError::Overlap => write!(f, "fix edits overlap"),
        }
    }
}

impl std::error::Error for FixError {}

/// Mechanical fixes for one diagnostic, guarded by `expected_sha256`.
///
/// Returns an empty list for every code today; each arm documents why
/// its code has no safe mechanical repair. New fixes add an arm plus a
/// behavior-preservation test proving the repair preserves meaning.
pub fn fixes_for(diagnostic: &Diagnostic, expected_sha256: &str) -> Vec<DiagnosticFix> {
    let _ = expected_sha256;
    match diagnostic.code {
        // Lexer/layout/parse violations: the source is invalid and every
        // repair guesses at intent (tab width, intended delimiter,
        // dropped token). The formatter owns whitespace; nothing here is
        // meaning-preserving because there is no meaning yet.
        _ if diagnostic.code.starts_with("E1") => Vec::new(),
        // E2001 unresolved name: importing, renaming or declaring the
        // name are all authored decisions, never mechanical.
        // E2002 duplicate: which occurrence survives is a UX decision.
        // E2003-E2005 import visibility: provider/member choice is authored.
        // E2006 helper misuse: no mechanical source repair exists.
        // E2007 composition cycles, E2008 ownership, E2009 composed-app
        // imports, E2010 empty uses, E2012 shadowing, E2013 unknown
        // members, E2014 derive targets, E2017-E2018 reference cycles:
        // all need design judgment about the intended graph.
        _ if diagnostic.code.starts_with("E2") => Vec::new(),
        // Type mismatches and invalid operators/calls/queries: the
        // intended type or operator is unknowable mechanically.
        _ if diagnostic.code.starts_with("E3") => Vec::new(),
        // Effects/authority/disclosure (E4xxx) and operations/fixtures
        // (E5xxx): reserved ranges with no emitters yet; permission and
        // business-default repairs always need an authored decision.
        _ if diagnostic.code.starts_with("E4") || diagnostic.code.starts_with("E5") => Vec::new(),
        // Catalog/capability faults (E6xxx): missing or invalid producer
        // contracts are repaired by producing the catalog, not by edits.
        _ if diagnostic.code.starts_with("E6") => Vec::new(),
        // Tool/config faults (E7xxx): no source edit applies.
        _ if diagnostic.code.starts_with("E7") => Vec::new(),
        // Warnings and information: no emitters yet. Note in particular
        // that unused-import removal awaits an unused-import diagnostic
        // (no E2xxx/I1xxx names one today); inventing the detection here
        // would be a second checker, so no fix ships until analysis
        // reports it.
        _ => Vec::new(),
    }
}

/// Wrap one lint safe fix as an IDE fix (single-span lint edits map
/// to one-element edit lists; hash and range survive unchanged).
pub fn from_lint_fix(fix: &crate::lint::LintFix) -> DiagnosticFix {
    DiagnosticFix {
        id: fix.rule,
        title: fix.title.clone(),
        kind: "quickfix",
        safe: true,
        expected_sha256: fix.expected_sha256.clone(),
        edits: vec![FixEdit {
            start: fix.span.start,
            end: fix.span.end,
            new_text: fix.replacement.clone(),
        }],
    }
}

/// Apply a fix to `text`, enforcing the contract: the SHA-256 gate
/// first, then range validity, then atomic application.
pub fn apply_fix(text: &str, fix: &DiagnosticFix) -> Result<String, FixError> {
    if sha256_hex(text.as_bytes()) != fix.expected_sha256 {
        return Err(FixError::StaleContent);
    }
    let mut edits = fix.edits.clone();
    edits.sort_by_key(|e| (e.start, e.end));
    for window in edits.windows(2) {
        if window[0].end > window[1].start {
            return Err(FixError::Overlap);
        }
    }
    for edit in &edits {
        if edit.start > edit.end
            || edit.end as usize > text.len()
            || !text.is_char_boundary(edit.start as usize)
            || !text.is_char_boundary(edit.end as usize)
        {
            return Err(FixError::BadRange);
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for edit in &edits {
        out.push_str(&text[cursor..edit.start as usize]);
        out.push_str(&edit.new_text);
        cursor = edit.end as usize;
    }
    out.push_str(&text[cursor..]);
    Ok(out)
}
