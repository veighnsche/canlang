//! Immediate DATA observations at original scalar LET and constructor field sites.
use super::ir::*;
use crate::analysis::{ResolvedType, SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Preserve an existing native DATA getter instead of installing a second
/// auxiliary observer at that same freshly checked original expression.
pub(super) fn native_owns_data(
    owner: &IrItem,
    native: &super::scenario_receipts::NativeScenarioReceipt,
    span: Span,
    loan: &serde_json::Value,
) -> bool {
    if loan.get("loop").is_some()
        || loan.get("stages").is_some()
        || loan["owner"] != owner.canonical
        || loan["source"] != serde_json::to_value(&native.plan.source).unwrap_or_default()
        || loan["node"]["start"] != span.start
        || loan["node"]["end"] != span.end
    {
        return false;
    }
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return false;
    };
    // LET snapshots need their independent capture bookkeeping, including
    // when an ordinary native DATA consumer also uses their original value.
    if effects
        .iter()
        .any(|statement| matches!(statement,IrStmt::Let{span:original,..}if *original==span))
    {
        return false;
    }
    let model = loan["path"]
        .as_array()
        .and_then(|path| path.last())
        .map(|edge| &edge["model"])
        .or_else(|| loan["parents"].as_array().and_then(|path| path.last()))
        .unwrap_or(&loan["model"]);
    let site = super::scenario_receipts::NativeSite {
        calls: Vec::new(),
        span,
        default_selection: false,
    };
    let declared = |read: &super::scenario_receipts::NativeDependency| {
        native
            .plan
            .returns
            .iter()
            .flat_map(|returned| &returned.dependencies)
            .find(|dependency| {
                dependency.id == read.id
                    && model == &read.model
                    && loan["field"]["name"] == read.field
                    && dependency.model == read.model
                    && dependency.field == read.field
                    && loan["field"]["type"] == dependency.type_id
                    && loan["source"]
                        == serde_json::to_value(&dependency.source).unwrap_or_default()
            })
    };
    native.dependencies.get(&site).is_some_and(|reads| {
        reads.iter().all(|read| declared(read).is_some())
            && reads.iter().any(|read| {
                declared(read).is_some_and(|dependency| {
                    dependency.role == super::scenario_receipts::ReceiptRole::Data
                })
            })
    })
}

/// Native owners reuse the same original stage-zero scalar capture consumed
/// by a later source Require. An unrelated outer DATA read has no such owner.
pub(super) fn native_guard_capture(
    owner: &IrItem,
    native: &super::scenario_receipts::NativeScenarioReceipt,
    requires: &HashMap<Span, serde_json::Value>,
    span: Span,
    loan: &serde_json::Value,
) -> bool {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return false;
    };
    let Some(value) = effects.iter().find_map(|statement| match statement {
        IrStmt::Let {
            name,
            value,
            span: original,
        } if *original == span && loan["binding"] == *name => Some(value),
        _ => None,
    }) else {
        return false;
    };
    let site = super::scenario_receipts::NativeSite {
        calls: Vec::new(),
        span: value.span,
        default_selection: false,
    };
    // A getter already owned by the complete native recipe must keep its
    // independent observations. This bridge owns only the guard capture.
    if native.dependencies.contains_key(&site) || native.intrinsics.contains_key(&site) {
        return false;
    }
    matches!(
        loan["valueType"].as_str(),
        Some(
            "bool"
                | "int"
                | "decimal"
                | "text"
                | "email"
                | "url"
                | "locale"
                | "date"
                | "datetime"
                | "duration"
                | "timezone"
                | "currency"
                | "money"
        )
    ) && loan.get("loop").is_none()
        && loan["stage"] == 0
        && loan.get("stages").is_none()
        && loan
            .get("field")
            .is_some_and(|field| field.get("metadata").is_none())
        && requires.values().any(|guard| {
            guard["owner"] == owner.canonical
                && guard["decision"] == "require"
                && guard.get("mutationPrefix").is_some()
                && guard["source"]["path"] == loan["source"]["path"]
                && guard["source"]["sha256"] == loan["source"]["sha256"]
                && guard["captures"].as_array().is_some_and(|captures| {
                    captures.iter().any(|capture| {
                        capture["node"] == loan["node"]
                            && capture["binding"] == loan["binding"]
                            && capture["typeId"] == loan["valueType"]
                    })
                })
        })
}

/// Exact native dependency IDs read at one original scalar site, joined by
/// the checked expression occurrence rather than a model/field scan. Only
/// reads the disclosure analysis paired with a declared DATA return keep.
/// Partitioned copies are unioned: a read owned by any copy's receipt is
/// owned by the owner (omission would fail completeness for paths in the
/// other copies).
fn site_dependency_ids(
    native: Option<&[super::scenario_receipts::NativeScenarioReceipt]>,
    span: Span,
    model: &str,
    field: &str,
    field_type: &str,
    source: &serde_json::Value,
) -> Vec<String> {
    let Some(copies) = native else {
        return Vec::new();
    };
    let site = super::scenario_receipts::NativeSite {
        calls: Vec::new(),
        span,
        default_selection: false,
    };
    let mut ids = Vec::new();
    for native in copies {
        let Some(reads) = native.dependencies.get(&site) else {
            continue;
        };
        for read in reads.iter().filter(|read| {
            read.model == model
                && read.field == field
                && native
                    .plan
                    .returns
                    .iter()
                    .flat_map(|returned| &returned.dependencies)
                    .any(|dependency| {
                        dependency.id == read.id
                            && dependency.model == read.model
                            && dependency.field == read.field
                            && dependency.type_id == field_type
                            && serde_json::to_value(&dependency.source).unwrap_or_default()
                                == *source
                            && dependency.role == super::scenario_receipts::ReceiptRole::Data
                    })
        }) {
            if !ids.contains(&read.id) {
                ids.push(read.id.clone());
            }
        }
    }
    ids
}

