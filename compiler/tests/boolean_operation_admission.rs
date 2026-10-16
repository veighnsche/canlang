//! Outcome 8 (C02/C03 Boolean operation admission): original role-expression
//! `by=` gates emit matching operation/policy trees through the existing
//! ordered State `ByPredicate` receiver.
//!
//! The original 43 operation sites are pure role `or` trees (declared roles
//! and built-in actor spellings, source-ordered); no data/subject gate is
//! implied. The compiler transcribes exactly those trees into both the
//! `operations` member (`by:`) and the `policy.operations` manifest, reusing
//! the State `ByPredicate` AST read-only (`packages/state/src/policy/roles.ts`
//! plus the native T16 transcription in
//! `packages/cloudflare/src/runtime/invoke.ts`, both Lane C territory and
//! unchanged here). Genuine scenario and CRUD consumers keep short-circuit
//! order, exact roles, current authority (live `hasRole` re-resolution,
//! never baked snapshots), original resolver failures and the separately
//! sealed CRUD `when` marker.
//!
//! TEST-ONLY: artifacts are produced under the explicit test-only
//! incomplete-analysis acknowledgment with no catalog, exactly like the
//! hermetic `b3_i5` goldens. Assertions read emitted JS only; no module is
//! executed and nothing here claims runtime success.

use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, SourceId};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

