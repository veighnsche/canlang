//! Original Contract input member provenance and native emission correspondence.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    DependencyRole, DisclosureIntrinsicKind, ScenarioDisclosure,
};
use canlang_compiler::analysis::{CheckedProgram, NodeKey, check_program};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, ir, js};
use canlang_compiler::codegen::artifact::to_json;
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const SOURCE: &str = r#"app InputMembers
Given
 Customer {active:bool,name:text}
 Location {title:text}
 Result {location:Location,title:text trim min=1,value:money,notes:text}
 contract Selection {location:Location}
 contract Lead {customer:Customer,alternate:Customer,selection:Selection,title:Result.title,value:money,notes:text}
 policy Customer read=members
 policy Location read=members
 policy Result read=members
When
 scenario promote(input:Lead) -> Result by=members
  require input.customer.active and input.alternate.active and input.value.minor>=0 and input.value.currency==input.value.currency
  do
   create Result {location=input.selection.location,title=input.title,value=input.value,notes=input.notes} as result
   return result
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn checked(source: &str) -> (SourceDb, CheckedProgram) {
    let (db, program, _) = checked_with_catalog(source);
    (db, program)
}
fn checked_with_catalog(source: &str) -> (SourceDb, CheckedProgram, Option<Catalog>) {
    let mut db = SourceDb::new();
    let file = db.add("contract-input-members.can".into(), source.into());
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, catalog)
}
fn disclosure(program: &CheckedProgram) -> &ScenarioDisclosure {
    let owner = program
        .symbols
        .iter()
        .find(|symbol| symbol.name == "promote")
        .unwrap();
    program.scenario_disclosures().get(&owner.id).unwrap()
}
fn text(db: &SourceDb, node: NodeKey) -> &str {
    db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
}
fn body(source: &str, result: &str, body: &str) -> String {
    let source = source.replace("-> Result by", &format!("-> {result} by"));
    let before = source.split("  require ").next().unwrap();
    format!("{before}  do\n{body}\nThen\n")
}

fn native_artifact(source: &str) -> serde_json::Value {
    let (db, program, catalog) = checked_with_catalog(source);
    let mut result = DiagnosticResult::new("contract-input-members", "1.0", 1);
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
    assert!(
        diagnostics.is_empty(),
        "{}; {}: {diagnostics:?}",
        source
            .lines()
            .find(|line| line.trim_start().starts_with("scenario "))
            .unwrap_or("scenario"),
        source
            .lines()
            .find(|line| line.trim_start().starts_with("require "))
            .unwrap_or("body")
    );
    serde_json::from_str(&to_json(&artifact)).unwrap()
}

#[test]
fn actual_native_emission_qualifies_original_renamed_result_and_version_input_paths() {
    for source in [
        SOURCE.to_string(),
        SOURCE
            .replace("InputMembers", "Renamed")
            .replace("Lead", "Reviewed")
            .replace("input", "payload")
            .replace("customer", "buyer"),
        body(SOURCE, "Location", "   return input.selection.location"),
        body(
            SOURCE,
            "int",
            "   return input.customer.version+input.alternate.version",
        ),
    ] {
        let artifact = native_artifact(&source);
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| {
                operation["name"]
                    .as_str()
                    .is_some_and(|name| name.ends_with(".promote"))
            })
            .unwrap();
        assert!(
            operation["result"]["disclosure"]["returns"]
                .as_array()
                .is_some_and(|returns| !returns.is_empty())
        );
        let callable = artifact["callables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|callable| callable["id"] == operation["name"])
            .unwrap();
        let generated = artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|module| module["path"] == callable["module"])
            .unwrap()["js"]
            .as_str()
            .unwrap();
        assert!(!generated.contains("throw new Error(\"Unsupported"));
    }
}

#[test]
fn native_input_path_correspondence_refuses_same_typed_field_substitution() {
    let (db, program, catalog) = checked_with_catalog(SOURCE);
    let (mut lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = lowered
        .items
        .iter_mut()
        .find(|item| item.canonical == "InputMembers.promote")
        .unwrap();
    let ir::IrItemKind::Scenario { effects, .. } = &mut owner.kind else {
        panic!("scenario");
    };
    let ir::IrStmt::Create { input, .. } = &mut effects[0] else {
        panic!("original create");
    };
    let ir::IrExpr::Object(entries) = &mut input.expr else {
        panic!("input entries");
    };
    let value = &mut entries
        .iter_mut()
        .find(|(name, _)| name == "title")
        .unwrap()
        .1;
    let ir::IrExpr::Member { field, .. } = &mut value.expr else {
        panic!("original member");
    };
    *field = "notes".into();
    let output = js::emit_program_with_native_source_receipts(&lowered, true, &db);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{:?}",
        output.diagnostics
    );
}

