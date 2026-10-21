//! Original checked query lineage transported through the existing State DTO.
//! This optional source producer does not certify native execution or turn a
//! declined scenario into a complete disclosure.
use std::collections::HashSet;

use crate::analysis::catalog::Catalog;
use crate::analysis::resolve::{SymbolId, SymbolKind};
use crate::analysis::scenario_disclosure::{
    CheckedScenarioDisclosure, CheckedScenarioSource, CheckedTranscriptField,
    CheckedTranscriptSource, DependencyRole, DisclosureDependency, DisclosureInfluence,
    DisclosureIntrinsic, DisclosureQuery, DisclosureQueryProjection, DisclosureReturn,
    DisclosureSource, InfluenceKind, ScenarioDisclosure,
};
use crate::analysis::types::{
    CheckedQuery, CheckedQueryProjection, CheckedQueryProjectionField,
    CheckedQueryProjectionMapping, SelectedCallTarget,
};
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType};
use crate::source::{SourceDb, Span};

use super::ir::{IrExpr, IrItem, IrItemKind, IrProgram, IrQuery, IrQueryDomain, IrOwner, IrStmt, IrType, TypedExpr};
use super::scenario_decisions::{same_scenario_semantics, serial_type};
use super::scenario_receipts::{
    NativeIntrinsicKind, NativeReturn, NativeScenarioReceipt, ReceiptDependency,
    ReceiptDisclosurePlan, ReceiptInfluence, ReceiptIntrinsic, ReceiptQuery,
    ReceiptQueryDependency, ReceiptQueryOrder, ReceiptQueryParent, ReceiptQueryParentOrigin,
    ReceiptQueryProjection, ReceiptQueryProjectionField, ReceiptReturn, ReceiptRole, ReceiptSource,
};

/// Fresh lowering and successful-requirement correspondence for exactly one
/// immutable query input cohort. Standalone consumers construct their own;
/// the emitter borrows its shared source preparation instead.
pub(super) struct PreparedQuerySources<'a> {
    program: &'a CheckedProgram,
    ir: &'a IrProgram,
    db: &'a SourceDb,
    catalog: Option<&'a Catalog>,
    fresh: std::borrow::Cow<'a, IrProgram>,
    diagnostics: Vec<crate::diagnostic::Diagnostic>,
    returns: Option<super::scenario_feasibility::PreparedRequireReturns<'a>>,
    source_context: Option<&'a super::scenario_decisions::FreshSourceContext<'a>>,
}

/// Backend gaps remain diagnostics on the complete artifact. They cannot stand
/// in for missing correspondence inside this owner's original source closure.
fn declaration_span(program: &CheckedProgram, id: SymbolId) -> Option<Span> {
    use crate::analysis::resolve::SymbolKind;
    let symbol = program.symbols.get(id.0 as usize)?;
    let node = match &symbol.kind {
        SymbolKind::Scenario { .. } => Some(program.effects.scenarios.get(&id)?.node),
        SymbolKind::DeriveFn { .. } | SymbolKind::DeriveField { .. } => {
            Some(program.effects.derives.get(&id)?.node)
        }
        SymbolKind::Model { .. } => Some(program.effects.models.get(&id)?.node),
        SymbolKind::Contract { .. } | SymbolKind::Event { .. }
        | SymbolKind::Preferences { .. } => Some(program.effects.records.get(&id)?.node),
        SymbolKind::Field { owner, .. } => {
            let fields = program.effects.models.get(owner).map(|model| &model.fields)
                .or_else(|| program.effects.records.get(owner).map(|record| &record.fields))?;
            Some(fields.iter().find(|field| field.field == id)?.node)
        }
        SymbolKind::Param { owner, .. } => {
            let params = program.effects.scenarios.get(owner).map(|scenario| &scenario.params)
                .or_else(|| program.effects.derives.get(owner).map(|derive| &derive.params))?;
            Some(params.iter().find(|parameter| parameter.param == id)?.node)
        }
        _ => None,
    };
    if let Some(node) = node {
        if node.file != symbol.span.file || node.start > symbol.span.start
            || node.end < symbol.span.end {
            return None;
        }
        Some(Span::new(node.file, node.start, node.end))
    } else {
        Some(symbol.span)
    }
}

fn declare_type_symbols(
    program: &CheckedProgram,
    ty: &ResolvedType,
    spans: &mut Vec<Span>,
) -> Option<()> {
    match ty {
        ResolvedType::Record { symbol, .. } | ResolvedType::Message(symbol) => {
            spans.push(declaration_span(program, *symbol)?)
        }
        ResolvedType::Enum {
            owner: Some(owner), ..
        } => spans.push(declaration_span(program, *owner)?),
        ResolvedType::Array { element, .. } | ResolvedType::Nullable(element) => {
            declare_type_symbols(program, element, spans)?
        }
        _ => {}
    }
    Some(())
}

fn declare_fact_symbols(
    program: &CheckedProgram,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    spans: &mut Vec<Span>,
    require_queries: bool,
) -> Option<()> {
    use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
    for parameter in &source.parameters {
        spans.push(declaration_span(program, parameter.parameter)?);
        declare_type_symbols(program, &parameter.ty, spans)?;
        if let Some(alias) = parameter.constraints.as_ref().and_then(|value| value.alias) {
            spans.push(declaration_span(program, alias)?);
        }
    }
    for call in &source.calls {
        spans.push(declaration_span(program, call.operation)?);
    }
    for site in source.decision_sites.as_ref()? {
        for call in &site.calls {
            if let CheckedDecisionCallTarget::DeriveFn(id) = call.target {
                spans.push(declaration_span(program, id)?);
            }
            for frame in &call.chain {
                spans.push(declaration_span(program, frame.derive)?);
            }
            for (id, _) in &call.defaults {
                spans.push(declaration_span(program, *id)?);
            }
        }
    }
    let queries = if require_queries {
        source.queries.as_deref()?
    } else {
        source.queries.as_deref().unwrap_or_default()
    };
    for query in queries {
        spans.push(declaration_span(program, query.model)?);
    }
    Some(())
}

fn declare_schema_symbols(
    program: &CheckedProgram,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    spans: &mut Vec<Span>,
) -> Option<()> {
    for schema in source.stored_contracts.iter().flatten() {
        spans.push(declaration_span(program, schema.id)?);
        if let Some(parent) = schema.parent {
            spans.push(declaration_span(program, parent)?);
        }
        for field in &schema.fields {
            spans.push(declaration_span(program, field.id)?);
            declare_type_symbols(program, &field.ty, spans)?;
            if let Some(alias) = field.constraints.as_ref().and_then(|value| value.alias) {
                spans.push(declaration_span(program, alias)?);
            }
            if let Some(reuse) = field.reuse {
                spans.push(declaration_span(program, reuse)?);
            }
        }
    }
    declare_create_symbols(program, source, spans)
}

fn declare_create_symbols(
    program: &CheckedProgram,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    spans: &mut Vec<Span>,
) -> Option<()> {
    for create in source.creates.iter().flatten() {
        spans.push(declaration_span(program, create.model)?);
        for field in &create.definition.fields {
            spans.push(declaration_span(program, field.field)?);
            declare_type_symbols(program, &field.ty, spans)?;
            if let Some(alias) = field.constraints.as_ref().and_then(|value| value.alias) {
                spans.push(declaration_span(program, alias)?);
            }
            for (data, _, _, _, _) in &field.modifier_sources {
                spans.push(declaration_span(program, data.field)?);
            }
        }
    }
    Some(())
}

pub(super) fn checked_query_diagnostics(
    program: &CheckedProgram,
    owner: &IrItem,
    diagnostics: &[crate::diagnostic::Diagnostic],
) -> Option<()> {
    checked_owner_diagnostics(program, owner, diagnostics, true)
}

/// A SEND owner may have no query inventory. The same diagnostic closure
/// still covers its body, consumed helpers and schema declarations.
pub(super) fn checked_send_diagnostics(
    program: &CheckedProgram,
    owner: &IrItem,
    diagnostics: &[crate::diagnostic::Diagnostic],
) -> Option<()> {
    checked_owner_diagnostics(program, owner, diagnostics, false)
}

fn checked_owner_diagnostics(
    program: &CheckedProgram,
    owner: &IrItem,
    diagnostics: &[crate::diagnostic::Diagnostic],
    require_queries: bool,
) -> Option<()> {
    let source = program
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    // Symbol/IR spans cover declaration names only. A refusal inside an
    // original initializer or helper body belongs to the consumed closure too.
    let mut spans = vec![Span::new(source.node.file, source.node.start, source.node.end)];
    declare_fact_symbols(program, source, &mut spans, require_queries)?;
    declare_schema_symbols(program, source, &mut spans)?;
    let overlaps = |a: Span, b: Span| a.file == b.file && a.start <= b.end && b.start <= a.end;
    for diagnostic in diagnostics {
        if diagnostic.severity != crate::diagnostic::Severity::Error {
            continue;
        }
        if !matches!(diagnostic.code, "E6007" | "E6008")
            || spans.iter().any(|span| {
                overlaps(*span, diagnostic.primary)
                    || diagnostic
                        .related
                        .iter()
                        .any(|related| overlaps(*span, related.span))
            })
        {
            return None;
        }
    }
    Some(())
}

pub(super) enum CollectedQueryPlan {
    Transcript(ReceiptDisclosurePlan),
    Receipt(Box<NativeScenarioReceipt>),
    Source(ReceiptDisclosurePlan),
}

pub(super) struct CollectedQuerySources {
    pub any: Option<serde_json::Value>,
    pub selections: Option<serde_json::Value>,
    pub plan: Option<CollectedQueryPlan>,
}

impl<'a> PreparedQuerySources<'a> {
    fn standalone(
        program: &'a CheckedProgram,
        ir: &'a IrProgram,
        db: &'a SourceDb,
        catalog: Option<&'a Catalog>,
    ) -> Option<Self> {
        program.validate_cohort(db, catalog).ok()?;
        let (fresh, diagnostics) = super::ir::build(program, db, catalog);
        let returns = if diagnostics.iter().any(|d| {
            d.severity == crate::diagnostic::Severity::Error && !matches!(d.code, "E6007" | "E6008")
        }) {
            None
        } else {
            super::scenario_feasibility::prepare_with_fresh(program, ir, db, catalog, &fresh)
        };
        Some(Self {
            program,
            ir,
            db,
            catalog,
            fresh: std::borrow::Cow::Owned(fresh),
            diagnostics,
            returns,
            source_context: None,
        })
    }

    pub(super) fn from_context(
        context: &'a super::scenario_decisions::FreshSourceContext<'a>,
    ) -> Self {
        let program = context.program();
        let ir = context.ir();
        let db = context.db();
        let catalog = context.catalog();
        Self {
            program,
            ir,
            db,
            catalog,
            fresh: std::borrow::Cow::Borrowed(context.fresh()),
            diagnostics: context.ir_diagnostics().to_vec(),
            returns: super::scenario_feasibility::prepare_with_fresh(
                program,
                ir,
                db,
                catalog,
                context.fresh(),
            ),
            source_context: Some(context),
        }
    }

    pub(super) fn returns(
        &self,
    ) -> Option<&super::scenario_feasibility::PreparedRequireReturns<'a>> {
        self.returns.as_ref()
    }

    fn checked_owner(&self, owner: &IrItem) -> Option<()> {
        checked_query_diagnostics(self.program, owner, &self.diagnostics)?;
        same_scenario_semantics(self.program, self.ir, &self.fresh, owner)
    }

    fn decisions(&self, owner: &IrItem) -> Option<()> {
        self.checked_owner(owner)?;
        if let Some(context) = self.source_context {
            super::scenario_decisions::collect_decision_sources_with_context(context, owner)?;
        } else {
            super::scenario_decisions::collect_decision_sources_with_fresh(
                self.program,
                self.ir,
                owner,
                self.db,
                self.catalog,
                &self.fresh,
            )?;
        }
        Some(())
    }

    fn plan(&self, owner: &IrItem, entry: &str) -> Option<ReceiptDisclosurePlan> {
        self.plan_with_context(owner, entry, self.source_context)
    }

    fn plan_with_context(
        &self,
        owner: &IrItem,
        entry: &str,
        source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
    ) -> Option<ReceiptDisclosurePlan> {
        let returned = if matches!(owner.kind, IrItemKind::Scenario { read: false, .. })
            && matches!(
                self.program.scenario_disclosures().get(&owner.id)?,
                ScenarioDisclosure::Complete(_)
            ) {
            Some(self.returns.as_ref()?.returns(self.ir, owner.id)?)
        } else {
            None
        };
        let mut plan = checked_query_plan_full(
            self.program,
            self.ir,
            owner,
            self.db,
            self.catalog,
            entry,
            self,
            source_context,
        )?;
        if let Some(returned) = returned {
            super::scenario_receipts::project_plan_returns(&mut plan, &returned)?;
        }
        Some(plan)
    }

    /// Authenticate each owner plan once, then derive its separate metadata.
    pub(super) fn collect_owner(&self, owner: &IrItem, entry: &str) -> CollectedQuerySources {
        let any = serialize_query_any_prepared(
            self.program,
            self.ir,
            owner,
            self.db,
            self.catalog,
            entry,
            Some(self),
        );
        let Some(plan) = self.plan(owner, entry) else {
            return CollectedQuerySources {
                any,
                selections: None,
                plan: None,
            };
        };
        let source = self
            .ir
            .scenario_disclosures
            .get(&owner.id)
            .and_then(|d| d.source_facts());
        let transcript = source.is_some_and(|source| {
            source
                .transcripts
                .as_deref()
                .is_some_and(|facts| !facts.is_empty())
                || source
                    .inline_selections
                    .as_deref()
                    .is_some_and(|facts| !facts.is_empty())
        });
        if transcript {
            return CollectedQuerySources {
                any,
                selections: selection_metadata(self.ir, owner),
                plan: Some(CollectedQueryPlan::Transcript(plan)),
            };
        }
        // A failed native-receipt join still retains the authenticated source
        // plan exactly as the former standalone source fallback did.
        let receipt = collect_complete_query_receipt_prepared(
            self.program,
            self.ir,
            owner,
            self,
            plan.clone(),
        );
        CollectedQuerySources {
            any,
            selections: None,
            plan: Some(match receipt {
                Some(receipt) => CollectedQueryPlan::Receipt(Box::new(receipt)),
                None => CollectedQueryPlan::Source(plan),
            }),
        }
    }
}

