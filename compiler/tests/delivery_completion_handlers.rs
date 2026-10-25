//! Provider adapter completions (`on=Cap.op.completed`) lower through the
//! canonical invocation path (CAN18-v1 outcome 9, family B).
//!
//! A capability op returning a nullable contract (`reconcile(source:text)
//! -> Settlement?`, the BillingV1/MembershipV1 shape) carries the DESIGN
//! §8 envelope with the op's declared result; the handler keeps the
//! `on:"owner.Cap.op"` routing identity with a typed `invocation`
//! descriptor instead of refusing with `handler triggers have no §13
//! member lowering`.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrEventSource, IrItemKind};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const SOURCE: &str = r#"app Probe
Given
 contract Settlement { reference:text, amount:int }
 capability BillV1 version=1
  reconcile(source:text) -> Settlement?
  charge(value:text) -> Settlement
When
 scenario got_settled on=BillV1.reconcile.completed
  do let id=event.delivery_id
 scenario got_charged on=BillV1.charge.completed
  do let status=event.status
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
    let id = db.add("delivery-completion-handlers.can".into(), source.into());
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
fn nullable_and_plain_contract_results_lower_with_typed_invocation() {
    let (db, program, catalog) = checked(SOURCE);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        handler_source(&ir, "Probe.got_settled"),
        Some(IrEventSource::DeliveryCompleted {
            source: "Probe.BillV1.reconcile".into(),
            result_type: "Probe.Settlement".into(),
        })
    );
    assert_eq!(
        handler_source(&ir, "Probe.got_charged"),
        Some(IrEventSource::DeliveryCompleted {
            source: "Probe.BillV1.charge".into(),
            result_type: "Probe.Settlement".into(),
        })
    );
    let js_out = js::emit_program(&ir);
    assert!(js_out.diagnostics.is_empty(), "{:?}", js_out.diagnostics);
    for fragment in [
        "event:\"Probe.BillV1.reconcile\"",
        "event:\"Probe.BillV1.charge\"",
        "invocation:",
        "\"name\":\"result\"",
        "Probe.Settlement",
    ] {
        assert!(
            js_out.entry.js.contains(fragment),
            "typed completion invocation {fragment}: {}",
            js_out.entry.js
        );
    }
}

#[test]
fn unknown_completion_op_and_bare_operation_still_refuse() {
    let (_db, _program, catalog) = checked(SOURCE);
    // Unknown capability op: check-time refusal, never a silent trigger.
    let bad = SOURCE.replace(
        "on=BillV1.reconcile.completed",
        "on=BillV1.missing.completed",
    );
    let mut db = SourceDb::new();
    let id = db.add("delivery-completion-unknown.can".into(), bad);
    let (_, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3010"
                && diagnostic.message.contains("unknown event source")),
        "unknown completion op refuses: {diagnostics:?}"
    );
    // A bare operation name is not a completion source: the checker points
    // at the `.completed` form instead of admitting a trigger.
    let bare = SOURCE.replace("on=BillV1.reconcile.completed", "on=BillV1.reconcile");
    let mut db = SourceDb::new();
    let id = db.add("delivery-completion-bare.can".into(), bare);
    let (_, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3010"
                && diagnostic.message.contains(".completed")),
        "bare operation refuses: {diagnostics:?}"
    );
}