pub(super) fn collect(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    requires: &HashMap<Span, serde_json::Value>,
    module: &str,
    loops: Option<&serde_json::Value>,
    native_source: Option<&serde_json::Value>,
    native: Option<&[super::scenario_receipts::NativeScenarioReceipt]>,
) -> Option<HashMap<Span, serde_json::Value>> {
    let IrItemKind::Scenario {
        params,
        effects,
        hook: None,
        read: false,
        trusted: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let source = native_source.cloned().or_else(|| {
        requires
            .values()
            .find(|source| source["owner"] == owner.canonical)
            .map(|site| site["source"].clone())
    })?;
    fn relevant(body: &[IrStmt]) -> bool {
        body.iter().any(|statement| match statement {
            IrStmt::Let { .. }
            | IrStmt::Create { .. }
            | IrStmt::Set { .. }
            | IrStmt::Schedule { .. } => true,
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => relevant(then_branch) || relevant(else_branch),
            IrStmt::For { body, .. } => relevant(body),
            _ => false,
        })
    }
    if !relevant(effects) {
        return Some(HashMap::new());
    }
    context.same_scenario(ir, owner)?;
    // The number of alternatives stays within the wire census. A numeric
    // checkpoint may be larger after an independently sealed finite loop,
    // using the same write allowance as State's sourceBodyLoopLimits.
    let stage_limit = match loops {
        Some(plan) => plan["loops"]
            .as_array()?
            .iter()
            .try_fold(200usize, |total, entry| {
                let maximum = usize::try_from(entry["maximum"].as_u64()?).ok()?;
                let writes = usize::try_from(entry["writes"].as_u64()?).ok()?;
                if !(1..=1000).contains(&maximum) || writes > 4 {
                    return None;
                }
                total.checked_add(maximum.checked_mul(writes)?)
            })?,
        None => 200,
    };
    let mut roots: BTreeMap<String, SymbolId> = params
        .iter()
        .filter_map(|id| {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty:
                    IrType::Known(ResolvedType::Record {
                        symbol,
                        stored: true,
                    }),
                ..
            } = &param.kind
            else {
                return None;
            };
            matches!(
                ir.items.get(symbol.0 as usize)?.kind,
                IrItemKind::Model { .. }
            )
            .then(|| (param.name.clone(), *symbol))
        })
        .collect();
    fn uses(value: &TypedExpr, name: &str, depth: usize) -> bool {
        if depth >= 64 {
            return false;
        }
        match &value.expr {
            IrExpr::Name(value) => value == name,
            IrExpr::Member { base, .. } => uses(base, name, depth + 1),
            IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } | IrExpr::Array(args) => {
                args.iter().any(|value| uses(value, name, depth + 1))
            }
            IrExpr::Object(fields) => fields.iter().any(|(_, value)| uses(value, name, depth + 1)),
            IrExpr::Binary { left, right, .. } => {
                uses(left, name, depth + 1) || uses(right, name, depth + 1)
            }
            IrExpr::Unary { operand, .. } => uses(operand, name, depth + 1),
            _ => false,
        }
    }
    fn used_by_send_at(statements: &[IrStmt], name: &str, depth: usize) -> bool {
        if depth >= 64 {
            return false;
        }
        for statement in statements {
            match statement {
                IrStmt::Send { args, .. } if uses(args, name, 0) => return true,
                IrStmt::Let { name: shadow, .. } if shadow == name => return false,
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    if used_by_send_at(then_branch, name, depth + 1)
                        || used_by_send_at(else_branch, name, depth + 1)
                    {
                        return true;
                    }
                }
                IrStmt::For {
                    item,
                    limit: Some(limit),
                    body,
                    ..
                } if item != name
                    && matches!(limit.expr,IrExpr::Int(maximum)if (1..=1000).contains(&maximum)) =>
                {
                    if used_by_send_at(body, name, depth + 1) {
                        return true;
                    }
                }
                IrStmt::For { .. } => {}
                IrStmt::Match { .. } => return false,
                _ => {}
            }
        }
        false
    }
    fn used_by_send(statements: &[IrStmt], name: &str) -> bool {
        used_by_send_at(statements, name, 0)
    }
    fn scalar_loan(
        ir: &IrProgram,
        owner: &IrItem,
        context: &super::source_context::FreshSourceContext<'_>,
        roots: &BTreeMap<String, SymbolId>,
        source: &serde_json::Value,
        module: &str,
        value: &TypedExpr,
        span: Span,
        stage: usize,
        name: &str,
        native: Option<&[super::scenario_receipts::NativeScenarioReceipt]>,
    ) -> Option<serde_json::Value> {
        fn receiver(
            ir: &IrProgram,
            value: &TypedExpr,
            roots: &BTreeMap<String, SymbolId>,
            depth: usize,
        ) -> Option<(String, SymbolId, Vec<SymbolId>)> {
            if depth >= 16 {
                return None;
            }
            match &value.expr {
                IrExpr::Name(name) => {
                    let model = *roots.get(name)?;
                    (value.ty
                        == ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        })
                    .then(|| (name.clone(), model, Vec::new()))
                }
                IrExpr::Member { base, field } if field == "parent" => {
                    let (parameter, root, mut parents) = receiver(ir, base, roots, depth + 1)?;
                    let owner = parents.last().copied().unwrap_or(root);
                    let IrItemKind::Model {
                        owner: IrOwner::ChildOf(parent),
                        ..
                    } = &ir.items.get(owner.0 as usize)?.kind
                    else {
                        return None;
                    };
                    if value.ty
                        != (ResolvedType::Record {
                            symbol: *parent,
                            stored: true,
                        })
                    {
                        return None;
                    }
                    parents.push(*parent);
                    Some((parameter, root, parents))
                }
                _ => None,
            }
        }
        let IrExpr::Member { base, .. } = &value.expr else {
            return None;
        };
        let (parameter, root, path) = receiver(ir, base, roots, 0)
            .map(|(parameter, root, parents)| {
                (
                    parameter,
                    root,
                    parents
                        .into_iter()
                        .map(|model| ("parent".into(), model, false))
                        .collect::<Vec<_>>(),
                )
            })
            .or_else(|| super::source_send_data::scalar_field_receiver(ir, base, roots))?;
        let model = &path.last().map(|(_, model, _)| *model).unwrap_or(root);
        if path.is_empty()
            && value.ty == ResolvedType::Scalar(crate::analysis::Scalar::Int)
            && matches!(&value.expr,IrExpr::Member{field,..}if field=="version")
            && matches!(&owner.kind,IrItemKind::Scenario{result:None,effects,..}if effects.iter().any(|statement|
                matches!(statement,IrStmt::For{item,span,body,..}if body.iter().all(|statement|matches!(statement,IrStmt::Set{when:None,..})) && item==&parameter && span.file==value.span.file
                    && span.start<=value.span.start && value.span.end<=span.end)))
            && let IrItemKind::Model { fields, .. } = &ir.items[model.0 as usize].kind
            && !fields
                .iter()
                .filter_map(|id| ir.items.get(id.0 as usize))
                .any(|field| field.name == "version")
        {
            super::source_loops::model_corresponds(context, *model)?;
            return Some(
                serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"stage":stage,"binding":name,
                "parameter":parameter,"model":ir.items[root.0 as usize].canonical,
                "field":{"name":"version","type":"int","metadata":true},"valueType":"int"}),
            );
        }
        let transport = |ty: &ResolvedType| {
            super::source_send_data::data_type(ir, ty).or_else(|| match ty {
                ResolvedType::Record {
                    symbol,
                    stored: true,
                } if matches!(
                    ir.items.get(symbol.0 as usize)?.kind,
                    IrItemKind::Model { .. }
                ) =>
                {
                    Some(ir.items[symbol.0 as usize].canonical.clone())
                }
                _ => None,
            })
        };
        if let IrExpr::Member { base, field } = &value.expr
            && base.ty
                == (ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                })
            && let IrItemKind::Model { fields, .. } = &ir.items[model.0 as usize].kind
            && let Some(declaration) = fields
                .iter()
                .filter_map(|id| ir.items.get(id.0 as usize))
                .find(|item| item.name == *field)
            && let IrItemKind::Field {
                owner: field_owner,
                ty: IrType::Known(ty),
                ..
            } = &declaration.kind
            && field_owner == model
            && (ty == &value.ty
                || matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty))
            && let Some(field_type) = transport(ty)
            && let Some(value_type) = transport(&value.ty)
            && let Some(original) = context.fresh().items.get(declaration.id.0 as usize)
            && declaration.id == original.id
            && declaration.canonical == original.canonical
            && declaration.name == original.name
            && declaration.module == original.module
            && declaration.span == original.span
            && matches!(&original.kind,IrItemKind::Field{owner,ty:IrType::Known(original_ty),..}if owner==model&&original_ty==ty)
        {
            let mut site = serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"stage":stage,"binding":name,
                "parameter":parameter,"model":ir.items[root.0 as usize].canonical,"field":{"name":field,"type":field_type},"valueType":value_type});
            if !path.is_empty() {
                if path
                    .iter()
                    .all(|(field, _, narrowed)| field == "parent" && !*narrowed)
                {
                    site["parents"] = serde_json::json!(
                        path.iter()
                            .map(|(_, id, _)| ir.items[id.0 as usize].canonical.clone())
                            .collect::<Vec<_>>()
                    );
                } else {
                    site["path"]=serde_json::json!(path.iter().map(|(field,id,narrowed)|{
                    let mut edge=serde_json::json!({"field":field,"model":ir.items[id.0 as usize].canonical});
                    if *narrowed{edge["nullable"]=serde_json::json!(true);}edge
                }).collect::<Vec<_>>());
                }
            }
            // Attach the exact native dependency IDs read at this original
            // expression. State redeems only these IDs against the declared
            // DATA returns; a model/field scan would confuse same-field
            // reads at other roots, stages, or consumers.
            // dependency.model is the terminal field-owning model (field_owner
            // == model above), not the loan root: a loan through parent or
            // reference paths must join its exact return DATA dependency.
            let dependency_ids = site_dependency_ids(
                native,
                value.span,
                &ir.items[model.0 as usize].canonical,
                field,
                &field_type,
                &site["source"],
            );
            if !dependency_ids.is_empty() {
                site["dependencyIds"] = serde_json::json!(dependency_ids);
            }
            // A parent traversal reads its intermediate owner row through the
            // exact reference DATA dependency the disclosure pairs with this
            // leaf read (source_dependency_id). Carry those paired IDs so
            // State records the edge through the canonical reference
            // observer; dropping them fails completeness, and the leaf join
            // above cannot see them. Unpaired traversals keep no edge IDs
            // and stay fail-closed.
            let mut parent_dependency_ids = Vec::new();
            // Union across partitioned copies: an edge observed by any copy's
            // receipt belongs to the owner; omission would fail completeness
            // for paths in the other copies.
            if site.get("parents").is_some()
                && let Some(copies) = native
            {
                for native_ref in copies {
                    let Some(reads) =
                        native_ref
                            .dependencies
                            .get(&super::scenario_receipts::NativeSite {
                                calls: Vec::new(),
                                span: value.span,
                                default_selection: false,
                            })
                    else {
                        continue;
                    };
                    for read in reads {
                        if let Some(edge) = &read.source_dependency_id
                            && !parent_dependency_ids.contains(edge)
                        {
                            parent_dependency_ids.push(edge.clone());
                        }
                    }
                }
            }
            if !parent_dependency_ids.is_empty() {
                site["parentDependencyIds"] = serde_json::json!(parent_dependency_ids);
            }
            return Some(site);
        }
        None
    }
    let mut stage = 0;
    let mut loans = HashMap::new();
    for (index, statement) in effects.iter().enumerate() {
        match statement {
            IrStmt::Let { name, value, span } => {
                let guard_capture = requires
                    .values()
                    .filter(|source| source["owner"] == owner.canonical)
                    .filter_map(|source| source["captures"].as_array())
                    .flatten()
                    .any(|capture| {
                        capture["binding"] == *name
                            && capture["node"]["start"] == span.start
                            && capture["node"]["end"] == span.end
                    });
                if (guard_capture || used_by_send(&effects[index + 1..], name))
                    && let Some(loan) = scalar_loan(
                        ir, owner, context, &roots, &source, module, value, *span, stage, name,
                        native,
                    )
                {
                    loans.insert(*span, loan);
                }
                roots.remove(name);
            }
            IrStmt::Create { binding, .. } => {
                if let Some(binding) = binding {
                    roots.remove(binding);
                }
                stage += 1;
            }
            IrStmt::Set { .. } | IrStmt::Transition { .. } | IrStmt::Delete { .. } => stage += 1,
            IrStmt::Require { .. } | IrStmt::Send { .. } => {}
            _ => break,
        }
    }
    // Constructor field DATA is observed exactly where the original field
    // expression executes. A census-admitted bounded loop joins the exact
    // enumeration of iteration count times exact per-iteration writes
    // instead of abandoning later statements; stages stay exact reachable
    // counts, never a guessed point or an open range. File/derived fields
    // cannot enter the field loan.
    fn loop_shadowed_names(body: &[IrStmt], depth: usize) -> Option<BTreeSet<String>> {
        if depth > 64 {
            return None;
        }
        let mut names = BTreeSet::new();
        for statement in body {
            match statement {
                IrStmt::Let { name, .. } => {
                    names.insert(name.clone());
                }
                IrStmt::Create {
                    binding: Some(name),
                    ..
                } => {
                    names.insert(name.clone());
                }
                IrStmt::For { item, body, .. } => {
                    names.insert(item.clone());
                    names.extend(loop_shadowed_names(body, depth + 1)?);
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    names.extend(loop_shadowed_names(then_branch, depth + 1)?);
                    names.extend(loop_shadowed_names(else_branch, depth + 1)?);
                }
                IrStmt::Match { arms, .. } => {
                    for arm in arms {
                        names.extend(loop_shadowed_names(&arm.body, depth + 1)?);
                    }
                }
                _ => {}
            }
        }
        Some(names)
    }
    // Exact per-iteration staged-write counts for a census-admitted loop
    // body. Mirrors the body_counts admission shape (straight-line writes
    // plus empty-else conditional branches); anything else refuses, as the
    // loop census itself would have refused the entry.
    fn loop_write_sets(body: &[IrStmt], depth: usize) -> Option<BTreeSet<usize>> {
        if depth > 64 {
            return None;
        }
        let mut total = BTreeSet::<usize>::from([0]);
        for statement in body {
            let step = match statement {
                IrStmt::Let { .. }
                | IrStmt::Send { .. }
                | IrStmt::Cancel { .. }
                | IrStmt::Schedule { .. } => BTreeSet::<usize>::from([0]),
                IrStmt::Set { .. } | IrStmt::Create { .. } => BTreeSet::from([1]),
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } if else_branch.is_empty() => {
                    let mut when_taken = BTreeSet::<usize>::from([0]);
                    when_taken.extend(loop_write_sets(then_branch, depth + 1)?);
                    when_taken
                }
                _ => return None,
            };
            let mut combined = BTreeSet::new();
            for have in &total {
                for add in &step {
                    combined.insert(have.checked_add(*add)?);
                }
            }
            if combined.len() > 200 {
                return None;
            }
            total = combined;
        }
        Some(total)
    }
    // Exact reachable totals over zero to `maximum` iterations. The census
    // bounds alternative counts, not the numeric value of a write checkpoint.
    fn loop_write_totals(per_iteration: &BTreeSet<usize>, maximum: u64) -> Option<BTreeSet<usize>> {
        let mut totals = BTreeSet::<usize>::from([0]);
        for _ in 0..maximum {
            let mut grown = BTreeSet::new();
            for have in &totals {
                for add in per_iteration {
                    grown.insert(have.checked_add(*add)?);
                }
            }
            totals = totals.union(&grown).copied().collect();
            if totals.len() > 200 {
                return None;
            }
        }
        Some(totals)
    }
    fn after_loop_stages(
        stages: &BTreeSet<usize>,
        body: &[IrStmt],
        entry: &serde_json::Value,
        stage_limit: usize,
    ) -> Option<BTreeSet<usize>> {
        let maximum = entry["maximum"].as_u64()?;
        let writes = usize::try_from(entry["writes"].as_u64()?).ok()?;
        let per_iteration = loop_write_sets(body, 0)?;
        if per_iteration.last().copied().unwrap_or(0) > writes {
            return None;
        }
        let totals = loop_write_totals(&per_iteration, maximum)?;
        let joined: BTreeSet<_> = stages
            .iter()
            .flat_map(|stage| {
                totals.iter().map(move |extra| {
                    stage
                        .checked_add(*extra)
                        .filter(|stage| *stage < stage_limit)
                })
            })
            .collect::<Option<_>>()?;
        (joined.len() <= 200).then_some(joined)
    }
    fn advance_stages(stages: &BTreeSet<usize>, stage_limit: usize) -> Option<BTreeSet<usize>> {
        stages
            .iter()
            .map(|stage| stage.checked_add(1).filter(|stage| *stage < stage_limit))
            .collect()
    }
    fn constructors(
        ir: &IrProgram,
        owner: &IrItem,
        context: &super::source_context::FreshSourceContext<'_>,
        body: &[IrStmt],
        roots: &mut BTreeMap<String, SymbolId>,
        source: &serde_json::Value,
        module: &str,
        stage_limit: usize,
        mut stages: BTreeSet<usize>,
        loans: &mut HashMap<Span, serde_json::Value>,
        loops: Option<&serde_json::Value>,
        native: Option<&[super::scenario_receipts::NativeScenarioReceipt]>,
    ) -> Option<BTreeSet<usize>> {
        for statement in body {
            match statement {
                IrStmt::Create { input, binding, .. } => {
                    if let IrExpr::Object(fields) = &input.expr {
                        for (name, value) in fields {
                            if matches!(
                                value.ty.nullable_inner().unwrap_or(&value.ty),
                                ResolvedType::Scalar(_)
                                    | ResolvedType::Enum { .. }
                                    | ResolvedType::Record { stored: true, .. }
                            ) && let Some(mut loan) = scalar_loan(
                                ir,
                                owner,
                                context,
                                roots,
                                source,
                                module,
                                value,
                                value.span,
                                *stages.first()?,
                                name,
                                native,
                            ) {
                                if stages.len() > 1 {
                                    let fields = loan.as_object_mut()?;
                                    fields.remove("stage");
                                    fields.insert("stages".into(), serde_json::json!(stages));
                                }
                                loans.insert(value.span, loan);
                            }
                        }
                    }
                    if let Some(name) = binding {
                        roots.remove(name);
                    }
                    stages = advance_stages(&stages, stage_limit)?;
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    let left = constructors(
                        ir,
                        owner,
                        context,
                        then_branch,
                        &mut roots.clone(),
                        source,
                        module,
                        stage_limit,
                        stages.clone(),
                        loans,
                        loops,
                        native,
                    );
                    let right = constructors(
                        ir,
                        owner,
                        context,
                        else_branch,
                        &mut roots.clone(),
                        source,
                        module,
                        stage_limit,
                        stages.clone(),
                        loans,
                        loops,
                        native,
                    );
                    // Agreeing exact stages keep the single census. Once a
                    // bounded loop join admitted several reachable counts,
                    // the join keeps their exact union. Two exact-but-different
                    // stages still refuse, as before.
                    match (left, right) {
                        (Some(left), Some(right)) if left == right => stages = left,
                        (Some(left), Some(right)) if left.len() > 1 || right.len() > 1 => {
                            stages = left.union(&right).copied().collect();
                            if stages.len() > 200
                                || stages.last().copied().unwrap_or(stage_limit) >= stage_limit
                            {
                                return None;
                            }
                        }
                        _ => return None,
                    }
                }
                IrStmt::For {
                    item,
                    domain,
                    body,
                    span,
                    ..
                } => {
                    // The loop census admits only statically bounded loops.
                    // Later statements observe the exact enumeration of
                    // iteration count times exact per-iteration writes:
                    // with two writes per iteration, odd intermediates are
                    // impossible and never admitted. Any count reaching the
                    // census budget refuses instead of truncating silently.
                    let entry = loops
                        .and_then(|loops| loops.get("loops")?.as_array())?
                        .iter()
                        .find(|entry| {
                            entry["node"]["start"] == span.start && entry["node"]["end"] == span.end
                        })?;
                    let ResolvedType::Array { element, .. } = &domain.ty else {
                        return None;
                    };
                    let ResolvedType::Record {
                        symbol,
                        stored: true,
                    } = element.as_ref()
                    else {
                        return None;
                    };
                    if entry["item"] != *item
                        || entry["model"] != ir.items[symbol.0 as usize].canonical
                    {
                        return None;
                    }
                    // Names bound anywhere in the body stop being stable
                    // roots afterwards. Loop-body loans stay unrecorded: a
                    // dynamic iteration count cannot fix their stage.
                    for name in loop_shadowed_names(body, 0)? {
                        roots.remove(&name);
                    }
                    stages = after_loop_stages(&stages, body, entry, stage_limit)?;
                }
                IrStmt::Let { name, .. } => {
                    roots.remove(name);
                }
                IrStmt::Set { .. } | IrStmt::Transition { .. } | IrStmt::Delete { .. } => {
                    stages = advance_stages(&stages, stage_limit)?
                }
                IrStmt::Require { .. } | IrStmt::Send { .. } => {}
                _ => return None,
            }
            if stages.len() > 200 || stages.last().copied().unwrap_or(stage_limit) >= stage_limit {
                return None;
            }
        }
        Some(stages)
    }
    let mut constructor_roots = params
        .iter()
        .filter_map(|id| {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty:
                    IrType::Known(ResolvedType::Record {
                        symbol,
                        stored: true,
                    }),
                ..
            } = &param.kind
            else {
                return None;
            };
            matches!(
                ir.items.get(symbol.0 as usize)?.kind,
                IrItemKind::Model { .. }
            )
            .then(|| (param.name.clone(), *symbol))
        })
        .collect();
    constructors(
        ir,
        owner,
        context,
        effects,
        &mut constructor_roots,
        &source,
        module,
        stage_limit,
        BTreeSet::from([0]),
        &mut loans,
        loops,
        native,
    );
    // Each scalar field is observed where its original getter executes.
    // Native JavaScript retains lazy operands and earlier Values failures.
    fn scalar(ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Scalar(value) => !matches!(
                value,
                crate::analysis::Scalar::File
                    | crate::analysis::Scalar::Secret
                    | crate::analysis::Scalar::Member
                    | crate::analysis::Scalar::Json
                    | crate::analysis::Scalar::Bytes
            ),
            ResolvedType::Enum { cases, .. } => !cases.is_empty(),
            ResolvedType::Nullable(inner) => scalar(inner),
            _ => false,
        }
    }
    fn leaves(
        ir: &IrProgram,
        owner: &IrItem,
        context: &super::source_context::FreshSourceContext<'_>,
        value: &TypedExpr,
        roots: &BTreeMap<String, SymbolId>,
        source: &serde_json::Value,
        module: &str,
        stages: &BTreeSet<usize>,
        name: &str,
        loans: &mut HashMap<Span, serde_json::Value>,
        depth: usize,
        native: Option<&[super::scenario_receipts::NativeScenarioReceipt]>,
    ) -> Option<()> {
        if depth > 32 {
            return None;
        }
        if matches!(value.expr, IrExpr::Member { .. })
            && scalar(&value.ty)
            && let Some(mut loan) = scalar_loan(
                ir,
                owner,
                context,
                roots,
                source,
                module,
                value,
                value.span,
                *stages.first()?,
                name,
                native,
            )
        {
            if stages.len() > 1 {
                let fields = loan.as_object_mut()?;
                fields.remove("stage");
                fields.insert("stages".into(), serde_json::json!(stages));
            }
            loans.insert(value.span, loan);
            return Some(());
        }
        let mut child = |value: &TypedExpr| {
            leaves(
                ir,
                owner,
                context,
                value,
                roots,
                source,
                module,
                stages,
                name,
                loans,
                depth + 1,
                native,
            )
        };
        match &value.expr {
            IrExpr::Member { base, .. } => child(base),
            IrExpr::Binary { left, right, .. } => {
                child(left)?;
                child(right)
            }
            IrExpr::Unary { operand, .. } => child(operand),
            IrExpr::Object(fields) => {
                for (_, value) in fields {
                    child(value)?;
                }
                Some(())
            }
            IrExpr::Call {
                target: IrCallTarget::Builtin { id, awaited: false },
                args,
            }
            | IrExpr::BoundCall {
                target: IrCallTarget::Builtin { id, awaited: false },
                args,
                ..
            } if context.catalog().and_then(|catalog| catalog.effects(id))
                == Some(crate::analysis::catalog::Effects::Pure) =>
            {
                for value in args {
                    child(value)?;
                }
                Some(())
            }
            IrExpr::Query(query) => {
                // Candidate values come only from the existing current-viewer
                // reader. External original root fields retain their separate
                // staged DATA observations; an alias can never borrow a root.
                if !matches!(
                    owner.kind,
                    IrItemKind::Scenario {
                        trusted: false,
                        read: false,
                        ..
                    }
                ) || !matches!(query.domain, IrQueryDomain::Model(_))
                    || query.source.is_none()
                {
                    return None;
                }
                if let Some(parent) = &query.parent {
                    leaves(
                        ir,
                        owner,
                        context,
                        parent,
                        roots,
                        source,
                        module,
                        stages,
                        name,
                        loans,
                        depth + 1,
                        native,
                    )?;
                }
                let mut scoped = roots.clone();
                scoped.remove(&query.where_param);
                if let Some(alias) = &query.select_param {
                    scoped.remove(alias);
                }
                for value in query
                    .where_pred
                    .iter()
                    .map(|value| value.as_ref())
                    .chain(query.select.iter().map(|value| value.as_ref()))
                    .chain(query.value_order.iter().map(|order| order.key.as_ref()))
                {
                    leaves(
                        ir,
                        owner,
                        context,
                        value,
                        &scoped,
                        source,
                        module,
                        stages,
                        name,
                        loans,
                        depth + 1,
                        native,
                    )?;
                }
                for value in query.limit.iter().chain(query.archived.iter()) {
                    leaves(
                        ir,
                        owner,
                        context,
                        value,
                        roots,
                        source,
                        module,
                        stages,
                        name,
                        loans,
                        depth + 1,
                        native,
                    )?;
                }
                Some(())
            }
            IrExpr::Int(_)
            | IrExpr::Decimal(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Null
            | IrExpr::Money { .. }
            | IrExpr::DurationMs(_)
            | IrExpr::Date(_)
            | IrExpr::Datetime(_)
            | IrExpr::Name(_) => Some(()),
            _ => None,
        }
    }
    fn expressions(
        ir: &IrProgram,
        owner: &IrItem,
        context: &super::source_context::FreshSourceContext<'_>,
        body: &[IrStmt],
        roots: &mut BTreeMap<String, SymbolId>,
        values: &mut BTreeSet<String>,
        source: &serde_json::Value,
        module: &str,
        stage_limit: usize,
        mut stages: BTreeSet<usize>,
        loans: &mut HashMap<Span, serde_json::Value>,
        loops: Option<&serde_json::Value>,
        native: Option<&[super::scenario_receipts::NativeScenarioReceipt]>,
    ) -> Option<BTreeSet<usize>> {
        if stages.is_empty() || stages.len() > 200 || stages.last().copied()? >= stage_limit {
            return None;
        }
        for statement in body {
            match statement {
                IrStmt::Let { name, value, span } => {
                    if !loans.contains_key(span)
                        && super::source_send_data::plain_value(ir, &value.ty, 0)
                    {
                        let mut nested = HashMap::new();
                        if leaves(
                            ir,
                            owner,
                            context,
                            value,
                            roots,
                            source,
                            module,
                            &stages,
                            name,
                            &mut nested,
                            0,
                            native,
                        )
                        .is_some()
                        {
                            loans.extend(nested);
                        }
                    }
                    let pure = loans.contains_key(span)
                        || super::source_send_data::send_value(ir, value, values, 0)
                        || super::source_send_data::observed_scalar_value(ir, value, loans, values);
                    roots.remove(name);
                    values.remove(name);
                    if pure {
                        values.insert(name.clone());
                    }
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    let left = expressions(
                        ir,
                        owner,
                        context,
                        then_branch,
                        &mut roots.clone(),
                        &mut values.clone(),
                        source,
                        module,
                        stage_limit,
                        stages.clone(),
                        loans,
                        loops,
                        native,
                    );
                    let right = expressions(
                        ir,
                        owner,
                        context,
                        else_branch,
                        &mut roots.clone(),
                        &mut values.clone(),
                        source,
                        module,
                        stage_limit,
                        stages.clone(),
                        loans,
                        loops,
                        native,
                    );
                    // Both authored branches contribute their exact reachable write counts.
                    // Preserve lazy execution; this is a finite admission set, not a range.
                    stages = left?.union(&right?).copied().collect();
                }
                IrStmt::Schedule {
                    at, payload, span, ..
                } => {
                    let mut nested = HashMap::new();
                    if leaves(
                        ir,
                        owner,
                        context,
                        at,
                        roots,
                        source,
                        module,
                        &stages,
                        "at",
                        &mut nested,
                        0,
                        native,
                    )
                    .is_some()
                        && leaves(
                            ir,
                            owner,
                            context,
                            payload,
                            roots,
                            source,
                            module,
                            &stages,
                            "payload",
                            &mut nested,
                            0,
                            native,
                        )
                        .is_some()
                    {
                        loans.extend(nested);
                    }
                    let _ = span;
                }
                IrStmt::For {
                    item,
                    domain,
                    body,
                    span,
                    ..
                } => {
                    if stages.len() != 1 {
                        return None;
                    }
                    let entry = loops?.get("loops")?.as_array()?.iter().find(|entry| {
                        entry["node"]["start"] == span.start && entry["node"]["end"] == span.end
                    })?;
                    let ResolvedType::Array { element, .. } = &domain.ty else {
                        return None;
                    };
                    let ResolvedType::Record {
                        symbol,
                        stored: true,
                    } = element.as_ref()
                    else {
                        return None;
                    };
                    if entry["item"] != *item
                        || entry["model"] != ir.items[symbol.0 as usize].canonical
                    {
                        return None;
                    }
                    let mut nested_roots = roots.clone();
                    nested_roots.insert(item.clone(), *symbol);
                    let mut nested_values = values.clone();
                    nested_values.remove(item);
                    let mut nested = HashMap::new();
                    expressions(
                        ir,
                        owner,
                        context,
                        body,
                        &mut nested_roots,
                        &mut nested_values,
                        source,
                        module,
                        stage_limit,
                        BTreeSet::from([0]),
                        &mut nested,
                        loops,
                        native,
                    )?;
                    if nested.values().any(|loan| loan.get("stages").is_some()) {
                        return None;
                    }
                    for (key, mut loan) in nested.drain() {
                        loan["loop"] = entry["id"].clone();
                        loans.insert(key, loan);
                    }
                    // Constructor and expression observations share the same
                    // exact finite stage join after an authenticated loop.
                    // Item-local loans remain relative to their private lease.
                    stages = after_loop_stages(&stages, body, entry, stage_limit)?;
                    for name in loop_shadowed_names(body, 0)? {
                        roots.remove(&name);
                        values.remove(&name);
                    }
                }
                IrStmt::Create { input, binding, .. } => {
                    let mut nested = HashMap::new();
                    if leaves(
                        ir,
                        owner,
                        context,
                        input,
                        roots,
                        source,
                        module,
                        &stages,
                        "create",
                        &mut nested,
                        0,
                        native,
                    )
                    .is_some()
                    {
                        loans.extend(nested);
                    }
                    if let Some(name) = binding {
                        roots.remove(name);
                        values.remove(name);
                    }
                    stages = advance_stages(&stages, stage_limit)?;
                }
                IrStmt::Set { changes, .. } => {
                    // Nested Object leaves use the same pure expression walker as LET.
                    // Observe each original getter before this SET advances the write stage.
                    let mut nested = HashMap::new();
                    if leaves(
                        ir,
                        owner,
                        context,
                        changes,
                        roots,
                        source,
                        module,
                        &stages,
                        "set",
                        &mut nested,
                        0,
                        native,
                    )
                    .is_some()
                    {
                        loans.extend(nested);
                    }
                    stages = advance_stages(&stages, stage_limit)?;
                }
                IrStmt::Transition { .. } | IrStmt::Delete { .. } => {
                    stages = advance_stages(&stages, stage_limit)?
                }
                IrStmt::Require { .. } | IrStmt::Send { .. } | IrStmt::Cancel { .. } => {}
                _ => return None,
            }
            if stages.len() > 200 {
                return None;
            }
        }
        Some(stages)
    }
    let mut expression_roots = params
        .iter()
        .filter_map(|id| {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty:
                    IrType::Known(ResolvedType::Record {
                        symbol,
                        stored: true,
                    }),
                ..
            } = &param.kind
            else {
                return None;
            };
            matches!(
                ir.items.get(symbol.0 as usize)?.kind,
                IrItemKind::Model { .. }
            )
            .then(|| (param.name.clone(), *symbol))
        })
        .collect();
    let mut values = params
        .iter()
        .filter_map(|id| {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty: IrType::Known(ty),
                ..
            } = &param.kind
            else {
                return None;
            };
            super::source_send_data::plain_value(ir, ty, 0).then(|| param.name.clone())
        })
        .collect();
    expressions(
        ir,
        owner,
        context,
        effects,
        &mut expression_roots,
        &mut values,
        &source,
        module,
        stage_limit,
        BTreeSet::from([0]),
        &mut loans,
        loops,
        native,
    );
    Some(loans)
}

