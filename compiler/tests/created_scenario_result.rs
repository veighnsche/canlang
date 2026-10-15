//! Source preparation for newly-created singular model CALL results. Installed
//! descriptor/factory correspondence below issues no row, call or read authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrEffectCallTarget, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt,
};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_calls::{
    collect_scenario_source_calls, collect_static_scenario_calls,
};
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};
use std::process::Command;

// Preserve the original Chat declaration/argument order and create-return / CALL
// as-return forms. Paid submission, transcript and admission remain other duties.
const CHAT_FORM: &str = r#"app CanChat uses=[chat]
package chat
 use std {TextMessage}
 Given
  Conversation {title:text}
  Branch in Conversation {title:text}
  Turn in Branch {content:text,attachments:file[]}
  Run in Branch {account:user}
  policy Conversation read=members
  policy Branch read=members
  policy Turn read=members
  policy Run read=members
 When
  export scenario ask(branch:Branch,prompt:TextMessage.content,attachments:file[]=[]) by=members -> Run
   do
    create Run {parent=branch,account=actor} as run
    return run
  scenario regenerate(turn:Turn,title:text) by=members -> Run
   do
    create Branch {parent=turn.parent.parent,title} as branch
    call ask {branch,prompt=turn.content,attachments=turn.attachments} as run
    return run
 Then
"#;

// Preserve the original Creative singular result and six authored CALL inputs,
// including the nullable Conversation INPUT (the result remains nonnullable).
const CREATIVE_FORM: &str = r#"app CanCreative uses=[chat,creative]
package chat
 Given
  export Conversation {title:text}
  export Branch in Conversation {title:text}
  export Turn in Branch {content:text}
  policy Conversation read=members
  policy Branch read=members
  policy Turn read=members
 When
 Then
package creative
 use chat {Conversation,Turn}
 use std {ImageRequest}
 Given
  Budget {account:user}
  Revision {name:text}
  Template {revision:Revision,budget:Budget}
  Run {source:text,conversation:Conversation?,revision:Revision,budget:Budget,prompt:ImageRequest.prompt,negative:ImageRequest.negative,width:ImageRequest.width,height:ImageRequest.height}
  policy Budget read=members
  policy Revision read=members
  policy Template read=members
  policy Run read=members
 When
  export scenario generate(template:Template,prompt:ImageRequest.prompt,negative:ImageRequest.negative="",width:ImageRequest.width=512,height:ImageRequest.height=512,conversation:Conversation?=null) by=members -> Run
   do
    let revision=template.revision
    let budget=template.budget
    create Run {source=operation.id,conversation,revision,budget,prompt,negative,width,height} as run
    return run
  scenario from_turn(turn:Turn,template:Template,negative:ImageRequest.negative="",width:ImageRequest.width=512,height:ImageRequest.height=512) by=members -> Run
   do
    call generate {template,prompt=turn.content,negative,width,height,conversation=turn.parent.parent} as run
    return run
 Then
"#;

// Isolate the new result leaf on the already-supported root create/default
// profile. It does not replace either original application's native workflow.
const CREATED: &str = r#"app CreatedRun
Given
 Run {count:int=0}
 Other {count:int=0}
 contract Result {run:Run}
 policy Run read=members
 policy Other read=members
When
 crud Run by=members fields=count delete=remove
 crud Other by=members fields=count delete=remove
 scenario ask(value:int,note:text) -> Run by=members
  do
   create Run {} as run
   return run
 scenario regenerate(value:int) -> Run by=members
  do
   call ask {note="first",value} as run
   return run
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn checked(source: &str) -> (SourceDb, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("created-scenario-result.can".into(), source.into());
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
    (db, ir, catalog)
}
fn item<'a>(ir: &'a IrProgram, name: &str) -> &'a IrItem {
    ir.items.iter().find(|item| item.canonical == name).unwrap()
}
fn result(ir: &IrProgram, name: &str) -> ResolvedType {
    ResolvedType::Record {
        symbol: item(ir, name).id,
        stored: true,
    }
}
fn call_mut(handler: &mut IrItem) -> &mut IrStmt {
    let IrItemKind::Scenario { effects, .. } = &mut handler.kind else {
        panic!("scenario")
    };
    effects
        .iter_mut()
        .find(|statement| matches!(statement, IrStmt::Call { .. }))
        .unwrap()
}
fn returned(handler: &IrItem) -> &canlang_compiler::codegen::ir::TypedExpr {
    let IrItemKind::Scenario { effects, .. } = &handler.kind else {
        panic!("scenario")
    };
    let IrStmt::Return {
        value: Some(value), ..
    } = effects.last().unwrap()
    else {
        panic!("return")
    };
    value
}

