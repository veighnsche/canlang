//! Checked membership source correspondence; the native loader supplies authority.
use std::collections::{BTreeMap, HashMap};

use crate::analysis::catalog::{Catalog, Effects, SigType};
use crate::analysis::types::SelectedCallTarget;
use crate::analysis::{CheckedProgram, ResolvedType, Scalar};
use crate::source::{SourceDb, Span};

use super::ir::IrProgram;

/// Private prepared input. Raw IR cannot invent membership source identities.
pub(super) struct MembershipSources {
    calls: HashMap<Span, serde_json::Value>,
    predicates: HashMap<Span, serde_json::Value>,
    pub sites: BTreeMap<String, serde_json::Value>,
    closure: String,
}

fn closure(ir: &IrProgram) -> String {
    format!(
        "{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}",
        ir.modules,
        ir.items,
        ir.read_rules,
        ir.callback_read_rules,
        ir.invariants,
        ir.locks,
        ir.retention,
        ir.crud_when,
        ir.preferences_valid,
    )
}

impl MembershipSources {
    pub fn calls(&self, ir: &IrProgram) -> Option<&HashMap<Span, serde_json::Value>> {
        (self.closure == closure(ir)).then_some(&self.calls)
    }

    pub fn predicates(&self, ir: &IrProgram) -> Option<&HashMap<Span, serde_json::Value>> {
        (self.closure == closure(ir)).then_some(&self.predicates)
    }
}

/// Reuse the original checked call slots and complete decision inventories.
/// A source recipe names a call; it never supplies a membership answer or scope.
pub(super) fn prepare(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
) -> Option<MembershipSources> {
    program.validate_cohort(db, catalog).ok()?;
    let catalog = catalog?;
    let mut calls = HashMap::new();
    for (node, selected) in &program.types.selected_calls {
        let SelectedCallTarget::Builtin { id, overload } = &selected.target else {
            continue;
        };
        if id != "active_member" {
            continue;
        }
        let entry = catalog.lookup(id)?;
        let signature = catalog.overloads(id)?.get(*overload)?;
        if *overload != 0
            || entry.effects != Some(Effects::StateRead)
            || signature.params.len() != 2
            || selected.arguments.len() != 2
            || selected.slots.len() != 2
            || selected.slots.iter().any(Option::is_none)
            || program.types.node_types.get(node) != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return None;
        }
        if signature.params[0].name != "person"
            || signature.params[1].name != "team"
            || signature.params[0].ty != SigType::Named("user".into())
            || signature.params[1].ty != SigType::Named("Team".into())
            || signature.result != SigType::Named("bool".into())
        {
            return None;
        }
        let person = selected.arguments.get(selected.slots[0]?)?;
        let team = selected.arguments.get(selected.slots[1]?)?;
        if person == team
            || program.types.node_types.get(person) != Some(&ResolvedType::Scalar(Scalar::User))
            || program.types.node_types.get(team) != Some(&ResolvedType::Team)
        {
            return None;
        }
        let file = db.get(node.file)?;
        let module = program.modules.iter().find(|module| {
            module.file == node.file
                && module.span.start <= node.start
                && module.span.end >= node.end
        })?;
        if node.start >= node.end || node.end as usize > file.text.len() {
            return None;
        }
        calls.insert(
            Span::new(node.file, node.start, node.end),
            serde_json::json!({
                "source": {"path":file.path,"sha256":file.sha256,"module":module.name},
                "node": {"start":node.start,"end":node.end},
            }),
        );
    }
    if calls.is_empty() {
        return None;
    }
    // One fresh owning graph check, reused by all source/call consumers.
    let (fresh, diagnostics) = super::ir::build(program, db, Some(catalog));
    if !diagnostics.is_empty() || closure(&fresh) != closure(ir) {
        return None;
    }
    let read_sources =
        super::scenario_decisions::ReadDecisionSources::prepare(program, ir, db, Some(catalog))?;
    let mut sites = BTreeMap::new();
    for item in &ir.items {
        if let Some(source) = super::scenario_decisions::serialize_decision_sources(
            program,
            ir,
            item,
            db,
            Some(catalog),
        ) && source.iter().any(|site| site.calls.iter().any(|call| {
                matches!(&call.target, super::scenario_decisions::SerialDecisionTarget::Builtin { id, .. }
                    if id == "active_member")
            })) {
                sites.insert(item.canonical.clone(), serde_json::to_value(source).ok()?);
        }
    }
    for rule in ir.read_rules.iter().chain(&ir.callback_read_rules) {
        if let Some(source) = read_sources.serialize_rule(rule)
            && source.iter().any(|site| site.calls.iter().any(|call| {
                matches!(&call.target, super::scenario_decisions::SerialDecisionTarget::Builtin { id, .. }
                    if id == "active_member")
            })) {
                let owner = source.first()?.owner.clone();
                if sites.insert(owner, serde_json::to_value(source).ok()?).is_some() {
                    return None;
                }
        }
    }
    let mut pages = BTreeMap::<String, Vec<_>>::new();
    let mut predicates = HashMap::new();
    for site in read_sources.serialize_predicates()? {
        let file = db.iter().find(|(_, file)| file.path == site.source.path)?.0;
        let identity = serde_json::json!({
            "source":site.source,"owner":site.owner,"node":site.node,"statement":site.statement,
        });
        if predicates
            .insert(Span::new(file, site.node.start, site.node.end), identity)
            .is_some()
        {
            return None;
        }
        pages.entry(site.owner.clone()).or_default().push(site);
    }
    for (owner, source) in pages {
        if source.iter().any(|site| site.calls.iter().any(|call| {
            matches!(&call.target, super::scenario_decisions::SerialDecisionTarget::Builtin { id, .. }
                if id == "active_member")
        })) && sites.insert(owner, serde_json::to_value(source).ok()?).is_some() {
            return None;
        }
    }
    Some(MembershipSources {
        calls,
        predicates,
        sites,
        closure: closure(ir),
    })
}