/// Newly supported selected references and versions need the private immediate
/// DATA observation path, including domains with a direct admitted parent.
pub(super) fn needs_selected_observation(owner: &IrItem) -> bool {
    fn selected(value: &TypedExpr, item: &str) -> bool {
        match &value.expr {
            IrExpr::Name(name) => name == item,
            IrExpr::Member { base, field } if field == "version" => {
                matches!(&base.expr,IrExpr::Name(name)if name==item)
            }
            IrExpr::Object(fields) => fields.iter().any(|(_, value)| selected(value, item)),
            _ => false,
        }
    }
    matches!(&owner.kind,IrItemKind::Scenario{effects,..}if effects.iter().any(|statement|
        matches!(statement,IrStmt::For{item,body,..}if body.iter().any(|statement|
            matches!(statement,IrStmt::Set{changes,..}if selected(changes,item))))))
}

/// A newly supported item-version read must use its immediate DATA observer;
/// a missing loan cannot silently fall back to an unobserved record getter.
pub(super) fn complete_loop_metadata(
    owner: &IrItem,
    loops: &serde_json::Value,
    loans: &HashMap<Span, serde_json::Value>,
) -> bool {
    fn value_complete(
        value: &TypedExpr,
        item: &str,
        model: &serde_json::Value,
        id: &serde_json::Value,
        owner: &IrItem,
        selected_authorized: bool,
        loans: &HashMap<Span, serde_json::Value>,
    ) -> bool {
        match &value.expr {
            IrExpr::Name(name) if name == item => selected_authorized,
            IrExpr::Member { base, field }
                if field == "version" && matches!(&base.expr,IrExpr::Name(name)if name==item) =>
            {
                loans.get(&value.span).is_some_and(|loan| {
                    loan["owner"] == owner.canonical
                        && loan["loop"] == *id
                        && loan["model"] == *model
                        && loan["parameter"] == item
                        && loan["field"]["metadata"] == true
                        && loan["field"]["name"] == "version"
                        && loan["field"]["type"] == "int"
                })
            }
            IrExpr::Object(fields) => fields.iter().all(|(_, value)| {
                value_complete(value, item, model, id, owner, selected_authorized, loans)
            }),
            _ => true,
        }
    }
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return false;
    };
    effects.iter().all(|statement| {
        let IrStmt::For {
            item, span, body, ..
        } = statement
        else {
            return true;
        };
        let Some(entry) = loops["loops"].as_array().and_then(|entries| {
            entries.iter().find(|entry| {
                entry["node"]["start"] == span.start && entry["node"]["end"] == span.end
            })
        }) else {
            return true;
        };
        body.iter().all(|statement| match statement {
            IrStmt::Set { changes, .. } => {
                // This initial reference form shares the actual same-SET version DATA
                // observation. A CONTROL-selected reference alone has no DATA grant.
                let selected_authorized = loans.values().any(|loan| {
                    loan["owner"] == owner.canonical
                        && loan["loop"] == entry["id"]
                        && loan["model"] == entry["model"]
                        && loan["parameter"] == *item
                        && loan["field"]["metadata"] == true
                        && loan["node"]["start"]
                            .as_u64()
                            .is_some_and(|start| start >= changes.span.start as u64)
                        && loan["node"]["end"]
                            .as_u64()
                            .is_some_and(|end| end <= changes.span.end as u64)
                });
                value_complete(
                    changes,
                    item,
                    &entry["model"],
                    &entry["id"],
                    owner,
                    selected_authorized,
                    loans,
                )
            }
            _ => true,
        })
    })
}