/// Serialize the real checked model scan, local nominal select and all four
/// domain influences. The plan is source correspondence only: State still
/// requires its actual private query execution, candidates and checkpoint.
pub fn serialize_query_sources(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<serde_json::Value> {
    serde_json::to_value(checked_query_plan(
        program,
        ir,
        owner,
        db,
        catalog,
        entry_module,
        None,
    )?)
    .ok()
}

/// Retain the authenticated transcript plan for the native collector. The
/// source plan alone still cannot admit capture or a created-model result.

/// Literal intermediate selection metadata, authenticated through the same
/// source query path. This does not bind a result or activate native capture.

fn selection_metadata(ir: &IrProgram, owner: &IrItem) -> Option<serde_json::Value> {
    let source = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let transcripts = source.transcripts.as_deref()?;
    let inline = source.inline_selections.as_deref()?;
    if transcripts.is_empty() && inline.is_empty() {
        return None;
    }
    let metadata=transcripts.iter().map(|fact|(&fact.id,&fact.fields,&fact.dependencies))
        .chain(inline.iter().map(|fact|(&fact.query.id,&fact.fields,&fact.dependencies)))
        .map(|(id,fields,dependencies)|serde_json::json!({"queryId":id,"type":"TextMessage[]",
            "fields":fields.iter().zip(dependencies).map(|(field,dependency)|serde_json::json!({"name":field.name,"dependencyId":dependency.id})).collect::<Vec<_>>()
        })).collect();
    Some(serde_json::Value::Array(metadata))
}

/// The literal existential selector belongs to its original checked collection
/// call. Publishing it does not admit the scenario or a native query lifetime.

fn any_query_gate(program: &CheckedProgram, owner: &IrItem) -> Option<()> {
    if !matches!(
        owner.kind,
        IrItemKind::Scenario {
            read: false,
            trusted: false,
            cohort: None,
            ..
        }
    ) {
        return None;
    }
    if !program
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?
        .queries
        .as_deref()?
        .iter()
        .any(|query| {
            query.first.is_none()
                && query.count.is_none()
                && query.projection.is_none()
                && program.types.checked_collection_calls.values().any(|call| {
                    call.builtin == "any" && call.query == query.node && call.model == query.model
                })
        })
    {
        return None;
    }
    Some(())
}

fn prepare_any_fresh<'i, 'p>(
    program: &CheckedProgram,
    ir: &'i IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
    prepared: Option<&'p PreparedQuerySources<'p>>,
) -> Option<(
    &'i crate::analysis::scenario_disclosure::CheckedScenarioSource,
    std::borrow::Cow<'p, IrProgram>,
)> {
    program.validate_cohort(db, catalog).ok()?;
    if entry_module.is_empty() {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let original = program
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    if source.queries != original.queries
        || source.source != original.source
        || source.node != original.node
    {
        return None;
    }
    let fresh = if let Some(prepared) = prepared {
        prepared.checked_owner(owner)?;
        std::borrow::Cow::Borrowed(prepared.fresh.as_ref())
    } else {
        let (fresh, diagnostics) = super::ir::build(program, db, catalog);
        checked_query_diagnostics(program, owner, &diagnostics)?;
        std::borrow::Cow::Owned(fresh)
    };
    same_scenario_semantics(program, ir, &fresh, owner)?;
    same_scenario_semantics(program, ir, &fresh, ir.items.get(owner.id.0 as usize)?)?;
    Some((source, fresh))
}

fn select_any_call(
    mixed: bool,
    owner: &IrItem,
    outer: NodeKey,
    query: &DisclosureQuery,
    site: &crate::analysis::scenario_disclosure::CheckedDecisionSite,
    site_index: usize,
    call: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
    call_index: usize,
) -> Option<(usize, usize)> {
    use crate::analysis::scenario_disclosure::{
        CheckedDecisionCallTarget, CheckedDecisionStage,
    };
    (site.owner == owner.id && (site.stage == CheckedDecisionStage::LeadingRequire
        || mixed && site.stage == CheckedDecisionStage::BodyRequire)
        && (site.node == outer || mixed) && call.chain.len() == 1 && call.chain[0].node == outer
        && matches!(&call.target,CheckedDecisionCallTarget::Builtin{id,overload} if id=="any" && *overload==0)
        && call.arguments.first().is_some_and(|value| value.0==query.node)
        && call.arguments.get(1).is_some_and(|value| Some(value.0)==query.predicate))
        .then_some((site_index,call_index))
}

fn native_any_metadata(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    fresh: &IrProgram,
    prepared: Option<&PreparedQuerySources<'_>>,
) -> Option<Option<serde_json::Value>> {
    use crate::analysis::scenario_disclosure::CheckedDecisionStage;
    let Some(plan) = super::scenario_receipts::checked_native_helper_any_query_plan(ir, owner, db, entry_module)
            .or_else(|| {
                super::scenario_receipts::checked_native_mixed_helper_query_plan(
                    ir,
                    owner,
                    db,
                    entry_module,
                )
            })
    else {
        return Some(None);
    };
    if let Some(prepared) = prepared {
        prepared.decisions(owner)?;
    } else {
        super::scenario_decisions::serialize_decision_sources_with_fresh(
            program, ir, owner, db, catalog, fresh,
        )?;
    }
    let mixed = plan.queries.len() == 3;
    let mut metadata = Vec::new();
    for query in source
        .queries
        .as_deref()?
        .iter()
        .filter(|query| query.first.is_none())
    {
        let outer = *query.dependencies.first()?.calls.first()?;
        let sites: Vec<_> = source
            .decision_sites
            .as_deref()?
            .iter()
            .filter(|site| {
                !matches!(
                    site.stage,
                    CheckedDecisionStage::ReadPolicy
                        | CheckedDecisionStage::ReadPredicate
                        | CheckedDecisionStage::SendDispatch
                )
            })
            .collect();
        let mut selected = sites.iter().enumerate().flat_map(|(site_index,site)|
        site.calls.iter().enumerate().filter_map(move |(call_index,call)|
            select_any_call(mixed, owner, outer, query, site, site_index, call, call_index)));
        let (site_index, call_index) = selected.next()?;
        if selected.next().is_some() {
            return None;
        }
        metadata.push(serde_json::json!({"kind":"predicate","queryId":query.id,
        "dependencyIds":query.dependencies.iter().map(|read|&read.id).collect::<Vec<_>>(),
        "sourceCall":{"siteIndex":site_index,"callIndex":call_index}}));
    }
    Some(Some(serde_json::Value::Array(metadata)))
}

fn resolve_composed_call(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    guards: &[IrStmt],
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    q: &DisclosureQuery,
) -> Option<Option<(Span, Span, SymbolId, Span)>> {
    use super::ir::IrUnOp;
    let mut collections = program
        .types
        .checked_collection_calls
        .values()
        .filter(|call| call.builtin == "any" && call.query == q.node);
    let collection = collections.next()?;
    if collections.next().is_some() {
        return None;
    }
    let mut actual_calls = guards.iter().filter_map(|guard| {
        let IrStmt::Require { cond, span } = guard else {
            return None;
        };
        // Negated and positive guard polarities share the defining
        // matcher; the bare `any(...)` cond carries its own call span.
        let operand = match &cond.expr {
            IrExpr::Unary {
                op: IrUnOp::Not,
                operand,
            } => operand.as_ref(),
            _ => cond,
        };
        same_span(collection.node, operand.span)
            .then_some((operand, cond.span, *span))
    });
    let (call, cond_span, guard_span) = actual_calls.next()?;
    if actual_calls.next().is_some() {
        return None;
    }
    if super::scenario_receipts::checked_any_first_query_ir(ir, owner, call, db)
        != Some(q)
    {
        return Some(None);
    }
    let parent = super::scenario_receipts::checked_any_first_parent(ir, owner, q, call, db);
    let (_, _, _, _, parent_model) = parent?;
    Some(Some((cond_span, guard_span, parent_model, call.span)))
}

fn composed_site_matches(
    site: &crate::analysis::scenario_disclosure::CheckedDecisionSite,
    owner: &IrItem,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    guard_span: Span,
    cond_span: Span,
) -> bool {
    use crate::analysis::scenario_disclosure::CheckedDecisionStage;
    site.owner == owner.id
        && site.stage == CheckedDecisionStage::LeadingRequire
        && same_span(site.statement, guard_span)
        && same_span(site.node, cond_span)
        && site.source == source.source
}

fn composed_call_matches(
    original_call: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
    q: &DisclosureQuery,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    owner: &IrItem,
    call_span: Span,
) -> bool {
    use crate::analysis::scenario_disclosure::CheckedDecisionCallTarget;
    same_span(original_call.node, call_span)
        && matches!(&original_call.target, CheckedDecisionCallTarget::Builtin{id,overload} if id=="any" && *overload==0)
        && original_call.arguments.len() == 2
        && original_call.arguments[0].0 == q.node
        && Some(original_call.arguments[1].0) == q.predicate
        && original_call.slots == [Some(0), Some(1)]
        && original_call.defaults.is_empty()
        && original_call.chain.is_empty()
        && original_call.source == source.source
        && original_call.module == owner.module
}

fn match_composed_site<'s>(
    source: &'s crate::analysis::scenario_disclosure::CheckedScenarioSource,
    owner: &IrItem,
    q: &DisclosureQuery,
    call_span: Span,
    cond_span: Span,
    guard_span: Span,
) -> Option<(
    usize,
    usize,
    &'s crate::analysis::scenario_disclosure::CheckedDecisionCall,
)> {
    use crate::analysis::scenario_disclosure::CheckedDecisionStage;
    let sites: Vec<_> = source
        .decision_sites
        .as_deref()?
        .iter()
        .filter(|site| {
            !matches!(
                site.stage,
                CheckedDecisionStage::ReadPolicy
                    | CheckedDecisionStage::ReadPredicate
                    | CheckedDecisionStage::SendDispatch
            )
        })
        .collect();
    let mut found = Vec::new();
    for (site_index, site) in sites.iter().enumerate() {
        for (call_index, original_call) in site.calls.iter().enumerate() {
            if composed_site_matches(site, owner, source, guard_span, cond_span)
                && composed_call_matches(original_call, q, source, owner, call_span)
            {
                found.push((site_index, call_index, site, original_call));
            }
        }
    }
    let [matched] = found.as_slice() else {
        return None;
    };
    let (site_index, call_index, _site, original_call) = *matched;
    Some((site_index, call_index, original_call))
}

fn resolve_composed_domain(
    program: &CheckedProgram,
    q: &DisclosureQuery,
    original_call: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
) -> Option<(String, bool, NodeKey, NodeKey)> {
    use crate::analysis::{ResolvedType, Scalar};
    let (domain_node, predicate_node) =
        (original_call.arguments[0].0, original_call.arguments[1].0);
    let predicate_bool = matches!(
        program.types.node_types.get(&predicate_node),
        Some(ResolvedType::Scalar(Scalar::Bool))
    );
    let domain_model = match program.types.node_types.get(&domain_node) {
        Some(ResolvedType::Array { element, .. })
            if matches!(element.as_ref(),
                ResolvedType::Record { symbol, .. } if *symbol == q.model) =>
        {
            format!("{model}[]", model = q.model_name)
        }
        _ => return None,
    };
    Some((domain_model, predicate_bool, domain_node, predicate_node))
}

fn push_composed_metadata(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry_module: &str,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    q: &DisclosureQuery,
    parent_model: SymbolId,
    site_index: usize,
    call_index: usize,
    original_call: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
    domain_model: String,
    predicate_bool: bool,
    domain_node: NodeKey,
    predicate_node: NodeKey,
    metadata: &mut Vec<serde_json::Value>,
    composed: &mut Vec<String>,
) -> Option<()> {
    for id in [q.model, parent_model] {
        let schema = source
            .stored_contracts
            .as_deref()?
            .iter()
            .find(|schema| schema.id == id && schema.model)?;
        super::scenario_receipts::match_stored_contract_schema(ir, schema, db)?;
        for field in &schema.fields {
            super::scenario_receipts::match_stored_contract_field(ir, field, db)?;
        }
    }
    // Direct chain-free guard calls carry the exact checked call
    // record for the runtime to re-verify against the installed
    // owner/source producer: LeadingRequire stage, builtin `any`,
    // source/model argument slots and empty chain. The `direct`
    // bit only routes past helper-chain resolution; it authorizes
    // nothing by itself, and every field below is sealed.
    if !predicate_bool
        || original_call.node.start >= original_call.node.end
        || domain_node.start < original_call.node.start
        || domain_node.end > original_call.node.end
        || predicate_node.start < original_call.node.start
        || predicate_node.end > original_call.node.end
    {
        return None;
    }
    let call_source =
        super::scenario_receipts::transport_source(&original_call.source, entry_module)?;
    metadata.push(serde_json::json!({"kind":"predicate","queryId":q.id,
    "dependencyIds":q.dependencies.iter().map(|read|&read.id).collect::<Vec<_>>(),
    "sourceCall":{"siteIndex":site_index,"callIndex":call_index},"direct":true,
    "call":{
        "owner":owner.canonical,
        "stage":"leading-require",
        "siteIndex":site_index,
        "callIndex":call_index,
        "source":call_source,
        "node":{"start":original_call.node.start,"end":original_call.node.end},
        "target":{"kind":"builtin","id":"any","overload":0},
        "arguments":[
            {"type":domain_model,
                "node":{"start":domain_node.start,"end":domain_node.end}},
            {"type":"bool",
                "node":{"start":predicate_node.start,"end":predicate_node.end}}
        ],
        "slots":[0,1],
        "chain":[]}}));
    composed.push(q.id.clone());
    Some(())
}

fn match_composed_query(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry_module: &str,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    guards: &[IrStmt],
    q: &DisclosureQuery,
    metadata: &mut Vec<serde_json::Value>,
    composed: &mut Vec<String>,
) -> Option<()> {
    let Some((cond_span, guard_span, parent_model, call_span)) =
        resolve_composed_call(program, ir, owner, db, guards, source, q)?
    else {
        return Some(());
    };
    let (site_index, call_index, original_call) =
        match_composed_site(source, owner, q, call_span, cond_span, guard_span)?;
    let (domain_model, predicate_bool, domain_node, predicate_node) =
        resolve_composed_domain(program, q, original_call)?;
    push_composed_metadata(
        program, ir, owner, db, entry_module, source, q, parent_model,
        site_index, call_index, original_call, domain_model, predicate_bool,
        domain_node, predicate_node, metadata, composed,
    )
}

fn collect_composed_metadata(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry_module: &str,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    guards: &[IrStmt],
) -> Option<(Vec<serde_json::Value>, Vec<String>)> {
    let mut metadata = Vec::new();
    let mut composed = Vec::new();
    for q in source
        .queries
        .as_deref()?
        .iter()
        .filter(|q| q.first.is_none() && q.count.is_none() && q.projection.is_none())
    {
        match_composed_query(
            program, ir, owner, db, entry_module, source, guards, q,
            &mut metadata, &mut composed,
        )?;
    }
    Some((metadata, composed))
}

fn resolve_bool_call<'p, 'g>(
    program: &'p CheckedProgram,
    guards: &'g [IrStmt],
    q: &DisclosureQuery,
) -> Option<(
    &'p crate::analysis::types::CheckedCollectionCall,
    &'p crate::analysis::types::SelectedCall,
    &'g TypedExpr,
    NodeKey,
    &'g super::ir::IrCallTarget,
    &'g [TypedExpr],
    Option<&'g [Option<usize>]>,
    &'g TypedExpr,
    &'g TypedExpr,
    &'g super::ir::IrQuery,
    &'g String,
    &'g TypedExpr,
)> {
    use super::ir::IrUnOp;
    let mut calls = program
        .types
        .checked_collection_calls
        .values()
        .filter(|call| call.builtin == "any" && call.query == q.node);
    let collection = calls.next()?;
    if calls.next().is_some() {
        return None;
    }
    let selected = program.types.selected_calls.get(&collection.node)?;
    let predicate_node = collection.predicate.as_ref()?.node;
    let mut actual_calls = guards.iter().filter_map(|guard| {
        let IrStmt::Require { cond, .. } = guard else {
            return None;
        };
        let IrExpr::Unary {
            op: IrUnOp::Not,
            operand,
        } = &cond.expr
        else {
            return None;
        };
        same_span(collection.node, operand.span).then_some(operand.as_ref())
    });
    let call = actual_calls.next()?;
    if actual_calls.next().is_some() {
        return None;
    }
    let (target, args, slots) = match &call.expr {
        IrExpr::Call { target, args } => (target, args, None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args, Some(slots.as_slice())),
        _ => return None,
    };
    let [domain, predicate] = args.as_slice() else {
        return None;
    };
    let IrExpr::Query(query) = &domain.expr else {
        return None;
    };
    let IrExpr::Lambda { param, body } = &predicate.expr else {
        return None;
    };
    Some((
        collection, selected, call, predicate_node, target, args, slots,
        domain, predicate, query, param, body,
    ))
}

fn resolve_bool_model<'i, 'g>(
    program: &CheckedProgram,
    ir: &'i IrProgram,
    q: &'g DisclosureQuery,
    query: &'g super::ir::IrQuery,
) -> Option<(
    &'g crate::analysis::types::CheckedQuery,
    &'g String,
    NodeKey,
    &'i IrItem,
    &'i IrItem,
    SymbolId,
    SymbolId,
    NodeKey,
    &'i IrItem,
    &'g crate::analysis::scenario_disclosure::DisclosureDependency,
    ResolvedType,
)> {
    let checked = query.source.as_deref()?;
    let [alias] = checked.clauses.as_slice() else {
        return None;
    };
    let crate::analysis::types::CheckedQueryClauseKind::As { name: alias_name } = &alias.kind
    else {
        return None;
    };
    let model = nominal(program, ir, q.model)?;
    let [(parent_node, parameter_id)] = q.inputs.as_slice() else {
        return None;
    };
    let parameter = nominal(program, ir, *parameter_id)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol: parent_id,
                stored: true,
            }),
        default: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let parent = nominal(program, ir, *parent_id)?;
    let [dependency] = q.dependencies.as_slice() else {
        return None;
    };
    let array = ResolvedType::Array {
        element: Box::new(ResolvedType::Record {
            symbol: q.model,
            stored: true,
        }),
        ordered: true,
        nonempty: false,
    };
    Some((
        checked, alias_name, alias.node, model, parameter, *parameter_owner,
        *parent_id, *parent_node, parent, dependency, array,
    ))
}

