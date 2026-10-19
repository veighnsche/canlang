//! Finite checked source for the original Workbench parent-reference producer.
//! This cohort does not claim admission of the complete draft application.
use canlang_compiler::{
    analysis::{
        CheckedProgram, ResolvedType, Scalar,
        catalog::{Catalog, CatalogRequest, load_catalog},
        check_program,
        scenario_disclosure::{
            CheckedScenarioDisclosure, DependencyRole, DisclosureEffectKind, ScenarioDisclosure,
        },
    },
    codegen::{
        ir::{self, IrExpr, IrItemKind, IrProgram, IrStmt},
        js,
    },
    source::{SourceDb, Span, sha256_hex},
};
use serde_json::Value;
use std::path::Path;

const SOURCE: &str = r#"app StoredReferenceSource uses=[workbench]
package rent_catalog
 Given
  export Location {name:text}
  policy Location read=members
 When
 Then
package todo
 use rent_catalog {Location}
 Given
  export Task {location:Location?,title:text,description:text?,due:datetime?,priority:enum(low,normal,high)=normal,done:bool=false}
  policy Task read=members
 When
 Then
package workbench
 use rent_catalog {Location}
 use todo {Task}
 Given
  contract Scope {targets:Task[]! min=1 max=10}
  contract Fact {task:Task,version:int min=1,title:Task.title max=2000,description:Task.description max=8000,due:Task.due,priority:Task.priority,done:bool}
  Run {location:Location,targets:Scope.targets}
  Step in Run {ordinal:int min=1 max=8}
  policy Run read=members
  policy Step read=members
 When
  scenario context(location:Location,targets:Scope.targets) read=true -> Fact[] by=members
   require count(targets)>0
   do
    let visible=Task as task where task in targets and task.location==location
    require count(visible)==count(targets)
    return visible as task select Fact {task,version=task.version,title=task.title,description=task.description,due=task.due,priority=task.priority,done=task.done}
  scenario parent(step:Step) -> int by=members
   do
    call context {location=step.parent.location,targets=step.parent.targets} as fresh
    require count(fresh)==count(step.parent.targets)
    return 1
 Then
"#;

fn checked(source: &str) -> (SourceDb, CheckedProgram, IrProgram, Option<Catalog>) {
    let mut db = SourceDb::new();
    let file = db.add("stored-reference-source.can".into(), source.into());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, lowered, catalog)
}

fn fact<'a>(program: &'a CheckedProgram, name: &str) -> &'a ScenarioDisclosure {
    let symbol = program
        .symbols
        .iter()
        .find(|item| item.canonical == name)
        .unwrap();
    program.scenario_disclosures().get(&symbol.id).unwrap()
}

fn complete<'a>(program: &'a CheckedProgram, name: &str) -> &'a CheckedScenarioDisclosure {
    match fact(program, name) {
        ScenarioDisclosure::Complete(value) => value,
        other => panic!("{name}: {other:?}"),
    }
}

