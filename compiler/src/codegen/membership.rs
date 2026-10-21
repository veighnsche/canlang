//! Checked membership source correspondence; the native loader supplies authority.
use std::collections::{BTreeMap, HashMap};

use crate::analysis::CheckedProgram;
use crate::analysis::NodeKey;
use crate::analysis::catalog::{Catalog, Effects, SigType};
use crate::analysis::types::{SelectedCall, SelectedCallTarget};
use crate::analysis::{ResolvedType, Scalar};
use crate::source::SourceDb;
use crate::source::Span;

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

fn membership_call_shape(
    program: &CheckedProgram,
    catalog: &Catalog,
    node: &NodeKey,
    selected: &SelectedCall,
    id: &str,
    overload: usize,
) -> bool {
    let entry = catalog.lookup(id);
    let signature = catalog.overloads(id).and_then(|overloads| overloads.get(overload));
    let (Some(entry), Some(signature)) = (entry, signature) else {
        return false;
    };
    if overload != 0
        || entry.effects != Some(Effects::StateRead)
        || signature.params.len() != 2
        || selected.arguments.len() != 2
        || selected.slots.len() != 2
        || selected.slots.iter().any(Option::is_none)
        || program.types.node_types.get(node) != Some(&ResolvedType::Scalar(Scalar::Bool))
    {
        return false;
    }
    true
}

fn membership_call_parties<'a>(
    program: &'a CheckedProgram,
    catalog: &'a Catalog,
    selected: &'a SelectedCall,
    id: &str,
    overload: usize,
) -> Option<(&'a NodeKey, &'a NodeKey)> {
    let signature = catalog.overloads(id)?.get(overload)?;
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
    Some((person, team))
}

fn membership_call_record(
    program: &CheckedProgram,
    db: &SourceDb,
    node: &NodeKey,
) -> Option<(Span, serde_json::Value)> {
    let file = db.get(node.file)?;
    let module = program.modules.iter().find(|module| {
        module.file == node.file
            && module.span.start <= node.start
            && module.span.end >= node.end
    })?;
    if node.start >= node.end || node.end as usize > file.text.len() {
        return None;
    }
    Some((
        Span::new(node.file, node.start, node.end),
        serde_json::json!({
            "source": {"path":file.path,"sha256":file.sha256,"module":module.name},
            "node": {"start":node.start,"end":node.end},
        }),
    ))
}

fn collect_membership_calls(
    program: &CheckedProgram,
    catalog: &Catalog,
    db: &SourceDb,
) -> Option<HashMap<Span, serde_json::Value>> {
    let mut calls = HashMap::new();
    for (node, selected) in &program.types.selected_calls {
        let SelectedCallTarget::Builtin { id, overload } = &selected.target else {
            continue;
        };
        if id != "active_member" {
            continue;
        }
        if !membership_call_shape(program, catalog, node, selected, id, *overload) {
            return None;
        }
        let (_person, _team) =
            membership_call_parties(program, catalog, selected, id, *overload)?;
        let (span, record) = membership_call_record(program, db, node)?;
        calls.insert(span, record);
    }
    Some(calls)
}

fn membership_diagnostics_overlap(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    calls: &HashMap<Span, serde_json::Value>,
) -> bool {
    context.has_ir_diagnostics()
        && context.ir_diagnostics().iter().any(|diagnostic| {
            calls.keys().any(|node| {
                node.file == diagnostic.primary.file
                    && node.start < diagnostic.primary.end
                    && diagnostic.primary.start < node.end
            })
        })
}

