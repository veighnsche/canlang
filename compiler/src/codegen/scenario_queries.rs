//! Original checked query lineage transported through the existing State DTO.
//! This optional source producer does not certify native execution or turn a
//! declined scenario into a complete disclosure.
use std::collections::HashSet;

use crate::analysis::catalog::Catalog;
use crate::analysis::resolve::{SymbolId, SymbolKind};
use crate::analysis::scenario_disclosure::{
    DependencyRole, DisclosureSource, InfluenceKind, ScenarioDisclosure,
};
use crate::analysis::types::{CheckedQueryProjectionMapping, SelectedCallTarget};
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType};
use crate::source::{SourceDb, Span};

use super::ir::{IrExpr, IrItem, IrItemKind, IrProgram, IrQueryDomain, IrStmt, IrType};
use super::scenario_decisions::{same_scenario_semantics, serial_type};
use super::scenario_receipts::{
    NativeIntrinsicKind, NativeReturn, NativeScenarioReceipt, ReceiptDependency,
    ReceiptDisclosurePlan, ReceiptInfluence, ReceiptIntrinsic, ReceiptQuery,
    ReceiptQueryDependency, ReceiptQueryOrder, ReceiptQueryParent, ReceiptQueryParentOrigin,
    ReceiptQueryProjection, ReceiptQueryProjectionField, ReceiptReturn, ReceiptRole, ReceiptSource,
};

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
    )?)
    .ok()
}

/// Retain the authenticated transcript plan for the native collector. The
/// source plan alone still cannot admit capture or a created-model result.
pub(super) fn collect_transcript_query_source(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<ReceiptDisclosurePlan> {
    let source = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    if !source
        .transcripts
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
        && !source
            .inline_selections
            .as_deref()
            .is_some_and(|facts| !facts.is_empty())
    {
        return None;
    }
    checked_query_plan(program, ir, owner, db, catalog, entry_module)
}

/// Literal intermediate selection metadata, authenticated through the same
/// source query path. This does not bind a result or activate native capture.
pub(super) fn serialize_transcript_selections(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<serde_json::Value> {
    let source = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let transcripts = source.transcripts.as_deref()?;
    let inline = source.inline_selections.as_deref()?;
    if transcripts.is_empty() && inline.is_empty() {
        return None;
    }
    checked_query_plan(program, ir, owner, db, catalog, entry_module)?;
    let metadata=transcripts.iter().map(|fact|(&fact.id,&fact.fields,&fact.dependencies))
        .chain(inline.iter().map(|fact|(&fact.query.id,&fact.fields,&fact.dependencies)))
        .map(|(id,fields,dependencies)|serde_json::json!({"queryId":id,"type":"TextMessage[]",
            "fields":fields.iter().zip(dependencies).map(|(field,dependency)|serde_json::json!({"name":field.name,"dependencyId":dependency.id})).collect::<Vec<_>>()
        })).collect();
    Some(serde_json::Value::Array(metadata))
}

/// The literal existential selector belongs to its original checked collection
/// call. Publishing it does not admit the scenario or a native query lifetime.
pub(super) fn serialize_query_any(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<serde_json::Value> {
    use super::ir::{IrCallTarget, IrOwner, IrUnOp};
    use crate::analysis::Scalar;
    if !matches!(
        owner.kind,
        IrItemKind::Scenario {
            read: false,
            trusted: false,
            cohort: None,
            ..
        }
    ) || !program
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
    let (fresh, diagnostics) = super::ir::build(program, db, catalog);
    if !diagnostics.is_empty() {
        return None;
    }
    same_scenario_semantics(program, ir, &fresh, owner)?;
    same_scenario_semantics(program, ir, &fresh, ir.items.get(owner.id.0 as usize)?)?;
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
    let boolean = ResolvedType::Scalar(Scalar::Bool);
    let mut metadata = Vec::new();
    for q in source
        .queries
        .as_deref()?
        .iter()
        .filter(|q| q.first.is_none() && q.count.is_none() && q.projection.is_none())
    {
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
        if actual_calls.next().is_some()
            || q.id.is_empty()
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
            || call.ty != boolean
            || predicate.ty != boolean
            || body.ty != boolean
            || !same_span(predicate_node, body.span)
            || param != alias_name
            || alias.node != collection.alias
            || !matches!(&body.expr,IrExpr::Member {base,field} if field == "unfinished" && matches!(&base.expr,IrExpr::Name(name) if name == param))
            || checked.node != q.node
            || checked.domain != q.domain
            || program.types.checked_queries.get(&q.node) != Some(checked)
            || checked.domain_type != array
            || checked.result != array
            || domain.ty != array
            || query.collection_call.as_deref() != Some(collection)
            || query.contract_collection_call.is_some()
            || query.where_pred.is_some()
            || query.where_async
            || query.select.is_some()
            || query.select_param.is_some()
            || !query.order.is_empty()
            || query.limit.is_some()
            || query.archived.is_some()
            || q.limit.is_some()
            || q.archived
            || !q.order.is_empty()
            || q.cardinality_guard.is_some()
            || *parameter_owner != owner.id
            || !matches!(&model.kind,IrItemKind::Model {owner: IrOwner::ChildOf(id),..} if id == parent_id)
            || !matches!(&query.domain,IrQueryDomain::Model(name) if name == &model.canonical)
            || query.parent.as_ref().is_none_or(|value| {
                !same_span(*parent_node, value.span)
                    || !matches!(&value.expr,IrExpr::Name(name) if name == &parameter.name)
            })
            || dependency.id.is_empty()
            || dependency.role != DependencyRole::Control
            || dependency.field_name != "unfinished"
            || dependency.model != model.id
            || dependency.model_name != model.canonical
            || dependency.node != predicate_node
            || dependency.ty != boolean
            || dependency.type_id != "bool"
            || dependency.source != q.source
            || !dependency.calls.is_empty()
            || dependency.query_id.is_some()
            || field_type(program, ir, dependency.field, model.id)? != &boolean
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
    }
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
    let plan = checked_query_plan(program, ir, owner, db, catalog, entry_module)?;
    let original = program.scenario_disclosures().get(&owner.id)?;
    let queries = original.source_facts()?.queries.as_ref()?;
    let query = queries.first()?;
    if queries
        .iter()
        .any(|query| query.first.is_some() || query.count.is_some())
    {
        let expected_influences =
            super::scenario_receipts::checked_native_query_influences(queries)?;
        let (fresh, diagnostics) = super::ir::build(program, db, catalog);
        if !diagnostics.is_empty() {
            return None;
        }
        let mut native_returns = Vec::new();
        let prepared = super::scenario_feasibility::prepare(program, ir, db, catalog)?;
        let selected_returns = prepared.returns(ir, owner.id)?;
        let ScenarioDisclosure::Complete(original_checked) = original else {
            return None;
        };
        for disclosure in [
            original,
            fresh.scenario_disclosures.get(&owner.id)?,
            ir.scenario_disclosures.get(&owner.id)?,
        ] {
            let ScenarioDisclosure::Complete(checked) = disclosure else {
                return None;
            };
            if checked.scenario != owner.id
                || checked.node != original.source_facts()?.node
                || checked.source != query.source
                || !super::scenario_feasibility::same_disclosure(original_checked, checked)
                || checked.returns.is_empty()
                || selected_returns.len() != plan.returns.len()
            {
                return None;
            }
            for (returned, emitted) in selected_returns.iter().zip(&plan.returns) {
                if returned.node != query.return_node
                    || returned.id != emitted.id
                    || returned.source != query.source
                    || returned.model_result.is_none()
                    || returned.influences != expected_influences
                    || emitted.projection.is_some()
                {
                    return None;
                }
            }
            if native_returns.is_empty() {
                native_returns = selected_returns
                    .iter()
                    .map(|returned| NativeReturn {
                        id: returned.id.clone(),
                        span: Span::new(returned.node.file, returned.node.start, returned.node.end),
                        decisions: Vec::new(),
                        implicit: false,
                    })
                    .collect();
            }
        }
        // This typed preparation grants no row/effect receipt by itself. The
        // created-model collector joins its own original effects and reads.
        return Some(NativeScenarioReceipt {
            plan,
            current_revision: None,
            dependencies: Default::default(),
            intrinsics: Default::default(),
            decisions: Default::default(),
            decision_keys: Default::default(),
            calls: Default::default(),
            returns: native_returns,
        });
    }
    let [query] = queries.as_slice() else {
        return None;
    };
    let (fresh, diagnostics) = super::ir::build(program, db, catalog);
    if !diagnostics.is_empty() {
        return None;
    }
    for disclosure in [
        original,
        fresh.scenario_disclosures.get(&owner.id)?,
        ir.scenario_disclosures.get(&owner.id)?,
    ] {
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
        }],
    })
}