const REQUIRED_RESULT: &str = r#"app RequiredResult
Given
 Item {title:text}
 Other {title:text}
 policy Item read=members
 policy Other read=members
When
 scenario retain(item:Item,other:Item) -> Item by=members
  do return item
Then
"#;

#[test]
fn required_parameter_model_result_reuses_original_reserved_identity_and_return_binding() {
    for source in [
        REQUIRED_RESULT.to_string(),
        REQUIRED_RESULT
            .replace("RequiredResult", "RenamedResult")
            .replace("Item", "Entry")
            .replace("item", "selected")
            .replace("retain", "keep"),
    ] {
        let (db, ir, _) = checked(&source);
        let owner = ir
            .items
            .iter()
            .find(|item| matches!(&item.kind, IrItemKind::Scenario { .. }))
            .unwrap();
        let ScenarioDisclosure::Complete(disclosure) = &ir.scenario_disclosures[&owner.id] else {
            panic!(
                "required original model return must be complete: {:?}",
                ir.scenario_disclosures[&owner.id]
            );
        };
        let returned = &disclosure.returns[0];
        assert_eq!(returned.dependencies.len(), 1);
        let identity = &returned.dependencies[0];
        assert_eq!(identity.field_name, "id");
        assert_eq!(identity.type_id, "text");
        assert_eq!(
            identity.role,
            canlang_compiler::analysis::scenario_disclosure::DependencyRole::Data
        );
        assert!(identity.calls.is_empty() && identity.query_id.is_none());
        assert_eq!(
            identity.node.kind,
            canlang_compiler::syntax::SyntaxKind::NameRef as u8
        );
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
        let operation = emitted
            .operations
            .iter()
            .find(|operation| operation.name == owner.canonical)
            .unwrap();
        let plan =
            serde_json::to_value(operation.disclosure.as_ref().expect("original result plan"))
                .unwrap();
        assert_eq!(plan["returns"][0]["dependencies"][0]["field"], "id");
        let body = &emitted.entry.js;
        let observation = format!(
            "await observeScenarioReceiptDependency(c,\"{}\",$receiptValue,\"id\",\"{}\");",
            identity.model_name, identity.id
        );
        let at = body
            .find(&observation)
            .expect("observe the same once-evaluated native return view");
        assert_eq!(body.matches(&observation).count(), 1);
        assert!(
            body[at..].contains(
                "await bindScenarioReceiptModelResult(c,$receiptReturns[0],$receiptValue)"
            )
        );
        assert!(
            !body.contains("$receiptValue[\"id\"]"),
            "no fake source member or substituted result"
        );
    }
}

