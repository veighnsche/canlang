//! Checked standard terminal provenance gates bounded native publication.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrEventSource, IrItemKind};
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

const SOURCE: &str = "app Terminal\nuse std {EmailV1 as Mail} from=deployment.mail\nGiven\nWhen\n scenario observed on=Mail.send.completed\n  do let status=event.status\nThen\n";

fn catalog() -> Catalog {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let mut db = SourceDb::new();
    let id = db.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

fn checked(source: &str, catalog: &Catalog) -> (SourceDb, CheckedProgram) {
    let mut db = SourceDb::new();
    let id = db.add("terminal.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[id], Some(catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program)
}

#[test]
fn bound_standard_terminal_retains_original_operation_result_and_authored_route() {
    let catalog = catalog();
    let (db, program) = checked(SOURCE, &catalog);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        ir.items.len(),
        program.symbols.len(),
        "no synthetic provider symbol"
    );
    let handler = ir
        .items
        .iter()
        .find(|item| item.canonical == "Terminal.observed")
        .unwrap();
    assert!(matches!(&handler.kind, IrItemKind::Scenario {
        event_source: Some(IrEventSource::StandardCompleted { source, canonical_operation, result_type, binding, from }), ..
    } if source == "Terminal.Mail.send.completed" && canonical_operation == "std.EmailV1.send"
        && result_type == "EmailAccepted" && binding == "Terminal.Mail" && from == "deployment.mail"));
    let (db, program) = checked(&SOURCE.replace(" from=deployment.mail", ""), &catalog);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("handler triggers")),
        "{diagnostics:?}"
    );
    assert!(
        !ir.items.iter().any(|item| matches!(
            &item.kind,
            IrItemKind::Scenario {
                event_source: Some(IrEventSource::StandardCompleted { .. }),
                ..
            }
        )),
        "unbound import cannot supply a native route"
    );
}

#[test]
fn edited_or_partial_standard_terminal_facts_cannot_promote_a_source() {
    let catalog = catalog();
    let (_, original) = checked(SOURCE, &catalog);
    for change in 0..10 {
        let (db, mut program) = checked(SOURCE, &catalog);
        let handler = program
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == "Terminal.observed")
            .unwrap()
            .id;
        match change {
            0 => program.types.std_delivery_completion_handlers.clear(),
            1 => {
                program
                    .types
                    .std_delivery_completion_handlers
                    .values_mut()
                    .next()
                    .unwrap()
                    .result_type = "IncomingEmail".into()
            }
            2 => {
                program
                    .types
                    .std_delivery_completion_handlers
                    .values_mut()
                    .next()
                    .unwrap()
                    .from = Some("deployment.other".into())
            }
            3 => {
                program
                    .types
                    .std_delivery_completion_handlers
                    .values_mut()
                    .next()
                    .unwrap()
                    .canonical_operation = "std.MailboxV1.reply".into()
            }
            4 => {
                program.effects.scenarios.remove(&handler);
            }
            5 => program.symbols[handler.0 as usize].canonical = "Terminal.copied".into(),
            6 => program.modules[0].imports[0].members[0].alias = "Other".into(),
            7 => program.effects.scenarios.get_mut(&handler).unwrap().on_node = None,
            8 => {
                program
                    .types
                    .std_delivery_completion_handlers
                    .values_mut()
                    .next()
                    .unwrap()
                    .payload = canlang_compiler::analysis::ResolvedType::Scalar(
                    canlang_compiler::analysis::Scalar::Text,
                )
            }
            9 => {
                let data = program.effects.scenarios.get_mut(&handler).unwrap();
                data.node = data.on_node.unwrap();
            }
            _ => unreachable!(),
        }
        let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("checked source census")),
            "change {change}: {diagnostics:?}"
        );
        assert!(
            !ir.items.iter().any(|item| matches!(
                &item.kind,
                IrItemKind::Scenario {
                    event_source: Some(IrEventSource::StandardCompleted { .. }),
                    ..
                }
            )),
            "change {change} cannot construct checked provenance"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "terminal.can".into(),
        SOURCE.replace("deployment.mail", "deployment.other"),
    );
    let (ir, diagnostics) = ir::build(&original, &stale, Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6011"),
        "{diagnostics:?}"
    );
    assert!(ir.items.is_empty());
}
