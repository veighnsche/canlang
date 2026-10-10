//! Optional checked decision correspondence. This publishes no execution authority.
use super::ir::*;
use crate::analysis::catalog::{Catalog, Effects};
use crate::analysis::scenario_disclosure::{
    CheckedDecisionCallFrame, CheckedDecisionCallTarget, CheckedDecisionPosition as Position,
    CheckedDecisionSite, CheckedDecisionStage as Stage,
};
use crate::analysis::types::SelectedCallTarget;
use crate::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, Span};
use crate::syntax::{self, SyntaxKind, SyntaxNode};
use std::collections::{HashMap, HashSet};

pub fn collect_decision_sources(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<Vec<CheckedDecisionSite>> {
    program.validate_cohort(db, catalog).ok()?;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let proofs = source.decision_sites.as_ref()?;
    let own = program
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    if own.decision_sites.as_ref() != Some(proofs)
        || own.source.path != source.source.path
        || own.source.sha256 != source.source.sha256
    {
        return None;
    }
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner.kind
    else {
        return None;
    };
    let (fresh, diagnostics) = super::ir::build(program, db, catalog);
    if diagnostics
        .iter()
        .any(|d| d.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let expected = fresh.items.get(owner.id.0 as usize)?;
    let IrItemKind::Scenario {
        guards: original_guards,
        effects: original_effects,
        ..
    } = &expected.kind
    else {
        return None;
    };
    let mut semantics = SemanticJoin {
        program,
        actual: ir,
        expected: &fresh,
        nodes: 0,
        stack: HashSet::new(),
    };
    semantics.statements(guards, original_guards, 0)?;
    semantics.statements(effects, original_effects, 0)?;
    let mut cx = Consumer {
        program,
        ir,
        db,
        catalog,
        nodes: HashMap::new(),
        steps: 0,
        count: 0,
    };
    for &file in program.checked_files() {
        let input = db.get(file)?;
        let (tree, diagnostics) = syntax::parse_source(file, &input.text);
        if diagnostics
            .iter()
            .any(|d| d.severity == crate::diagnostic::Severity::Error)
        {
            return None;
        }
        cx.index(&tree)?;
    }
    cx.steps = 0;
    let mut sites = Vec::new();
    for (i, s) in guards.iter().enumerate() {
        cx.statements(s, vec![Position::Guard(i)], true, &mut sites)?;
    }
    for (i, s) in effects.iter().enumerate() {
        cx.statements(s, vec![Position::Body(i)], false, &mut sites)?;
    }
    if sites.len() != proofs.len() {
        return None;
    }
    for ((expr, span, stage, position), proof) in sites.iter().zip(proofs) {
        if proof.owner != owner.id
            || proof.stage != *stage
            || proof.position != *position
            || !cx.same(proof.statement, *span)
            || !cx.same(proof.node, expr.span)
            || expr.ty != ResolvedType::Scalar(Scalar::Bool)
            || !cx.origin(&proof.source, proof.node, owner.module)
        {
            return None;
        }
        let mut matched = HashSet::new();
        cx.expression(expr, &[], &mut HashSet::new(), proof, &mut matched, 0)?;
        if matched.len() != proof.calls.len() {
            return None;
        }
    }
    Some(proofs.clone())
}
struct Consumer<'a> {
    program: &'a CheckedProgram,
    ir: &'a IrProgram,
    db: &'a SourceDb,
    catalog: Option<&'a Catalog>,
    nodes: HashMap<NodeKey, (SyntaxKind, Span, Option<NodeKey>)>,
    steps: usize,
    count: usize,
}
impl Consumer<'_> {
    fn index(&mut self, root: &SyntaxNode) -> Option<()> {
        let mut pending = vec![(root, 0usize)];
        while let Some((node, depth)) = pending.pop() {
            self.steps += 1;
            if self.steps > 200000 || depth > 256 {
                return None;
            }
            let grouped = (node.kind == SyntaxKind::Group)
                .then(|| {
                    node.children
                        .iter()
                        .find(|child| {
                            child.token().is_none()
                                && !matches!(child.kind, SyntaxKind::Trivia | SyntaxKind::Comment)
                        })
                        .map(NodeKey::of)
                })
                .flatten();
            self.nodes
                .insert(NodeKey::of(node), (node.kind, node.span, grouped));
            pending.extend(node.children.iter().map(|child| (child, depth + 1)));
        }
        Some(())
    }
    fn same(&self, key: NodeKey, span: Span) -> bool {
        let mut key = key;
        for _ in 0..65 {
            let Some((kind, actual, grouped)) = self.nodes.get(&key) else {
                return false;
            };
            if *kind != SyntaxKind::Group {
                return *actual == span;
            }
            let Some(inner) = grouped else {
                return false;
            };
            key = *inner;
        }
        false
    }
    fn origin(
        &self,
        s: &crate::analysis::scenario_disclosure::DisclosureSource,
        k: NodeKey,
        module: crate::analysis::resolve::ModuleId,
    ) -> bool {
        self.ir
            .modules
            .get(module.0 as usize)
            .and_then(|m| self.db.get(m.file).map(|f| (m, f)))
            .is_some_and(|(m, f)| {
                m.id == module
                    && m.file == k.file
                    && k.start >= m.span.start
                    && k.end <= m.span.end
                    && k.start < k.end
                    && m.name == s.module
                    && f.path == s.path
                    && f.sha256 == s.sha256
                    && k.end as usize <= f.text.len()
                    && self.nodes.contains_key(&k)
            })
    }
    fn statements<'a>(
        &mut self,
        s: &'a IrStmt,
        p: Vec<Position>,
        leading: bool,
        out: &mut Vec<(&'a TypedExpr, Span, Stage, Vec<Position>)>,
    ) -> Option<()> {
        self.steps += 1;
        if p.len() > 64 || self.steps > 16384 {
            return None;
        }
        match s {
            IrStmt::Require { cond, span } => out.push((
                cond,
                *span,
                if leading {
                    Stage::LeadingRequire
                } else {
                    Stage::BodyRequire
                },
                p,
            )),
            IrStmt::Send {
                when: Some(cond),
                span,
                ..
            } => out.push((cond, *span, Stage::SendDispatch, p)),
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => {
                for (i, c) in then_branch.iter().enumerate() {
                    let mut q = p.clone();
                    q.push(Position::Then(i));
                    self.statements(c, q, false, out)?;
                }
                for (i, c) in else_branch.iter().enumerate() {
                    let mut q = p.clone();
                    q.push(Position::Else(i));
                    self.statements(c, q, false, out)?;
                }
            }
            IrStmt::For { body, .. } => {
                for (i, c) in body.iter().enumerate() {
                    let mut q = p.clone();
                    q.push(Position::Loop(i));
                    self.statements(c, q, false, out)?;
                }
            }
            IrStmt::Match { arms, .. } => {
                for (a, arm) in arms.iter().enumerate() {
                    for (i, c) in arm.body.iter().enumerate() {
                        let mut q = p.clone();
                        q.push(Position::Match {
                            arm: a,
                            statement: i,
                        });
                        self.statements(c, q, false, out)?;
                    }
                }
            }
            IrStmt::Unsupported { .. } => return None,
            _ => {}
        }
        if out.len() > 200 {
            return None;
        }
        Some(())
    }
    fn expression(
        &mut self,
        e: &TypedExpr,
        chain: &[CheckedDecisionCallFrame],
        stack: &mut HashSet<crate::analysis::resolve::SymbolId>,
        site: &CheckedDecisionSite,
        matched: &mut HashSet<usize>,
        depth: usize,
    ) -> Option<()> {
        self.steps += 1;
        if depth > 64 || chain.len() > 16 || self.steps > 16384 {
            return None;
        }
        match &e.expr {
            IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                for a in args {
                    if let IrExpr::Lambda { body, .. } = &a.expr {
                        collection_lambda(self.program, args, a)?;
                        self.expression(body, chain, stack, site, matched, depth + 1)?;
                    } else {
                        self.expression(a, chain, stack, site, matched, depth + 1)?;
                    }
                }
                let mut found = site.calls.iter().enumerate().filter(|(_, p)| {
                    self.same(p.node, e.span)
                        && p.chain.len() == chain.len()
                        && p.chain.iter().zip(chain).all(|(a, b)| {
                            a.node == b.node
                                && a.derive == b.derive
                                && a.module == b.module
                                && a.source.path == b.source.path
                                && a.source.sha256 == b.source.sha256
                                && a.source.module == b.source.module
                        })
                });
                let (i, p) = found.next()?;
                if found.next().is_some() || i != matched.len() || !matched.insert(i) {
                    return None;
                }
                self.count += 1;
                if self.count > 200 || !self.origin(&p.source, p.node, p.module) {
                    return None;
                }
                let selected = self.program.types.selected_calls.get(&p.node)?;
                if self.program.types.node_types.get(&p.node) != Some(&e.ty) {
                    return None;
                }
                if selected.arguments.len() != args.len()
                    || selected.arguments.len() != p.arguments.len()
                    || selected.slots != p.slots
                {
                    return None;
                }
                let mut used = HashSet::new();
                for n in p.slots.iter().flatten() {
                    if *n >= args.len() || !used.insert(*n) {
                        return None;
                    }
                }
                if used.len() != args.len() {
                    return None;
                }
                for ((a, (key, ty)), selected_key) in
                    args.iter().zip(&p.arguments).zip(&selected.arguments)
                {
                    if key != selected_key
                        || !self.same(*key, a.span)
                        || a.ty != *ty
                        || self.program.types.node_types.get(key) != Some(ty)
                    {
                        return None;
                    }
                }
                let irslots = match &e.expr {
                    IrExpr::BoundCall { slots, .. } => slots.clone(),
                    _ => (0..args.len()).map(Some).collect(),
                };
                if irslots != p.slots {
                    return None;
                }
                match (&p.target, &selected.target, target) {
                    (
                        CheckedDecisionCallTarget::Builtin { id, overload },
                        SelectedCallTarget::Builtin {
                            id: actual,
                            overload: index,
                        },
                        IrCallTarget::Builtin {
                            id: lowered,
                            awaited,
                        },
                    ) => {
                        let cat = self.catalog?;
                        let entry = cat.lookup(id)?;
                        if id != actual
                            || id != lowered
                            || overload != index
                            || cat.overloads(id)?.get(*overload).is_none()
                            || *awaited != (entry.effects == Some(Effects::StateRead))
                            || !p.defaults.is_empty()
                        {
                            return None;
                        }
                    }
                    (
                        CheckedDecisionCallTarget::DeriveFn(id),
                        SelectedCallTarget::DeriveFn(actual),
                        IrCallTarget::DeriveFn(name),
                    ) => {
                        let item = self.ir.items.get(id.0 as usize)?;
                        if id != actual
                            || item.id != *id
                            || item.canonical != *name
                            || !stack.insert(*id)
                        {
                            return None;
                        }
                        let IrItemKind::DeriveFn {
                            params,
                            expr: Some(body),
                            ..
                        } = &item.kind
                        else {
                            return None;
                        };
                        let declared = self.program.effects.derives.get(id)?;
                        let body_node = declared.expr?;
                        if params.len() != p.slots.len()
                            || item.module != declared.module
                            || params
                                .iter()
                                .copied()
                                .ne(declared.params.iter().map(|param| param.param))
                            || !self.same(body_node, body.span)
                            || self.program.types.node_types.get(&body_node) != Some(&body.ty)
                        {
                            return None;
                        }
                        let mut frame = chain.to_vec();
                        frame.push(CheckedDecisionCallFrame {
                            node: p.node,
                            module: p.module,
                            source: p.source.clone(),
                            derive: *id,
                        });
                        let mut defaults = Vec::new();
                        for (pid, slot) in params.iter().zip(&p.slots) {
                            if slot.is_none() {
                                let param = self.ir.items.get(pid.0 as usize)?;
                                let IrItemKind::Param {
                                    owner,
                                    default_node: Some(key),
                                    default: Some(default),
                                    ..
                                } = &param.kind
                                else {
                                    return None;
                                };
                                if *owner != *id
                                    || param.id != *pid
                                    || declared
                                        .params
                                        .iter()
                                        .find(|param| param.param == *pid)?
                                        .default
                                        != Some(*key)
                                {
                                    return None;
                                }
                                defaults.push((*pid, *key));
                                let d = match default {
                                    IrDefault::Literal(d) | IrDefault::Computed { expr: d, .. } => {
                                        d
                                    }
                                };
                                if !self.same(*key, d.span)
                                    || self.program.types.node_types.get(key) != Some(&d.ty)
                                {
                                    return None;
                                }
                                self.expression(d, &frame, stack, site, matched, 0)?;
                            }
                        }
                        if defaults != p.defaults {
                            return None;
                        }
                        self.expression(body, &frame, stack, site, matched, 0)?;
                        stack.remove(id);
                    }
                    _ => return None,
                }
            }
            IrExpr::Query(query) => {
                checked_query(self.program, query)?;
                if let IrQueryDomain::Value { base, .. } = &query.domain {
                    self.expression(base, chain, stack, site, matched, depth + 1)?;
                }
                for expression in [
                    &query.parent,
                    &query.where_pred,
                    &query.limit,
                    &query.archived,
                    &query.select,
                ]
                .into_iter()
                .flatten()
                {
                    if let IrExpr::Lambda { body, .. } = &expression.expr {
                        self.expression(body, chain, stack, site, matched, depth + 1)?;
                    } else {
                        self.expression(expression, chain, stack, site, matched, depth + 1)?;
                    }
                }
            }
            IrExpr::Binary { left, right, .. } => {
                self.expression(left, chain, stack, site, matched, depth + 1)?;
                self.expression(right, chain, stack, site, matched, depth + 1)?;
            }
            IrExpr::Unary { operand, .. } | IrExpr::Member { base: operand, .. } => {
                self.expression(operand, chain, stack, site, matched, depth + 1)?
            }
            IrExpr::Array(a) => {
                for v in a {
                    self.expression(v, chain, stack, site, matched, depth + 1)?;
                }
            }
            IrExpr::Object(a) => {
                for (_, v) in a {
                    self.expression(v, chain, stack, site, matched, depth + 1)?;
                }
            }
            IrExpr::Int(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Null
            | IrExpr::Name(_)
            | IrExpr::Decimal(_)
            | IrExpr::DurationMs(_)
            | IrExpr::Money { .. }
            | IrExpr::Date(_)
            | IrExpr::Datetime(_) => {}
            _ => return None,
        }
        Some(())
    }
}