#[test]
fn required_parameter_result_rejects_changed_body_owner_model_and_source() {
    let (db, ir, _) = checked(REQUIRED_RESULT);
    let owner = item(&ir, "RequiredResult.retain").id;
    let other_type = result(&ir, "RequiredResult.Other");
    for mode in [
        "return-name",
        "return-type",
        "return-span",
        "owner-name",
        "parameter-name",
        "parameter-model",
        "model-fields",
    ] {
        let mut changed = ir.clone();
        match mode {
            "return-name" | "return-type" | "return-span" => {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    unreachable!()
                };
                let IrStmt::Return {
                    value: Some(value), ..
                } = effects.last_mut().unwrap()
                else {
                    unreachable!()
                };
                match mode {
                    "return-name" => value.expr = IrExpr::Name("other".into()),
                    "return-type" => value.ty = other_type.clone(),
                    _ => value.span.start += 1,
                }
            }
            "owner-name" => changed.items[owner.0 as usize].name = "different".into(),
            "parameter-name" | "parameter-model" => {
                let IrItemKind::Scenario { params, .. } = &changed.items[owner.0 as usize].kind
                else {
                    unreachable!()
                };
                let parameter = params[0];
                if mode == "parameter-name" {
                    changed.items[parameter.0 as usize].name = "other".into();
                } else {
                    let IrItemKind::Param { ty, .. } =
                        &mut changed.items[parameter.0 as usize].kind
                    else {
                        unreachable!()
                    };
                    *ty = ir::IrType::Known(other_type.clone());
                }
            }
            _ => {
                let model = item(&changed, "RequiredResult.Item").id;
                let IrItemKind::Model { fields, .. } = &mut changed.items[model.0 as usize].kind
                else {
                    unreachable!()
                };
                fields.clear();
            }
        }
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == "RequiredResult.retain")
                .is_none_or(|operation| operation.disclosure.is_none()),
            "{mode}"
        );
    }
    let mut foreign = SourceDb::new();
    foreign.add(
        "created-scenario-result.can".into(),
        REQUIRED_RESULT.replace("return item", "return other"),
    );
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &foreign);
    assert!(
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == "RequiredResult.retain")
            .is_none_or(|operation| operation.disclosure.is_none())
    );
}

#[test]
fn original_named_chat_and_creative_source_forms_preserve_singular_result_and_input_order() {
    for (source, parent, target, model, names, parameters) in [
        (
            CHAT_FORM,
            "chat.regenerate",
            "chat.ask",
            "chat.Run",
            vec!["branch", "prompt", "attachments"],
            vec!["branch", "prompt", "attachments"],
        ),
        (
            CREATIVE_FORM,
            "creative.from_turn",
            "creative.generate",
            "creative.Run",
            vec![
                "template",
                "prompt",
                "negative",
                "width",
                "height",
                "conversation",
            ],
            vec![
                "template",
                "prompt",
                "negative",
                "width",
                "height",
                "conversation",
            ],
        ),
    ] {
        let (db, ir, _) = checked(source);
        let parent = item(&ir, parent);
        let target = item(&ir, target);
        let sites = collect_scenario_source_calls(&ir, parent, &db)
            .expect("original checked CALL source facts");
        assert_eq!(sites.len(), 1);
        let site = &sites[0];
        assert_eq!(site.target, target.canonical);
        assert_eq!(site.binding.as_deref(), Some("run"));
        assert!(!site.read);
        assert_eq!(site.result, Some(result(&ir, model)));
        assert_eq!(
            site.inputs
                .iter()
                .map(|input| input.name.as_str())
                .collect::<Vec<_>>(),
            names
        );
        let declaration = ir.scenario_disclosures[&target.id].source_facts().unwrap();
        assert_eq!(declaration.result, site.result);
        assert_eq!(
            declaration
                .parameters
                .iter()
                .map(|parameter| ir.items[parameter.parameter.0 as usize].name.as_str())
                .collect::<Vec<_>>(),
            parameters
        );
        for handler in [parent, target] {
            let value = returned(handler);
            assert_eq!(value.ty, result(&ir, model));
            assert!(matches!(&value.expr,IrExpr::Name(name) if name=="run"));
        }
        for input in &site.inputs {
            assert_eq!(input.source.file, site.span.file);
            assert!(input.source.start >= site.span.start && input.source.end <= site.span.end);
        }
    }
}

