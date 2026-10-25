//! Cross-operation CALL join: caller, typed inputs, admission, source order
//! and one owner transaction. Mirrors `scenario_call_references.rs`.
//!
//! Covered now: void scalar calls, model-result passthrough (the
//! `desk.handoff` consumption shape), scalar member operands, and the
//! refusal surface (recursion, order/omission/duplication skew, void
//! bindings). No native rows or File authority are issued.
//!
//! Admitted sub-shapes (Lane C D2/D6): void children with creates, and
//! `set` on a bound model-result child, join below with receipt emission.
//!
//! Admitted sub-shapes (Lane C D1/D3/D5/D7/D8 plus external effects): each
//! twin below carries one original gate — nullable widening (`text` into
//! `text?`, explicit and implicit), singular `file?`, enum and array slots
//! (including contract arrays and `=name` defaults), single-hop
//! `param.parent` provenance, branch-nested calls, member-domain loops and
//! `emit`/`schedule`/`cancel` children — and joins with
//! `invokeScenarioReceiptCall` emission.
//!
//! Remaining original-only shapes (still declined, reasons in parentheses):
//! filtered `as row where …` loops (not whole-collection member domains),
//! `send`/`cancel` inside loop bodies, record-carrying `emit` payloads,
//! nullable-to-required narrowing without an exact supplied type, and
//! `create` inside loop bodies.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{ResolvedType, check_program};
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
  Label in Branch {note:text,kind:enum(plain,fancy)=plain}
  contract Slot {from:datetime,until:datetime}
  event Ping {note:text}
  policy Conversation read=members
  policy Branch read=members
  policy Leaf read=members
  policy Label read=members
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
        format!("cross-operation-{name}.can"),
        format!("{GIVEN}{scenarios}{THEN}"),
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
    assert!(
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == parent)
            .unwrap()
            .disclosure
            .is_some()
    );
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

#[test]
fn void_create_child_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "void-create",
        r#"  export scenario vc_child(branch:Branch,title:text) by=members
   do
    create Leaf {parent=branch,note=title} as leaf
    set leaf {note=title}
  scenario vc_parent(branch:Branch,title:text) by=members
   do call vc_child {branch,title}
