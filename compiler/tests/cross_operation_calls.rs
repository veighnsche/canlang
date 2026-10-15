//! Cross-operation CALL join: caller, typed inputs, admission, source order
//! and one owner transaction. Mirrors `scenario_call_references.rs`.
//!
//! Covered now: void scalar calls, model-result passthrough (the
//! `desk.handoff` consumption shape), scalar member operands, and the
//! refusal surface (recursion, order/omission/duplication skew, void
//! bindings). No native rows or File authority are issued.
//!
//! Pending contract (the original 7 need disclosure gates owned outside
//! this lane; each reason below is the observed
//! `ScenarioDisclosure::Declined` reason on a faithful minimal shape):
//! - `propose.offer_alternative` → `propose.revise`: bound-result `set`
//!   ("bound child result consumption needs its owning provenance"),
//!   member-domain `for` ("loop needs direct admitted array input"),
//!   `proposal=revision.parent` into a non-nullable slot ("model child
//!   input lacks original provenance"), `text` into `text?` and the
//!   `QuoteInterval[]` slot ("child input needs explicit checked
//!   declaration").
//! - `rent_fulfillment.request` → `rent_reservations.prepare`: void child
//!   with branch-nested creates ("create then set/current-field return
//!   profile required").
//! - `rent_fulfillment.check_in` → `rent_reservations.arrive` and
//!   `check_out` → `depart`: void children with top-level creates plus
//!   `schedule`/`emit` (return-profile gate and "mutation or external
//!   effect closure").
//! - `rent_fulfillment.cancel` → `rent_reservations.cancel_booking`:
//!   `cancel`, member-domain `for`, nested creates (same gates).
//! - `desk.handoff` → `maintain.report`: only the singular `file?` slot
//!   remains ("child input needs explicit checked declaration"); the
//!   call/bind/set/return shape below already joins.
//! - `field.complete` → `maintain.inspect`: branch-nested call with a
//!   record input ("model call input needs original root occurrence"),
//!   child `cancel`, nested creates, array/enum slots (same gates), plus
//!   the parent `emit`.
use canlang_compiler::analysis::catalog::{load_catalog, CatalogRequest};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{check_program, ResolvedType};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_calls::collect_static_scenario_calls;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const GIVEN: &str = r#"app CanT uses=[t]
package t
 Given
  Conversation {title:text}
  Branch in Conversation {title:text}
  Leaf in Branch {note:text}
  policy Conversation read=members
  policy Branch read=members
  policy Leaf read=members
 When
"#;

const THEN: &str = " Then\n";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn lowered(name: &str, scenarios: &str) -> (SourceDb, IrProgram) {
    let mut db = SourceDb::new();
    let file = db.add(
        format!("cross-operation-{name}.can").into(),
        format!("{GIVEN}{scenarios}{THEN}").into(),
    );
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, ir)
}

fn item<'a>(ir: &'a IrProgram, canonical: &str) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .unwrap()
}

fn source_text(db: &SourceDb, span: Span) -> &str {
    db.get(span.file)
        .unwrap()
        .text
        .get(span.start as usize..span.end as usize)
        .unwrap()
        .trim()
}

fn joined(name: &str, scenarios: &str, parent: &str) -> (SourceDb, IrProgram) {
    let (db, ir) = lowered(name, scenarios);
    let owner = item(&ir, parent);
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    let sites =
        collect_static_scenario_calls(&ir, owner, &emitted.operations, &db, &emitted.entry.path)
            .expect("complete cross-operation CALL");
    assert_eq!(sites.len(), 1);
    assert_eq!(
        sites[0].interface.to_json(),
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == sites[0].target)
            .unwrap()
            .to_json()
    );
    assert_eq!(
        emitted
            .entry
            .js
            .matches(&format!(
                "await invokeScenarioReceiptCall(c,\"{}\"",
                sites[0].id
            ))
            .count(),
        1
    );
    assert!(emitted
        .operations
        .iter()
        .find(|operation| operation.name == parent)
        .unwrap()
        .disclosure
        .is_some());
    (db, ir)
}

fn assert_join_refused(ir: &IrProgram, db: &SourceDb, parent: &str, mode: &str) {
    let emitted = js::emit_program_with_native_source_receipts(ir, true, db);
    let owner = item(ir, parent);
    assert!(
        collect_static_scenario_calls(ir, owner, &emitted.operations, db, &emitted.entry.path)
            .is_none(),
        "{mode}: static CALL survived"
    );
    assert!(
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == parent)
            .is_none_or(|operation| operation.disclosure.is_none()),
        "{mode}: native disclosure survived"
    );
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{mode}: {:?}",
        emitted.diagnostics
    );
}

#[test]
fn void_scalar_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "control",
        r#"  export scenario ctl_child(branch:Branch,title:text) by=members
   do set branch {title}
  scenario ctl_parent(branch:Branch,title:text) by=members
   do call ctl_child {branch,title}
"#,
        "t.ctl_parent",
    );
    let owner = item(&ir, "t.ctl_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    let child = emitted
        .operations
        .iter()
        .find(|operation| operation.name == "t.ctl_child")
        .unwrap();
    assert_eq!(child.result.as_deref(), Some("void"));
}

