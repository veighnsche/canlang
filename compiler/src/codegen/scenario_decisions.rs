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
    super::scenario_calls::checked_source(ir, owner, db)?
        .decision_sites
        .as_ref()?;
    let (fresh, diagnostics) = super::ir::build(program, db, catalog);
    if diagnostics
        .iter()
        .any(|d| d.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    collect_decision_sources_with_fresh(program, ir, owner, db, catalog, &fresh)
}

pub(super) fn collect_decision_sources_with_fresh(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    fresh: &IrProgram,
) -> Option<Vec<CheckedDecisionSite>> {
    program.validate_cohort(db, catalog).ok()?;
    super::scenario_calls::checked_source(ir, owner, db)?
        .decision_sites
        .as_ref()?;
    let mut trees = Vec::new();
    for &file in program.checked_files() {
        let (tree, diagnostics) = syntax::parse_source(file, &db.get(file)?.text);
        if diagnostics
            .iter()
            .any(|d| d.severity == crate::diagnostic::Severity::Error)
        {
            return None;
        }
        trees.push((file, tree));
    }
    collect_decision_sources_checked(program, ir, owner, db, catalog, fresh, &trees)
}

pub(super) fn collect_decision_sources_with_context(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<CheckedDecisionSite>> {
    collect_decision_sources_checked(
        context.program,
        context.ir,
        owner,
        context.db,
        context.catalog,
        &context.fresh,
        &context.trees,
    )
}

fn collect_decision_sources_checked(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    fresh: &IrProgram,
    trees: &[(crate::source::SourceId, SyntaxNode)],
) -> Option<Vec<CheckedDecisionSite>> {
    program.validate_cohort(db, catalog).ok()?;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let proofs = source.decision_sites.as_ref()?;
    let own = program
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    if own.decision_sites.as_ref() != Some(proofs)
        || own.transcripts != source.transcripts
        || own.inline_selections != source.inline_selections
        || own.source.path != source.source.path
        || own.source.sha256 != source.source.sha256
    {
        return None;
    }
    for transcript in source.transcripts.iter().flatten() {
        let schema = source
            .stored_contracts
            .as_deref()?
            .iter()
            .find(|schema| schema.id == transcript.model && schema.model)?;
        super::scenario_receipts::match_stored_contract_schema(ir, schema, db)?;
        for field in &schema.fields {
            super::scenario_receipts::match_stored_contract_field(ir, field, db)?;
        }
    }
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner.kind
    else {
        return None;
    };
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
        expected: fresh,
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
    // Only the original consumed anchors need a CST cache. Unrelated source
    // remains in the checked/fresh cohort without spending this owner's budget.
    let mut required = HashSet::new();
    let mut calls = 0usize;
    if proofs.len() > 200 {
        return None;
    }
    for site in proofs {
        required.extend([site.node, site.statement]);
        for call in &site.calls {
            calls += 1;
            if calls > 200 {
                return None;
            }
            required.insert(call.node);
            required.extend(call.arguments.iter().map(|(node, _)| *node));
            required.extend(call.defaults.iter().map(|(_, node)| *node));
            if let CheckedDecisionCallTarget::DeriveFn(id) = call.target {
                required.insert(program.effects.derives.get(&id)?.expr?);
            }
        }
    }
    cx.index_required(trees, &required)?;
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
        cx.expression(expr, &[], &mut HashSet::new(), &proof.calls, &mut matched, 0)?;
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

/// Required page anchors for the read seals: every page the IR sealed.
/// Unrelated Given/When bulk never spends the finite index budget; a missing
/// anchor refuses exactly like the previous whole-tree lookup did.
pub(super) fn page_anchor_keys(ir: &IrProgram) -> HashSet<NodeKey> {
    let mut required = HashSet::new();
    for module in &ir.modules {
        for page in &module.pages {
            required.insert(NodeKey {
                file: page.span.file,
                start: page.span.start,
                end: page.span.end,
                kind: SyntaxKind::Page as u8,
            });
        }
    }
    required
}

/// Ancestor-pruned page locator with the same finite bounds as the consumer
/// index: only children containing the required anchor are visited.
pub(super) fn find_page_root<'t>(
    tree: &'t SyntaxNode,
    page: NodeKey,
    steps: &mut usize,
) -> Option<&'t SyntaxNode> {
    let contains = |node: &SyntaxNode| {
        node.span.file == page.file
            && node.span.start <= page.start
            && node.span.end >= page.end
    };
    if !contains(tree) {
        return None;
    }
    let mut pending = vec![(tree, 0usize)];
    while let Some((node, depth)) = pending.pop() {
        if depth > 256 {
            return None;
        }
        *steps += 1;
        if *steps > 200000 {
            return None;
        }
        if NodeKey::of(node) == page {
            return Some(node);
        }
        pending.extend(
            node.children
                .iter()
                .filter(|child| contains(child))
                .map(|child| (child, depth + 1)),
        );
    }
    None
}

/// Bounded key search inside one sealed page subtree.
pub(super) fn find_page_key<'t>(
    root: &'t SyntaxNode,
    key: NodeKey,
    steps: &mut usize,
) -> Option<&'t SyntaxNode> {
    let mut pending = vec![(root, 0usize)];
    while let Some((node, depth)) = pending.pop() {
        if depth > 256 {
            return None;
        }
        *steps += 1;
        if *steps > 200000 {
            return None;
        }
        if NodeKey::of(node) == key {
            return Some(node);
        }
        pending.extend(node.children.iter().map(|child| (child, depth + 1)));
    }
    None
}

/// The selected helper closure: every derive body the expression join may
/// descend into from a sealed predicate. Derive bodies are small one-step
/// helpers; the Given/When bulk around them stays unindexed.
pub(super) fn helper_closure_keys(program: &CheckedProgram) -> HashSet<NodeKey> {
    let mut required = HashSet::new();
    for data in program.effects.derives.values() {
        required.extend(data.expr);
        for param in &data.params {
            required.extend(param.default);
        }
    }
    required
}

/// Best-effort helper-closure indexing: present bodies join the consumer
/// map under the same finite bounds; missing anchors stay absent, and their
/// use sites still refuse downstream exactly as before.
fn index_helper_closure(
    consumer: &mut Consumer,
    trees: &[(crate::source::SourceId, SyntaxNode)],
    program: &CheckedProgram,
) {
    for key in helper_closure_keys(program) {
        let _ = consumer.index_required(trees, &HashSet::from([key]));
    }
}

