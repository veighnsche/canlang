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
    NativeReturn, NativeScenarioReceipt, ReceiptDisclosurePlan, ReceiptInfluence, ReceiptQuery,
    ReceiptQueryDependency, ReceiptQueryOrder, ReceiptQueryProjection, ReceiptQueryProjectionField,
    ReceiptReturn, ReceiptRole, ReceiptSource,
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
                || checked.returns.len() != plan.returns.len()
                || checked.returns.is_empty()
                || checked.returns.len() > 200
            {
                return None;
            }
            for (returned, emitted) in checked.returns.iter().zip(&plan.returns) {
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
                native_returns = checked
                    .returns
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
        || queries.is_empty()
        || queries.len() > 2
    {
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
        let first = plans.next()??;
        return if let Some(count) = plans.next() {
            super::scenario_receipts::merge_native_query_plans(first, count?)
        } else {
            Some(first)
        };
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

/// Exact original owning first-query source. Generic arrays, copied queries and
/// projections cannot supply this plan or the native first-row hook.
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
        || program.types.checked_queries.contains_key(&query.node)
        || program
            .types
            .checked_collection_calls
            .contains_key(&count.call)
    {
        return None;
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
    let expected_influences =
        super::scenario_receipts::checked_native_query_influences(facts.queries.as_deref()?)?;
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
                || checked.returns.len() > 200
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
