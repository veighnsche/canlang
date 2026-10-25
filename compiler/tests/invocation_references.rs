//! Generated complete invocation construction uses the existing public Values contracts.
#![cfg(unix)]
use canlang_compiler::{
    analysis::{
        catalog::{CatalogRequest, load_catalog},
        check_program,
        types::{ResolvedType, Scalar},
    },
    codegen::ir::{self, IrEffectCallTarget, IrExpr, IrItemKind, IrStmt, IrType},
    source::{SourceDb, Span},
};
use std::path::{Path, PathBuf};
use std::process::Command;

const STATEMENT_CALLS: &str = r#"app CallFacts
Given
 Item {title:text}
 Proposal {call:invocation(Item.update,empty)?}
 policy Item read=members
 policy Proposal read=members
When
 crud Item by=members fields=title
 scenario context(value:int,note:text) read=true -> int by=members
  do return value
 scenario scalar(value:int) -> int by=members
  do return value
 scenario empty() by=members
  do require true
 scenario caller(proposal:Proposal,descriptor:invocation(scalar),value:int,note:text) -> int by=members
  require proposal.call!=null
  do
   call context {note="Authored first",value} as fresh
   let retained=fresh
   call proposal.call {}
   call descriptor {} as computed
   call empty {}
   return computed
 scenario void_caller(descriptor:invocation(empty)) by=members
  do call descriptor {}
Then
"#;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

