//! Finite first-query slice: `and`-chained `==` conjuncts (CAN18-v1).
//!
//! Selected admitted family (smallest complete): a contained id-ordered first
//! query whose where clause is one `==` or an order-preserving `and` chain
//! of `==` conjuncts over actor/param operands. Each conjunct records its own
//! Control dependency with per-conjunct source correspondence; the emitted
//! plan carries every ordered dependency with unique IDs.
//!
//! Deliberately still refused: `or` shapes, non-`==` comparisons, unknown
//! fields (early E2013), forged enum cases (early E2001), and anything
//! outside the admitted operand classes. Enum-typed fields admit with
//! enum params and closed case literals; the emitted plan carries the
//! compiler-sealed enum identity.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use serde_json::Value;
use std::path::{Path, PathBuf};

const CONJ: &str = include_str!("fixtures/first-query-conjunction.can");

fn conj_go(pred: &str) -> String {
    format!(
        r#"app ConjProbe
Given
 P {{v:int}}
 C in P {{v:int,role:text}}
 D {{w:int}}
 policy P read=members fields=v
 policy C read=members fields=parent,v,role
 policy D read=members fields=w
When
 crud P by=members fields=v
 crud C by=members fields=parent,v,role
 scenario go(p:P,n:int,r:text) -> int by=members
  do
   let c=first(p.C as c where {pred} order=c.id)
   require c!=null
   create D {{w=n}} as d
   return 1
Then
"#,
        pred = pred,
    )
}

fn conj_enum_go(pred: &str, params: &str) -> String {
    format!(
        r#"app ConjEnumProbe
Given
 P {{v:int}}
 C in P {{account:user,role:enum(administrator,booker)}}
 D {{w:int}}
 policy P read=members fields=v
 policy C read=members fields=parent,account,role
 policy D read=members fields=w
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role
 scenario go(p:P,{params}) -> int by=members
  do
   let c=first(p.C as c where {pred} order=c.id)
   require c!=null
   create D {{w=1}} as d
   return 1
Then
"#,
        pred = pred,
        params = params,
    )
}

fn conj_member_go(pred: &str, params: &str) -> String {
    format!(
        r#"app ConjMemberProbe
Given
 P {{v:int}}
 C in P {{account:user,role:enum(administrator,booker)}}
 D {{w:int}}
 I in P {{role:C.role}}
 policy P read=members fields=v
 policy C read=members fields=parent,account,role
 policy D read=members fields=w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role
 crud I by=members fields=parent,role
 scenario go(p:P,{params}) -> int by=members
  do
   let c=first(p.C as c where {pred} order=c.id)
   require c!=null
   create D {{w=1}} as d
   return 1
Then
"#,
        pred = pred,
        params = params,
    )
}

fn conj_contract_go(pred: &str, params: &str) -> String {
    format!(
        r#"app ConjContractProbe
Given
 P {{v:int}}
 contract Kinds {{role:enum(administrator,booker)}}
 C in P {{account:user,role:Kinds.role}}
 D {{w:int}}
 policy P read=members fields=v
 policy C read=members fields=parent,account,role
 policy D read=members fields=w
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role
 scenario go(p:P,{params}) -> int by=members
  do
   let c=first(p.C as c where {pred} order=c.id)
   require c!=null
   create D {{w=1}} as d
   return 1
Then
"#,
        pred = pred,
        params = params,
    )
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_catalog_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CAN_NATIVE_CATALOG") {
        return path.into();
    }
    root().join("packages/cloudflare/dist/native-catalog.json")
}

fn fixture_source(path: &str, source: &str) -> (SourceDb, CheckedProgram, ir::IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let path = native_catalog_path();
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
    (db, program, ir, catalog)
}

fn prepared_artifact(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (Value, Vec<Diagnostic>) {
    use canlang_compiler::codegen::artifact::to_json;
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    use canlang_compiler::diagnostic::DiagnosticResult;
    let mut result = DiagnosticResult::new("first-query-conjunction", "1.0", 1);
    result.add_sources(db);
    let (artifact, diagnostics) = emit(
        program,
        &EmitSources {
            db,
            result: &result,
            catalog: Some(catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    (
        serde_json::from_str(&to_json(&artifact)).unwrap(),
        diagnostics,
    )
}

fn has_e6008(diagnostics: &[Diagnostic], fragment: &str) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "E6008" && diagnostic.message.contains(fragment))
}

fn operation<'a>(artifact: &'a Value, name: &str) -> &'a Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == name)
        .unwrap()
}

