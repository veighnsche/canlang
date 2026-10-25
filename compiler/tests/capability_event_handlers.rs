//! Provider capability-event handlers (`on=Cap.event`) lower through the
//! canonical invocation path (CAN18-v1 outcome 9, family A).
//!
//! A `capability` inline `event` declaration carries the same checked field
//! payload as a declared event; the handler keeps the `on:"owner.Cap.event"`
//! routing identity with a typed `invocation` descriptor instead of refusing
//! with `handler triggers have no §13 member lowering`.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrEventSource, IrItemKind};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const SOURCE: &str = r#"app Probe
Given
 contract Intake { id:text, body:text }
 capability BoxV1 version=1
  fetch(source:text) -> Intake
  event arrived { value:Intake }
  event changed { source:text, version:int }
When
 scenario arrived_mail on=BoxV1.arrived
  do let seen=event.value.id
 scenario changed_mail on=BoxV1.changed
  do let version=event.version
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn checked(source: &str) -> (SourceDb, CheckedProgram, Catalog) {
    let mut db = SourceDb::new();
    let id = db.add("capability-event-handlers.can".into(), source.into());
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, catalog)
}

fn handler_source(ir: &ir::IrProgram, canonical: &str) -> Option<IrEventSource> {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .and_then(|item| match &item.kind {
            IrItemKind::Scenario { event_source, .. } => event_source.clone(),
            _ => None,
        })
}

#[test]
fn capability_event_handlers_lower_with_typed_event_and_invocation() {
    let (db, program, catalog) = checked(SOURCE);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        handler_source(&ir, "Probe.arrived_mail"),
        Some(IrEventSource::Declared("Probe.BoxV1.arrived".into()))
    );
    assert_eq!(
        handler_source(&ir, "Probe.changed_mail"),
        Some(IrEventSource::Declared("Probe.BoxV1.changed".into()))
    );
    let js_out = js::emit_program(&ir);
    assert!(js_out.diagnostics.is_empty(), "{:?}", js_out.diagnostics);
    assert!(
        js_out.entry.js.contains("event:\"Probe.BoxV1.arrived\""),
        "arrived routing identity: {}",
        js_out.entry.js
    );
    assert!(
        js_out.entry.js.contains("event:\"Probe.BoxV1.changed\""),
        "changed routing identity: {}",
        js_out.entry.js
    );
    assert!(
        js_out.entry.js.contains("invocation:"),
        "canonical invocation descriptors: {}",
        js_out.entry.js
    );
    // The invocation carries the checked payload shape: the contract-typed
    // `value` stays nominal, scalars keep their value types.
    for fragment in [
        "\"name\":\"value\",\"field\":{\"kind\":\"nominal\",\"name\":\"Probe.Intake\"},\"valueType\":\"Probe.Intake\",\"required\":true",
        "\"name\":\"source\",\"field\":{\"kind\":\"string\"},\"valueType\":\"text\",\"required\":true",
        "\"name\":\"version\",\"field\":{\"kind\":\"integer\"}",
    ] {
        assert!(
            js_out.entry.js.contains(fragment),
            "typed invocation input {fragment}: {}",
            js_out.entry.js
        );
    }
}

#[test]
fn unknown_capability_event_and_foreign_payload_leaves_still_refuse() {
    let (_db, _program, catalog) = checked(SOURCE);
    // Unknown capability event: check-time refusal, never a silent trigger.
    let bad = SOURCE.replace("on=BoxV1.arrived", "on=BoxV1.missing");
    let mut db = SourceDb::new();
    let id = db.add("capability-event-unknown.can".into(), bad);
    let (_, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3010"
                && diagnostic
                    .message
                    .contains("unknown event source 'BoxV1.missing'")),
        "unknown event refuses: {diagnostics:?}"
    );
    // Foreign payload leaf: the checked contract boundary still refuses.
    let bad_leaf = SOURCE.replace("let seen=event.value.id", "let seen=event.value.nope");
    let mut db = SourceDb::new();
    let id = db.add("capability-event-leaf.can".into(), bad_leaf);
    let (_, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E2013"),
        "foreign leaf refuses: {diagnostics:?}"
    );
}
