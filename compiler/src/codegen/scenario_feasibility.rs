//! Native-only feasibility of successful compulsory requirements.
//! The original source proof stays complete, including conservative paths.
use std::collections::{HashMap, HashSet};

use crate::analysis::catalog::Catalog;
use crate::analysis::effects::ModelData;
use crate::analysis::scenario_disclosure::{
    CheckedDecisionCallFrame, CheckedDecisionCallTarget, CheckedDecisionPosition,
    CheckedDecisionSite, CheckedDecisionStage, CheckedScenarioCreate, CheckedScenarioDisclosure,
    CheckedScenarioSource, CheckedStoredContractSchema, DisclosureChoice, DisclosureReturn,
    ScenarioDisclosure,
};
use crate::analysis::{CheckedProgram, ModuleId, NodeKey, ResolvedType, Scalar, SymbolId};
use crate::source::{SourceDb, Span};
use crate::syntax::SyntaxKind;

use super::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrExpr, IrItem, IrItemKind, IrParameterArrayBounds,
    IrProgram, IrStmt, IrType, TypedExpr,
};

/// Only this producer constructs the subset. The borrowed immutable IR is the
/// exact lifetime consumed by emission; a copied or different IR cannot use it.
pub(super) struct PreparedRequireReturns<'a> {
    ir: &'a IrProgram,
    program: &'a CheckedProgram,
    indices: HashMap<SymbolId, Vec<usize>>,
}

impl<'a> PreparedRequireReturns<'a> {
    /// Borrow the original complete source proof only for this sealed owner/IR.
    pub(super) fn checked_scenario(
        &self,
        ir: &IrProgram,
        owner: SymbolId,
    ) -> Option<&'a CheckedScenarioDisclosure> {
        if !std::ptr::eq(self.ir, ir) || !self.indices.contains_key(&owner) {
            return None;
        }
        let ScenarioDisclosure::Complete(original) =
            self.program.scenario_disclosures().get(&owner)?
        else {
            return None;
        };
        let ScenarioDisclosure::Complete(actual) = ir.scenario_disclosures.get(&owner)? else {
            return None;
        };
        same_disclosure(original, actual).then_some(original)
    }

    pub(super) fn returns(
        &self,
        ir: &IrProgram,
        owner: SymbolId,
    ) -> Option<Vec<&'a DisclosureReturn>> {
        if !std::ptr::eq(self.ir, ir) {
            return None;
        }
        let ScenarioDisclosure::Complete(original) =
            self.program.scenario_disclosures().get(&owner)?
        else {
            return None;
        };
        self.indices
            .get(&owner)?
            .iter()
            .map(|index| original.returns.get(*index))
            .collect()
    }
}

/// Reuse the freshly lowered immutable cohort inside a single emission.
/// All original/actual/fresh declarations and paths are still compared here.
pub(super) fn prepare_with_fresh<'a>(
    program: &'a CheckedProgram,
    ir: &'a IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    fresh: &IrProgram,
) -> Option<PreparedRequireReturns<'a>> {
    program.validate_cohort(db, catalog).ok()?;
    let mut indices = HashMap::new();
    for owner in &ir.items {
        let Some(ScenarioDisclosure::Complete(original)) =
            program.scenario_disclosures().get(&owner.id)
        else {
            continue;
        };
        let Some(ScenarioDisclosure::Complete(actual)) = ir.scenario_disclosures.get(&owner.id)
        else {
            continue;
        };
        let Some(ScenarioDisclosure::Complete(rebuilt)) = fresh.scenario_disclosures.get(&owner.id)
        else {
            continue;
        };
        // Every source path is compared before any path is classified, including
        // the ones which cannot survive a successful requirement.
        if !same_disclosure(original, actual) || !same_disclosure(original, rebuilt) {
            continue;
        }
        let Some(selected) = prepare_owner(program, ir, fresh, owner, original, db, catalog) else {
            continue;
        };
        indices.insert(owner.id, selected);
    }
    Some(PreparedRequireReturns {
        ir,
        program,
        indices,
    })
}

