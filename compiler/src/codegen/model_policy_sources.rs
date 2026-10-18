//! Whole owning policy source correspondence before extended classification.
use super::super::ir::{IrItemKind, IrModelRuleKind, IrOwner, IrProgram};
use crate::analysis::{CheckedProgram, resolve::ModelOwner};

pub(super) fn matches(program: &CheckedProgram, actual: &IrProgram, fresh: &IrProgram) -> bool {
    let fresh_program = fresh;
    if actual.modules.len() != fresh.modules.len()
        || actual.items.len() != fresh.items.len()
        || actual.catalog_version != fresh.catalog_version
    {
        return false;
    }
    for (actual, fresh) in actual.modules.iter().zip(&fresh.modules) {
        // Imports own std type/target identity and emitted package composition;
        // UI payloads are outside this policy source closure.
        if actual.id != fresh.id
            || actual.name != fresh.name
            || actual.kind != fresh.kind
            || actual.file != fresh.file
            || actual.span != fresh.span
            || actual.uses != fresh.uses
            || actual.uses_resolved != fresh.uses_resolved
            || format!("{:?}", actual.imports) != format!("{:?}", fresh.imports)
        {
            return false;
        }
    }
    for (actual, fresh) in actual.items.iter().zip(&fresh.items) {
        if matches!(
            actual.kind,
            IrItemKind::Model { .. } | IrItemKind::Contract { .. } | IrItemKind::Field { .. }
                | IrItemKind::DeriveField { .. } | IrItemKind::DeriveFn { .. }
                | IrItemKind::Scenario { hook: Some(_), .. }
        ) || matches!(
            fresh.kind,
            IrItemKind::Model { .. } | IrItemKind::Contract { .. } | IrItemKind::Field { .. }
                | IrItemKind::DeriveField { .. } | IrItemKind::DeriveFn { .. }
                | IrItemKind::Scenario { hook: Some(_), .. }
        ) {
            // Exact bounded owning declarations include field defaults/server,
            // type/schema, source spans, grants, uniqueness and lock registries.
            // Compare directly; no stored whole-IR clone/hash certificate exists.
            if format!("{actual:?}") != format!("{fresh:?}") {
                return false;
            }
        }
        let IrItemKind::Model {
            fields,
            owner,
            invariants,
            locks,
            ..
        } = &fresh.kind
        else {
            continue;
        };
        let Some(source) = program.effects.models.get(&fresh.id) else {
            return false;
        };
        let checked_owner = match source.owner {
            ModelOwner::Team => IrOwner::Team,
            ModelOwner::App => IrOwner::App,
            ModelOwner::ChildOf(parent) => IrOwner::ChildOf(parent),
        };
        if source.model != fresh.id
            || source.module != fresh.module
            || *owner != checked_owner
            || fields
                .iter()
                .copied()
                .filter(|id| {
                    matches!(fresh_program.items.get(id.0 as usize).map(|item| &item.kind),
                    Some(IrItemKind::Field { owner, .. }) if *owner == fresh.id)
                })
                .ne(source.fields.iter().map(|field| field.field))
            || invariants.len() != source.invariants.len()
            || locks.len() != source.locks.len()
        {
            return false;
        }
        for (index, declared) in source.invariants.iter().enumerate() {
            let matching = fresh_program
                .invariants
                .iter()
                .filter(|rule| {
                    rule.origin.as_ref().is_some_and(|origin| {
                        origin.model == fresh.id && origin.node == declared.node
                    })
                })
                .collect::<Vec<_>>();
            let [rule] = matching.as_slice() else {
                return false;
            };
            let Some(origin) = rule.origin.as_ref() else {
                return false;
            };
            if origin.kind != IrModelRuleKind::Invariant
                || origin.model != declared.target
                || origin.module != declared.module
                || origin.ordinal != declared.id
                || invariants.get(index) != Some(&origin.registry_id)
                || rule.id != origin.registry_id
                || origin.span != rule.span
                || origin.node.file != rule.span.file
                || origin.node.start != rule.span.start
                || origin.node.end != rule.span.end
            {
                return false;
            }
        }
        for (index, declared) in source.locks.iter().enumerate() {
            let matching = fresh_program
                .locks
                .iter()
                .filter(|rule| rule.origin.model == fresh.id && rule.origin.node == declared.node)
                .collect::<Vec<_>>();
            let [rule] = matching.as_slice() else {
                return false;
            };
            let origin = &rule.origin;
            if origin.kind != IrModelRuleKind::Lock
                || origin.model != fresh.id
                || origin.module != declared.module
                || origin.ordinal != declared.id
                || locks.get(index) != Some(&origin.registry_id)
                || rule.id != origin.registry_id
                || rule.fields != declared.fields
                || origin.span != rule.span
            {
                return false;
            }
        }
    }
    // This includes every predicate and source origin, even unsupported rows;
    // no omitted, reordered or mutation-borrowed rule can gain partial coverage.
    format!("{:?}", actual.invariants) == format!("{:?}", fresh.invariants)
        && format!("{:?}", actual.locks) == format!("{:?}", fresh.locks)
        && format!("{:?}", actual.read_rules) == format!("{:?}", fresh.read_rules)
        && format!("{:?}", actual.callback_read_rules) == format!("{:?}", fresh.callback_read_rules)
}