/// Only original immutable, pre-write LET values may cross a later guard.
/// The emitted callback retains the original query reader and field loans;
/// its result creates no row or ordinary DATA capability.
pub(super) fn capture_plain_value(ir: &IrProgram, ty: &ResolvedType, depth: usize) -> bool {
    if depth >= 16 || !super::source_send_data::plain_value(ir, ty, depth) {
        return false;
    }
    match ty {
        ResolvedType::Scalar(crate::analysis::Scalar::User) => false,
        ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
            capture_plain_value(ir, inner, depth + 1)
        }
        ResolvedType::Object(fields) => fields
            .iter()
            .all(|(_, ty)| capture_plain_value(ir, ty, depth + 1)),
        ResolvedType::Record { symbol, .. } => {
            matches!(ir.items.get(symbol.0 as usize).map(|item|&item.kind),Some(IrItemKind::Contract{fields,..}) if fields.iter().all(|id|
            matches!(ir.items.get(id.0 as usize).map(|item|&item.kind),Some(IrItemKind::Field{ty:IrType::Known(ty),..}) if capture_plain_value(ir,ty,depth+1))))
        }
        _ => true,
    }
}

/// A staged scalar aggregate still executes its original selected query.
/// No caller-supplied array or arbitrary helper stands in for that domain.
pub(super) fn query_value_expression(value: &TypedExpr) -> Option<(&TypedExpr, &IrQuery)> {
    if let IrExpr::Query(query) = &value.expr {
        return Some((value, query));
    }
    let (IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. }) = &value.expr
    else {
        return None;
    };
    if !matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "sum")
        || args.len() != 2
    {
        return None;
    }
    let IrExpr::Query(query) = &args[0].expr else {
        return None;
    };
    Some((&args[0], query))
}

