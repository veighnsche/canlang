//! Optional checked decision correspondence. This publishes no execution authority.
use super::ir::*;
use super::source_context::FreshSourceContext;
use super::source_correspondence::SemanticJoin;
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
        context.program(),
        context.ir(),
        owner,
        context.db(),
        context.catalog(),
        context.fresh(),
        context.trees(),
    )
}

fn decision_proof_sites<'a>(
    program: &CheckedProgram,
    ir: &'a IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<(
    &'a Vec<CheckedDecisionSite>,
    &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
)> {
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
    Some((proofs, source))
}

fn check_transcript_schemas(
    ir: &IrProgram,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    db: &SourceDb,
) -> Option<()> {
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
    Some(())
}

fn required_decision_nodes(
    program: &CheckedProgram,
    proofs: &[CheckedDecisionSite],
) -> Option<HashSet<NodeKey>> {
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
    Some(required)
}

fn verify_decision_sites(
    cx: &mut Consumer,
    owner: &IrItem,
    proofs: &[CheckedDecisionSite],
    sites: &[(&TypedExpr, Span, Stage, Vec<Position>)],
) -> Option<()> {
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
    Some(())
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
    let (proofs, source) = decision_proof_sites(program, ir, owner, db, catalog)?;
    check_transcript_schemas(ir, source, db)?;
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
    let required = required_decision_nodes(program, proofs)?;
    cx.index_required(trees, &required)?;
    cx.steps = 0;
    let mut sites = Vec::new();
    for (i, s) in guards.iter().enumerate() {
        cx.statements(s, vec![Position::Guard(i)], true, &mut sites)?;
    }
    for (i, s) in effects.iter().enumerate() {
        cx.statements(s, vec![Position::Body(i)], false, &mut sites)?;
    }
    verify_decision_sites(&mut cx, owner, proofs, &sites)?;
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

/// Only transparent parentheses may wrap the original collection query.
pub(super) fn collection_source_query(node: &SyntaxNode) -> Option<&SyntaxNode> {
    let expression = |node: &&SyntaxNode| {
        crate::analysis::resolve::is_expression(node.kind) || node.kind == SyntaxKind::Path
    };
    let mut sources = crate::analysis::kids(node).into_iter().filter(expression);
    let mut source = sources.next()?;
    if sources.next().is_some() {
        return None;
    }
    for _ in 0..64 {
        if source.kind != SyntaxKind::Group {
            return (source.kind == SyntaxKind::Query).then_some(source);
        }
        let mut children = crate::analysis::kids(source).into_iter().filter(expression);
        source = children.next()?;
        if children.next().is_some() {
            return None;
        }
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
    fn visit_call_args(
        &mut self,
        args: &[TypedExpr],
        e: &TypedExpr,
        chain: &[CheckedDecisionCallFrame],
        stack: &mut HashSet<crate::analysis::resolve::SymbolId>,
        calls: &[crate::analysis::scenario_disclosure::CheckedDecisionCall],
        matched: &mut HashSet<usize>,
        depth: usize,
    ) -> Option<()> {
        for a in args {
            if let IrExpr::Lambda { body, .. } = &a.expr {
                collection_lambda(self.program, args, a, e.span)?;
                self.expression(body, chain, stack, calls, matched, depth + 1)?;
            } else {
                self.expression(a, chain, stack, calls, matched, depth + 1)?;
            }
        }
        Some(())
    }
    fn find_consumed_call(
        &self,
        e: &TypedExpr,
        chain: &[CheckedDecisionCallFrame],
        calls: &[crate::analysis::scenario_disclosure::CheckedDecisionCall],
        matched: &mut HashSet<usize>,
    ) -> Option<usize> {
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
        let (i, _) = found.next()?;
        if found.next().is_some() || i != matched.len() || !matched.insert(i) {
            return None;
        }
        Some(i)
    }
    fn check_consumed_shape(
        &self,
        e: &TypedExpr,
        args: &[TypedExpr],
        p: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
        selected: &crate::analysis::types::SelectedCall,
    ) -> Option<()> {
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
        Some(())
    }
    fn check_builtin_target(
        &self,
        p: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
        selected: &SelectedCallTarget,
        target: &IrCallTarget,
    ) -> Option<bool> {
        let (
            CheckedDecisionCallTarget::Builtin { id, overload },
            SelectedCallTarget::Builtin {
                id: actual,
                overload: index,
            },
            IrCallTarget::Builtin {
                id: lowered,
                awaited,
            },
        ) = (&p.target, selected, target)
        else {
            return Some(false);
        };
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
        Some(true)
    }
    fn join_derive_defaults(
        &mut self,
        params: &[crate::analysis::resolve::SymbolId],
        declared: &crate::analysis::effects::DeriveData,
        p_slots: &[Option<usize>],
        id: crate::analysis::resolve::SymbolId,
        stack: &mut HashSet<crate::analysis::resolve::SymbolId>,
        calls: &[crate::analysis::scenario_disclosure::CheckedDecisionCall],
        matched: &mut HashSet<usize>,
        frame: &[CheckedDecisionCallFrame],
    ) -> Option<Vec<(crate::analysis::resolve::SymbolId, NodeKey)>> {
        let mut defaults = Vec::new();
        for (pid, slot) in params.iter().zip(p_slots) {
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
                if *owner != id
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
                    IrDefault::Literal(d) | IrDefault::Computed { expr: d, .. } => d,
                };
                if !self.same(*key, d.span)
                    || self.program.types.node_types.get(key) != Some(&d.ty)
                {
                    return None;
                }
                self.expression(d, frame, stack, calls, matched, 0)?;
            }
        }
        Some(defaults)
    }
    fn join_derive_call(
        &mut self,
        checked: &CheckedDecisionCallTarget,
        selected: &SelectedCallTarget,
        target: &IrCallTarget,
        p: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
        chain: &[CheckedDecisionCallFrame],
        stack: &mut HashSet<crate::analysis::resolve::SymbolId>,
        calls: &[crate::analysis::scenario_disclosure::CheckedDecisionCall],
        matched: &mut HashSet<usize>,
    ) -> Option<bool> {
        let (
            CheckedDecisionCallTarget::DeriveFn(id),
            SelectedCallTarget::DeriveFn(actual),
            IrCallTarget::DeriveFn(name),
        ) = (checked, selected, target)
        else {
            return Some(false);
        };
        let item = self.ir.items.get(id.0 as usize)?;
        if id != actual || item.id != *id || item.canonical != *name || !stack.insert(*id) {
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
        let defaults = self.join_derive_defaults(
            params,
            declared,
            &p.slots,
            *id,
            stack,
            calls,
            matched,
            &frame,
        )?;
        if defaults != p.defaults {
            return None;
        }
        self.expression(body, &frame, stack, calls, matched, 0)?;
        stack.remove(id);
        Some(true)
    }
    fn visit_query_parts(
        &mut self,
        expression: &TypedExpr,
        chain: &[CheckedDecisionCallFrame],
        stack: &mut HashSet<crate::analysis::resolve::SymbolId>,
        calls: &[crate::analysis::scenario_disclosure::CheckedDecisionCall],
        matched: &mut HashSet<usize>,
        depth: usize,
    ) -> Option<()> {
        let IrExpr::Query(query) = &expression.expr else { return None; };
        if query.source.is_some() {
            checked_query(self.program, query)?;
        } else {
            // A bare parent.Child domain has no Query syntax. Reuse the
            // exact containment/type/source proof used by SemanticJoin;
            // this carries no collection receipt or query authority.
            checked_contained_query(self.program, self.ir, query, expression.span, &expression.ty)?;
        }
        if let IrQueryDomain::Value { base, .. } = &query.domain {
            self.expression(base, chain, stack, calls, matched, depth + 1)?;
        }
        let mut expressions = [
            &query.parent,
            &query.where_pred,
            &query.limit,
            &query.archived,
            &query.select,
        ]
        .into_iter()
        .flatten()
        .map(Box::as_ref).collect::<Vec<_>>();
        expressions.extend(query.value_order.iter().map(|order| order.key.as_ref()));
        // The original call census follows authored clause order. An order
        // key may itself call a helper after a WHERE helper; visiting the
        // key first would reject their genuine, independently sealed IR.
        expressions.sort_by_key(|expression| (expression.span.file, expression.span.start, expression.span.end));
        for expression in expressions {
            if let IrExpr::Lambda { body, .. } = &expression.expr {
                self.expression(body, chain, stack, calls, matched, depth + 1)?;
            } else {
                self.expression(expression, chain, stack, calls, matched, depth + 1)?;
            }
        }
        Some(())
    }
    fn leaf_consumed(e: &TypedExpr) -> bool {
        matches!(
            &e.expr,
            IrExpr::Int(_)
                | IrExpr::Text(_)
                | IrExpr::Bool(_)
                | IrExpr::Null
                | IrExpr::Name(_)
                | IrExpr::Decimal(_)
                | IrExpr::DurationMs(_)
                | IrExpr::Money { .. }
                | IrExpr::Date(_)
                | IrExpr::Datetime(_)
        )
    }
    fn visit_compound_expr(
        &mut self,
        e: &TypedExpr,
        chain: &[CheckedDecisionCallFrame],
        stack: &mut HashSet<crate::analysis::resolve::SymbolId>,
        calls: &[crate::analysis::scenario_disclosure::CheckedDecisionCall],
        matched: &mut HashSet<usize>,
        depth: usize,
    ) -> Option<bool> {
        match &e.expr {
            IrExpr::Binary { left, right, .. } => {
                self.expression(left, chain, stack, calls, matched, depth + 1)?;
                self.expression(right, chain, stack, calls, matched, depth + 1)?;
                Some(true)
            }
            IrExpr::Unary { operand, .. } | IrExpr::Member { base: operand, .. } => {
                self.expression(operand, chain, stack, calls, matched, depth + 1)?;
                Some(true)
            }
            IrExpr::DeliveryRead { record, field, props, callback } => {
                self.expression(record, chain, stack, calls, matched, depth + 1)?;
                if let Some(callback) = callback {
                    if !callback.matches(self.ir, e, record, field, props) {
                        return None;
                    }
                }
                Some(true)
            }
            IrExpr::Array(a) => {
                for v in a {
                    self.expression(v, chain, stack, calls, matched, depth + 1)?;
                }
                Some(true)
            }
            IrExpr::Object(a) => {
                for (_, v) in a {
                    self.expression(v, chain, stack, calls, matched, depth + 1)?;
                }
                Some(true)
            }
            IrExpr::HasRole { person, .. } => {
                if let Some(person) = person {
                    self.expression(person, chain, stack, calls, matched, depth + 1)?;
                }
                Some(true)
            }
            _ => Some(false),
        }
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
            IrExpr::HasRole{role,person:Some(person)}=>{
                self.expression(person,chain,stack,calls,matched,depth+1)?;
                let index=self.find_consumed_call(e,chain,calls,matched)?;
                let call=&calls[index];self.count+=1;
                let CheckedDecisionCallTarget::Role(id)=call.target else{return None;};
                let selected=self.program.types.selected_calls.get(&call.node)?;
                if self.count>200||!self.origin(&call.source,call.node,call.module)
                    ||!matches!(selected.target,SelectedCallTarget::Role(actual)if actual==id)
                    ||!matches!(self.program.symbols.get(id.0 as usize),Some(symbol)if symbol.canonical==*role&&matches!(symbol.kind,crate::analysis::resolve::SymbolKind::Role))
                    ||!matches!(self.ir.items.get(id.0 as usize),Some(item)if item.canonical==*role&&matches!(item.kind,IrItemKind::Role{..}))
                    ||!call.defaults.is_empty(){return None;}
                self.check_consumed_shape(e,std::slice::from_ref(person.as_ref()),call,selected)?;
            },
            IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                self.visit_call_args(args, e, chain, stack, calls, matched, depth)?;
                let index = self.find_consumed_call(e, chain, calls, matched)?;
                let p = &calls[index];
                self.count += 1;
                if self.count > 200 || !self.origin(&p.source, p.node, p.module) {
                    return None;
                }
                let selected = self.program.types.selected_calls.get(&p.node)?;
                self.check_consumed_shape(e, args, p, selected)?;
                if self.check_builtin_target(p, &selected.target, target)? {
                } else if self.join_derive_call(
                    &p.target, &selected.target, target, p, chain, stack, calls, matched,
                )? {
                } else {
                    return None;
                }
            }
            IrExpr::Query(_) => {
                self.visit_query_parts(e, chain, stack, calls, matched, depth)?;
            }
            _ => {
                if self.visit_compound_expr(e, chain, stack, calls, matched, depth)? {
                } else if !Self::leaf_consumed(e) {
                    return None;
                }
            }
        }
        Some(())
    }
}

