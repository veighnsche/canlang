//! Recurring-tick handlers (`on=every(duration)`) lower through the
//! canonical invocation path (CAN18-v1 outcome 9, family C).
//!
//! An `every` handler keeps an `on:{every:<ms>n}` routing identity (UTC-
//! epoch aligned period in milliseconds, DESIGN §6) with a typed
//! `invocation` descriptor instead of refusing with `handler triggers
//! have no §13 member lowering`.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrEventSource, IrItemKind};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const SOURCE: &str = r#"app Probe
Given
 capability StockV1 version=1
  post(source:text) -> int
When
 scenario sweep_five on=every(5m)
  do send StockV1.post {source="tick"} as delivery
 scenario sweep_one on=every(1m)
  do send StockV1.post {source="tock"} as delivery
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
    let id = db.add("recurring-tick-handlers.can".into(), source.into());
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
fn every_handlers_lower_with_bigint_period_and_invocation() {
    let (db, program, catalog) = checked(SOURCE);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        handler_source(&ir, "Probe.sweep_five"),
        Some(IrEventSource::Every {
            interval_ms: 300_000
        })
    );
    assert_eq!(
        handler_source(&ir, "Probe.sweep_one"),
        Some(IrEventSource::Every {
            interval_ms: 60_000
        })
    );
    let js_out = js::emit_program(&ir);
    assert!(js_out.diagnostics.is_empty(), "{:?}", js_out.diagnostics);
    for fragment in ["on:{every:300000n}", "on:{every:60000n}", "invocation:"] {
        assert!(
            js_out.entry.js.contains(fragment),
            "tick routing {fragment}: {}",
            js_out.entry.js
        );
    }
}

#[test]
fn every_without_a_duration_literal_still_refuses() {
    let (_db, _program, catalog) = checked(SOURCE);
    // A non-duration argument is a check-time refusal, never a silent tick.
    let bad = SOURCE.replace("on=every(5m)", "on=every(5)");
    let mut db = SourceDb::new();
    let id = db.add("recurring-tick-literal.can".into(), bad);
    let (_, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(
        diagnostics.iter().any(
            |diagnostic| diagnostic.message.contains("every(duration literal)")
                || (diagnostic.code == "E3010" && diagnostic.message.contains("duration"))
        ),
        "non-duration every refuses: {diagnostics:?}"
    );
}
