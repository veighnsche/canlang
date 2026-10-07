//! Lint driver: configuration, entry point and machine-fixable code actions.
//!
//! ## Code allocation
//!
//! Lint findings reuse the reserved `explain` codes where they exist and
//! extend `I1xxx` for the two new description nits (see
//! `implementation/status/lane-01.md` for the normative ranges):
//!
//! | Rule id | Code | Severity | Default |
//! | --- | --- | --- | --- |
//! | `deprecated-builtin` | `W3001` | Warning | on (needs catalog data) |
//! | `unreachable-statement` | `W1001` | Warning | on |
//! | `unused-binding` | `I1001` | Info | on |
//! | `shadowed-binding` | `W2001` | Warning | **opt-in** (see below) |
//! | `redundant-null-marker` | `I1002` | Info | on |
//! | `empty-description` | `I1003` | Info | new, on |
//! | `duplicate-description` | `I1004` | Info | new, on |
//!
//! Severities follow the normative `DIAGNOSTICS.md` severity table:
//! unreachable/shadowing/deprecated are warnings, while unused and
//! redundant findings are `Info` ("kept out of default build output"). No
//! lint finding ever blocks output: only `Error` diagnostics do
//! ([`Severity::Error`](crate::diagnostic::Severity::Error)).
//!
//! Shadowing stays opt-in per the DIAGNOSTICS.md precision proviso even
//! though the shipped rule is exact (nested `let` hiding a top-level
//! `let` that is still referenced nearby): the coordinator can promote
//! it to [`RuleSet::recommended`] after reviewing corpus noise.
//!
//! ## Fix contract
//!
//! Fixes are separate from diagnostics ([`LintFix`]) and are computed
//! only when [`LintConfig::fix`] is set: with `fix=false`,
//! [`collect_fixes`] returns nothing and nothing is written. Every fix
//! carries the `expected_sha256` of the source bytes it was computed
//! against; [`apply_fix`]/[`apply_fixes`] refuse stale or misaligned
//! edits and never force them. Only meaning-preserving edits are
//! offered; anything needing an authored decision (renames, binding
//! removal, deprecation migration, description removal) has no fix.

use crate::analysis::Catalog;
use crate::analysis::CheckedProgram;
use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span};
use std::collections::HashSet;

use super::rules::{self, Finding, RuleCtx};

/// Which lint rules run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleSet {
    /// `W1001` statements after `require false` (`E4030` owns
    /// statements after `return`).
    pub unreachable_code: bool,
    /// `W2001` nested `let` hiding a referenced outer `let` (opt-in).
    pub shadowing: bool,
    /// `W3001` calls to deprecated catalog builtins.
    pub deprecated: bool,
    /// `I1001` `let`/query-alias bindings never read.
    pub unused: bool,
    /// `I1002` `?.` on a provably non-null receiver.
    pub redundant_null: bool,
    /// `I1003`/`I1004` empty or duplicated adjacent descriptions.
    pub description_nits: bool,
}

impl RuleSet {
    /// Recommended rules: everything except opt-in shadowing.
    pub fn recommended() -> Self {
        Self {
            unreachable_code: true,
            shadowing: false,
            deprecated: true,
            unused: true,
            redundant_null: true,
            description_nits: true,
        }
    }

    /// Every rule, including opt-in shadowing.
    pub fn all() -> Self {
        Self {
            unreachable_code: true,
            shadowing: true,
            deprecated: true,
            unused: true,
            redundant_null: true,
            description_nits: true,
        }
    }

    /// No rules.
    pub fn none() -> Self {
        Self {
            unreachable_code: false,
            shadowing: false,
            deprecated: false,
            unused: false,
            redundant_null: false,
            description_nits: false,
        }
    }
}

/// Deprecated builtins visible to the lint driver.
///
/// A snapshot of the producer catalog's `deprecation` notices for
/// source-callable builtins only: helpers and components are never
/// source-callable, so their notices (if any) are excluded. Built this
/// way the driver stays read-only over [`Catalog`] and reports nothing
/// (never errors) when no snapshot is configured.
#[derive(Debug, Clone, Default)]
pub struct DeprecatedSet {
    entries: Vec<(String, String)>,
}