fn single_bool_identity_mismatch(
    q: &DisclosureQuery,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    collection: &crate::analysis::types::CheckedCollectionCall,
    selected: &crate::analysis::types::SelectedCall,
    predicate_node: NodeKey,
    target: &super::ir::IrCallTarget,
    slots: Option<&[Option<usize>]>,
    call_ty: &ResolvedType,
    boolean: &ResolvedType,
) -> bool {
    use super::ir::IrCallTarget;
    use crate::analysis::types::SelectedCallTarget;
    q.id.is_empty()
        || q.source != source.source
        || q.alias != Some(collection.alias)
        || q.predicate != Some(predicate_node)
        || collection.overload != 0
        || collection.model != q.model
        || !matches!(&selected.target,SelectedCallTarget::Builtin {id,overload:0} if id == "any")
        || selected.arguments.len() != 2
        || selected.arguments[0] != q.node
        || selected.arguments[1] != predicate_node
        || selected.slots.as_slice() != [Some(0), Some(1)]
        || !matches!(target,IrCallTarget::Builtin {id,awaited:false} if id == "any")
        || slots.is_some_and(|slots| slots != [Some(0), Some(1)])
        || call_ty != boolean
}

fn single_bool_shape_mismatch(
    predicate: &TypedExpr,
    body: &TypedExpr,
    predicate_node: NodeKey,
    param: &String,
    alias_name: &String,
    alias_node: NodeKey,
    collection_alias: NodeKey,
    boolean: &ResolvedType,
) -> bool {
    predicate.ty != *boolean
        || body.ty != *boolean
        || !same_span(predicate_node, body.span)
        || param != alias_name
        || alias_node != collection_alias
        || !matches!(&body.expr,IrExpr::Member {base,field} if field == "unfinished" && matches!(&base.expr,IrExpr::Name(name) if name == param))
}

fn single_bool_checked_mismatch(
    program: &CheckedProgram,
    q: &DisclosureQuery,
    query: &super::ir::IrQuery,
    checked: &crate::analysis::types::CheckedQuery,
    array: &ResolvedType,
    domain: &TypedExpr,
    collection: &crate::analysis::types::CheckedCollectionCall,
) -> bool {
    checked.node != q.node
        || checked.domain != q.domain
        || program.types.checked_queries.get(&q.node) != Some(checked)
        || checked.domain_type != *array
        || checked.result != *array
        || domain.ty != *array
        || query.collection_call.as_deref() != Some(collection)
        || query.contract_collection_call.is_some()
}

fn single_bool_flags_mismatch(
    q: &DisclosureQuery,
    query: &super::ir::IrQuery,
) -> bool {
    query.where_pred.is_some()
        || query.where_async
        || query.select.is_some()
        || query.select_param.is_some()
        || query.value_order.is_some()
        || !query.order.is_empty()
        || query.limit.is_some()
        || query.archived.is_some()
        || q.limit.is_some()
        || q.archived
        || !q.order.is_empty()
        || q.cardinality_guard.is_some()
}

fn single_bool_model_mismatch(
    owner: &IrItem,
    model: &IrItem,
    parameter_owner: SymbolId,
    parent_id: SymbolId,
    parameter: &IrItem,
    parent_node: NodeKey,
    query: &super::ir::IrQuery,
) -> bool {
    parameter_owner != owner.id
        || !matches!(&model.kind,IrItemKind::Model {owner: IrOwner::ChildOf(id),..} if *id == parent_id)
        || !matches!(&query.domain,IrQueryDomain::Model(name) if name == &model.canonical)
        || query.parent.as_ref().is_none_or(|value| {
            !same_span(parent_node, value.span)
                || !matches!(&value.expr,IrExpr::Name(name) if name == &parameter.name)
        })
}

fn single_bool_dependency_mismatch(
    program: &CheckedProgram,
    ir: &IrProgram,
    dependency: &crate::analysis::scenario_disclosure::DisclosureDependency,
    model: &IrItem,
    q: &DisclosureQuery,
    predicate_node: NodeKey,
    boolean: &ResolvedType,
) -> Option<bool> {
    use crate::analysis::scenario_disclosure::DependencyRole;
    Some(dependency.id.is_empty()
        || dependency.role != DependencyRole::Control
        || dependency.field_name != "unfinished"
        || dependency.model != model.id
        || dependency.model_name != model.canonical
        || dependency.node != predicate_node
        || dependency.ty != *boolean
        || dependency.type_id != "bool"
        || dependency.source != q.source
        || !dependency.calls.is_empty()
        || dependency.query_id.is_some()
        || field_type(program, ir, dependency.field, model.id)? != boolean)
}

fn match_single_bool_query(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    guards: &[IrStmt],
    q: &DisclosureQuery,
    boolean: &ResolvedType,
    metadata: &mut Vec<serde_json::Value>,
) -> Option<()> {
    use super::ir::IrOwner;
    let (collection, selected, call, predicate_node, target, _args, slots,
        domain, predicate, query, param, body) =
        resolve_bool_call(program, guards, q)?;
    let (checked, alias_name, alias_node, model, parameter, parameter_owner,
        parent_id, parent_node, parent, dependency, array) =
        resolve_bool_model(program, ir, q, query)?;
    if single_bool_identity_mismatch(
        q, source, collection, selected, predicate_node, target, slots, &call.ty, boolean,
    ) || single_bool_shape_mismatch(
        predicate, body, predicate_node, param, alias_name, alias_node, collection.alias, boolean,
    ) || single_bool_checked_mismatch(program, q, query, checked, &array, domain, collection)
        || single_bool_flags_mismatch(q, query)
        || single_bool_model_mismatch(owner, model, parameter_owner, parent_id, parameter, parent_node, query)
        || single_bool_dependency_mismatch(program, ir, dependency, model, q, predicate_node, boolean)?
    {
        return None;
    }
    for id in [model.id, parent.id] {
        let schema = source
            .stored_contracts
            .as_deref()?
            .iter()
            .find(|schema| schema.id == id && schema.model)?;
        super::scenario_receipts::match_stored_contract_schema(ir, schema, db)?;
        for field in &schema.fields {
            super::scenario_receipts::match_stored_contract_field(ir, field, db)?;
        }
    }
    metadata.push(serde_json::json!({"queryId":q.id,"dependencyId":dependency.id}));
    Some(())
}