#[test]
fn required_contract_input_members_keep_actual_model_reads_and_scalar_payload_paths() {
    for source in [
        SOURCE.to_string(),
        SOURCE
            .replace("InputMembers", "Renamed")
            .replace("Lead", "Reviewed")
            .replace("input", "payload")
            .replace("customer", "buyer")
            .replace("selection", "chosen"),
    ] {
        let (db, program) = checked(&source);
        let ScenarioDisclosure::Complete(complete) = disclosure(&program) else {
            panic!("{:?}", disclosure(&program));
        };
        let root_name = if source.contains("payload:") {
            "payload"
        } else {
            "input"
        };
        let field = if root_name == "payload" {
            "buyer"
        } else {
            "customer"
        };
        let mut observed = Vec::new();
        for returned in &complete.returns {
            for read in &returned.dependencies {
                assert!(
                    read.model_name.ends_with(".Customer"),
                    "Contract input access is not a stored read: {read:?}"
                );
                assert_eq!(read.field_name, "active");
                assert_eq!(read.role, DependencyRole::Control);
                assert!(read.calls.is_empty() && read.query_id.is_none());
                observed.push(text(&db, read.node).to_string());
            }
            for leaf in ["title", "value", "notes"] {
                assert!(returned.intrinsics.iter().any(|intrinsic|
                    matches!(&intrinsic.kind, DisclosureIntrinsicKind::AdmittedInput {parameter,parameter_name}
                        if program.symbols[parameter.0 as usize].name == root_name && parameter_name == &format!("{root_name}/{leaf}"))
                        && text(&db, intrinsic.node) == format!("{root_name}.{leaf}")
                        && intrinsic.role == DependencyRole::Data));
            }
        }
        assert!(observed.contains(&format!("{root_name}.{field}.active")));
        assert!(observed.contains(&format!("{root_name}.alternate.active")));
        assert_eq!(complete.effects.len(), 1);
    }
}

#[test]
fn nested_required_model_result_and_explicit_id_keep_the_original_input_member_anchor() {
    for (result, expression, field) in [
        ("Location", "input.selection.location", "id"),
        ("text", "input.customer.id", "id"),
    ] {
        let source = body(SOURCE, result, &format!("   return {expression}"));
        let (db, program) = checked(&source);
        let ScenarioDisclosure::Complete(complete) = disclosure(&program) else {
            panic!("{:?}", disclosure(&program));
        };
        let [returned] = complete.returns.as_slice() else {
            panic!("one direct return");
        };
        let [read] = returned.dependencies.as_slice() else {
            panic!("one real model identity read");
        };
        assert_eq!(read.field_name, field);
        assert_eq!(text(&db, read.node), expression);
        assert_eq!(read.role, DependencyRole::Data);
        assert!(returned.intrinsics.is_empty());
    }
}

#[test]
fn separate_required_model_slots_keep_separate_original_version_paths() {
    let source = body(
        SOURCE,
        "int",
        "   return input.customer.version+input.alternate.version",
    );
    let (db, program) = checked(&source);
    let ScenarioDisclosure::Complete(complete) = disclosure(&program) else {
        panic!("{:?}", disclosure(&program));
    };
    let [returned] = complete.returns.as_slice() else {
        panic!("one version sum");
    };
    assert!(returned.dependencies.is_empty());
    assert_eq!(returned.intrinsics.len(), 2);
    for (intrinsic, slot) in returned.intrinsics.iter().zip(["customer", "alternate"]) {
        assert!(
            matches!(&intrinsic.kind, DisclosureIntrinsicKind::AdmittedReferenceVersion {parameter_name,model_name,..}
            if parameter_name == &format!("input/{slot}") && model_name == "InputMembers.Customer")
        );
        assert_eq!(text(&db, intrinsic.node), format!("input.{slot}.version"));
    }
    assert_ne!(returned.intrinsics[0].id, returned.intrinsics[1].id);
}

#[test]
fn copied_nullable_array_and_nonmodel_contract_slots_do_not_acquire_required_reference_provenance()
{
    let direct = body(SOURCE, "Location", "   return input.selection.location");
    for source in [
        direct.replace(
            "   return input.selection.location",
            "   let copied=input\n   return copied.selection.location",
        ),
        direct.replace(
            "   return input.selection.location",
            "   let copied=input.selection.location\n   return copied",
        ),
        direct
            .replace("location:Location}", "location:Location?}")
            .replace("-> Location by", "-> Location? by"),
        direct
            .replace("location:Location}", "location:Location[]}")
            .replace("-> Location by", "-> Location[] by"),
        direct
            .replace(
                "contract Selection {location:Location}",
                "contract Shell {title:text}\n contract Selection {location:Shell}",
            )
            .replace("-> Location by", "-> Shell by"),
    ] {
        let (_, program) = checked(&source);
        assert!(
            matches!(disclosure(&program), ScenarioDisclosure::Declined(_)),
            "{:?}",
            disclosure(&program)
        );
    }
}