fn query_dep_fields<'a>(prepared: &'a Value, operation_name: &str) -> Vec<&'a str> {
    let disclosure = &operation(prepared, operation_name)["result"]["disclosure"];
    let [query] = disclosure["queries"].as_array().unwrap().as_slice() else {
        panic!("one first query")
    };
    let deps = query["dependencies"].as_array().unwrap();
    assert!(!deps.is_empty(), "every conjunct emits its dependency");
    let mut ids: Vec<&str> = Vec::new();
    deps.iter()
        .map(|dep| {
            assert_eq!(dep["role"], "control");
            let id = dep["id"].as_str().unwrap();
            assert!(
                !id.is_empty() && !ids.contains(&id),
                "unique dependency IDs"
            );
            ids.push(id);
            dep["field"].as_str().unwrap()
        })
        .collect::<Vec<_>>()
}

#[test]
fn conj_two_param_predicates_admit() {
    let (db, program, _, catalog) =
        fixture_source("conj-two.can", &conj_go("c.v==n and c.role==r"));
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjProbe.go"),
        ["v", "role"],
        "emitted plan carries both conjuncts in source order"
    );
    let _ = db;
}

#[test]
fn conj_duplicate_field_admits_idempotent() {
    // A repeated conjunct restates the same constraint; per-occurrence
    // dependency IDs stay unique, so no new correspondence rule is needed.
    let (db, program, _, catalog) = fixture_source("conj-dup.can", &conj_go("c.v==n and c.v==n"));
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjProbe.go"),
        ["v", "v"],
        "both occurrences are emitted"
    );
    let _ = db;
}

#[test]
fn conj_fixture_scenarios_admit() {
    let (db, program, _, catalog) = fixture_source("conjunction.can", CONJ);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjSources.go_conj"),
        ["v", "role"]
    );
    assert_eq!(
        query_dep_fields(&prepared, "ConjSources.go_conj3"),
        ["v", "role", "tag"]
    );
    assert_eq!(
        query_dep_fields(&prepared, "ConjSources.go_conj_branch"),
        ["v", "role"],
        "conjunction composes with the admitted if-branch tail"
    );
    let _ = db;
}

#[test]
fn conj_or_shape_refuses() {
    let (db, program, _, catalog) = fixture_source("conj-or.can", &conj_go("c.v==n or c.role==r"));
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "cannot lower first query"),
        "or-shape where must stay refused, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn conj_comparison_refuses() {
    let (db, program, _, catalog) = fixture_source("conj-cmp.can", &conj_go("c.v==n and c.v>n"));
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "cannot lower first query"),
        "comparison conjunct must stay refused, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn conj_unknown_field_refuses_early() {
    // An unknown conjunct field never typechecks: the refusal lands at
    // check_program before any disclosure/receipt gate runs, so it cannot
    // reach the conjunction admission below. Observed against the real
    // compiler: E2013 unknown member 'missing' on model C.
    let mut db = SourceDb::new();
    let file = db.add("conj-field.can".into(), conj_go("c.v==n and c.missing==r"));
    let path = native_catalog_path();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (_, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "E2013" && diagnostic.message.contains("unknown member")
        }),
        "unknown conjunct field keeps its loud early refusal, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn conj_enum_param_admits() {
    let (db, program, _, catalog) = fixture_source(
        "conj-enum-param.can",
        &conj_enum_go("c.account==actor and c.role==r", "r:C.role"),
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjEnumProbe.go"),
        ["account", "role"],
        "actor plus enum-param conjuncts emit in source order"
    );
    let _ = db;
}

#[test]
fn conj_enum_literal_admits() {
    let (db, program, _, catalog) = fixture_source(
        "conj-enum-lit.can",
        &conj_enum_go("c.role==administrator", "n:int"),
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjEnumProbe.go"),
        ["role"],
        "closed case literal emits its single dependency"
    );
    let _ = db;
}