fn serialize_query_any_prepared(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
    prepared: Option<&PreparedQuerySources<'_>>,
) -> Option<serde_json::Value> {
    use crate::analysis::Scalar;
    any_query_gate(program, owner)?;
    let (source, fresh) =
        prepare_any_fresh(program, ir, owner, db, catalog, entry_module, prepared)?;
    if let Some(metadata) = native_any_metadata(
        program, ir, owner, db, catalog, entry_module, source, &fresh, prepared,
    )? {
        return Some(metadata);
    }
    let IrItemKind::Scenario {
        guards,
        read: false,
        trusted: false,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    // Direct leading `require not any(...)` composition metadata: the
    // predicate profile with its exact LeadingRequire source-call
    // association. The defining matcher re-proves guard/call/domain
    // correspondence per query here; indices address the same filtered
    // decision sites the runtime consumes.
    let (composed_metadata, composed_ids) =
        collect_composed_metadata(program, ir, owner, db, entry_module, source, guards)?;
    let boolean = ResolvedType::Scalar(Scalar::Bool);
    let mut metadata = Vec::new();
    for q in source
        .queries
        .as_deref()?
        .iter()
        .filter(|q| q.first.is_none() && q.count.is_none() && q.projection.is_none())
    {
        // Composition queries already carry predicate metadata above;
        // the single-bool loop below cannot express their shape.
        if composed_ids.iter().any(|id| id == &q.id) {
            continue;
        }
        match_single_bool_query(program, ir, owner, db, source, guards, q, &boolean, &mut metadata)?;
    }
    metadata.extend(composed_metadata);
    (!metadata.is_empty()).then_some(serde_json::Value::Array(metadata))
}

/// Whole checked query closure for the released public-read/private-child
/// dispatch. Only this immutable source/fresh executable producer can prepare
/// the nominal query receipt; a source inventory alone remains nongrant.
pub fn serialize_complete_query_receipt(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<serde_json::Value> {
    serde_json::to_value(
        collect_complete_query_receipt(program, ir, owner, db, catalog, entry_module)?.plan,
    )
    .ok()
}

pub(super) fn collect_complete_query_receipt(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<NativeScenarioReceipt> {
    let prepared = PreparedQuerySources::standalone(program, ir, db, catalog)?;
    let plan = prepared.plan(owner, entry_module)?;
    collect_complete_query_receipt_prepared(program, ir, owner, &prepared, plan)
}

fn complete_expected_influences(
    mixed_plan: &Option<ReceiptDisclosurePlan>,
    helper_plan: &Option<ReceiptDisclosurePlan>,
    queries: &[DisclosureQuery],
    query: &DisclosureQuery,
) -> Option<(
    Vec<DisclosureInfluence>,
    bool,
)> {
    let expected = if mixed_plan.is_some() {
        Vec::new()
    } else if helper_plan.is_some() {
        query.influences.clone()
    } else {
        super::scenario_receipts::checked_native_query_influences(queries)?
    };
    Some((expected, mixed_plan.is_some()))
}

fn match_complete_returned(
    ir: &IrProgram,
    owner: &IrItem,
    original: &ScenarioDisclosure,
    standalone_first: bool,
    void_tail: bool,
    mixed: bool,
    expected_influences: &[DisclosureInfluence],
    returned: &DisclosureReturn,
    emitted: &ReceiptReturn,
) -> Option<()> {
    let target_pair = original.source_facts()?.queries.as_deref().is_some_and(|queries|
        super::scenario_receipts::checked_any_first_target_return_order(
            queries, expected_influences, &returned.influences)
            || super::scenario_receipts::checked_assign_count_first_target_return_order(
                queries, expected_influences, &returned.influences));
    if !standalone_first
        && !void_tail
        && super::scenario_receipts::checked_created_model_result(ir, owner).is_none()
        || returned.id != emitted.id
        || returned.source != original.source_facts()?.source
        || !standalone_first && !void_tail && returned.model_result.is_none()
        || !mixed && !standalone_first && !target_pair && returned.influences != expected_influences
        || standalone_first
            && returned
                .influences
                .iter()
                .any(|value| !expected_influences.contains(value))
        || emitted.projection.is_some()
    {
        return None;
    }
    Some(())
}

fn build_native_returns(
    selected_returns: &[&DisclosureReturn],
) -> Vec<NativeReturn> {
    selected_returns
        .iter()
        .map(|returned| NativeReturn {
            id: returned.id.clone(),
            span: Span::new(returned.node.file, returned.node.start, returned.node.end),
            decisions: Vec::new(),
            implicit: false,
            reference_result: None,
        })
        .collect()
}

fn verify_complete_disclosure(
    disclosure: &ScenarioDisclosure,
    ir: &IrProgram,
    owner: &IrItem,
    original: &ScenarioDisclosure,
    original_checked: &CheckedScenarioDisclosure,
    plan: &ReceiptDisclosurePlan,
    selected_returns: &[&DisclosureReturn],
    standalone_first: bool,
    mixed: bool,
    expected_influences: &[DisclosureInfluence],
) -> Option<Vec<NativeReturn>> {
    let ScenarioDisclosure::Complete(checked) = disclosure
    else {
        return None;
    };
    if checked.scenario != owner.id
        || checked.node != original.source_facts()?.node
        || checked.source != original.source_facts()?.source
        || !super::scenario_feasibility::same_disclosure(original_checked, checked)
        || checked.returns.is_empty()
        || selected_returns.len() != plan.returns.len()
    {
        return None;
    }
    let void_tail = !standalone_first
        && !mixed
        && super::scenario_receipts::checked_void_effect_tail(owner, original_checked);
    for (returned, emitted) in selected_returns.iter().zip(&plan.returns) {
        match_complete_returned(
            ir,
            owner,
            original,
            standalone_first,
            void_tail,
            mixed,
            expected_influences,
            returned,
            emitted,
        )?;
    }
    Some(build_native_returns(selected_returns))
}

fn complete_helper_receipt(
    prepared: &PreparedQuerySources<'_>,
    ir: &IrProgram,
    owner: &IrItem,
    plan: ReceiptDisclosurePlan,
    original: &ScenarioDisclosure,
    queries: &[DisclosureQuery],
    query: &DisclosureQuery,
    helper_plan: Option<ReceiptDisclosurePlan>,
    mixed_plan: Option<ReceiptDisclosurePlan>,
    standalone_first: bool,
) -> Option<NativeScenarioReceipt> {
    let (expected_influences, mixed) =
        complete_expected_influences(&mixed_plan, &helper_plan, queries, query)?;
    if let Some(mut expected) = mixed_plan {
        let selected = prepared.returns.as_ref()?.returns(ir, owner.id)?;
        super::scenario_receipts::project_plan_returns(&mut expected, &selected)?;
        if serde_json::to_value(&plan).ok()? != serde_json::to_value(expected).ok()? {
            return None;
        }
    }
    prepared.checked_owner(owner)?;
    let fresh = prepared.fresh.as_ref();
    let selected_returns = prepared.returns.as_ref()?.returns(ir, owner.id)?;
    let ScenarioDisclosure::Complete(original_checked) = original else {
        return None;
    };
    let mut native_returns = Vec::new();
    for disclosure in [
        original,
        fresh.scenario_disclosures.get(&owner.id)?,
        ir.scenario_disclosures.get(&owner.id)?,
    ] {
        let built = verify_complete_disclosure(
            disclosure,
            ir,
            owner,
            original,
            original_checked,
            &plan,
            &selected_returns,
            standalone_first,
            mixed,
            &expected_influences,
        )?;
        if native_returns.is_empty() {
            native_returns = built;
        }
    }
    Some(NativeScenarioReceipt {
        plan,
        current_revision: None,
        dependencies: Default::default(),
        intrinsics: Default::default(),
        decisions: Default::default(),
        decision_keys: Default::default(),
        calls: Default::default(),
        returns: native_returns,
    })
}

fn verify_single_disclosure(
    disclosure: &ScenarioDisclosure,
    owner: &IrItem,
    original: &ScenarioDisclosure,
    query: &DisclosureQuery,
) -> Option<()> {
    let ScenarioDisclosure::Complete(checked) = disclosure else {
        return None;
    };
    let [returned] = checked.returns.as_slice() else {
        return None;
    };
    if checked.scenario != owner.id
        || checked.node != original.source_facts()?.node
        || checked.source != original.source_facts()?.source
        || !checked.effects.is_empty()
        || returned.id != query.return_id()
        || returned.node != query.return_node
        || returned.source != query.source
        || !returned.decisions.is_empty()
        || !returned.dependencies.is_empty()
        || !returned.intrinsics.is_empty()
        || returned.influences != query.influences
    {
        return None;
    }
    Some(())
}

fn complete_single_receipt(
    prepared: &PreparedQuerySources<'_>,
    ir: &IrProgram,
    owner: &IrItem,
    plan: ReceiptDisclosurePlan,
    original: &ScenarioDisclosure,
    queries: &[DisclosureQuery],
) -> Option<NativeScenarioReceipt> {
    let [query] = queries else {
        return None;
    };
    prepared.checked_owner(owner)?;
    let fresh = prepared.fresh.as_ref();
    for disclosure in [
        original,
        fresh.scenario_disclosures.get(&owner.id)?,
        ir.scenario_disclosures.get(&owner.id)?,
    ] {
        verify_single_disclosure(disclosure, owner, original, query)?;
    }
    Some(NativeScenarioReceipt {
        plan,
        current_revision: None,
        dependencies: Default::default(),
        intrinsics: Default::default(),
        decisions: Default::default(),
        decision_keys: Default::default(),
        calls: Default::default(),
        returns: vec![NativeReturn {
            id: query.return_id(),
            span: Span::new(
                query.return_node.file,
                query.return_node.start,
                query.return_node.end,
            ),
            decisions: Vec::new(),
            implicit: false,
            reference_result: None,
        }],
    })
}

fn collect_complete_query_receipt_prepared(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    prepared: &PreparedQuerySources<'_>,
    plan: ReceiptDisclosurePlan,
) -> Option<NativeScenarioReceipt> {
    if ir
        .scenario_disclosures
        .get(&owner.id)?
        .source_facts()?
        .transcripts
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return None;
    }
    // Reuse the full owning source/type/executable correspondence, not a
    // caller-supplied JSON plan or an IR-only Complete tag.
    let original = program.scenario_disclosures().get(&owner.id)?;
    let queries = original.source_facts()?.queries.as_ref()?;
    let query = queries.first()?;
    let helper_plan = super::scenario_receipts::checked_native_helper_any_query_plan(
        ir,
        owner,
        prepared.db,
        &plan.source.module,
    );
    let mixed_plan = super::scenario_receipts::checked_native_mixed_helper_query_plan(
        ir,
        owner,
        prepared.db,
        &plan.source.module,
    );
    let standalone_first = queries.len() == 1 && query.first.is_some() && query.count.is_none();
    if helper_plan.is_some()
        || queries
            .iter()
            .any(|query| query.first.is_some() || query.count.is_some())
    {
        return complete_helper_receipt(
            prepared,
            ir,
            owner,
            plan,
            original,
            queries,
            query,
            helper_plan,
            mixed_plan,
            standalone_first,
        );
    }
    complete_single_receipt(prepared, ir, owner, plan, original, queries)
}

fn checked_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    PreparedQuerySources::standalone(program, ir, db, catalog)?
        .plan_with_context(owner, entry_module, source_context)
}

fn check_full_transcript_influences(
    source: &CheckedScenarioSource,
    queries: &[DisclosureQuery],
) -> Option<()> {
    if !queries.is_empty()
        && super::scenario_receipts::checked_scenario_query_influences(source)?.len() != 24
    {
        return None;
    }
    Some(())
}

fn mixed_helper_plan(
    prepared: &PreparedQuerySources<'_>,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry_module: &str,
) -> Option<ReceiptDisclosurePlan> {
    let plan = super::scenario_receipts::checked_native_mixed_helper_query_plan(
        ir,
        owner,
        db,
        entry_module,
    )?;
    prepared.decisions(owner)?;
    super::scenario_receipts::checked_require_consumptions(
        ir,
        owner,
        db,
        prepared.returns.as_ref()?,
    )?;
    Some(plan)
}

fn any_helper_plan(
    prepared: &PreparedQuerySources<'_>,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry_module: &str,
) -> Option<ReceiptDisclosurePlan> {
    let plan =
        super::scenario_receipts::checked_native_helper_any_query_plan(ir, owner, db, entry_module)?;
    prepared.decisions(owner)?;
    Some(plan)
}

fn plan_single_query(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    query: &DisclosureQuery,
    db: &SourceDb,
    entry_module: &str,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    if query.first.is_some() {
        checked_first_query_plan(program, ir, owner, query, db, entry_module)
    } else if query.count.is_some() {
        checked_count_query_plan(
            program,
            ir,
            owner,
            query,
            db,
            entry_module,
            source_context,
        )
    } else {
        super::scenario_receipts::checked_native_any_direct_query_plan(
            ir,
            owner,
            query,
            db,
            entry_module,
        )
    }
}

fn combine_query_plans(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    queries: &[DisclosureQuery],
    db: &SourceDb,
    entry_module: &str,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    super::scenario_receipts::checked_native_query_influences(queries)?;
    let mut plans = queries
        .iter()
        .map(|query| plan_single_query(program, ir, owner, query, db, entry_module, source_context));
    let mut combined = plans.next()??;
    for next in plans {
        combined = super::scenario_receipts::merge_native_query_plans(combined, next?)?;
    }
    Some(combined)
}

fn split_direct_effects(effects: &[IrStmt]) -> Option<(&TypedExpr, &Span, &TypedExpr, &Span)> {
    let [
        IrStmt::Let { value: scan, .. },
        IrStmt::Require { span: guard, .. },
        IrStmt::Return {
            value: Some(selected),
            span: returned,
        },
    ] = effects
    else {
        return None;
    };
    Some((scan, guard, selected, returned))
}

fn split_direct_queries<'e>(scan: &'e TypedExpr, selected: &'e TypedExpr) -> Option<(&'e IrQuery, &'e IrQuery)> {
    let (IrExpr::Query(scan), IrExpr::Query(select)) = (&scan.expr, &selected.expr) else {
        return None;
    };
    Some((scan, select))
}

fn check_direct_query_identity(
    program: &CheckedProgram,
    q: &DisclosureQuery,
    source: &CheckedScenarioSource,
    source_projection: &DisclosureQueryProjection,
    scan_fact: &CheckedQuery,
    select_fact: &CheckedQuery,
    guard: &Span,
    returned: &Span,
) -> Option<()> {
    if q.first.is_some()
        || q.id.is_empty()
        || q.source != source.source
        || source_projection.source != source.source
        || q.node != scan_fact.node
        || q.domain != scan_fact.domain
        || program.types.checked_queries.get(&q.node) != Some(scan_fact)
        || source_projection.node != select_fact.node
        || program.types.checked_queries.get(&source_projection.node) != Some(select_fact)
        || !same_span(q.cardinality_guard?, *guard)
        || !same_span(q.return_node, *returned)
        || q.model != source_projection.model
        || q.limit.is_some()
        || q.archived
        || !q.order.is_empty()
    {
        return None;
    }
    Some(())
}

fn check_direct_scan_shape(scan: &IrQuery) -> Option<()> {
    if scan.value_order.is_some()
        || !scan.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.parent.is_some()
        || scan.select.is_some()
        || scan.where_async
        || scan.collection_call.is_some()
        || scan.contract_collection_call.is_some()
    {
        return None;
    }
    Some(())
}

fn check_direct_select_shape(select: &IrQuery) -> Option<()> {
    if select.parent.is_some()
        || select.where_pred.is_some()
        || select.where_async
        || select.value_order.is_some()
        || !select.order.is_empty()
        || select.limit.is_some()
        || select.archived.is_some()
        || select.collection_call.is_some()
        || select.contract_collection_call.is_some()
    {
        return None;
    }
    Some(())
}