impl DeprecatedSet {
    /// Snapshot every deprecated builtin (`kind == "builtin"` with a
    /// `deprecation` notice) from `catalog`.
    pub fn from_catalog(catalog: &Catalog) -> Self {
        let mut entries = Vec::new();
        for id in catalog.ids() {
            if catalog.is_builtin(id)
                && let Some(notice) = catalog.deprecation(id)
            {
                entries.push((id.to_string(), notice.to_string()));
            }
        }
        Self { entries }
    }

    /// Producer notice for a deprecated builtin id, if any.
    pub fn notice(&self, id: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, notice)| notice.as_str())
    }

    /// Whether the snapshot holds no deprecated builtins.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Number of deprecated builtins in the snapshot.
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Lint configuration.
#[derive(Debug, Clone)]
pub struct LintConfig {
    /// Which rules run.
    pub enabled: RuleSet,
    /// Whether machine fixes may be computed. `false` (the default)
    /// means diagnostics only: [`collect_fixes`] returns nothing.
    pub fix: bool,
    /// Deprecated-builtin snapshot (see [`DeprecatedSet`]). `None` (the
    /// default) means the catalog is unavailable: the deprecated rule
    /// reports nothing and never errors.
    pub deprecated: Option<DeprecatedSet>,
}

impl Default for LintConfig {
    /// Recommended rules on, fixes off, no catalog data.
    fn default() -> Self {
        Self {
            enabled: RuleSet::recommended(),
            fix: false,
            deprecated: None,
        }
    }
}

/// Lint the program's selected sources against their checked database.
///
/// Rules see `program` (symbols, modules, type table) plus the reparsed
/// CST for precise spans. Findings are warnings/informational only and
/// are returned in deterministic `(file, start, end, code, message)`
/// order. Parse diagnostics are intentionally ignored here: error
/// surfaces own them, and every rule independently skips subtrees that
/// already contain syntax errors.
pub fn lint_program(
    program: &CheckedProgram,
    db: &SourceDb,
    config: &LintConfig,
) -> Vec<Diagnostic> {
    let mut diagnostics: Vec<Diagnostic> = run(program, db, config)
        .into_iter()
        .map(|finding| finding.diagnostic)
        .collect();
    sort_diagnostics(&mut diagnostics);
    diagnostics
}

/// Compute machine-fixable code actions for the lint findings.
///
/// Returns an empty vector unless [`LintConfig::fix`] is set: with
/// `fix=false` nothing is offered and nothing is written. Fixes are
/// returned in deterministic `(file, start, end, rule)` order; each
/// carries the source `expected_sha256` it was computed against.
pub fn collect_fixes(program: &CheckedProgram, db: &SourceDb, config: &LintConfig) -> Vec<LintFix> {
    if !config.fix {
        return Vec::new();
    }
    let mut fixes = Vec::new();
    for (file, finding) in run_with_files(program, db, config) {
        let Some(pending) = finding.fix else {
            continue;
        };
        let sha = db
            .get(file)
            .map(|source| source.sha256.clone())
            .unwrap_or_default();
        fixes.push(LintFix {
            rule: pending.rule,
            title: pending.title,
            file,
            span: pending.span,
            expected_sha256: sha,
            replacement: pending.replacement,
        });
    }
    fixes.sort_by(|a, b| {
        (a.file, a.span.start, a.span.end, a.rule, &a.title).cmp(&(
            b.file,
            b.span.start,
            b.span.end,
            b.rule,
            &b.title,
        ))
    });
    fixes
}

/// One machine-fixable code action (safe kind only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LintFix {
    /// Lint rule id that produced the fix (see [`rules::RULES`]).
    pub rule: &'static str,
    /// Human-readable fix title.
    pub title: String,
    /// Source the span applies to.
    pub file: SourceId,
    /// Byte range to replace.
    pub span: Span,
    /// Lowercase hex SHA-256 of the source bytes the fix was computed
    /// against. [`apply_fix`] refuses to apply the fix to anything else.
    pub expected_sha256: String,
    /// Replacement text for the span.
    pub replacement: String,
}

/// Why a fix was refused. Refusals are never forced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FixRejected {
    /// Source bytes changed since the fix was computed: recompute.
    Stale {
        /// Hash the fix was computed against.
        expected: String,
        /// Hash of the bytes offered.
        found: String,
    },
    /// Span is out of bounds or splits a character.
    SpanInvalid {
        /// Rejected span start.
        start: u32,
        /// Rejected span end.
        end: u32,
        /// Length of the offered bytes.
        len: usize,
    },
    /// Two fixes in one batch overlap.
    Overlap {
        /// Earlier span.
        first: Span,
        /// Overlapping later span.
        second: Span,
    },
}