pub(super) fn collect_query_values(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    requires: &HashMap<Span, serde_json::Value>,
    module: &str,
) -> Option<HashMap<Span, serde_json::Value>> {
    let IrItemKind::Scenario {
        params,
        effects,
        read: false,
        trusted: false,
        hook: None,
        result: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    context.same_scenario(ir, owner)?;
    let source = &requires
        .values()
        .find(|source| source["owner"] == owner.canonical)?["source"];
    let mut values = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|item| {
            matches!(&item.kind, IrItemKind::Param { ty: IrType::Known(ty), .. }
            if super::source_send_data::plain_value(ir, ty, 0))
        })
        .map(|item| item.name.clone())
        .collect::<BTreeSet<_>>();
    let mut output = HashMap::new();
    let mut written = false;
    for effect in effects {
        let IrStmt::Let { name, value, span } = effect else {
            if matches!(effect, IrStmt::Require { .. }) {
                continue;
            }
            if matches!(effect, IrStmt::Create { when: None, .. }) {
                written = true;
                continue;
            }
            break;
        };
        let prefix = if written {
            let Some(prefix) = super::scenario_decisions::serialize_let_mutation_prefix(
                context, owner, *span, source,
            ) else {
                continue;
            };
            if !prefix
                .as_array()?
                .iter()
                .all(|step| step["kind"] == "create")
            {
                continue;
            }
            Some(prefix)
        } else {
            None
        };
        let mut queries = Vec::new();
        let query = if let Some((query_value, query)) = query_value_expression(value) {
            let IrQueryDomain::Model(model) = &query.domain else {
                continue;
            };
            let original = query.source.as_ref()?;
            if query.select.is_none()
                || query.where_async
                || query.limit.is_some()
                || query.archived.is_some()
                || original.node.file != span.file
                || original.node.start != query_value.span.start
                || original.node.end != query_value.span.end
            {
                continue;
            }
            queries.push(serde_json::json!({"node":{"start":query_value.span.start,"end":query_value.span.end},"model":model}));
            true
        } else {
            false
        };
        if written && !query {
            continue;
        }
        if !capture_plain_value(ir, &value.ty, 0)
            || !query && !super::source_send_data::send_value(ir, value, &values, 0)
        {
            continue;
        }
        let type_id = super::scenario_decisions::serial_type(&value.ty, context.original(), ir, 0)?;
        values.insert(name.clone());
        let mut descriptor = serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
            "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"value":{"start":value.span.start,"end":value.span.end},
            "binding":name,"typeId":type_id,"stage":0,"queries":queries});
        if let Some(prefix) = prefix {
            descriptor["stage"] = serde_json::json!(prefix.as_array()?.len());
            descriptor["mutationPrefix"] = prefix;
            let readers = collect_query_rows(
                ir,
                owner,
                context,
                &HashMap::from([(*span, descriptor.clone())]),
            );
            let Some(reader) = readers
                .get(span)
                .and_then(|site| site["queries"].as_array())
                .and_then(|queries| queries.first())
            else {
                continue;
            };
            descriptor["queries"][0]["reader"] = reader.clone();
        }
        output.insert(*span, descriptor);
    }
    // Repeated source LETs keep the genuine loop's identity. This initial
    // form admits only straight-line selected-item SETs; branch/CREATE proof
    // remains a separate, explicit extension of the same ordered census.
    let loops = super::source_loops::collect_phase_prefix(ir, owner, context, source, module);
    for statement in effects {
        let IrStmt::For {
            body,
            span: loop_span,
            ..
        } = statement
        else {
            continue;
        };
        let Some(loop_source) = loops
            .as_ref()
            .and_then(|plan| plan["loops"].as_array())
            .and_then(|loops| {
                loops.iter().find(|entry| {
                    entry["node"]["start"] == loop_span.start
                        && entry["node"]["end"] == loop_span.end
                })
            })
        else {
            continue;
        };
        if loop_source.get("condition").is_some()
            || loop_source.get("work").is_some()
            || loop_source["sends"] != 0
        {
            continue;
        }
        let Some(prefix) = super::scenario_decisions::serialize_loop_mutation_prefix(
            context, owner, *loop_span, source,
        ) else {
            continue;
        };
        if !prefix
            .as_array()?
            .iter()
            .all(|step| step["kind"] == "create")
        {
            continue;
        }
        let fields = body
            .iter()
            .filter_map(|statement| {
                if let IrStmt::Set {
                    changes,
                    when: None,
                    ..
                } = statement
                {
                    Some(changes)
                } else {
                    None
                }
            })
            .map(|changes| {
                let IrExpr::Object(fields) = &changes.expr else {
                    return None;
                };
                let mut names = fields
                    .iter()
                    .map(|(name, _)| name.clone())
                    .collect::<Vec<_>>();
                names.sort();
                Some(names)
            })
            .collect::<Option<Vec<_>>>()?;
        if fields.len() as u64 != loop_source["writes"].as_u64()?
            || body.iter().any(|statement| {
                !matches!(
                    statement,
                    IrStmt::Let { .. } | IrStmt::Set { when: None, .. }
                )
            })
        {
            continue;
        }
        let mut before = 0;
        for statement in body {
            let IrStmt::Let { name, value, span } = statement else {
                before += 1;
                continue;
            };
            let Some((query_value, query)) = query_value_expression(value) else {
                continue;
            };
            let IrQueryDomain::Model(model) = &query.domain else {
                continue;
            };
            let Some(original) = query.source.as_ref() else {
                continue;
            };
            if !capture_plain_value(ir, &value.ty, 0)
                || original.node.file != span.file
                || original.node.start != query_value.span.start
                || original.node.end != query_value.span.end
            {
                continue;
            }
            let Some(type_id) =
                super::scenario_decisions::serial_type(&value.ty, context.original(), ir, 0)
            else {
                continue;
            };
            let mut descriptor = serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},"owner":owner.canonical,
                "node":{"start":span.start,"end":span.end},"value":{"start":value.span.start,"end":value.span.end},"binding":name,"typeId":type_id,
                "stage":prefix.as_array()?.len(),"mutationPrefix":prefix,"loop":{"id":loop_source["id"],"before":before,"fields":fields},
                "queries":[{"node":{"start":query_value.span.start,"end":query_value.span.end},"model":model}]});
            let readers = collect_query_rows(
                ir,
                owner,
                context,
                &HashMap::from([(*span, descriptor.clone())]),
            );
            let Some(reader) = readers
                .get(span)
                .and_then(|site| site["queries"].as_array())
                .and_then(|queries| queries.first())
            else {
                continue;
            };
            descriptor["queries"][0]["reader"] = reader.clone();
            output.insert(*span, descriptor);
        }
    }
    Some(output)
}