#[test]
fn checked_read_query_and_bound_composite_call_join_without_native_admission() {
    use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
    use canlang_compiler::codegen::{js, scenario_calls::collect_scenario_source_calls};
    let source = r#"app SourceCalls
Given
 Location {name:text}
 Task {location:Location,title:text,done:bool=false}
 policy Location read=members
 policy Task read=members
 contract Scope {targets:Task[]! min=1 max=10}
 contract Fact {task:Task,version:int,title:Task.title,done:bool}
When
 scenario context(location:Location,targets:Scope.targets) read=true -> Fact[] by=members
  do
   let visible=Task as task where task in targets and task.location==location
   require count(visible)==count(targets)
   return visible as task select Fact {task,version=task.version,title=task.title,done=task.done}
 scenario caller(location:Location,targets:Scope.targets) -> int by=members
  do
   call context {location,targets} as facts
   call context {location,targets} as fresh
   return count(facts)
Then
"#;
    let mut db = SourceDb::new();
    let file = db.add("source-calls.can".into(), source.into());
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let context = lowered
        .items
        .iter()
        .find(|item| item.canonical == "SourceCalls.context")
        .unwrap();
    let parent = lowered
        .items
        .iter()
        .find(|item| item.canonical == "SourceCalls.caller")
        .unwrap();
    for item in [context, parent] {
        let fact = &lowered.scenario_disclosures[&item.id];
        assert!(
            matches!(fact, ScenarioDisclosure::Complete(_)),
            "{}: {fact:?}",
            item.canonical
        );
        let origin = fact
            .source_facts()
            .expect("checked source survives unsupported native closure");
        assert_eq!(origin.source.path, "source-calls.can");
        assert_eq!(origin.scenario, item.id);
    }
    let IrItemKind::Scenario { effects, .. } = &context.kind else {
        panic!()
    };
    let IrStmt::Let { value, .. } = &effects[0] else {
        panic!()
    };
    let IrExpr::Query(query) = &value.expr else {
        panic!()
    };
    let fact = query.source.as_ref().expect("real checked model query");
    assert_eq!(
        (fact.node.file, fact.node.start, fact.node.end),
        (value.span.file, value.span.start, value.span.end)
    );
    assert_eq!(fact.domain_type, checked.types.node_types[&fact.domain]);
    assert!(query.where_pred.is_some());
    let IrStmt::Return {
        value: Some(value), ..
    } = &effects[2]
    else {
        panic!()
    };
    let IrExpr::Query(projection) = &value.expr else {
        panic!()
    };
    let projection_fact = projection.source.as_ref().unwrap();
    let row_projection = projection_fact.projection.as_ref().unwrap();
    assert_eq!(row_projection.fields.len(), 4);
    let projected = projection.select.as_ref().unwrap();
    let IrExpr::Object(fields) = &projected.expr else {
        panic!("{projected:?}")
    };
    assert!(matches!(
        &fields[0].1.ty,
        ResolvedType::Record { stored: true, .. }
    ));
    assert!(matches!(&fields[1].1.expr, IrExpr::Member {field,..} if field=="version"));
    // Attribution must join the real lowered object, never merely travel with
    // a checked-query-shaped value. Each altered owning/source fact refuses.
    for mode in 0..9 {
        use canlang_compiler::analysis::types::CheckedQueryProjectionMapping as Mapping;
        let (mut altered, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{mode}: {diagnostics:?}");
        let proof = altered
            .types
            .checked_queries
            .get_mut(&projection_fact.node)
            .unwrap()
            .projection
            .as_mut()
            .unwrap();
        match mode {
            0 => proof.contract = proof.model,
            1 => proof.model = proof.contract,
            2 => proof.alias = fact.clauses[0].node,
            3 => proof.fields[0].node = proof.fields[1].node,
            4 => proof.fields[1].mapping = Mapping::StoredReference,
            5 => {
                proof.fields[2].mapping = Mapping::DirectField {
                    field: proof.fields[3].field,
                }
            }
            6 => proof.fields.swap(2, 3),
            7 => {
                proof.fields.pop();
            }
            8 => proof.fields[0].ty = ResolvedType::Scalar(Scalar::Bool),
            _ => unreachable!(),
        }
        let (altered, diagnostics) = ir::build(&altered, &db, catalog.as_ref());
        assert!(diagnostics.is_empty(), "{mode}: {diagnostics:?}");
        let IrItemKind::Scenario { effects, .. } = &altered.items[context.id.0 as usize].kind
        else {
            panic!()
        };
        let IrStmt::Return {
            value: Some(value), ..
        } = &effects[2]
        else {
            panic!()
        };
        assert!(
            matches!(value.expr, IrExpr::Unsupported { .. }),
            "{mode}: {value:?}"
        );
    }
    let emitted = js::emit_program_with_native_source_receipts(&lowered, true, &db);
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
    );
    assert!(
        emitted
            .operations
            .iter()
            .filter(|operation| operation.name == context.canonical
                || operation.name == parent.canonical)
            .all(|operation| operation.disclosure.is_none())
    );
    let sites = collect_scenario_source_calls(&lowered, parent, &db).unwrap();
    assert_eq!(sites.len(), 2);
    assert_eq!(sites[0].target, "SourceCalls.context");
    assert!(sites[0].read);
    assert_eq!(sites[0].binding.as_deref(), Some("facts"));
    assert_eq!(
        sites[0].result,
        lowered.scenario_disclosures[&context.id]
            .source_facts()
            .unwrap()
            .result
    );
    assert_eq!(
        sites[0]
            .inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["location", "targets"]
    );
    for tamper in 0..4 {
        let mut altered = lowered.clone();
        let ScenarioDisclosure::Complete(fact) =
            altered.scenario_disclosures.get_mut(&parent.id).unwrap()
        else {
            panic!()
        };
        let proof = fact.source_facts.as_mut().unwrap();
        match tamper {
            0 => proof.calls[0].binding = Some("fresh".into()),
            1 => proof.calls[0].inputs.reverse(),
            2 => proof.source.sha256 = "0".repeat(64),
            _ => proof.calls.push(proof.calls[0].clone()),
        }
        assert!(
            collect_scenario_source_calls(&altered, &altered.items[parent.id.0 as usize], &db)
                .is_none()
        );
    }
    let mut reordered = lowered.clone();
    let IrItemKind::Scenario { effects, .. } = &mut reordered.items[parent.id.0 as usize].kind
    else {
        panic!()
    };
    effects.swap(0, 1);
    assert!(
        collect_scenario_source_calls(&reordered, &reordered.items[parent.id.0 as usize], &db)
            .is_none()
    );
    let mut altered = checked;
    altered
        .types
        .checked_queries
        .get_mut(&fact.node)
        .unwrap()
        .clauses
        .reverse();
    let (altered, diagnostics) = ir::build(&altered, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let IrItemKind::Scenario { effects, .. } = &altered.items[context.id.0 as usize].kind else {
        panic!()
    };
    let IrStmt::Let { value, .. } = &effects[0] else {
        panic!()
    };
    assert!(matches!(value.expr, IrExpr::Unsupported { .. }));
}
fn compile(dir: &Path, name: &str, source: &str) -> std::process::Output {
    compile_with_receipts(dir, name, source, false)
}
fn compile_with_receipts(
    dir: &Path,
    name: &str,
    source: &str,
    native: bool,
) -> std::process::Output {
    let path = dir.join(format!("{name}.can"));
    std::fs::write(&path, source).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
    command.args(["compile", "--format=json"]);
    if native {
        command.arg("--native-scenario-receipts");
    }
    command
        .arg("--catalog")
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(path)
        .current_dir(root())
        .output()
        .unwrap()
}
fn decoded(output: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&output.stderr)))
}
#[test]
fn generated_invocations_execute_and_enter_existing_values_codecs() {
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let output = compile(
        scratch.path(),
        "invocations",
        include_str!("fixtures/invocation-references/source.can"),
    );
    assert!(output.status.success(), "{}", decoded(&output));
    std::fs::write(scratch.path().join("artifact.json"), output.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        include_str!("fixtures/invocation-references/execute.mjs"),
    )
    .unwrap();
    let result = Command::new("node")
        .arg(runner)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&result.stdout));
}