fn contained_source() -> String {
    SOURCE
        .replace(
            " Customer {active:bool,name:text}",
            " Customer {active:bool,name:text}\n Contact in Customer {title:text}",
        )
        .replace(
            "customer:Customer,alternate:Customer,",
            "customer:Customer,alternate:Customer,contact:Contact,another:Contact,",
        )
        .replace(
            " policy Customer read=members",
            " policy Contact read=members\n policy Customer read=members",
        )
        .replace(
            "require input.customer.active and",
            "require input.contact.parent==input.customer and input.customer.active and",
        )
}

#[test]
fn required_contract_model_parent_keeps_actual_containment_control_and_native_source() {
    for source in [
        contained_source(),
        contained_source()
            .replace("InputMembers", "Renamed")
            .replace("Lead", "Reviewed")
            .replace("input", "payload")
            .replace("contact", "person")
            .replace("customer", "buyer"),
    ] {
        let (db, program) = checked(&source);
        let ScenarioDisclosure::Complete(complete) = disclosure(&program) else {
            panic!("{:?}", disclosure(&program));
        };
        let root = if source.contains("payload:") {
            "payload.person"
        } else {
            "input.contact"
        };
        for returned in &complete.returns {
            let parents: Vec<_> = returned
                .dependencies
                .iter()
                .filter(|read| read.field_name == "parent")
                .collect();
            assert_eq!(parents.len(), 1, "{returned:?}");
            let parent = parents[0];
            assert_eq!(
                parent.model_name,
                if root.starts_with("payload") {
                    "Renamed.Contact"
                } else {
                    "InputMembers.Contact"
                }
            );
            assert_eq!(
                parent.type_id,
                if root.starts_with("payload") {
                    "Renamed.Customer"
                } else {
                    "InputMembers.Customer"
                }
            );
            assert_eq!(parent.role, DependencyRole::Control);
            assert_eq!(text(&db, parent.node), format!("{root}.parent"));
            assert!(parent.calls.is_empty() && parent.query_id.is_none());
        }
        let artifact = native_artifact(&source);
        assert!(
            artifact["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|operation| operation["name"]
                    .as_str()
                    .is_some_and(|name| name.ends_with(".promote"))
                    && operation["result"]["disclosure"]["returns"]
                        .as_array()
                        .is_some_and(|returns| !returns.is_empty()))
        );
    }
}

#[test]
fn contract_parent_source_census_includes_parent_absent_from_parameter_fields() {
    let source = contained_source()
        .replace("customer:Customer,alternate:Customer,", "")
        .replace("input.contact.parent==input.customer and input.customer.active and input.alternate.active", "input.contact.parent==input.another.parent");
    let (_, program) = checked(&source);
    assert!(
        matches!(disclosure(&program), ScenarioDisclosure::Complete(_)),
        "{:?}",
        disclosure(&program)
    );
    let artifact = native_artifact(&source);
    assert!(
        artifact["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["name"] == "InputMembers.Customer")
    );
}

#[test]
fn contract_parent_native_correspondence_refuses_same_typed_slot_and_changed_source() {
    let source = contained_source();
    let (db, program, catalog) = checked_with_catalog(&source);
    let (mut lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    fn substitute(value: &mut ir::TypedExpr) -> bool {
        if let ir::IrExpr::Member { field, .. } = &mut value.expr
            && field == "contact"
        {
            *field = "another".into();
            return true;
        }
        match &mut value.expr {
            ir::IrExpr::Binary { left, right, .. } => substitute(left) || substitute(right),
            ir::IrExpr::Member { base, .. } => substitute(base),
            _ => false,
        }
    }
    let original = lowered.clone();
    let owner = lowered
        .items
        .iter_mut()
        .find(|item| item.canonical == "InputMembers.promote")
        .unwrap();
    let ir::IrItemKind::Scenario { guards, .. } = &mut owner.kind else {
        panic!("scenario");
    };
    let ir::IrStmt::Require { cond, .. } = &mut guards[0] else {
        panic!("guard");
    };
    assert!(substitute(cond), "{cond:?}");
    let output = js::emit_program_with_native_source_receipts(&lowered, true, &db);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{:?}",
        output.diagnostics
    );
    let mut changed = SourceDb::new();
    changed.add(
        "contract-input-members.can".into(),
        source.replace("input.contact.parent", "input.another.parent"),
    );
    let output = js::emit_program_with_native_source_receipts(&original, true, &changed);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008" || diagnostic.code == "E6011"),
        "{:?}",
        output.diagnostics
    );
}