pub(super) fn requires_projection(original: &CheckedScenarioDisclosure, _ir: &IrProgram) -> bool {
    let nodes = super::scenario_receipts::query_plan_nodes(
        original
            .source_facts
            .as_deref()
            .and_then(|facts| facts.queries.as_ref())
            .map_or(0, Vec::len),
        original.returns.iter().map(|row| {
            (
                row.influences.len(),
                row.dependencies.len(),
                row.dependencies
                    .iter()
                    .filter(|read| read.query_id.is_some())
                    .count(),
                row.intrinsics.len(),
            )
        }),
    );
    original.returns.len() > 200 || nodes.is_none_or(|nodes| nodes > 20_000) || original.returns.iter().any(|row| {
        row.dependencies.iter().any(|read| {
            matches!(read.ty, ResolvedType::Record { stored: true, .. })
                && original.source_facts.as_deref().and_then(|facts| facts.stored_contracts.as_deref())
                    .is_some_and(|schemas| schemas.iter().any(|schema| schema.fields.iter().any(|field| {
                        field.id == read.field && matches!(&field.ty, ResolvedType::Nullable(inner) if inner.as_ref() == &read.ty)
                    })))
        })
    })
}

fn check_owner_hook(
    trusted: bool,
    declared_event: bool,
    event_present: bool,
    hook_present: bool,
    cohort_present: bool,
) -> Option<()> {
    let hook_feasible = trusted && declared_event && !hook_present && !cohort_present;
    if !hook_feasible && (trusted || event_present || hook_present || cohort_present) {
        return None;
    }
    Some(())
}

fn match_contract_schemas(
    ir: &IrProgram,
    fresh: &IrProgram,
    original: &CheckedScenarioDisclosure,
    db: &SourceDb,
) -> Option<()> {
    for schema in original
        .source_facts
        .as_deref()?
        .stored_contracts
        .as_deref()?
    {
        super::scenario_receipts::match_stored_contract_schema(ir, schema, db)?;
        for field in &schema.fields {
            super::scenario_receipts::match_stored_contract_field(ir, field, db)?;
        }
        // The stored read census can omit unsupported fields. Their complete
        // original declaration still participates in this native preparation.
        for id in &schema.field_order {
            let actual = ir.items.get(id.0 as usize)?;
            let expected = fresh.items.get(id.0 as usize)?;
            if actual.id != expected.id
                || actual.name != expected.name
                || actual.module != expected.module
                || actual.canonical != expected.canonical
                || actual.span != expected.span
                || format!("{:?}", actual.kind) != format!("{:?}", expected.kind)
            {
                return None;
            }
        }
    }
    Some(())
}

type Requirement<'a> = (
    &'a TypedExpr,
    Span,
    &'a CheckedDecisionSite,
    Vec<(Span, DisclosureChoice)>,
);

fn push_branch_statements<'a>(
    then_branch: &'a [IrStmt],
    else_branch: &'a [IrStmt],
    span: Span,
    position: &[CheckedDecisionPosition],
    branches: &[(Span, DisclosureChoice)],
    pending: &mut Vec<(
        &'a IrStmt,
        bool,
        Vec<CheckedDecisionPosition>,
        Vec<(Span, DisclosureChoice)>,
    )>,
) {
    for (then, statements) in [(false, else_branch), (true, then_branch)] {
        for (index, nested) in statements.iter().enumerate().rev() {
            let mut nested_position = position.to_vec();
            nested_position.push(if then {
                CheckedDecisionPosition::Then(index)
            } else {
                CheckedDecisionPosition::Else(index)
            });
            let mut nested_branches = branches.to_vec();
            nested_branches.push((
                span,
                if then {
                    DisclosureChoice::Then
                } else {
                    DisclosureChoice::Else
                },
            ));
            pending.push((nested, false, nested_position, nested_branches));
        }
    }
}

