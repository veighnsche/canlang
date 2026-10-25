//! Source-owned required reference and Money paths in native owner invariants.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::artifact::to_json;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

const SOURCE: &str = r#"app RequiredRules
Given
 Customer {active:bool}
 Contact in Customer {name:text}
 Location {currency:currency}
 Checked {customer:Customer,contact:Contact,location:Location,value:money}
 invariant Checked: row.contact.parent==row.customer and row.value.minor>=0 and row.value.currency==row.location.currency
 policy Customer read=members
 policy Contact read=members
 policy Location read=members
 policy Checked read=members
 contract Lead {customer:Customer,contact:Contact,location:Location,value:money}
When
 scenario check(input:Lead) -> Checked by=members
  do
   create Checked {customer=input.customer,contact=input.contact,location=input.location,value=input.value} as result
   return result
Then
"#;

fn checked(source: &str) -> (SourceDb, CheckedProgram, Option<Catalog>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let file = db.add("required-rules.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, catalog)
}

#[test]
fn original_required_invariant_emits_lazy_reads_and_reverse_dependencies() {
    for source in [
        SOURCE.to_string(),
        SOURCE
            .replace("RequiredRules", "Renamed")
            .replace("Checked", "Recorded")
            .replace("Contact", "Person")
            .replace("contact", "person"),
    ] {
        let app = if source.contains("app Renamed") {
            "Renamed"
        } else {
            "RequiredRules"
        };
        let (db, program, catalog) = checked(&source);
        let mut result = DiagnosticResult::new("required-rules", "1.0", 1);
        result.add_sources(&db);
        let (artifact, diagnostics) = emit(
            &program,
            &EmitSources {
                db: &db,
                result: &result,
                catalog: catalog.as_ref(),
                options: EmitOptions {
                    allow_incomplete_test_only: false,
                    native_scenario_receipts: true,
                },
            },
        );
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let artifact: serde_json::Value = serde_json::from_str(&to_json(&artifact)).unwrap();
        let policies = artifact["modelPolicies"].as_array().unwrap();
        let dependencies = policies[0]["rules"][0]["dependencies"].as_array().unwrap();
        assert_eq!(
            dependencies
                .iter()
                .map(|dependency| dependency["model"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                format!(
                    "{app}.{}",
                    if app == "Renamed" {
                        "Person"
                    } else {
                        "Contact"
                    }
                ),
                format!("{app}.Location")
            ]
        );
        assert!(
            dependencies
                .iter()
                .all(|dependency| dependency["maxTargets"] == 200)
        );
        let module = artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|module| module["js"].as_str().unwrap())
            .collect::<String>();
        assert!(module.contains("nativeReadReference(c,"));
        assert!(module.contains("same("));
        assert!(module.contains("views.final.query("));
        assert!(module.contains("archived:\"include\""));
        assert!(module.contains("location.id"));
        assert!(module.contains(if app == "Renamed" {
            "person.id"
        } else {
            "contact.id"
        }));
    }
}

#[test]
fn parent_enum_invariants_retain_lazy_binding_and_reverse_parent_dependency() {
    for (app, parent, child, predicate) in [
        (
            "ParentRules",
            "Customer",
            "CompanyRole",
            "row.parent.kind==company",
        ),
        ("ReusedRules", "Account", "Seat", "company==row.parent.kind"),
        (
            "LazyRules",
            "Customer",
            "CompanyRole",
            "row.enabled or row.parent.kind!=person",
        ),
    ] {
        let source = format!(
            "app {app}\nGiven\n {parent} {{kind:enum(person,company)=person}}\n {child} in {parent} {{enabled:bool=false}}\n invariant {child}: {predicate}\n policy {parent} read=members\n policy {child} read=members\nWhen\nThen\n"
        );
        let (db, program, catalog) = checked(&source);
        let mut result = DiagnosticResult::new("parent-enum-rules", "1.0", 1);
        result.add_sources(&db);
        let (artifact, diagnostics) = emit(
            &program,
            &EmitSources {
                db: &db,
                result: &result,
                catalog: catalog.as_ref(),
                options: EmitOptions {
                    allow_incomplete_test_only: false,
                    native_scenario_receipts: true,
                },
            },
        );
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let artifact: serde_json::Value = serde_json::from_str(&to_json(&artifact)).unwrap();
        let policies = artifact["modelPolicies"].as_array().unwrap();
        let policy = policies
            .iter()
            .find(|policy| policy["model"] == format!("{app}.{child}"))
            .unwrap();
        let dependencies = policy["rules"][0]["dependencies"].as_array().unwrap();
        assert_eq!(dependencies.len(), 1);
        assert_eq!(dependencies[0]["model"], format!("{app}.{parent}"));
        assert_eq!(dependencies[0]["maxTargets"], 200);
        let module = artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|module| module["js"].as_str().unwrap())
            .collect::<String>();
        assert!(module.contains("nativeReadReference(c,"));
        assert!(module.contains("views.final.query("));
        assert!(module.contains(&format!("parent:{{model:\"{app}.{parent}\",id:$id}}")));
        assert!(module.contains("archived:\"include\""));
    }
}