fn checked_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<ReceiptDisclosurePlan> {
    // Direct source-plan consumers also validate the complete original/fresh
    // declaration before constructor matching. The oversized mixed source's
    // derived members cannot borrow a later native-only validation step.
    let returned = if matches!(owner.kind, IrItemKind::Scenario { read: false, .. })
        && matches!(
            program.scenario_disclosures().get(&owner.id)?,
            ScenarioDisclosure::Complete(_)
        ) {
        let prepared = super::scenario_feasibility::prepare(program, ir, db, catalog)?;
        Some(prepared.returns(ir, owner.id)?)
    } else {
        None
    };
    let mut plan = checked_query_plan_full(program, ir, owner, db, catalog, entry_module)?;
    if let Some(returned) = returned {
        super::scenario_receipts::project_plan_returns(&mut plan, &returned)?;
    }
    Some(plan)
}

fn checked_query_plan_full(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry_module: &str,
) -> Option<ReceiptDisclosurePlan> {
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
    if source
        .transcripts
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        if !queries.is_empty()
            && super::scenario_receipts::checked_scenario_query_influences(source)?.len() != 24
        {
            return None;
        }
        return checked_transcript_query_plan(program, ir, owner, db, catalog, entry_module);
    }
    if source
        .inline_selections
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return checked_inline_selection_query_plan(program, ir, owner, db, catalog, entry_module);
    }
    if queries.is_empty() || queries.len() > 3 {
        return None;
    }
    // Build from the immutable checked owner rather than accepting a second
    // mutable IR proof. Unrelated emission diagnostics cannot grant this plan;
    // every executable owner expression must still join the original lowering.
    let (fresh, _) = super::ir::build(program, db, catalog);
    same_scenario_semantics(program, ir, &fresh, owner)?;
    // Public callers may pass a detached owner. Its valid body cannot cover
    // a different executable scenario stored in the supplied IR.
    same_scenario_semantics(program, ir, &fresh, ir.items.get(owner.id.0 as usize)?)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if queries
        .iter()
        .any(|query| query.first.is_some() || query.count.is_some())
    {
        super::scenario_receipts::checked_native_query_influences(queries)?;
        let mut plans = queries.iter().map(|query| {
            if query.first.is_some() {
                checked_first_query_plan(program, ir, owner, query, entry_module)
            } else {
                checked_count_query_plan(program, ir, owner, query, db, entry_module)
            }
        });
        let mut combined = plans.next()??;
        for next in plans {
            combined = super::scenario_receipts::merge_native_query_plans(combined, next?)?;
        }
        return Some(combined);
    }
    if queries.len() != 1 {
        return None;
    }
    let [
        IrStmt::Let { value: scan, .. },
        IrStmt::Require { span: guard, .. },
        IrStmt::Return {
            value: Some(selected),
            span: returned,
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let (IrExpr::Query(scan), IrExpr::Query(select)) = (&scan.expr, &selected.expr) else {
        return None;
    };
    let q = &queries[0];
    let source_projection = q.projection.as_ref()?;
    if q.first.is_some() {
        return None;
    }
    let scan_fact = scan.source.as_deref()?;
    let select_fact = select.source.as_deref()?;
    if q.id.is_empty()
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
        || !scan.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.parent.is_some()
        || scan.select.is_some()
        || scan.where_async
        || scan.collection_call.is_some()
        || scan.contract_collection_call.is_some()
        || select.parent.is_some()
        || select.where_pred.is_some()
        || select.where_async
        || !select.order.is_empty()
        || select.limit.is_some()
        || select.archived.is_some()
        || select.collection_call.is_some()
        || select.contract_collection_call.is_some()
    {
        return None;
    }
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
    let projection = select_fact.projection.as_deref()?;
    if projection.contract != source_projection.contract
        || projection.model != q.model
        || projection.alias != source_projection.alias
        || projection.fields != source_projection.fields
    {
        return None;
    }
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
    let mut fields = Vec::new();
    let mut mappings = HashSet::new();
    for mapped in &projection.fields {
        let id = mapped.field;
        let field = nominal(program, ir, id)?;
        if !declared.contains(&id)
            || field_type(program, ir, id, projection.contract)? != &mapped.ty
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
        fields.push(ReceiptQueryProjectionField {
            name: field.name.clone(),
            kind: kind.into(),
            field: input_field,
        });
    }
    let mut dependency_ids = HashSet::new();
    let mut dependencies = Vec::new();
    if q.dependencies.is_empty() || q.dependencies.len() > 200 {
        return None;
    }
    for dep in &q.dependencies {
        let field = nominal(program, ir, dep.field)?;
        if dep.id.is_empty()
            || !dependency_ids.insert(&dep.id)
            || dep.source != q.source
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
        dependencies.push(ReceiptQueryDependency {
            id: dep.id.clone(),
            source: origin(&dep.source, entry_module),
            role,
            field: field.name.clone(),
            type_id: dep.type_id.clone(),
        });
    }
    let mut influence_ids = HashSet::new();
    let mut kinds = HashSet::new();
    let mut influences = Vec::new();
    for influence in &q.influences {
        if influence.id.is_empty()
            || !influence_ids.insert(&influence.id)
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
    }
    if kinds.len() != 4 {
        return None;
    }
    Some(ReceiptDisclosurePlan {
        version: 1,
        source: origin(&source.source, entry_module),
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

/// The two original eager transcript invocations have separate query and
/// DATA identities even though they evaluate the same declared helper body.
/// This transports source correspondence only; the native receiver is separate.
/// The one original inline WHERE-bound TextMessage query uses existing State
/// query/selection transport; it never invents a local Contract or helper call.
fn checked_inline_selection_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    super::scenario_decisions::collect_decision_sources(program, ir, owner, db, catalog)?;
    let (fresh, diagnostics) = super::ir::build(program, db, catalog);
    if !diagnostics.is_empty() {
        return None;
    }
    same_scenario_semantics(program, ir, &fresh, owner)?;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let [fact] = source.inline_selections.as_deref()? else {
        return None;
    };
    let [query] = source.queries.as_deref()? else {
        return None;
    };
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
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let parent = nominal(program, ir, fact.parent.parent)?;
    let model = nominal(program, ir, query.model)?;
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
    let source_origin = origin(&source.source, entry);
    let query = ReceiptQuery {
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
    };
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
        let intrinsics=returned.intrinsics.iter().map(|read|Some(ReceiptIntrinsic{id:read.id.clone(),source:origin(&read.source,entry),
            role:match read.role {DependencyRole::Data=>ReceiptRole::Data,DependencyRole::Control=>ReceiptRole::Control},type_id:read.type_id.clone(),
            kind:match &read.kind {
                crate::analysis::scenario_disclosure::DisclosureIntrinsicKind::OperationId=>NativeIntrinsicKind::OperationId,
                crate::analysis::scenario_disclosure::DisclosureIntrinsicKind::AdmittedInput{parameter_name,..}=>NativeIntrinsicKind::AdmittedInput{parameter:parameter_name.clone()},
                crate::analysis::scenario_disclosure::DisclosureIntrinsicKind::AdmittedReferenceVersion{parameter_name,model_name,..}=>NativeIntrinsicKind::AdmittedReferenceVersion{parameter:parameter_name.clone(),model:model_name.clone()},
            }})).collect::<Option<Vec<_>>>()?;
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
    Some(ReceiptDisclosurePlan {
        version: 1,
        source: source_origin,
        queries: vec![query],
        returns,
    })
}

fn checked_transcript_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    use crate::analysis::scenario_disclosure::{DisclosureIntrinsicKind, ScenarioDisclosure};
    use crate::analysis::{ResolvedType, Scalar};
    super::scenario_decisions::collect_decision_sources(program, ir, owner, db, catalog)?;
    let (fresh, diagnostics) = super::ir::build(program, db, catalog);
    if !diagnostics.is_empty() {
        return None;
    }
    same_scenario_semantics(program, ir, &fresh, owner)?;
    same_scenario_semantics(program, ir, &fresh, ir.items.get(owner.id.0 as usize)?)?;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let [first, later] = source.transcripts.as_deref()? else {
        return None;
    };
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
    let mut queries = Vec::new();
    let mut influences = Vec::new();
    let mut ids = HashSet::new();
    for fact in [first, later] {
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
        if fact.id.is_empty()
            || !ids.insert(fact.id.clone())
            || *parent != fact.branch
            || *symbol != fact.branch
            || *parameter_owner != owner.id
            || model.name != "Turn"
            || branch.name != "Branch"
            || fact.slots != [Some(0)]
            || order.role != DependencyRole::Control
            || order.model != fact.model
            || order.model_name != model.canonical
            || order.field != fact.order
            || order.field_name != "position"
            || order.ty != ResolvedType::Scalar(Scalar::Int)
            || order.type_id != "int"
            || order.node != fact.order_node
            || order.calls != [fact.call]
            || order.source != fact.source
            || order.query_id.is_some()
            || field_type(program, ir, fact.order, fact.model)? != &order.ty
            || fact.dependencies.len() != 3
            || fact.query_dependencies.len() != 3
            || fact.fields.len() != 3
            || fact.influences.len() != 4
        {
            return None;
        }
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
            if field.name != name
                || read.id.is_empty()
                || !ids.insert(read.id.clone())
                || read.role != DependencyRole::Data
                || read.query_id.as_deref() != Some(fact.id.as_str())
                || read.calls != [fact.call]
                || read.source != fact.source
                || read.node != field.value_node
                || read.model != fact.model
                || read.model_name != model.canonical
                || read.field != field.source_field
                || read.field_name != field.name
                || read.ty != field.ty
                || field_type(program, ir, read.field, fact.model)? != &read.ty
                || query_read.id.is_empty()
                || !ids.insert(query_read.id.clone())
                || query_read.role != DependencyRole::Data
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
        }
        queries.push(ReceiptQuery {
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
                field: "position".into(),
                direction: "asc".into(),
            }],
            limit: None,
            archived: "exclude".into(),
            dependencies,
        });
    }
    if !source.queries.as_deref()?.is_empty() {
        influences = super::scenario_receipts::checked_scenario_query_influences(source)?;
        if influences.len() != 24 {
            return None;
        }
        // The owning checked call retains its separate external predicate.
        // Public metadata is checked here, never used as receipt authority.
        serialize_query_any(program, ir, owner, db, catalog, entry)?;
        let [any, ancestor, selected, count] = source.queries.as_deref()? else {
            return None;
        };
        let any =
            super::scenario_receipts::checked_native_any_query_plan(ir, owner, any, db, entry)?;
        let mut ancestor =
            checked_count_query_plan(program, ir, owner, ancestor, db, entry)?.queries;
        let mut selected = checked_first_query_plan(program, ir, owner, selected, entry)?.queries;
        let mut counted = checked_count_query_plan(program, ir, owner, count, db, entry)?.queries;
        if ancestor.len() != 1 || selected.len() != 1 || counted.len() != 1 || queries.len() != 2 {
            return None;
        }
        let later = queries.pop()?;
        let early = queries.pop()?;
        queries = vec![
            early,
            any,
            ancestor.pop()?,
            selected.pop()?,
            later,
            counted.pop()?,
        ];
        let mut ids = HashSet::new();
        if queries.iter().any(|query| !ids.insert(query.id.as_str())) {
            return None;
        }
    }
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
        if returned.id.is_empty()
            || !return_ids.insert(&returned.id)
            || returned.source != source.source
            || returned.influences != influences
            || [original, rebuilt].iter().any(|expected| {
                returned.id != expected.id
                    || returned.node != expected.node
                    || returned.source != expected.source
                    || returned.decisions != expected.decisions
                    || returned.dependencies != expected.dependencies
                    || returned.intrinsics.len() != expected.intrinsics.len()
                    || returned.intrinsics.iter().zip(&expected.intrinsics).any(
                        |(actual, original)| {
                            actual.id != original.id
                                || actual.source != original.source
                                || actual.node != original.node
                                || actual.calls != original.calls
                                || actual.role != original.role
                                || actual.kind != original.kind
                                || actual.ty != original.ty
                                || actual.type_id != original.type_id
                        },
                    )
                    || returned.influences != expected.influences
                    || returned.model_result != expected.model_result
            })
        {
            return None;
        }
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
        returns.push(ReceiptReturn {
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
                        DisclosureIntrinsicKind::OperationId => NativeIntrinsicKind::OperationId,
                        DisclosureIntrinsicKind::AdmittedInput { parameter_name, .. } => {
                            NativeIntrinsicKind::AdmittedInput {
                                parameter: parameter_name.clone(),
                            }
                        }
                        DisclosureIntrinsicKind::AdmittedReferenceVersion {
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
        });
    }
    Some(ReceiptDisclosurePlan {
        version: 1,
        source: origin(&source.source, entry),
        queries,
        returns,
    })
}