#[test]
fn invocation_target_alias_uses_owner_identity() {
    let scratch = tempfile::tempdir().unwrap();
    let source = "package work\n Given\n When\n  export scenario mutate(value:int) by=members\n   do\n    let copy = value\n Then\napp Client\nuse work {mutate as execute}\nGiven\nWhen\n scenario descriptor() read=true -> invocation(execute) by=members\n  do\n   return invocation(execute,{value=4})\nThen\n";
    let output = compile(scratch.path(), "alias", source);
    assert!(output.status.success(), "{}", decoded(&output));
    let artifact = decoded(&output);
    let emitted = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(emitted.contains("invocation(work.mutate)"), "{emitted}");
    assert!(emitted.contains("\"work.mutate\""), "{emitted}");
    assert!(!emitted.contains("invocation(Client.execute)"));
}

#[test]
fn statement_call_ir_retains_checked_operands_declarations_inputs_and_results() {
    let mut db = SourceDb::new();
    let file = db.add("statement-calls.can".into(), STATEMENT_CALLS.into());
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let root_path = root();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root_path,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = |name: &str| {
        ir.items
            .iter()
            .find(|item| item.canonical == format!("CallFacts.{name}"))
            .unwrap()
    };
    let caller = owner("caller");
    let IrItemKind::Scenario { effects, .. } = &caller.kind else {
        panic!("scenario owner")
    };
    let calls: Vec<_> = effects
        .iter()
        .filter_map(|statement| match statement {
            IrStmt::Call {
                target,
                inputs,
                binding,
                result,
                span,
            } => Some((target, inputs, binding, result, span)),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 4);
    let (target, inputs, binding, result, span) = calls[0];
    let context = owner("context");
    assert!(
        matches!(target, IrEffectCallTarget::Operation {operation, ..} if *operation == context.id)
    );
    assert_eq!(target.operations(), [context.id]);
    assert!(target.operand().is_none());
    let IrEffectCallTarget::Operation { source, .. } = target else {
        panic!("static declaration target")
    };
    assert_eq!(source.file, file);
    assert_eq!(
        STATEMENT_CALLS[source.start as usize..source.end as usize].trim(),
        "context"
    );
    assert_eq!(binding.as_deref(), Some("fresh"));
    assert_eq!(*result, Some(ResolvedType::Scalar(Scalar::Int)));
    assert!(STATEMENT_CALLS[span.start as usize..span.end as usize].contains("call context"));
    let IrExpr::Object(entries) = &inputs.expr else {
        panic!("ordered authored input object")
    };
    assert_eq!(
        entries
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["note", "value"]
    );
    assert_eq!(entries[0].1.ty, ResolvedType::Scalar(Scalar::Text));
    assert_eq!(entries[1].1.ty, ResolvedType::Scalar(Scalar::Int));
    assert!(matches!(&entries[1].1.expr, IrExpr::Name(name) if name == "value"));
    for (_, value) in entries {
        assert_eq!(value.span.file, file);
        assert!(value.span.start < value.span.end);
    }
    assert_eq!(
        &STATEMENT_CALLS[entries[1].1.span.start as usize..entries[1].1.span.end as usize],
        "value"
    );
    assert!(effects.iter().any(|statement| matches!(statement, IrStmt::Let{name,value,..} if name=="retained" && value.ty==ResolvedType::Scalar(Scalar::Int) && matches!(&value.expr,IrExpr::Name(name) if name=="fresh"))));
    let IrItemKind::Scenario {
        params,
        result,
        read,
        ..
    } = &context.kind
    else {
        panic!("context declaration")
    };
    assert!(*read);
    assert_eq!(*result, Some(ResolvedType::Scalar(Scalar::Int)));
    assert_eq!(params.len(), 2);
    for (index, expected) in [Scalar::Int, Scalar::Text].iter().enumerate() {
        assert!(
            matches!(&ir.items[params[index].0 as usize].kind, IrItemKind::Param{owner,index:slot,ty:IrType::Known(ResolvedType::Scalar(actual)),..} if *owner==context.id && *slot==index && actual==expected)
        );
    }
    let (dynamic, inputs, binding, result, _) = calls[1];
    let update = owner("Item.update");
    let empty = owner("empty");
    assert!(matches!(dynamic, IrEffectCallTarget::Invocation { .. }));
    assert_eq!(dynamic.operations(), [update.id, empty.id]);
    assert_eq!(
        dynamic.operand().unwrap().ty,
        ResolvedType::Invocation {
            targets: vec![update.id, empty.id]
        }
    );
    assert!(
        matches!(&dynamic.operand().unwrap().expr, IrExpr::Member{base,field} if field=="call" && matches!(&base.expr,IrExpr::Name(name) if name=="proposal"))
    );
    let operand = dynamic.operand().unwrap().span;
    assert_eq!(
        STATEMENT_CALLS[operand.start as usize..operand.end as usize].trim(),
        "proposal.call"
    );
    assert!(matches!(&inputs.expr, IrExpr::Object(entries) if entries.is_empty()));
    assert!(binding.is_none());
    assert!(matches!(result, Some(ResolvedType::Opaque(_))));
    let IrItemKind::CrudOp { model, fields, .. } = &update.kind else {
        panic!("generated CRUD declaration")
    };
    assert_eq!(*model, owner("Item").id);
    assert_eq!(fields, &["title"]);
    let IrItemKind::Model { fields, .. } = &ir.items[model.0 as usize].kind else {
        panic!("model owner")
    };
    assert_eq!(fields.len(), 1);
    assert!(
        matches!(&ir.items[fields[0].0 as usize].kind, IrItemKind::Field{owner,ty:IrType::Known(ResolvedType::Scalar(Scalar::Text)),..} if owner==model)
    );
    assert_eq!(calls[2].0.operations(), [owner("scalar").id]);
    assert!(matches!(calls[2].0, IrEffectCallTarget::Invocation { .. }));
    assert_eq!(calls[2].2.as_deref(), Some("computed"));
    assert_eq!(*calls[2].3, Some(ResolvedType::Scalar(Scalar::Int)));
    assert_eq!(calls[3].0.operations(), [empty.id]);
    assert!(calls[3].3.is_none());
    let IrItemKind::Scenario { effects, .. } = &owner("void_caller").kind else {
        panic!("void declaration")
    };
    assert!(
        matches!(&effects[0], IrStmt::Call{target:IrEffectCallTarget::Invocation{targets,..},result:None,binding:None,..} if targets==&[empty.id])
    );
    let scenario = checked.effects.scenarios.get(&caller.id).unwrap();
    let actual_targets: Vec<_> = scenario
        .effects
        .iter()
        .filter_map(|effect| effect.target_node.map(|node| (effect, node)))
        .collect();
    assert_eq!(actual_targets.len(), calls.len());
    for ((effect, node), (target, _, _, result, _)) in actual_targets.iter().zip(&calls) {
        assert_eq!(
            checked.types.effect_call_results.get(&effect.node),
            Some(*result)
        );
        let source = match target {
            IrEffectCallTarget::Operation { source, .. } => *source,
            _ => target.operand().unwrap().span,
        };
        assert_eq!(node.file, source.file);
        assert_eq!((node.start, node.end), (source.start, source.end));
    }
}

#[test]
fn mutation_call_invalidates_nullable_member_proof_before_dynamic_invocation() {
    let source = STATEMENT_CALLS.replace(
        "context(value:int,note:text) read=true",
        "context(value:int,note:text)",
    );
    let mut db = SourceDb::new();
    let file = db.add("mutation-call-control.can".into(), source.clone());
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let root_path = root();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root_path,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (_, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3009"
                && diagnostic.primary.file == file
                && source[diagnostic.primary.start as usize..diagnostic.primary.end as usize]
                    .trim()
                    == "proposal.call"),
        "a potentially mutating call must invalidate the nullable member proof: {diagnostics:?}"
    );
}