fn resolve_direct_model<'a>(
    program: &CheckedProgram,
    ir: &'a IrProgram,
    q: &DisclosureQuery,
    scan: &IrQuery,
    select: &IrQuery,
) -> Option<&'a IrItem> {
    let model = nominal(program, ir, q.model)?;
    let (
        SymbolKind::Model {
            fields: declared_model,
            ..
        },
        IrItemKind::Model {
            fields: live_model, ..
        },
    ) = (&program.symbols.get(q.model.0 as usize)?.kind, &model.kind)
    else {
        return None;
    };
    if declared_model != live_model
        || q.model_name != model.canonical
        || !matches!(&scan.domain, IrQueryDomain::Model(name) if name == &model.canonical)
        || !matches!(&select.domain, IrQueryDomain::Value { .. })
    {
        return None;
    }
    for field in declared_model {
        field_type(program, ir, *field, q.model)?;
    }
    Some(model)
}

fn check_direct_projection(
    projection: &CheckedQueryProjection,
    source_projection: &DisclosureQueryProjection,
    q: &DisclosureQuery,
) -> Option<()> {
    if projection.contract != source_projection.contract
        || projection.model != q.model
        || projection.alias != source_projection.alias
        || projection.fields != source_projection.fields
    {
        return None;
    }
    Some(())
}

fn resolve_direct_contract<'a>(
    program: &'a CheckedProgram,
    ir: &IrProgram,
    projection: &CheckedQueryProjection,
) -> Option<&'a Vec<SymbolId>> {
    let contract = nominal(program, ir, projection.contract)?;
    let (SymbolKind::Contract { fields: declared }, IrItemKind::Contract { fields: live, .. }) = (
        &program.symbols.get(projection.contract.0 as usize)?.kind,
        &contract.kind,
    ) else {
        return None;
    };
    if declared != live || declared.len() != projection.fields.len() {
        return None;
    }
    Some(declared)
}

fn project_mapped_field(
    program: &CheckedProgram,
    ir: &IrProgram,
    q: &DisclosureQuery,
    declared: &[SymbolId],
    mapped: &CheckedQueryProjectionField,
    contract: SymbolId,
    mappings: &mut HashSet<String>,
) -> Option<ReceiptQueryProjectionField> {
    let id = mapped.field;
    let field = nominal(program, ir, id)?;
    if !declared.contains(&id)
        || field_type(program, ir, id, contract)? != &mapped.ty
        || !mappings.insert(field.name.clone())
    {
        return None;
    }
    let (kind, input_field) = match mapped.mapping {
        CheckedQueryProjectionMapping::StoredReference => {
            if !matches!(mapped.ty, ResolvedType::Record { symbol, .. } if symbol == q.model) {
                return None;
            }
            ("reference", None)
        }
        CheckedQueryProjectionMapping::Version => {
            if mapped.ty != ResolvedType::Scalar(crate::analysis::Scalar::Int) {
                return None;
            }
            ("version", None)
        }
        CheckedQueryProjectionMapping::DirectField { field: input } => {
            let actual = nominal(program, ir, input)?;
            if field_type(program, ir, input, q.model)? != &mapped.ty
                || !q
                    .dependencies
                    .iter()
                    .any(|dep| dep.role == DependencyRole::Data && dep.field == input)
            {
                return None;
            }
            ("field", Some(actual.name.clone()))
        }
    };
    Some(ReceiptQueryProjectionField {
        name: field.name.clone(),
        kind: kind.into(),
        field: input_field,
    })
}

fn assemble_direct_dependency(
    program: &CheckedProgram,
    ir: &IrProgram,
    q: &DisclosureQuery,
    model: &IrItem,
    dep: &DisclosureDependency,
    entry: &str,
) -> Option<ReceiptQueryDependency> {
    let field = nominal(program, ir, dep.field)?;
    if dep.source != q.source
        || dep.model != q.model
        || dep.model_name != model.canonical
        || dep.field_name != field.name
        || !dep.calls.is_empty()
        || field_type(program, ir, dep.field, q.model)? != &dep.ty
        || serial_type(&dep.ty, program, ir, 0)? != dep.type_id
    {
        return None;
    }
    let role = match dep.role {
        DependencyRole::Data => ReceiptRole::Data,
        DependencyRole::Control => ReceiptRole::Control,
    };
    Some(ReceiptQueryDependency {
        id: dep.id.clone(),
        source: origin(&dep.source, entry),
        role,
        field: field.name.clone(),
        type_id: dep.type_id.clone(),
    })
}

fn push_direct_influence(
    influence: &DisclosureInfluence,
    q: &DisclosureQuery,
    kinds: &mut HashSet<&'static str>,
    influences: &mut Vec<ReceiptInfluence>,
) -> Option<()> {
    if influence.id.is_empty()
        || influence.query_id.as_deref() != Some(q.id.as_str())
        || influence.source != q.source
    {
        return None;
    }
    let kind = match influence.kind {
        InfluenceKind::QueryExistence => "query-existence",
        InfluenceKind::QueryCardinality => "query-cardinality",
        InfluenceKind::QueryMembership => "query-membership",
        InfluenceKind::QueryOrder => "query-order",
        InfluenceKind::AbsentReference => return None,
    };
    if !kinds.insert(kind) {
        return None;
    }
    influences.push(ReceiptInfluence {
        id: influence.id.clone(),
        kind: kind.into(),
        query_id: Some(q.id.clone()),
    });
    Some(())
}

fn plan_direct_query(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    source: &CheckedScenarioSource,
    queries: &[DisclosureQuery],
    entry_module: &str,
) -> Option<ReceiptDisclosurePlan> {
    if queries.len() != 1 {
        return None;
    }
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let (scan_expr, guard, selected_expr, returned) = split_direct_effects(effects)?;
    let (scan, select) = split_direct_queries(scan_expr, selected_expr)?;
    let q = &queries[0];
    let source_projection = q.projection.as_ref()?;
    let scan_fact = scan.source.as_deref()?;
    let select_fact = select.source.as_deref()?;
    check_direct_query_identity(
        program,
        q,
        source,
        source_projection,
        scan_fact,
        select_fact,
        guard,
        returned,
    )?;
    check_direct_scan_shape(scan)?;
    check_direct_select_shape(select)?;
    let model = resolve_direct_model(program, ir, q, scan, select)?;
    let projection = select_fact.projection.as_deref()?;
    check_direct_projection(projection, source_projection, q)?;
    let declared = resolve_direct_contract(program, ir, projection)?;
    let mut fields = Vec::new();
    let mut mappings = HashSet::new();
    for mapped in &projection.fields {
        fields.push(project_mapped_field(
            program,
            ir,
            q,
            declared,
            mapped,
            projection.contract,
            &mut mappings,
        )?);
    }
    let dependencies = assemble_direct_dependencies(program, ir, q, model, entry_module)?;
    let influences = assemble_direct_influences(q)?;
    Some(ReceiptDisclosurePlan {
        version: 1, event_decision: None, term_decision: None, leave_request_decision: None, leave_decide_decision: None, refer_reject_decision: None, member_retry_decision: None, invoice_overdue_decision: None, rent_movement_refund_decision: None,
        invoice_collect_decision: None, rent_notice_decision: None,source: origin(&source.source, entry_module),
        queries: vec![ReceiptQuery {
            id: q.id.clone(),
            source: origin(&q.source, entry_module),
            model: model.canonical.clone(),
            parent: None,
            order: Vec::new(),
            limit: None,
            archived: "exclude".into(),
            dependencies,
        }],
        returns: vec![ReceiptReturn {
            id: q.return_id(),
            // Candidate slots belong to the query observation inventory, not
            // ordinary scalar observations. Leading authorization is still
            // unqualified; this source transport grants no scenario admission.
            source: origin(&source.source, entry_module),
            influences,
            dependencies: Vec::new(),
            intrinsics: Vec::new(),
            projection: Some(ReceiptQueryProjection {
                kind: "query-contract-array".into(),
                query_id: q.id.clone(),
                source: origin(&source_projection.source, entry_module),
                fields,
            }),
        }],
    })
}

fn load_full_inputs<'p, 'i>(
    program: &'p CheckedProgram,
    ir: &'i IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<(
    &'i CheckedScenarioSource,
    &'p CheckedScenarioSource,
    &'i Vec<DisclosureQuery>,
)> {
    program.validate_cohort(db, catalog).ok()?;
    if entry_module.is_empty() {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let original = program
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    let queries = source.queries.as_ref()?;
    if source.node != original.node
        || source.source != original.source
        || source.queries != original.queries
        || source.transcripts != original.transcripts
    {
        return None;
    }
    Some((source, original, queries))
}

fn assemble_direct_dependencies(
    program: &CheckedProgram,
    ir: &IrProgram,
    q: &DisclosureQuery,
    model: &IrItem,
    entry_module: &str,
) -> Option<Vec<ReceiptQueryDependency>> {
    let mut dependency_ids = HashSet::new();
    let mut dependencies = Vec::new();
    if q.dependencies.is_empty() || q.dependencies.len() > 200 {
        return None;
    }
    for dep in &q.dependencies {
        if dep.id.is_empty() || !dependency_ids.insert(&dep.id) {
            return None;
        }
        dependencies.push(assemble_direct_dependency(
            program,
            ir,
            q,
            model,
            dep,
            entry_module,
        )?);
    }
    Some(dependencies)
}

fn assemble_direct_influences(q: &DisclosureQuery) -> Option<Vec<ReceiptInfluence>> {
    let mut influence_ids = HashSet::new();
    let mut kinds = HashSet::new();
    let mut influences = Vec::new();
    for influence in &q.influences {
        if influence.id.is_empty() || !influence_ids.insert(&influence.id) {
            return None;
        }
        push_direct_influence(influence, q, &mut kinds, &mut influences)?;
    }
    if kinds.len() != 4 {
        return None;
    }
    Some(influences)
}

fn checked_query_plan_full(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
    prepared: &PreparedQuerySources<'_>,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    let (source, _original, queries) =
        load_full_inputs(program, ir, owner, db, catalog, entry_module)?;
    if source
        .transcripts
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        check_full_transcript_influences(source, queries)?;
        return checked_transcript_query_plan(
            program,
            ir,
            owner,
            db,
            entry_module,
            prepared,
            source_context,
        );
    }
    if source
        .inline_selections
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return checked_inline_selection_query_plan(program, ir, owner, db, entry_module, prepared);
    }
    if queries.is_empty() || queries.len() > 3 {
        return None;
    }
    // Build from the immutable checked owner rather than accepting a second
    // mutable IR proof. Unrelated emission diagnostics cannot grant this plan;
    // every executable owner expression must still join the original lowering.
    let fresh = prepared.fresh.as_ref();
    same_scenario_semantics(program, ir, fresh, owner)?;
    // Public callers may pass a detached owner. Its valid body cannot cover
    // a different executable scenario stored in the supplied IR.
    same_scenario_semantics(program, ir, fresh, ir.items.get(owner.id.0 as usize)?)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if let Some(plan) = mixed_helper_plan(prepared, ir, owner, db, entry_module) {
        return Some(plan);
    }
    if let Some(plan) = any_helper_plan(prepared, ir, owner, db, entry_module) {
        return Some(plan);
    }
    if queries
        .iter()
        .any(|query| query.first.is_some() || query.count.is_some())
    {
        return combine_query_plans(
            program,
            ir,
            owner,
            queries,
            db,
            entry_module,
            source_context,
        );
    }
    plan_direct_query(program, ir, owner, source, queries, entry_module)
}

/// The two original eager transcript invocations have separate query and
/// DATA identities even though they evaluate the same declared helper body.
/// This transports source correspondence only; the native receiver is separate.
/// The one original inline WHERE-bound TextMessage query uses existing State
/// query/selection transport; it never invents a local Contract or helper call.
fn check_inline_identity(
    program: &CheckedProgram,
    owner: &IrItem,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    query: &DisclosureQuery,
) -> Option<()> {
    let original_source = program
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    if source.inline_selections != original_source.inline_selections
        || query != &fact.query
        || !source.transcripts.as_deref()?.is_empty()
        || fact.query.influences.len() != 4
        || fact.query.first.is_some()
        || fact.query.count.is_some()
        || fact.query.projection.is_some()
    {
        return None;
    }
    Some(())
}

fn check_inline_parent(
    parent: &IrItem,
    model: &IrItem,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    query: &DisclosureQuery,
) -> Option<()> {
    if !matches!(&model.kind,IrItemKind::Model{owner:super::ir::IrOwner::ChildOf(id),..} if *id==parent.id)
        || fact.parent.child != fact.parent_dependency.model
        || fact.parent_dependency.field_name != "parent"
        || fact.parent_dependency.type_id != parent.canonical
        || fact.parent_dependency.query_id.is_some()
        || fact.parent_dependency.role != DependencyRole::Data
        || fact.parent_dependency.node != fact.parent.node
        || fact.query.source != source.source
        || fact.dependencies.len() != 3
        || fact.fields.len() != 3
        || fact.bound_dependency.role != DependencyRole::Control
        || fact.bound_dependency.query_id.as_deref() != Some(query.id.as_str())
        || fact.bound_dependency.node != fact.bound_node
        || fact.bound_dependency.type_id != "int"
    {
        return None;
    }
    Some(())
}

fn check_inline_dependencies(
    program: &CheckedProgram,
    ir: &IrProgram,
    query: &DisclosureQuery,
) -> Option<()> {
    let mut ids = HashSet::new();
    for read in &query.dependencies {
        if read.id.is_empty()
            || !ids.insert(read.id.as_str())
            || read.model != query.model
            || read.source != query.source
        {
            return None;
        }
        if field_type(program, ir, read.field, query.model)? != &read.ty {
            return None;
        }
    }
    Some(())
}