/// Private handlers do not expose a saved public result. Their ordinary
/// ordered query arrays may feed the existing owner mutation frame when the
/// complete executable owner still matches independently checked source.
/// Keep the older read-only C23 receipt family on its original path.
pub(super) fn owner_handler_queries(context: &FreshSourceContext<'_>, owner: &IrItem) -> Option<()> {
    // Recurring ticks qualify alongside declared payload events: a tick
    // carries no event inputs (DESIGN §6), so there is no payload schema
    // for Declared-ness to vouch for, and the same-semantics re-lowering
    // below re-verifies the whole handler either way.
    let IrItemKind::Scenario { params, trusted: true, result: None, read: false,
        expose_excluded: false, by, effects, event_source: Some(IrEventSource::Declared(_) | IrEventSource::Every { .. }),
        hook: None, cohort: None, .. } = &owner.kind else { return None; };
    if !params.is_empty() || !by.is_empty() { return None; }
    fn mutation(statements: &[IrStmt]) -> bool {
        statements.iter().any(|statement| match statement {
            IrStmt::Create { .. } | IrStmt::Set { .. } | IrStmt::Send { .. } | IrStmt::Emit { .. } |
            IrStmt::Schedule { .. } | IrStmt::Cancel { .. } => true,
            IrStmt::If { then_branch, else_branch, .. } => mutation(then_branch) || mutation(else_branch),
            IrStmt::For { body, .. } => mutation(body),
            IrStmt::Match { arms, .. } => arms.iter().any(|arm| mutation(&arm.body)),
            _ => false,
        })
    }
    if !mutation(effects) { return None; }
    context.same_scenario(context.ir(), owner)
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
    Role { name: String },
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionArgument {
    pub node: SerialDecisionNode,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_id: Option<String>,
    #[serde(rename = "valueShape", skip_serializing_if = "Option::is_none")]
    pub value_shape: Option<SerialDecisionValueShape>,
}
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SerialDecisionValueShape {
    Type { #[serde(rename="type")] type_id: String },
    Array { element: Box<SerialDecisionValueShape>, ordered: bool, nonempty: bool },
    Object { fields: Vec<SerialDecisionValueField> },
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialDecisionValueField { pub name: String, pub shape: SerialDecisionValueShape }
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

pub(super) fn serialize_decision_sources_with_context(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<SerialDecisionSite>> {
    let sites = collect_decision_sources_with_context(context, owner)?;
    serialize_sites(context.program(), context.ir(), context.db(), sites, None)
}

/// SEND compares against the freshly checked original; preserve that distinction
/// from membership/query consumers of the supplied checked tables.
pub(super) fn serialize_original_decision_sources_with_context(
    context: &FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<Vec<SerialDecisionSite>> {
    let sites = collect_decision_sources_checked(
        context.original(),
        context.ir(),
        owner,
        context.db(),
        context.catalog(),
        context.fresh(),
        context.trees(),
    )?;
    serialize_sites(context.original(), context.ir(), context.db(), sites, None)
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

fn match_read_rule(
    rule: &IrRuleFn,
    original: &CheckedProgram,
) -> Option<(crate::analysis::resolve::SymbolId, usize, bool)> {
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
    Some((*model, *ordinal, *callback))
}

fn check_read_rule_policy(
    program: &CheckedProgram,
    original: &CheckedProgram,
    model: crate::analysis::resolve::SymbolId,
    ordinal: usize,
    rule: &IrRuleFn,
) -> Option<bool> {
    let symbol = original.symbols.get(model.0 as usize)?;
    let actual_symbol = program.symbols.get(model.0 as usize)?;
    if actual_symbol.id != model
        || actual_symbol.canonical != symbol.canonical
        || actual_symbol.module != symbol.module
        || rule.origin.is_some()
    {
        return None;
    }
    let actual_model = program.effects.models.get(&model)?;
    let original_model = original.effects.models.get(&model)?;
    if actual_model.model != model || actual_model.module != original_model.module {
        return None;
    }
    let actual_policy = actual_model.policies.get(ordinal)?;
    let policy = original_model.policies.get(ordinal)?;
    if read_policy_mismatch(actual_policy, policy) {
        return None;
    }
    Some(policy.where_predicate.is_some())
}

fn read_policy_mismatch(
    actual: &crate::analysis::effects::PolicyRule,
    expected: &crate::analysis::effects::PolicyRule,
) -> bool {
    actual.id != expected.id
        || actual.node != expected.node
        || actual.module != expected.module
        || actual.read != expected.read
        || actual.where_predicate != expected.where_predicate
        || actual.fields != expected.fields
        || actual.callback_fields != expected.callback_fields
        || actual.fields_node != expected.fields_node
}

fn select_matching_rules<'a, 'b>(
    expected_rules: &'a [IrRuleFn],
    actual_rules: &'b [IrRuleFn],
    rule: &IrRuleFn,
) -> Option<(&'a IrRuleFn, &'b IrRuleFn)> {
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
    Some((expected, actual))
}

fn split_rule_predicates(rule: &IrRuleFn, has_where: bool) -> Option<Vec<&TypedExpr>> {
    if has_where {
        let IrExpr::Binary {
            op: IrBinOp::And,
            left,
            right,
        } = &rule.pred.expr
        else {
            return None;
        };
        Some(vec![left.as_ref(), right.as_ref()])
    } else {
        Some(vec![&rule.pred])
    }
}

fn verify_rule_predicates(
    consumer: &mut Consumer<'_>,
    sites: &[CheckedDecisionSite],
    predicates: Vec<&TypedExpr>,
    module: crate::analysis::resolve::ModuleId,
) -> Option<()> {
    if sites.len() != predicates.len() {
        return None;
    }
    for (site, predicate) in sites.iter().zip(predicates) {
        if predicate.ty != ResolvedType::Scalar(Scalar::Bool)
            || !consumer.origin(&site.source, site.node, module)
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
    Some(())
}

pub(super) fn serialize_read_rule(
    sources: &FreshSourceContext<'_>,
    rule: &IrRuleFn,
) -> Option<Vec<SerialDecisionSite>> {
    let program = sources.program();
    let ir = sources.ir();
    let db = sources.db();
    let catalog = sources.catalog();
    let original = sources.original();
    let fresh = sources.fresh();
    let trees = sources.trees();
    let resolved = sources.resolved();
    let (model, ordinal, callback) = match_read_rule(rule, original)?;
    let has_where = check_read_rule_policy(program, original, model, ordinal, rule)?;
    let expected_rules = if callback {
        &fresh.callback_read_rules
    } else {
        &fresh.read_rules
    };
    let actual_rules = if callback {
        &ir.callback_read_rules
    } else {
        &ir.read_rules
    };
    let (expected, actual) = select_matching_rules(expected_rules, actual_rules, rule)?;
    let mut semantics = SemanticJoin {
        program: original,
        actual: ir,
        expected: fresh,
        nodes: 0,
        stack: HashSet::new(),
    };
    semantics.expression(&rule.pred, &expected.pred, 0)?;
    semantics.expression(&actual.pred, &expected.pred, 0)?;
    let symbol = original.symbols.get(model.0 as usize)?;
    let sites = crate::analysis::scenario_disclosure::checked_read_decision_sites(
        db,
        trees,
        resolved,
        &original.types,
        &original.effects,
        model,
        ordinal,
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
    let predicates = split_rule_predicates(rule, has_where)?;
    verify_rule_predicates(&mut consumer, &sites, predicates, symbol.module)?;
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

fn module_identity_mismatch(module: &IrModule, expected: &IrModule) -> bool {
    module.id != expected.id
        || module.name != expected.name
        || module.file != expected.file
        || module.span != expected.span
        || module.pages.len() != expected.pages.len()
}

fn join_predicate_page(
    join: &mut SemanticJoin,
    page: &IrPage,
    expected_page: &IrPage,
) -> Option<()> {
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
    Some(())
}

fn resolve_page_node<'t>(
    consumer: &mut Consumer<'_>,
    trees: &'t [(crate::source::SourceId, crate::syntax::SyntaxNode)],
    page_span: Span,
) -> Option<(&'t crate::syntax::SyntaxNode, NodeKey)> {
    let page_key = NodeKey {
        file: page_span.file,
        start: page_span.start,
        end: page_span.end,
        kind: SyntaxKind::Page as u8,
    };
    // The sealed page subtree carries this owner's CST; a missing
    // anchor refuses exactly like the previous whole-tree lookup did.
    let Some((_, tree)) = trees.iter().find(|(file, _)| *file == page_span.file) else {
        return None;
    };
    let page_node = find_page_root(tree, page_key, &mut consumer.steps)?;
    if page_node.kind != SyntaxKind::Page {
        return None;
    }
    Some((page_node, page_key))
}

fn resolve_predicate_body(ui: &IrUi) -> Option<Option<&TypedExpr>> {
    if !matches!(ui.factory.as_str(), "list" | "table" | "calendar") {
        return Some(None);
    }
    let mut predicates = ui.props.iter().filter(|(name, _)| name == "where");
    let Some((_, predicate)) = predicates.next() else {
        return Some(None);
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
        return Some(None);
    }
    let IrExpr::Lambda { body, .. } = &predicate.expr else {
        return None;
    };
    Some(Some(body))
}

fn verify_predicate_site(
    consumer: &mut Consumer<'_>,
    site: &CheckedDecisionSite,
    body: &TypedExpr,
    module: crate::analysis::resolve::ModuleId,
) -> Option<()> {
    // Each collected site is an independent validation unit:
    // prior units must not spend its finite expression budget.
    // Total output stays capped below.
    consumer.steps = 0;
    if !consumer.same(site.node, body.span)
        || body.ty != ResolvedType::Scalar(Scalar::Bool)
        || !consumer.origin(&site.source, site.node, module)
    {
        return None;
    }
    let mut matched = HashSet::new();
    consumer.expression(body, &[], &mut HashSet::new(), &site.calls, &mut matched, 0)?;
    if matched.len() != site.calls.len() {
        return None;
    }
    Some(())
}

pub(super) fn serialize_read_predicates(sources: &FreshSourceContext<'_>) -> Option<Vec<SerialDecisionSite>> {
    let ir = sources.ir();
    let db = sources.db();
    let catalog = sources.catalog();
    let original = sources.original();
    let fresh = sources.fresh();
    let trees = sources.trees();
    let resolved = sources.resolved();
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
        if module_identity_mismatch(module, expected_module) {
            return None;
        }
        for (page, expected_page) in module.pages.iter().zip(&expected_module.pages) {
            // Each page join is pairwise, so the node budget bounds one
            // page, not the whole world: without this reset, large cohorts
            // accumulate past the cap at an arbitrary page and the caller
            // bridge (e.g. membership) loses every occurrence.
            join.nodes = 0;
            join_predicate_page(&mut join, page, expected_page)?;
            let (page_node, page_key) = resolve_page_node(&mut consumer, trees, page.span)?;
            let owner = format!("{}.{}", page.owner, page.fn_name);
            let mut pending = page.render.iter().rev().collect::<Vec<_>>();
            while let Some(ui) = pending.pop() {
                pending.extend(ui.children.iter().rev());
                let Some(body) = resolve_predicate_body(ui)? else {
                    continue;
                };
                let ui_key = NodeKey {
                    file: ui.span.file,
                    start: ui.span.start,
                    end: ui.span.end,
                    kind: SyntaxKind::Collection as u8,
                };
                let source_ui = find_page_key(page_node, ui_key, &mut consumer.steps)?;
                let query = collection_source_query(source_ui)?;
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
                verify_predicate_site(&mut consumer, &site, body, module.id)?;
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
fn resolve_page_predicate<'g>(
    original: &CheckedProgram,
    page_node: &crate::syntax::SyntaxNode,
    guard: &'g IrGuard,
) -> Option<(&'g TypedExpr, NodeKey, NodeKey)> {
    let IrGuard::Expr(expr) = guard else {
        return None;
    };
    let Some(statement) = crate::analysis::kids(page_node).into_iter().find(|n| {
        matches!(n.kind, SyntaxKind::Require | SyntaxKind::UiLeaf)
            && n.span.start <= expr.span.start
            && n.span.end >= expr.span.end
    }) else {
        return None;
    };
    let Some(predicate) = crate::analysis::kids(statement).into_iter().find(|n| {
        original.types.node_types.get(&NodeKey::of(n))
            == Some(&ResolvedType::Scalar(Scalar::Bool))
    }) else {
        return None;
    };
    if !crate::analysis::scenario_disclosure::expression_reads_membership(
        &original.types,
        &original.effects,
        NodeKey::of(predicate),
    ) {
        return None;
    }
    Some((expr, NodeKey::of(predicate), NodeKey::of(statement)))
}

type PageCandidate<'a> = (
    crate::analysis::resolve::ModuleId,
    crate::analysis::resolve::SymbolId,
    String,
    &'a TypedExpr,
    NodeKey,
    NodeKey,
    &'static str,
    Option<String>,
);

type StatelessCandidate<'a> = (
    crate::analysis::resolve::ModuleId,
    String,
    &'a TypedExpr,
    NodeKey,
    NodeKey,
);

fn push_page_candidate<'e>(
    candidates: &mut Vec<PageCandidate<'e>>,
    stateless: &mut Vec<StatelessCandidate<'e>>,
    sources: &FreshSourceContext<'_>,
    original: &CheckedProgram,
    module: crate::analysis::resolve::ModuleId,
    page_owner: &str,
    page_fn: &str,
    expr: &'e TypedExpr,
    predicate: NodeKey,
    statement: NodeKey,
    route: Option<&crate::syntax::SyntaxNode>,
) -> Option<()> {
    // An incidental route record never defines permission to read
    // (DESIGN §3): a guard without a record owner keeps its exact
    // owning page sources without inventing a model.
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
            module,
            model,
            format!("{}.{}", page_owner, page_fn),
            expr,
            predicate,
            statement,
            "page-require",
            None,
        ));
    } else if records.is_empty() && !has_scalar {
        stateless.push((
            module,
            format!("{}.{}", page_owner, page_fn),
            expr,
            predicate,
            statement,
        ));
    } else {
        return None;
    }
    Some(())
}

fn collect_page_candidates<'i>(
    ir: &'i IrProgram,
    sources: &FreshSourceContext<'_>,
    original: &'i CheckedProgram,
    consumer: &mut Consumer<'_>,
) -> Option<(Vec<PageCandidate<'i>>, Vec<StatelessCandidate<'i>>)> {
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
                let Some((expr, predicate, statement)) =
                    resolve_page_predicate(original, page_node, guard)
                else {
                    continue;
                };
                push_page_candidate(
                    &mut candidates,
                    &mut stateless,
                    sources,
                    original,
                    module.id,
                    &page.owner,
                    &page.fn_name,
                    expr,
                    predicate,
                    statement,
                    route,
                )?;
            }
        }
    }
    Some((candidates, stateless))
}

