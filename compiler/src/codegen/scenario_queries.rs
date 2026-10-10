//! Original checked query lineage transported through the existing State DTO.
//! This optional source producer does not certify native execution or turn a
//! declined scenario into a complete disclosure.
use std::collections::HashSet;

use crate::analysis::catalog::Catalog;
use crate::analysis::resolve::{SymbolId, SymbolKind};
use crate::analysis::scenario_disclosure::{DependencyRole, DisclosureSource, InfluenceKind};
use crate::analysis::types::CheckedQueryProjectionMapping;
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType};
use crate::source::{SourceDb, Span, sha256_hex};

use super::ir::{IrExpr, IrItem, IrItemKind, IrProgram, IrQueryDomain, IrStmt, IrType};
use super::scenario_decisions::{same_scenario_semantics, serial_type};
use super::scenario_receipts::{
    ReceiptDisclosurePlan, ReceiptInfluence, ReceiptQuery, ReceiptQueryDependency,
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
        || queries.len() != 1
    {
        return None;
    }
    // Build from the immutable checked owner rather than accepting a second
    // mutable IR proof. Unrelated emission diagnostics cannot grant this plan;
    // every executable owner expression must still join the original lowering.
    let (fresh, _) = super::ir::build(program, db, catalog);
    same_scenario_semantics(program, ir, &fresh, owner)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
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
    let scan_fact = scan.source.as_ref()?;
    let select_fact = select.source.as_ref()?;
    if q.id.is_empty()
        || q.source != source.source
        || q.projection.source != source.source
        || q.node != scan_fact.node
        || q.domain != scan_fact.domain
        || program.types.checked_queries.get(&q.node) != Some(scan_fact)
        || q.projection.node != select_fact.node
        || program.types.checked_queries.get(&q.projection.node) != Some(select_fact)
        || !same_span(q.cardinality_guard, *guard)
        || !same_span(q.return_node, *returned)
        || q.model != q.projection.model
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
        || select.parent.is_some()
        || select.where_pred.is_some()
        || select.where_async
        || !select.order.is_empty()
        || select.limit.is_some()
        || select.archived.is_some()
        || select.collection_call.is_some()
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
    if projection.contract != q.projection.contract
        || projection.model != q.model
        || projection.alias != q.projection.alias
        || projection.fields != q.projection.fields
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
    serde_json::to_value(ReceiptDisclosurePlan {
        version: 1,
        source: origin(&source.source, entry_module),
        queries: vec![ReceiptQuery {
            id: q.id.clone(),
            source: origin(&q.source, entry_module),
            model: model.canonical.clone(),
            order: Vec::new(),
            limit: None,
            archived: "exclude".into(),
            dependencies,
        }],
        returns: vec![ReceiptReturn {
            id: sha256_hex(
                format!(
                    "query-return:{}:{}:{}",
                    q.id, q.return_node.start, q.return_node.end
                )
                .as_bytes(),
            ),
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
                source: origin(&q.projection.source, entry_module),
                fields,
            }),
        }],
    })
    .ok()
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