#[test]
fn created_singular_call_result_joins_the_real_emitted_model_interface() {
    let (db, ir, _) = checked(CREATED);
    let parent = item(&ir, "CreatedRun.regenerate");
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    for name in ["CreatedRun.ask", "CreatedRun.regenerate"] {
        assert!(
            matches!(
                ir.scenario_disclosures[&item(&ir, name).id],
                ScenarioDisclosure::Complete(_)
            ),
            "{name}"
        );
        let operation = emitted
            .operations
            .iter()
            .find(|operation| operation.name == name)
            .unwrap();
        assert_eq!(operation.result.as_deref(), Some("CreatedRun.Run"));
        assert!(operation.disclosure.is_some());
    }
    let sites =
        collect_static_scenario_calls(&ir, parent, &emitted.operations, &db, &emitted.entry.path)
            .expect("exact created result source producer");
    assert_eq!(sites.len(), 1);
    let site = &sites[0];
    assert_eq!(site.target, "CreatedRun.ask");
    assert_eq!(site.binding.as_deref(), Some("run"));
    assert_eq!(site.interface.result.as_deref(), Some("CreatedRun.Run"));
    assert_eq!(
        site.inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["note", "value"]
    );
    assert_eq!(
        site.interface
            .inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["value", "note"]
    );
    assert_eq!(
        site.interface.to_json(),
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == site.target)
            .unwrap()
            .to_json()
    );
    let body = &emitted.entry.js;
    let binding = "const $receiptModelResult=await bindScenarioReceiptModelResult(c,$receiptReturns[0],$receiptValue);";
    assert_eq!(
        body.matches(binding).count(),
        2,
        "root and child returned views bind exactly once: {body}"
    );
    assert_eq!(
        body.matches(&format!(
            "{binding}selectScenarioReceiptReturn(c,$receiptReturns[0]);return $receiptModelResult;"
        ))
        .count(),
        2,
        "await genuine binding before selection and return its same canonical wire: {body}"
    );
    let ordinary = js::emit_program(&ir);
    assert!(!ordinary.entry.js.contains("bindScenarioReceiptModelResult"));
    let occurrence = format!("await invokeScenarioReceiptCall(c,\"{}\"", site.id);
    assert_eq!(body.matches(occurrence.as_str()).count(), 1, "{body}");
    let start = body.find(&occurrence).unwrap();
    let binding = body[..start]
        .rsplit("const ")
        .next()
        .unwrap()
        .strip_suffix(" = ")
        .expect("CALL owns one immutable binding");
    assert!(!binding.is_empty() && !binding.contains('\n'));
    assert!(
        body[start..].contains(&format!("const $receiptValue={binding};")),
        "once-evaluated return: {body}"
    );
}

#[test]
fn source_owner_type_result_binding_and_input_order_mutants_never_qualify_created_call() {
    let (db, ir, _) = checked(CREATED);
    let parent = item(&ir, "CreatedRun.regenerate");
    let id = parent.id;
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        collect_static_scenario_calls(&ir, parent, &emitted.operations, &db, &emitted.entry.path)
            .is_some()
    );
    let mut foreign = SourceDb::new();
    foreign.add(
        "created-scenario-result.can".into(),
        CREATED.replace("first", "changed"),
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
    for corruption in [
        "owner",
        "span",
        "result",
        "binding",
        "input-order",
        "input-type",
        "child-type",
    ] {
        let mut changed = ir.clone();
        if corruption == "child-type" {
            let child_id = item(&changed, "CreatedRun.ask").id;
            let foreign = result(&changed, "CreatedRun.Other");
            let IrItemKind::Scenario { result, .. } = &mut changed.items[child_id.0 as usize].kind
            else {
                panic!()
            };
            *result = Some(foreign);
        } else {
            let parent = &mut changed.items[id.0 as usize];
            if corruption == "owner" {
                parent.name = "forged".into();
                parent.canonical = "CreatedRun.forged".into();
            } else if corruption == "span" {
                parent.span.start += 1;
            } else {
                let IrStmt::Call {
                    inputs,
                    binding,
                    result,
                    ..
                } = call_mut(parent)
                else {
                    panic!()
                };
                match corruption {
                    "result" => *result = Some(ResolvedType::Scalar(Scalar::Text)),
                    "binding" => *binding = Some("other".into()),
                    "input-order" => {
                        let IrExpr::Object(entries) = &mut inputs.expr else {
                            panic!()
                        };
                        entries.reverse();
                    }
                    "input-type" => {
                        let IrExpr::Object(entries) = &mut inputs.expr else {
                            panic!()
                        };
                        entries[0].1.ty = ResolvedType::Scalar(Scalar::Int);
                    }
                    _ => unreachable!(),
                }
            }
        }
        assert!(
            collect_static_scenario_calls(
                &changed,
                &changed.items[id.0 as usize],
                &emitted.operations,
                &db,
                &emitted.entry.path
            )
            .is_none(),
            "{corruption}"
        );
    }
    for corruption in ["descriptor-result", "descriptor-order", "missing-target"] {
        let mut operations = emitted.operations.clone();
        if corruption == "missing-target" {
            operations.retain(|operation| operation.name != "CreatedRun.ask");
        } else {
            let target = operations
                .iter_mut()
                .find(|operation| operation.name == "CreatedRun.ask")
                .unwrap();
            if corruption == "descriptor-result" {
                target.result = Some("CreatedRun.Other".into());
            } else {
                target.inputs.reverse();
            }
        }
        assert!(
            collect_static_scenario_calls(&ir, parent, &operations, &db, &emitted.entry.path)
                .is_none(),
            "{corruption}"
        );
    }
    // A forged static target never becomes the same declaration by retaining
    // the genuine call source span and copied input/body data.
    let mut changed = ir.clone();
    let model = item(&changed, "CreatedRun.Run").id;
    let IrStmt::Call { target, .. } = call_mut(&mut changed.items[id.0 as usize]) else {
        panic!()
    };
    let IrEffectCallTarget::Operation { operation, .. } = target else {
        panic!()
    };
    *operation = model;
    assert!(collect_scenario_source_calls(&changed, &changed.items[id.0 as usize], &db).is_none());
}