fn collect_requirements<'a>(
    sites: &'a [CheckedDecisionSite],
    owner: &IrItem,
    effects: &'a [IrStmt],
    guards: &'a [IrStmt],
) -> Option<Vec<Requirement<'a>>> {
    let mut requirements = Vec::new();
    let mut pending = Vec::new();
    for (leading, statements) in [(false, effects), (true, guards)] {
        for (index, statement) in statements.iter().enumerate().rev() {
            let position = if leading {
                CheckedDecisionPosition::Guard(index)
            } else {
                CheckedDecisionPosition::Body(index)
            };
            pending.push((
                statement,
                leading,
                vec![position],
                Vec::<(Span, DisclosureChoice)>::new(),
            ));
        }
    }
    let mut visits = 0;
    while let Some((statement, leading, position, branches)) = pending.pop() {
        visits += 1;
        if visits > 16384 || position.len() > 64 {
            return None;
        }
        match statement {
            IrStmt::Require { cond, span } => {
                let stage = if leading {
                    CheckedDecisionStage::LeadingRequire
                } else {
                    CheckedDecisionStage::BodyRequire
                };
                let mut matching = sites.iter().filter(|site| {
                    site.owner == owner.id
                        && site.stage == stage
                        && site.position == position
                        && same_span(site.statement, *span)
                });
                let site = matching.next()?;
                if matching.next().is_some() || !same_span(site.node, cond.span) {
                    return None;
                }
                requirements.push((cond, *span, site, branches));
            }
            IrStmt::If {
                then_branch,
                else_branch,
                span,
                ..
            } if !leading => {
                push_branch_statements(
                    then_branch,
                    else_branch,
                    *span,
                    &position,
                    &branches,
                    &mut pending,
                );
            }
            // Other conditional forms stay unknown, as before. This finite
            // extension only proves original If choices; no leaf is evaluated.
            _ => {}
        }
    }
    Some(requirements)
}