"#,
        "t.vc_parent",
    );
    let owner = item(&ir, "t.vc_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let child = item(&ir, "t.vc_child");
    assert!(matches!(
        ir.scenario_disclosures[&child.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

#[test]
fn bound_child_result_set_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "bound-set",
        r#"  export scenario bs_child(branch:Branch,title:text) -> Branch by=members
   do
    create Branch {parent=branch.parent,title} as made
    return made
  scenario bs_parent(branch:Branch,title:text) -> Branch by=members
   do
    call bs_child {branch,title} as made
    set made {title}
    return made
"#,
        "t.bs_parent",
    );
    let owner = item(&ir, "t.bs_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
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

/// D1/D3 twin (`propose.revise` `resource`/`product`): `text` widens into
/// `text?` with an explicit null default. The declaration keeps its
/// absence; the supply carries the exact inner type.
#[test]
fn widened_nullable_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "widen-null",
        r#"  export scenario wn_child(branch:Branch,title:text,product:text?=null) by=members
   do set branch {title}
  scenario wn_parent(branch:Branch,title:text,product:text) by=members
   do call wn_child {branch,title,product=title}
"#,
        "t.wn_parent",
    );
    let owner = item(&ir, "t.wn_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

/// D1 twin (`propose.revise` implicit `resource:text?`): absence without an
/// explicit default still widens from the exact supplied value.
#[test]
fn implicit_nullable_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "implicit-null",
        r#"  export scenario in_child(branch:Branch,title:text,resource:text?) by=members
   do set branch {title}
  scenario in_parent(branch:Branch,title:text,resource:text) by=members
   do call in_child {branch,title,resource}
"#,
        "t.in_parent",
    );
    let owner = item(&ir, "t.in_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

/// D1 twin (`desk.handoff` → `maintain.report` `photo`): the singular
/// `file?` slot admits the exact nullable supply; no File authority is
/// issued by the join itself.
#[test]
fn singular_file_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "singular-file",
        r#"  export scenario sf_child(branch:Branch,title:text,photo:file?=null) by=members
   do set branch {title}
  scenario sf_parent(branch:Branch,title:text,photo:file?=null) by=members
   do call sf_child {branch,title,photo}
"#,
        "t.sf_parent",
    );
    let owner = item(&ir, "t.sf_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

/// D1 twin (`maintain.inspect` `result`): enum slots keep their exact
/// checked domain through field reuse; case spellings are never converted.
#[test]
fn enum_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "enum-slot",
        r#"  export scenario en_child(branch:Branch,title:text,kind:Label.kind) by=members
   do set branch {title}
  scenario en_parent(branch:Branch,title:text,kind:Label.kind) by=members
   do call en_child {branch,title,kind}
"#,
        "t.en_parent",
    );
    let owner = item(&ir, "t.en_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

/// D1 twin (`maintain.inspect` `answers`, `propose.revise` `intervals`):
/// scalar and contract arrays keep their exact element shape; only required
/// slots or an empty-array literal default are eligible.
#[test]
fn array_calls_join_and_emit_receipt_call() {
    for (name, child_param, parent_param) in [
        ("scalar-array", "titles:text[]=[]", "titles:text[]"),
        ("contract-array", "slots:Slot[]=[]", "slots:Slot[]"),
    ] {
        let (db, ir) = joined(
            name,
            &format!(
                r#"  export scenario ax_child(branch:Branch,title:text,{child_param}) by=members
   do set branch {{title}}
  scenario ax_parent(branch:Branch,title:text,{parent_param}) by=members
   do call ax_child {{branch,title,{slot}}}
"#,
                slot = child_param.split(':').next().unwrap(),
            ),
            "t.ax_parent",
        );
        let owner = item(&ir, "t.ax_parent");
        assert!(matches!(
            ir.scenario_disclosures[&owner.id],
            ScenarioDisclosure::Complete(_)
        ));
        let _ = db;
    }
}

/// D1 twin (`propose.revise` `refund_before:datetime=from`): a genuine
/// `=name` default names an earlier required same-type parameter. The CALL
/// supplies every slot, so the default never evaluates there.
#[test]
fn param_reference_default_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "paramref-default",
        r#"  export scenario pr_child(branch:Branch,title:text,from:datetime,until:datetime=from) by=members
   do set branch {title}
  scenario pr_parent(branch:Branch,title:text,from:datetime,until:datetime) by=members
   do call pr_child {branch,title,from,until}
"#,
        "t.pr_parent",
    );
    let owner = item(&ir, "t.pr_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

/// D3/D5 twin (`proposal=revision.parent`): one checked `param.parent` hop
/// into a required slot. The base stays the caller's original required
/// model parameter; the hop is the checked containment edge.
#[test]
fn parent_member_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "parent-member",
        r#"  export scenario pm_child(conv:Conversation,title:text) by=members
   do set conv {title}
  scenario pm_parent(branch:Branch,title:text) by=members
   do call pm_child {conv=branch.parent,title}
"#,
        "t.pm_parent",
    );
    let owner = item(&ir, "t.pm_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

/// D7 twin (`field.complete` → `record_inspection`): a branch-nested call
/// keeps the caller's original parameter value; shadowing still resolves
/// through the lexical binding check and derived/call/loop positions refuse.
#[test]
fn branch_nested_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "nested-call",
        r#"  export scenario nc_child(branch:Branch,title:text) by=members
   do set branch {title}
  scenario nc_parent(branch:Branch,title:text) by=members
   do
    if title!=""
     call nc_child {branch,title}
"#,
        "t.nc_parent",
    );
    let owner = item(&ir, "t.nc_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

/// D8 twin (`propose.offer_alternative` loop shape): a member-domain loop
/// scans the caller's whole contained collection in source order next to a
/// joined call. Filtered `as row where …` loops still refuse below.
#[test]
fn member_domain_loop_with_call_joins_and_emits_receipt_call() {
    let (db, ir) = joined(
        "member-loop",
        r#"  export scenario ml_child(branch:Branch,title:text) by=members
   do set branch {title}
  scenario ml_parent(branch:Branch,title:text) by=members
   do
    call ml_child {branch,title}
    for leaf in branch.Leaf limit=10
     set leaf {note=title}
"#,
        "t.ml_parent",
    );
    let owner = item(&ir, "t.ml_parent");
    assert!(matches!(
        ir.scenario_disclosures[&owner.id],
        ScenarioDisclosure::Complete(_)
    ));
    let _ = db;
}

/// `_`-arm twins (`arrive`/`depart`/`cancel_booking`/`complete` shapes):
/// `emit`, `schedule` and `cancel` evaluate their exact authored value
/// operands once in source order inside the owner transaction. Record
/// reads never hide inside payloads or keys.
#[test]
fn external_effect_children_join_and_emit_receipt_call() {
    for (name, body) in [
        (
            "emit-child",
            "set branch {title}\n    emit Ping {note=title}",
        ),
        (
            "sched-child",
            "set branch {title}\n    schedule title at=now event=Ping {note=title}\n    cancel title",
        ),
    ] {
        let (db, ir) = joined(
            name,
            &format!(
                r#"  export scenario xe_child(branch:Branch,title:text) by=members
   do
    {body}
  scenario xe_parent(branch:Branch,title:text) by=members
   do call xe_child {{branch,title}}
"#
            ),
            "t.xe_parent",
        );
        let owner = item(&ir, "t.xe_parent");
        assert!(matches!(
            ir.scenario_disclosures[&owner.id],
            ScenarioDisclosure::Complete(_)
        ));
        let _ = db;
    }
}

/// Widening and provenance keep their refusals: an explicit null supply
/// (no exact inner value), a double-hop `parent.parent` chain and a
/// filtered member loop never join.
#[test]
fn widened_and_provenance_mismatches_refuse_join() {
    for (name, scenarios, parent) in [
        (
            "null-supply",
            r#"  export scenario mm_child(branch:Branch,title:text,product:text?=null) by=members
   do set branch {title}
  scenario mm_parent(branch:Branch,title:text) by=members
   do call mm_child {branch,title,product=null}
"#,
            "t.mm_parent",
        ),
        (
            "double-hop",
            r#"  export scenario dh_child(conv:Conversation,title:text) by=members
   do set conv {title}
  scenario dh_parent(leaf:Leaf,title:text) by=members
   do call dh_child {conv=leaf.parent.parent,title}
"#,
            "t.dh_parent",
        ),
        (
            "filtered-loop",
            r#"  export scenario fl_child(branch:Branch,title:text) by=members
   do set branch {title}
  scenario fl_parent(branch:Branch,title:text) by=members
   do
    call fl_child {branch,title}
    for leaf in branch.Leaf as row where row.note!="" limit=10
     set leaf {note=title}
"#,
            "t.fl_parent",
        ),
    ] {
        let (db, ir) = lowered(name, scenarios);
        assert_join_refused(&ir, &db, parent, name);
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
        format!("{GIVEN}{SOURCE}{THEN}"),
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