/// Exact checked Count selection, including the original ancestor guard.
/// Supplied arrays and copied queries cannot supply this native query plan.
fn checked_count_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    let plan =
        super::scenario_receipts::checked_native_count_query_plan(ir, owner, query, db, entry)?;
    let count = query.count.as_ref()?;
    let selected = program.types.selected_calls.get(&count.call)?;
    if !matches!(&selected.target, SelectedCallTarget::Builtin {id,overload}
        if id == "count" && *overload == count.overload)
        || selected.slots != count.slots
        || selected.arguments.len() != 1
    {
        return None;
    }
    if count.contained_parent.is_some() {
        if program.types.checked_queries.contains_key(&query.node)
            || program
                .types
                .checked_collection_calls
                .contains_key(&count.call)
        {
            return None;
        }
    } else {
        let source = program.types.checked_queries.get(&query.node)?;
        let collection = program.types.checked_collection_calls.get(&count.call)?;
        if selected.arguments.as_slice() != [query.node]
            || source.node != query.node
            || source.domain != query.domain
            || source.projection.is_some()
            || collection.node != count.call
            || collection.builtin != "count"
            || collection.overload != count.overload
            || collection.model != query.model
            || collection.query != query.node
            || Some(collection.alias) != query.alias
            || collection.predicate.is_some()
        {
            return None;
        }
    }
    Some(plan)
}