fn collect_derive_candidates<'i>(
    original: &'i CheckedProgram,
    ir: &'i IrProgram,
    candidates: &mut Vec<PageCandidate<'i>>,
) -> Option<()> {
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
    Some(())
}

fn serialize_candidate_observers(
    sources: &FreshSourceContext<'_>,
    original: &CheckedProgram,
    ir: &IrProgram,
    consumer: &mut Consumer<'_>,
    candidates: Vec<PageCandidate<'_>>,
    output: &mut Vec<(Span, serde_json::Value, Vec<SerialDecisionSite>)>,
) -> Option<()> {
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
    Some(())
}

fn serialize_stateless_observers(
    sources: &FreshSourceContext<'_>,
    original: &CheckedProgram,
    ir: &IrProgram,
    consumer: &mut Consumer<'_>,
    stateless: Vec<StatelessCandidate<'_>>,
    output: &mut Vec<(Span, serde_json::Value, Vec<SerialDecisionSite>)>,
) -> Option<()> {
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
    Some(())
}

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
    let (mut candidates, stateless) =
        collect_page_candidates(ir, sources, original, &mut consumer)?;
    collect_derive_candidates(original, ir, &mut candidates)?;
    let mut output = Vec::new();
    serialize_candidate_observers(sources, original, ir, &mut consumer, candidates, &mut output)?;
    serialize_stateless_observers(sources, original, ir, &mut consumer, stateless, &mut output)?;
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
fn collect_require_keys(
    original: &CheckedProgram,
    sites: &[CheckedDecisionSite],
) -> Option<HashSet<NodeKey>> {
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
    Some(required)
}