fn return_possible(
    input: (&CheckedProgram, &IrProgram, &IrProgram),
    original: &CheckedScenarioDisclosure,
    requirements: &[Requirement<'_>],
    returned: &DisclosureReturn,
    steps: &mut usize,
) -> Option<bool> {
    for (condition, span, site, branches) in requirements {
        // Observer-owned requirements do not contribute static AND choices.
        // Their exact compulsory source predicate is independently executed by
        // the initial-stage runtime observer. Treat its value as unknown here;
        // never infer impossible paths from absent static decisions.
        if original.source_facts.as_deref().and_then(|facts| facts.source_requires.as_deref())
            .is_some_and(|sites| sites.iter().any(|observed|
                observed.node == site.node && observed.statement == site.statement))
        { continue; }
        // A conditional requirement constrains only a return whose actual
        // original branch choices prove that this requirement was reached.
        if (returned.node == original.node
            || span.file == returned.node.file && span.end <= returned.node.start)
            && branches_reached(returned, branches)?
            && !possibly_true(
                (input.0, input.1, input.2),
                condition,
                (site, returned),
                &[],
                &mut HashSet::new(),
                0,
                steps,
            )?
        {
            return Some(false);
        }
    }
    Some(true)
}

fn select_possible_returns(
    input: (&CheckedProgram, &IrProgram, &IrProgram),
    original: &CheckedScenarioDisclosure,
    requirements: &[Requirement<'_>],
) -> Option<Vec<usize>> {
    let mut selected = Vec::new();
    let mut steps = 0;
    for (index, returned) in original.returns.iter().enumerate() {
        if return_possible(input, original, requirements, returned, &mut steps)? {
            selected.push(index);
        }
    }
    Some(selected)
}

fn prepare_owner(
    program: &CheckedProgram,
    ir: &IrProgram,
    fresh: &IrProgram,
    owner: &IrItem,
    original: &CheckedScenarioDisclosure,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<Vec<usize>> {
    let IrItemKind::Scenario {
        guards,
        effects,
        trusted,
        read: false,
        event_source,
        hook,
        cohort,
        ..
    } = &owner.kind
    else {
        return None;
    };
    // C23 hook slice: the declared-event void single-first handler shares
    // the generic decision/return inventory below; every other trusted
    // shape keeps the refusal (mirrors the native receipt gate).
    check_owner_hook(
        *trusted,
        matches!(
            event_source,
            Some(crate::codegen::ir::IrEventSource::Declared(_))
        ),
        event_source.is_some(),
        hook.is_some(),
        cohort.is_some(),
    )?;
    super::source_correspondence::same_scenario_semantics(program, ir, fresh, owner)?;
    super::source_correspondence::same_scenario_semantics(
        program,
        ir,
        fresh,
        ir.items.get(owner.id.0 as usize)?,
    )?;
    let sites = super::scenario_decisions::collect_decision_sources_with_fresh(
        program, ir, owner, db, catalog, fresh,
    )?;
    // Accepted bounded native profiles keep their original transport inventory.
    // Projection is needed only for the demonstrated oversized source closure
    // or a nullable stored reference narrowed by its compulsory requirements.
    if !requires_projection(original, ir) {
        return Some((0..original.returns.len()).collect());
    }
    match_contract_schemas(ir, fresh, original, db)?;
    let requirements = collect_requirements(&sites, owner, effects, guards)?;
    select_possible_returns((program, ir, fresh), original, &requirements)
}

fn branches_reached(
    returned: &DisclosureReturn,
    branches: &[(Span, DisclosureChoice)],
) -> Option<bool> {
    for (span, expected) in branches {
        let mut choices = returned.decisions.iter().filter(|decision| {
            decision.calls.is_empty()
                && decision.node.kind == SyntaxKind::If as u8
                && same_span(decision.node, *span)
        });
        let Some(choice) = choices.next() else {
            return Some(false);
        };
        if choices.next().is_some() {
            return None;
        }
        match &choice.choice {
            DisclosureChoice::Then | DisclosureChoice::Else => {
                if &choice.choice != expected {
                    return Some(false);
                }
            }
            _ => return None,
        }
    }
    Some(true)
}

fn eval_and(
    input: (&CheckedProgram, &IrProgram, &IrProgram),
    expression: &TypedExpr,
    returned: &DisclosureReturn,
    site: &CheckedDecisionSite,
    chain: &[CheckedDecisionCallFrame],
    stack: &mut HashSet<SymbolId>,
    depth: usize,
    steps: &mut usize,
    left: &TypedExpr,
    right: &TypedExpr,
) -> Option<bool> {
    let (program, ir, fresh) = input;
    let node = NodeKey {
        file: expression.span.file,
        start: expression.span.start,
        end: expression.span.end,
        kind: SyntaxKind::Binary as u8,
    };
    if program.types.node_types.get(&node) != Some(&expression.ty) {
        return None;
    }
    let calls: Vec<_> = chain.iter().map(|frame| frame.node).collect();
    let mut choices = returned
        .decisions
        .iter()
        .filter(|decision| decision.node == node && decision.calls == calls);
    let choice = &choices.next()?.choice;
    if choices.next().is_some() {
        return None;
    }
    match choice {
        DisclosureChoice::RhsSkipped => Some(false),
        DisclosureChoice::RhsEvaluated => Some(
            possibly_true(
                (program, ir, fresh),
                left,
                (site, returned),
                chain,
                stack,
                depth + 1,
                steps,
            )? && possibly_true(
                (program, ir, fresh),
                right,
                (site, returned),
                chain,
                stack,
                depth + 1,
                steps,
            )?,
        ),
        _ => None,
    }
}

fn param_identity_mismatch(
    actual: &IrItem,
    expected: &IrItem,
    parameter: SymbolId,
    callee_module: ModuleId,
    id: SymbolId,
    index: usize,
    owner: SymbolId,
    expected_owner: SymbolId,
    ordinal: usize,
    expected_ordinal: usize,
) -> bool {
    actual.id != parameter
        || expected.id != parameter
        || actual.module != callee_module
        || actual.module != expected.module
        || actual.span != expected.span
        || actual.name != expected.name
        || actual.canonical != expected.canonical
        || owner != id
        || owner != expected_owner
        || ordinal != index
        || ordinal != expected_ordinal
}

fn param_shape_mismatch(
    ty: &IrType,
    expected_ty: &IrType,
    default: &Option<IrDefault>,
    expected_default: &Option<IrDefault>,
    default_node: &Option<NodeKey>,
    expected_node: &Option<NodeKey>,
    default_copy: &Option<SymbolId>,
    expected_copy: &Option<SymbolId>,
    array_bounds: &Option<IrParameterArrayBounds>,
    expected_bounds: &Option<IrParameterArrayBounds>,
    parameter: SymbolId,
    actual: &IrProgram,
    fresh: &IrProgram,
) -> bool {
    !matches!((ty, expected_ty), (IrType::Known(a), IrType::Known(b)) if a == b)
        || default.is_some()
        || expected_default.is_some()
        || default_node != expected_node
        || default_copy != expected_copy
        || !match (array_bounds, expected_bounds) {
            (None, None) => true,
            (Some(a), Some(b)) => a.min == b.min && a.max == b.max,
            _ => false,
        }
        || actual.value_constraints.get(&parameter) != fresh.value_constraints.get(&parameter)
}

fn check_derive_params(
    actual: &IrProgram,
    fresh: &IrProgram,
    callee_module: ModuleId,
    id: SymbolId,
    params: &[SymbolId],
) -> Option<()> {
    for (index, parameter) in params.iter().enumerate() {
        let actual_item = actual.items.get(parameter.0 as usize)?;
        let expected_item = fresh.items.get(parameter.0 as usize)?;
        let (
            IrItemKind::Param {
                owner,
                index: ordinal,
                ty,
                default,
                default_node,
                default_copy_source,
                array_bounds,
                ..
            },
            IrItemKind::Param {
                owner: expected_owner,
                index: expected_ordinal,
                ty: expected_ty,
                default: expected_default,
                default_node: expected_node,
                default_copy_source: expected_copy,
                array_bounds: expected_bounds,
                ..
            },
        ) = (&actual_item.kind, &expected_item.kind)
        else {
            return None;
        };
        if param_identity_mismatch(
            actual_item,
            expected_item,
            *parameter,
            callee_module,
            id,
            index,
            *owner,
            *expected_owner,
            *ordinal,
            *expected_ordinal,
        ) || param_shape_mismatch(
            ty,
            expected_ty,
            default,
            expected_default,
            default_node,
            expected_node,
            default_copy_source,
            expected_copy,
            array_bounds,
            expected_bounds,
            *parameter,
            actual,
            fresh,
        ) {
            return None;
        }
    }
    Some(())
}

fn callee_mismatch(
    callee: &IrItem,
    expected: &IrItem,
    id: SymbolId,
    name: &String,
    params: &[SymbolId],
    expected_params: &[SymbolId],
    result: &ResolvedType,
    expected_result: &ResolvedType,
    body: &TypedExpr,
    expected_body: &TypedExpr,
    call_slots: &[Option<usize>],
    slots: &[Option<usize>],
    args_len: usize,
    defaults_empty: bool,
    stack: &mut HashSet<SymbolId>,
) -> bool {
    callee.id != id
        || callee.canonical != *name
        || callee.module != expected.module
        || callee.canonical != expected.canonical
        || callee.span != expected.span
        || params != expected_params
        || result != &ResolvedType::Scalar(Scalar::Bool)
        || expected_result != result
        || body.ty != *result
        || expected_body.ty != *result
        || call_slots != slots
        || slots.len() != params.len()
        || args_len != params.len()
        || slots.iter().any(Option::is_none)
        || !defaults_empty
        || !stack.insert(id)
}

fn eval_derive_call(
    input: (&CheckedProgram, &IrProgram, &IrProgram),
    expression: &TypedExpr,
    site: &CheckedDecisionSite,
    returned: &DisclosureReturn,
    chain: &[CheckedDecisionCallFrame],
    stack: &mut HashSet<SymbolId>,
    depth: usize,
    steps: &mut usize,
    name: &String,
    args: &[TypedExpr],
) -> Option<bool> {
    let (program, ir, fresh) = input;
    let mut matching = site.calls.iter().filter(|call| {
        same_span(call.node, expression.span)
            && call.chain == chain
            && matches!(call.target, CheckedDecisionCallTarget::DeriveFn(_))
    });
    let call = matching.next()?;
    if matching.next().is_some() {
        return None;
    }
    let CheckedDecisionCallTarget::DeriveFn(id) = call.target else {
        return None;
    };
    let callee = ir.items.get(id.0 as usize)?;
    let expected = fresh.items.get(id.0 as usize)?;
    let (
        IrItemKind::DeriveFn {
            params,
            result: IrType::Known(result),
            expr: Some(body),
        },
        IrItemKind::DeriveFn {
            params: expected_params,
            result: IrType::Known(expected_result),
            expr: Some(expected_body),
        },
    ) = (&callee.kind, &expected.kind)
    else {
        return None;
    };
    let slots: Vec<_> = match &expression.expr {
        IrExpr::BoundCall { slots, .. } => slots.clone(),
        _ => (0..args.len()).map(Some).collect(),
    };
    if callee_mismatch(
        callee,
        expected,
        id,
        name,
        params,
        expected_params,
        result,
        expected_result,
        body,
        expected_body,
        &call.slots,
        &slots,
        args.len(),
        call.defaults.is_empty(),
        stack,
    ) {
        return None;
    }
    check_derive_params(ir, fresh, callee.module, id, params)?;
    let mut nested = chain.to_vec();
    nested.push(CheckedDecisionCallFrame {
        node: call.node,
        module: call.module,
        source: call.source.clone(),
        derive: id,
    });
    let possible = possibly_true(
        (program, ir, fresh),
        body,
        (site, returned),
        &nested,
        stack,
        depth + 1,
        steps,
    );
    stack.remove(&id);
    possible
}

fn possibly_true(
    input: (&CheckedProgram, &IrProgram, &IrProgram),
    expression: &TypedExpr,
    path: (&CheckedDecisionSite, &DisclosureReturn),
    chain: &[CheckedDecisionCallFrame],
    stack: &mut HashSet<SymbolId>,
    depth: usize,
    steps: &mut usize,
) -> Option<bool> {
    let (program, ir, fresh) = input;
    let (site, returned) = path;
    *steps += 1;
    if *steps > 16384
        || depth > 64
        || chain.len() > 16
        || expression.ty != ResolvedType::Scalar(Scalar::Bool)
    {
        return None;
    }
    match &expression.expr {
        IrExpr::Binary {
            op: IrBinOp::And,
            left,
            right,
        } => {
            eval_and(
                (program, ir, fresh),
                expression,
                returned,
                site,
                chain,
                stack,
                depth,
                steps,
                left,
                right,
            )
        }
        IrExpr::Call {
            target: IrCallTarget::DeriveFn(name),
            args,
        }
        | IrExpr::BoundCall {
            target: IrCallTarget::DeriveFn(name),
            args,
            ..
        } => {
            eval_derive_call(
                (program, ir, fresh),
                expression,
                site,
                returned,
                chain,
                stack,
                depth,
                steps,
                name,
                args,
            )
        }
        // Member/equality/builtin values, OR/NOT and other shapes remain
        // unknown: either value is possible. No leaf is evaluated or promoted.
        _ => Some(true),
    }
}

fn same_span(node: NodeKey, span: Span) -> bool {
    node.file == span.file && node.start == span.start && node.end == span.end
}

pub(super) fn same_disclosure(
    a: &CheckedScenarioDisclosure,
    b: &CheckedScenarioDisclosure,
) -> bool {
    a.scenario == b.scenario
        && a.node == b.node
        && a.source == b.source
        && a.effects == b.effects
        && a.require_consumptions == b.require_consumptions
        && a.returns.len() == b.returns.len()
        && !a.returns.is_empty()
        && a.returns.len() <= 1024
        && a.returns.iter().zip(&b.returns).all(|(a, b)| {
            a.id == b.id
                && a.node == b.node
                && a.source == b.source
                && a.decisions == b.decisions
                && a.dependencies == b.dependencies
                && a.intrinsics == b.intrinsics
                && a.influences == b.influences
                && a.model_result == b.model_result
        })
        && match (&a.source_facts, &b.source_facts) {
            (Some(a), Some(b)) => same_source(a, b),
            _ => false,
        }
}

fn same_source(a: &CheckedScenarioSource, b: &CheckedScenarioSource) -> bool {
    a.scenario == b.scenario
        && a.node == b.node
        && a.source == b.source
        && a.read == b.read
        && a.result == b.result
        && a.expression_types == b.expression_types
        && a.decision_sites == b.decision_sites
        && a.source_requires == b.source_requires
        && a.queries == b.queries
        && a.transcripts == b.transcripts
        && a.inline_selections == b.inline_selections
        && same_slice(&a.parameters, &b.parameters, |a, b| {
            a.parameter == b.parameter
                && a.node == b.node
                && a.type_node == b.type_node
                && a.ty == b.ty
                && a.default == b.default
                && a.constraints == b.constraints
        })
        && same_slice(&a.calls, &b.calls, |a, b| {
            a.node == b.node
                && a.target_node == b.target_node
                && a.operation == b.operation
                && a.binding == b.binding
                && a.result == b.result
                && same_slice(&a.inputs, &b.inputs, |a, b| {
                    a.name == b.name && a.node == b.node && a.ty == b.ty
                })
        })
        && same_optional(&a.creates, &b.creates, same_create)
        && same_optional(&a.stored_contracts, &b.stored_contracts, same_stored_schema)
}

fn same_slice<T>(a: &[T], b: &[T], equal: impl Fn(&T, &T) -> bool) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
}
fn same_optional<T>(
    a: &Option<Vec<T>>,
    b: &Option<Vec<T>>,
    equal: impl Fn(&T, &T) -> bool,
) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => same_slice(a, b, equal),
        _ => false,
    }
}
fn same_create(a: &CheckedScenarioCreate, b: &CheckedScenarioCreate) -> bool {
    a.node == b.node
        && a.target_node == b.target_node
        && a.source == b.source
        && a.model == b.model
        && a.binding == b.binding
        && a.inputs == b.inputs
        && a.expression_types == b.expression_types
        && a.definition.canonical == b.definition.canonical
        && a.definition.source == b.definition.source
        && a.definition.span == b.definition.span
        && same_model(&a.definition.declaration, &b.definition.declaration)
        && a.definition.contributed == b.definition.contributed
        && same_slice(&a.definition.fields, &b.definition.fields, |a, b| {
            a.field == b.field
                && a.name == b.name
                && a.canonical == b.canonical
                && a.source == b.source
                && a.ty == b.ty
                && a.constraints == b.constraints
                && a.reuse == b.reuse
        })
}
fn same_model(a: &ModelData, b: &ModelData) -> bool {
    a.model == b.model
        && a.module == b.module
        && a.node == b.node
        && a.label == b.label
        && a.owner == b.owner
        && a.fields == b.fields
        && same_slice(&a.policies, &b.policies, |a, b| {
            (
                a.id,
                a.module,
                a.node,
                a.read,
                a.where_predicate,
                &a.fields,
                &a.callback_fields,
                a.fields_node,
            ) == (
                b.id,
                b.module,
                b.node,
                b.read,
                b.where_predicate,
                &b.fields,
                &b.callback_fields,
                b.fields_node,
            )
        })
        && same_slice(&a.invariants, &b.invariants, |a, b| {
            (a.id, a.module, a.node, a.target, a.predicate)
                == (b.id, b.module, b.node, b.target, b.predicate)
        })
        && same_slice(&a.uniques, &b.uniques, |a, b| {
            (
                a.id,
                a.module,
                a.node,
                &a.fields,
                a.fields_node,
                a.where_predicate,
            ) == (
                b.id,
                b.module,
                b.node,
                &b.fields,
                b.fields_node,
                b.where_predicate,
            )
        })
        && same_slice(&a.locks, &b.locks, |a, b| {
            (a.id, a.module, a.node, &a.fields, a.fields_node, a.when)
                == (b.id, b.module, b.node, &b.fields, b.fields_node, b.when)
        })
        && same_slice(&a.retains, &b.retains, |a, b| {
            (a.id, a.module, a.node, a.until) == (b.id, b.module, b.node, b.until)
        })
}
fn same_stored_schema(a: &CheckedStoredContractSchema, b: &CheckedStoredContractSchema) -> bool {
    a.id == b.id
        && a.canonical == b.canonical
        && a.module == b.module
        && a.span == b.span
        && a.source == b.source
        && a.model == b.model
        && a.parent == b.parent
        && a.owner == b.owner
        && a.field_order == b.field_order
        && same_slice(&a.fields, &b.fields, |a, b| {
            a.id == b.id
                && a.canonical == b.canonical
                && a.name == b.name
                && a.owner == b.owner
                && a.span == b.span
                && a.source == b.source
                && a.ty == b.ty
                && a.required_array == b.required_array
                && a.declared == b.declared
                && a.constraints == b.constraints
                && a.contributed == b.contributed
                && a.reuse == b.reuse
                && a.trim == b.trim
                && a.min == b.min
                && a.max == b.max
        })
}

