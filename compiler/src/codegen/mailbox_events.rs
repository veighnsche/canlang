//! Private source correspondence for bound MailboxV1.received only.
//! Metadata supplies neither ingress identity nor File/runtime authority.
use super::ir::{self, IrEventSource, IrItem, IrItemKind, IrProgram};
use crate::analysis::catalog::Catalog;
use crate::analysis::{CheckedProgram, check_program};
use crate::diagnostic::Severity;
use crate::source::SourceDb;
use std::collections::HashSet;

pub(super) struct PreparedMailboxEvents<'a> {
    ir: &'a IrProgram,
    _program: &'a CheckedProgram,
    _db: &'a SourceDb,
    _catalog: &'a Catalog,
    handlers: HashSet<usize>,
}

impl PreparedMailboxEvents<'_> {
    pub(super) fn matches(&self, ir: &IrProgram, index: usize, item: &IrItem) -> bool {
        std::ptr::eq(self.ir, ir)
            && self.handlers.contains(&index)
            && ir
                .items
                .get(index)
                .is_some_and(|original| std::ptr::eq(original, item))
            && matches!(&item.kind, IrItemKind::Scenario {trusted:true,read:false,event_source:Some(IrEventSource::MailboxReceived {..}),hook:None,cohort:None,params,by,..}
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
    program: &'a CheckedProgram,
    ir: &'a IrProgram,
    db: &'a SourceDb,
    catalog: Option<&'a Catalog>,
) -> Option<PreparedMailboxEvents<'a>> {
    // The immutable original census survives edits to public effects/types or
    // handler withdrawal before IR lowering. An absent current event is refusal.
    let indices: HashSet<_> = ir
        .committed_sources
        .mailbox_event_handlers()
        .iter()
        .map(|handler| handler.id.0 as usize)
        .collect();
    if indices.is_empty() || indices.len() != ir.committed_sources.mailbox_event_handlers().len() {
        return None;
    }
    let catalog = catalog?;
    program.validate_cohort(db, Some(catalog)).ok()?;
    let (original, diagnostics) = check_program(db, program.checked_files(), Some(catalog));
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
    {
        return None;
    }
    let (fresh, diagnostics) = ir::build(&original, db, Some(catalog));
    if diagnostics.iter().any(|diagnostic| diagnostic.severity==Severity::Error)
        || indices != fresh.committed_sources.mailbox_event_handlers().iter()
            .map(|handler| handler.id.0 as usize).collect::<HashSet<_>>()
        || format!("{:?}",ir.committed_sources.mailbox_event_handlers())
            != format!("{:?}",fresh.committed_sources.mailbox_event_handlers())
        || closure(ir) != closure(&fresh) || ir.value_constraints != fresh.value_constraints
        || ir.catalog_version != fresh.catalog_version
        || indices.iter().any(|index| !matches!(&fresh.items.get(*index).map(|item|&item.kind),
            Some(IrItemKind::Scenario {trusted:true,read:false,event_source:Some(IrEventSource::MailboxReceived {..}),hook:None,cohort:None,params,by,..})
                if params.is_empty() && by.is_empty()))
    { return None; }
    Some(PreparedMailboxEvents {
        ir,
        _program: program,
        _db: db,
        _catalog: catalog,
        handlers: indices,
    })
}

#[cfg(test)]
mod tests {
    use super::super::js::{self, EmitDecisionSources, JsOutput};
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};
    use crate::analysis::{ResolvedType, SymbolId};
    use crate::source::Span;
    use std::collections::BTreeMap;

    const SOURCE: &str = r#"app MailboxSource
use std {MailboxV1 as Post} from=deployment.inbox
use std {IncomingEmail}
Given
When
 scenario received on=Post.received
  do let incoming=event.value
