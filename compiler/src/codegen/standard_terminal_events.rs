//! Source/IR correspondence for the existing bound Work terminal carriers.
//! Candidate decoding alone supplies no handler or financial authority.
use super::ir::{IrEventSource, IrItem, IrItemKind, IrProgram};
use super::scenario_decisions::FreshSourceContext;
use crate::analysis::CheckedProgram;
use std::collections::HashSet;

fn allowed(capability: &str, operation: &str, result: &str) -> bool {
    matches!(
        (capability, operation, result),
        ("std.EmailV1", "send", "EmailAccepted")
            | (
                "std.PaymentsV1",
                "collect" | "refund" | "cancel" | "reconcile",
                "PaymentState"
            )
    )
}

pub(super) fn requested(program: &CheckedProgram) -> bool {
    !program.standard_completion_handlers.is_empty()
        && program.standard_completion_handlers.iter().all(|handler| {
            let source = &handler.completion;
            allowed(&source.capability, &source.op, &source.result_type)
        })
}

pub(super) struct PreparedStandardTerminalEvents<'a> {
    ir: &'a IrProgram,
    handlers: HashSet<usize>,
}
impl PreparedStandardTerminalEvents<'_> {
    pub(super) fn matches(&self, ir: &IrProgram, index: usize, item: &IrItem) -> bool {
        std::ptr::eq(self.ir, ir)
            && self.handlers.contains(&index)
            && ir
                .items
                .get(index)
                .is_some_and(|original| std::ptr::eq(original, item))
            && matches!(&item.kind, IrItemKind::Scenario {trusted:true,read:false,
                event_source:Some(IrEventSource::StandardCompleted {..}),hook:None,result:None,params,by,..}
                if params.is_empty() && by.is_empty())
    }
}

// Compare the ordered executable and owning schema closure. Hash-map-backed
// value constraints retain structural equality separately from Debug order.
fn closure(ir: &IrProgram) -> String {
    format!(
        "{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}\n{:?}",
        ir.modules,
        ir.items,
        ir.read_rules,
        ir.callback_read_rules,
        ir.invariants,
        ir.locks,
        ir.retention,
        ir.crud_when,
        ir.preferences_valid,
        ir.referenced_builtins,
        ir.suites,
        ir.migrations
    )
}

pub(super) fn prepare<'a>(
    context: &'a FreshSourceContext<'_>,
) -> Option<PreparedStandardTerminalEvents<'a>> {
    let ir = context.ir();
    let fresh = context.fresh();
    let original = context.original();
    let catalog = context.catalog()?;
    if !ir
        .standard_completion_sources
        .is_private_terminal_candidate()
        || !fresh
            .standard_completion_sources
            .is_private_terminal_candidate()
        || !requested(original)
    {
        return None;
    }
    context
        .program()
        .validate_cohort(context.db(), Some(catalog))
        .ok()?;
    let facts = &ir.standard_completion_sources.handlers;
    let handlers = facts
        .iter()
        .map(|handler| handler.id.0 as usize)
        .collect::<HashSet<_>>();
    if handlers.is_empty()
        || handlers.len() != facts.len()
        || handlers
            != original
                .standard_completion_handlers
                .iter()
                .map(|handler| handler.id.0 as usize)
                .collect()
        || format!("{facts:?}") != format!("{:?}", fresh.standard_completion_sources.handlers)
        || closure(ir) != closure(fresh)
        || ir.value_constraints != fresh.value_constraints
        || ir.resolved_cases != fresh.resolved_cases
        || ir.catalog_version != fresh.catalog_version
        || ir
            .items
            .iter()
            .filter(|item| {
                matches!(
                    &item.kind,
                    IrItemKind::Scenario {
                        event_source: Some(IrEventSource::StandardCompleted { .. }),
                        ..
                    }
                )
            })
            .count()
            != handlers.len()
    {
        return None;
    }
    let prepared = PreparedStandardTerminalEvents { ir, handlers };
    if prepared.handlers.iter().any(|index| !fresh.items.get(*index).is_some_and(|item| {
        matches!(&item.kind, IrItemKind::Scenario {trusted:true,read:false,
            event_source:Some(IrEventSource::StandardCompleted {canonical_operation,result_type,..}),
            hook:None,result:None,params,by,..} if params.is_empty() && by.is_empty()
                && facts.iter().find(|fact|fact.id.0 as usize==*index).is_some_and(|fact|
                    canonical_operation==&fact.completion.canonical_operation && result_type==&fact.completion.result_type))
    })) { return None; }
    Some(prepared)
}