fn join_require_statements<'o>(
    semantic: &mut SemanticJoin<'_>,
    consumer: &mut Consumer<'_>,
    owner: &IrItem,
    site: &CheckedDecisionSite,
    guards: &'o [IrStmt],
    effects: &'o [IrStmt],
    expected_guards: &[IrStmt],
    expected_effects: &[IrStmt],
) -> Option<&'o TypedExpr> {
    use crate::analysis::scenario_disclosure::{CheckedDecisionPosition, CheckedDecisionStage};
    let (actual, expected) = match (site.position.as_slice(), site.stage) {
        ([CheckedDecisionPosition::Guard(index)], CheckedDecisionStage::LeadingRequire) => {
            (guards.get(*index)?, expected_guards.get(*index)?)
        }
        ([CheckedDecisionPosition::Body(index),nested @ ..], CheckedDecisionStage::BodyRequire) => {
            let mut actual=effects.get(*index)?;
            let mut expected=expected_effects.get(*index)?;
            if !nested.is_empty(){semantic.statements(&effects[..*index],&expected_effects[..*index],0)?;}
            for position in nested {
                let (IrStmt::If{cond:ac,then_branch:a,else_branch:b,span:at},IrStmt::If{cond:bc,then_branch:x,else_branch:y,span:bt})=(actual,expected) else{return None;};
                if at!=bt{return None;}semantic.expression(ac,bc,0)?;
                let (left,right,index)=match position {
                    CheckedDecisionPosition::Then(index)=>(a,x,*index),
                    CheckedDecisionPosition::Else(index)=>(b,y,*index),
                    _=>return None,
                };
                semantic.statements(left.get(..index)?,right.get(..index)?,0)?;
                actual=left.get(index)?;expected=right.get(index)?;
            }
            (actual,expected)
        }
        ([CheckedDecisionPosition::Body(index)], CheckedDecisionStage::BodyCondition) => {
            semantic.statements(effects.get(..*index)?,expected_effects.get(..*index)?,0)?;
            (effects.get(*index)?,expected_effects.get(*index)?)
        }
        ([CheckedDecisionPosition::Body(index),CheckedDecisionPosition::Loop(child)], CheckedDecisionStage::BodyCondition) => {
            semantic.statements(effects.get(..*index)?,expected_effects.get(..*index)?,0)?;
            let (IrStmt::For{body:a,span:at,..},IrStmt::For{body:b,span:bt,..})=(effects.get(*index)?,expected_effects.get(*index)?)else{return None;};
            if at!=bt{return None;}
            if *child!=0||a.len()!=1||b.len()!=1{
                let work=semantic.program.scenario_disclosures().get(&owner.id)?.source_facts()?.member_work_loops.as_deref()?;
                if !work.iter().any(|plan|plan.node.file==at.file&&plan.node.start==at.start&&plan.node.end==at.end
                    &&plan.condition==site.node&&plan.condition_statement==site.statement){return None;}
                // The independently checked Work shape retains its entire
                // selection and prefix, including optional SET and CANCEL.
                semantic.statements(std::slice::from_ref(effects.get(*index)?),
                    std::slice::from_ref(expected_effects.get(*index)?),0)?;
            }
            (a.get(*child)?,b.get(*child)?)
        }
        _ => return None,
    };
    let (cond,span,expected_cond,expected_span)=match(actual,expected,site.stage) {
        (IrStmt::Require{cond,span},IrStmt::Require{cond:other,span:at},CheckedDecisionStage::LeadingRequire|CheckedDecisionStage::BodyRequire)=>(cond,span,other,at),
        (IrStmt::If{cond,span,..},IrStmt::If{cond:other,span:at,..},CheckedDecisionStage::BodyCondition)=>(cond,span,other,at),
        _=>return None,
    };
    if site.owner != owner.id
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
    Some(cond)
}