// Compare typed semantic structure against the original lowering, never text/debug output.
struct SemanticJoin<'a> {
    program: &'a CheckedProgram,
    actual: &'a IrProgram,
    expected: &'a IrProgram,
    nodes: usize,
    stack: HashSet<crate::analysis::resolve::SymbolId>,
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
    fn expression(&mut self, a: &TypedExpr, b: &TypedExpr, depth: usize) -> Option<()> {
        self.budget(depth)?;
        if a.ty != b.ty || a.span != b.span {
            return None;
        }
        match (&a.expr, &b.expr) {
            (IrExpr::Int(a), IrExpr::Int(b)) if a == b => {}
            (IrExpr::Text(a), IrExpr::Text(b)) if a == b => {}
            (IrExpr::Bool(a), IrExpr::Bool(b)) if a == b => {}
            (IrExpr::Null, IrExpr::Null) => {}
            (IrExpr::Name(a), IrExpr::Name(b)) if a == b => {}
            (IrExpr::Decimal(a), IrExpr::Decimal(b)) if a == b => {}
            (IrExpr::DurationMs(a), IrExpr::DurationMs(b)) if a == b => {}
            (IrExpr::Date(a), IrExpr::Date(b)) if a == b => {}
            (IrExpr::Datetime(a), IrExpr::Datetime(b)) if a == b => {}
            (
                IrExpr::Money {
                    minor: a,
                    currency: x,
                },
                IrExpr::Money {
                    minor: b,
                    currency: y,
                },
            ) if a == b && x == y => {}
            (IrExpr::Member { base: a, field: x }, IrExpr::Member { base: b, field: y })
                if x == y =>
            {
                self.expression(a, b, depth + 1)?
            }
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
            }
            (IrExpr::Unary { op: x, operand: a }, IrExpr::Unary { op: y, operand: b })
                if x == y =>
            {
                self.expression(a, b, depth + 1)?
            }
            (IrExpr::Array(a), IrExpr::Array(b)) => self.expressions(a, b, depth + 1)?,
            (IrExpr::Object(a), IrExpr::Object(b)) if a.len() == b.len() => {
                for ((x, a), (y, b)) in a.iter().zip(b) {
                    if x != y {
                        return None;
                    }
                    self.expression(a, b, depth + 1)?;
                }
            }
            (IrExpr::Call { target: x, args: a }, IrExpr::Call { target: y, args: b }) => {
                self.target(x, y, depth + 1, None)?;
                self.call_arguments(a, b, depth + 1)?;
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
                self.call_arguments(a, b, depth + 1)?;
            }
            (IrExpr::Query(a), IrExpr::Query(b)) => self.query(a, b, depth + 1)?,
            _ => return None,
        }
        Some(())
    }
    fn call_arguments(&mut self, a: &[TypedExpr], b: &[TypedExpr], d: usize) -> Option<()> {
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
                    collection_lambda(self.program, a, x)?;
                    collection_lambda(self.program, b, y)?;
                    self.expression(xbody, ybody, d)?;
                }
                _ => self.expression(x, y, d)?,
            }
        }
        Some(())
    }
    fn query(&mut self, a: &IrQuery, b: &IrQuery, d: usize) -> Option<()> {
        checked_query(self.program, a)?;
        checked_query(self.program, b)?;
        if a.source != b.source
            || a.collection_call != b.collection_call
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
        }
        match (&a.domain, &b.domain) {
            (IrQueryDomain::Model(x), IrQueryDomain::Model(y)) if x == y => {}
            (
                IrQueryDomain::Value { base: x, alias: p },
                IrQueryDomain::Value { base: y, alias: q },
            ) if p == q => self.expression(x, y, d)?,
            _ => return None,
        }
        for (x, y) in [
            (&a.parent, &b.parent),
            (&a.where_pred, &b.where_pred),
            (&a.limit, &b.limit),
            (&a.archived, &b.archived),
            (&a.select, &b.select),
        ] {
            match (x, y) {
                (None, None) => {}
                (Some(x), Some(y)) => match (&x.expr, &y.expr) {
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
                        self.expression(xbody, ybody, d)?
                    }
                    _ => self.expression(x, y, d)?,
                },
                _ => return None,
            }
        }
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
                let item = self.expected.items.iter().find(|i| i.canonical == *b)?;
                let actual = self.actual.items.get(item.id.0 as usize)?;
                if actual.id != item.id
                    || actual.module != item.module
                    || actual.canonical != item.canonical
                    || self.stack.len() >= 16
                    || !self.stack.insert(item.id)
                {
                    return None;
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
                self.expression(ae, be, d)?;
                if let Some(slots) = slots {
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
                }
                self.stack.remove(&item.id);
            }
            _ => return None,
        }
        Some(())
    }
    fn statements(&mut self, a: &[IrStmt], b: &[IrStmt], d: usize) -> Option<()> {
        if a.len() != b.len() {
            return None;
        }
        for (a, b) in a.iter().zip(b) {
            self.statement(a, b, d)?;
        }
        Some(())
    }
    fn statement(&mut self, a: &IrStmt, b: &IrStmt, d: usize) -> Option<()> {
        self.budget(d)?;
        match (a, b) {
            (IrStmt::Require { cond: a, span: x }, IrStmt::Require { cond: b, span: y })
                if x == y =>
            {
                self.expression(a, b, d + 1)?
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
            ) if x == y && s == t => self.expression(a, b, d + 1)?,
            (IrStmt::Return { value: a, span: x }, IrStmt::Return { value: b, span: y })
                if x == y =>
            {
                self.optional(a, b, d + 1)?
            }
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
            }
            (
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
            ) if x == y && s == t => {
                self.expression(a, b, d + 1)?;
                self.optional(c, e, d + 1)?;
                self.statements(z, w, d + 1)?;
            }
            (
                IrStmt::Send {
                    operation: x,
                    args: a,
                    when: c,
                    binding: u,
                    deployment_binding: v,
                    span: s,
                },
                IrStmt::Send {
                    operation: y,
                    args: b,
                    when: e,
                    binding: w,
                    deployment_binding: z,
                    span: t,
                },
            ) if x == y && u == w && v == z && s == t => {
                self.expression(a, b, d + 1)?;
                self.optional(c, e, d + 1)?;
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
            }
            _ => return None,
        }
        Some(())
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionSource {
    pub path: String,
    pub sha256: String,
    pub module: String,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionNode {
    pub start: u32,
    pub end: u32,
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SerialDecisionPosition {
    Guard { index: usize },
    Body { index: usize },
    Then { index: usize },
    Else { index: usize },
    Loop { index: usize },
    Match { arm: usize, statement: usize },
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SerialDecisionTarget {
    Builtin { id: String, overload: usize },
    Derive { name: String },
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionArgument {
    pub node: SerialDecisionNode,
    #[serde(rename = "type")]
    pub type_id: String,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionDefault {
    pub parameter: String,
    pub source: SerialDecisionSource,
    pub node: SerialDecisionNode,
    #[serde(rename = "type")]
    pub type_id: String,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionFrame {
    pub source: SerialDecisionSource,
    pub node: SerialDecisionNode,
    pub derive: String,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionCall {
    pub source: SerialDecisionSource,
    pub node: SerialDecisionNode,
    pub target: SerialDecisionTarget,
    pub arguments: Vec<SerialDecisionArgument>,
    pub slots: Vec<Option<usize>>,
    pub defaults: Vec<SerialDecisionDefault>,
    pub chain: Vec<SerialDecisionFrame>,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionSite {
    pub version: u8,
    pub source: SerialDecisionSource,
    pub owner: String,
    pub node: SerialDecisionNode,
    pub statement: SerialDecisionNode,
    pub stage: String,
    pub position: Vec<SerialDecisionPosition>,
    pub calls: Vec<SerialDecisionCall>,
}

/// Optional private transport only. No artifact registration or execution capability.
pub fn serialize_decision_sources(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<Vec<SerialDecisionSite>> {
    let sites = collect_decision_sources(program, ir, owner, db, catalog)?;
    let canonical = |id: crate::analysis::resolve::SymbolId| -> Option<String> {
        let item = ir.items.get(id.0 as usize)?;
        let symbol = program.symbols.get(id.0 as usize)?;
        if item.id != id
            || symbol.id != id
            || item.canonical != symbol.canonical
            || item.module != symbol.module
            || item.canonical.is_empty()
        {
            return None;
        }
        Some(item.canonical.clone())
    };
    let mut output = Vec::new();
    let mut count = 0usize;
    let mut values = 0usize;
    for site in sites {
        let mut calls = Vec::new();
        for call in site.calls {
            count += 1;
            values = values.checked_add(
                call.arguments.len()
                    + call.slots.len()
                    + call.defaults.len()
                    + call.chain.len()
                    + 1,
            )?;
            if count > 200 || values > 20000 {
                return None;
            }
            let target = match call.target {
                CheckedDecisionCallTarget::Builtin { id, overload } => {
                    SerialDecisionTarget::Builtin { id, overload }
                }
                CheckedDecisionCallTarget::DeriveFn(id) => SerialDecisionTarget::Derive {
                    name: canonical(id)?,
                },
            };
            let mut arguments = Vec::new();
            for (node, ty) in call.arguments {
                arguments.push(SerialDecisionArgument {
                    node: serial_node(node),
                    type_id: serial_type(&ty, program, ir, 0)?,
                });
            }
            let mut defaults = Vec::new();
            for (id, node) in call.defaults {
                let item = ir.items.get(id.0 as usize)?;
                let IrItemKind::Param {
                    default_node: Some(actual),
                    ty: IrType::Known(ty),
                    ..
                } = &item.kind
                else {
                    return None;
                };
                if *actual != node {
                    return None;
                }
                let module = ir.modules.get(item.module.0 as usize)?;
                let checked_module = program.modules.get(item.module.0 as usize)?;
                let file = db.get(module.file)?;
                if module.id != item.module
                    || checked_module.id != item.module
                    || module.name != checked_module.name
                    || module.file != checked_module.file
                    || module.span != checked_module.span
                    || module.file != node.file
                    || node.start < module.span.start
                    || node.end > module.span.end
                    || node.start >= node.end
                    || node.end as usize > file.text.len()
                {
                    return None;
                }
                defaults.push(SerialDecisionDefault {
                    parameter: canonical(id)?,
                    source: SerialDecisionSource {
                        path: file.path.clone(),
                        sha256: file.sha256.clone(),
                        module: module.name.clone(),
                    },
                    node: serial_node(node),
                    type_id: serial_type(ty, program, ir, 0)?,
                });
            }
            let mut chain = Vec::new();
            for frame in call.chain {
                chain.push(SerialDecisionFrame {
                    source: serial_source(frame.source),
                    node: serial_node(frame.node),
                    derive: canonical(frame.derive)?,
                });
            }
            calls.push(SerialDecisionCall {
                source: serial_source(call.source),
                node: serial_node(call.node),
                target,
                arguments,
                slots: call.slots,
                defaults,
                chain,
            });
        }
        let position = site
            .position
            .into_iter()
            .map(|p| match p {
                Position::Guard(index) => SerialDecisionPosition::Guard { index },
                Position::Body(index) => SerialDecisionPosition::Body { index },
                Position::Then(index) => SerialDecisionPosition::Then { index },
                Position::Else(index) => SerialDecisionPosition::Else { index },
                Position::Loop(index) => SerialDecisionPosition::Loop { index },
                Position::Match { arm, statement } => {
                    SerialDecisionPosition::Match { arm, statement }
                }
            })
            .collect();
        output.push(SerialDecisionSite {
            version: 1,
            source: serial_source(site.source),
            owner: canonical(site.owner)?,
            node: serial_node(site.node),
            statement: serial_node(site.statement),
            stage: match site.stage {
                Stage::LeadingRequire => "leading-require",
                Stage::BodyRequire => "body-require",
                Stage::SendDispatch => "send-dispatch",
            }
            .into(),
            position,
            calls,
        });
    }
    Some(output)
}
fn serial_node(node: NodeKey) -> SerialDecisionNode {
    SerialDecisionNode {
        start: node.start,
        end: node.end,
    }
}
fn serial_source(
    source: crate::analysis::scenario_disclosure::DisclosureSource,
) -> SerialDecisionSource {
    SerialDecisionSource {
        path: source.path,
        sha256: source.sha256,
        module: source.module,
    }
}
fn serial_type(
    ty: &ResolvedType,
    program: &CheckedProgram,
    ir: &IrProgram,
    depth: usize,
) -> Option<String> {
    if depth > 64 {
        return None;
    }
    let nominal = |id: crate::analysis::resolve::SymbolId| {
        let item = ir.items.get(id.0 as usize)?;
        let symbol = program.symbols.get(id.0 as usize)?;
        if item.id != id
            || symbol.id != id
            || item.module != symbol.module
            || item.canonical != symbol.canonical
        {
            return None;
        }
        Some(item)
    };
    Some(match ty {
        ResolvedType::Scalar(s) => s.as_str().into(),
        ResolvedType::Team => "Team".into(),
        ResolvedType::Null => "null".into(),
        ResolvedType::Nullable(inner) => {
            format!("{}?", serial_type(inner, program, ir, depth + 1)?)
        }
        ResolvedType::Array { element, .. } => {
            format!("{}[]", serial_type(element, program, ir, depth + 1)?)
        }
        ResolvedType::Record { symbol, .. } => {
            let item = nominal(*symbol)?;
            if !matches!(
                item.kind,
                IrItemKind::Model { .. } | IrItemKind::Contract { .. } | IrItemKind::Event { .. }
            ) {
                return None;
            }
            item.canonical.clone()
        }
        ResolvedType::Enum {
            owner: Some(id),
            cases,
        } => {
            let item = nominal(*id)?;
            let IrItemKind::Field {
                ty:
                    IrType::Known(ResolvedType::Enum {
                        owner: Some(actual),
                        cases: expected,
                    }),
                ..
            } = &item.kind
            else {
                return None;
            };
            if actual != id || expected != cases || cases.is_empty() {
                return None;
            }
            item.canonical.clone()
        }
        ResolvedType::Enum { owner: None, cases }
            if !cases.is_empty()
                && cases.len() <= 200
                && cases.iter().all(|case| {
                    !case.is_empty() && !case.chars().any(|c| matches!(c, ',' | '(' | ')'))
                }) =>
        {
            format!("enum({})", cases.join(","))
        }
        _ => return None,
    })
}

fn checked_query(program: &CheckedProgram, query: &IrQuery) -> Option<()> {
    let source = query.source.as_ref()?;
    if program.types.checked_queries.get(&source.node) != Some(source) {
        return None;
    }
    if let Some(call) = query.collection_call.as_ref()
        && (program.types.checked_collection_calls.get(&call.node) != Some(call.as_ref())
            || call.query != source.node)
    {
        return None;
    }
    Some(())
}
fn collection_lambda(
    program: &CheckedProgram,
    args: &[TypedExpr],
    lambda: &TypedExpr,
) -> Option<()> {
    let IrExpr::Lambda { param, body } = &lambda.expr else {
        return None;
    };
    let mut candidates = args.iter().filter_map(|arg| match &arg.expr {
        IrExpr::Query(q) => q.collection_call.as_deref().map(|c| (q, c)),
        _ => None,
    });
    let (query, call) = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    checked_query(program, query)?;
    if !matches!(call.builtin.as_str(), "any" | "all") {
        return None;
    }
    let predicate = call.predicate.as_ref()?;
    let selected = program.types.selected_calls.get(&call.node)?;
    let predicate_slot = selected.slots.get(1).copied().flatten()?;
    if !std::ptr::eq(args.get(predicate_slot)?, lambda)
        || selected.arguments.get(predicate_slot) != Some(&predicate.node)
        || lambda.ty != predicate.ty
        || body.ty != predicate.ty
    {
        return None;
    }
    let source = query.source.as_ref()?;
    let clause = source.clauses.iter().find(|c| c.node == call.alias)?;
    let crate::analysis::types::CheckedQueryClauseKind::As { name } = &clause.kind else {
        return None;
    };
    if name != param {
        return None;
    }
    Some(())
}
