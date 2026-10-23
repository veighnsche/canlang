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
mod authority_query_sites;
mod mailbox_events;
mod payments_events;
mod standard_terminal_events;
mod membership;
pub mod model_policies;
pub mod model_policy_profile;
pub mod model_unique_conditions;
mod read_predicates;
mod purchase_all;
pub mod runtime_bindings;
pub mod scenario_calls;
mod scenario_create_sources;
mod scenario_current_revision;
mod scenario_feasibility;
pub mod scenario_queries;
mod scenario_receipts;
mod event_decisions;
mod event_notice_audit;
mod event_send_decisions;
mod success_send_decisions;
mod term_decisions;
mod leave_decisions;
mod refer_decisions;
mod rent_movement_refund_decisions;
mod member_retry_decisions;
mod invoice_overdue_decisions;
mod invoice_collect_decisions;
mod rent_notice_decisions;
mod invoice_issue_decisions;
mod send_guards;
mod source_send_data;
mod source_loops;
mod source_created_rows;
mod source_let_data;
pub mod sourcemap;
pub mod then_views;

use crate::analysis::CheckedProgram;
use crate::analysis::catalog::Catalog;
use crate::analysis::resolve::SymbolId;
use crate::codegen::artifact::CompileArtifact;
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
    /// Emit the private retained-result markers for a native State host.
    /// Generic callable/UI hosts keep their existing unclaimed ABI.
    pub native_scenario_receipts: bool,
}

impl EmitOptions {
    /// Production options: refuse incomplete analyses.
    pub fn new() -> Self {
        Self {
            allow_incomplete_test_only: false,
            native_scenario_receipts: false,
        }
    }