fn checked_first_query_plan(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    q: &crate::analysis::scenario_disclosure::DisclosureQuery,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    use super::ir::IrCallTarget;
    use crate::analysis::{ResolvedType, Scalar};
    let facts = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let expected_influences = super::scenario_receipts::checked_scenario_query_influences(facts)?;
    let first = q.first.as_ref()?;
    let alias = q.alias?;
    let predicate_node = q.predicate?;
    let IrItemKind::Scenario {
        read: false,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut bindings = effects.iter().filter_map(|effect| match effect {
        IrStmt::Let { value, span, .. } if same_span(first.binding, *span) => Some(value),
        _ => None,
    });
    let call = bindings.next()?;
    if bindings.next().is_some() || !same_span(first.call, call.span) {
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
    let collection = query.collection_call.as_deref()?;
    let checked = query.source.as_deref()?;
    let selected = program.types.selected_calls.get(&first.call)?;
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
    let [order] = q.order.as_slice() else {
        return None;
    };
    if q.id.is_empty()
        || q.model_name != model.canonical
        || declared != actual
        || q.projection.is_some()
        || q.cardinality_guard.is_some()
        || q.limit.is_some()
        || q.archived
        || order.field.is_some()
        || order.field_name != "id"
        || order.descending
        || !matches!(target,IrCallTarget::Builtin {id,awaited:false}
            if id=="first")
        || !matches!(&selected.target,SelectedCallTarget::Builtin {id,overload}
            if id=="first" && *overload==first.overload)
        || selected.slots.as_slice() != [Some(0)]
        || selected.arguments.len() != 1
        || slots.is_some_and(|slots| slots != [Some(0)])
        || collection.node != first.call
        || collection.builtin != "first"
        || collection.overload != first.overload
        || collection.query != q.node
        || collection.alias != alias
        || collection.model != q.model
        || collection.predicate.is_some()
        || program.types.checked_collection_calls.get(&first.call) != Some(collection)
        || checked.node != q.node
        || checked.domain != q.domain
        || checked.projection.is_some()
        || program.types.checked_queries.get(&q.node) != Some(checked)
        || checked.domain_type != array
        || checked.result != array
        || domain.ty != array
        || call.ty != ResolvedType::Nullable(Box::new(record.clone()))
        || !matches!(&query.domain,IrQueryDomain::Model(name) if name==&model.canonical)
        || query.parent.is_some()
        || query.select.is_some()
        || query.select_param.is_some()
        || query.limit.is_some()
        || query.archived.is_some()
        || query.where_async
        || query.contract_collection_call.is_some()
        || query.where_pred.as_ref().is_none_or(|predicate| {
            !same_span(predicate_node, predicate.span)
                || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        })
        || query.order.len() != 1
        || query.order[0].field != "id"
        || query.order[0].descending
    {
        return None;
    }
    let [dependency] = q.dependencies.as_slice() else {
        return None;
    };
    let field = nominal(program, ir, dependency.field)?;
    if !declared.contains(&field.id)
        || field.name != "account"
        || dependency.id.is_empty()
        || dependency.source != q.source
        || dependency.model != q.model
        || dependency.model_name != model.canonical
        || dependency.field_name != field.name
        || dependency.role != DependencyRole::Control
        || !dependency.calls.is_empty()
        || field_type(program, ir, field.id, q.model)? != &ResolvedType::Scalar(Scalar::User)
        || dependency.ty != ResolvedType::Scalar(Scalar::User)
        || dependency.type_id != "user"
        || declared.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|item| item.name == "id")
        })
    {
        return None;
    }
    // Check every real owning field, including those read after first selection.
    for field in declared {
        field_type(program, ir, *field, q.model)?;
    }
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
    let return_ids = match ir.scenario_disclosures.get(&owner.id)? {
        ScenarioDisclosure::Complete(checked) => {
            if checked.returns.is_empty()
                || checked.returns.iter().any(|returned| {
                    returned.node != q.return_node
                        || returned.source != q.source
                        || returned.influences != expected_influences
                })
            {
                return None;
            }
            checked
                .returns
                .iter()
                .map(|returned| returned.id.clone())
                .collect::<Vec<_>>()
        }
        _ => vec![q.return_id()],
    };
    Some(ReceiptDisclosurePlan {
        version: 1,
        source: origin(&q.source, entry),
        queries: vec![ReceiptQuery {
            id: q.id.clone(),
            source: origin(&q.source, entry),
            model: model.canonical.clone(),
            parent: None,
            order: vec![ReceiptQueryOrder {
                field: "id".into(),
                direction: "asc".into(),
            }],
            limit: None,
            archived: "exclude".into(),
            dependencies: vec![ReceiptQueryDependency {
                id: dependency.id.clone(),
                source: origin(&dependency.source, entry),
                role: ReceiptRole::Control,
                field: field.name.clone(),
                type_id: "user".into(),
            }],
        }],
        returns: return_ids
            .into_iter()
            .map(|id| ReceiptReturn {
                id,
                source: origin(&q.source, entry),
                influences: influences.clone(),
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

#[cfg(test)]
mod any_source_tests {
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};
    use crate::analysis::{Scalar, check_program};
    use crate::codegen::ir::{IrCallTarget, IrUnOp, TypedExpr};
    use std::path::Path;

    fn any_call_mut(ir: &mut IrProgram, owner: SymbolId) -> &mut TypedExpr {
        let IrItemKind::Scenario { guards, .. } = &mut ir.items[owner.0 as usize].kind else {
            panic!("original ask")
        };
        guards.iter_mut().find_map(|guard| {
            let IrStmt::Require { cond, .. } = guard else { return None; };
            let IrExpr::Unary { op: IrUnOp::Not, operand } = &mut cond.expr else { return None; };
            matches!(&operand.expr,IrExpr::Call {target:IrCallTarget::Builtin {id,..},..} | IrExpr::BoundCall {target:IrCallTarget::Builtin {id,..},..} if id == "any").then_some(operand.as_mut())
        }).expect("actual not ANY leading guard")
    }

    #[test]
    fn unchanged_original_any_metadata_is_authentic_and_mutants_keep_native_refusal() {
        // One actual checked cohort/setup is reused for the positive and its
        // same-span mutants. Each serializer owns its fresh correspondence.
        let mut db = SourceDb::new();
        let chat = db.add(
            "CanChat.can".into(),
            include_str!("../../tests/fixtures/original-a850/CanChat.can").into(),
        );
        let creative = db.add(
            "CanCreative.can".into(),
            include_str!("../../tests/fixtures/original-a850/CanCreative.can").into(),
        );
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let path = root.join("target/profile-native-catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(chat, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[chat, creative], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "chat.ask")
            .unwrap();
        let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
            panic!(
                "exact analysis reuse completes unchanged original source: {:?}",
                ir.scenario_disclosures[&owner.id]
            );
        };
        assert_eq!(
            proof.returns.len(),
            256,
            "conservative source paths are retained"
        );
        let facts = ir.scenario_disclosures[&owner.id].source_facts().unwrap();
        let queries = facts.queries.as_deref().unwrap();
        assert_eq!(queries.len(), 4);
        assert_eq!(facts.transcripts.as_deref().unwrap().len(), 2);
        let query = queries
            .iter()
            .find(|query| {
                query.first.is_none() && query.count.is_none() && query.projection.is_none()
            })
            .unwrap();
        let [dependency] = query.dependencies.as_slice() else {
            panic!("one actual unfinished control")
        };
        assert_eq!(dependency.role, DependencyRole::Control);
        assert_eq!(dependency.field_name, "unfinished");
        assert_eq!(dependency.model_name, "chat.Run");
        assert_eq!(dependency.ty, ResolvedType::Scalar(Scalar::Bool));
        assert_eq!(
            ir.items[dependency.field.0 as usize].canonical,
            "chat.Run.unfinished"
        );
        assert!(dependency.calls.is_empty() && dependency.query_id.is_none());
        let entry = super::super::js::pick_entrypoint(&ir).unwrap();
        let module = super::super::js::module_path(&ir.module(entry).name);
        let metadata = serialize_query_any(&program, &ir, owner, &db, Some(&catalog), &module)
            .expect("actual original ANY metadata");
        assert_eq!(
            metadata,
            serde_json::json!([{"queryId":query.id,"dependencyId":dependency.id}])
        );
        assert_eq!(
            program.scenario_disclosures()[&owner.id]
                .source_facts()
                .unwrap()
                .queries
                .as_deref(),
            Some(queries)
        );
        let metadata_by_owner =
            std::collections::BTreeMap::from([(owner.canonical.clone(), metadata.clone())]);
        let native = super::super::js::emit_program_with_query_sources(
            &ir,
            true,
            &db,
            &std::collections::BTreeMap::new(),
            &std::collections::BTreeMap::new(),
            super::super::js::EmitDecisionSources {
                query_any: Some(&metadata_by_owner),
                ..Default::default()
            },
        );
        let emitted = std::iter::once(&native.entry)
            .chain(native.packages.iter())
            .map(|module| module.js.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(emitted.contains(&format!("queryAny:{}", metadata)));
        assert!(
            !emitted.contains("executeScenarioReceiptAny"),
            "literal metadata alone grants no native lowering"
        );
        assert!(
            native
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008")
        );
        assert!(
            native
                .operations
                .iter()
                .find(|operation| operation.name == "chat.ask")
                .unwrap()
                .disclosure
                .is_none()
        );
        for mode in [
            "predicate-field",
            "awaited",
            "slots",
            "parent",
            "field-schema",
            "proof-id",
            "proof-loss",
        ] {
            let mut changed = ir.clone();
            if mode == "field-schema" {
                let IrItemKind::Field { ty, .. } =
                    &mut changed.items[dependency.field.0 as usize].kind
                else {
                    panic!("Run unfinished")
                };
                *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
            } else if matches!(mode, "proof-id" | "proof-loss") {
                let disclosure = changed.scenario_disclosures.get_mut(&owner.id).unwrap();
                let proof = match disclosure {
                    ScenarioDisclosure::Complete(value) => &mut value.source_facts,
                    ScenarioDisclosure::Declined(value) => &mut value.source_facts,
                };
                if mode == "proof-loss" {
                    *proof = None;
                } else {
                    let queries = proof.as_mut().unwrap().queries.as_mut().unwrap();
                    let other = queries
                        .iter()
                        .find(|candidate| candidate.id != query.id)
                        .unwrap()
                        .id
                        .clone();
                    queries
                        .iter_mut()
                        .find(|candidate| candidate.id == query.id)
                        .unwrap()
                        .id = other;
                }
            } else {
                let call = any_call_mut(&mut changed, owner.id);
                if mode == "slots" {
                    let (target, args) = match &call.expr {
                        IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                            (target.clone(), args.clone())
                        }
                        _ => panic!("ANY"),
                    };
                    call.expr = IrExpr::BoundCall {
                        target,
                        args,
                        slots: vec![Some(1), Some(0)],
                    };
                } else {
                    let (target, args) = match &mut call.expr {
                        IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                            (target, args)
                        }
                        _ => panic!("ANY"),
                    };
                    if mode == "awaited" {
                        let IrCallTarget::Builtin { awaited, .. } = target else {
                            panic!("ANY builtin")
                        };
                        *awaited = true;
                    } else if mode == "predicate-field" {
                        let IrExpr::Lambda { body, .. } = &mut args[1].expr else {
                            panic!("external predicate")
                        };
                        let IrExpr::Member { field, .. } = &mut body.expr else {
                            panic!("unfinished")
                        };
                        *field = "stop_requested".into();
                    } else {
                        let IrExpr::Query(query) = &mut args[0].expr else {
                            panic!("original contained domain")
                        };
                        query.parent.as_mut().unwrap().expr = IrExpr::Name("allowance".into());
                    }
                }
            }
            assert!(
                serialize_query_any(
                    &program,
                    &changed,
                    &changed.items[owner.id.0 as usize],
                    &db,
                    Some(&catalog),
                    &module
                )
                .is_none(),
                "{mode}"
            );
        }
    }
}

#[cfg(test)]
mod inline_selection_tests {
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};
    #[test]
    fn original_regenerate_inline_selection_consumers_preserve_source_and_refuse_unprepared_plans()
    {
        let mut db = SourceDb::new();
        let file = db.add(
            "CanChat.can".into(),
            include_str!("../../tests/fixtures/original-a850/CanChat.can").into(),
        );
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let path = root.join("target/profile-native-catalog.json");
        let (catalog, errors) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(errors.is_empty(), "{errors:?}");
        let (program, errors) = crate::analysis::check_program(&db, &[file], catalog.as_ref());
        assert!(errors.is_empty(), "{errors:?}");
        let (ir, errors) = super::super::ir::build(&program, &db, catalog.as_ref());
        assert!(errors.is_empty(), "{errors:?}");
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "chat.regenerate")
            .unwrap();
        let proof = &ir.scenario_disclosures[&owner.id];
        let source = proof
            .source_facts()
            .expect("original source facts survive the separate guard/native dependency");
        assert!(source.transcripts.as_deref().unwrap().is_empty());
        let [fact] = source.inline_selections.as_deref().unwrap() else {
            panic!("one original inline query");
        };
        let IrItemKind::Scenario { guards, .. } = &owner.kind else {
            panic!("original guards");
        };
        let mut pending = guards
            .iter()
            .filter_map(|stmt| match stmt {
                IrStmt::Require { cond, .. } => Some(cond),
                _ => None,
            })
            .collect::<Vec<_>>();
        let mut unfinished = None;
        while let Some(expr) = pending.pop() {
            match &expr.expr {
                IrExpr::Unary { operand, .. } => {
                    pending.push(operand);
                }
                IrExpr::Binary { left, right, .. } => {
                    pending.extend([left.as_ref(), right.as_ref()])
                }
                IrExpr::Member { base, field }
                    if field == "unfinished"
                        && matches!(&base.expr,IrExpr::Member{field,..} if field=="run") =>
                {
                    unfinished = Some(expr)
                }
                _ => {}
            }
        }
        let unfinished = unfinished.expect("actual original Run guard");
        let pairs = super::super::scenario_receipts::checked_profile_scalar_pairs(
            &ir, owner, unfinished, &db,
        )
        .expect("actual sealed Run reference/Bool consumer");
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0.field_name, "run");
        assert_eq!(pairs[0].1.field_name, "unfinished");
        assert_eq!(pairs[0].0.role, DependencyRole::Control);
        assert_eq!(pairs[0].1.role, DependencyRole::Control);
        assert!(
            super::super::scenario_receipts::checked_profile_scalar_pairs(
                &ir,
                owner,
                &unfinished.clone(),
                &db
            )
            .is_none(),
            "copied expression lacks exact borrowed occurrence"
        );
        let original = source
            .creates
            .as_deref()
            .unwrap()
            .iter()
            .find(|created| {
                created.model
                    == ir
                        .items
                        .iter()
                        .find(|item| item.canonical == "chat.Branch")
                        .unwrap()
                        .id
            })
            .unwrap();
        let IrItemKind::Scenario { effects, .. } = &owner.kind else {
            panic!("original body");
        };
        let value = effects
            .iter()
            .find_map(|stmt| match stmt {
                IrStmt::Let { value, span, .. }
                    if *span
                        == Span::new(
                            fact.statement.file,
                            fact.statement.start,
                            fact.statement.end,
                        ) =>
                {
                    Some(value)
                }
                _ => None,
            })
            .unwrap();
        super::super::scenario_create_sources::checked_create_expression(
            &ir, original, value, fact.value, &db,
        )
        .expect("owning prefix expression uses actual inline selection");
        for mode in [
            "predicate-alias",
            "candidate-field",
            "bound-field",
            "select-alias",
            "selection-type",
        ] {
            let mut changed = value.clone();
            let IrExpr::Binary { right, .. } = &mut changed.expr else {
                panic!("prefix");
            };
            let IrExpr::Query(query) = &mut right.expr else {
                panic!("original query");
            };
            if mode == "select-alias" {
                query.select_param = Some("turn".into());
            } else if mode == "selection-type" {
                query.select.as_mut().unwrap().ty =
                    ResolvedType::Scalar(crate::analysis::Scalar::Text);
            } else {
                let IrExpr::Binary { left, right, .. } =
                    &mut query.where_pred.as_mut().unwrap().expr
                else {
                    panic!("predicate");
                };
                match mode {
                    "predicate-alias" => {
                        let IrExpr::Member { base, .. } = &mut left.expr else {
                            panic!("candidate");
                        };
                        base.expr = IrExpr::Name("turn".into());
                    }
                    "candidate-field" => {
                        let IrExpr::Member { field, .. } = &mut left.expr else {
                            panic!("candidate");
                        };
                        *field = "role".into();
                    }
                    "bound-field" => {
                        let IrExpr::Member { field, .. } = &mut right.expr else {
                            panic!("bound");
                        };
                        *field = "role".into();
                    }
                    _ => unreachable!(),
                }
            }
            assert!(
                super::super::scenario_create_sources::checked_create_expression(
                    &ir, original, &changed, fact.value, &db
                )
                .is_none(),
                "{mode}"
            );
        }
        let module = super::super::js::module_path("chat");
        assert!(
            matches!(proof, ScenarioDisclosure::Complete(_)),
            "original full regenerate source must be complete"
        );
        let plan = checked_query_plan(&program, &ir, owner, &db, catalog.as_ref(), &module)
            .expect("original sealed inline query plan");
        assert_eq!(plan.queries.len(), 1);
        assert_eq!(plan.queries[0].id, fact.query.id);
        assert_eq!(plan.queries[0].dependencies.len(), 5);
        assert!(
            matches!(&plan.queries[0].parent.as_ref().unwrap().origin,ReceiptQueryParentOrigin::StoredReference{dependency_id} if dependency_id==&fact.parent_dependency.id)
        );
        let metadata =
            serialize_transcript_selections(&program, &ir, owner, &db, catalog.as_ref(), &module)
                .unwrap();
        assert_eq!(metadata[0]["queryId"], fact.query.id);
        assert_eq!(metadata[0]["type"], "TextMessage[]");
        assert_eq!(metadata[0]["fields"].as_array().unwrap().len(), 3);
        for returned in &plan.returns {
            assert_eq!(returned.influences.len(), 4);
            assert!(
                returned
                    .dependencies
                    .iter()
                    .any(|read| read.id == fact.bound_dependency.id
                        && read.query_id.as_deref() == Some(fact.query.id.as_str()))
            );
        }
    }
}
