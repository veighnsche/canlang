//! Composed model rules must retain their owning predicates in shared registries.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::source::{SourceDb, Span};

#[test]
fn duplicate_local_model_names_keep_distinct_read_and_callback_owners() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let fixture = include_str!("fixtures/callback-diagnostics.can");
    let body = fixture.split("Then").next().unwrap();
    let package = format!("{body}Then\n");
    let package = package
        .lines()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                format!("{line}\n")
            } else {
                format!(" {line}\n")
            }
        })
        .collect::<String>();
    let chat = package.replace("app CallbackDiagnostics", "package chat");
    let creative = package
        .replace("app CallbackDiagnostics", "package creative")
        .replace("row.label!=\"\"", "row.label==\"creative\"")
        .replace("row.label==\"visible\"", "row.label==\"creative-visible\"");
    let mut db = SourceDb::new();
    let a = db.add("chat.can".into(), chat);
    let b = db.add("creative.can".into(), creative);
    let app = db.add(
        "app.can".into(),
        "app Composed uses=[chat,creative]\n".into(),
    );
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(a, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[a, b, app], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for module in ["chat", "creative"] {
        for ordinal in [1, 2, 3, 4, 6] {
            let key = format!("{module}.Job.read.{ordinal}");
            assert_eq!(
                ir.read_rules.iter().filter(|rule| rule.id == key).count(),
                1
            );
        }
        for ordinal in [5, 6] {
            let key = format!("{module}.Job.callbackRead.{ordinal}");
            assert_eq!(
                ir.callback_read_rules
                    .iter()
                    .filter(|rule| rule.id == key)
                    .count(),
                1
            );
        }
    }
    let emitted = js::emit_program(&ir);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    let entry = &emitted.entry.js;
    assert!(entry.contains("rule:\"chat.Job.read.1\""), "{entry}");
    assert!(entry.contains("rule:\"creative.Job.read.1\""), "{entry}");
    assert!(
        entry.contains("rule:\"chat.Job.callbackRead.5\""),
        "{entry}"
    );
    assert!(
        entry.contains("rule:\"creative.Job.callbackRead.5\""),
        "{entry}"
    );
    let chat_predicate = ir
        .callback_read_rules
        .iter()
        .find(|rule| rule.id == "chat.Job.callbackRead.5")
        .unwrap();
    let creative_predicate = ir
        .callback_read_rules
        .iter()
        .find(|rule| rule.id == "creative.Job.callbackRead.5")
        .unwrap();
    assert_ne!(
        format!("{:?}", chat_predicate.pred.expr),
        format!("{:?}", creative_predicate.pred.expr)
    );
    assert!(!entry.contains("\"Job.read."), "{entry}");
    assert!(!entry.contains("\"Job.callbackRead."), "{entry}");
}
