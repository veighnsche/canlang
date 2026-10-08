//! Checked IR and direct JavaScript emission (lane-01 codegen, PR6).
//!
//! [`emit`] drives the pipeline: [`ir`] builds the checked IR from a
//! [`CheckedProgram`](crate::analysis::CheckedProgram), [`js`] lowers it to
//! production modules, [`bdd`] lowers separate test artifacts, [`sourcemap`]
//! maps emitted lines to `.can` byte spans, and [`artifact`] assembles the
//! [`CompileArtifact`](artifact::CompileArtifact) envelope.
//!
//! ## Diagnostic codes (`E6xxx`)
//!
//! * `E6005` `incomplete-analysis`: the driver refuses an incomplete
//!   analysis (`DiagnosticResult.complete == false`) unless the caller
//!   passes the explicit test-only acknowledgment. The pipeline analysis
//!   is complete (effects, examples, UI shape rules, handler sources),
//!   so production `can compile` never reports this; the acknowledgment
//!   exists for hermetic golden tests over partial fixtures.
//! * `E6006` `unchecked-position`: analysis left a position unchecked that
//!   emission needs. One diagnostic per affected item (scenario bodies,
//!   CRUD guards, fixture recipes, message text, derive expressions,
//!   model rules/labels, capability versions) plus one consolidated
//!   diagnostic per body-carrying module for families with no analysis
//!   tables at all (policies, invariants, unique constraints, locks,
//!   retains, pages, examples, migrations, descriptions). Emission
//!   continues with fail-closed placeholders (empty rule arrays, throwing
//!   stubs) and never invents semantics.
//! * `E6007` `unavailable-emission-capability`: compilation needs a
//!   producer capability that is not available — no catalog was consulted
//!   so `requires` cannot pin builtin semantics, no catalog was provided
//!   to verify a referenced builtin, or a referenced builtin is missing,
//!   `planned` or `external` in the consumed catalog. Names the producer
//!   and availability; never a silent emit.
//! * `E6008` `unsupported-emission`: a checked position has no DESIGN §13
//!   lowering — an unknown UI factory, named builtin arguments, a
//!   value-domain query, an unlowered authority scope/trigger/retains
//!   shape, or another unlowered position. The emitted placeholder
//!   throws loudly.
//! * `E6011` `checked-cohort-mismatch`: the source database or catalog
//!   belongs to a different owner, or a selected source did not exist at
//!   check time. Emission refuses before lowering, including in test-only mode.

pub mod artifact;
pub mod bdd;
mod defaults;
pub mod ir;
pub mod js;
pub mod sourcemap;

use crate::analysis::CheckedProgram;
use crate::analysis::catalog::Catalog;
use crate::analysis::resolve::SymbolId;
use crate::codegen::artifact::{CompileArtifact, to_json};
use crate::codegen::bdd::BddModule;
use crate::codegen::ir::{IrItemKind, IrProgram, ReferencedBuiltin};
use crate::diagnostic::{Diagnostic, DiagnosticResult};
use crate::source::{SourceDb, SourceId, Span};

/// Codegen driver options.
#[derive(Debug, Clone)]
pub struct EmitOptions {
    /// Explicit test-only acknowledgment that the analysis is incomplete.
    /// Hermetic golden tests over partial fixtures set this; it must
    /// never gate production compilation, and artifacts produced under
    /// it make no runtime-success claims. It never bypasses input-owner checks.
    pub allow_incomplete_test_only: bool,
}

impl EmitOptions {
    /// Production options: refuse incomplete analyses.
    pub fn new() -> Self {
        Self {
            allow_incomplete_test_only: false,
        }
    }

    /// Test-only options: proceed despite incomplete analysis. Golden
    /// tests only; artifacts stay test-only until the B1 join.
    pub fn test_only() -> Self {
        Self {
            allow_incomplete_test_only: true,
        }
    }
}

impl Default for EmitOptions {
    fn default() -> Self {
        Self::new()
    }
}

/// Sources consulted by one emission: texts, analysis result and catalog.
#[derive(Debug)]
pub struct EmitSources<'a> {
    /// Original checked source owner (appends and moves remain valid).
    pub db: &'a SourceDb,
    /// Analysis result: completeness gates emission.
    pub result: &'a DiagnosticResult,
    /// Original checked catalog or its clone, if one was loaded.
    pub catalog: Option<&'a Catalog>,
    /// Driver options.
    pub options: EmitOptions,
}

