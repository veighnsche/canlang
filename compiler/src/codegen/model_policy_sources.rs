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
            IrItemKind::Model { .. } | IrItemKind::Field { .. }
        ) || matches!(
            fresh.kind,
            IrItemKind::Model { .. } | IrItemKind::Field { .. }
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