fn assemble_inline_query(
    entry: &str,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    query: &DisclosureQuery,
    model: &IrItem,
    parent: &IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
) -> Option<ReceiptQuery> {
    let source_origin = origin(&source.source, entry);
    Some(ReceiptQuery {
        id: query.id.clone(),
        source: source_origin.clone(),
        model: model.canonical.clone(),
        parent: Some(ReceiptQueryParent {
            source: source_origin.clone(),
            model: parent.canonical.clone(),
            origin: ReceiptQueryParentOrigin::StoredReference {
                dependency_id: fact.parent_dependency.id.clone(),
            },
        }),
        order: query
            .order
            .iter()
            .map(|order| ReceiptQueryOrder {
                field: order.field_name.clone(),
                direction: if order.descending { "desc" } else { "asc" }.into(),
            })
            .collect(),
        limit: None,
        archived: "exclude".into(),
        dependencies: fact
            .query
            .dependencies
            .iter()
            .map(|read| ReceiptQueryDependency {
                id: read.id.clone(),
                source: origin(&read.source, entry),
                role: match read.role {
                    DependencyRole::Data => ReceiptRole::Data,
                    DependencyRole::Control => ReceiptRole::Control,
                },
                field: read.field_name.clone(),
                type_id: read.type_id.clone(),
            })
            .collect(),
    })
}

fn assemble_return_influences(
    returned: &DisclosureReturn,
) -> Option<Vec<ReceiptInfluence>> {
    use crate::analysis::scenario_disclosure::InfluenceKind;
    let mut influences = Vec::new();
    for influence in &returned.influences {
        let kind = match influence.kind {
            InfluenceKind::QueryExistence => "query-existence",
            InfluenceKind::QueryCardinality => "query-cardinality",
            InfluenceKind::QueryMembership => "query-membership",
            InfluenceKind::QueryOrder => "query-order",
            InfluenceKind::AbsentReference => return None,
        };
        influences.push(ReceiptInfluence {
            id: influence.id.clone(),
            query_id: influence.query_id.clone(),
            kind: kind.into(),
        });
    }
    Some(influences)
}

fn assemble_return_intrinsics(
    returned: &DisclosureReturn,
    entry: &str,
) -> Option<Vec<ReceiptIntrinsic>> {
    use crate::analysis::scenario_disclosure::{DependencyRole, DisclosureIntrinsicKind};
    returned.intrinsics.iter().map(|read|Some(ReceiptIntrinsic{id:read.id.clone(),source:origin(&read.source,entry),
        role:match read.role {DependencyRole::Data=>ReceiptRole::Data,DependencyRole::Control=>ReceiptRole::Control},type_id:read.type_id.clone(),
        kind:match &read.kind {
            DisclosureIntrinsicKind::OperationId=>NativeIntrinsicKind::OperationId,
            DisclosureIntrinsicKind::AdmittedInput{parameter_name,..}=>NativeIntrinsicKind::AdmittedInput{parameter:parameter_name.clone()},
            DisclosureIntrinsicKind::AdmittedReferenceVersion{parameter_name,model_name,..}=>NativeIntrinsicKind::AdmittedReferenceVersion{parameter:parameter_name.clone(),model:model_name.clone()},
        }})).collect::<Option<Vec<_>>>()
}

fn assemble_inline_returns(
    checked: &CheckedScenarioDisclosure,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    entry: &str,
) -> Option<Vec<ReceiptReturn>> {
    let mut returns = Vec::new();
    for returned in &checked.returns {
        if returned.influences != fact.query.influences || returned.source != source.source {
            return None;
        }
        for required in fact
            .dependencies
            .iter()
            .chain([&fact.bound_dependency, &fact.parent_dependency])
        {
            if !returned.dependencies.iter().any(|read| read == required) {
                return None;
            }
        }
        let influences = assemble_return_influences(returned)?;
        let intrinsics = assemble_return_intrinsics(returned, entry)?;
        returns.push(ReceiptReturn {
            id: returned.id.clone(),
            source: origin(&returned.source, entry),
            influences,
            dependencies: returned
                .dependencies
                .iter()
                .map(|read| ReceiptDependency {
                    id: read.id.clone(),
                    source: origin(&read.source, entry),
                    role: match read.role {
                        DependencyRole::Data => ReceiptRole::Data,
                        DependencyRole::Control => ReceiptRole::Control,
                    },
                    model: read.model_name.clone(),
                    field: read.field_name.clone(),
                    type_id: read.type_id.clone(),
                    query_id: read.query_id.clone(),
                })
                .collect(),
            intrinsics,
            projection: None,
        });
    }
    Some(returns)
}

fn check_inline_fields(
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    query: &DisclosureQuery,
) -> Option<()> {
    for ((field, read), name) in
        fact.fields
            .iter()
            .zip(&fact.dependencies)
            .zip(["role", "content", "attachments"])
    {
        if field.name != name
            || field.source_field != read.field
            || field.value_node != read.node
            || read.role != DependencyRole::Data
            || read.query_id.as_deref() != Some(query.id.as_str())
            || read.source != query.source
            || read.model != query.model
            || read.ty != field.ty
            || !query.dependencies.iter().any(|candidate| {
                candidate.role == DependencyRole::Data
                    && candidate.field == read.field
                    && candidate.ty == read.ty
                    && candidate.id != read.id
            })
        {
            return None;
        }
    }
    Some(())
}

fn checked_inline_selection_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry: &str,
    prepared: &PreparedQuerySources<'_>,
) -> Option<ReceiptDisclosurePlan> {
    prepared.decisions(owner)?;
    prepared.checked_owner(owner)?;
    let fresh = prepared.fresh.as_ref();
    same_scenario_semantics(program, ir, fresh, owner)?;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let [fact] = source.inline_selections.as_deref()? else {
        return None;
    };
    let [query] = source.queries.as_deref()? else {
        return None;
    };
    check_inline_identity(program, owner, source, fact, query)?;
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let parent = nominal(program, ir, fact.parent.parent)?;
    let model = nominal(program, ir, query.model)?;
    check_inline_parent(parent, model, source, fact, query)?;
    check_inline_dependencies(program, ir, query)?;
    check_inline_fields(fact, query)?;
    let query = assemble_inline_query(entry, source, query, model, parent, fact)?;
    let returns = assemble_inline_returns(checked, fact, source, entry)?;
    Some(ReceiptDisclosurePlan {
        version: 1, event_decision: None, term_decision: None, leave_request_decision: None, leave_decide_decision: None, refer_reject_decision: None, member_retry_decision: None, invoice_overdue_decision: None, rent_movement_refund_decision: None,
        invoice_collect_decision: None, rent_notice_decision: None,source: origin(&source.source, entry),
        queries: vec![query],
        returns,
    })
}

fn check_transcript_pair(
    first: &CheckedTranscriptSource,
    later: &CheckedTranscriptSource,
    source: &CheckedScenarioSource,
) -> Option<()> {
    if first.id == later.id
        || first.call.file != later.call.file
        || first.call.end > later.call.start
        || first.statement.kind != crate::syntax::SyntaxKind::Require as u8
        || later.statement.kind != crate::syntax::SyntaxKind::Let as u8
        || first.derive != later.derive
        || first.declaration != later.declaration
        || first.body != later.body
        || first.query != later.query
        || first.branch != later.branch
        || first.model != later.model
        || first.parameter != later.parameter
        || first.formal != later.formal
        || first.source != source.source
        || later.source != source.source
    {
        return None;
    }
    Some(())
}

fn load_transcript_pair<'a>(
    prepared: &PreparedQuerySources<'_>,
    program: &CheckedProgram,
    ir: &'a IrProgram,
    owner: &IrItem,
    db: &SourceDb,
) -> Option<(
    &'a CheckedScenarioSource,
    &'a CheckedTranscriptSource,
    &'a CheckedTranscriptSource,
)> {
    prepared.decisions(owner)?;
    prepared.checked_owner(owner)?;
    let fresh = prepared.fresh.as_ref();
    same_scenario_semantics(program, ir, fresh, owner)?;
    same_scenario_semantics(program, ir, fresh, ir.items.get(owner.id.0 as usize)?)?;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let [first, later] = source.transcripts.as_deref()? else {
        return None;
    };
    check_transcript_pair(first, later, source)?;
    Some((source, first, later))
}

fn check_transcript_order_owner(
    fact: &CheckedTranscriptSource,
    parent: &SymbolId,
    symbol: &SymbolId,
    parameter_owner: &SymbolId,
    owner: &IrItem,
) -> Option<()> {
    if *parent != fact.branch
        || *symbol != fact.branch
        || *parameter_owner != owner.id
        || fact.slots != [Some(0)]
        || fact.dependencies.len() != 3
        || fact.query_dependencies.len() != 3
        || fact.fields.len() != 3
        || fact.influences.len() != 4
    {
        return None;
    }
    Some(())
}

fn check_transcript_order_read(
    program: &CheckedProgram,
    ir: &IrProgram,
    fact: &CheckedTranscriptSource,
    model: &IrItem,
    order: &DisclosureDependency,
) -> Option<()> {
    if order.role != DependencyRole::Control
        || order.model != fact.model
        || order.model_name != model.canonical
        || order.field != fact.order
        || order.field_name != ir.items.get(fact.order.0 as usize)?.name
        || order.ty != ResolvedType::Scalar(crate::analysis::Scalar::Int)
        || order.type_id != "int"
        || order.node != fact.order_node
        || order.calls != [fact.call]
        || order.source != fact.source
        || order.query_id.is_some()
        || field_type(program, ir, fact.order, fact.model)? != &order.ty
    {
        return None;
    }
    Some(())
}

fn check_transcript_read(
    program: &CheckedProgram,
    ir: &IrProgram,
    fact: &CheckedTranscriptSource,
    model_canonical: &str,
    field: &CheckedTranscriptField,
    read: &DisclosureDependency,
) -> Option<()> {
    if read.role != DependencyRole::Data
        || read.query_id.as_deref() != Some(fact.id.as_str())
        || read.calls != [fact.call]
        || read.source != fact.source
        || read.node != field.value_node
        || read.model != fact.model
        || read.model_name != model_canonical
        || read.field != field.source_field
        || read.field_name != ir.items.get(field.source_field.0 as usize)?.name
        || read.ty != field.ty
        || field_type(program, ir, read.field, fact.model)? != &read.ty
    {
        return None;
    }
    Some(())
}

fn check_transcript_query_read(
    query_read: &DisclosureDependency,
    read: &DisclosureDependency,
) -> Option<()> {
    if query_read.role != DependencyRole::Data
        || query_read.query_id.is_some()
        || query_read.source != read.source
        || query_read.node != read.node
        || query_read.calls != read.calls
        || query_read.model != read.model
        || query_read.model_name != read.model_name
        || query_read.field != read.field
        || query_read.field_name != read.field_name
        || query_read.ty != read.ty
        || query_read.type_id != read.type_id
    {
        return None;
    }
    Some(())
}

fn check_transcript_field(
    program: &CheckedProgram,
    ir: &IrProgram,
    fact: &CheckedTranscriptSource,
    model_canonical: &str,
    field: &CheckedTranscriptField,
    read: &DisclosureDependency,
    query_read: &DisclosureDependency,
    name: &str,
    ids: &mut HashSet<String>,
) -> Option<()> {
    if field.name != name || read.id.is_empty() || !ids.insert(read.id.clone()) {
        return None;
    }
    check_transcript_read(program, ir, fact, model_canonical, field, read)?;
    if query_read.id.is_empty() || !ids.insert(query_read.id.clone()) {
        return None;
    }
    check_transcript_query_read(query_read, read)?;
    Some(())
}

fn push_transcript_influence(
    fact: &CheckedTranscriptSource,
    influence: &DisclosureInfluence,
    kind: InfluenceKind,
    ids: &mut HashSet<String>,
    influences: &mut Vec<DisclosureInfluence>,
) -> Option<()> {
    if influence.id.is_empty()
        || !ids.insert(influence.id.clone())
        || influence.query_id.as_deref() != Some(fact.id.as_str())
        || influence.source != fact.source
        || influence.node != fact.query.node
        || influence.kind != kind
    {
        return None;
    }
    influences.push(influence.clone());
    Some(())
}

fn assemble_transcript_query(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    entry: &str,
    fact: &CheckedTranscriptSource,
    ids: &mut HashSet<String>,
    influences: &mut Vec<DisclosureInfluence>,
) -> Option<ReceiptQuery> {
    let model = nominal(program, ir, fact.model)?;
    let branch = nominal(program, ir, fact.branch)?;
    let parameter = nominal(program, ir, fact.parameter)?;
    let IrItemKind::Model {
        owner: super::ir::IrOwner::ChildOf(parent),
        ..
    } = &model.kind
    else {
        return None;
    };
    let IrItemKind::Param {
        owner: parameter_owner,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol,
                stored: true,
            }),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let order = &fact.order_dependency;
    if fact.id.is_empty() || !ids.insert(fact.id.clone()) {
        return None;
    }
    check_transcript_order_owner(fact, parent, symbol, parameter_owner, owner)?;
    check_transcript_order_read(program, ir, fact, model, order)?;
    let mut dependencies = vec![ReceiptQueryDependency {
        id: order.id.clone(),
        source: origin(&order.source, entry),
        role: ReceiptRole::Control,
        field: order.field_name.clone(),
        type_id: order.type_id.clone(),
    }];
    if order.id.is_empty() || !ids.insert(order.id.clone()) {
        return None;
    }
    for (((field, read), query_read), name) in fact
        .fields
        .iter()
        .zip(&fact.dependencies)
        .zip(&fact.query_dependencies)
        .zip(["role", "content", "attachments"])
    {
        check_transcript_field(
            program,
            ir,
            fact,
            &model.canonical,
            field,
            read,
            query_read,
            name,
            ids,
        )?;
        dependencies.push(ReceiptQueryDependency {
            id: query_read.id.clone(),
            source: origin(&query_read.source, entry),
            role: ReceiptRole::Data,
            field: query_read.field_name.clone(),
            type_id: query_read.type_id.clone(),
        });
    }
    for (influence, kind) in fact.influences.iter().zip([
        InfluenceKind::QueryExistence,
        InfluenceKind::QueryCardinality,
        InfluenceKind::QueryMembership,
        InfluenceKind::QueryOrder,
    ]) {
        push_transcript_influence(fact, influence, kind, ids, influences)?;
    }
    Some(ReceiptQuery {
        id: fact.id.clone(),
        source: origin(&fact.source, entry),
        model: model.canonical.clone(),
        parent: Some(ReceiptQueryParent {
            source: origin(&fact.source, entry),
            model: branch.canonical.clone(),
            origin: ReceiptQueryParentOrigin::AdmittedReference {
                parameter: parameter.name.clone(),
            },
        }),
        order: vec![ReceiptQueryOrder {
            field: order.field_name.clone(),
            direction: "asc".into(),
        }],
        limit: None,
        archived: "exclude".into(),
        dependencies,
    })
}