fn emitted(db: &SourceDb, program: &CheckedProgram, catalog: Option<&Catalog>) -> Value {
    let mut result =
        canlang_compiler::diagnostic::DiagnosticResult::new("stored-reference-source", "1.0", 1);
    result.complete = true;
    let (artifact, diagnostics) = canlang_compiler::codegen::emit(
        program,
        &canlang_compiler::codegen::EmitSources {
            db,
            result: &result,
            catalog,
            options: canlang_compiler::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap()
}

#[test]
fn original_parent_member_operands_keep_checked_whole_reads_and_native_child_receipts() {
    let (db, program, lowered, catalog) = checked(SOURCE);
    let parent = complete(&program, "workbench.parent");
    let child = complete(&program, "workbench.context");
    assert_eq!(parent.effects.len(), 1);
    assert!(matches!(&parent.effects[0].kind,
        DisclosureEffectKind::Call { input_keys, .. }
        if input_keys == &["location".to_string(), "targets".to_string()]));
    assert_eq!(parent.returns.len(), 1);
    let returned = &parent.returns[0];
    assert!(
        returned.influences.is_empty(),
        "child query influences stay in its own receipt"
    );
    for (model, field, type_id, spelling) in [
        ("workbench.Step", "parent", "workbench.Run", "step.parent"),
        (
            "workbench.Run",
            "location",
            "rent_catalog.Location",
            "step.parent.location",
        ),
        (
            "workbench.Run",
            "targets",
            "todo.Task[]",
            "step.parent.targets",
        ),
    ] {
        let dependencies: Vec<_> = returned
            .dependencies
            .iter()
            .filter(|dependency| dependency.model_name == model && dependency.field_name == field)
            .collect();
        assert!(
            !dependencies.is_empty(),
            "missing whole stored {model}.{field}"
        );
        for dependency in dependencies {
            assert_eq!(dependency.type_id, type_id);
            let captured = db.get(dependency.node.file).unwrap();
            assert_eq!(dependency.source.path, captured.path);
            assert_eq!(
                dependency.source.sha256,
                sha256_hex(captured.text.as_bytes())
            );
            assert_eq!(
                &captured.text[dependency.node.start as usize..dependency.node.end as usize],
                spelling
            );
            assert!(dependency.calls.is_empty());
            if field == "targets" {
                assert!(matches!(&dependency.ty,
                    ResolvedType::Array { element, ordered: true, nonempty: false }
                    if matches!(element.as_ref(), ResolvedType::Record { stored: true, .. })));
            }
        }
    }
    assert!(
        returned
            .dependencies
            .iter()
            .any(|dependency| dependency.role == DependencyRole::Control
                && dependency.field_name == "targets")
    );
    assert!(
        returned.intrinsics.is_empty(),
        "parent traversal does not invent an authored version read"
    );
    assert!(
        returned
            .dependencies
            .iter()
            .all(|dependency| dependency.model_name == "workbench.Step"
                || dependency.model_name == "workbench.Run")
    );
    let queries = child
        .source_facts
        .as_ref()
        .unwrap()
        .queries
        .as_ref()
        .unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(child.returns[0].id, queries[0].return_id());
    assert_eq!(child.returns[0].influences, queries[0].influences);
    assert_eq!(child.returns[0].influences.len(), 4);

    let run_targets = lowered
        .items
        .iter()
        .find(|item| item.canonical == "workbench.Run.targets")
        .unwrap();
    let IrItemKind::Field { required_array, .. } = &run_targets.kind else {
        panic!("stored targets");
    };
    assert!(
        !required_array,
        "Scope's field-only ! does not alter borrowed reference operands"
    );
    let child_targets = lowered
        .items
        .iter()
        .find(|item| item.canonical == "workbench.context.targets")
        .unwrap();
    let IrItemKind::Param {
        array_bounds: Some(bounds),
        ..
    } = &child_targets.kind
    else {
        panic!("bounded input");
    };
    assert_eq!((bounds.min, bounds.max), (Some(1), Some(10)));
    for (id, disclosure) in program.scenario_disclosures() {
        assert_eq!(
            format!("{disclosure:?}"),
            format!("{:?}", lowered.scenario_disclosures.get(id).unwrap())
        );
    }
    let artifact = emitted(&db, &program, catalog.as_ref());
    let parent_operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "workbench.parent")
        .unwrap();
    assert_eq!(
        parent_operation["inputs"]["fields"][0]["field"]["model"],
        "workbench.Step"
    );
    assert_eq!(
        parent_operation["inputs"]["fields"][0]["field"]["requireVersion"],
        true
    );
    for name in ["workbench.parent", "workbench.context"] {
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == name)
            .unwrap();
        assert!(
            operation["result"].get("disclosure").is_some(),
            "{name} actual prepared disclosure"
        );
    }
    let modules = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for helper in [
        "observeScenarioReceiptDependency",
        "invokeScenarioReceiptCall",
        "executeScenarioReceiptQuery",
    ] {
        assert!(modules.contains(helper), "native emitter omitted {helper}");
    }
    for dependency in &returned.dependencies {
        assert!(
            modules.contains(&dependency.id),
            "native emitter omitted actual stored read"
        );
    }
    assert!(modules.contains(&queries[0].id));
    assert!(modules.contains(&queries[0].return_id()));
}

fn count_source() -> String {
    SOURCE.replace(
        "    call context {location=step.parent.location,targets=step.parent.targets} as fresh\n    require count(fresh)==count(step.parent.targets)\n    return 1",
        "    require count(step.parent.targets)>0\n    return count(step.parent.targets)",
    )
}

fn native_parent(lowered: &IrProgram, db: &SourceDb) -> bool {
    js::emit_program_with_native_source_receipts(lowered, true, db)
        .operations
        .iter()
        .find(|operation| operation.name == "workbench.parent")
        .unwrap()
        .disclosure
        .is_some()
}