/// Emit a compile artifact from a checked program.
///
/// Refuses incomplete analyses with a precise `E6005` unless the caller
/// passes the explicit test-only acknowledgment. Otherwise builds the
/// checked IR, lowers production and test modules, maps source spans
/// and assembles the artifact, returning every `E6006`/`E6007`/
/// `E6008` alongside it in canonical order. Numeric emission capacity
/// failures return `E6012` with no executable artifact. Diagnostics with severity
/// error always block shipping; the caller decides that from the returned
/// list.
///
/// Inputs must retain the program's source/catalog owners. Foreign owners
/// return `E6011` with no executable output, even when contents match or
/// test-only options acknowledge incomplete analysis. Source/map inventory
/// still includes all DB entries; only [`CheckedProgram::checked_files`] are
/// lowered. Callers must merge analysis/load errors as well as emitted errors.
pub fn emit(
    program: &CheckedProgram,
    sources: &EmitSources<'_>,
) -> (CompileArtifact, Vec<Diagnostic>) {
    if !sources.result.complete && !sources.options.allow_incomplete_test_only {
        let primary = sources
            .db
            .iter()
            .next()
            .map(|(id, _)| Span::new(id, 0, 0))
            .unwrap_or(Span::new(SourceId(0), 0, 0));
        return (
            empty_artifact(sources.db),
            vec![Diagnostic::error(
                "E6005",
                "analysis is incomplete (complete=false); codegen refuses to emit without an explicit test-only acknowledgment".to_string(),
                primary,
            )],
        );
    }
    if let Err(diagnostic) = program.validate_cohort(sources.db, sources.catalog) {
        return (empty_artifact(sources.db), vec![diagnostic]);
    }
    let (ir, mut diags) = ir::build(program, sources.db, sources.catalog);
    let js_out = js::emit_program(&ir);
    diags.extend(js_out.diagnostics.iter().cloned());
    if diags.iter().any(|diagnostic| diagnostic.code == "E6012") {
        diags.sort_by(Diagnostic::canonical_cmp);
        return (empty_artifact(sources.db), diags);
    }
    let (test_modules, test_builtins, suite_diags) = emit_suites(&ir);
    diags.extend(suite_diags);
    if diags.iter().any(|diagnostic| diagnostic.code == "E6012") {
        diags.sort_by(Diagnostic::canonical_cmp);
        return (empty_artifact(sources.db), diags);
    }
    let (artifact, mut artifact_diags) = artifact::assemble(
        &ir,
        &js_out,
        &test_modules,
        &test_builtins,
        sources.db,
        sources.catalog,
    );
    diags.append(&mut artifact_diags);
    diags.sort_by(Diagnostic::canonical_cmp);
    (artifact, diags)
}

fn empty_artifact(db: &SourceDb) -> CompileArtifact {
    CompileArtifact {
        language_version: crate::LANGUAGE_VERSION.to_string(),
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        sources: db
            .iter()
            .map(|(_, source)| artifact::ArtifactSource {
                path: source.path.clone(),
                sha256: source.sha256.clone(),
            })
            .collect(),
        modules: Vec::new(),
        callables: Vec::new(),
        operations: Vec::new(),
        models: Vec::new(),
        pages: Vec::new(),
        migrations: Vec::new(),
        requires: Vec::new(),
        tests: Vec::new(),
    }
}

/// One test module per suite (operation suites, then orphan recipes),
/// in suite order; fixtures without a decoded recipe keep a failing
/// shell so the suite still fails closed. Returns the modules, the
/// suite-observed builtin references for availability checks, and the
/// suite diagnostics.
fn emit_suites(ir: &IrProgram) -> (Vec<BddModule>, Vec<ReferencedBuiltin>, Vec<Diagnostic>) {
    let mut modules = Vec::new();
    let mut builtins = Vec::new();
    let mut diags = Vec::new();
    for suite in &ir.suites {
        let (module, diagnostics, suite_builtins) = bdd::emit_suite(ir, suite);
        modules.push(module);
        builtins.extend(suite_builtins);
        diags.extend(diagnostics);
    }
    // Fixtures the suites never claim (recipes missing) keep a failing
    // shell; the IR build already reports their `E6006`.
    let claimed: std::collections::HashSet<SymbolId> = ir
        .suites
        .iter()
        .flat_map(|suite| suite.fixtures.iter())
        .filter_map(|fixture| {
            ir.items.iter().find_map(|item| {
                if item.canonical == fixture.canonical {
                    Some(item.id)
                } else {
                    None
                }
            })
        })
        .collect();
    for item in &ir.items {
        if matches!(item.kind, IrItemKind::Fixture { .. }) && !claimed.contains(&item.id) {
            match bdd::try_emit_fixture_shell(ir, item) {
                Ok(module) => modules.push(module),
                Err(diagnostic) => diags.push(diagnostic),
            }
        }
    }
    (modules, builtins, diags)
}

/// Render a compile artifact as compact JSON per `artifact.ts`.
pub fn to_json_string(artifact: &CompileArtifact) -> String {
    to_json(artifact)
}
