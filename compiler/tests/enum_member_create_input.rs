//! Enum-typed member reads as create inputs under a first query.
//!
//! A scenario whose first query compares against a param-row enum field
//! (`c.role==i.role`) and whose create stores that same read
//! (`role=i.role`) lifts the read as a return DATA dependency. The
//! return-dependency transport owner previously admitted enum data only
//! for machine-transition recipes, so every transition-less enum create
//! input refused with `cannot lower first query` even though the create
//! correspondence, the predicate and the plan each pass on their own.
//! Plain (non-machine) enum reads now transport as the sealed
//! `enum(a,b)` identity with nominal owner correspondence; machine
//! fields keep their transition-only path and its refusal.
//!
//! The fixtures are void scenarios (the original CanCustomer accept
//! profile): a data-bearing scalar return without projection is refused
//! at the runtime binder by design, while void carries no result value
//! to shape and binds the same data read under caller authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::codegen::artifact::to_json;
use serde_json::Value;
use std::path::{Path, PathBuf};

const REUSED: &str = r#"app EnumCreateProbe
Given
 P {v:int}
 C in P {account:user,role:enum(administrator,booker)}
 D in P {account:user,role:C.role,w:int}
 I in P {role:C.role}
 policy P read=members fields=v
 policy C read=members fields=parent,account,role
 policy D read=members fields=parent,account,role,w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role
 crud D by=members fields=parent,account,role,w
 crud I by=members fields=parent,role
 scenario go(p:P,i:I) by=members
  do
   let c=first(p.C as c where c.account==actor and c.role==i.role order=c.id)
   require c!=null
   create D {parent=p,account=actor,role=i.role,w=1} as d
Then
"#;

const LITERAL: &str = r#"app EnumCreateLiteralProbe
Given
 P {v:int}
 C in P {account:user,role:enum(administrator,booker)}
 D in P {account:user,role:C.role,w:int}
 I in P {role:C.role}
 policy P read=members fields=v
 policy C read=members fields=parent,account,role
 policy D read=members fields=parent,account,role,w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role
 crud D by=members fields=parent,account,role,w
 crud I by=members fields=parent,role
 scenario go(p:P,i:I) by=members
  do
   let c=first(p.C as c where c.account==actor and c.role==i.role order=c.id)
   require c!=null
   create D {parent=p,account=actor,role=administrator,w=1} as d
Then
"#;

const MACHINE: &str = r#"app EnumCreateMachineProbe
Given
 P {v:int}
 C in P {account:user,role:enum(administrator,booker)}
 M in P {account:user,role:C.role=administrator machine}
 D in P {account:user,role:C.role,w:int}
 I in P {role:C.role}
 policy P read=members fields=v
 policy C read=members fields=parent,account,role
 policy M read=members fields=parent,account,role
 policy D read=members fields=parent,account,role,w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role
 crud D by=members fields=parent,account,role,w
 crud I by=members fields=parent,role
 scenario go(p:P,i:I,m:M) by=members
  do
   let c=first(p.C as c where c.account==actor and c.role==i.role order=c.id)
   require c!=null
   create D {parent=p,account=actor,role=m.role,w=1} as d
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn fixture(path: &str, source: &str) -> (SourceDb, CheckedProgram, ir::IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let catalog_path = root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
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

fn prepared(program: &CheckedProgram, db: &SourceDb, catalog: &Catalog) -> (Value, Vec<Diagnostic>) {
    let mut result = DiagnosticResult::new("enum-member-create-input", "1.0", 1);
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

fn operation<'a>(artifact: &'a Value, name: &str) -> &'a Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == name)
        .unwrap()
}

fn return_data_dep<'a>(prepared: &'a Value, operation_name: &str, field: &str) -> &'a Value {
    let disclosure = &operation(prepared, operation_name)["result"]["disclosure"];
    let returns = disclosure["returns"].as_array().unwrap();
    assert_eq!(returns.len(), 1, "void return discloses once");
    let deps = returns[0]["dependencies"].as_array().unwrap();
    let dep = deps
        .iter()
        .find(|dep| dep["field"] == field)
        .unwrap_or_else(|| panic!("return carries the {field} data read, got {deps:?}"));
    assert_eq!(dep["role"], "data");
    dep
}

#[test]
fn reused_enum_member_create_input_emits_sealed_data_transport() {
    let (db, program, _, catalog) = fixture("enum-member-create-input.can", REUSED);
    let (prepared, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let dep = return_data_dep(&prepared, "EnumCreateProbe.go", "role");
    assert_eq!(
        dep["type"], "enum(administrator,booker)",
        "plain enum data reads transport the sealed case identity, got {dep:?}"
    );
    assert_eq!(
        dep["model"], "EnumCreateProbe.I",
        "transport names the actually read row, got {dep:?}"
    );
    assert!(
        dep["id"].as_str().is_some_and(|id| !id.is_empty()),
        "data dependency carries an identity, got {dep:?}"
    );
    let source = &dep["source"];
    assert!(
        source["path"].as_str().unwrap().ends_with("enum-member-create-input.can"),
        "dependency keeps its source path, got {dep:?}"
    );
    assert!(
        source["sha256"].as_str().unwrap().len() >= 16,
        "dependency keeps its content identity, got {dep:?}"
    );
    let _ = db;
}

#[test]
fn literal_enum_create_input_carries_no_return_data_read() {
    // Control: the same query with a closed-case literal create stores no
    // transported read, so the data dependency above belongs to the member
    // create input rather than the predicate or the create itself.
    let (db, program, _, catalog) = fixture("enum-literal-create-input.can", LITERAL);
    let (prepared, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let disclosure = &operation(&prepared, "EnumCreateLiteralProbe.go")["result"]["disclosure"];
    let returns = disclosure["returns"].as_array().unwrap();
    assert_eq!(returns.len(), 1);
    assert_eq!(
        returns[0]["dependencies"].as_array().unwrap().len(),
        0,
        "literal create inputs transport no data read"
    );
    let _ = db;
}

#[test]
fn machine_enum_member_read_still_refuses_without_transition() {
    // A machine-governed enum read keeps its transition-recipe-only
    // transport: without a transition in the scenario the plain-enum
    // admission must not pick it up.
    let (db, program, _, catalog) = fixture("enum-machine-create-input.can", MACHINE);
    let (_, diagnostics) = prepared(&program, &db, &catalog);
    assert!(
        diagnostics.iter().any(|diagnostic| diagnostic.code == "E6008"
            && diagnostic.message.contains("original native query correspondence")),
        "machine enum reads without a transition keep the refusal, got {diagnostics:?}"
    );
    let _ = db;
}