fn plain_source_value(ir: &IrProgram, ty: &ResolvedType, depth: usize) -> bool {
    if depth >= 16 { return false; }
    match ty {
        ResolvedType::Scalar(scalar) => *scalar != Scalar::File,
        ResolvedType::Nullable(inner) | ResolvedType::Array {element:inner,ordered:true,..} => plain_source_value(ir,inner,depth+1),
        ResolvedType::Object(fields) => fields.len() <= 200 && fields.iter().all(|(_,ty)|plain_source_value(ir,ty,depth+1)),
        ResolvedType::Record {symbol,..} => matches!(ir.items.get(symbol.0 as usize).map(|item|&item.kind),
            Some(IrItemKind::Contract {fields,..}) if !fields.is_empty() && fields.len()<=200
                && fields.iter().all(|id|matches!(ir.items.get(id.0 as usize).map(|item|&item.kind),
                    Some(IrItemKind::Field {ty:IrType::Known(ty),..}) if plain_source_value(ir,ty,depth+1)))),
        _ => false,
    }
}

fn serialize_require_params(
    ir: &IrProgram,
    original: &CheckedProgram,
    owner: &IrItem,
    params: &[crate::analysis::resolve::SymbolId],
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    sources: &FreshSourceContext<'_>,
) -> Option<Vec<serde_json::Value>> {
    if params.len() != facts.parameters.len() {
        return None;
    }
    let mut parameters = Vec::new();
    for (index, (id, checked)) in params.iter().zip(&facts.parameters).enumerate() {
        let item = ir.items.get(id.0 as usize)?;
        let IrItemKind::Param {
            owner: declared_owner,
            index: declared_index,
            ty: IrType::Known(ty),
            default,
            default_node,
            default_copy_source,
            ..
        } = &item.kind
        else {
            return None;
        };
        // Consume the original analysis proof once; never infer unreadness
        // from absence in a lowered body or a user-supplied wire flag.
        let unread_file = facts.unread_file_parameters.contains(id);
        if unread_file { sources.same_scenario(ir, owner)?; }
        let exact_unread_file_array = unread_file
            && matches!(ty, ResolvedType::Array { element, ordered: true, nonempty: false }
                if element.as_ref() == &ResolvedType::Scalar(Scalar::File))
            && default_copy_source.is_none()
            && match (default, default_node, checked.default) {
                (None, None, None) => true,
                (Some(IrDefault::Literal(value)), Some(node), Some(original_node)) =>
                    *node == original_node && value.ty == *ty
                        && matches!(&value.expr, IrExpr::Array(elements) if elements.is_empty())
                        && value.span == Span::new(node.file, node.start, node.end),
                _ => false,
            };
        let exact_null_default = matches!(ty,
            ResolvedType::Nullable(inner) if inner.as_ref() == &ResolvedType::Scalar(Scalar::File)
                || matches!(inner.as_ref(),ResolvedType::Record{symbol,stored:true}
                    if ir.items.get(symbol.0 as usize).is_some_and(|model|matches!(model.kind,IrItemKind::Model{..}))))
            && matches!((default, default_node, checked.default),
                (Some(IrDefault::Literal(value)), Some(node), Some(original_node))
                    if *node == original_node && value.ty == ResolvedType::Null
                        && matches!(value.expr, IrExpr::Null)
                        && value.span == Span::new(node.file, node.start, node.end))
            && default_copy_source.is_none() && checked.constraints.is_none();
        let exact_empty_text_array = matches!(ty, ResolvedType::Array { element, ordered: true, nonempty: false }
            if element.as_ref() == &ResolvedType::Scalar(Scalar::Text))
            && matches!((default, default_node, checked.default),
                (Some(IrDefault::Literal(value)), Some(node), Some(original_node))
                    if *node == original_node && value.ty == *ty
                        && matches!(&value.expr, IrExpr::Array(elements) if elements.is_empty())
                        && value.span == Span::new(node.file, node.start, node.end))
            && default_copy_source.is_none() && checked.constraints.is_none();
        let source_value_default = plain_source_value(ir,ty,0) && checked.constraints.is_none()
            && checked.default.is_some() && *default_node == checked.default
            && sources.same_scenario(ir, owner).is_some()
            && match default {
                Some(IrDefault::Literal(value)) => matches!(&value.expr,
                    IrExpr::Int(_) | IrExpr::Decimal(_) | IrExpr::Text(_) | IrExpr::Bool(_) | IrExpr::Null
                    | IrExpr::Date(_) | IrExpr::Datetime(_) | IrExpr::DurationMs(_))
                    || matches!(&value.expr,IrExpr::Array(values) if values.is_empty()),
                Some(IrDefault::Computed {expr,..}) => default_copy_source.is_some_and(|source|
                    params[..index].contains(&source) && ir.items.get(source.0 as usize).is_some_and(|parameter|
                        matches!(&parameter.kind,IrItemKind::Param {ty:IrType::Known(prior),default:None,..}
                            if prior == ty && matches!(&expr.expr,IrExpr::Name(name) if name == &parameter.name)))),
                _ => false,
            };
        if *id != checked.parameter
            || *declared_owner != owner.id
            || *declared_index != index
            || *ty != checked.ty
            || !(default.is_none() && checked.default.is_none() || exact_null_default || exact_empty_text_array || source_value_default || exact_unread_file_array)
        {
            return None;
        }
        let mut parameter = serde_json::json!({"name":item.name,"typeId":serial_type(ty,original,ir,0)?});
        if unread_file { parameter["unread"] = serde_json::json!(true); }
        parameters.push(parameter);
    }
    Some(parameters)
}

