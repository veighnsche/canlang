//! Private source correspondence for bound PaymentsV1.changed only.
//! Metadata supplies neither ingress identity nor File/runtime authority.
use super::ir::{IrEventSource, IrItem, IrItemKind, IrProgram};
use crate::analysis::CheckedProgram;
use crate::analysis::catalog::Catalog;
use crate::source::SourceDb;
use std::collections::HashSet;

pub(super) struct PreparedPaymentsChangedEvents<'a> {
    ir: &'a IrProgram,
    _program: &'a CheckedProgram,
    _db: &'a SourceDb,
    _catalog: &'a Catalog,
    handlers: HashSet<usize>,
}

impl PreparedPaymentsChangedEvents<'_> {
    pub(super) fn matches(&self, ir: &IrProgram, index: usize, item: &IrItem) -> bool {
        std::ptr::eq(self.ir, ir)
            && self.handlers.contains(&index)
            && ir
                .items
                .get(index)
                .is_some_and(|original| std::ptr::eq(original, item))
            && matches!(&item.kind, IrItemKind::Scenario {trusted:true,read:false,event_source:Some(IrEventSource::PaymentsChanged {..}),hook:None,cohort:None,params,by,..}
                if params.is_empty() && by.is_empty())
    }
}

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
    context: &'a super::source_context::FreshSourceContext<'_>,
) -> Option<PreparedPaymentsChangedEvents<'a>> {
    let program = context.program();
    let ir = context.ir();
    let db = context.db();
    let catalog = context.catalog()?;
    let original = context.original();
    let fresh = context.fresh();
    // The immutable original census survives edits to public effects/types or
    // handler withdrawal before IR lowering. An absent current event is refusal.
    let indices: HashSet<_> = ir
        .committed_sources
        .payments_changed_event_handlers()
        .iter()
        .map(|handler| handler.id.0 as usize)
        .collect();
    if indices.is_empty()
        || indices.len() != ir.committed_sources.payments_changed_event_handlers().len()
    {
        return None;
    }
    program.validate_cohort(db, Some(catalog)).ok()?;
    if indices != original.payments_changed_handlers().iter()
        .map(|handler| handler.id.0 as usize).collect::<HashSet<_>>()
        || indices != fresh.committed_sources.payments_changed_event_handlers().iter()
            .map(|handler| handler.id.0 as usize).collect::<HashSet<_>>()
        || format!("{:?}",ir.committed_sources.payments_changed_event_handlers())
            != format!("{:?}",fresh.committed_sources.payments_changed_event_handlers())
        || closure(ir) != closure(fresh) || ir.value_constraints != fresh.value_constraints
        || ir.catalog_version != fresh.catalog_version
        || indices.iter().any(|index| !matches!(&fresh.items.get(*index).map(|item|&item.kind),
            Some(IrItemKind::Scenario {trusted:true,read:false,event_source:Some(IrEventSource::PaymentsChanged {..}),hook:None,cohort:None,params,by,..})
                if params.is_empty() && by.is_empty()))
    { return None; }
    Some(PreparedPaymentsChangedEvents {
        ir,
        _program: program,
        _db: db,
        _catalog: catalog,
        handlers: indices,
    })
}