fn assemble_transcript_subplans(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry: &str,
    source: &CheckedScenarioSource,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
) -> Option<(ReceiptQuery, ReceiptQuery, ReceiptQuery, ReceiptQuery)> {
    let [any, ancestor, selected, count] = source.queries.as_deref()? else {
        return None;
    };
    let any = super::scenario_receipts::checked_native_any_query_plan(ir, owner, any, db, entry)?;
    let mut ancestor =
        checked_count_query_plan(program, ir, owner, ancestor, db, entry, source_context)?.queries;
    let mut selected =
        checked_first_query_plan(program, ir, owner, selected, db, entry)?.queries;
    let mut counted =
        checked_count_query_plan(program, ir, owner, count, db, entry, source_context)?.queries;
    if ancestor.len() != 1 || selected.len() != 1 || counted.len() != 1 {
        return None;
    }
    Some((any, ancestor.pop()?, selected.pop()?, counted.pop()?))
}

fn enrich_transcript_queries(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry: &str,
    prepared: &PreparedQuerySources<'_>,
    source: &CheckedScenarioSource,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
    mut queries: Vec<ReceiptQuery>,
) -> Option<(Vec<ReceiptQuery>, Vec<DisclosureInfluence>)> {
    let influences = super::scenario_receipts::checked_scenario_query_influences(source)?;
    if influences.len() != 24 {
        return None;
    }
    // The owning checked call retains its separate external predicate.
    // Public metadata is checked here, never used as receipt authority.
    serialize_query_any_prepared(
        program,
        ir,
        owner,
        db,
        prepared.catalog,
        entry,
        Some(prepared),
    )?;
    let (any, ancestor, selected, counted) =
        assemble_transcript_subplans(program, ir, owner, db, entry, source, source_context)?;
    if queries.len() != 2 {
        return None;
    }
    let later = queries.pop()?;
    let early = queries.pop()?;
    queries = vec![
        early,
        any,
        ancestor,
        selected,
        later,
        counted,
    ];
    let mut ids = HashSet::new();
    if queries.iter().any(|query| !ids.insert(query.id.as_str())) {
        return None;
    }
    Some((queries, influences))
}

fn load_transcript_disclosures<'i, 'p, 'f>(
    ir: &'i IrProgram,
    program: &'p CheckedProgram,
    fresh: &'f IrProgram,
    owner: &IrItem,
) -> Option<(
    &'i CheckedScenarioDisclosure,
    &'p CheckedScenarioDisclosure,
    &'f CheckedScenarioDisclosure,
)> {
    let (
        ScenarioDisclosure::Complete(checked),
        ScenarioDisclosure::Complete(original),
        ScenarioDisclosure::Complete(rebuilt),
    ) = (
        ir.scenario_disclosures.get(&owner.id)?,
        program.scenario_disclosures().get(&owner.id)?,
        fresh.scenario_disclosures.get(&owner.id)?,
    )
    else {
        return None;
    };
    Some((checked, original, rebuilt))
}

fn transcript_intrinsic_matches(actual: &DisclosureIntrinsic, expected: &DisclosureIntrinsic) -> bool {
    actual.id == expected.id
        && actual.source == expected.source
        && actual.node == expected.node
        && actual.calls == expected.calls
        && actual.role == expected.role
        && actual.kind == expected.kind
        && actual.ty == expected.ty
        && actual.type_id == expected.type_id
}

fn transcript_return_matches(
    returned: &DisclosureReturn,
    expected: &DisclosureReturn,
) -> bool {
    returned.id == expected.id
        && returned.node == expected.node
        && returned.source == expected.source
        && returned.decisions == expected.decisions
        && returned.dependencies == expected.dependencies
        && returned.intrinsics.len() == expected.intrinsics.len()
        && returned
            .intrinsics
            .iter()
            .zip(&expected.intrinsics)
            .all(|(actual, original)| transcript_intrinsic_matches(actual, original))
        && returned.influences == expected.influences
        && returned.model_result == expected.model_result
}

fn check_transcript_return_shape(
    returned: &DisclosureReturn,
    source: &CheckedScenarioSource,
    influences: &[DisclosureInfluence],
    original: &DisclosureReturn,
    rebuilt: &DisclosureReturn,
) -> Option<()> {
    if returned.source != source.source
        || returned.influences != influences
        || [original, rebuilt]
            .iter()
            .any(|expected| !transcript_return_matches(returned, expected))
    {
        return None;
    }
    Some(())
}

fn check_transcript_return_coverage(
    returned: &DisclosureReturn,
    first: &CheckedTranscriptSource,
    later: &CheckedTranscriptSource,
) -> Option<()> {
    for fact in [first, later] {
        if returned.dependencies.iter().any(|read| {
            read.id == fact.order_dependency.id
                || fact
                    .query_dependencies
                    .iter()
                    .any(|query| query.id == read.id)
        }) {
            return None;
        }
        for read in &fact.dependencies {
            let mut actual = returned
                .dependencies
                .iter()
                .filter(|actual| actual.id == read.id);
            if actual.next()? != read || actual.next().is_some() {
                return None;
            }
        }
    }
    Some(())
}

fn build_transcript_return(
    returned: &DisclosureReturn,
    entry: &str,
) -> Option<ReceiptReturn> {
    Some(ReceiptReturn {
        id: returned.id.clone(),
        source: origin(&returned.source, entry),
        influences: returned
            .influences
            .iter()
            .map(|influence| ReceiptInfluence {
                id: influence.id.clone(),
                query_id: influence.query_id.clone(),
                kind: match influence.kind {
                    InfluenceKind::QueryExistence => "query-existence",
                    InfluenceKind::QueryCardinality => "query-cardinality",
                    InfluenceKind::QueryMembership => "query-membership",
                    InfluenceKind::QueryOrder => "query-order",
                    InfluenceKind::AbsentReference => {
                        unreachable!("checked transcript influences")
                    }
                }
                .into(),
            })
            .collect(),
        dependencies: returned
            .dependencies
            .iter()
            .map(|read| ReceiptDependency {
                id: read.id.clone(),
                source: origin(&read.source, entry),
                role: match read.role {
                    DependencyRole::Data => ReceiptRole::Data,
                    DependencyRole::Control => ReceiptRole::Control,
                },
                model: read.model_name.clone(),
                field: read.field_name.clone(),
                type_id: read.type_id.clone(),
                query_id: read.query_id.clone(),
            })
            .collect(),
        intrinsics: returned
            .intrinsics
            .iter()
            .map(|read| ReceiptIntrinsic {
                id: read.id.clone(),
                source: origin(&read.source, entry),
                role: match read.role {
                    DependencyRole::Data => ReceiptRole::Data,
                    DependencyRole::Control => ReceiptRole::Control,
                },
                type_id: read.type_id.clone(),
                kind: match &read.kind {
                    crate::analysis::scenario_disclosure::DisclosureIntrinsicKind::OperationId => {
                        NativeIntrinsicKind::OperationId
                    }
                    crate::analysis::scenario_disclosure::DisclosureIntrinsicKind::AdmittedInput {
                        parameter_name,
                        ..
                    } => NativeIntrinsicKind::AdmittedInput {
                        parameter: parameter_name.clone(),
                    },
                    crate::analysis::scenario_disclosure::DisclosureIntrinsicKind::AdmittedReferenceVersion {
                        parameter_name,
                        model_name,
                        ..
                    } => NativeIntrinsicKind::AdmittedReferenceVersion {
                        parameter: parameter_name.clone(),
                        model: model_name.clone(),
                    },
                },
            })
            .collect(),
        projection: None,
    })
}

fn checked_transcript_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry: &str,
    prepared: &PreparedQuerySources<'_>,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    let (source, first, later) = load_transcript_pair(prepared, program, ir, owner, db)?;
    let mut queries = Vec::new();
    let mut influences = Vec::new();
    let mut ids = HashSet::new();
    for fact in [first, later] {
        queries.push(assemble_transcript_query(program, ir, owner, entry, fact, &mut ids, &mut influences)?);
    }
    if !source.queries.as_deref()?.is_empty() {
        (queries, influences) = enrich_transcript_queries(program, ir, owner, db, entry, prepared, source, source_context, queries)?;
    }
    let fresh = prepared.fresh.as_ref();
    let (checked, original, rebuilt) = load_transcript_disclosures(ir, program, fresh, owner)?;
    if checked.returns.is_empty()
        || checked.returns.len() != original.returns.len()
        || checked.returns.len() != rebuilt.returns.len()
        || !super::scenario_feasibility::same_disclosure(original, checked)
        || !super::scenario_feasibility::same_disclosure(original, rebuilt)
    {
        return None;
    }
    let mut returns = Vec::new();
    let mut return_ids = HashSet::new();
    for ((returned, original), rebuilt) in checked
        .returns
        .iter()
        .zip(&original.returns)
        .zip(&rebuilt.returns)
    {
        if returned.id.is_empty() || !return_ids.insert(&returned.id) {
            return None;
        }
        check_transcript_return_shape(returned, source, &influences, original, rebuilt)?;
        check_transcript_return_coverage(returned, first, later)?;
        returns.push(build_transcript_return(returned, entry)?);
    }
    Some(ReceiptDisclosurePlan {
        version: 1, event_decision: None, term_decision: None, leave_request_decision: None, leave_decide_decision: None, refer_reject_decision: None, member_retry_decision: None, invoice_overdue_decision: None, rent_movement_refund_decision: None,
        invoice_collect_decision: None, rent_notice_decision: None,source: origin(&source.source, entry),
        queries,
        returns,
    })
}

/// Exact checked Count selection, including the original ancestor guard.
/// Supplied arrays and copied queries cannot supply this native query plan.
fn check_count_shape(
    program: &CheckedProgram,
    query: &DisclosureQuery,
    call: NodeKey,
    overload: usize,
    slots: &Vec<Option<usize>>,
    contained: bool,
    selected: &crate::analysis::types::SelectedCall,
) -> Option<()> {
    if !matches!(&selected.target, SelectedCallTarget::Builtin {id,overload:o}
        if id == "count" && *o == overload)
        || selected.slots != *slots
        || selected.arguments.len() != 1
    {
        return None;
    }
    if contained {
        if program.types.checked_queries.contains_key(&query.node)
            || program
                .types
                .checked_collection_calls
                .contains_key(&call)
        {
            return None;
        }
    } else {
        let source = program.types.checked_queries.get(&query.node)?;
        let collection = program.types.checked_collection_calls.get(&call)?;
        if selected.arguments.as_slice() != [query.node]
            || source.node != query.node
            || source.domain != query.domain
            || source.projection.is_some()
            || collection.node != call
            || collection.builtin != "count"
            || collection.overload != overload
            || collection.model != query.model
            || collection.query != query.node
            || Some(collection.alias) != query.alias
            || collection.predicate.is_some()
        {
            return None;
        }
    }
    Some(())
}

fn checked_count_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    query: &DisclosureQuery,
    db: &SourceDb,
    entry: &str,
    source_context: Option<&super::scenario_decisions::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    let plan = super::scenario_receipts::checked_native_count_query_plan(
        ir,
        owner,
        query,
        db,
        entry,
        source_context,
    )?;
    let count = query.count.as_ref()?;
    let selected = program.types.selected_calls.get(&count.call)?;
    if owner.canonical == "member_terms.assign" {
        let fact = program.types.checked_collection_calls.get(&count.call)?;
        let checked = program.types.checked_queries.get(&query.node)?;
        if !matches!(&selected.target, SelectedCallTarget::Builtin {id,overload}
            if id == "count" && *overload == count.overload)
            || selected.slots != count.slots || selected.arguments.as_slice() != [query.node]
            || fact.node != count.call || fact.query != query.node
            || fact.model != query.model || fact.builtin != "count"
            || checked.node != query.node || checked.domain != query.domain
        { return None; }
        return Some(plan);
    }
    check_count_shape(
        program,
        query,
        count.call,
        count.overload,
        &count.slots,
        count.contained_parent.is_some(),
        selected,
    )?;
    Some(plan)
}

/// Archived-first correspondence: the disclosure proves the exact
/// `archived=include` spelling (the grammar admits no other archived
/// value) while IR drops the valueless clause, so a disclosed include with
/// no IR archived value is the genuine shape. Any other combination —
/// disclosed exclude with an IR value, or an IR non-include value — refuses.
fn archived_first_matches(disclosed: bool, ir: &Option<Box<TypedExpr>>) -> bool {
    match (disclosed, ir) {
        (false, None) => true,
        (true, None) => true,
        (true, Some(expr)) => {
            matches!(&expr.expr, IrExpr::Name(name) if name == "include")
        }
        _ => false,
    }
}

fn resolve_first_call<'e>(
    effects: &'e [IrStmt],
    binding: NodeKey,
    call_span: NodeKey,
) -> Option<(
    &'e super::ir::IrQuery,
    &'e super::ir::IrCallTarget,
    &'e [TypedExpr],
    Option<&'e [Option<usize>]>,
    &'e ResolvedType,
    &'e TypedExpr,
)> {
    let mut bindings = effects.iter().filter_map(|effect| match effect {
        IrStmt::Let { value, span, .. } if same_span(binding, *span) => Some(value),
        _ => None,
    });
    let call = bindings.next()?;
    if bindings.next().is_some() || !same_span(call_span, call.span) {
        return None;
    }
    let (target, args, slots) = match &call.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [domain] = args else {
        return None;
    };
    let IrExpr::Query(query) = &domain.expr else {
        return None;
    };
    Some((query, target, args, slots, &call.ty, domain))
}