/// Emit the entry module JS for one source under the test-only ack, with
/// every emission diagnostic in canonical order.
fn emit_all(source: &str) -> (String, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id: SourceId = db.add("test.can".to_string(), source.to_string());
    let (program, check_diags) = check_program(&db, &[id], None);
    assert!(
        check_diags.is_empty(),
        "check must pass for emission fixtures: {check_diags:?}"
    );
    let mut result = DiagnosticResult::new("test", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.diagnostics = Vec::new();
    result.complete = false;
    result.finish();
    let sources = EmitSources {
        db: &db,
        result: &result,
        catalog: None,
        options: EmitOptions::test_only(),
    };
    let (artifact, emit_diags) = emit(&program, &sources);
    let js = artifact
        .modules
        .first()
        .map(|m| m.js.clone())
        .unwrap_or_default();
    (js, emit_diags)
}

fn codes(diags: &[Diagnostic]) -> Vec<String> {
    diags
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect()
}

/// Shared Given: four declared roles, one stored model with a member read
/// grant, and a user predicate for sealed CRUD `when` clauses.
const GIVEN: &str = r#"app T
Given
 role reviewer
 role finance
 role legal
 role sales
 M { title:text, owner:user }
 policy M read=members
 derive allowed(person:user):bool = person.id != ""
When
"#;

/// Original two-way shape (`authenticated or host_manager`, CanBook): a
/// built-in plus a declared role, in authored order, on a scenario.
fn two_way() -> String {
    format!(
        "{GIVEN} scenario hold(record:M) by=authenticated or reviewer\n  do set record {{title=\"held\"}}\nThen\n"
    )
}

/// Original four-way shape (`legal or sales or property_manager or
/// finance`, CanContract): declared roles only, on CRUD with a sealed
/// `when` candidate precondition.
fn four_way_crud() -> String {
    format!(
        "{GIVEN} crud M by=legal or sales or reviewer or finance fields=title when=allowed(actor)\nThen\n"
    )
}

/// Original three-way shape with a leading built-in
/// (`authenticated or reception or billing`, CanRent).
fn three_way() -> String {
    format!(
        "{GIVEN} scenario greet(record:M) by=authenticated or reviewer or finance\n  do set record {{title=\"hi\"}}\nThen\n"
    )
}

#[test]
fn two_way_scenario_emits_matching_operation_and_policy_trees() {
    let (js, diags) = emit_all(&two_way());
    assert!(
        diags.iter().all(|d| d.code != "E6008"),
        "role-or admission emits, nothing refused: {:?}",
        codes(&diags)
    );
    // Operations member carries the ordered tree: built-ins stay bare,
    // declared roles become `{role}` objects, source order kept.
    assert!(
        js.contains(r#"by:{"or":["authenticated",{"role":"T.reviewer"}]}"#),
        "operations by tree in source order:\n{js}"
    );
    // Policy manifest carries the same tree as its single `by` term, with
    // no `gated` marker and no invented spelling.
    assert!(
        js.contains(r#""T.hold":{by:[{"or":["authenticated",{"role":"T.reviewer"}]}]}"#),
        "policy by tree without gated marker:\n{js}"
    );
    assert!(
        !js.contains("gated:true"),
        "pure role trees are transcribable, never gated:\n{js}"
    );
}

#[test]
fn four_way_crud_emits_trees_with_separately_sealed_when() {
    let src = four_way_crud();
    let (js, diags) = emit_all(&src);
    assert!(
        diags.iter().all(|d| d.code != "E6008"),
        "role-or CRUD admission emits, nothing refused: {:?}",
        codes(&diags)
    );
    let tree = r#"{"or":[{"role":"T.legal"},{"role":"T.sales"},{"role":"T.reviewer"},{"role":"T.finance"}]}"#;
    // Every generated CRUD operation carries the exact four-way tree with
    // exact roles in authored order.
    for op in ["T.M.create", "T.M.update", "T.M.delete"] {
        assert!(
            js.contains(&format!("by:{tree}")),
            "operations {op} carries the tree:\n{js}"
        );
    }
    // Policy entries carry the same tree AND keep `when:true` as a sealed
    // marker: the candidate predicate is emitted code, never inlined data.
    for op in ["T.M.create", "T.M.update", "T.M.delete"] {
        let marker = format!("\"{op}\":{{by:[{tree}],when:true}}");
        assert!(
            js.contains(&marker),
            "policy {op} keeps sealed when beside the tree:\n{js}"
        );
    }
}

#[test]
fn three_way_builtin_first_keeps_order_and_bare_builtins() {
    let (js, diags) = emit_all(&three_way());
    assert!(
        diags.iter().all(|d| d.code != "E6008"),
        "role-or admission emits, nothing refused: {:?}",
        codes(&diags)
    );
    assert!(
        js.contains(r#"by:{"or":["authenticated",{"role":"T.reviewer"},{"role":"T.finance"}]}"#),
        "three-way tree keeps authored order:\n{js}"
    );
}

#[test]
fn lone_role_gate_keeps_exact_historical_bytes() {
    let src = format!("{GIVEN} crud M by=members fields=title\nThen\n");
    let (js, diags) = emit_all(&src);
    assert!(
        diags.iter().all(|d| d.code != "E6008"),
        "lone roles still emit: {:?}",
        codes(&diags)
    );
    // Historical single-role forms are byte-identical: bare strings, no
    // tree wrappers, no gated markers.
    assert!(
        js.contains(r#""T.M.create":{by:["members"]}"#),
        "policy lone-role bytes unchanged:\n{js}"
    );
    assert!(
        js.contains(r#"by:"members""#),
        "operations lone-role bytes unchanged:\n{js}"
    );
    assert!(
        !js.contains("gated:true") && !js.contains("{or:") && !js.contains("{and:"),
        "lone roles emit no trees:\n{js}"
    );
}

#[test]
fn subject_gate_still_refuses_loud_without_a_tree() {
    let src = format!(
        "{GIVEN} scenario s(candidate:M, person:user) by=reviewer(person)\n  do set candidate {{title=\"x\"}}\nThen\n"
    );
    let (js, diags) = emit_all(&src);
    // The subject gate has no static tree form: the operations member
    // refuses loudly with the historical message...
    assert!(
        codes(&diags)
            .iter()
            .any(|d| d.contains("expression gates have no operations-member lowering")),
        "subject gate keeps loud refusal: {:?}",
        codes(&diags)
    );
    // ...the policy manifest marks it gated without inventing a tree...
    assert!(
        js.contains(r#""T.s":{gated:true}"#),
        "subject gate stays gated:true:\n{js}"
    );
    // ...and no ByPredicate tree is fabricated for it.
    assert!(
        !js.contains("{\"role\":\"T.r\"}"),
        "no invented tree for subject gates:\n{js}"
    );
}

#[test]
fn data_gate_still_refuses_loud_without_a_tree() {
    let src = format!(
        "{GIVEN} scenario s(candidate:M) by=reviewer or (actor != null and allowed(actor))\n  do set candidate {{title=\"x\"}}\nThen\n"
    );
    let (js, diags) = emit_all(&src);
    assert!(
        codes(&diags)
            .iter()
            .any(|d| d.contains("operations-member lowering")),
        "data-mixed gate keeps loud refusal: {:?}",
        codes(&diags)
    );
    assert!(
        js.contains("gated:true") && !js.contains(r#""T.s":{by:"#),
        "data-mixed gate stays gated with no by tree:\n{js}"
    );
}

#[test]
fn admission_check_short_circuits_in_source_order() {
    let (js, diags) = emit_all(&two_way());
    assert!(
        diags.iter().all(|d| d.code != "E6008"),
        "role-or admission emits: {:?}",
        codes(&diags)
    );
    // The executable admission keeps lazy left-to-right order: the
    // built-in check precedes the declared-role check in one `||` chain.
    let check = js
        .find("hasRole(c,\"authenticated\")")
        .expect("builtin admission check:\n{js}");
    let role = js
        .find("hasRole(c,\"T.reviewer\")")
        .expect("declared-role admission check:\n{js}");
    assert!(check < role, "admission evaluates in source order:\n{js}");
    assert!(js.contains("||"), "disjunction stays lazy:\n{js}");
}

#[test]
fn unknown_role_still_fails_at_check_with_no_tree() {
    let src = format!(
        "{GIVEN} scenario s(candidate:M) by=reviewer or nope\n  do set candidate {{title=\"x\"}}\nThen\n"
    );
    let mut db = SourceDb::new();
    let id: SourceId = db.add("test.can".to_string(), src);
    let (_, check_diags) = check_program(&db, &[id], None);
    // Original resolver failure: the unknown name refuses at check time,
    // so no admission tree can be fabricated for it.
    assert!(
        check_diags
            .iter()
            .any(|d| d.code == "E2001" && d.message.contains("nope")),
        "unknown role still fails resolution: {check_diags:?}"
    );
}