/// Apply one fix to source bytes, refusing stale or misaligned edits.
///
/// `sha256` must be the lowercase hex SHA-256 of `text`; a mismatch
/// with [`LintFix::expected_sha256`] refuses with
/// [`FixRejected::Stale`]. Returns the updated text on success.
pub fn apply_fix(text: &str, sha256: &str, fix: &LintFix) -> Result<String, FixRejected> {
    if sha256 != fix.expected_sha256 {
        return Err(FixRejected::Stale {
            expected: fix.expected_sha256.clone(),
            found: sha256.to_string(),
        });
    }
    check_span(text, fix.span)?;
    let (start, end) = (fix.span.start as usize, fix.span.end as usize);
    let mut out = String::with_capacity(text.len() + fix.replacement.len());
    out.push_str(&text[..start]);
    out.push_str(&fix.replacement);
    out.push_str(&text[end..]);
    Ok(out)
}

/// Apply several same-file fixes atomically: any refusal (stale bytes,
/// invalid span, overlap) rejects the whole batch with no partial
/// result. All fixes must have been computed against `text` (their
/// `expected_sha256` must equal `sha256`).
pub fn apply_fixes(text: &str, sha256: &str, fixes: &[LintFix]) -> Result<String, FixRejected> {
    for fix in fixes {
        if fix.expected_sha256 != sha256 {
            return Err(FixRejected::Stale {
                expected: fix.expected_sha256.clone(),
                found: sha256.to_string(),
            });
        }
        check_span(text, fix.span)?;
    }
    let mut ordered: Vec<&LintFix> = fixes.iter().collect();
    ordered.sort_by_key(|fix| (fix.span.start, fix.span.end));
    for pair in ordered.windows(2) {
        if pair[0].span.end > pair[1].span.start {
            return Err(FixRejected::Overlap {
                first: pair[0].span,
                second: pair[1].span,
            });
        }
    }
    // Descending application keeps every earlier span valid.
    let mut current = text.to_string();
    for fix in ordered.iter().rev() {
        let (start, end) = (fix.span.start as usize, fix.span.end as usize);
        current.replace_range(start..end, &fix.replacement);
    }
    Ok(current)
}

#[derive(serde::Serialize)]
struct FixSpan {
    start: u32,
    end: u32,
}

impl From<Span> for FixSpan {
    fn from(span: Span) -> Self {
        Self {
            start: span.start,
            end: span.end,
        }
    }
}

impl serde::Serialize for LintFix {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(serde::Serialize)]
        struct FixWire<'a> {
            rule: &'a str,
            title: &'a str,
            file: u32,
            span: FixSpan,
            expected_sha256: &'a str,
            replacement: &'a str,
        }
        FixWire {
            rule: self.rule,
            title: &self.title,
            file: self.file.0,
            span: self.span.into(),
            expected_sha256: &self.expected_sha256,
            replacement: &self.replacement,
        }
        .serialize(serializer)
    }
}

impl serde::Serialize for FixRejected {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(serde::Serialize)]
        #[serde(tag = "reason", rename_all = "snake_case")]
        enum Detail<'a> {
            Stale { expected: &'a str, found: &'a str },
            SpanInvalid { start: u32, end: u32, len: usize },
            Overlap { first: FixSpan, second: FixSpan },
        }
        #[derive(serde::Serialize)]
        struct Rejection<'a> {
            status: &'static str,
            #[serde(flatten)]
            detail: Detail<'a>,
        }
        let detail = match self {
            Self::Stale { expected, found } => Detail::Stale { expected, found },
            Self::SpanInvalid { start, end, len } => Detail::SpanInvalid {
                start: *start,
                end: *end,
                len: *len,
            },
            Self::Overlap { first, second } => Detail::Overlap {
                first: (*first).into(),
                second: (*second).into(),
            },
        };
        Rejection {
            status: "rejected",
            detail,
        }
        .serialize(serializer)
    }
}

/// Render one fix as compact single-line JSON with fixed key order:
///
/// `{"rule":..,"title":..,"file":N,"span":{"start":N,"end":N},"expected_sha256":..,"replacement":..}`
///
/// `file` is the numeric [`SourceId`] resolvable through the envelope's
/// `sources` array. String escaping uses the shared typed JSON adapter,
/// matching the diagnostic envelope. This is the agent fix-JSON shape
/// consumed by `can lint --fix --format=json` and downstream authoring
/// work: keep the key order stable.
pub fn fix_to_json(fix: &LintFix) -> String {
    crate::json::to_compact_string(fix).expect("lint fix JSON serialization invariant")
}