#[test]
fn unprepared_statement_calls_refuse_publication_in_both_emission_modes() {
    let scratch = tempfile::tempdir().unwrap();
    for native in [false, true] {
        let output =
            compile_with_receipts(scratch.path(), "statement-calls", STATEMENT_CALLS, native);
        assert!(!output.status.success());
        let value = decoded(&output);
        assert!(value.get("modules").is_none(), "{value}");
        assert!(
            value["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E6008"
                    && diagnostic["message"].as_str().is_some_and(|message| message
                        .contains("canonical cross-operation invocation of CallFacts.context"))),
            "{value}"
        );
        assert!(
            value["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .all(|diagnostic| diagnostic["code"] != "E6006"),
            "checked target/value facts must not leave generic decode gaps: {value}"
        );
    }
}

#[test]
fn static_mutation_call_sites_join_real_emitted_interfaces_and_refuse_tampering() {
    use canlang_compiler::codegen::{
        js,
        scenario_calls::{CallResultFact, collect_static_scenario_calls},
    };
    let source = "app CallProfile\nGiven\nWhen\n scenario child(value:int,note:text) -> int by=members\n  do return value\n scenario finish() by=members\n  do require true\n scenario parent(value:int) -> int by=members\n  do\n   call child {note=\"first\",value}\n   call finish {}\n   return 1\nThen\n";
    let mut db = SourceDb::new();
    let file = db.add("static-call-profile.can".into(), source.into());
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let root_path = root();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root_path,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        emitted.diagnostics.is_empty(),
        "exact native static profile: {:?}",
        emitted.diagnostics
    );
    let cli_dir = tempfile::tempdir().unwrap();
    let assert_refused =
        |name: &str, source: &str| {
            let output = compile_with_receipts(cli_dir.path(), name, source, true);
            let value = decoded(&output);
            assert!(!output.status.success(), "{name}: {value}");
            assert!(value.get("modules").is_none(), "{name}: {value}");
            assert!(
                value["diagnostics"].as_array().unwrap().iter().any(
                    |diagnostic| diagnostic["code"] == "E6008"
                        && diagnostic["message"].as_str().is_some_and(
                            |message| message.contains("canonical cross-operation invocation")
                        )
                ),
                "{name}: {value}"
            );
        };
    let generic = compile(cli_dir.path(), "static-generic", source);
    assert!(!generic.status.success());
    assert!(decoded(&generic).get("modules").is_none());
    assert!(
        decoded(&generic)["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008")
    );
    for (name, refused) in [
        (
            "read-child",
            source.replace(
                "child(value:int,note:text) -> int",
                "child(value:int,note:text) read=true -> int",
            ),
        ),
        (
            "bound-child",
            source.replace(
                "call child {note=\"first\",value}",
                "call child {note=\"first\",value} as ignored",
            ),
        ),
        (
            "omitted-default-child",
            source
                .replace("child(value:int,note:text)", "child(value:int=1,note:text)")
                .replace(
                    "call child {note=\"first\",value}",
                    "call child {note=\"first\"}",
                ),
        ),
        (
            "array-child",
            source
                .replace(
                    "child(value:int,note:text) -> int",
                    "child(value:int,note:text) -> int[]",
                )
                .replace("do return value", "do return [value]"),
        ),
    ] {
        assert_refused(name, &refused);
    }
    let native = compile_with_receipts(cli_dir.path(), "static-native", source, true);
    assert!(native.status.success(), "{}", decoded(&native));
    let artifact = decoded(&native);
    let native_js = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        native_js
            .matches("await invokeScenarioReceiptCall(c,")
            .count(),
        2
    );
    assert!(
        native_js.contains("callSites:")
            && native_js.contains("\"targets\":[\"CallProfile.child\"]"),
        "{native_js}"
    );
    for name in [
        "CallProfile.parent",
        "CallProfile.child",
        "CallProfile.finish",
    ] {
        assert!(
            emitted
                .operations
                .iter()
                .find(|op| op.name == name)
                .unwrap()
                .disclosure
                .is_some(),
            "bounded parent and children retain prepared disclosure: {name}"
        );
    }
    let parent = ir
        .items
        .iter()
        .find(|item| item.canonical == "CallProfile.parent")
        .unwrap();
    let without_source = js::emit_program_with_native_receipts(&ir, true);
    assert!(
        without_source
            .operations
            .iter()
            .find(|op| op.name == "CallProfile.parent")
            .unwrap()
            .disclosure
            .is_none(),
        "no checked source database means no prepared call parent"
    );
    let sites =
        collect_static_scenario_calls(&ir, parent, &emitted.operations, &db, &emitted.entry.path)
            .expect("exact static mutation profile");
    assert_eq!(sites.len(), 2);
    assert_eq!(sites[0].parent, "CallProfile.parent");
    assert_eq!(sites[0].target, "CallProfile.child");
    assert_eq!(
        sites[0]
            .inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["note", "value"]
    );
    assert_eq!(sites[0].inputs[0].ty, ResolvedType::Scalar(Scalar::Text));
    assert_eq!(sites[0].inputs[1].ty, ResolvedType::Scalar(Scalar::Int));
    assert_eq!(
        source[sites[0].inputs[1].source.start as usize..sites[0].inputs[1].source.end as usize]
            .trim(),
        "value"
    );
    assert_eq!(
        sites[0].result,
        CallResultFact::Scalar(ResolvedType::Scalar(Scalar::Int))
    );
    assert_eq!(sites[1].result, CallResultFact::Void);
    assert_eq!(sites[0].source.path, "static-call-profile.can");
    assert_eq!(sites[0].source.sha256, db.get(file).unwrap().sha256);
    assert_eq!(sites[0].source.module, emitted.entry.path);
    assert_ne!(sites[0].id, sites[1].id);
    let again =
        collect_static_scenario_calls(&ir, parent, &emitted.operations, &db, &emitted.entry.path)
            .unwrap();
    assert_eq!(sites[0].id, again[0].id);
    let module_dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        module_dir.path().join("node_modules"),
    )
    .unwrap();
    std::fs::write(module_dir.path().join("positive.mjs"), &emitted.entry.js).unwrap();
    std::fs::write(
        module_dir.path().join("no-source.mjs"),
        &without_source.entry.js,
    )
    .unwrap();
    let expected: Vec<_> = sites.iter().map(|site|serde_json::json!({
        "id":site.id,"source":{"path":site.source.path,"sha256":site.source.sha256,"module":site.source.module},
        "kind":"operation","targets":[site.target],"resultType":site.interface.result,
    })).collect();
    std::fs::write(
        module_dir.path().join("expected.json"),
        serde_json::to_vec(&expected).unwrap(),
    )
    .unwrap();
    assert_eq!(
        sites[0].interface.to_json(),
        emitted
            .operations
            .iter()
            .find(|op| op.name == sites[0].target)
            .unwrap()
            .to_json()
    );
    let mut missing = emitted.operations.clone();
    missing.retain(|op| op.name != "CallProfile.child");
    assert!(
        collect_static_scenario_calls(&ir, parent, &missing, &db, &emitted.entry.path).is_none()
    );
    let mut skewed = emitted.operations.clone();
    skewed
        .iter_mut()
        .find(|op| op.name == "CallProfile.child")
        .unwrap()
        .result = Some("text".into());
    assert!(
        collect_static_scenario_calls(&ir, parent, &skewed, &db, &emitted.entry.path).is_none()
    );
    let mut foreign = SourceDb::new();
    foreign.add(
        "static-call-profile.can".into(),
        source.replace("first", "changed"),
    );
    assert!(
        collect_static_scenario_calls(
            &ir,
            parent,
            &emitted.operations,
            &foreign,
            &emitted.entry.path
        )
        .is_none()
    );
    for corruption in ["target", "input", "duplicate"] {
        let mut skewed = ir.clone();
        let finish = skewed
            .items
            .iter()
            .find(|item| item.canonical == "CallProfile.finish")
            .unwrap()
            .id;
        let IrItemKind::Scenario { effects, .. } = &mut skewed.items[parent.id.0 as usize].kind
        else {
            panic!("parent")
        };
        if corruption == "duplicate" {
            // Counts still match, but the second source occurrence was
            // omitted and the first proof cannot certify two actual calls.
            effects[1] = effects[0].clone();
        } else {
            let IrStmt::Call { target, inputs, .. } = &mut effects[0] else {
                panic!("call")
            };
            if corruption == "target" {
                let IrEffectCallTarget::Operation { operation, .. } = target else {
                    panic!("static")
                };
                *operation = finish;
            } else {
                let IrExpr::Object(entries) = &mut inputs.expr else {
                    panic!("input object")
                };
                entries.reverse();
            }
        }
        let refused = js::emit_program_with_native_source_receipts(&skewed, true, &db);
        std::fs::write(
            module_dir.path().join(format!("{corruption}-skew.mjs")),
            &refused.entry.js,
        )
        .unwrap();
        assert!(
            refused
                .operations
                .iter()
                .find(|op| op.name == "CallProfile.parent")
                .unwrap()
                .disclosure
                .is_none(),
            "unmatched target/input proof refuses prepared parent"
        );
        assert!(
            collect_static_scenario_calls(
                &skewed,
                &skewed.items[parent.id.0 as usize],
                &emitted.operations,
                &db,
                &emitted.entry.path
            )
            .is_none()
        );
    }
    // Root depth is zero: sixteen real child edges are supported, while
    // the next edge exceeds the shared source/State call-depth boundary.
    for edges in [16, 17] {
        let mut source = String::from("app CallDepth\nGiven\nWhen\n");
        for depth in 0..edges {
            source.push_str(&format!(
                " scenario step{depth}() by=members\n  do call step{} {{}}\n",
                depth + 1
            ));
        }
        source.push_str(&format!(
            " scenario step{edges}() by=members\n  do require true\nThen\n"
        ));
        let mut db = SourceDb::new();
        let file = db.add(format!("call-depth-{edges}.can"), source.clone());
        let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        let parent = ir
            .items
            .iter()
            .find(|item| item.canonical == "CallDepth.step0")
            .unwrap();
        let sites = collect_static_scenario_calls(
            &ir,
            parent,
            &emitted.operations,
            &db,
            &emitted.entry.path,
        );
        assert_eq!(
            sites.is_some(),
            edges == 16,
            "root-excluded child depth {edges}"
        );
        let disclosure = emitted
            .operations
            .iter()
            .find(|op| op.name == parent.canonical)
            .unwrap()
            .disclosure
            .as_ref();
        assert_eq!(
            disclosure.is_some(),
            edges == 16,
            "prepared parent depth {edges}"
        );
        if edges == 16 {
            assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
            let output = compile_with_receipts(cli_dir.path(), "depth-16", &source, true);
            assert!(output.status.success(), "{}", decoded(&output));
        } else {
            assert_refused("depth-17", &source);
            assert!(
                emitted
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "E6008")
            );
        }
        if let Some(sites) = sites {
            assert_eq!(sites.len(), 1);
            assert_eq!(sites[0].target, "CallDepth.step1");
            assert_eq!(sites[0].source.path, "call-depth-16.can");
            assert_eq!(sites[0].source.sha256, db.get(file).unwrap().sha256);
            assert_eq!(sites[0].source.module, emitted.entry.path);
            std::fs::write(module_dir.path().join("depth-expected.json"), serde_json::to_vec(&serde_json::json!({
                "id":sites[0].id,"source":{"path":sites[0].source.path,"sha256":sites[0].source.sha256,"module":sites[0].source.module},
                "kind":"operation","targets":[sites[0].target],"resultType":sites[0].interface.result
            })).unwrap()).unwrap();
        }
        std::fs::write(
            module_dir.path().join(format!("depth-{edges}.mjs")),
            &emitted.entry.js,
        )
        .unwrap();
    }
    // Standalone and statically checked nested SEND retain their original
    // native receipt and exact cross-operation interface.
    let framework_source = "app CallFramework\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\nWhen\n scenario child() by=members\n  do send LLM.cancel {revision=1,source=\"fixed\"} as stop\n scenario parent() by=members\n  do call child {}\nThen\n";
    let nested_framework =
        compile_with_receipts(cli_dir.path(), "framework-child", framework_source, true);
    assert!(
        nested_framework.status.success(),
        "{}",
        String::from_utf8_lossy(&nested_framework.stdout)
    );
    let nested_framework = decoded(&nested_framework);
    assert_eq!(nested_framework["operations"].as_array().unwrap().len(), 2);
    let mut framework_db = SourceDb::new();
    let framework_file = framework_db.add("call-framework.can".into(), framework_source.into());
    let (checked, diagnostics) = check_program(&framework_db, &[framework_file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (framework_ir, diagnostics) = ir::build(&checked, &framework_db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let framework =
        js::emit_program_with_native_source_receipts(&framework_ir, true, &framework_db);
    for (name, admitted) in [
        ("CallFramework.child", true),
        ("CallFramework.parent", false),
    ] {
        let owner = framework_ir
            .items
            .iter()
            .find(|item| item.canonical == name)
            .unwrap();
        assert_eq!(
            collect_static_scenario_calls(
                &framework_ir,
                owner,
                &framework.operations,
                &framework_db,
                &framework.entry.path
            )
            .is_some(),
            admitted,
            "standalone versus nested Send profile: {name}"
        );
        assert!(
            framework
                .operations
                .iter()
                .find(|op| op.name == name)
                .unwrap()
                .disclosure
                .is_some(),
            "source-sealed receipt descriptor: {name}"
        );
    }
    assert!(
        framework.diagnostics.is_empty(),
        "{:?}",
        framework.diagnostics
    );
    std::fs::write(module_dir.path().join("framework.mjs"), &framework.entry.js).unwrap();
    for package in &framework.packages {
        std::fs::write(module_dir.path().join(&package.path), &package.js).unwrap();
    }
    let runner = r#"import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
// The real native host maps this emitted specifier to its public facade.
// Preserve generated module bytes; neither this loader nor the test executes handlers.
registerHooks({resolve(specifier,context,next){return specifier==='@canlang/stdlib'
 ?{url:pathToFileURL(process.argv[2]).href,shortCircuit:true}:next(specifier,context);}});
const expected=JSON.parse(readFileSync(new URL('./expected.json',import.meta.url),'utf8'));
const positive=await import('./positive.mjs');
const carrier=positive.appDefinition.operations['CallProfile.parent'].callSites;
assert.deepEqual(carrier,expected,'actual emitted registry retains checked call order and identity');
const owning=positive.canApp().operations;
const parent=owning.find(op=>op.name==='CallProfile.parent');
const body=positive.canApp()['CallProfile.parent'].toString();
assert.equal((body.match(/await invokeScenarioReceiptCall\(c,/g)||[]).length,2,'prepared static occurrences each await one real facade call');
assert.equal((body.match(/note:"first",value:/g)||[]).length,1,'authored object retains note then shorthand value exactly once');
assert.equal((body.match(/"first"/g)||[]).length,1,'literal argument is not reconstructed or reevaluated');
let previous=-1;
for(const site of carrier){
 const occurrence=`await invokeScenarioReceiptCall(c,${JSON.stringify(site.id)},${JSON.stringify(site.targets[0])},`;
 const at=body.indexOf(occurrence);assert.ok(at>previous,'real body and metadata retain checked source call order');
 assert.equal(body.indexOf(occurrence,at+1),-1,'one source site lowers once');previous=at;
}
for(const site of carrier){
 assert.deepEqual(Object.keys(site).sort(),['id','kind','resultType','source','targets']);
 assert.deepEqual(Object.keys(site.source).sort(),['module','path','sha256']);
 assert.deepEqual(site.source,parent.result.disclosure.source);
 assert.equal(site.kind,'operation');assert.equal(site.targets.length,1);
 assert.equal(site.resultType,owning.find(op=>op.name===site.targets[0]).result?.type??null);
}
assert.notEqual(carrier[0].id,carrier[1].id);
for(const file of ['no-source','target-skew','input-skew','duplicate-skew']){
 const module=await import(`./${file}.mjs`);
 assert.equal(Object.hasOwn(module.appDefinition.operations['CallProfile.parent'],'callSites'),false,'unproved source/target/ordered inputs have no public callSites carrier');
 assert.equal(module.canApp()['CallProfile.parent'].toString().includes('invokeScenarioReceiptCall'),false,'unmatched call profiles retain refusal bodies');
}
const depthExpected=JSON.parse(readFileSync(new URL('./depth-expected.json',import.meta.url),'utf8'));
for(const edges of [16,17]){
 const module=await import(`./depth-${edges}.mjs`);
 const operation=module.appDefinition.operations['CallDepth.step0'];
 const body=module.canApp()['CallDepth.step0'].toString();
 if(edges===16){
  assert.deepEqual(operation.callSites,[depthExpected],'sixteen child edges preserve the genuine source-qualified site');
  assert.deepEqual(operation.callSites[0].source,module.canApp().operations.find(op=>op.name==='CallDepth.step0').result.disclosure.source);
  assert.equal((body.match(/await invokeScenarioReceiptCall\(c,/g)||[]).length,1);
  assert.ok(body.includes(`await invokeScenarioReceiptCall(c,${JSON.stringify(depthExpected.id)},"CallDepth.step1",`));
 }else{
  assert.equal(Object.hasOwn(operation,'callSites'),false,'seventeenth child edge declines the root carrier');
  assert.equal(body.includes('invokeScenarioReceiptCall'),false,'over-depth root retains refusal body');
 }
}
const framework=await import('./framework.mjs');
const frameworkSites=framework.appDefinition.operations['CallFramework.parent'].callSites;
assert.equal(frameworkSites.length,1);
assert.deepEqual(frameworkSites[0].targets,['CallFramework.child']);
assert.equal(frameworkSites[0].kind,'operation');assert.equal(frameworkSites[0].resultType,'void');
assert.deepEqual(frameworkSites[0].source,framework.canApp().operations.find(op=>op.name==='CallFramework.parent').result.disclosure.source);
assert.equal((framework.canApp()['CallFramework.parent'].toString().match(/await invokeScenarioReceiptCall\(c,/g)||[]).length,1,'source-sealed framework child uses one exact invocation site');
const frameworkOperations=framework.canApp().operations;
const frameworkReturn=frameworkOperations.find(op=>op.name==='CallFramework.parent').result.disclosure;
assert.equal(frameworkReturn.version,1);assert.equal(frameworkReturn.returns.length,1);
assert.deepEqual(frameworkReturn.returns[0].dependencies,[],'void parent has no fabricated result DATA');
assert.ok(frameworkOperations.find(op=>op.name==='CallFramework.child').result.disclosure,'standalone Send receipt is preserved');
// Refused call handlers are deliberately never invoked.
"#;
    std::fs::write(module_dir.path().join("inspect.mjs"), runner).unwrap();
    let inspected = Command::new("node")
        .arg(module_dir.path().join("inspect.mjs"))
        .arg(root().join("packages/cloudflare/dist/runtime/stdlib.js"))
        .output()
        .unwrap();
    assert!(
        inspected.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&inspected.stdout),
        String::from_utf8_lossy(&inspected.stderr)
    );
    // State bounds the aggregate nested execution, not merely each callee's
    // local inventory: one branch call plus 199 leaves is 200 occurrences.
    for leaves in [199, 200] {
        let source = format!(
            "app CallLimit\nGiven\nWhen\n scenario leaf() by=members\n  do require true\n scenario branch() by=members\n  do\n{} scenario parent() by=members\n  do call branch {{}}\nThen\n",
            "   call leaf {}\n".repeat(leaves)
        );
        let mut db = SourceDb::new();
        let file = db.add("call-limit.can".into(), source.clone());
        let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        if leaves == 199 {
            let output = compile_with_receipts(cli_dir.path(), "aggregate-200", &source, true);
            assert!(output.status.success(), "{}", decoded(&output));
        } else {
            assert_refused("aggregate-201", &source);
        }
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        let parent = ir
            .items
            .iter()
            .find(|item| item.canonical == "CallLimit.parent")
            .unwrap();
        assert_eq!(
            collect_static_scenario_calls(
                &ir,
                parent,
                &emitted.operations,
                &db,
                &emitted.entry.path
            )
            .is_some(),
            leaves == 199,
            "aggregate owner call limit"
        );
        assert_eq!(
            emitted
                .operations
                .iter()
                .find(|op| op.name == parent.canonical)
                .unwrap()
                .disclosure
                .is_some(),
            leaves == 199
        );
    }
}