#[test]
fn copied_nullable_and_array_contract_contacts_cannot_acquire_parent_lineage() {
    for source in [
        contained_source().replace("contact:Contact,", "contact:Contact?,").replace("require input.contact.parent", "require input.contact!=null and input.contact.parent"),
        contained_source().replace("contact:Contact,", "contact:Contact[],").replace("  require input.contact.parent==input.customer and input.customer.active and input.alternate.active and input.value.minor>=0 and input.value.currency==input.value.currency\n  do", "  do\n   let copied=first(input.contact)\n   require copied!=null and copied.parent==input.customer"),
        contained_source().replace("  require input.contact.parent==input.customer and input.customer.active and input.alternate.active and input.value.minor>=0 and input.value.currency==input.value.currency\n  do", "  do\n   let copied=input.contact\n   require copied.parent==input.customer"),
    ] {
        let (_, program) = checked(&source);
        assert!(matches!(disclosure(&program), ScenarioDisclosure::Declined(_)), "{:?}", disclosure(&program));
    }
}

#[test]
fn contained_reference_equality_keeps_equivalent_independently_admitted_roots() {
    for source in [
        contained_source()
            .replace("promote(input:Lead)", "promote(input:Lead,other:Lead)")
            .replace(
                "input.contact.parent==input.customer",
                "input.contact.parent==other.customer",
            ),
        contained_source()
            .replace(
                "promote(input:Lead)",
                "promote(input:Lead,customer:Customer)",
            )
            .replace(
                "input.contact.parent==input.customer",
                "input.contact.parent==customer",
            ),
        contained_source()
            .replace("promote(input:Lead)", "promote(input:Lead,contact:Contact)")
            .replace(
                "input.contact.parent==input.customer",
                "contact.parent==input.customer",
            ),
    ] {
        let (_, program) = checked(&source);
        assert!(
            matches!(disclosure(&program), ScenarioDisclosure::Complete(_)),
            "{:?}",
            disclosure(&program)
        );
        let artifact = native_artifact(&source);
        assert!(
            artifact["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|operation| operation["name"] == "InputMembers.promote"
                    && operation["result"]["disclosure"]["returns"]
                        .as_array()
                        .is_some_and(|returns| !returns.is_empty()))
        );
    }
}

#[test]
fn currency_stored_controls_keep_their_declared_type_across_renaming() {
    for field in ["currency", "settlement"] {
        let source = SOURCE
            .replace(
                "Location {title:text}",
                &format!("Location {{title:text,{field}:currency}}"),
            )
            .replace(
                "input.value.currency==input.value.currency",
                &format!("input.value.currency==input.selection.location.{field}"),
            );
        let (_, program) = checked(&source);
        let ScenarioDisclosure::Complete(complete) = disclosure(&program) else {
            panic!("{:?}", disclosure(&program));
        };
        assert!(
            complete
                .returns
                .iter()
                .any(
                    |returned| returned.dependencies.iter().any(|read| read.model_name
                        == "InputMembers.Location"
                        && read.field_name == field
                        && read.type_id == "currency"
                        && read.role == DependencyRole::Control)
                )
        );
        let artifact = native_artifact(&source);
        let location = artifact["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["name"] == "InputMembers.Location")
            .unwrap();
        let declared = location["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|declared| declared["name"] == field)
            .unwrap();
        assert_eq!(declared["field"]["kind"], "string");
        assert_eq!(declared["valueType"], "currency");
    }
}

#[test]
fn currency_parameters_and_contract_members_keep_native_result_and_input_profiles() {
    for (parameter, expression) in [
        ("input:currency", "input"),
        ("input:Requested", "input.currency"),
    ] {
        let source = format!(
            "app CurrencyInput\nGiven\n contract Requested {{currency:currency}}\nWhen\n scenario echo({parameter}) -> currency by=members\n  do\n   return {expression}\nThen\n"
        );
        let artifact = native_artifact(&source);
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == "CurrencyInput.echo")
            .unwrap();
        assert_eq!(operation["result"]["type"], "currency");
        assert!(
            operation["result"]["disclosure"]["returns"]
                .as_array()
                .unwrap()
                .iter()
                .all(|returned| returned["intrinsics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|intrinsic| intrinsic["kind"] == "admitted-input"
                        && intrinsic["type"] == "currency"))
        );
    }
}