#[test]
fn stored_parent_reference_schema_refuses_changed_owner_field_bounds_and_source() {
    let source = count_source();
    let (db, program, lowered, _) = checked(&source);
    complete(&program, "workbench.parent");
    assert!(
        native_parent(&lowered, &db),
        "genuine finite stored count publishes"
    );
    assert!(
        js::emit_program_with_native_receipts(&lowered, true)
            .operations
            .iter()
            .find(|operation| operation.name == "workbench.parent")
            .unwrap()
            .disclosure
            .is_none(),
        "implicit parent and terminal field need actual schema source"
    );
    let mut stale = SourceDb::new();
    stale.add(
        "stored-reference-source.can".into(),
        format!("{source}\n## stale source\n"),
    );
    assert!(!native_parent(&lowered, &stale));
    for corruption in 0..10 {
        let mut changed = lowered.clone();
        let canonical = match corruption {
            0 | 1 => "workbench.Step",
            2..=5 => "workbench.Run.targets",
            6..=8 => "workbench.Scope.targets",
            _ => "workbench.Run",
        };
        let item = changed
            .items
            .iter_mut()
            .find(|item| item.canonical == canonical)
            .unwrap();
        match corruption {
            0 => {
                let IrItemKind::Model { owner, .. } = &mut item.kind else {
                    panic!("child model");
                };
                *owner = ir::IrOwner::Team;
            }
            1 => item.canonical = "workbench.OtherStep".into(),
            9 => {
                let IrItemKind::Model { owner, .. } = &mut item.kind else {
                    panic!("root owner");
                };
                *owner = ir::IrOwner::App;
            }
            2..=5 => {
                let IrItemKind::Field {
                    owner,
                    ty,
                    required_array,
                    modifiers,
                    ..
                } = &mut item.kind
                else {
                    panic!("stored field");
                };
                match corruption {
                    2 => *ty = ir::IrType::Known(ResolvedType::Scalar(Scalar::Bool)),
                    3 => *required_array = !*required_array,
                    4 => *owner = item.id,
                    5 => modifiers.trim = !modifiers.trim,
                    _ => unreachable!(),
                }
            }
            6..=8 => {
                let IrItemKind::Field {
                    ty,
                    required_array,
                    modifiers,
                    ..
                } = &mut item.kind
                else {
                    panic!("owning Scope field");
                };
                match corruption {
                    6 => modifiers.min.as_mut().unwrap().expr = IrExpr::Int(0),
                    7 => modifiers.max.as_mut().unwrap().expr = IrExpr::Int(11),
                    8 => {
                        *required_array = false;
                        *ty = ir::IrType::Known(ResolvedType::Scalar(Scalar::Bool));
                    }
                    _ => unreachable!(),
                }
            }
            _ => unreachable!(),
        }
        assert!(
            !native_parent(&changed, &db),
            "forged parent/schema {corruption}: {canonical}"
        );
    }
    let parent = lowered
        .items
        .iter()
        .find(|item| item.canonical == "workbench.parent")
        .unwrap()
        .id;
    for corruption in 0..5 {
        let mut changed = lowered.clone();
        let IrItemKind::Scenario { effects, .. } = &mut changed.items[parent.0 as usize].kind
        else {
            panic!("parent");
        };
        let IrStmt::Require { cond, .. } = &mut effects[0] else {
            panic!("stored count guard");
        };
        let IrExpr::Binary { left, .. } = &mut cond.expr else {
            panic!("positive count");
        };
        let IrExpr::Call { args, .. } = &mut left.expr else {
            panic!("count");
        };
        let IrExpr::Member { base, field } = &mut args[0].expr else {
            panic!("terminal targets");
        };
        match corruption {
            0 => *field = "location".into(),
            1 => base.expr = IrExpr::Name("copied".into()),
            2 => base.ty = ResolvedType::Nullable(Box::new(base.ty.clone())),
            3 => {
                base.ty = ResolvedType::Array {
                    element: Box::new(base.ty.clone()),
                    ordered: true,
                    nonempty: false,
                }
            }
            4 => {
                let IrExpr::Member { base, .. } = &mut base.expr else {
                    panic!("implicit parent");
                };
                base.expr = IrExpr::Name("foreign".into());
            }
            _ => unreachable!(),
        }
        assert!(
            !native_parent(&changed, &db),
            "forged member origin {corruption}"
        );
    }
}

#[test]
fn parent_query_call_refuses_copied_inputs_and_reference_dereference() {
    let cases = [
        SOURCE
            .replace("    call context", "    let copied=step\n    call context")
            .replace(
                "location=step.parent.location",
                "location=copied.parent.location",
            ),
        SOURCE
            .replace(
                "    call context",
                "    let copied=step.parent\n    call context",
            )
            .replace("location=step.parent.location", "location=copied.location"),
        SOURCE
            .replace(
                "    call context",
                "    let copied=step.parent.targets\n    call context",
            )
            .replace("targets=step.parent.targets", "targets=copied"),
        SOURCE.replace(
            "    return 1",
            "    require step.parent.location.name==\"Site\"\n    return 1",
        ),
        SOURCE.replace("min=1 max=10}", "min=0 max=10}"),
        SOURCE.replace("targets:Scope.targets}", "targets:Task[]}"),
    ];
    for (index, source) in cases.iter().enumerate() {
        let (_, program, _, _) = checked(source);
        if index < 4 {
            complete(&program, "workbench.context");
        }
        assert!(
            matches!(
                fact(&program, "workbench.parent"),
                ScenarioDisclosure::Declined(_)
            ),
            "unsupported parent origin {index} was broadly admitted: {source}"
        );
    }
}