#[test]
fn model_result_passthrough_joins_and_returns_bound_result() {
    let (db, ir) = joined(
        "model-pass",
        r#"  export scenario mp_child(branch:Branch,title:text) -> Branch by=members
   do
    create Branch {parent=branch.parent,title} as made
    return made
  scenario mp_parent(branch:Branch,title:text) -> Branch by=members
   do
    call mp_child {branch,title} as made
    set branch {title}
    return made
"#,
        "t.mp_parent",
    );
    let parent = item(&ir, "t.mp_parent");
    let calls =
        canlang_compiler::codegen::scenario_calls::collect_scenario_source_calls(&ir, parent, &db)
            .expect("checked model CALL source");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].binding.as_deref(), Some("made"));
    assert_eq!(
        calls[0].result,
        Some(ResolvedType::Record {
            symbol: item(&ir, "t.Branch").id,
            stored: true
        })
    );
}

#[test]
fn scalar_member_operand_joins_with_original_spelling() {
    let (db, ir) = joined(
        "scalar-member",
        r#"  export scenario sm_child(branch:Branch,title:text) by=members
   do set branch {title}
  scenario sm_parent(branch:Branch,leaf:Leaf) by=members
   do call sm_child {branch,title=leaf.note}
"#,
        "t.sm_parent",
    );
    let parent = item(&ir, "t.sm_parent");
    let calls =
        canlang_compiler::codegen::scenario_calls::collect_scenario_source_calls(&ir, parent, &db)
            .expect("checked scalar-member CALL source");
    assert_eq!(calls.len(), 1);
    assert_eq!(source_text(&db, calls[0].inputs[1].source), "leaf.note");
}

fn effects_mut<'a>(ir: &'a mut IrProgram, name: &str) -> &'a mut Vec<IrStmt> {
    let id = item(ir, name).id;
    let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
        panic!("scenario")
    };
    effects
}

fn call_inputs_mut<'a>(ir: &'a mut IrProgram, name: &str) -> &'a mut Vec<(String, ir::TypedExpr)> {
    let IrStmt::Call { inputs, .. } = effects_mut(ir, name)
        .iter_mut()
        .find(|stmt| matches!(stmt, IrStmt::Call { .. }))
        .unwrap()
    else {
        panic!("call")
    };
    let IrExpr::Object(entries) = &mut inputs.expr else {
        panic!("inputs")
    };
    entries
}

#[test]
fn skewed_call_inputs_refuse_source_ir_and_interface_match() {
    const SOURCE: &str = r#"  export scenario sk_child(branch:Branch,title:text) by=members
   do set branch {title}
  scenario sk_parent(branch:Branch,title:text) by=members
   do call sk_child {branch,title}
"#;
    for mode in [
        "argument-order",
        "argument-omission",
        "argument-duplicate",
        "void-binding",
    ] {
        let (db, ir) = lowered("skew", SOURCE);
        let mut changed = ir.clone();
        match mode {
            "argument-order" => call_inputs_mut(&mut changed, "t.sk_parent").swap(0, 1),
            "argument-omission" => {
                call_inputs_mut(&mut changed, "t.sk_parent").pop();
            }
            "argument-duplicate" => {
                let entries = call_inputs_mut(&mut changed, "t.sk_parent");
                entries[1].0 = entries[0].0.clone();
            }
            "void-binding" => {
                let id = item(&changed, "t.sk_parent").id;
                let IrItemKind::Scenario { effects, .. } = &mut changed.items[id.0 as usize].kind
                else {
                    panic!("scenario")
                };
                let IrStmt::Call { binding, .. } = effects
                    .iter_mut()
                    .find(|stmt| matches!(stmt, IrStmt::Call { .. }))
                    .unwrap()
                else {
                    panic!("call")
                };
                *binding = Some("held".to_string());
            }
            _ => unreachable!(),
        }
        assert_join_refused(&changed, &db, "t.sk_parent", mode);
    }
}

#[test]
fn recursive_calls_refuse_at_check() {
    const SOURCE: &str = r#"  export scenario rc_self(branch:Branch) by=members
   do call rc_self {branch}
  export scenario rc_a(branch:Branch) by=members
   do call rc_b {branch}
  export scenario rc_b(branch:Branch) by=members
   do call rc_a {branch}
"#;
    let mut db = SourceDb::new();
    let file = db.add(
        "cross-operation-recursion.can".into(),
        format!("{GIVEN}{SOURCE}{THEN}").into(),
    );
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (_, diagnostics) = check_program(&db, &[file], Some(&catalog.unwrap()));
    let cycles: Vec<_> = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "E3005")
        .map(|diagnostic| diagnostic.message.clone())
        .collect();
    assert!(
        cycles
            .iter()
            .any(|message| message.contains("rc_self -> rc_self")),
        "{cycles:?}"
    );
    assert!(
        cycles
            .iter()
            .any(|message| message.contains("rc_a -> rc_b -> rc_a")),
        "{cycles:?}"
    );
}