/// The additional original Chat fields retain their actual authored type
/// occurrence. In particular TextMessage.role has no local enum owner: matching
/// cases alone cannot authenticate its owning catalog field reuse. The complete
/// source/fresh rule and declaration join runs before this private census.
pub(super) fn checked_chat_field_annotations(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &crate::source::SourceDb,
) -> std::collections::HashSet<crate::analysis::resolve::SymbolId> {
    let mut fields = std::collections::HashSet::new();
    for symbol in &program.symbols {
        let crate::analysis::resolve::SymbolKind::Field { owner, type_node } = &symbol.kind else {
            continue;
        };
        let Some(model) = ir.items.get(owner.0 as usize) else {
            continue;
        };
        let annotation = match (model.name.as_str(), symbol.name.as_str()) {
            ("Branch", "profile") => "Profile",
            ("Branch", "prefix") => "TextMessage[]",
            ("Branch", "origin") => "Turn?",
            ("Turn", "role") => "TextMessage.role",
            ("Turn", "attachments") => "file[]",
            ("Turn", "run") => "Run",
            ("Run", "allowance") => "Allowance",
            ("Run", "request_value") => "TextRequest",
            ("Run", "request") => "delivery(LLM.generate)?",
            ("Run", "used") => "int?",
            ("Run", "reserved") => "int",
            _ => continue,
        };
        let Some(actual) = ir.items.get(symbol.id.0 as usize) else {
            continue;
        };
        let Some(declared_model) = program.effects.models.get(owner) else {
            continue;
        };
        let Some(declared) = declared_model
            .fields
            .iter()
            .find(|field| field.field == symbol.id)
        else {
            continue;
        };
        let Some(source) = db.get(type_node.file) else {
            continue;
        };
        if symbol.module != model.module
            || actual.id != symbol.id
            || actual.module != symbol.module
            || actual.canonical != symbol.canonical
            || !matches!(&actual.kind, IrItemKind::Field { owner: own, .. } if own == owner)
            || declared_model.model != *owner
            || declared_model.module != model.module
            || declared.type_node != *type_node
            || type_node.file != declared.node.file
            || type_node.start < declared.node.start
            || type_node.end > declared.node.end
            || type_node.start >= type_node.end
            || symbol.span.file != declared.node.file
            || symbol.span.start < declared.node.start
            || symbol.span.end > declared.node.end
            || source
                .text
                .get(symbol.span.start as usize..symbol.span.end as usize)
                .is_none_or(|text| text != symbol.name)
            || source
                .text
                .get(type_node.start as usize..type_node.end as usize)
                .is_none_or(|text| text.trim() != annotation)
        {
            continue;
        }
        fields.insert(symbol.id);
    }
    fields
}