#[test]
fn conj_forged_case_refuses_early() {
    // A case name outside the declared enum never resolves: the refusal
    // lands at check_program before any disclosure/receipt gate runs.
    // Observed against the real compiler: E2001 unresolved name 'nobody'.
    let mut db = SourceDb::new();
    let file = db.add(
        "conj-case.can".into(),
        conj_enum_go("c.role==nobody", "n:int"),
    );
    let path = native_catalog_path();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (_, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "E2001" && diagnostic.message.contains("unresolved name")
        }),
        "forged enum case keeps its loud early refusal, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn conj_member_grouped_base_admits() {
    // Grouping and trivia shift surface spans: the sealed path is
    // normalized (`i.role`) and the receiver occurrence is the exact
    // recorded original, so a grouped base still clears full emission.
    let (db, program, _, catalog) = fixture_source(
        "conj-member-grouped.can",
        &conj_member_go("c.account==actor and c.role==(i).role", "i:I"),
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjMemberProbe.go"),
        ["account", "role"],
        "grouped member read emits both control dependencies"
    );
    let _ = db;
}

#[test]
fn conj_member_read_admits() {
    // A param-row member read compares against the caller's admitted
    // row field through the complete emitted artifact: same-domain
    // enum, exact base and field.
    let (db, program, _, catalog) = fixture_source(
        "conj-member.can",
        &conj_member_go("c.account==actor and c.role==i.role", "i:I"),
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjMemberProbe.go"),
        ["account", "role"],
        "member-read conjunct emits its control dependency"
    );
    let _ = db;
}

#[test]
fn conj_enum_contract_qualified_literal_admits() {
    // A contract-owned qualified closed case lowers to the same semantic
    // case as a model-owned one and must clear the complete emitted
    // artifact: the retained checked set owns the Model|Contract rule,
    // not a model-name heuristic.
    let (db, program, _, catalog) = fixture_source(
        "conj-enum-contract-qual.can",
        &conj_contract_go("c.role==Kinds.role.administrator", "n:int"),
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjContractProbe.go"),
        ["role"],
        "contract-owned qualified case emits its control dependency"
    );
    let _ = db;
}

#[test]
fn conj_enum_qualified_literal_admits() {
    // A qualified closed-case spelling lowers to the same semantic case
    // as the bare literal and must clear the complete emitted artifact,
    // not just the predicate correspondence check.
    let (db, program, _, catalog) = fixture_source(
        "conj-enum-qual.can",
        &conj_enum_go("c.role==C.role.administrator", "n:int"),
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjEnumProbe.go"),
        ["role"],
        "qualified case emits its control dependency"
    );
    let _ = db;
}

fn conj_nav_go(pred: &str, params: &str) -> String {
    format!(
        r#"app ConjNavProbe
Given
 P {{v:int}}
 C in P {{v:int,account:user}}
 D {{w:int}}
 I in P {{v:int}}
 policy P read=members fields=v
 policy C read=members fields=parent,v,account
 policy D read=members fields=w
 policy I read=members fields=parent,v
When
 crud P by=members fields=v
 crud C by=members fields=parent,v,account
 crud I by=members fields=parent,v
 scenario go(p:P,i:I{params}) -> int by=members
  do
   let c=first(i.parent.C as c where {pred} order=c.id)
   require c!=null
   create D {{w=1}} as d
   return 1
Then
"#,
        pred = pred,
        params = params,
    )
}

fn conj_nav_member_go(pred: &str) -> String {
    format!(
        r#"app ConjNavMemberProbe
Given
 P {{v:int}}
 C in P {{account:user,role:enum(administrator,booker)}}
 D {{w:int}}
 I in P {{role:C.role}}
 policy P read=members fields=v
 policy C read=members fields=parent,account,role
 policy D read=members fields=w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role
 crud I by=members fields=parent,role
 scenario go(p:P,i:I) -> int by=members
  do
   let c=first(i.parent.C as c where {pred} order=c.id)
   require c!=null
   create D {{w=1}} as d
   return 1
Then
"#,
        pred = pred,
    )
}

fn query_parent_plan<'a>(prepared: &'a Value, operation_name: &str) -> &'a Value {
    let disclosure = &operation(prepared, operation_name)["result"]["disclosure"];
    let [query] = disclosure["queries"].as_array().unwrap().as_slice() else {
        panic!("one first query")
    };
    &query["parent"]
}