/// Render fixes as a compact JSON array (`[]` when empty). Callers pass
/// [`collect_fixes`] output, which is already in deterministic
/// `(file, start, end, rule)` order; this function preserves slice order.
pub fn fixes_to_json(fixes: &[LintFix]) -> String {
    crate::json::to_compact_string(fixes).expect("lint fixes JSON serialization invariant")
}

/// Render a refusal as compact single-line JSON with fixed key order:
///
/// * stale: `{"status":"rejected","reason":"stale","expected":..,"found":..}`
/// * span: `{"status":"rejected","reason":"span_invalid","start":N,"end":N,"len":N}`
/// * overlap: `{"status":"rejected","reason":"overlap","first":{"start":N,"end":N},"second":{...}}`
///
/// Agents detect staleness from `"reason":"stale"` plus the two hashes;
/// nothing here is silent.
pub fn rejected_to_json(rejected: &FixRejected) -> String {
    crate::json::to_compact_string(rejected).expect("lint rejection JSON serialization invariant")
}

fn check_span(text: &str, span: Span) -> Result<(), FixRejected> {
    let (start, end) = (span.start as usize, span.end as usize);
    if start > end
        || end > text.len()
        || !text.is_char_boundary(start)
        || !text.is_char_boundary(end)
    {
        return Err(FixRejected::SpanInvalid {
            start: span.start,
            end: span.end,
            len: text.len(),
        });
    }
    Ok(())
}

fn run(program: &CheckedProgram, db: &SourceDb, config: &LintConfig) -> Vec<Finding> {
    run_with_files(program, db, config)
        .into_iter()
        .map(|(_, finding)| finding)
        .collect()
}

fn run_with_files(
    program: &CheckedProgram,
    db: &SourceDb,
    config: &LintConfig,
) -> Vec<(SourceId, Finding)> {
    let declared = declared_names(program);
    let mut out = Vec::new();
    for &file in program.checked_files() {
        let Some(source) = db.get(file) else {
            continue;
        };
        let (tree, _) = crate::syntax::parse(db, file);
        let ctx = RuleCtx {
            program,
            text: &source.text,
            deprecated: config.deprecated.as_ref(),
            declared: &declared,
        };
        let mut findings = Vec::new();
        rules::check_file(&ctx, &tree, &config.enabled, &mut findings);
        out.extend(findings.into_iter().map(|finding| (file, finding)));
    }
    out
}

/// Names of declarations a bare reference could resolve to, plus every
/// import alias in the program.
///
/// Only symbols with bare-reference positions count (models, contracts,
/// events, roles, messages, fixtures, scenarios, derived functions):
/// fields, parameters, derived fields, preferences, capabilities and
/// CRUD nodes are reachable only through member syntax or lexical
/// scope (where a `let` wins by nearest-binding-first), so they can
/// never steal a lint-attributed reference. Program-wide (not
/// module-scoped) on purpose: guards trade rare false negatives for
/// no false positives.
fn declared_names(program: &CheckedProgram) -> HashSet<String> {
    use crate::analysis::SymbolKind;
    let mut names = HashSet::new();
    for symbol in &program.symbols {
        let bare = matches!(
            symbol.kind,
            SymbolKind::Model { .. }
                | SymbolKind::Contract { .. }
                | SymbolKind::Event { .. }
                | SymbolKind::Role
                | SymbolKind::Message { .. }
                | SymbolKind::Fixture { .. }
                | SymbolKind::Scenario { .. }
                | SymbolKind::DeriveFn { .. }
        );
        if bare {
            names.insert(symbol.name.clone());
        }
    }
    for module in &program.modules {
        for import in &module.imports {
            for member in &import.members {
                names.insert(member.alias.clone());
            }
        }
    }
    names
}

fn sort_diagnostics(diagnostics: &mut [Diagnostic]) {
    diagnostics.sort_by(|a, b| {
        (
            a.primary.file,
            a.primary.start,
            a.primary.end,
            a.code,
            &a.message,
        )
            .cmp(&(
                b.primary.file,
                b.primary.start,
                b.primary.end,
                b.code,
                &b.message,
            ))
    });
}