Then
"#;

    fn fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
        let mut db = SourceDb::new();
        let file = db.add("mailbox-source.can".into(), SOURCE.into());
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert_eq!(program.mailbox_handlers().len(), 1);
        let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        (db, program, ir, catalog)
    }

    fn emit<'a>(
        ir: &'a IrProgram,
        db: &'a SourceDb,
        prepared: Option<&'a PreparedMailboxEvents<'a>>,
    ) -> JsOutput {
        js::emit_program_with_query_sources(
            ir,
            false,
            db,
            &BTreeMap::new(),
            &BTreeMap::new(),
            EmitDecisionSources {
                mailbox_events: prepared,
                ..Default::default()
            },
        )
    }

    fn assert_refused(output: &JsOutput, label: &str) {
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("MailboxV1.received source")),
            "{label}: {:?}",
            output.diagnostics
        );
    }

    #[test]
    fn checked_bound_mailbox_emits_owning_private_input_and_full_payload() {
        let (db, program, ir, catalog) = fixture();
        let prepared = prepare(&program, &ir, &db, Some(&catalog)).expect("genuine clean source");
        let original = &program.mailbox_handlers()[0];
        let handler = &ir.items[original.id.0 as usize];
        assert!(prepared.matches(&ir, original.id.0 as usize, handler));
        assert!(matches!(&handler.kind, IrItemKind::Scenario {
            trusted:true, read:false, event_source:Some(IrEventSource::MailboxReceived {source,binding,from}),
            hook:None, cohort:None, params, by, ..
        } if params.is_empty() && by.is_empty() && source=="MailboxSource.Post.received"
            && binding=="MailboxSource.Post" && from=="deployment.inbox"));
        let emitted = emit(&ir, &db, Some(&prepared));
        assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
        let email = emitted
            .value_types
            .as_ref()
            .unwrap()
            .contracts
            .iter()
            .find(|contract| contract.name == "IncomingEmail")
            .unwrap();
        assert_eq!(
            email
                .fields
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            [
                "mailbox",
                "source",
                "thread",
                "sender",
                "reply_to",
                "subject",
                "body",
                "body_complete",
                "attachments",
                "attachment_count",
                "attachments_complete",
                "received"
            ]
        );
        assert_eq!(
            email
                .fields
                .iter()
                .find(|field| field.name == "attachments")
                .unwrap()
                .declared,
            "file[]"
        );
        assert_eq!(
            email
                .fields
                .iter()
                .find(|field| field.name == "received")
                .unwrap()
                .declared,
            "datetime"
        );
        let text = &emitted.entry.js;
        assert!(
            text.contains("event:\"MailboxSource.Post.received\""),
            "{text}"
        );
        assert!(
            text.contains("\"field\":{\"kind\":\"nominal\",\"name\":\"IncomingEmail\"}"),
            "{text}"
        );
        assert!(
            text.contains("\"valueType\":\"IncomingEmail\",\"required\":true"),
            "{text}"
        );
        assert!(
            text.contains(
                "\"MailboxSource.Post.received\":{inputs:{value:{type:\"IncomingEmail\"}}}"
            ),
            "{text}"
        );
        assert_refused(&js::emit_program(&ir), "raw");
        assert_refused(
            &js::emit_program_with_native_source_receipts(&ir, false, &db),
            "raw with source bytes",
        );
    }

    #[test]
    fn original_mailbox_claim_survives_public_program_withdrawal_before_build() {
        for mutation in 0..12 {
            let (db, mut program, _, catalog) = fixture();
            let original = program.mailbox_handlers()[0].clone();
            match mutation {
                0 => program.effects.scenarios.get_mut(&original.id).unwrap().on = None,
                1 => {
                    program.effects.scenarios.remove(&original.id);
                }
                2 => {
                    program
                        .types
                        .std_capability_event_handlers
                        .remove(&original.on);
                }
                3 => {
                    let payload = &mut program
                        .types
                        .std_capability_event_handlers
                        .get_mut(&original.on)
                        .unwrap()
                        .payload;
                    let ResolvedType::Object(fields) = payload else {
                        panic!("original payload")
                    };
                    let ResolvedType::StdNominal { fields: email, .. } = &mut fields[0].1 else {
                        panic!("original IncomingEmail")
                    };
                    email.pop();
                }
                4 => {
                    program
                        .types
                        .std_capability_event_handlers
                        .get_mut(&original.on)
                        .unwrap()
                        .source = "Foreign.Post.received".into()
                }
                5 => program.modules[original.module.0 as usize].id = crate::analysis::ModuleId(99),
                6 => program.symbols[original.id.0 as usize].id = SymbolId(99),
                7 => {
                    program.symbols.remove(original.id.0 as usize);
                }
                8 => program.modules[original.module.0 as usize].imports[0].from = None,
                9 => program.symbols[original.id.0 as usize].canonical = "Foreign.received".into(),
                10 => {
                    program
                        .types
                        .std_capability_event_handlers
                        .get_mut(&original.on)
                        .unwrap()
                        .payload = ResolvedType::Object(Vec::new())
                }
                11 => {
                    let Some(crate::analysis::effects::HandlerSource::StdCapabilityEvent {
                        source,
                        ..
                    }) = &mut program.effects.scenarios.get_mut(&original.id).unwrap().on
                    else {
                        panic!("original source")
                    };
                    *source = "Foreign.Post.received".into();
                }
                _ => unreachable!(),
            }
            assert_eq!(
                program.mailbox_handlers()[0].id,
                original.id,
                "mutation {mutation}"
            );
            let (changed, _) = ir::build(&program, &db, Some(&catalog));
            assert!(
                changed
                    .committed_sources
                    .requires_mailbox_event(original.id.0 as usize),
                "mutation {mutation}"
            );
            assert!(
                prepare(&program, &changed, &db, Some(&catalog)).is_none(),
                "mutation {mutation}"
            );
            assert_refused(
                &emit(&changed, &db, None),
                &format!("before build {mutation}"),
            );
        }
    }

    #[test]
    fn original_mailbox_claim_refuses_stale_preparation_and_changed_body() {
        let (db, program, ir, catalog) = fixture();
        let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
        let original = &program.mailbox_handlers()[0];
        for mutation in 0..4 {
            let mut changed = ir.clone();
            if mutation == 3 {
                changed.items.clear();
            } else {
                let handler = &mut changed.items[original.id.0 as usize];
                let IrItemKind::Scenario {
                    event_source,
                    effects,
                    ..
                } = &mut handler.kind
                else {
                    panic!("original handler")
                };
                match mutation {
                    0 => *event_source = None,
                    1 => effects.clear(),
                    2 => handler.id = SymbolId(99),
                    _ => unreachable!(),
                }
            }
            assert!(
                prepare(&program, &changed, &db, Some(&catalog)).is_none(),
                "mutation {mutation}"
            );
            assert_refused(
                &emit(&changed, &db, Some(&prepared)),
                &format!("stale {mutation}"),
            );
        }
        let mut other = SourceDb::new();
        let file = other.add("other-mailbox-source.can".into(), SOURCE.into());
        assert_eq!(file, program.checked_files()[0]);
        assert!(prepare(&program, &ir, &other, Some(&catalog)).is_none());
    }
}