#[test]
fn conj_navigation_parent_admits() {
    // The one-hop containment navigation off a default-free stored-record
    // parameter selects the exact parent model: the plan carries the
    // admitted-reference hop, never a relabeled same-model parameter.
    let (db, program, _, catalog) = fixture_source(
        "conj-nav.can",
        &conj_nav_go("c.account==actor and c.v==n", ",n:int"),
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjNavProbe.go"),
        ["account", "v"],
        "navigation conjuncts emit both control dependencies"
    );
    let parent = query_parent_plan(&prepared, "ConjNavProbe.go");
    assert_eq!(parent["model"], "ConjNavProbe.P");
    assert_eq!(parent["origin"]["kind"], "admitted-reference");
    assert_eq!(parent["origin"]["parameter"], "i");
    let _ = db;
}

#[test]
fn conj_navigation_member_over_parent_admits() {
    // The original invitation shape: a member-operand conjunct over the
    // navigated parent, keeping the exact sealed base.field occurrence.
    let (db, program, _, catalog) = fixture_source(
        "conj-nav-member.can",
        &conj_nav_member_go("c.account==actor and c.role==i.role"),
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "ConjNavMemberProbe.go"),
        ["account", "role"],
        "member conjunct over navigation emits both control dependencies"
    );
    let parent = query_parent_plan(&prepared, "ConjNavMemberProbe.go");
    assert_eq!(parent["model"], "ConjNavMemberProbe.P");
    assert_eq!(parent["origin"]["kind"], "admitted-reference");
    assert_eq!(parent["origin"]["parameter"], "i");
    let _ = db;
}

#[test]
fn conj_navigation_two_hop_refuses() {
    // Exactly one authored hop is admitted: a two-hop containment path
    // stays refused even though every member link typechecks.
    let source = r#"app ConjNavTwoHop
Given
 G {v:int}
 P in G {v:int}
 C in G {v:int,account:user}
 D {w:int}
 I in P {v:int}
 policy G read=members fields=v
 policy P read=members fields=parent,v
 policy C read=members fields=parent,v,account
 policy D read=members fields=w
 policy I read=members fields=parent,v
When
 crud G by=members fields=v
 crud P by=members fields=parent,v
 crud C by=members fields=parent,v,account
 crud I by=members fields=parent,v
 scenario go(g:G,i:I,n:int) -> int by=members
  do
   let c=first(i.parent.parent.C as c where c.account==actor and c.v==n order=c.id)
   require c!=null
   create D {w=n} as d
   return 1
Then
"#;
    let (db, program, _, catalog) = fixture_source("conj-nav-twohop.can", source);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "cannot lower first query"),
        "two-hop navigation must stay refused, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn conj_navigation_parent_rooted_operand_refuses() {
    // Conjunct receivers are parameters, never containment paths: a
    // parent-rooted operand carries no input entry of its own.
    let (db, program, _, catalog) = fixture_source(
        "conj-nav-proot.can",
        &conj_nav_go("c.account==actor and c.v==i.parent.v", ",n:int"),
    );
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "cannot lower first query"),
        "parent-rooted conjunct must stay refused, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn conj_navigation_fixture_admits() {
    // The committed navigation fixture pins both admitted scenarios end
    // to end at the compiler level; the installed consumer below proves
    // the executable half.
    let source = include_str!("fixtures/first-query-navigation.can");
    let (db, program, _, catalog) = fixture_source("first-query-navigation.can", source);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        query_dep_fields(&prepared, "NavProbe.go_nav"),
        ["account", "v"]
    );
    assert_eq!(
        query_dep_fields(&prepared, "NavProbe.go_nav_role"),
        ["account", "role"]
    );
    for scenario in ["NavProbe.go_nav", "NavProbe.go_nav_role"] {
        let parent = query_parent_plan(&prepared, scenario);
        assert_eq!(parent["model"], "NavProbe.P", "{scenario}");
        assert_eq!(parent["origin"]["kind"], "admitted-reference", "{scenario}");
        assert_eq!(parent["origin"]["parameter"], "i", "{scenario}");
    }
    let _ = db;
}