fn resolve_first_model<'p, 'i>(
    program: &'p CheckedProgram,
    ir: &'i IrProgram,
    q: &DisclosureQuery,
    first_call: NodeKey,
) -> Option<(
    &'p crate::analysis::types::SelectedCall,
    &'i IrItem,
    &'p Vec<SymbolId>,
    &'i Vec<SymbolId>,
    ResolvedType,
    ResolvedType,
)> {
    let selected = program.types.selected_calls.get(&first_call)?;
    let model = nominal(program, ir, q.model)?;
    let (
        SymbolKind::Model {
            fields: declared, ..
        },
        IrItemKind::Model { fields: actual, .. },
    ) = (&program.symbols.get(q.model.0 as usize)?.kind, &model.kind)
    else {
        return None;
    };
    let record = ResolvedType::Record {
        symbol: q.model,
        stored: true,
    };
    let array = ResolvedType::Array {
        element: Box::new(record.clone()),
        ordered: true,
        nonempty: false,
    };
    Some((selected, model, declared, actual, record, array))
}

fn first_parent_ok(
    ir: &IrProgram,
    owner: &IrItem,
    q: &DisclosureQuery,
    query: &super::ir::IrQuery,
    db: &SourceDb,
) -> Option<bool> {
    match q.first.as_ref()?.contained_parent {
        None => Some(query.parent.is_none()),
        Some((receiver, _)) => {
            let (parameter, parent_id) =
                super::scenario_receipts::checked_first_query_parent(ir, owner, q, query, db)?;
            let expected = ResolvedType::Record {
                symbol: parent_id,
                stored: true,
            };
            let parent = query.parent.as_deref()?;
            Some(
                parent.span.file == receiver.file
                    && parent.span.start == receiver.start
                    && parent.span.end == receiver.end
                    && parent.ty == expected
                    && match &parent.expr {
                        IrExpr::Name(name) => name == &parameter.name,
                        IrExpr::Member { base, field } => {
                            field == "parent"
                                && matches!(&base.expr, IrExpr::Name(name) if name == &parameter.name)
                        }
                        _ => false,
                    },
            )
        }
    }
}

fn first_identity_mismatch(
    q: &DisclosureQuery,
    model: &IrItem,
    declared: &[SymbolId],
    actual: &[SymbolId],
    target: &super::ir::IrCallTarget,
    selected: &crate::analysis::types::SelectedCall,
    slots: Option<&[Option<usize>]>,
    first_overload: usize,
) -> bool {
    use super::ir::IrCallTarget;
    use crate::analysis::types::SelectedCallTarget;
    q.id.is_empty()
        || q.model_name != model.canonical
        || declared != actual
        || q.projection.is_some()
        || q.cardinality_guard.is_some()
        || q.limit.is_some()
        || !matches!(target,IrCallTarget::Builtin {id,awaited:false}
            if id=="first")
        || !matches!(&selected.target,SelectedCallTarget::Builtin {id,overload}
            if id=="first" && *overload==first_overload)
        || selected.slots.as_slice() != [Some(0)]
        || selected.arguments.len() != 1
        || slots.is_some_and(|slots| slots != [Some(0)])
}

fn first_collection_mismatch(
    program: &CheckedProgram,
    q: &DisclosureQuery,
    checked: &crate::analysis::types::CheckedQuery,
    array: &ResolvedType,
    collection: &crate::analysis::types::CheckedCollectionCall,
    first_call: NodeKey,
    first_overload: usize,
    alias: NodeKey,
) -> bool {
    collection.node != first_call
        || collection.builtin != "first"
        || collection.overload != first_overload
        || collection.query != q.node
        || collection.alias != alias
        || collection.model != q.model
        || collection.predicate.is_some()
        || program.types.checked_collection_calls.get(&first_call) != Some(collection)
        || checked.node != q.node
        || checked.domain != q.domain
        || checked.projection.is_some()
        || program.types.checked_queries.get(&q.node) != Some(checked)
        || checked.domain_type != *array
        || checked.result != *array
}

fn first_query_shape_mismatch(
    q: &DisclosureQuery,
    query: &super::ir::IrQuery,
    model: &IrItem,
    domain_ty: &ResolvedType,
    call_ty: &ResolvedType,
    record: &ResolvedType,
    array: &ResolvedType,
    first_parent: bool,
) -> bool {
    use super::ir::IrOwner;
    use crate::analysis::Scalar;
    domain_ty != array
        || *call_ty != ResolvedType::Nullable(Box::new(record.clone()))
        || !matches!(&query.domain,IrQueryDomain::Model(name) if name==&model.canonical)
        || !first_parent
        || query.select.is_some()
        || query.select_param.is_some()
        || query.limit.is_some()
        || query.where_async
        || query.contract_collection_call.is_some()
        || query.value_order.is_some()
        || !archived_first_matches(q.archived, &query.archived)
}

fn check_first_dependencies<'i, 'g>(
    program: &CheckedProgram,
    ir: &'i IrProgram,
    q: &'g DisclosureQuery,
    model: &IrItem,
    declared: &[SymbolId],
) -> Option<Vec<(
    &'g crate::analysis::scenario_disclosure::DisclosureDependency,
    &'i IrItem,
)>> {
    use crate::analysis::scenario_disclosure::DependencyRole;
    // An order-only first carries no predicate and no transported inputs,
    // so empty dependencies are its honest state; a where-query with no
    // dependencies is malformed and keeps the refusal.
    if (q.dependencies.is_empty() && q.predicate.is_some())
        || declared.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|item| item.name == "id")
        })
    {
        return None;
    }
    let mut conjuncts = Vec::new();
    for dependency in q.dependencies.iter() {
        let field = nominal(program, ir, dependency.field)?;
        if !declared.contains(&field.id)
            || dependency.id.is_empty()
            || dependency.source != q.source
            || dependency.model != q.model
            || dependency.model_name != model.canonical
            || dependency.field_name != field.name
            || dependency.role != DependencyRole::Control
            || !dependency.calls.is_empty()
            || field_type(program, ir, field.id, q.model)? != &dependency.ty
        {
            return None;
        }
        conjuncts.push((dependency, field));
    }
    let mut seen = HashSet::new();
    if conjuncts
        .iter()
        .any(|(dependency, _)| !seen.insert(&dependency.id))
    {
        return None;
    }
    // Check every real owning field, including those read after first selection.
    for field in declared {
        field_type(program, ir, *field, q.model)?;
    }
    Some(conjuncts)
}

fn check_first_influences(
    q: &DisclosureQuery,
) -> Option<Vec<ReceiptInfluence>> {
    use crate::analysis::scenario_disclosure::InfluenceKind;
    let mut kinds = HashSet::new();
    let mut ids = HashSet::new();
    let mut influences = Vec::new();
    for influence in &q.influences {
        let kind = match influence.kind {
            InfluenceKind::QueryExistence => "query-existence",
            InfluenceKind::QueryCardinality => "query-cardinality",
            InfluenceKind::QueryMembership => "query-membership",
            InfluenceKind::QueryOrder => "query-order",
            InfluenceKind::AbsentReference => return None,
        };
        if influence.id.is_empty()
            || !ids.insert(&influence.id)
            || !kinds.insert(kind)
            || influence.source != q.source
            || influence.node != q.node
            || influence.query_id.as_deref() != Some(q.id.as_str())
        {
            return None;
        }
        influences.push(ReceiptInfluence {
            id: influence.id.clone(),
            kind: kind.into(),
            query_id: Some(q.id.clone()),
        });
    }
    if kinds.len() != 4 {
        return None;
    }
    Some(influences)
}

fn check_first_returns<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    q: &DisclosureQuery,
    expected_influences: &[DisclosureInfluence],
) -> Option<&'a CheckedScenarioDisclosure> {
    let ScenarioDisclosure::Complete(checked_returns) = ir.scenario_disclosures.get(&owner.id)?
    else {
        return None;
    };
    if checked_returns.returns.is_empty()
        || checked_returns.returns.iter().any(|returned| {
            returned.source != q.source
                || returned
                    .influences
                    .iter()
                    .any(|value| !expected_influences.contains(value))
        })
    {
        return None;
    }
    Some(checked_returns)
}

fn first_query_parent(
    ir: &IrProgram,
    owner: &IrItem,
    q: &DisclosureQuery,
    query: &super::ir::IrQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<Option<ReceiptQueryParent>> {
    // A contained domain carries its admitted parent edge; unscoped first
    // queries keep no parent. The edge re-proves the disclosure's receiver
    // against the immutable IR owner (sealed parent schema included), so a
    // mismatched parent keeps the plan refusal below.
    match q.first.as_ref()?.contained_parent {
        None => Some(None),
        Some(_) => {
            let (parameter, parent_id) =
                super::scenario_receipts::checked_first_query_parent(ir, owner, q, query, db)?;
            Some(Some(ReceiptQueryParent {
                source: origin(&q.source, entry),
                model: ir.items.get(parent_id.0 as usize)?.canonical.clone(),
                origin: ReceiptQueryParentOrigin::AdmittedReference {
                    parameter: parameter.name.clone(),
                },
            }))
        }
    }
}

fn checked_first_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    q: &DisclosureQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    let facts = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let expected_influences = super::scenario_receipts::checked_scenario_query_influences(facts)?;
    let first = q.first.as_ref()?;
    let alias = q.alias?;
    let IrItemKind::Scenario {
        read: false,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let (query, target, _args, slots, call_ty, domain) =
        resolve_first_call(effects, first.binding, first.call)?;
    let collection = query.collection_call.as_deref()?;
    let checked = query.source.as_deref()?;
    let (selected, model, declared, actual, record, array) =
        resolve_first_model(program, ir, q, first.call)?;
    super::scenario_receipts::checked_first_query_order(q, query)?;
    super::scenario_receipts::checked_first_query_predicate(ir, owner, q, query)?;
    let first_parent = first_parent_ok(ir, owner, q, query, db)?;
    if first_identity_mismatch(
        q, model, declared, actual, target, selected, slots, first.overload,
    ) || first_collection_mismatch(
        program, q, checked, &array, collection, first.call, first.overload, alias,
    ) || first_query_shape_mismatch(
        q, query, model, &domain.ty, call_ty, &record, &array, first_parent,
    ) {
        return None;
    }
    let conjuncts = check_first_dependencies(program, ir, q, model, declared)?;
    let influences = check_first_influences(q)?;
    let checked_returns = check_first_returns(ir, owner, q, &expected_influences)?;
    let parent = first_query_parent(ir, owner, q, query, db, entry)?;
    Some(ReceiptDisclosurePlan {
        version: 1, event_decision: None, term_decision: None, leave_request_decision: None, leave_decide_decision: None, refer_reject_decision: None, member_retry_decision: None, invoice_overdue_decision: None, rent_movement_refund_decision: None,
        invoice_collect_decision: None, rent_notice_decision: None,source: origin(&q.source, entry),
        queries: vec![ReceiptQuery {
            id: q.id.clone(),
            source: origin(&q.source, entry),
            model: model.canonical.clone(),
            parent,
            order: q
                .order
                .iter()
                .map(|order| ReceiptQueryOrder {
                    field: order.field_name.clone(),
                    direction: "asc".into(),
                })
                .collect(),
            limit: None,
            archived: if q.archived { "include" } else { "exclude" }.into(),
            dependencies: conjuncts
                .iter()
                .map(|(dependency, field)| ReceiptQueryDependency {
                    id: dependency.id.clone(),
                    source: origin(&dependency.source, entry),
                    role: ReceiptRole::Control,
                    field: field.name.clone(),
                    type_id: dependency.type_id.clone(),
                })
                .collect(),
        }],
        returns: checked_returns
            .returns
            .iter()
            .map(|returned| ReceiptReturn {
                id: returned.id.clone(),
                source: origin(&returned.source, entry),
                influences: influences
                    .iter()
                    .filter(|value| {
                        returned
                            .influences
                            .iter()
                            .any(|original| original.id == value.id)
                    })
                    .cloned()
                    .collect(),
                dependencies: Vec::new(),
                intrinsics: Vec::new(),
                projection: None,
            })
            .collect(),
    })
}

fn same_span(node: NodeKey, span: Span) -> bool {
    node.file == span.file && node.start == span.start && node.end == span.end
}
fn origin(source: &DisclosureSource, entry: &str) -> ReceiptSource {
    ReceiptSource {
        path: source.path.clone(),
        sha256: source.sha256.clone(),
        module: entry.into(),
    }
}
fn nominal<'a>(program: &CheckedProgram, ir: &'a IrProgram, id: SymbolId) -> Option<&'a IrItem> {
    let (original, actual) = (
        program.symbols.get(id.0 as usize)?,
        ir.items.get(id.0 as usize)?,
    );
    (original.id == id
        && actual.id == id
        && original.canonical == actual.canonical
        && original.name == actual.name
        && original.module == actual.module
        && original.span == actual.span)
        .then_some(actual)
}
fn field_type<'a>(
    program: &'a CheckedProgram,
    ir: &IrProgram,
    id: SymbolId,
    owner: SymbolId,
) -> Option<&'a ResolvedType> {
    let actual = nominal(program, ir, id)?;
    let (
        SymbolKind::Field {
            owner: original_owner,
            ..
        },
        IrItemKind::Field {
            owner: actual_owner,
            ty: IrType::Known(ty),
            ..
        },
    ) = (&program.symbols.get(id.0 as usize)?.kind, &actual.kind)
    else {
        return None;
    };
    let original = program.types.symbol_types.get(&id)?;
    (owner == *original_owner && owner == *actual_owner && original == ty).then_some(original)
}