/// Query codecs spell enum cases inline; ordinary stored observations retain
/// their declaring field's nominal identity. Join only those two spellings of
/// the same original checked field, without changing either published type.
pub(super) fn same_query_capture_type(
    context: &super::source_context::FreshSourceContext<'_>,
    ordinary: &crate::analysis::scenario_disclosure::DisclosureDependency,
    query: &crate::analysis::scenario_disclosure::DisclosureDependency,
) -> bool {
    if ordinary.type_id == query.type_id {
        return true;
    }
    let ResolvedType::Enum {
        owner: Some(enum_owner),
        cases,
    } = &ordinary.ty
    else {
        return false;
    };
    if ordinary.ty != query.ty
        || ordinary.field != query.field
        || ordinary.model != query.model
        || cases.is_empty()
        || query.type_id != format!("enum({})", cases.join(","))
    {
        return false;
    }
    let ir = context.ir();
    for id in [ordinary.field, *enum_owner] {
        let Some(actual) = ir.items.get(id.0 as usize) else {
            return false;
        };
        let Some(original) = context.fresh().items.get(id.0 as usize) else {
            return false;
        };
        if actual.id != id
            || original.id != id
            || format!("{actual:?}") != format!("{original:?}")
            || context.original().types.symbol_types.get(&id) != Some(&ordinary.ty)
            || !matches!(&actual.kind, IrItemKind::Field { ty: IrType::Known(ty), .. } if ty == &ordinary.ty)
        {
            return false;
        }
    }
    let field = &ir.items[ordinary.field.0 as usize];
    let declaration = &ir.items[enum_owner.0 as usize];
    matches!(&field.kind, IrItemKind::Field { owner, .. } if *owner == ordinary.model)
        && ordinary.type_id == declaration.canonical
}