fn serialize_require_observer(
    sources: &FreshSourceContext<'_>,
    original: &CheckedProgram,
    ir: &IrProgram,
    owner: &IrItem,
    site: &CheckedDecisionSite,
    cond: &TypedExpr,
    parameters: Vec<serde_json::Value>,
    output: &mut Vec<(Span, serde_json::Value)>,
) -> Option<()> {
    // Recollect the same expression for its read observer. This is not
    // a mutation of the original leading/body Require membership record.
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
    let mut identity = serde_json::json!({"source":serial_source(site.source.clone()),
        "owner":owner.canonical,"node":serial_node(site.node),"statement":serial_node(site.statement),
        "parameters":parameters,"sites":serialized});
    if site.stage==crate::analysis::scenario_disclosure::CheckedDecisionStage::BodyCondition {
        identity["decision"]=serde_json::json!("if");
    }
    if let [crate::analysis::scenario_disclosure::CheckedDecisionPosition::Body(index),crate::analysis::scenario_disclosure::CheckedDecisionPosition::Loop(child)]=site.position.as_slice(){
        let IrItemKind::Scenario{effects,..}=&owner.kind else{return None;};
        let IrStmt::For{item,domain,body,span,..}=effects.get(*index)?else{return None;};
        if *child!=0||body.len()!=1{
            let plans=original.scenario_disclosures().get(&owner.id)?.source_facts()?.member_work_loops.as_deref()?;
            if !plans.iter().any(|plan|plan.node.file==span.file&&plan.node.start==span.start&&plan.node.end==span.end
                &&plan.condition==site.node&&plan.condition_statement==site.statement){return None;}
        }
        let ResolvedType::Array{element,..}=&domain.ty else{return None;};
        let ResolvedType::Record{symbol,stored:true}=element.as_ref() else{return None;};
        let mut ancestor=*symbol;let mut visited=HashSet::new();
        loop{
            if !visited.insert(ancestor)||visited.len()>32{return None;}
            super::source_loops::model_corresponds(sources,ancestor)?;
            let IrItemKind::Model{owner,..}=&ir.items.get(ancestor.0 as usize)?.kind else{return None;};
            if let super::ir::IrOwner::ChildOf(parent)=owner{ancestor=*parent;}else{break;}
        }
        identity["loop"]=serde_json::json!({"node":{"start":span.start,"end":span.end},"item":item,"model":ir.items.get(symbol.0 as usize)?.canonical});
        let parameters=identity["parameters"].as_array_mut()?;
        if parameters.iter().any(|parameter|parameter["name"]==*item){return None;}
        parameters.push(serde_json::json!({"name":item,"typeId":ir.items.get(symbol.0 as usize)?.canonical}));
    }
    if output.len() >= 200 {
        return None;
    }
    output.push((cond.span, identity));
    Some(())
}