/// Exact consumed anchors for one rule's checked decision sites: the same
/// node/depth/call bounds as the decision index, so unrelated source never
/// spends this seal's finite budget.
fn required_site_keys(
    program: &CheckedProgram,
    sites: &[CheckedDecisionSite],
) -> Option<HashSet<NodeKey>> {
    let mut required = HashSet::new();
    let mut calls = 0usize;
    if sites.len() > 200 {
        return None;
    }
    for site in sites {
        required.extend([site.node, site.statement]);
        for call in &site.calls {
            calls += 1;
            if calls > 200 {
                return None;
            }
            required.insert(call.node);
            required.extend(call.arguments.iter().map(|(node, _)| *node));
            required.extend(call.defaults.iter().map(|(_, node)| *node));
            if let CheckedDecisionCallTarget::DeriveFn(id) = call.target {
                required.insert(program.effects.derives.get(&id)?.expr?);
            }
        }
    }
    Some(required)
}
impl Consumer<'_> {
    fn index_required(
        &mut self,
        trees: &[(crate::source::SourceId, SyntaxNode)],
        required: &HashSet<NodeKey>,
    ) -> Option<()> {
        let contains = |node: &SyntaxNode, key: &NodeKey| {
            node.span.file == key.file && node.span.start <= key.start && node.span.end >= key.end
        };
        for (file, tree) in trees {
            let keys: Vec<_> = required.iter().filter(|key| key.file == *file).collect();
            if keys.is_empty() {
                continue;
            }
            let mut pending = vec![(tree, 0usize)];
            while let Some((node, depth)) = pending.pop() {
                if depth > 256 {
                    return None;
                }
                if required.contains(&NodeKey::of(node)) {
                    self.index_at_depth(node, depth)?;
                    continue;
                }
                self.steps += 1;
                if self.steps > 200000 {
                    return None;
                }
                pending.extend(
                    node.children
                        .iter()
                        .filter(|child| keys.iter().any(|key| contains(child, key)))
                        .map(|child| (child, depth + 1)),
                );
            }
        }
        required
            .iter()
            .all(|key| self.nodes.contains_key(key))
            .then_some(())
    }

    fn index_at_depth(&mut self, root: &SyntaxNode, depth: usize) -> Option<()> {
        let mut pending = vec![(root, depth)];
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
            if self
                .nodes
                .insert(NodeKey::of(node), (node.kind, node.span, grouped))
                .is_some()
            {
                return None;
            }
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
                cond,
                then_branch,
                else_branch,
                span,
            } => {
                out.push((cond, *span, Stage::BodyCondition, p.clone()));
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
        calls: &[crate::analysis::scenario_disclosure::CheckedDecisionCall],
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
                        collection_lambda(self.program, args, a, e.span)?;
                        self.expression(body, chain, stack, calls, matched, depth + 1)?;
                    } else {
                        self.expression(a, chain, stack, calls, matched, depth + 1)?;
                    }
                }
                let mut found = calls.iter().enumerate().filter(|(_, p)| {
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
                                self.expression(d, &frame, stack, calls, matched, 0)?;
                            }
                        }
                        if defaults != p.defaults {
                            return None;
                        }
                        self.expression(body, &frame, stack, calls, matched, 0)?;
                        stack.remove(id);
                    }
                    _ => return None,
                }
            }
            IrExpr::Query(query) => {
                checked_query(self.program, query)?;
                if let IrQueryDomain::Value { base, .. } = &query.domain {
                    self.expression(base, chain, stack, calls, matched, depth + 1)?;
                }
                if let Some(order) = &query.value_order {
                    self.expression(&order.key, chain, stack, calls, matched, depth + 1)?;
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
                        self.expression(body, chain, stack, calls, matched, depth + 1)?;
                    } else {
                        self.expression(expression, chain, stack, calls, matched, depth + 1)?;
                    }
                }
            }
            IrExpr::Binary { left, right, .. } => {
                self.expression(left, chain, stack, calls, matched, depth + 1)?;
                self.expression(right, chain, stack, calls, matched, depth + 1)?;
            }
            IrExpr::Unary { operand, .. } | IrExpr::Member { base: operand, .. } => {
                self.expression(operand, chain, stack, calls, matched, depth + 1)?
            }
            IrExpr::Array(a) => {
                for v in a {
                    self.expression(v, chain, stack, calls, matched, depth + 1)?;
                }
            }
            IrExpr::Object(a) => {
                for (_, v) in a {
                    self.expression(v, chain, stack, calls, matched, depth + 1)?;
                }
            }
            IrExpr::HasRole { person, .. } => {
                if let Some(person) = person {
                    self.expression(person, chain, stack, calls, matched, depth + 1)?;
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

/// Join the executable scenario to a fresh lowering of its original checker.
/// Shared by independent nongrant source producers; it does not require a
/// supported native decision capture profile.
pub(super) fn same_scenario_semantics(
    program: &CheckedProgram,
    actual: &IrProgram,
    expected: &IrProgram,
    owner: &IrItem,
) -> Option<()> {
    let original = expected.items.get(owner.id.0 as usize)?;
    if owner.id != original.id
        || owner.module != original.module
        || owner.canonical != original.canonical
        || owner.span != original.span
    {
        return None;
    }
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
    // both sides (C23 hook slice); pre-commit hooks and cohorts stay out.
    if a != b
        || at != bt
        || ar != br
        || ad != bd
        || ax != bx
        || av != bv
        || ah.is_some()
        || bh.is_some()
        || ac.is_some()
        || bc.is_some()
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
            || *xo != owner.id
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
    if ab.len() != bb.len() {
        return None;
    }
    for (a, b) in ab.iter().zip(bb) {
        join.guard(a, b, 0)?;
    }
    join.statements(ag, bg, 0)?;
    join.statements(ae, be, 0)
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
        let call_span = a.span;
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
                self.call_arguments(a, b, depth + 1, call_span)?;
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
            }
            (IrExpr::Query(x), IrExpr::Query(y)) => self.query(x, y, a.span, &a.ty, depth + 1)?,
            (IrExpr::Lambda { param: x, body: a }, IrExpr::Lambda { param: y, body: b })
                if x == y =>
            {
                self.expression(a, b, depth + 1)?;
            }
            (IrExpr::HasRole { role: x, person: a }, IrExpr::HasRole { role: y, person: b })
                if x == y =>
            {
                match (a, b) {
                    (None, None) => {}
                    (Some(a), Some(b)) => self.expression(a, b, depth + 1)?,
                    _ => return None,
                }
            }
            (IrExpr::Message(a), IrExpr::Message(b)) => self.message(a, b, depth + 1)?,
            // Identical checked placeholders correspond exactly. Both sides
            // lower to the same throwing placeholder (IR build and codegen
            // still report their own E6008), so recognizing the
            // correspondence neither executes the gap nor masks it. `ty` and
            // `span` equality is established on entry; any differing
            // `what`/`why` still refuses. The single-tree executability
            // check keeps refusing every placeholder.
            (IrExpr::Unsupported { what: x, why: p }, IrExpr::Unsupported { what: y, why: q })
                if x == y && p == q => {}
            // A checked page-time predicate is data-only render filtering
            // (`row.datetime >= now`); its recorded model field,
            // comparison, spans, and paging support fully determine the
            // sealed meaning on both sides.
            (IrExpr::PageTimePredicate(a), IrExpr::PageTimePredicate(b)) if a.corresponds(b) => {}
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
                for (p, q) in p.iter().zip(q) {
                    if p.name != q.name || p.type_id != q.type_id || p.source != q.source {
                        return None;
                    }
                    self.optional(&p.default, &q.default, depth + 1)?;
                }
            }
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
            ) if x == y && u == v && p == q => self.expressions(a, b, depth + 1)?,
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
                match (a_callback, b_callback) {
                    (None, None) => {}
                    (Some(ap), Some(bp))
                        if ap.matches(self.actual, a, x, p, i)
                            && bp.matches(self.expected, b, y, q, j) => {}
                    _ => return None,
                }
            }
            _ => return None,
        }
        Some(())
    }
    fn guard(&mut self, a: &IrGuard, b: &IrGuard, depth: usize) -> Option<()> {
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
    fn message(&mut self, a: &IrMessage, b: &IrMessage, depth: usize) -> Option<()> {
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
    fn ui(&mut self, a: &IrUi, b: &IrUi, depth: usize) -> Option<()> {
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
    fn query(
        &mut self,
        a: &IrQuery,
        b: &IrQuery,
        span: Span,
        ty: &ResolvedType,
        d: usize,
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
        }
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
                if let (
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
                {
                    if a != b
                        || !known_type_equal(x, y)
                        || ae.ty != ResolvedType::Scalar(Scalar::Bool)
                        || slots.is_some()
                    {
                        return None;
                    }
                    self.expression(ae, be, d + 1)?;
                    self.stack.remove(&item.id);
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
                    if b.as_slice() != [fact.formal] {
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
                    if current.id != fact.formal
                        || original.id != fact.formal
                        || current.module != original.module
                        || current.module != item.module
                        || current.span != original.span
                        || current.canonical != original.canonical
                        || current.name != original.name
                        || *current_owner != item.id
                        || current_owner != original_owner
                        || *current_index != 0
                        || current_index != original_index
                        || !known_type_equal(current_ty, original_ty)
                        || !matches!(current_ty,IrType::Known(ResolvedType::Record {symbol,stored:true})
                            if *symbol==fact.branch)
                    {
                        return None;
                    }
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
            }
            // A prepared child call remains an original statement in a
            // parent's decision sites. Match its complete static operand and
            // authored inputs to fresh IR; receipt preparation still owns all
            // execution authority and child result qualification.
            (
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
            ) if x == y && a == b && u == v && ar == br && s == t => {
                self.expression(c, e, d + 1)?;
            }
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
    serialize_sites(program, ir, db, sites, None)
}

/// Reuse an already lowered cohort without removing decision serialization checks.
pub(super) fn serialize_decision_sources_with_fresh(
    program: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    fresh: &IrProgram,
) -> Option<Vec<SerialDecisionSite>> {
    let sites = collect_decision_sources_with_fresh(program, ir, owner, db, catalog, fresh)?;
    serialize_sites(program, ir, db, sites, None)
}

/// One fresh, invocation-local source cohort. No authority or global cache;
/// all consumers borrow the exact supplied inputs and retain their own checks.
pub(super) struct FreshSourceContext<'a> {
    program: &'a CheckedProgram,
    ir: &'a IrProgram,
    db: &'a SourceDb,
    catalog: Option<&'a Catalog>,
    original: CheckedProgram,
    fresh: IrProgram,
    has_ir_diagnostics: bool,
    ir_diagnostics: Vec<crate::diagnostic::Diagnostic>,
    trees: Vec<(crate::source::SourceId, SyntaxNode)>,
    resolved: crate::analysis::resolve::ResolveTables,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum SourcePreparationGap {
    Cohort,
    Analysis,
    Ir,
    MissingSource,
    Cst(Span),
    Resolution,
}

impl<'a> FreshSourceContext<'a> {
    pub(super) fn prepare(
        program: &'a CheckedProgram,
        ir: &'a IrProgram,
        db: &'a SourceDb,
        catalog: Option<&'a Catalog>,
    ) -> Result<Self, SourcePreparationGap> {
        Self::prepare_inner(program, ir, db, catalog, false)
    }

    /// Query association may borrow a partial lowering, never execution authority.
    /// The query consumer still seals its complete original consumed closure.
    pub(super) fn prepare_queries(
        program: &'a CheckedProgram,
        ir: &'a IrProgram,
        db: &'a SourceDb,
        catalog: Option<&'a Catalog>,
    ) -> Result<Self, SourcePreparationGap> {
        Self::prepare_inner(program, ir, db, catalog, true)
    }

    fn prepare_inner(
        program: &'a CheckedProgram,
        ir: &'a IrProgram,
        db: &'a SourceDb,
        catalog: Option<&'a Catalog>,
        query_association: bool,
    ) -> Result<Self, SourcePreparationGap> {
        program
            .validate_cohort(db, catalog)
            .map_err(|_| SourcePreparationGap::Cohort)?;
        let (original, diagnostics) = crate::analysis::check_program_with_given(
            db,
            program.checked_files(),
            catalog,
            program.original_given(),
        );
        if diagnostics
            .iter()
            .any(|d| d.severity == crate::diagnostic::Severity::Error)
        {
            return Err(SourcePreparationGap::Analysis);
        }
        let (fresh, diagnostics) = super::ir::build(&original, db, catalog);
        let has_ir_diagnostics = !diagnostics.is_empty();
        if diagnostics.iter().any(|d| {
            d.severity == crate::diagnostic::Severity::Error
                && (!query_association || !matches!(d.code, "E6007" | "E6008"))
        }) {
            return Err(SourcePreparationGap::Ir);
        }
        let ir_diagnostics = diagnostics;
        let mut trees = Vec::new();
        for &file in original.checked_files() {
            let input = db.get(file).ok_or(SourcePreparationGap::MissingSource)?;
            let (tree, diagnostics) = syntax::parse_source(file, &input.text);
            if diagnostics
                .iter()
                .any(|d| d.severity == crate::diagnostic::Severity::Error)
            {
                return Err(SourcePreparationGap::Cst(tree.span));
            }
            trees.push((file, tree));
        }
        let mut diagnostics = Vec::new();
        let resolved = crate::analysis::resolve::try_resolve_program_with_given(
            db,
            &trees,
            catalog,
            program.original_given(),
            &mut diagnostics,
        )
        .map_err(|_| SourcePreparationGap::Resolution)?;
        if diagnostics
            .iter()
            .any(|d| d.severity == crate::diagnostic::Severity::Error)
        {
            return Err(SourcePreparationGap::Resolution);
        }
        Ok(Self {
            program,
            ir,
            db,
            catalog,
            original,
            fresh,
            has_ir_diagnostics,
            ir_diagnostics,
            trees,
            resolved,
        })
    }

    pub(super) fn program(&self) -> &CheckedProgram {
        self.program
    }
    pub(super) fn ir(&self) -> &IrProgram {
        self.ir
    }
    pub(super) fn db(&self) -> &SourceDb {
        self.db
    }
    pub(super) fn catalog(&self) -> Option<&Catalog> {
        self.catalog
    }
    pub(super) fn original(&self) -> &CheckedProgram {
        &self.original
    }
    pub(super) fn fresh(&self) -> &IrProgram {
        &self.fresh
    }
    pub(super) fn has_ir_errors(&self) -> bool {
        self.ir_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    }
    pub(super) fn ir_diagnostics(&self) -> &[crate::diagnostic::Diagnostic] {
        &self.ir_diagnostics
    }
    pub(super) fn has_ir_diagnostics(&self) -> bool {
        self.has_ir_diagnostics
    }
    pub(super) fn trees(&self) -> &[(crate::source::SourceId, SyntaxNode)] {
        &self.trees
    }
    pub(super) fn resolved(&self) -> &crate::analysis::resolve::ResolveTables {
        &self.resolved
    }
    pub(super) fn serialize_rule(&self, rule: &IrRuleFn) -> Option<Vec<SerialDecisionSite>> {
        serialize_read_rule(self, rule)
    }
    pub(super) fn serialize_predicates(&self) -> Option<Vec<SerialDecisionSite>> {
        serialize_read_predicates(self)
    }
}

pub(super) fn serialize_decision_sources_with_context(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<SerialDecisionSite>> {
    let sites = collect_decision_sources_with_context(context, owner)?;
    serialize_sites(context.program, context.ir, context.db, sites, None)
}

/// SEND compares against the freshly checked original; preserve that distinction
/// from membership/query consumers of the supplied checked tables.
pub(super) fn serialize_original_decision_sources_with_context(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<SerialDecisionSite>> {
    let sites = collect_decision_sources_checked(
        &context.original,
        context.ir,
        owner,
        context.db,
        context.catalog,
        &context.fresh,
        &context.trees,
    )?;
    serialize_sites(&context.original, context.ir, context.db, sites, None)
}

/// Original policy source correspondence for a registered ordinary or protected
/// read rule. Source metadata supplies no policy or execution authority.
pub fn serialize_read_decision_sources(
    program: &CheckedProgram,
    ir: &IrProgram,
    rule: &IrRuleFn,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<Vec<SerialDecisionSite>> {
    FreshSourceContext::prepare(program, ir, db, catalog)
        .ok()?
        .serialize_rule(rule)
}

fn serialize_read_rule(
    sources: &FreshSourceContext<'_>,
    rule: &IrRuleFn,
) -> Option<Vec<SerialDecisionSite>> {
    let program = sources.program;
    let ir = sources.ir;
    let db = sources.db;
    let catalog = sources.catalog;
    let original = &sources.original;
    let fresh = &sources.fresh;
    let trees = &sources.trees;
    let resolved = &sources.resolved;
    let mut matches = Vec::new();
    for (model, data) in &original.effects.models {
        let symbol = original.symbols.get(model.0 as usize)?;
        for (ordinal, policy) in data.policies.iter().enumerate() {
            let span = Span::new(policy.node.file, policy.node.start, policy.node.end);
            for (kind, callback) in [("read", false), ("callbackRead", true)] {
                if rule.span == span
                    && rule.id
                        == format!(
                            "{}.{kind}.{}",
                            super::ir::model_rule_prefix(original, symbol),
                            ordinal + 1
                        )
                {
                    matches.push((*model, ordinal, callback));
                }
            }
        }
    }
    let [(model, ordinal, callback)] = matches.as_slice() else {
        return None;
    };
    let symbol = original.symbols.get(model.0 as usize)?;
    let actual_symbol = program.symbols.get(model.0 as usize)?;
    if actual_symbol.id != *model
        || actual_symbol.canonical != symbol.canonical
        || actual_symbol.module != symbol.module
        || rule.origin.is_some()
    {
        return None;
    }
    let actual_model = program.effects.models.get(model)?;
    let original_model = original.effects.models.get(model)?;
    if actual_model.model != *model || actual_model.module != original_model.module {
        return None;
    }
    let actual_policy = actual_model.policies.get(*ordinal)?;
    let policy = original_model.policies.get(*ordinal)?;
    if actual_policy.id != policy.id
        || actual_policy.node != policy.node
        || actual_policy.module != policy.module
        || actual_policy.read != policy.read
        || actual_policy.where_predicate != policy.where_predicate
        || actual_policy.fields != policy.fields
        || actual_policy.callback_fields != policy.callback_fields
        || actual_policy.fields_node != policy.fields_node
    {
        return None;
    }
    let expected_rules = if *callback {
        &fresh.callback_read_rules
    } else {
        &fresh.read_rules
    };
    let actual_rules = if *callback {
        &ir.callback_read_rules
    } else {
        &ir.read_rules
    };
    let matching_rule =
        |candidate: &&IrRuleFn| candidate.id == rule.id && candidate.span == rule.span;
    let mut expected_matches = expected_rules.iter().filter(matching_rule);
    let expected = expected_matches.next()?;
    if expected_matches.next().is_some() {
        return None;
    }
    let mut actual_matches = actual_rules.iter().filter(matching_rule);
    let actual = actual_matches.next()?;
    if actual_matches.next().is_some() || actual.origin.is_some() {
        return None;
    }
    let mut semantics = SemanticJoin {
        program: original,
        actual: ir,
        expected: fresh,
        nodes: 0,
        stack: HashSet::new(),
    };
    semantics.expression(&rule.pred, &expected.pred, 0)?;
    semantics.expression(&actual.pred, &expected.pred, 0)?;
    let sites = crate::analysis::scenario_disclosure::checked_read_decision_sites(
        db,
        trees,
        resolved,
        &original.types,
        &original.effects,
        *model,
        *ordinal,
    )?;
    let mut consumer = Consumer {
        program: original,
        ir,
        db,
        catalog,
        nodes: HashMap::new(),
        steps: 0,
        count: 0,
    };
    // Only this rule's consumed anchors spend the finite index budget, then
    // the present helper-closure bodies join best-effort. Unrelated source
    // remains in the checked/fresh cohort unindexed.
    consumer.index_required(trees, &required_site_keys(original, &sites)?)?;
    index_helper_closure(&mut consumer, trees, original);
    consumer.steps = 0;
    let predicates = if policy.where_predicate.is_some() {
        let IrExpr::Binary {
            op: IrBinOp::And,
            left,
            right,
        } = &rule.pred.expr
        else {
            return None;
        };
        vec![left.as_ref(), right.as_ref()]
    } else {
        vec![&rule.pred]
    };
    if sites.len() != predicates.len() {
        return None;
    }
    for (site, predicate) in sites.iter().zip(predicates) {
        if predicate.ty != ResolvedType::Scalar(Scalar::Bool)
            || !consumer.origin(&site.source, site.node, symbol.module)
        {
            return None;
        }
        // Shorthand grants may lower to synthetic context calls. They have no
        // selected authored call; the whole predicate was joined above.
        if !site.calls.is_empty() {
            let mut matched = HashSet::new();
            consumer.expression(
                predicate,
                &[],
                &mut HashSet::new(),
                &site.calls,
                &mut matched,
                0,
            )?;
            if matched.len() != site.calls.len() {
                return None;
            }
        }
    }
    let module = original.modules.get(symbol.module.0 as usize)?;
    let owner = if super::ir::model_rule_prefix(original, symbol) == symbol.canonical {
        rule.id.clone()
    } else {
        format!("{}.{}", module.name, rule.id)
    };
    serialize_sites(original, ir, db, sites, Some(&owner))
}

/// Named-page stored-model collection predicates at their original query sites.
/// The collection factory erases its Query carrier into `model`/`where` props;
/// original CST/query facts and fresh render correspondence retain that owner.
pub fn serialize_read_predicate_sources(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<Vec<SerialDecisionSite>> {
    FreshSourceContext::prepare(program, ir, db, catalog)
        .ok()?
        .serialize_predicates()
}

fn serialize_read_predicates(sources: &FreshSourceContext<'_>) -> Option<Vec<SerialDecisionSite>> {
    let ir = sources.ir;
    let db = sources.db;
    let catalog = sources.catalog;
    let original = &sources.original;
    let fresh = &sources.fresh;
    let trees = &sources.trees;
    let resolved = &sources.resolved;
    if ir.modules.len() != fresh.modules.len() {
        return None;
    }
    let mut consumer = Consumer {
        program: original,
        ir,
        db,
        catalog,
        nodes: HashMap::new(),
        steps: 0,
        count: 0,
    };
    // Only the sealed pages spend the finite index budget, then the present
    // helper-closure bodies join best-effort. Unrelated Given/When bulk
    // remains in the checked/fresh cohort unindexed.
    consumer.index_required(trees, &page_anchor_keys(ir))?;
    index_helper_closure(&mut consumer, trees, original);
    consumer.steps = 0;
    let mut join = SemanticJoin {
        program: original,
        actual: ir,
        expected: fresh,
        nodes: 0,
        stack: HashSet::new(),
    };
    let mut output = Vec::new();
    let mut call_count = 0usize;
    for (module, expected_module) in ir.modules.iter().zip(&fresh.modules) {
        if module.id != expected_module.id
            || module.name != expected_module.name
            || module.file != expected_module.file
            || module.span != expected_module.span
            || module.pages.len() != expected_module.pages.len()
        {
            return None;
        }
        for (page, expected_page) in module.pages.iter().zip(&expected_module.pages) {
            if page.owner != expected_page.owner
                || page.fn_name != expected_page.fn_name
                || page.descriptor_name != expected_page.descriptor_name
                || page.path != expected_page.path
                || page.span != expected_page.span
                || page.render.len() != expected_page.render.len()
                || page.admit.len() != expected_page.admit.len()
            {
                return None;
            }
            join.message(&page.title, &expected_page.title, 0)?;
            for (actual, expected) in page.admit.iter().zip(&expected_page.admit) {
                join.guard(actual, expected, 0)?;
            }
            for (actual, expected) in page.render.iter().zip(&expected_page.render) {
                join.ui(actual, expected, 0)?;
            }
            let page_key = NodeKey {
                file: page.span.file,
                start: page.span.start,
                end: page.span.end,
                kind: SyntaxKind::Page as u8,
            };
            // The sealed page subtree carries this owner's CST; a missing
            // anchor refuses exactly like the previous whole-tree lookup did.
            let Some((_, tree)) = trees.iter().find(|(file, _)| *file == page.span.file) else {
                return None;
            };
            let page_node = find_page_root(tree, page_key, &mut consumer.steps)?;
            if page_node.kind != SyntaxKind::Page {
                return None;
            }
            let owner = format!("{}.{}", page.owner, page.fn_name);
            let mut pending = page.render.iter().rev().collect::<Vec<_>>();
            while let Some(ui) = pending.pop() {
                pending.extend(ui.children.iter().rev());
                if !matches!(ui.factory.as_str(), "list" | "table" | "calendar") {
                    continue;
                }
                let mut predicates = ui.props.iter().filter(|(name, _)| name == "where");
                let Some((_, predicate)) = predicates.next() else {
                    continue;
                };
                if predicates.next().is_some() {
                    return None;
                }
                // Checked data filters are compared by the complete fresh UI
                // join above and carry no callable decision census. Checked
                // page-time predicates match the read-predicate seal, which
                // skips the same data-only shapes.
                if matches!(
                    &predicate.expr,
                    IrExpr::Object(_) | IrExpr::PageTimePredicate(_)
                ) {
                    continue;
                }
                let IrExpr::Lambda { body, .. } = &predicate.expr else {
                    return None;
                };
                let ui_key = NodeKey {
                    file: ui.span.file,
                    start: ui.span.start,
                    end: ui.span.end,
                    kind: SyntaxKind::Collection as u8,
                };
                let source_ui = find_page_key(page_node, ui_key, &mut consumer.steps)?;
                let query = crate::analysis::kids(source_ui)
                    .into_iter()
                    .find(|child| child.kind == SyntaxKind::Query)?;
                let site = crate::analysis::scenario_disclosure::checked_read_predicate_site(
                    db,
                    trees,
                    resolved,
                    &original.types,
                    &original.effects,
                    module.id,
                    page_key,
                    NodeKey::of(query),
                )?;
                // Each collected site is an independent validation unit:
                // prior units must not spend its finite expression budget.
                // Total output stays capped below.
                consumer.steps = 0;
                if !consumer.same(site.node, body.span)
                    || body.ty != ResolvedType::Scalar(Scalar::Bool)
                    || !consumer.origin(&site.source, site.node, module.id)
                {
                    return None;
                }
                let mut matched = HashSet::new();
                consumer.expression(body, &[], &mut HashSet::new(), &site.calls, &mut matched, 0)?;
                if matched.len() != site.calls.len() {
                    return None;
                }
                call_count = call_count.checked_add(site.calls.len())?;
                if output.len() >= 200 || call_count > 200 {
                    return None;
                }
                match serialize_sites(original, ir, db, vec![site], Some(&owner)) {
                    Some(sites) => output.extend(sites),
                    None => return None,
                }
            }
        }
    }
    Some(output)
}

/// Original Boolean observers. The read-predicate preparation seals the full
/// fresh source and IR before these identities can reach the emitter.
pub(super) fn serialize_read_booleans(
    sources: &FreshSourceContext<'_>,
) -> Option<Vec<(Span, serde_json::Value, Vec<SerialDecisionSite>)>> {
    let original = sources.original();
    let ir = sources.ir();
    let mut consumer = Consumer {
        program: original,
        ir,
        db: sources.db(),
        catalog: sources.catalog(),
        nodes: HashMap::new(),
        steps: 0,
        count: 0,
    };
    // Only the sealed pages spend the finite index budget, then the present
    // helper-closure bodies join best-effort. Unrelated Given/When bulk
    // remains in the checked/fresh cohort unindexed.
    consumer.index_required(sources.trees(), &page_anchor_keys(ir))?;
    index_helper_closure(&mut consumer, sources.trees(), original);
    consumer.steps = 0;
    let mut candidates = Vec::new();
    let mut stateless = Vec::new();
    for module in &ir.modules {
        for page in &module.pages {
            let page_key = NodeKey {
                file: page.span.file,
                start: page.span.start,
                end: page.span.end,
                kind: SyntaxKind::Page as u8,
            };
            let (_, tree) = sources
                .trees()
                .iter()
                .find(|(file, _)| *file == page.span.file)?;
            let page_node = find_page_root(tree, page_key, &mut consumer.steps)?;
            let route = crate::analysis::kids(page_node)
                .into_iter()
                .find(|n| n.kind == SyntaxKind::Route);
            for guard in &page.admit {
                let IrGuard::Expr(expr) = guard else {
                    continue;
                };
                let Some(statement) = crate::analysis::kids(page_node).into_iter().find(|n| {
                    matches!(n.kind, SyntaxKind::Require | SyntaxKind::UiLeaf)
                        && n.span.start <= expr.span.start
                        && n.span.end >= expr.span.end
                }) else {
                    continue;
                };
                let Some(predicate) = crate::analysis::kids(statement).into_iter().find(|n| {
                    original.types.node_types.get(&NodeKey::of(n))
                        == Some(&ResolvedType::Scalar(Scalar::Bool))
                }) else {
                    continue;
                };
                if !crate::analysis::scenario_disclosure::expression_reads_membership(
                    &original.types,
                    &original.effects,
                    NodeKey::of(predicate),
                ) {
                    continue;
                }
                // An incidental route record never defines permission to
                // read (DESIGN §3): a guard without a record owner keeps
                // its exact owning page sources without inventing a model.
                let route_kids = route.map(crate::analysis::kids).unwrap_or_default();
                let records = route_kids
                    .iter()
                    .filter(|n| n.kind == SyntaxKind::RouteRecord)
                    .collect::<Vec<_>>();
                let has_scalar = route_kids
                    .iter()
                    .any(|n| n.kind == SyntaxKind::RouteScalar);
                if records.len() == 1 && !has_scalar {
                    let path = crate::analysis::kids(records[0])
                        .into_iter()
                        .find(|n| n.kind == SyntaxKind::Path)?;
                    let model = *sources.resolved().node_symbol.get(&NodeKey::of(path))?;
                    let model = if matches!(
                        original.symbols.get(model.0 as usize)?.kind,
                        crate::analysis::resolve::SymbolKind::Model { .. }
                    ) {
                        model
                    } else {
                        return None;
                    };
                    candidates.push((
                        module.id,
                        model,
                        format!("{}.{}", page.owner, page.fn_name),
                        expr,
                        NodeKey::of(predicate),
                        NodeKey::of(statement),
                        "page-require",
                        None,
                    ));
                } else if records.is_empty() && !has_scalar {
                    stateless.push((
                        module.id,
                        format!("{}.{}", page.owner, page.fn_name),
                        expr,
                        NodeKey::of(predicate),
                        NodeKey::of(statement),
                    ));
                } else {
                    return None;
                }
            }
        }
    }
    for item in &ir.items {
        let IrItemKind::DeriveField {
            model,
            expr: Some(expr),
            ..
        } = &item.kind
        else {
            continue;
        };
        let data = original.effects.derives.get(&item.id)?;
        let key = data.expr?;
        // A Boolean result never defines permission to read (DESIGN §3):
        // derived fields of every type reuse this same observer join.
        if crate::analysis::scenario_disclosure::expression_reads_membership(
            &original.types,
            &original.effects,
            key,
        ) {
            candidates.push((
                item.module,
                *model,
                item.canonical.clone(),
                expr,
                key,
                data.node,
                "derived-field",
                Some(item.name.clone()),
            ));
        }
    }
    let mut output = Vec::new();
    for (module, model, owner, expr, key, statement, kind, field) in candidates {
        let site = crate::analysis::scenario_disclosure::checked_read_boolean_site(
            sources.db(),
            sources.trees(),
            sources.resolved(),
            &original.types,
            &original.effects,
            module,
            model,
            key,
            statement,
        )?;
        // Each collected observer is an independent validation unit:
        // prior units must not spend its finite expression budget.
        // Total output stays capped below.
        consumer.steps = 0;
        if !consumer.same(site.node, expr.span) || !consumer.origin(&site.source, site.node, module)
        {
            return None;
        }
        let mut matched = HashSet::new();
        consumer.expression(expr, &[], &mut HashSet::new(), &site.calls, &mut matched, 0)?;
        if matched.len() != site.calls.len() {
            return None;
        }
        let mut identity = serde_json::json!({"source":{"path":site.source.path,"sha256":site.source.sha256,"module":site.source.module},"owner":owner,
            "node":serial_node(site.node),"statement":serial_node(site.statement),
            "model":ir.items.get(model.0 as usize)?.canonical,"kind":kind});
        if let Some(field) = field {
            identity["field"] = serde_json::Value::String(field);
        }
        let sites = serialize_sites(original, ir, sources.db(), vec![site], Some(&owner))?;
        output.push((expr.span, identity, sites));
        if output.len() > 200 {
            return None;
        }
    }
    for (module, owner, expr, key, statement) in stateless {
        let collected = crate::analysis::scenario_disclosure::collect_read_calls(
            sources.db(),
            sources.trees(),
            sources.resolved(),
            &original.types,
            &original.effects,
            module,
            key,
        )?;
        // Each collected observer is an independent validation unit:
        // prior units must not spend its finite expression budget.
        // Total output stays capped below.
        consumer.steps = 0;
        if !consumer.same(key, expr.span)
            || !consumer.origin(&collected.source, key, module)
        {
            return None;
        }
        let mut matched = HashSet::new();
        consumer.expression(
            expr,
            &[],
            &mut HashSet::new(),
            &collected.calls,
            &mut matched,
            0,
        )?;
        if matched.len() != collected.calls.len() {
            return None;
        }
        let mut count = 0usize;
        let mut values = 0usize;
        let mut calls = Vec::new();
        for call in &collected.calls {
            calls.push(serialize_call(
                original,
                ir,
                sources.db(),
                call,
                &mut count,
                &mut values,
            )?);
        }
        let origin = collected.source.clone();
        let identity = serde_json::json!({"source":{"path":origin.path,"sha256":origin.sha256,"module":origin.module},"owner":owner.clone(),
            "node":serial_node(key),"statement":serial_node(statement),"kind":"page-require"});
        let sites = vec![SerialDecisionSite {
            version: 1,
            source: serial_source(collected.source),
            owner,
            node: serial_node(key),
            statement: serial_node(statement),
            stage: "read-predicate".into(),
            position: Vec::new(),
            calls,
        }];
        output.push((expr.span, identity, sites));
        if output.len() > 200 {
            return None;
        }
    }
    Some(output)
}

fn serialize_sites(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    sites: Vec<CheckedDecisionSite>,
    owner_override: Option<&str>,
) -> Option<Vec<SerialDecisionSite>> {
    let mut output = Vec::new();
    let mut count = 0usize;
    let mut values = 0usize;
    for site in &sites {
        let mut calls = Vec::new();
        for call in &site.calls {
            calls.push(serialize_call(program, ir, db, call, &mut count, &mut values)?);
        }
        let position = site
            .position
            .iter()
            .map(|p| match p {
                Position::Guard(index) => SerialDecisionPosition::Guard { index: *index },
                Position::Body(index) => SerialDecisionPosition::Body { index: *index },
                Position::Then(index) => SerialDecisionPosition::Then { index: *index },
                Position::Else(index) => SerialDecisionPosition::Else { index: *index },
                Position::Loop(index) => SerialDecisionPosition::Loop { index: *index },
                Position::Match { arm, statement } => SerialDecisionPosition::Match {
                    arm: *arm,
                    statement: *statement,
                },
            })
            .collect();
        output.push(SerialDecisionSite {
            version: 1,
            source: serial_source(site.source.clone()),
            owner: match owner_override {
                Some(owner) => owner.to_owned(),
                None => serialize_canonical(program, ir, site.owner)?,
            },
            node: serial_node(site.node),
            statement: serial_node(site.statement),
            stage: match site.stage {
                Stage::LeadingRequire => "leading-require",
                Stage::BodyRequire => "body-require",
                Stage::BodyCondition => "body-condition",
                Stage::ReadPolicy => "read-policy",
                Stage::ReadPredicate => "read-predicate",
                Stage::SendDispatch => "send-dispatch",
            }
            .into(),
            position,
            calls,
        });
    }
    Some(output)
}
/// A leading source requirement has its own observer; its original decision
/// stage remains untouched. Fresh source/IR correspondence and the complete
/// selected helper census authenticate the private emitted callable.
pub(super) fn serialize_scenario_requires(
    sources: &FreshSourceContext<'_>,
) -> Option<Vec<(Span, serde_json::Value)>> {
    use crate::analysis::scenario_disclosure::{CheckedDecisionPosition, CheckedDecisionStage};
    let original = sources.original();
    let ir = sources.ir();
    let mut output = Vec::new();
    for owner in &ir.items {
        let Some(facts) = original
            .scenario_disclosures()
            .get(&owner.id)
            .and_then(|value| value.source_facts())
        else {
            continue;
        };
        let Some(sites) = facts.source_requires.as_deref() else {
            continue;
        };
        if sites.is_empty() {
            continue;
        }
        let IrItemKind::Scenario {
            params,
            guards,
            read: false,
            trusted: false,
            cohort: None,
            ..
        } = &owner.kind
        else {
            return None;
        };
        let expected = sources.fresh().items.get(owner.id.0 as usize)?;
        let IrItemKind::Scenario {
            guards: expected_guards,
            ..
        } = &expected.kind
        else {
            return None;
        };
        let mut semantic = SemanticJoin {
            program: original,
            actual: ir,
            expected: sources.fresh(),
            nodes: 0,
            stack: HashSet::new(),
        };
        let mut consumer = Consumer {
            program: original,
            ir,
            db: sources.db(),
            catalog: sources.catalog(),
            nodes: HashMap::new(),
            steps: 0,
            count: 0,
        };
        let mut required = HashSet::new();
        for site in sites {
            required.extend([site.node, site.statement]);
            for call in &site.calls {
                required.insert(call.node);
                required.extend(call.arguments.iter().map(|(node, _)| *node));
                if let CheckedDecisionCallTarget::DeriveFn(id) = call.target {
                    required.insert(original.effects.derives.get(&id)?.expr?);
                }
            }
        }
        consumer.index_required(sources.trees(), &required)?;
        for site in sites {
            let [CheckedDecisionPosition::Guard(index)] = site.position.as_slice() else {
                return None;
            };
            let IrStmt::Require { cond, span } = guards.get(*index)? else {
                return None;
            };
            let IrStmt::Require {
                cond: expected_cond,
                span: expected_span,
            } = expected_guards.get(*index)?
            else {
                return None;
            };
            if site.stage != CheckedDecisionStage::LeadingRequire
                || site.owner != owner.id
                || *span != *expected_span
                || !consumer.same(site.statement, *span)
                || !consumer.same(site.node, cond.span)
                || cond.ty != ResolvedType::Scalar(Scalar::Bool)
                || !consumer.origin(&site.source, site.node, owner.module)
            {
                return None;
            }
            semantic.expression(cond, expected_cond, 0)?;
            consumer.steps = 0;
            let mut matched = HashSet::new();
            consumer.expression(cond, &[], &mut HashSet::new(), &site.calls, &mut matched, 0)?;
            if matched.len() != site.calls.len() {
                return None;
            }
            // Recollect the same expression for its read observer. This is not
            // a mutation of the original LeadingRequire membership record.
            let observer = crate::analysis::scenario_disclosure::checked_read_boolean_site(
                sources.db(),
                sources.trees(),
                sources.resolved(),
                &original.types,
                &original.effects,
                owner.module,
                owner.id,
                site.node,
                site.statement,
            )?;
            if observer.calls != site.calls || observer.source != site.source {
                return None;
            }
            let serialized = serialize_sites(
                original,
                ir,
                sources.db(),
                vec![observer],
                Some(&owner.canonical),
            )?;
            let mut parameters = Vec::new();
            if params.len() != facts.parameters.len() {
                return None;
            }
            for (index, (id, checked)) in params.iter().zip(&facts.parameters).enumerate() {
                let item = ir.items.get(id.0 as usize)?;
                let IrItemKind::Param {
                    owner: declared_owner,
                    index: declared_index,
                    ty: IrType::Known(ty),
                    default: None,
                    ..
                } = &item.kind
                else {
                    return None;
                };
                if *id != checked.parameter
                    || *declared_owner != owner.id
                    || *declared_index != index
                    || *ty != checked.ty
                    || checked.default.is_some()
                {
                    return None;
                }
                parameters.push(
                    serde_json::json!({"name":item.name,"typeId":serial_type(ty,original,ir,0)?}),
                );
            }
            let identity = serde_json::json!({"source":serial_source(site.source.clone()),
                "owner":owner.canonical,"node":serial_node(site.node),"statement":serial_node(site.statement),
                "parameters":parameters,"sites":serialized});
            if output.len() >= 200 {
                return None;
            }
            output.push((cond.span, identity));
        }
    }
    Some(output)
}

fn serial_node(node: NodeKey) -> SerialDecisionNode {
    SerialDecisionNode {
        start: node.start,
        end: node.end,
    }
}

/// Canonical owning identity shared by every serialized decision call: the
/// IR item and the checked symbol must agree on id, canonical name and
/// module, with no empty or invented declaration.
fn serialize_canonical(
    program: &CheckedProgram,
    ir: &IrProgram,
    id: crate::analysis::resolve::SymbolId,
) -> Option<String> {
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
}

/// One checked decision call with its owning sources, argument types, slots,
/// defaults and helper chain. Transport budgets match `serialize_sites`.
fn serialize_call(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    call: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
    count: &mut usize,
    values: &mut usize,
) -> Option<SerialDecisionCall> {
    *count += 1;
    *values = values.checked_add(
        call.arguments.len() + call.slots.len() + call.defaults.len() + call.chain.len() + 1,
    )?;
    if *count > 200 || *values > 20000 {
        return None;
    }
    let target = match &call.target {
        crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::Builtin { id, overload } => {
            SerialDecisionTarget::Builtin {
                id: id.clone(),
                overload: *overload,
            }
        }
        crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::DeriveFn(id) => {
            SerialDecisionTarget::Derive {
                name: serialize_canonical(program, ir, *id)?,
            }
        }
    };
    let mut arguments = Vec::new();
    for (node, ty) in &call.arguments {
        arguments.push(SerialDecisionArgument {
            node: serial_node(*node),
            type_id: serial_type(ty, program, ir, 0)?,
        });
    }
    let mut defaults = Vec::new();
    for (id, node) in &call.defaults {
        let item = ir.items.get(id.0 as usize)?;
        let IrItemKind::Param {
            default_node: Some(actual),
            ty: IrType::Known(ty),
            ..
        } = &item.kind
        else {
            return None;
        };
        if *actual != *node {
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
            parameter: serialize_canonical(program, ir, *id)?,
            source: SerialDecisionSource {
                path: file.path.clone(),
                sha256: file.sha256.clone(),
                module: module.name.clone(),
            },
            node: serial_node(*node),
            type_id: serial_type(ty, program, ir, 0)?,
        });
    }
    let mut chain = Vec::new();
    for frame in &call.chain {
        chain.push(SerialDecisionFrame {
            source: serial_source(frame.source.clone()),
            node: serial_node(frame.node),
            derive: serialize_canonical(program, ir, frame.derive)?,
        });
    }
    Some(SerialDecisionCall {
        source: serial_source(call.source.clone()),
        node: serial_node(call.node),
        target,
        arguments,
        slots: call.slots.clone(),
        defaults,
        chain,
    })
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
pub(super) fn serial_type(
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
        ResolvedType::StdNominal { .. }
            if crate::analysis::types::checked_standard_nominal_name(ty) == Some("TextMessage") =>
        {
            "TextMessage".into()
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

/// A bare checked `parent.Child` member has no explicit query clauses. Its
/// existing lowering remains source correspondence only, never a query receipt.
fn checked_contained_query(
    program: &CheckedProgram,
    ir: &IrProgram,
    query: &IrQuery,
    span: Span,
    ty: &ResolvedType,
) -> Option<()> {
    use crate::analysis::resolve::{ModelOwner, SymbolKind};
    if query.source.is_some()
        || query.collection_call.is_some()
        || query.contract_collection_call.is_some()
        || query.where_pred.is_some()
        || query.where_async
        || query.value_order.is_some()
        || !query.order.is_empty()
        || query.limit.is_some()
        || query.archived.is_some()
        || query.select.is_some()
        || query.select_param.is_some()
    {
        return None;
    }
    let member = NodeKey {
        file: span.file,
        start: span.start,
        end: span.end,
        kind: SyntaxKind::Member as u8,
    };
    if program.types.node_types.get(&member) != Some(ty) {
        return None;
    }
    let ResolvedType::Array {
        element,
        ordered: true,
        nonempty: false,
    } = ty
    else {
        return None;
    };
    let ResolvedType::Record {
        symbol: child,
        stored: true,
    } = element.as_ref()
    else {
        return None;
    };
    let declaration = program.symbols.get(child.0 as usize)?;
    let SymbolKind::Model {
        owner: ModelOwner::ChildOf(owner),
        ..
    } = &declaration.kind
    else {
        return None;
    };
    let item = ir.items.get(child.0 as usize)?;
    if declaration.id != *child
        || item.id != *child
        || item.canonical != declaration.canonical
        || item.module != declaration.module
        || !matches!(item.kind, IrItemKind::Model { owner: IrOwner::ChildOf(actual), .. } if actual == *owner)
        || !matches!(&query.domain, IrQueryDomain::Model(name) if name == &declaration.canonical)
    {
        return None;
    }
    let parent = query.parent.as_deref()?;
    let parent_ty = ResolvedType::Record {
        symbol: *owner,
        stored: true,
    };
    let parent_kind = match &parent.expr {
        IrExpr::Name(_) => SyntaxKind::NameRef,
        IrExpr::Member { .. } => SyntaxKind::Member,
        _ => return None,
    };
    let parent_key = NodeKey {
        file: parent.span.file,
        start: parent.span.start,
        end: parent.span.end,
        kind: parent_kind as u8,
    };
    let parent_declaration = program.symbols.get(owner.0 as usize)?;
    let parent_item = ir.items.get(owner.0 as usize)?;
    if parent.ty != parent_ty
        || program.types.node_types.get(&parent_key) != Some(&parent_ty)
        || parent.span.file != span.file
        || parent.span.start != span.start
        || parent.span.end >= span.end
        || parent_declaration.id != *owner
        || !matches!(parent_declaration.kind, SymbolKind::Model { .. })
        || parent_item.id != *owner
        || parent_item.canonical != parent_declaration.canonical
        || parent_item.module != parent_declaration.module
        || !matches!(parent_item.kind, IrItemKind::Model { .. })
    {
        return None;
    }
    Some(())
}

fn checked_query(program: &CheckedProgram, query: &IrQuery) -> Option<()> {
    let source = query.source.as_deref()?;
    if query.value_order.is_some()
        && (matches!(query.domain, IrQueryDomain::Model(_))
            || !query.order.is_empty()
            || query.collection_call.is_some()
            || query.contract_collection_call.is_some())
    {
        return None;
    }
    if program.types.checked_queries.get(&source.node) != Some(source) {
        return None;
    }
    if let Some(call) = query.collection_call.as_ref()
        && (program.types.checked_collection_calls.get(&call.node) != Some(call.as_ref())
            || call.query != source.node)
    {
        return None;
    }
    if let Some(call) = query.contract_collection_call.as_ref()
        && (program
            .types
            .checked_contract_collection_calls
            .get(&call.node)
            != Some(call.as_ref())
            || query.collection_call.is_some()
            || call.query != source.node
            || call.domain != source.domain)
    {
        return None;
    }
    Some(())
}
fn collection_lambda(
    program: &CheckedProgram,
    args: &[TypedExpr],
    lambda: &TypedExpr,
    call: Span,
) -> Option<()> {
    collection_lambda_arguments(program, args, lambda, call, None)
}

/// Checked owning rules have the original source database available, so
/// equivalent Group arguments retain the same exact selected call proof.
pub(super) fn checked_collection_lambda(
    program: &CheckedProgram,
    args: &[TypedExpr],
    lambda: &TypedExpr,
    call: Span,
    db: &SourceDb,
) -> Option<()> {
    collection_lambda_arguments(program, args, lambda, call, Some(db))
}

fn collection_lambda_arguments(
    program: &CheckedProgram,
    args: &[TypedExpr],
    lambda: &TypedExpr,
    call: Span,
    db: Option<&SourceDb>,
) -> Option<()> {
    let normalized = |key: NodeKey| -> Option<NodeKey> {
        let Some(db) = db else {
            return Some(key);
        };
        let (tree, diagnostics) = crate::syntax::parse_source(key.file, &db.get(key.file)?.text);
        if !diagnostics.is_empty() {
            return None;
        }
        let mut node = tree.descendants().find(|node| NodeKey::of(node) == key)?;
        for _ in 0..65 {
            if node.kind != SyntaxKind::Group {
                return Some(NodeKey::of(node));
            }
            node = node.children.iter().find(|child| {
                child.token().is_none()
                    && !matches!(child.kind, SyntaxKind::Trivia | SyntaxKind::Comment)
            })?;
        }
        None
    };
    let IrExpr::Lambda { param, body } = &lambda.expr else {
        return None;
    };
    let key = NodeKey {
        file: call.file,
        start: call.start,
        end: call.end,
        kind: SyntaxKind::Call as u8,
    };
    let selected = program.types.selected_calls.get(&key)?;
    let SelectedCallTarget::Builtin { id, .. } = &selected.target else {
        return None;
    };
    if !matches!(id.as_str(), "any" | "all") {
        return None;
    }
    let predicate_slot = selected.slots.get(1).copied().flatten()?;
    let domain_slot = selected.slots.first().copied().flatten()?;
    if !std::ptr::eq(args.get(predicate_slot)?, lambda) {
        return None;
    }
    let IrExpr::Query(query) = &args.get(domain_slot)?.expr else {
        return None;
    };
    checked_query(program, query)?;
    let source = query.source.as_deref()?;
    if normalized(*selected.arguments.get(domain_slot)?)? != source.node {
        return None;
    }
    let predicate_key = selected.arguments.get(predicate_slot)?;
    let predicate = normalized(*predicate_key)?;
    if predicate.file != lambda.span.file
        || predicate.start != lambda.span.start
        || predicate.end != lambda.span.end
        || program.types.node_types.get(predicate_key) != Some(&lambda.ty)
        || body.ty != lambda.ty
    {
        return None;
    }
    let mut aliases = source.clauses.iter().filter_map(|clause| {
        if let crate::analysis::types::CheckedQueryClauseKind::As { name } = &clause.kind {
            Some(name)
        } else {
            None
        }
    });
    if aliases.next()? != param || aliases.next().is_some() {
        return None;
    }
    Some(())
}

#[cfg(test)]
mod consumed_index_tests {
    use super::*;
    use crate::analysis::catalog::CatalogRequest;
    use crate::analysis::{check_program, scenario_disclosure::ScenarioDisclosure};
    use std::path::Path;

    #[test]
    fn exact_decision_index_ignores_unrelated_cst_and_preserves_consumed_refusals() {
        let mut db = SourceDb::new();
        let file = db.add("decision-owner.can".into(), "package Helpers\n Given\n  export derive allowed(value:int=1):bool = ((value>0))\n When\n Then\napp DecisionScope\nuse Helpers {allowed}\nGiven\nWhen\n scenario execute() -> bool by=members\n  require allowed()\n  do return true\nThen\n".into());
        let noise = db.add(
            "unrelated.can".into(),
            format!(
                "package Noise\n Given\n{} When\n Then\n",
                "  ## unrelated source\n".repeat(200_001)
            ),
        );
        let (noise_tree, diagnostics) = syntax::parse_source(noise, &db.get(noise).unwrap().text);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(noise_tree.descendants().count() > 200_000);
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let catalog_path = root
            .parent()
            .unwrap()
            .join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = crate::analysis::catalog::load_catalog(&CatalogRequest {
            flag: Some(&catalog_path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[file, noise], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let owner = ir
            .items
            .iter()
            .find(|item| item.canonical == "DecisionScope.execute")
            .unwrap();
        let context = FreshSourceContext::prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        let sites = collect_decision_sources_with_context(&context, owner)
            .expect("unrelated CST does not consume the original owner's finite index budget");
        assert_eq!(sites.len(), 1);
        assert!(sites[0].calls.iter().any(|call| !call.defaults.is_empty()));
        for mutation in 0..4 {
            let mut changed = ir.clone();
            match mutation {
                0 | 1 => {
                    let ScenarioDisclosure::Complete(checked) =
                        changed.scenario_disclosures.get_mut(&owner.id).unwrap()
                    else {
                        panic!("original complete owner")
                    };
                    let site = &mut checked
                        .source_facts
                        .as_mut()
                        .unwrap()
                        .decision_sites
                        .as_mut()
                        .unwrap()[0];
                    if mutation == 0 {
                        site.node.start += 1;
                    } else {
                        site.calls
                            .iter_mut()
                            .find(|call| !call.defaults.is_empty())
                            .unwrap()
                            .defaults[0]
                            .1
                            .start += 1;
                    }
                }
                2 => {
                    let helper = changed
                        .items
                        .iter_mut()
                        .find(|item| item.canonical == "Helpers.allowed")
                        .unwrap();
                    let IrItemKind::DeriveFn {
                        expr: Some(body), ..
                    } = &mut helper.kind
                    else {
                        panic!("helper")
                    };
                    body.expr = IrExpr::Bool(true);
                }
                _ => {
                    let parameter = changed
                        .items
                        .iter_mut()
                        .find(|item| item.canonical == "Helpers.allowed.value")
                        .unwrap();
                    let IrItemKind::Param {
                        default: Some(default),
                        ..
                    } = &mut parameter.kind
                    else {
                        panic!("default")
                    };
                    let (IrDefault::Literal(value) | IrDefault::Computed { expr: value, .. }) =
                        default;
                    value.expr = IrExpr::Int(2);
                }
            }
            assert!(
                collect_decision_sources_with_fresh(
                    &program,
                    &changed,
                    &changed.items[owner.id.0 as usize],
                    &db,
                    Some(&catalog),
                    &ir
                )
                .is_none(),
                "consumed source/helper/default mutation {mutation}"
            );
        }
        let make_consumer = || Consumer {
            program: &program,
            ir: &ir,
            db: &db,
            catalog: Some(&catalog),
            nodes: HashMap::new(),
            steps: 0,
            count: 0,
        };
        let (tree, _) = syntax::parse_source(file, &db.get(file).unwrap().text);
        let key = sites[0].node;
        let mut missing = key;
        missing.start += 1;
        assert!(
            make_consumer()
                .index_required(&[(file, tree.clone())], &HashSet::from([missing]))
                .is_none()
        );
        assert!(
            make_consumer()
                .index_required(&[(file, tree.clone()), (file, tree)], &HashSet::from([key]))
                .is_none(),
            "ambiguous source anchor refuses"
        );
        assert!(
            make_consumer()
                .index_required(
                    &[(noise, noise_tree.clone())],
                    &HashSet::from([NodeKey::of(&noise_tree)])
                )
                .is_none(),
            "the consumed subtree still has its original 200k node bound"
        );
    }
}