/// Full native receipts retain their query slots. Initial captures and exact
/// aggregate-item captures share one descriptor and DATA-pairing mechanism;
/// an iteration always needs its private native item lease at execution.
pub(super) fn collect_native_query_values(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    module: &str,
) -> Option<HashMap<Span, serde_json::Value>> {
    fn names(value: &TypedExpr, output: &mut BTreeSet<String>, depth: usize) -> Option<()> {
        if depth > 64 {
            return None;
        }
        let mut child = |value: &TypedExpr| names(value, output, depth + 1);
        match &value.expr {
            IrExpr::Name(name) => {
                output.insert(name.clone());
            }
            IrExpr::Member { base, .. } | IrExpr::Unary { operand: base, .. } => child(base)?,
            IrExpr::Binary { left, right, .. } => {
                child(left)?;
                child(right)?;
            }
            IrExpr::Array(values)
            | IrExpr::Call { args: values, .. }
            | IrExpr::BoundCall { args: values, .. } => {
                for value in values {
                    child(value)?;
                }
            }
            IrExpr::Object(fields) => {
                for (_, value) in fields {
                    child(value)?;
                }
            }
            IrExpr::Query(_) => return None,
            _ => {}
        }
        Some(())
    }

    let ir = context.ir();
    context.same_scenario(ir, owner)?;

    let facts = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let originals = context
        .original()
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    if facts.query_values != originals.query_values
        || facts.aggregate_loops != originals.aggregate_loops
    {
        return None;
    }

    let query_values = facts.query_values.as_deref()?;
    if query_values.is_empty() {
        return None;
    }
    let IrItemKind::Scenario {
        params,
        effects,
        result,
        read: false,
        trusted: false,
        hook: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if result.is_some()
        && super::scenario_receipts::checked_created_model_result(ir, owner).is_none()
    {
        return None;
    }
    let source = serde_json::to_value(super::scenario_receipts::transport_source(
        &facts.source,
        module,
    )?)
    .ok()?;
    let mut outer_values=params.iter().filter_map(|id|ir.items.get(id.0 as usize))
        .filter(|item|matches!(&item.kind,IrItemKind::Param{ty:IrType::Known(ty),..}if capture_plain_value(ir,ty,0)))
        .map(|item|item.name.clone()).collect::<BTreeSet<_>>();
    let mut outer_prior = std::collections::BTreeMap::<String, serde_json::Value>::new();

    let leading = effects
        .iter()
        .take_while(|statement| matches!(statement, IrStmt::Require { .. } | IrStmt::Let { .. }))
        .collect::<Vec<_>>();
    let mut scopes = vec![(None, leading, None)];
    for aggregate in facts.aggregate_loops.as_deref().unwrap_or_default() {
        let span = Span {
            file: aggregate.node.file,
            start: aggregate.node.start,
            end: aggregate.node.end,
        };
        let body = effects.iter().find_map(|statement| match statement {
            IrStmt::For {
                body, span: actual, ..
            } if *actual == span => Some(body),
            _ => None,
        })?;
        let prefix = super::scenario_decisions::serialize_loop_mutation_prefix(
            context, owner, span, &source,
        )?;
        let [created] = prefix.as_array()?.as_slice() else {
            return None;
        };
        if created["kind"] != "create"
            || created["created"]["node"]["start"] != aggregate.created.start
            || created["created"]["node"]["end"] != aggregate.created.end
        {
            return None;
        }
        let declarations = body
            .iter()
            .take_while(|statement| matches!(statement, IrStmt::Let { .. }))
            .collect::<Vec<_>>();
        if declarations.len() != aggregate.values.len()
            || declarations
                .iter()
                .zip(&aggregate.values)
                .any(|(statement, node)| {
                    !matches!(statement, IrStmt::Let { span, .. }
                    if span.file == node.file && span.start == node.start && span.end == node.end)
                })
        {
            return None;
        }
        scopes.push((Some(aggregate), declarations, Some(prefix)));
    }

    let mut output = HashMap::new();
    for (aggregate, statements, prefix) in scopes {
        let mut values = outer_values.clone();
        let mut prior = outer_prior.clone();
        for statement in statements {
            if matches!(statement, IrStmt::Require { .. }) {
                continue;
            }
            let IrStmt::Let { name, value, span } = statement else {
                break;
            };
            if !capture_plain_value(ir, &value.ty, 0) {
                continue;
            }
            let type_id =
                super::scenario_decisions::serial_type(&value.ty, context.original(), ir, 0)?;
            let mut descriptor = serde_json::json!({"source":source,"owner":owner.canonical,"node":{"start":span.start,"end":span.end},
            "value":{"start":value.span.start,"end":value.span.end},"binding":name,"typeId":type_id,"stage":0,"queries":[]});
            if let Some(aggregate) = aggregate {
                descriptor["iteration"] = serde_json::json!(aggregate.id);
                descriptor["stage"] = serde_json::json!(prefix.as_ref()?.as_array()?.len());
                descriptor["mutationPrefix"] = prefix.as_ref()?.clone();
            }
            if let Some(query) = query_values.iter().find(|query| {
                query.statement.file == span.file
                    && query.statement.start == span.start
                    && query.statement.end == span.end
                    && query.iteration == aggregate.map(|aggregate| aggregate.node)
            }) {
                descriptor["receiptQueryId"] = serde_json::json!(query.query.id);
                let crate::analysis::scenario_disclosure::ScenarioDisclosure::Complete(checked) =
                    ir.scenario_disclosures.get(&owner.id)?
                else {
                    return None;
                };
                let mut pairs = Vec::new();
                let mut ordinary_ids = BTreeSet::new();
                for dependency in query.query.dependencies.iter().filter(|dependency| {
                    dependency.role == crate::analysis::scenario_disclosure::DependencyRole::Data
                }) {
                    let mut matches = checked
                        .returns
                        .iter()
                        .filter(|returned| returned.source_values.contains(&query.statement))
                        .flat_map(|returned| &returned.dependencies)
                        .filter(|ordinary| {
                            ordinary.query_id.as_deref() == Some(query.query.id.as_str())
                                && ordinary.node == dependency.node
                                && ordinary.calls == dependency.calls
                                && ordinary.source == dependency.source
                                && ordinary.model == dependency.model
                                && ordinary.field == dependency.field
                                && ordinary.ty == dependency.ty
                                && same_query_capture_type(context, ordinary, dependency)
                                && ordinary.role == dependency.role
                        })
                        .map(|ordinary| ordinary.id.clone())
                        .collect::<BTreeSet<_>>();
                    if matches.len() != 1 {
                        return None;
                    }
                    let ordinary = matches.pop_first()?;
                    if ordinary == dependency.id || !ordinary_ids.insert(ordinary.clone()) {
                        return None;
                    }
                    pairs.push(serde_json::json!({"ordinaryDependencyId":ordinary,"queryDependencyId":dependency.id}));
                }
                descriptor["receiptDependencies"] = serde_json::json!(pairs);
                let cases = |choice| {
                    checked
                        .returns
                        .iter()
                        .filter(|returned| {
                            if aggregate.is_some() {
                                // Each actual repeated SUM may be empty or
                                // nonempty without choosing a different owner
                                // return. Its genuine item lease distinguishes
                                // occurrences; retain the original return census.
                                returned.source_values.contains(&query.statement)
                            } else {
                                returned.decisions.iter().any(|decision| {
                                    decision.node == query.value
                                        && decision.calls.is_empty()
                                        && decision.choice == choice
                                })
                            }
                        })
                        .map(|returned| returned.id.clone())
                        .collect::<Vec<_>>()
                };
                descriptor["receiptCases"] = serde_json::json!({"empty":cases(crate::analysis::scenario_disclosure::DisclosureChoice::Else),"nonempty":cases(crate::analysis::scenario_disclosure::DisclosureChoice::Then)});
                descriptor["queries"] = serde_json::json!([{"node":{"start":query.value.start,"end":query.value.end},"model":query.query.model_name}]);
            } else {
                if !super::source_send_data::send_value(ir, value, &values, 0) {
                    continue;
                }
                let mut used = BTreeSet::new();
                names(value, &mut used, 0)?;
                let captures = used
                    .iter()
                    .filter_map(|name| prior.get(name).cloned())
                    .collect::<Vec<_>>();
                if captures.is_empty() {
                    continue;
                }
                descriptor["captures"] = serde_json::json!(captures);
            }
            values.insert(name.clone());
            prior.insert(name.clone(),serde_json::json!({"node":{"start":span.start,"end":span.end},"binding":name,"typeId":type_id}));
            output.insert(*span, descriptor);
            if output.len() > 200 {
                return None;
            }
        }
        if aggregate.is_none() {
            outer_values = values;
            outer_prior = prior;
        }
    }

    Some(output)
}

/// A direct plain field projection is the first State-owned Values query.
/// More complex clauses keep their existing independently checked reader.
pub(super) fn collect_query_rows(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    values: &HashMap<Span, serde_json::Value>,
) -> HashMap<Span, serde_json::Value> {
    let mut out = HashMap::new();
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return out;
    };
    let statements = effects.iter().flat_map(|statement| match statement {
        IrStmt::For { body, .. } => body.iter().collect::<Vec<_>>(),
        _ => vec![statement],
    });
    for effect in statements {
        let IrStmt::Let { value, span, .. } = effect else {
            continue;
        };
        let Some(site) = values.get(span) else {
            continue;
        };
        // Complete receipt queries retain native slots and DATA obligations.
        if site.get("receiptQueryId").is_some() {
            continue;
        }
        let Some((query_value, query)) = query_value_expression(value) else {
            continue;
        };
        let super::ir::IrQueryDomain::Model(model) = &query.domain else {
            continue;
        };
        if query.parent.is_some() && site.get("mutationPrefix").is_none()
            || query.where_pred.is_some()
            || query.limit.is_some()
            || query.archived.is_some()
            || !query.order.is_empty()
            || query.value_order.is_some()
        {
            continue;
        }
        let (Some(projection), Some(alias)) = (&query.select, &query.select_param) else {
            continue;
        };
        let IrExpr::Member { base, field } = &projection.expr else {
            continue;
        };
        if !matches!(&base.expr,IrExpr::Name(name)if name==alias) {
            continue;
        }
        let Some(model_item) = ir.items.iter().find(|item| item.canonical == *model) else {
            continue;
        };
        let IrItemKind::Model { fields, .. } = &model_item.kind else {
            continue;
        };
        if !fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|item|item.name==*field&&matches!(&item.kind,IrItemKind::Field{ty:IrType::Known(ty),..}if *ty==projection.ty)){continue;}
        let Some(ty) =
            super::scenario_decisions::serial_type(&projection.ty, context.original(), ir, 0)
        else {
            continue;
        };
        let id = crate::source::sha256_hex(
            format!(
                "source-values-query/v1:{}:{}:{}",
                site["source"]["sha256"], query_value.span.start, query_value.span.end
            )
            .as_bytes(),
        );
        let mut descriptor = serde_json::json!({"id":id,"node":{"start":query_value.span.start,"end":query_value.span.end},"model":model,"fields":[{"name":field,"type":ty}]});
        if let Some(parent) = &query.parent {
            let IrExpr::Name(name) = &parent.expr else {
                continue;
            };
            let ResolvedType::Record {
                symbol,
                stored: true,
            } = parent.ty
            else {
                continue;
            };
            let Some(parent_model) = ir.items.get(symbol.0 as usize) else {
                continue;
            };
            if !matches!(&model_item.kind, IrItemKind::Model { owner: IrOwner::ChildOf(actual), .. } if *actual == symbol)
            {
                continue;
            }
            let IrItemKind::Scenario { params, .. } = &owner.kind else {
                continue;
            };
            if params.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|parameter|parameter.name==*name&&matches!(&parameter.kind,IrItemKind::Param {ty:IrType::Known(ty),default:None,..} if *ty==parent.ty)) {
                descriptor["parent"] = serde_json::json!({"model":parent_model.canonical,"parameter":name});
            } else {
                let Some(created) = site["mutationPrefix"].as_array().and_then(|prefix|prefix.iter().find_map(|step|(step["kind"]=="create"&&step["created"]["binding"]==*name&&step["created"]["model"]==parent_model.canonical).then_some(&step["created"]))) else { continue; };
                descriptor["parent"] = serde_json::json!({"model":parent_model.canonical,"created":created});
            }
        }
        out.insert(*span,serde_json::json!({"source":site["source"],"owner":owner.canonical,"node":site["node"],"queries":[descriptor]}));
    }
    out
}