fn collect_membership_sites(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    ir: &IrProgram,
    program: &CheckedProgram,
) -> Option<BTreeMap<String, serde_json::Value>> {
    let mut sites = BTreeMap::new();
    for item in &ir.items {
        if item.canonical == "maintain.remind" {
            if let Some(source) = super::event_decisions::collect_maintain_membership_sites(context, item) {
                sites.insert(item.canonical.clone(), serde_json::Value::Array(source));
            }
            continue;
        }
        if item.canonical == "member_terms.term" {
            if let Some(source) = super::term_decisions::collect_term_membership_sites(context,item) {
                sites.insert(item.canonical.clone(),serde_json::Value::Array(source));
            }
            continue;
        }
        if item.canonical == "leave.request" {
            if let Some(source) = super::leave_decisions::collect_leave_membership_sites(context,item) {
                sites.insert(item.canonical.clone(),serde_json::Value::Array(source));
            }
            continue;
        }
        let require_fields = program.scenario_disclosures().get(&item.id).is_some_and(|disclosure| {
            matches!(disclosure, crate::analysis::scenario_disclosure::ScenarioDisclosure::Complete(checked)
                if !checked.require_consumptions.is_empty())
        });
        if let Some(source) = super::scenario_decisions::serialize_decision_sources_with_context(context, item) && (require_fields || source.iter().any(|site| site.calls.iter().any(|call| {
                matches!(&call.target, super::scenario_decisions::SerialDecisionTarget::Builtin { id, .. }
                    if id == "active_member")
            }))) {
                sites.insert(item.canonical.clone(), serde_json::to_value(source).ok()?);
        }
    }
    for rule in ir.read_rules.iter().chain(&ir.callback_read_rules) {
        if let Some(source) = context.serialize_rule(rule)
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
    Some(sites)
}

fn collect_membership_predicates(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
    db: &SourceDb,
) -> Option<(
    HashMap<Span, serde_json::Value>,
    BTreeMap<String, serde_json::Value>,
)> {
    let mut pages = BTreeMap::<String, Vec<_>>::new();
    let mut predicates = HashMap::new();
    for site in context.serialize_predicates()? {
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
    // Require the complete fresh checked and IR seal before accepting Boolean
    // observers, including unrelated edits to the surrounding execution closure.
    let _sealed = super::read_predicates::prepare_with_context(context)?;
    for (span, identity, source) in super::scenario_decisions::serialize_read_booleans(context)? {
        let mut predicate = identity.clone();
        let object = predicate.as_object_mut()?;
        object.remove("model");
        object.remove("kind");
        object.remove("field");
        if predicates.insert(span, predicate).is_some() {
            return None;
        }
        pages
            .entry(source.first()?.owner.clone())
            .or_default()
            .extend(source);
    }
    let mut sites = BTreeMap::new();
    for (owner, source) in pages {
        if source.iter().any(|site| site.calls.iter().any(|call| {
            matches!(&call.target, super::scenario_decisions::SerialDecisionTarget::Builtin { id, .. }
                if id == "active_member")
        })) && sites.insert(owner, serde_json::to_value(source).ok()?).is_some() {
            return None;
        }
    }
    Some((predicates, sites))
}

pub(super) fn prepare_with_context(
    context: &super::scenario_decisions::FreshSourceContext<'_>,
) -> Option<MembershipSources> {
    let program = context.program();
    let ir = context.ir();
    let db = context.db();
    let catalog = context.catalog();
    program.validate_cohort(db, catalog).ok()?;
    let catalog = catalog?;
    let calls = collect_membership_calls(program, catalog, db)?;
    let has_require_fields = program.scenario_disclosures().values().any(|disclosure| {
        matches!(disclosure, crate::analysis::scenario_disclosure::ScenarioDisclosure::Complete(checked)
            if !checked.require_consumptions.is_empty())
    });
    if calls.is_empty() && !has_require_fields {
        return None;
    }
    // Same original execution closure, now borrowed from this invocation.
    // Only a refusal that touches a checked membership occurrence vetoes the
    // bridge: unrelated IR refusals elsewhere must not orphan exactly-bound
    // observations, while an affected source stays refused with its exact
    // codes. The State receipt/dispatch producers keep their own
    // exact-occurrence rules on top of this correspondence.
    let fresh = context.fresh();
    if closure(fresh) != closure(ir) {
        return None;
    }
    if membership_diagnostics_overlap(context, &calls) {
        return None;
    }
    let mut sites = collect_membership_sites(context, ir, program)?;
    let (predicates, extra) = collect_membership_predicates(context, db)?;
    for (owner, source) in extra {
        if sites.insert(owner, source).is_some() {
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