#[test]
fn indirect_intermediate_nullable_array_and_composite_results_stay_outside_model_leaf() {
    for (mode, signature, parameters, body) in [
        (
            "indirect-existing",
            "Run",
            "run:Run",
            "   let copied=run\n   return copied",
        ),
        (
            "intermediate-only",
            "Run",
            "",
            "   create Run {} as run\n   delete run\n   return run",
        ),
        (
            "nullable",
            "Run?",
            "",
            "   create Run {} as run\n   return run",
        ),
        (
            "array",
            "Run[]",
            "",
            "   create Run {} as run\n   return [run]",
        ),
        (
            "composite",
            "Result",
            "",
            "   create Run {} as run\n   return Result {run}",
        ),
    ] {
        let source = format!(
            "app RefusedCreated\nGiven\n Run {{count:int=0}}\n contract Result {{run:Run}}\n policy Run read=members\nWhen\n crud Run by=members fields=count delete=remove\n scenario rejected({parameters}) -> {signature} by=members\n  do\n{body}\nThen\n"
        );
        let (db, ir, _) = checked(&source);
        let handler = item(&ir, "RefusedCreated.rejected");
        assert!(
            matches!(
                ir.scenario_disclosures[&handler.id],
                ScenarioDisclosure::Declined(_)
            ),
            "{mode}"
        );
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == handler.canonical)
                .unwrap()
                .disclosure
                .is_none(),
            "{mode}"
        );
    }
    for (result, body) in [
        ("int", "   return run.count"),
        ("Run", "   let copied=run\n   return copied"),
        ("Run", "   require run==run\n   return run"),
    ] {
        let source = CREATED
            .replace(
                "scenario regenerate(value:int) -> Run",
                &format!("scenario regenerate(value:int) -> {result}"),
            )
            .replace(
                "   call ask {note=\"first\",value} as run\n   return run",
                &format!("   call ask {{note=\"first\",value}} as run\n{body}"),
            );
        let (db, ir, _) = checked(&source);
        let parent = item(&ir, "CreatedRun.regenerate");
        assert!(
            matches!(
                ir.scenario_disclosures[&parent.id],
                ScenarioDisclosure::Declined(_)
            ),
            "{body}"
        );
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == parent.canonical)
                .unwrap()
                .disclosure
                .is_none(),
            "{body}"
        );
    }
}

