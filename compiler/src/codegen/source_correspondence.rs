//! Structural comparison against the fresh original lowering; no execution authority.
use super::ir::*;
use super::scenario_decisions::{checked_contained_query, checked_query, collection_lambda};
use super::source_context::FreshSourceContext;
use crate::analysis::{CheckedProgram, ResolvedType, Scalar};
use crate::source::Span;
use std::collections::HashSet;

/// Join the executable scenario to a fresh lowering of its original checker.
/// Shared by independent nongrant source producers; it does not require a
/// supported native decision capture profile.
fn check_owner_identity<'a>(expected: &'a IrProgram, owner: &IrItem) -> Option<&'a IrItem> {
    let original = expected.items.get(owner.id.0 as usize)?;
    if owner.id != original.id
        || owner.module != original.module
        || owner.canonical != original.canonical
        || owner.span != original.span
    {
        return None;
    }
    Some(original)
}

fn join_scenario_lists<'x>(
    owner: &'x IrItem,
    original: &'x IrItem,
    private_cohort: bool,
) -> Option<(
    &'x Vec<crate::analysis::resolve::SymbolId>,
    &'x Vec<IrGuard>,
    &'x Vec<IrStmt>,
    &'x Vec<IrStmt>,
    &'x Vec<crate::analysis::resolve::SymbolId>,
    &'x Vec<IrGuard>,
    &'x Vec<IrStmt>,
    &'x Vec<IrStmt>,
)> {
    let (
        IrItemKind::Scenario {
            params: a,
            trusted: at,
            result: ar,
            read: ad,
            expose_excluded: ax,
            by: ab,
            guards: ag,
            effects: ae,
            event_source: av,
            hook: ah,
            cohort: ac,
            ..
        },
        IrItemKind::Scenario {
            params: b,
            trusted: bt,
            result: br,
            read: bd,
            expose_excluded: bx,
            by: bb,
            guards: bg,
            effects: be,
            event_source: bv,
            hook: bh,
            cohort: bc,
            ..
        },
    ) = (&owner.kind, &original.kind)
    else {
        return None;
    };
    // Query source transport has no hook/cohort execution authority. A
    // declared-event handler may still prove its own identical trigger on
    // both sides (C23 hook slice). Only the separate private handler join
    // accepts an exact model cohort; pre-commit hooks always stay out.
    if a != b
        || at != bt
        || ar != br
        || ad != bd
        || ax != bx
        || av != bv
        || ah.is_some()
        || bh.is_some()
        || match (ac, bc) {
            (None, None) => false,
            (Some(a), Some(b)) if private_cohort => {
                a.kind != IrCohortKind::Model
                    || b.kind != IrCohortKind::Model
                    || a.model != b.model
                    || a.bind != b.bind
                    || a.parent.is_some()
                    || b.parent.is_some()
                    || a.span != b.span
                    || a.bind.as_deref().is_none_or(str::is_empty)
            }
            _ => true,
        }
    {
        return None;
    }
    Some((a, ab, ag, ae, b, bb, bg, be))
}

fn join_semantic_params(
    join: &mut SemanticJoin,
    actual: &IrProgram,
    expected: &IrProgram,
    owner: crate::analysis::resolve::SymbolId,
    a: &[crate::analysis::resolve::SymbolId],
) -> Option<()> {
    for id in a {
        let (x, y) = (
            actual.items.get(id.0 as usize)?,
            expected.items.get(id.0 as usize)?,
        );
        let (
            IrItemKind::Param {
                owner: xo,
                index: xi,
                ty: xt,
                default: xd,
                default_node: xn,
                ..
            },
            IrItemKind::Param {
                owner: yo,
                index: yi,
                ty: yt,
                default: yd,
                default_node: yn,
                ..
            },
        ) = (&x.kind, &y.kind)
        else {
            return None;
        };
        if x.id != *id
            || y.id != *id
            || x.canonical != y.canonical
            || x.name != y.name
            || x.module != y.module
            || x.span != y.span
            || xo != yo
            || *xo != owner
            || xi != yi
            || xn != yn
            || !known_type_equal(xt, yt)
        {
            return None;
        }
        match (xd, yd) {
            (None, None) => {}
            (Some(IrDefault::Literal(x)), Some(IrDefault::Literal(y))) => {
                join.expression(x, y, 0)?
            }
            (
                Some(IrDefault::Computed { expr: x, .. }),
                Some(IrDefault::Computed { expr: y, .. }),
            ) => join.expression(x, y, 0)?,
            _ => return None,
        }
    }
    Some(())
}

pub(super) fn same_scenario_semantics(
    program: &CheckedProgram,
    actual: &IrProgram,
    expected: &IrProgram,
    owner: &IrItem,
) -> Option<()> {
    join_scenario_semantics(program, actual, expected, owner, false)
}

/// Private model-cohort children have their own owning runtime admission.
/// This seals only their original body; ordinary query/profile source joins
/// continue to reject every cohort through `same_scenario_semantics`.
pub(super) fn same_private_handler_semantics(
    program: &CheckedProgram,
    actual: &IrProgram,
    expected: &IrProgram,
    owner: &IrItem,
) -> Option<()> {
    let IrItemKind::Scenario {
        trusted: true,
        result: None,
        read: false,
        expose_excluded: false,
        scope_authority: false,
        params,
        by,
        hook: None,
        event_source: Some(IrEventSource::Declared(_)),
        cohort: Some(cohort),
        ..
    } = &owner.kind
    else {
        return None;
    };
    if !params.is_empty() || !by.is_empty() {
        return None;
    }
    let a = actual.items.get(cohort.model.0 as usize)?;
    let b = expected.items.get(cohort.model.0 as usize)?;
    let (
        IrItemKind::Model {
            owner: a_owner,
            fields: a_fields,
            ..
        },
        IrItemKind::Model {
            owner: b_owner,
            fields: b_fields,
            ..
        },
    ) = (&a.kind, &b.kind)
    else {
        return None;
    };
    if a.id != b.id
        || a.module != b.module
        || a.canonical != b.canonical
        || a.name != b.name
        || a.span != b.span
        || a_owner != b_owner
        || a_fields != b_fields
    {
        return None;
    }
    join_scenario_semantics(program, actual, expected, owner, true)
}