    /// Test-only options: proceed despite incomplete analysis. Golden
    /// tests only; artifacts stay test-only until the B1 join.
    pub fn test_only() -> Self {
        Self {
            allow_incomplete_test_only: true,
            native_scenario_receipts: false,
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
    let (ir, mut diags) = if standard_terminal_events::requested(program) {
        ir::build_standard_terminal_candidates(program, sources.db, sources.catalog)
    } else {
        ir::build(program, sources.db, sources.catalog)
    };
    let needs_source_context = sources.options.native_scenario_receipts
        || !program.payments_changed_handlers().is_empty()
        || ir.standard_completion_sources.is_private_terminal_candidate()
        || program.types.selected_calls.values().any(|call| {
            matches!(
                &call.target, crate::analysis::types::SelectedCallTarget::Builtin { id, .. }
                    if id == "active_member"
            )
        });
    let source_preparation = needs_source_context.then(|| {
        scenario_decisions::FreshSourceContext::prepare_queries(
            program,
            &ir,
            sources.db,
            sources.catalog,
        )
    });
    let query_context = source_preparation
        .as_ref()
        .and_then(|result| result.as_ref().ok());
    // Existing policy/query consumers retain their strict full-IR gate. The
    // membership producer bridge carries its own occurrence-scoped seal, so it
    // prepares from the unfiltered context instead.
    let source_context = query_context.filter(|context| !context.has_ir_errors());
    let query_preparation = sources
        .options
        .native_scenario_receipts
        .then(|| query_context.map(scenario_queries::PreparedQuerySources::from_context))
        .flatten();
    let feasibility = query_preparation
        .as_ref()
        .and_then(|prepared| prepared.returns());
    let mut query_sources = std::collections::BTreeMap::new();
    let mut query_receipts = std::collections::BTreeMap::new();
    let mut transcript_queries = std::collections::BTreeMap::new();
    let mut query_selections = std::collections::BTreeMap::new();
    let mut query_any = std::collections::BTreeMap::new();
    if let Some(prepared) = query_preparation.as_ref()
        && let Some(entry) = js::pick_entrypoint(&ir)
    {
        let entry_module = js::module_path(&ir.module(entry).name);
        for item in &ir.items {
            let collected = prepared.collect_owner(item, &entry_module);
            if let Some(metadata) = collected.any {
                query_any.insert(item.canonical.clone(), metadata);
            }
            if let Some(selections) = collected.selections {
                query_selections.insert(item.canonical.clone(), selections);
            }
            match collected.plan {
                Some(scenario_queries::CollectedQueryPlan::Transcript(plan)) => {
                    query_sources.insert(
                        item.canonical.clone(),
                        serde_json::to_value(&plan)
                            .expect("checked transcript query JSON invariant"),
                    );
                    transcript_queries.insert(item.canonical.clone(), plan);
                }
                Some(scenario_queries::CollectedQueryPlan::Receipt(recipe)) => {
                    query_sources.insert(
                        item.canonical.clone(),
                        serde_json::to_value(&recipe.plan)
                            .expect("checked query recipe JSON invariant"),
                    );
                    query_receipts.insert(item.canonical.clone(), *recipe);
                }
                Some(scenario_queries::CollectedQueryPlan::Source(plan)) => {
                    query_sources.insert(
                        item.canonical.clone(),
                        serde_json::to_value(plan).expect("checked query source JSON invariant"),
                    );
                }
                None => {}
            }
        }
    }
    // Membership correspondence is sealed per checked occurrence inside the
    // bridge, so unrelated IR refusals elsewhere do not orphan it. Query
    // consumers above keep the strict error-filtered context.
    let membership = query_context.and_then(membership::prepare_with_context);
    let mailbox_events = mailbox_events::prepare(program, &ir, sources.db, sources.catalog);
    let payments_changed_events = query_context.and_then(payments_events::prepare);
    let standard_terminal_events = query_context.and_then(standard_terminal_events::prepare);
    // Boolean/read inventory seals per checked occurrence inside its bridge,
    // so unrelated IR refusals elsewhere do not orphan it; the requires-only
    // fallback below preserves prior behavior when occurrence seals refuse.
    // SEND guards separately seal each owning scenario below; an unrelated
    // IR refusal must not erase another owner's exact guard.
    let read_predicates = sources
        .options
        .native_scenario_receipts
        .then(|| match source_context {
            Some(context) => read_predicates::prepare_with_context(context),
            None => query_context.and_then(|context| {
                read_predicates::prepare_with_context(context)
                    .or_else(|| read_predicates::prepare_requires_with_context(context))
            }),
        })
        .flatten();
    let send_guards = sources.options.native_scenario_receipts.then(|| {
        match source_preparation
            .as_ref()
            .expect("native source preparation was attempted")
        {
            Ok(context) => send_guards::prepare_with_context(context),
            Err(error) => Err(send_guards::source_preparation_gap(*error)),
        }
    });
    let policy_module = js::pick_entrypoint(&ir)
        .map(|entry| js::module_path(&ir.module(entry).name))
        .unwrap_or_else(|| js::module_path("index"));
    let local_policies = model_policies::collect_checked_policies(
        program,
        &ir,
        sources.db,
        sources.catalog,
        &policy_module,
    );
    let model_rule_origins = model_unique_conditions::collect_checked_model_rule_origins(
        program,
        &ir,
        sources.db,
        sources.catalog,
    );
    let unique_conditions = model_unique_conditions::collect_checked_unique_conditions(
        program,
        &ir,
        sources.db,
        sources.catalog,
    );
    let owner_handlers = ir.items.iter().filter_map(|owner| {
        scenario_decisions::owner_handler_queries(query_context?, owner).map(|()| owner.id)
    }).collect::<std::collections::HashSet<_>>();
    let authority_queries = query_context.and_then(authority_query_sites::prepare_with_context);
    let private_derives = query_context.and_then(|context|
        read_predicates.as_ref()?.private_only_derives(context, &owner_handlers));
    let js_out = js::emit_program_with_feasible_query_sources(
        &ir,
        sources.options.native_scenario_receipts,
        sources.db,
        &query_sources,
        &query_receipts,
        js::EmitDecisionSources {
            // Derived members carry their own occurrence-scoped seal, so the
            // emit path borrows the unfiltered context: unrelated IR refusals
            // elsewhere do not orphan exactly-bound derives. Strict consumers
            // above keep the error-filtered context.
            source_context: query_context,
            authority_queries: authority_queries.as_ref(),
            owner_handlers: Some(&owner_handlers),
            private_derives: private_derives.as_ref(),
            local_policies: local_policies.as_ref(),
            unique_conditions: unique_conditions.as_deref(),
            model_rule_origins: model_rule_origins.as_deref(),
            query_any: Some(&query_any),
            query_selections: Some(&query_selections),
            transcript_queries: Some(&transcript_queries),
            membership: membership.as_ref(),
            mailbox_events: mailbox_events.as_ref(),
            payments_changed_events: payments_changed_events.as_ref(),
            standard_terminal_events: standard_terminal_events.as_ref(),
            read_predicates: read_predicates.as_ref(),
            send_guards: send_guards.as_ref().and_then(|guards| guards.as_ref().ok()),
            send_guard_gap: send_guards
                .as_ref()
                .and_then(|guards| guards.as_ref().err()),
        },
        feasibility,
    );
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
        given_contracts: None,
        stylesheets: Vec::new(),
        generated_views: Vec::new(),
        value_types: None,
        model_policies: None,
        committed_changes: None,
        runtime_bindings: Vec::new(),
        pages: Vec::new(),
        derived_bool_receipts: Vec::new(),
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

pub mod scenario_decisions;