#[test]
fn child_create_and_return_ir_must_match_original_model_and_binding() {
    let (db, ir, _) = checked(CREATED);
    let child = item(&ir, "CreatedRun.ask").id;
    let parent = item(&ir, "CreatedRun.regenerate").id;
    let other = result(&ir, "CreatedRun.Other");
    for mode in [
        "create-target",
        "create-binding",
        "create-object",
        "create-input-span",
        "create-span",
        "return-name",
        "return-type",
        "return-span",
        "return-expression",
        "model-owner",
    ] {
        let mut changed = ir.clone();
        if mode == "model-owner" {
            let model = item(&changed, "CreatedRun.Run").id;
            let parent = item(&changed, "CreatedRun.Other").id;
            let IrItemKind::Model { owner, .. } = &mut changed.items[model.0 as usize].kind else {
                panic!("model");
            };
            *owner = ir::IrOwner::ChildOf(parent);
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[child.0 as usize].kind
            else {
                panic!("scenario");
            };
            if mode.starts_with("create-") {
                let IrStmt::Create {
                    model,
                    input,
                    binding,
                    span,
                    ..
                } = &mut effects[0]
                else {
                    panic!("create");
                };
                match mode {
                    "create-target" => *model = "CreatedRun.Other".into(),
                    "create-binding" => *binding = Some("other".into()),
                    "create-object" => {
                        let IrExpr::Object(entries) = &mut input.expr else {
                            panic!("object");
                        };
                        entries.push((
                            "count".into(),
                            ir::TypedExpr::new(
                                IrExpr::Int(9),
                                ResolvedType::Scalar(Scalar::Int),
                                *span,
                            ),
                        ));
                    }
                    "create-input-span" => input.span.start += 1,
                    "create-span" => span.start += 1,
                    _ => unreachable!(),
                }
            } else {
                let IrStmt::Return {
                    value: Some(value),
                    span,
                } = effects.last_mut().unwrap()
                else {
                    panic!("return");
                };
                match mode {
                    "return-name" => value.expr = IrExpr::Name("other".into()),
                    "return-type" => value.ty = other.clone(),
                    "return-span" => span.start += 1,
                    "return-expression" => value.expr = IrExpr::Int(9),
                    _ => unreachable!(),
                }
            }
        }
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == "CreatedRun.ask")
                .unwrap()
                .disclosure
                .is_none(),
            "{mode}"
        );
        assert!(
            collect_static_scenario_calls(
                &changed,
                &changed.items[parent.0 as usize],
                &emitted.operations,
                &db,
                &emitted.entry.path
            )
            .is_none(),
            "{mode}"
        );
    }
}

#[test]
fn actual_cli_verified_factory_and_installed_state_descriptor_share_created_model_source() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("created-scenario-result.can");
    std::fs::write(&source, CREATED).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, output.stdout).unwrap();
    let runner = scratch.path().join("created-result.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact),factory=module.canApp();
const loaded=loadArtifactDescriptors(artifact,{by:'members'});
for(const name of ['CreatedRun.ask','CreatedRun.regenerate']) {
 const operation=artifact.operations.find(operation=>operation.name===name),callable=artifact.callables.find(callable=>callable.id===name);
 assert.equal(operation.result.type,'CreatedRun.Run');assert.equal(loaded.registry.get(name).descriptor.result.type,'CreatedRun.Run');
 assert.deepEqual(loaded.registry.get(name).descriptor.result.disclosure,operation.result.disclosure);
 assert.equal(module[callable.export],name);let handler=factory;for(const part of callable.member)handler=handler[part];assert.equal(typeof handler,'function');
 assert.equal(module.appDefinition.operations[name].handler,name);
}
const calls=module.appDefinition.operations['CreatedRun.regenerate'].callSites;
assert.equal(calls.length,1);assert.deepEqual(calls[0].targets,['CreatedRun.ask']);assert.equal(calls[0].resultType,'CreatedRun.Run');
assert.deepEqual(calls[0].source,artifact.operations.find(operation=>operation.name==='CreatedRun.regenerate').result.disclosure.source);
// Do not execute this factory with fabricated c/rows. Dev must connect its
// genuine current owner row to State's model binder before return selection.
console.log('CLI, verified factory and installed State share exact created model CALL source/descriptor; native execution remains the Dev owner leaf');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact)
        .arg(&source)
        .arg(scratch.path().join("modules"))
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&run.stdout));
}