fn join_scenario_semantics(
    program: &CheckedProgram,
    actual: &IrProgram,
    expected: &IrProgram,
    owner: &IrItem,
    private_cohort: bool,
) -> Option<()> {
    let original = check_owner_identity(expected, owner)?;
    let (a, ab, ag, ae, _b, bb, bg, be) = join_scenario_lists(owner, original, private_cohort)?;
    let mut join = SemanticJoin {
        program,
        actual,
        expected,
        nodes: 0,
        stack: HashSet::new(),
    };
    join_semantic_params(&mut join, actual, expected, owner.id, a)?;
    if ab.len() != bb.len() {
        return None;
    }
    for (a, b) in ab.iter().zip(bb) {
        join.guard(a, b, 0)?;
    }
    join.statements(ag, bg, 0)?;
    join.statements(ae, be, 0)
}

/// Pure query helpers use the same complete source join as scenario bodies.
/// This seals declarations and expressions, without selecting a read authority.
pub(super) fn same_derive_semantics(
    program: &CheckedProgram,
    actual: &IrProgram,
    expected: &IrProgram,
    owner: &IrItem,
) -> Option<()> {
    let original = check_owner_identity(expected, owner)?;
    let (
        IrItemKind::DeriveFn {
            params: a,
            result: ar,
            expr: Some(ae),
        },
        IrItemKind::DeriveFn {
            params: b,
            result: br,
            expr: Some(be),
        },
    ) = (&owner.kind, &original.kind)
    else {
        return None;
    };
    if a != b
        || !known_type_equal(ar, br)
        || owner.name != original.name
        || owner.exported != original.exported
    {
        return None;
    }
    let mut join = SemanticJoin {
        program,
        actual,
        expected,
        nodes: 0,
        stack: HashSet::new(),
    };
    join_semantic_params(&mut join, actual, expected, owner.id, a)?;
    join.expression(ae, be, 0)
}

/// A nullable local delivery retains its original declared operation only;
/// this seal grants no send or result observation producer.
pub(super) fn same_capability_operation(
    context: &FreshSourceContext<'_>,
    op: crate::analysis::SymbolId,
) -> Option<()> {
    let actual = context.ir();
    let expected = context.fresh();
    let a = actual.items.get(op.0 as usize)?;
    let b = expected.items.get(op.0 as usize)?;
    let (
        IrItemKind::CapabilityOp {
            params: ap,
            result: ar,
        },
        IrItemKind::CapabilityOp {
            params: bp,
            result: br,
        },
    ) = (&a.kind, &b.kind)
    else {
        return None;
    };
    let identity = |a: &IrItem, b: &IrItem| {
        a.id == b.id
            && a.canonical == b.canonical
            && a.name == b.name
            && a.module == b.module
            && a.span == b.span
    };
    if !identity(a, b) || ap != bp || !known_type_equal(ar, br) {
        return None;
    }
    let mut caps = actual
        .items
        .iter()
        .filter(|item| matches!(&item.kind,IrItemKind::Capability{ops,..} if ops.contains(&op)));
    let cap = caps.next()?;
    if caps.next().is_some() {
        return None;
    }
    let original = expected.items.get(cap.id.0 as usize)?;
    let (
        IrItemKind::Capability {
            ops: ao,
            events: ae,
            version: av,
        },
        IrItemKind::Capability {
            ops: bo,
            events: be,
            version: bv,
        },
    ) = (&cap.kind, &original.kind)
    else {
        return None;
    };
    if !identity(cap, original) || ao != bo || ae != be || av != bv {
        return None;
    }
    let mut join = SemanticJoin {
        program: context.original(),
        actual,
        expected,
        nodes: 0,
        stack: HashSet::new(),
    };
    join_semantic_params(&mut join, actual, expected, op, ap)?;
    for id in ap {
        let (
            IrItemKind::Param {
                default_copy_source: a,
                array_bounds: ab,
                ..
            },
            IrItemKind::Param {
                default_copy_source: b,
                array_bounds: bb,
                ..
            },
        ) = (
            &actual.items.get(id.0 as usize)?.kind,
            &expected.items.get(id.0 as usize)?.kind,
        )
        else {
            return None;
        };
        if a != b || ab.as_ref().map(|b| (b.min, b.max)) != bb.as_ref().map(|b| (b.min, b.max)) {
            return None;
        }
    }
    Some(())
}