pub(super) fn serialize_scenario_requires(
    sources: &FreshSourceContext<'_>,
) -> Option<Vec<(Span, serde_json::Value)>> {
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
            effects,
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
            effects: expected_effects,
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
        let required = collect_require_keys(original, sites)?;
        consumer.index_required(sources.trees(), &required)?;
        let mut staged_owner_sealed=false;
        // State binds each operation's observer inventory independently.
        // Keep the existing finite site bound on that owner, not the corpus.
        let mut owner_output=Vec::new();
        for site in sites {
            if site.stage==crate::analysis::scenario_disclosure::CheckedDecisionStage::BodyCondition && !staged_owner_sealed {
                // A staged branch must retain its original prefix and both
                // arms, not only the condition that borrows owner control.
                sources.same_scenario(ir, owner)?;
                staged_owner_sealed=true;
            }
            let cond = join_require_statements(
                &mut semantic,
                &mut consumer,
                owner,
                site,
                guards,
                effects,
                expected_guards,
                expected_effects,
            )?;
            let parameters = serialize_require_params(ir, original, owner, params, facts, sources)?;
            serialize_require_observer(
                sources,
                original,
                ir,
                owner,
                site,
                cond,
                parameters,
                &mut owner_output,
            )?;
        }
        output.extend(owner_output);
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
fn serialize_call_target(
    program: &CheckedProgram,
    ir: &IrProgram,
    call: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
) -> Option<SerialDecisionTarget> {
    Some(match &call.target {
        crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::Role(id)=>{
            if !matches!(ir.items.get(id.0 as usize)?.kind,IrItemKind::Role{..}){return None;}
            SerialDecisionTarget::Role{name:serialize_canonical(program,ir,*id)?}
        },
        crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::Builtin {
            id,
            overload,
        } => SerialDecisionTarget::Builtin {
            id: id.clone(),
            overload: *overload,
        },
        crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::DeriveFn(id) => {
            SerialDecisionTarget::Derive {
                name: serialize_canonical(program, ir, *id)?,
            }
        }
    })
}

fn serialize_call_defaults(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    call: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
) -> Option<Vec<SerialDecisionDefault>> {
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
    Some(defaults)
}

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
    let target = serialize_call_target(program, ir, call)?;
    let mut arguments = Vec::new();
    for (node, ty) in &call.arguments {
        let type_id = serial_type(ty, program, ir, 0);
        let value_shape = if type_id.is_none() {
            if !plain_source_value(ir,ty,0) { return None; }
            Some(serial_value_shape(ty,program,ir,0)?)
        } else { None };
        arguments.push(SerialDecisionArgument { node: serial_node(*node), type_id, value_shape });
    }
    let defaults = serialize_call_defaults(program, ir, db, call)?;
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
fn serial_value_shape(ty: &ResolvedType, program: &CheckedProgram, ir: &IrProgram,
    depth: usize) -> Option<SerialDecisionValueShape> {
    if depth >= 16 || matches!(ty, ResolvedType::Scalar(Scalar::File | Scalar::Secret | Scalar::Member | Scalar::Json | Scalar::Bytes)) { return None; }
    if let Some(type_id) = serial_type(ty,program,ir,0) {
        return Some(SerialDecisionValueShape::Type {type_id});
    }
    Some(match ty {
        ResolvedType::Array {element,ordered,nonempty} => SerialDecisionValueShape::Array {
            element:Box::new(serial_value_shape(element,program,ir,depth+1)?), ordered:*ordered, nonempty:*nonempty },
        ResolvedType::Object(fields) if !fields.is_empty() && fields.len()<=200 => SerialDecisionValueShape::Object {
            fields:fields.iter().map(|(name,ty)| Some(SerialDecisionValueField {name:name.clone(),
                shape:serial_value_shape(ty,program,ir,depth+1)?})).collect::<Option<_>>()? },
        _ => return None,
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
fn serial_record_type(item: &IrItem) -> Option<String> {
    if !matches!(
        item.kind,
        IrItemKind::Model { .. } | IrItemKind::Contract { .. } | IrItemKind::Event { .. }
    ) {
        return None;
    }
    Some(item.canonical.clone())
}

fn serial_enum_type(item: &IrItem, id: &crate::analysis::resolve::SymbolId, cases: &Vec<String>) -> Option<String> {
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
    Some(item.canonical.clone())
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
        ResolvedType::Record { symbol, .. } => serial_record_type(nominal(*symbol)?)?,
        ResolvedType::Enum {
            owner: Some(id),
            cases,
        } => serial_enum_type(nominal(*id)?, id, cases)?,
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
fn contained_query_bare(query: &IrQuery) -> bool {
    query.source.is_some()
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
}

fn contained_child_match(
    program: &CheckedProgram,
    ir: &IrProgram,
    query: &IrQuery,
    span: Span,
    ty: &ResolvedType,
) -> Option<crate::analysis::resolve::SymbolId> {
    use crate::analysis::resolve::{ModelOwner, SymbolKind};
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
    Some(*owner)
}

pub(super) fn checked_contained_query(
    program: &CheckedProgram,
    ir: &IrProgram,
    query: &IrQuery,
    span: Span,
    ty: &ResolvedType,
) -> Option<()> {
    if contained_query_bare(query) {
        return None;
    }
    let owner = contained_child_match(program, ir, query, span, ty)?;
    contained_parent_ok(program, ir, query, span, owner)
}

fn contained_parent_ok(
    program: &CheckedProgram,
    ir: &IrProgram,
    query: &IrQuery,
    span: Span,
    owner: crate::analysis::resolve::SymbolId,
) -> Option<()> {
    use crate::analysis::resolve::SymbolKind;
    let parent = query.parent.as_deref()?;
    let parent_ty = ResolvedType::Record {
        symbol: owner,
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
        || parent_declaration.id != owner
        || !matches!(parent_declaration.kind, SymbolKind::Model { .. })
        || parent_item.id != owner
        || parent_item.canonical != parent_declaration.canonical
        || parent_item.module != parent_declaration.module
        || !matches!(parent_item.kind, IrItemKind::Model { .. })
    {
        return None;
    }
    Some(())
}

pub(super) fn checked_query(program: &CheckedProgram, query: &IrQuery) -> Option<()> {
    let source = query.source.as_deref()?;
    if query.value_order.is_some()
        && (!query.order.is_empty()
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
pub(super) fn collection_lambda(
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

fn normalized_lambda_key(db: Option<&SourceDb>, key: NodeKey) -> Option<NodeKey> {
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
}

fn join_lambda_query<'a>(
    program: &CheckedProgram,
    args: &'a [TypedExpr],
    lambda: &TypedExpr,
    call: Span,
) -> Option<(&'a IrQuery, NodeKey, NodeKey)> {
    let IrExpr::Lambda { body, .. } = &lambda.expr else {
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
    if !matches!(id.as_str(), "any" | "all" | "group") {
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
    if body.ty != lambda.ty {
        return None;
    }
    Some((
        query,
        *selected.arguments.get(domain_slot)?,
        *selected.arguments.get(predicate_slot)?,
    ))
}

fn collection_lambda_arguments(
    program: &CheckedProgram,
    args: &[TypedExpr],
    lambda: &TypedExpr,
    call: Span,
    db: Option<&SourceDb>,
) -> Option<()> {
    let IrExpr::Lambda { param, .. } = &lambda.expr else {
        return None;
    };
    let (query, domain_key, predicate_key) = join_lambda_query(program, args, lambda, call)?;
    let source = query.source.as_deref()?;
    if normalized_lambda_key(db, domain_key)? != source.node {
        return None;
    }
    let predicate = normalized_lambda_key(db, predicate_key)?;
    if predicate.file != lambda.span.file
        || predicate.start != lambda.span.start
        || predicate.end != lambda.span.end
        || program.types.node_types.get(&predicate_key) != Some(&lambda.ty)
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