// Compare typed semantic structure against the original lowering, never text/debug output.
pub(super) struct SemanticJoin<'a> {
    pub(super) program: &'a CheckedProgram,
    pub(super) actual: &'a IrProgram,
    pub(super) expected: &'a IrProgram,
    pub(super) nodes: usize,
    pub(super) stack: HashSet<crate::analysis::resolve::SymbolId>,
}
impl SemanticJoin<'_> {
    fn budget(&mut self, depth: usize) -> Option<()> {
        self.nodes += 1;
        if depth > 64 || self.nodes > 16384 {
            None
        } else {
            Some(())
        }
    }
    fn leaf_corresponds(a: &IrExpr, b: &IrExpr) -> bool {
        match (a, b) {
            (IrExpr::Int(a), IrExpr::Int(b)) => a == b,
            (IrExpr::Text(a), IrExpr::Text(b)) => a == b,
            (IrExpr::Bool(a), IrExpr::Bool(b)) => a == b,
            (IrExpr::Null, IrExpr::Null) => true,
            (IrExpr::Name(a), IrExpr::Name(b)) => a == b,
            (IrExpr::Decimal(a), IrExpr::Decimal(b)) => a == b,
            (IrExpr::DurationMs(a), IrExpr::DurationMs(b)) => a == b,
            (IrExpr::Date(a), IrExpr::Date(b)) => a == b,
            (IrExpr::Datetime(a), IrExpr::Datetime(b)) => a == b,
            (
                IrExpr::Money {
                    minor: a,
                    currency: x,
                },
                IrExpr::Money {
                    minor: b,
                    currency: y,
                },
            ) => a == b && x == y,
            // Identical checked placeholders correspond exactly. Both sides
            // lower to the same throwing placeholder (IR build and codegen
            // still report their own E6008), so recognizing the
            // correspondence neither executes the gap nor masks it. `ty` and
            // `span` equality is established on entry; any differing
            // `what`/`why` still refuses. The single-tree executability
            // check keeps refusing every placeholder.
            (IrExpr::Unsupported { what: x, why: p }, IrExpr::Unsupported { what: y, why: q })
                if x == y && p == q =>
            {
                true
            }
            // A checked page-time predicate is data-only render filtering
            // (`row.datetime >= now`); its recorded model field,
            // comparison, spans, and paging support fully determine the
            // sealed meaning on both sides.
            (IrExpr::PageTimePredicate(a), IrExpr::PageTimePredicate(b)) => a.corresponds(b),
            _ => false,
        }
    }
    fn join_member_derive(&mut self, a: &TypedExpr, b: &TypedExpr, depth: usize) -> Option<bool> {
        let (IrExpr::Member { base: x, field: f }, IrExpr::Member { base: y, field: g }) =
            (&a.expr, &b.expr)
        else {
            return Some(false);
        };
        if f != g {
            return Some(false);
        }
        self.expression(x, y, depth + 1)?;
        // A derived member can be inlined into an owning source
        // observer. Its executable body belongs to that same source
        // comparison, rather than only the Member's spelling/type.
        if let ResolvedType::Record { symbol: model, .. } = &y.ty
            && let Some(expected) = self.expected.items.iter().find(|item| {
                item.name == *g
                    && matches!(item.kind,
                    IrItemKind::DeriveField { model: owner, .. } if owner == *model)
            })
        {
            let actual = self.actual.items.get(expected.id.0 as usize)?;
            let (
                IrItemKind::DeriveField {
                    model: actual_model,
                    ty: actual_ty,
                    expr: Some(actual_body),
                    ..
                },
                IrItemKind::DeriveField {
                    model: expected_model,
                    ty: expected_ty,
                    expr: Some(expected_body),
                    ..
                },
            ) = (&actual.kind, &expected.kind)
            else {
                return None;
            };
            if actual.id != expected.id
                || actual.name != expected.name
                || actual.module != expected.module
                || actual.canonical != expected.canonical
                || actual.span != expected.span
                || actual_model != expected_model
                || !known_type_equal(actual_ty, expected_ty)
                || self.stack.len() >= 16
                || !self.stack.insert(expected.id)
            {
                return None;
            }
            self.expression(actual_body, expected_body, depth + 1)?;
            self.stack.remove(&expected.id);
        }
        Some(true)
    }
    fn join_call_like(
        &mut self,
        a: &TypedExpr,
        b: &TypedExpr,
        call_span: Span,
        span: Span,
        ty: &ResolvedType,
        depth: usize,
    ) -> Option<bool> {
        match (&a.expr, &b.expr) {
            (IrExpr::Call { target: x, args: a }, IrExpr::Call { target: y, args: b }) => {
                self.target(x, y, depth + 1, None)?;
                self.call_arguments(a, b, depth + 1, call_span)?;
                Some(true)
            }
            (
                IrExpr::BoundCall {
                    target: x,
                    args: a,
                    slots: s,
                },
                IrExpr::BoundCall {
                    target: y,
                    args: b,
                    slots: t,
                },
            ) if s == t => {
                self.target(x, y, depth + 1, Some(s))?;
                self.call_arguments(a, b, depth + 1, call_span)?;
                Some(true)
            }
            (IrExpr::Query(x), IrExpr::Query(y)) => {
                self.query(x, y, span, ty, depth + 1)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn join_simple_recursive(
        &mut self,
        a: &TypedExpr,
        b: &TypedExpr,
        depth: usize,
    ) -> Option<bool> {
        match (&a.expr, &b.expr) {
            (
                IrExpr::Binary {
                    op: x,
                    left: a,
                    right: c,
                },
                IrExpr::Binary {
                    op: y,
                    left: b,
                    right: d,
                },
            ) if x == y => {
                self.expression(a, b, depth + 1)?;
                self.expression(c, d, depth + 1)?;
                Some(true)
            }
            (IrExpr::Unary { op: x, operand: a }, IrExpr::Unary { op: y, operand: b })
                if x == y =>
            {
                self.expression(a, b, depth + 1)?;
                Some(true)
            }
            (IrExpr::Array(a), IrExpr::Array(b)) => {
                self.expressions(a, b, depth + 1)?;
                Some(true)
            }
            (IrExpr::Object(a), IrExpr::Object(b)) if a.len() == b.len() => {
                for ((x, a), (y, b)) in a.iter().zip(b) {
                    if x != y {
                        return None;
                    }
                    self.expression(a, b, depth + 1)?;
                }
                Some(true)
            }
            (IrExpr::Lambda { param: x, body: a }, IrExpr::Lambda { param: y, body: b })
                if x == y =>
            {
                self.expression(a, b, depth + 1)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn join_has_role(&mut self, a: &TypedExpr, b: &TypedExpr, depth: usize) -> Option<bool> {
        let (IrExpr::HasRole { role: x, person: a }, IrExpr::HasRole { role: y, person: b }) =
            (&a.expr, &b.expr)
        else {
            return Some(false);
        };
        if x != y {
            return Some(false);
        }
        match (a, b) {
            (None, None) => Some(true),
            (Some(a), Some(b)) => {
                self.expression(a, b, depth + 1)?;
                Some(true)
            }
            _ => None,
        }
    }
    fn join_message_like(&mut self, a: &TypedExpr, b: &TypedExpr, depth: usize) -> Option<bool> {
        match (&a.expr, &b.expr) {
            (IrExpr::Message(a), IrExpr::Message(b)) => {
                self.message(a, b, depth + 1)?;
                Some(true)
            }
            (
                IrExpr::MessageCall {
                    descriptor: a,
                    args: x,
                    params: p,
                },
                IrExpr::MessageCall {
                    descriptor: b,
                    args: y,
                    params: q,
                },
            ) if p.len() == q.len() => {
                self.message(a, b, depth + 1)?;
                self.expressions(x, y, depth + 1)?;
                self.join_message_params(p, q, depth)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn join_message_params(
        &mut self,
        p: &[IrMessageCallParam],
        q: &[IrMessageCallParam],
        depth: usize,
    ) -> Option<()> {
        for (p, q) in p.iter().zip(q) {
            if p.name != q.name || p.type_id != q.type_id || p.source != q.source {
                return None;
            }
            self.optional(&p.default, &q.default, depth + 1)?;
        }
        Some(())
    }
    fn join_special_read(&mut self, a: &TypedExpr, b: &TypedExpr, depth: usize) -> Option<bool> {
        match (&a.expr, &b.expr) {
            (
                IrExpr::Format {
                    args: a,
                    descriptor_index: x,
                    locale_index: u,
                    schemas: p,
                },
                IrExpr::Format {
                    args: b,
                    descriptor_index: y,
                    locale_index: v,
                    schemas: q,
                },
            ) if x == y && u == v && p == q => {
                self.expressions(a, b, depth + 1)?;
                Some(true)
            }
            (
                IrExpr::DeliveryRead {
                    record: x,
                    field: p,
                    props: i,
                    callback: a_callback,
                },
                IrExpr::DeliveryRead {
                    record: y,
                    field: q,
                    props: j,
                    callback: b_callback,
                },
            ) if p == q && i == j => {
                self.expression(x, y, depth + 1)?;
                self.join_delivery_callback(a_callback, b_callback, a, b, x, y, p, q, i, j)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn join_delivery_callback(
        &mut self,
        a_callback: &Option<Box<CheckedGenerationCallbackRead>>,
        b_callback: &Option<Box<CheckedGenerationCallbackRead>>,
        a: &TypedExpr,
        b: &TypedExpr,
        x: &TypedExpr,
        y: &TypedExpr,
        p: &str,
        q: &str,
        i: &[String],
        j: &[String],
    ) -> Option<()> {
        match (a_callback, b_callback) {
            (None, None) => Some(()),
            (Some(ap), Some(bp))
                if ap.matches(self.actual, a, x, p, i) && bp.matches(self.expected, b, y, q, j) =>
            {
                Some(())
            }
            _ => None,
        }
    }
    /// A constructed nominal value also consumes its defining schema and
    /// creation defaults. Equal object entries alone cannot seal a substituted
    /// Contract/Event, field declaration or default elsewhere in mutable IR.
    fn constructor_schema(
        &mut self,
        ty: &ResolvedType,
        depth: usize,
        active: &mut HashSet<crate::analysis::resolve::SymbolId>,
    ) -> Option<()> {
        self.budget(depth)?;
        match ty {
            ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
                self.constructor_schema(inner, depth + 1, active)
            }
            ResolvedType::Record { symbol, .. } => {
                let expected = self.expected.items.get(symbol.0 as usize)?;
                let fields = match &expected.kind {
                    IrItemKind::Contract { fields, .. } | IrItemKind::Event { fields } => fields,
                    _ => return Some(()),
                };
                let actual = self.actual.items.get(symbol.0 as usize)?;
                let current = match (&expected.kind, &actual.kind) {
                    (IrItemKind::Contract { .. }, IrItemKind::Contract { fields, .. })
                    | (IrItemKind::Event { .. }, IrItemKind::Event { fields }) => fields,
                    _ => return None,
                };
                let (a_module, b_module) = (
                    self.actual.modules.get(actual.module.0 as usize)?,
                    self.expected.modules.get(expected.module.0 as usize)?,
                );
                if a_module.id != actual.module
                    || a_module.id != b_module.id
                    || a_module.name != b_module.name
                    || a_module.kind != b_module.kind
                    || a_module.file != b_module.file
                    || a_module.span != b_module.span
                    || expected.span.file != b_module.file
                {
                    return None;
                }
                if actual.id != *symbol
                    || expected.id != *symbol
                    || actual.module != expected.module
                    || actual.name != expected.name
                    || actual.canonical != expected.canonical
                    || actual.span != expected.span
                    || actual.exported != expected.exported
                    || fields != current
                    || fields.len() > 200
                    || !active.insert(*symbol)
                {
                    return None;
                }
                for id in fields {
                    self.budget(depth + 1)?;
                    let (a, b) = (
                        self.actual.items.get(id.0 as usize)?,
                        self.expected.items.get(id.0 as usize)?,
                    );
                    let (
                        IrItemKind::Field {
                            owner: ao,
                            ty: IrType::Known(at),
                            required_array: ar,
                            default: ad,
                            server: None,
                            modifiers: am,
                            ..
                        },
                        IrItemKind::Field {
                            owner: bo,
                            ty: IrType::Known(bt),
                            required_array: br,
                            default: bd,
                            server: None,
                            modifiers: bm,
                            ..
                        },
                    ) = (&a.kind, &b.kind)
                    else {
                        return None;
                    };
                    if a.id != *id
                        || b.id != *id
                        || a.module != b.module
                        || a.module != actual.module
                        || a.name != b.name
                        || a.canonical != b.canonical
                        || a.span != b.span
                        || a.exported != b.exported
                        || *ao != *symbol
                        || ao != bo
                        || at != bt
                        || ar != br
                        || am.trim != bm.trim
                        || am.unique != bm.unique
                        || am.machine != bm.machine
                        || self.actual.value_constraints.get(id)
                            != self.expected.value_constraints.get(id)
                    {
                        return None;
                    }
                    self.optional(&am.min, &bm.min, depth + 1)?;
                    self.optional(&am.max, &bm.max, depth + 1)?;
                    match (ad, bd) {
                        (None, None) => {}
                        (Some(IrDefault::Literal(a)), Some(IrDefault::Literal(b))) => {
                            self.expression(a, b, depth + 1)?
                        }
                        _ => return None,
                    }
                    self.constructor_schema(bt, depth + 1, active)?;
                }
                active.remove(symbol);
                Some(())
            }
            _ => Some(()),
        }
    }

    pub(super) fn expression(&mut self, a: &TypedExpr, b: &TypedExpr, depth: usize) -> Option<()> {
        let call_span = a.span;
        self.budget(depth)?;
        if a.ty != b.ty || a.span != b.span {
            return None;
        }
        if matches!((&a.expr, &b.expr), (IrExpr::Object(_), IrExpr::Object(_))) {
            self.constructor_schema(&b.ty, depth + 1, &mut HashSet::new())?;
        }
        if Self::leaf_corresponds(&a.expr, &b.expr) {
            return Some(());
        }
        if self.join_member_derive(a, b, depth)? {
            return Some(());
        }
        if self.join_call_like(a, b, call_span, a.span, &a.ty, depth)? {
            return Some(());
        }
        if self.join_simple_recursive(a, b, depth)? {
            return Some(());
        }
        if self.join_has_role(a, b, depth)? {
            return Some(());
        }
        if self.join_message_like(a, b, depth)? {
            return Some(());
        }
        if self.join_special_read(a, b, depth)? {
            return Some(());
        }
        None
    }
    pub(super) fn guard(&mut self, a: &IrGuard, b: &IrGuard, depth: usize) -> Option<()> {
        self.budget(depth)?;
        match (a, b) {
            (IrGuard::Role(a), IrGuard::Role(b)) if a == b => {}
            (IrGuard::Subject { role: a, person: x }, IrGuard::Subject { role: b, person: y })
                if a == b =>
            {
                self.expression(x, y, depth + 1)?
            }
            (IrGuard::Expr(a), IrGuard::Expr(b)) => self.expression(a, b, depth + 1)?,
            (IrGuard::And(a), IrGuard::And(b)) | (IrGuard::Or(a), IrGuard::Or(b))
                if a.len() == b.len() =>
            {
                for (a, b) in a.iter().zip(b) {
                    self.guard(a, b, depth + 1)?;
                }
            }
            (IrGuard::Not(a), IrGuard::Not(b)) => self.guard(a, b, depth + 1)?,
            _ => return None,
        }
        Some(())
    }
    pub(super) fn message(&mut self, a: &IrMessage, b: &IrMessage, depth: usize) -> Option<()> {
        self.budget(depth)?;
        if a.source != b.source
            || a.source_lang != b.source_lang
            || a.variants != b.variants
            || a.params.len() != b.params.len()
        {
            return None;
        }
        for (a, b) in a.params.iter().zip(&b.params) {
            if a.name != b.name || a.type_id != b.type_id {
                return None;
            }
            self.expression(&a.value, &b.value, depth + 1)?;
        }
        Some(())
    }
    pub(super) fn ui(&mut self, a: &IrUi, b: &IrUi, depth: usize) -> Option<()> {
        self.budget(depth)?;
        if a.factory != b.factory
            || a.span != b.span
            || a.row_scope != b.row_scope
            || a.props.len() != b.props.len()
            || a.children.len() != b.children.len()
        {
            return None;
        }
        match (&a.view, &b.view) {
            (None, None) => {}
            (Some(a), Some(b)) if a.identity == b.identity => {
                self.expression(&a.argument, &b.argument, depth + 1)?
            }
            _ => return None,
        }
        if matches!(
            a.factory.as_str(),
            "callbackValueList" | "callbackValueCard"
        ) && (!self
            .actual
            .callback_grants
            .matches_value_list(self.actual, a)
            || !self
                .expected
                .callback_grants
                .matches_value_list(self.expected, b))
        {
            return None;
        }
        self.optional(&a.gate, &b.gate, depth + 1)?;
        for ((x, a), (y, b)) in a.props.iter().zip(&b.props) {
            if x != y {
                return None;
            }
            self.expression(a, b, depth + 1)?;
        }
        for (a, b) in a.children.iter().zip(&b.children) {
            self.ui(a, b, depth + 1)?;
        }
        Some(())
    }
    fn call_arguments(
        &mut self,
        a: &[TypedExpr],
        b: &[TypedExpr],
        d: usize,
        call: Span,
    ) -> Option<()> {
        if a.len() != b.len() {
            return None;
        }
        for (x, y) in a.iter().zip(b) {
            match (&x.expr, &y.expr) {
                (
                    IrExpr::Lambda {
                        param: p,
                        body: xbody,
                    },
                    IrExpr::Lambda {
                        param: q,
                        body: ybody,
                    },
                ) if p == q && x.ty == y.ty && x.span == y.span => {
                    collection_lambda(self.program, a, x, call)?;
                    collection_lambda(self.program, b, y, call)?;
                    self.expression(xbody, ybody, d)?;
                }
                _ => self.expression(x, y, d)?,
            }
        }
        Some(())
    }
    fn query_source_ok(
        &mut self,
        a: &IrQuery,
        b: &IrQuery,
        span: Span,
        ty: &ResolvedType,
    ) -> Option<()> {
        match (&a.source, &b.source) {
            (Some(_), Some(_)) => {
                checked_query(self.program, a)?;
                checked_query(self.program, b)?;
            }
            (None, None) => {
                checked_contained_query(self.program, self.actual, a, span, ty)?;
                checked_contained_query(self.program, self.expected, b, span, ty)?;
            }
            _ => return None,
        }
        Some(())
    }
    fn query_ordering_ok(&mut self, a: &IrQuery, b: &IrQuery, d: usize) -> Option<()> {
        match (&a.value_order, &b.value_order) {
            (None, None) => {}
            (Some(x), Some(y)) if x.descending == y.descending => {
                self.expression(&x.key, &y.key, d)?;
            }
            _ => return None,
        }
        match (&a.domain, &b.domain) {
            (IrQueryDomain::Model(x), IrQueryDomain::Model(y)) if x == y => {}
            (
                IrQueryDomain::Value { base: x, alias: p },
                IrQueryDomain::Value { base: y, alias: q },
            ) if p == q => self.expression(x, y, d)?,
            _ => return None,
        }
        Some(())
    }
    fn query_optional_expr(&mut self, x: &TypedExpr, y: &TypedExpr, d: usize) -> Option<()> {
        match (&x.expr, &y.expr) {
            (
                IrExpr::Lambda {
                    param: p,
                    body: xbody,
                },
                IrExpr::Lambda {
                    param: q,
                    body: ybody,
                },
            ) if p == q && x.ty == y.ty && x.span == y.span => self.expression(xbody, ybody, d)?,
            _ => self.expression(x, y, d)?,
        }
        Some(())
    }
    fn query_optional_parts(&mut self, a: &IrQuery, b: &IrQuery, d: usize) -> Option<()> {
        for (x, y) in [
            (&a.parent, &b.parent),
            (&a.where_pred, &b.where_pred),
            (&a.limit, &b.limit),
            (&a.archived, &b.archived),
            (&a.select, &b.select),
        ] {
            match (x, y) {
                (None, None) => {}
                (Some(x), Some(y)) => self.query_optional_expr(x, y, d)?,
                _ => return None,
            }
        }
        Some(())
    }
    /// Flat Model order terms have no typed Member expression to join.
    /// Their defining field still determines comparison semantics, so seal
    /// its original owner, declaration and type before consuming the term.
    fn query_order_field(&mut self, query: &IrQuery, name: &str, depth: usize) -> Option<()> {
        let IrQueryDomain::Model(model) = &query.domain else {
            return Some(());
        };
        self.budget(depth)?;
        let expected = self
            .expected
            .items
            .iter()
            .find(|item| item.canonical == *model)?;
        let actual = self.actual.items.get(expected.id.0 as usize)?;
        let (
            IrItemKind::Model {
                fields: a,
                owner: ao,
                ..
            },
            IrItemKind::Model {
                fields: b,
                owner: bo,
                ..
            },
        ) = (&actual.kind, &expected.kind)
        else {
            return None;
        };
        if actual.id != expected.id
            || actual.canonical != expected.canonical
            || actual.name != expected.name
            || actual.module != expected.module
            || actual.span != expected.span
            || a != b
            || ao != bo
        {
            return None;
        }
        let (am, bm) = (
            self.actual.modules.get(actual.module.0 as usize)?,
            self.expected.modules.get(expected.module.0 as usize)?,
        );
        if am.id != actual.module
            || am.id != bm.id
            || am.name != bm.name
            || am.kind != bm.kind
            || am.file != bm.file
            || am.span != bm.span
            || expected.span.file != bm.file
        {
            return None;
        }
        // Originally synthetic metadata (for example id) has no mutable
        // field declaration. Equal complete field inventories preserve that.
        let Some(field) = b
            .iter()
            .filter_map(|id| self.expected.items.get(id.0 as usize))
            .find(|field| field.name == name)
        else {
            return Some(());
        };
        let current = self.actual.items.get(field.id.0 as usize)?;
        if current.id != field.id
            || current.canonical != field.canonical
            || current.name != field.name
            || current.module != field.module
            || current.module != actual.module
            || current.span != field.span
        {
            return None;
        }
        match (&current.kind, &field.kind) {
            (
                IrItemKind::Field {
                    owner: a, ty: at, ..
                },
                IrItemKind::Field {
                    owner: b, ty: bt, ..
                },
            ) if *a == actual.id && a == b && known_type_equal(at, bt) => {}
            (
                IrItemKind::DeriveField {
                    model: a,
                    ty: at,
                    expr: Some(ae),
                    ..
                },
                IrItemKind::DeriveField {
                    model: b,
                    ty: bt,
                    expr: Some(be),
                    ..
                },
            ) if *a == actual.id && a == b && known_type_equal(at, bt) => {
                if self.stack.len() >= 16 || !self.stack.insert(field.id) {
                    return None;
                }
                self.expression(ae, be, depth + 1)?;
                self.stack.remove(&field.id);
            }
            _ => return None,
        }
        Some(())
    }
    fn query(
        &mut self,
        a: &IrQuery,
        b: &IrQuery,
        span: Span,
        ty: &ResolvedType,
        d: usize,
    ) -> Option<()> {
        self.query_source_ok(a, b, span, ty)?;
        if a.source != b.source
            || a.collection_call != b.collection_call
            || a.contract_collection_call != b.contract_collection_call
            || a.where_param != b.where_param
            || a.where_async != b.where_async
            || a.select_param != b.select_param
            || a.order.len() != b.order.len()
        {
            return None;
        }
        for (x, y) in a.order.iter().zip(&b.order) {
            if x.field != y.field || x.descending != y.descending {
                return None;
            }
            self.query_order_field(b, &y.field, d + 1)?;
        }
        self.query_ordering_ok(a, b, d)?;
        self.query_optional_parts(a, b, d)?;
        Some(())
    }
    fn expressions(&mut self, a: &[TypedExpr], b: &[TypedExpr], d: usize) -> Option<()> {
        if a.len() != b.len() {
            return None;
        }
        for (a, b) in a.iter().zip(b) {
            self.expression(a, b, d)?;
        }
        Some(())
    }
    fn derive_formal_mismatch(
        current: &IrItem,
        original: &IrItem,
        item: &IrItem,
        formal: crate::analysis::resolve::SymbolId,
        branch: crate::analysis::resolve::SymbolId,
        current_owner: crate::analysis::resolve::SymbolId,
        original_owner: crate::analysis::resolve::SymbolId,
        current_index: usize,
        original_index: usize,
        current_ty: &IrType,
        original_ty: &IrType,
    ) -> bool {
        current.id != formal
            || original.id != formal
            || current.module != original.module
            || current.module != item.module
            || current.span != original.span
            || current.canonical != original.canonical
            || current.name != original.name
            || current_owner != item.id
            || current_owner != original_owner
            || current_index != 0
            || current_index != original_index
            || !known_type_equal(current_ty, original_ty)
            || !matches!(current_ty,IrType::Known(ResolvedType::Record {symbol,stored:true})
                if *symbol==branch)
    }
    fn join_derive_fn_formal(
        &mut self,
        item: &IrItem,
        b: &[crate::analysis::resolve::SymbolId],
    ) -> Option<()> {
        join_semantic_params(self, self.actual, self.expected, item.id, b)?;
        // Supplied slots do not visit defaults. The exact transcript
        // projection still consumes its original required Branch
        // formal, so seal that declaration independently of the body.
        if let Some(fact) = self
            .program
            .scenario_disclosures()
            .values()
            .filter_map(|value| value.source_facts())
            .filter_map(|source| source.transcripts.as_ref())
            .flatten()
            .find(|fact| fact.derive == item.id)
        {
            if b != [fact.formal] {
                return None;
            }
            let current = self.actual.items.get(fact.formal.0 as usize)?;
            let original = self.expected.items.get(fact.formal.0 as usize)?;
            let (
                IrItemKind::Param {
                    owner: current_owner,
                    index: current_index,
                    ty: current_ty,
                    default: None,
                    default_node: None,
                    default_copy_source: None,
                    ..
                },
                IrItemKind::Param {
                    owner: original_owner,
                    index: original_index,
                    ty: original_ty,
                    default: None,
                    default_node: None,
                    default_copy_source: None,
                    ..
                },
            ) = (&current.kind, &original.kind)
            else {
                return None;
            };
            if Self::derive_formal_mismatch(
                current,
                original,
                item,
                fact.formal,
                fact.branch,
                *current_owner,
                *original_owner,
                *current_index,
                *original_index,
                current_ty,
                original_ty,
            ) {
                return None;
            }
        }
        Some(())
    }
    fn join_supplied_slots(
        &mut self,
        b: &[crate::analysis::resolve::SymbolId],
        slots: &[Option<usize>],
        d: usize,
    ) -> Option<()> {
        if slots.len() != b.len() {
            return None;
        }
        for (pid, slot) in b.iter().zip(slots) {
            if slot.is_none() {
                let actual = self.actual.items.get(pid.0 as usize)?;
                let original = self.expected.items.get(pid.0 as usize)?;
                let (
                    IrItemKind::Param {
                        owner: a,
                        index: x,
                        ty: at,
                        default_node: ak,
                        default: Some(ad),
                        ..
                    },
                    IrItemKind::Param {
                        owner: b,
                        index: y,
                        ty: bt,
                        default_node: bk,
                        default: Some(bd),
                        ..
                    },
                ) = (&actual.kind, &original.kind)
                else {
                    return None;
                };
                if actual.id != original.id
                    || a != b
                    || x != y
                    || ak != bk
                    || !known_type_equal(at, bt)
                {
                    return None;
                }
                let ae = match ad {
                    IrDefault::Literal(e) | IrDefault::Computed { expr: e, .. } => e,
                };
                let be = match bd {
                    IrDefault::Literal(e) | IrDefault::Computed { expr: e, .. } => e,
                };
                self.expression(ae, be, d)?;
            }
        }
        Some(())
    }
    fn join_derive_field_target(
        &mut self,
        actual: &IrItem,
        item: &IrItem,
        slots: Option<&Vec<Option<usize>>>,
        d: usize,
    ) -> Option<bool> {
        let (
            IrItemKind::DeriveField {
                model: a,
                ty: x,
                expr: Some(ae),
                ..
            },
            IrItemKind::DeriveField {
                model: b,
                ty: y,
                expr: Some(be),
                ..
            },
        ) = (&actual.kind, &item.kind)
        else {
            return Some(false);
        };
        if a != b
            || !known_type_equal(x, y)
            || ae.ty != ResolvedType::Scalar(Scalar::Bool)
            || slots.is_some()
        {
            return None;
        }
        self.expression(ae, be, d + 1)?;
        self.stack.remove(&item.id);
        Some(true)
    }
    fn join_derive_identity<'a>(
        expected: &'a IrProgram,
        actual_program: &'a IrProgram,
        stack: &mut HashSet<crate::analysis::resolve::SymbolId>,
        canonical: &str,
    ) -> Option<(&'a IrItem, &'a IrItem)> {
        let item = expected.items.iter().find(|i| i.canonical == *canonical)?;
        let actual = actual_program.items.get(item.id.0 as usize)?;
        if actual.id != item.id
            || actual.module != item.module
            || actual.canonical != item.canonical
            || stack.len() >= 16
            || !stack.insert(item.id)
        {
            return None;
        }
        Some((actual, item))
    }
    fn target(
        &mut self,
        a: &IrCallTarget,
        b: &IrCallTarget,
        d: usize,
        slots: Option<&Vec<Option<usize>>>,
    ) -> Option<()> {
        match (a, b) {
            (
                IrCallTarget::Builtin { id: a, awaited: x },
                IrCallTarget::Builtin { id: b, awaited: y },
            ) if a == b && x == y => {}
            (IrCallTarget::DeriveFn(a), IrCallTarget::DeriveFn(b)) if a == b => {
                let (actual, item) =
                    Self::join_derive_identity(self.expected, self.actual, &mut self.stack, b)?;
                if self.join_derive_field_target(actual, item, slots, d)? {
                    return Some(());
                }
                let (
                    IrItemKind::DeriveFn {
                        params: a,
                        result: x,
                        expr: Some(ae),
                    },
                    IrItemKind::DeriveFn {
                        params: b,
                        result: y,
                        expr: Some(be),
                    },
                ) = (&actual.kind, &item.kind)
                else {
                    return None;
                };
                if a != b || !known_type_equal(x, y) {
                    return None;
                }
                self.join_derive_fn_formal(item, b)?;
                self.expression(ae, be, d)?;
                if let Some(slots) = slots {
                    self.join_supplied_slots(b, slots, d)?;
                }
                self.stack.remove(&item.id);
            }
            _ => return None,
        }
        Some(())
    }
    pub(super) fn statements(&mut self, a: &[IrStmt], b: &[IrStmt], d: usize) -> Option<()> {
        if a.len() != b.len() {
            return None;
        }
        for (a, b) in a.iter().zip(b) {
            self.statement(a, b, d)?;
        }
        Some(())
    }
    fn join_simple_effect(&mut self, a: &IrStmt, b: &IrStmt, d: usize) -> Option<bool> {
        match (a, b) {
            (IrStmt::Require { cond: a, span: x }, IrStmt::Require { cond: b, span: y })
                if x == y =>
            {
                self.expression(a, b, d + 1)?;
                Some(true)
            }
            (
                IrStmt::Let {
                    name: x,
                    value: a,
                    span: s,
                },
                IrStmt::Let {
                    name: y,
                    value: b,
                    span: t,
                },
            ) if x == y && s == t => {
                self.expression(a, b, d + 1)?;
                Some(true)
            }
            (
                IrStmt::Create {
                    model: x,
                    input: a,
                    when: u,
                    binding: v,
                    span: s,
                },
                IrStmt::Create {
                    model: y,
                    input: b,
                    when: w,
                    binding: z,
                    span: t,
                },
            ) if x == y && u == w && v == z && s == t => {
                self.expression(a, b, d + 1)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    /// Event payloads have an untyped object carrier. Seal the defining
    /// declaration explicitly before either effect consumes its schema.
    pub(super) fn event_schema(&mut self, event: &str, depth: usize) -> Option<()> {
        let mut declarations = self.expected.items.iter().filter(|item| {
            item.canonical == event && matches!(item.kind, IrItemKind::Event { .. })
        });
        let declaration = declarations.next()?;
        if declarations.next().is_some()
            || self
                .actual
                .items
                .iter()
                .filter(|item| item.canonical == event)
                .count()
                != 1
        {
            return None;
        }
        self.constructor_schema(
            &ResolvedType::Record {
                symbol: declaration.id,
                stored: false,
            },
            depth,
            &mut HashSet::new(),
        )
    }
    fn join_event_effect(&mut self, a: &IrStmt, b: &IrStmt, d: usize) -> Option<bool> {
        match (a, b) {
            (
                IrStmt::Emit {
                    event: x,
                    payload: a,
                    span: s,
                },
                IrStmt::Emit {
                    event: y,
                    payload: b,
                    span: t,
                },
            ) if x == y && s == t => {
                self.event_schema(y, d + 1)?;
                self.expression(a, b, d + 1)?;
                Some(true)
            }
            (
                IrStmt::Cancel {
                    owner_package: x,
                    key: a,
                    span: s,
                },
                IrStmt::Cancel {
                    owner_package: y,
                    key: b,
                    span: t,
                },
            ) if x == y && s == t => {
                self.expression(a, b, d + 1)?;
                Some(true)
            }
            (
                IrStmt::Schedule {
                    owner_package: x,
                    key: a,
                    at: c,
                    event: u,
                    payload: e,
                    span: s,
                },
                IrStmt::Schedule {
                    owner_package: y,
                    key: b,
                    at: other_at,
                    event: v,
                    payload: f,
                    span: t,
                },
            ) if x == y && u == v && s == t => {
                self.event_schema(v, d + 1)?;
                self.expression(a, b, d + 1)?;
                self.expression(c, other_at, d + 1)?;
                self.expression(e, f, d + 1)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn join_call_statement(&mut self, a: &IrStmt, b: &IrStmt, d: usize) -> Option<bool> {
        // A prepared child call remains an original statement in a
        // parent's decision sites. Match its complete static operand and
        // authored inputs to fresh IR; receipt preparation still owns all
        // execution authority and child result qualification.
        let (
            IrStmt::Call {
                target:
                    IrEffectCallTarget::Operation {
                        source: x,
                        operation: a,
                    },
                inputs: c,
                binding: u,
                result: ar,
                span: s,
            },
            IrStmt::Call {
                target:
                    IrEffectCallTarget::Operation {
                        source: y,
                        operation: b,
                    },
                inputs: e,
                binding: v,
                result: br,
                span: t,
            },
        ) = (a, b)
        else {
            return Some(false);
        };
        if x != y || a != b || u != v || ar != br || s != t {
            return Some(false);
        }
        self.expression(c, e, d + 1)?;
        Some(true)
    }
    fn join_branch_statement(&mut self, a: &IrStmt, b: &IrStmt, d: usize) -> Option<bool> {
        match (a, b) {
            (
                IrStmt::If {
                    cond: a,
                    then_branch: x,
                    else_branch: z,
                    span: s,
                },
                IrStmt::If {
                    cond: b,
                    then_branch: y,
                    else_branch: w,
                    span: t,
                },
            ) if s == t => {
                self.expression(a, b, d + 1)?;
                self.statements(x, y, d + 1)?;
                self.statements(z, w, d + 1)?;
                Some(true)
            }
            (
                IrStmt::Match {
                    subject: a,
                    arms: x,
                    span: s,
                },
                IrStmt::Match {
                    subject: b,
                    arms: y,
                    span: t,
                },
            ) if s == t && x.len() == y.len() => {
                self.expression(a, b, d + 1)?;
                for (a, b) in x.iter().zip(y) {
                    if a.case != b.case || a.span != b.span {
                        return None;
                    }
                    self.statements(&a.body, &b.body, d + 1)?;
                }
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn join_for_statement(&mut self, a: &IrStmt, b: &IrStmt, d: usize) -> Option<bool> {
        let (
            IrStmt::For {
                item: x,
                domain: a,
                limit: c,
                body: z,
                span: s,
            },
            IrStmt::For {
                item: y,
                domain: b,
                limit: e,
                body: w,
                span: t,
            },
        ) = (a, b)
        else {
            return Some(false);
        };
        if x != y || s != t {
            return Some(false);
        }
        self.expression(a, b, d + 1)?;
        self.optional(c, e, d + 1)?;
        self.statements(z, w, d + 1)?;
        Some(true)
    }
    fn join_scoped_statement(&mut self, a: &IrStmt, b: &IrStmt, d: usize) -> Option<bool> {
        match (a, b) {
            (
                IrStmt::Send {
                    operation: x,
                    args: a,
                    when: c,
                    when_at_source: source_a,
                    binding: u,
                    deployment_binding: v,
                    span: s,
                },
                IrStmt::Send {
                    operation: y,
                    args: b,
                    when: e,
                    when_at_source: source_b,
                    binding: w,
                    deployment_binding: z,
                    span: t,
                },
            ) if x == y && u == w && v == z && s == t && source_a == source_b => {
                self.expression(a, b, d + 1)?;
                self.optional(c, e, d + 1)?;
                Some(true)
            }
            (
                IrStmt::Set {
                    record: a,
                    changes: c,
                    when: x,
                    span: s,
                },
                IrStmt::Set {
                    record: b,
                    changes: e,
                    when: y,
                    span: t,
                },
            ) if x == y && s == t => {
                self.expression(a, b, d + 1)?;
                self.expression(c, e, d + 1)?;
                Some(true)
            }
            (IrStmt::Return { value: a, span: x }, IrStmt::Return { value: b, span: y })
                if x == y =>
            {
                self.optional(a, b, d + 1)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn statement(&mut self, a: &IrStmt, b: &IrStmt, d: usize) -> Option<()> {
        self.budget(d)?;
        if self.join_simple_effect(a, b, d)? {
            return Some(());
        }
        if self.join_event_effect(a, b, d)? {
            return Some(());
        }
        if self.join_for_statement(a, b, d)? {
            return Some(());
        }
        if self.join_call_statement(a, b, d)? {
            return Some(());
        }
        if self.join_branch_statement(a, b, d)? {
            return Some(());
        }
        if self.join_scoped_statement(a, b, d)? {
            return Some(());
        }
        None
    }
    fn optional(&mut self, a: &Option<TypedExpr>, b: &Option<TypedExpr>, d: usize) -> Option<()> {
        match (a, b) {
            (None, None) => Some(()),
            (Some(a), Some(b)) => self.expression(a, b, d),
            _ => None,
        }
    }
}
fn known_type_equal(a: &IrType, b: &IrType) -> bool {
    matches!((a,b),(IrType::Known(a),IrType::Known(b)) if a==b)
}
