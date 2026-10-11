//! Bounded original CALL operand fragments join checked source, real owning
//! descriptors and emitted carriers. No native row or File authority is issued.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrDefault, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType,
};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_calls::{
    collect_scenario_source_calls, collect_static_scenario_calls,
};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::path::{Path, PathBuf};
use std::process::Command;

// Keep the original Branch CreateAs, turn.content and named CALL operands.
// These child bodies exercise only populated owning Create/Return. Original
// transcript queries, allowance work and guarded child SEND remain separate.
const CHAT: &str = r#"app CanChat uses=[chat]
package chat
 use std {TextMessage}
 Given
  Conversation {title:text}
  Branch in Conversation {title:text}
  Turn in Branch {content:text,attachments:file[] max=8}
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

// The six original Creative operands are unchanged. The required Turn has
// exactly two checked containment edges to the nullable Conversation slot.
const CREATIVE: &str = r#"app CanCreative uses=[chat,creative]
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
  Template {name:text}
  Run {template:Template,conversation:Conversation?,prompt:ImageRequest.prompt,negative:ImageRequest.negative,width:ImageRequest.width,height:ImageRequest.height}
  policy Template read=members
  policy Run read=members
 When
  export scenario generate(template:Template,prompt:ImageRequest.prompt,negative:ImageRequest.negative="",width:ImageRequest.width=512,height:ImageRequest.height=512,conversation:Conversation?=null) by=members -> Run
   do
    create Run {template,conversation,prompt,negative,width,height} as run
    return run
  scenario from_turn(turn:Turn,template:Template,negative:ImageRequest.negative="",width:ImageRequest.width=512,height:ImageRequest.height=512) by=members -> Run
   do
    call generate {template,prompt=turn.content,negative,width,height,conversation=turn.parent.parent} as run
    return run
 Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn lowered(source: &str) -> (SourceDb, IrProgram) {
    let mut db = SourceDb::new();
    let file = db.add("scenario-call-references.can".into(), source.into());
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

fn assert_two_parent_types(ir: &IrProgram, value: &ir::TypedExpr) {
    let IrExpr::Member {
        base: branch,
        field,
    } = &value.expr
    else {
        panic!("outer Conversation parent")
    };
    assert_eq!(field, "parent");
    assert_eq!(
        value.ty,
        ResolvedType::Record {
            symbol: item(ir, "chat.Conversation").id,
            stored: true
        }
    );
    let IrExpr::Member { base: turn, field } = &branch.expr else {
        panic!("intermediate Branch parent")
    };
    assert_eq!(field, "parent");
    assert_eq!(
        branch.ty,
        ResolvedType::Record {
            symbol: item(ir, "chat.Branch").id,
            stored: true
        }
    );
    assert!(matches!(&turn.expr, IrExpr::Name(name) if name == "turn"));
    assert_eq!(
        turn.ty,
        ResolvedType::Record {
            symbol: item(ir, "chat.Turn").id,
            stored: true
        }
    );
}

#[test]
fn original_reference_calls_join_complete_source_and_actual_owning_interfaces() {
    for (source, parent_name, child_name, names) in [
        (
            CHAT,
            "chat.regenerate",
            "chat.ask",
            vec!["branch", "prompt", "attachments"],
        ),
        (
            CREATIVE,
            "creative.from_turn",
            "creative.generate",
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
        let (db, ir) = lowered(source);
        let parent = item(&ir, parent_name);
        let child = item(&ir, child_name);
        let calls = collect_scenario_source_calls(&ir, parent, &db)
            .expect("checked original rich CALL source");
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(call.target, child_name);
        assert_eq!(call.binding.as_deref(), Some("run"));
        assert_eq!(
            call.inputs
                .iter()
                .map(|input| input.name.as_str())
                .collect::<Vec<_>>(),
            names
        );
        assert_eq!(source_text(&db, call.inputs[1].source), "turn.content");
        assert_eq!(
            call.result,
            Some(ResolvedType::Record {
                symbol: item(
                    &ir,
                    if parent_name == "chat.regenerate" {
                        "chat.Run"
                    } else {
                        "creative.Run"
                    }
                )
                .id,
                stored: true
            })
        );
        let facts = ir.scenario_disclosures[&parent.id].source_facts().unwrap();
        if parent_name == "chat.regenerate" {
            let created = &facts.creates.as_ref().unwrap()[0];
            assert_eq!(created.binding, "branch");
            assert_eq!(created.definition.canonical, "chat.Branch");
            assert!(created.node.end <= call.span.start);
            assert_eq!(source_text(&db, call.inputs[0].source), "branch");
            assert_eq!(
                created
                    .inputs
                    .iter()
                    .map(|input| input.name.as_str())
                    .collect::<Vec<_>>(),
                ["parent", "title"]
            );
            assert_eq!(
                source_text(
                    &db,
                    Span::new(
                        created.inputs[0].value_node.file,
                        created.inputs[0].value_node.start,
                        created.inputs[0].value_node.end
                    )
                ),
                "turn.parent.parent"
            );
            let IrItemKind::Scenario { effects, .. } = &parent.kind else {
                panic!("scenario")
            };
            let IrStmt::Create { input, .. } = &effects[0] else {
                panic!("preceding Branch Create")
            };
            let IrExpr::Object(inputs) = &input.expr else {
                panic!("authored Create input")
            };
            assert_eq!(inputs[0].0, "parent");
            assert_two_parent_types(&ir, &inputs[0].1);
        } else {
            assert_eq!(source_text(&db, call.inputs[0].source), "template");
            assert_eq!(
                source_text(&db, call.inputs[5].source),
                "turn.parent.parent"
            );
            assert_eq!(
                call.inputs[5].ty,
                ResolvedType::Record {
                    symbol: item(&ir, "chat.Conversation").id,
                    stored: true
                }
            );
            let IrItemKind::Scenario { effects, .. } = &parent.kind else {
                panic!("scenario")
            };
            let IrStmt::Call { inputs, .. } = &effects[0] else {
                panic!("original six-slot CALL")
            };
            let IrExpr::Object(inputs) = &inputs.expr else {
                panic!("CALL inputs")
            };
            assert_eq!(inputs[5].0, "conversation");
            assert_two_parent_types(&ir, &inputs[5].1);
            let declared = ir.scenario_disclosures[&child.id].source_facts().unwrap();
            assert_eq!(
                declared
                    .parameters
                    .iter()
                    .map(|parameter| ir.items[parameter.parameter.0 as usize].name.as_str())
                    .collect::<Vec<_>>(),
                names
            );
            let conversation = declared
                .parameters
                .iter()
                .find(|parameter| ir.items[parameter.parameter.0 as usize].name == "conversation")
                .unwrap();
            assert_eq!(
                conversation.ty,
                ResolvedType::Nullable(Box::new(call.inputs[5].ty.clone()))
            );
            let default = conversation.default.unwrap();
            assert_eq!(
                source_text(&db, Span::new(default.file, default.start, default.end)),
                "null"
            );
            let IrItemKind::Param {
                ty: IrType::Known(ty),
                default: Some(ir::IrDefault::Literal(value)),
                ..
            } = &ir.items[conversation.parameter.0 as usize].kind
            else {
                panic!("literal default")
            };
            assert_eq!(ty, &conversation.ty);
            assert!(matches!(value.expr, IrExpr::Null));
        }
        assert!(
            matches!(
                ir.scenario_disclosures[&parent.id],
                ScenarioDisclosure::Complete(_)
            ),
            "bounded original reference CALL source"
        );
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
        let sites = collect_static_scenario_calls(
            &ir,
            parent,
            &emitted.operations,
            &db,
            &emitted.entry.path,
        )
        .expect("complete original reference CALL");
        assert_eq!(sites.len(), 1);
        assert_eq!(sites[0].target, child.canonical);
        assert_eq!(
            sites[0]
                .inputs
                .iter()
                .map(|input| input.name.as_str())
                .collect::<Vec<_>>(),
            names
        );
        assert_eq!(
            sites[0].interface.to_json(),
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == child_name)
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
                .find(|operation| operation.name == parent_name)
                .unwrap()
                .disclosure
                .is_some()
        );
    }
}

#[test]
fn original_stored_file_array_call_joins_exact_dependency_and_ordinary_default_declaration() {
    let (db, ir) = lowered(CHAT);
    let parent = item(&ir, "chat.regenerate");
    let calls = collect_scenario_source_calls(&ir, parent, &db)
        .expect("original three-slot CALL inventory");
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0]
            .inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["branch", "prompt", "attachments"]
    );
    assert_eq!(
        source_text(&db, calls[0].inputs[2].source),
        "turn.attachments"
    );
    assert!(
        matches!(&calls[0].inputs[2].ty, ResolvedType::Array {element, ..} if **element == ResolvedType::Scalar(Scalar::File))
    );
    assert!(matches!(
        ir.scenario_disclosures[&parent.id],
        ScenarioDisclosure::Complete(_)
    ));
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    let sites =
        collect_static_scenario_calls(&ir, parent, &emitted.operations, &db, &emitted.entry.path)
            .unwrap();
    assert_eq!(sites.len(), 1);
    assert!(
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == parent.canonical)
            .unwrap()
            .disclosure
            .is_some()
    );
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&parent.id] else {
        panic!("complete")
    };
    let dependencies: Vec<_> = proof
        .returns
        .iter()
        .flat_map(|returned| &returned.dependencies)
        .filter(|dependency| dependency.field_name == "attachments")
        .collect();
    assert!(!dependencies.is_empty());
    let original = dependencies[0];
    for dependency in dependencies {
        assert_eq!(dependency.id, original.id);
        assert_eq!(dependency.model_name, "chat.Turn");
        assert_eq!(dependency.field, item(&ir, "chat.Turn.attachments").id);
        assert_eq!(dependency.type_id, "file[]");
        assert_eq!(
            source_text(
                &db,
                Span::new(
                    dependency.node.file,
                    dependency.node.start,
                    dependency.node.end
                )
            ),
            "turn.attachments"
        );
    }
    assert!(emitted.entry.js.contains("fileInputs"));
    assert!(emitted.entry.js.contains(&original.id));
    let child = emitted
        .operations
        .iter()
        .find(|operation| operation.name == "chat.ask")
        .unwrap();
    let field = child
        .inputs
        .iter()
        .find(|input| input.name == "attachments")
        .unwrap();
    assert!(matches!(field.field, js::JsMcpField::File));
    assert_eq!(field.value_type.as_deref(), Some("file[]"));
    assert_eq!(field.array_required, Some(false));
    assert!(!field.required);
    assert!(!field.nullable);
    assert_eq!(
        field.default.as_ref().unwrap().to_json(),
        r#"{"kind":"literal","value":[]}"#
    );
    let IrItemKind::Field {
        modifiers,
        required_array: false,
        ..
    } = &item(&ir, "chat.Turn.attachments").kind
    else {
        panic!("ordinary original File field")
    };
    assert!(matches!(
        modifiers.max.as_ref().unwrap().expr,
        IrExpr::Int(8)
    ));
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

fn assert_call_refused(ir: &IrProgram, db: &SourceDb, parent: &str, mode: &str) {
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
fn exact_reference_and_stored_file_operands_refuse_source_ir_and_interface_skew() {
    for (source, parent, child, modes) in [
        (
            CHAT,
            "chat.regenerate",
            "chat.ask",
            vec![
                "argument-order",
                "argument-omission",
                "argument-duplicate",
                "reference-name",
                "reference-type",
                "member-name",
                "file-member",
                "file-receiver",
                "file-type",
                "field-type",
                "field-bound",
                "parameter-name",
                "parameter-type",
                "parameter-default",
                "parameter-array",
                "create-binding",
                "create-order",
                "create-input",
                "create-missing",
                "model-canonical",
                "source-metadata",
            ],
        ),
        (
            CREATIVE,
            "creative.from_turn",
            "creative.generate",
            vec![
                "argument-order",
                "argument-omission",
                "argument-duplicate",
                "reference-name",
                "reference-type",
                "member-name",
                "parent-edge",
                "parent-base",
                "containment",
                "nullable-default",
                "scalar-default",
                "parameter-order",
            ],
        ),
    ] {
        let (db, ir) = lowered(source);
        let owner = item(&ir, parent).id;
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
        assert!(
            collect_static_scenario_calls(
                &ir,
                &ir.items[owner.0 as usize],
                &emitted.operations,
                &db,
                &emitted.entry.path
            )
            .is_some()
        );
        let mut changed_source = SourceDb::new();
        changed_source.add(
            "scenario-call-references.can".into(),
            source.replace("prompt=turn.content", "prompt=turn.changed"),
        );
        assert_call_refused(&ir, &changed_source, parent, "source");
        for mode in modes {
            let mut changed = ir.clone();
            match mode {
                "argument-order" => call_inputs_mut(&mut changed, parent).swap(0, 1),
                "argument-omission" => {
                    call_inputs_mut(&mut changed, parent).pop();
                }
                "argument-duplicate" => {
                    let entries = call_inputs_mut(&mut changed, parent);
                    entries[1].0 = entries[0].0.clone();
                }
                "reference-name" => {
                    call_inputs_mut(&mut changed, parent)[0].1.expr = IrExpr::Name("foreign".into())
                }
                "reference-type" => {
                    call_inputs_mut(&mut changed, parent)[0].1.ty =
                        ResolvedType::Scalar(Scalar::Text)
                }
                "member-name" | "file-member" | "file-receiver" | "file-type" => {
                    let entries = call_inputs_mut(&mut changed, parent);
                    let value = &mut entries[if mode.starts_with("file-") { 2 } else { 1 }].1;
                    if mode == "file-type" {
                        value.ty = ResolvedType::Scalar(Scalar::Text);
                    } else {
                        let IrExpr::Member { base, field } = &mut value.expr else {
                            panic!("direct stored field")
                        };
                        if mode == "file-receiver" {
                            base.expr = IrExpr::Name("foreign".into());
                        } else {
                            *field = "changed".into();
                        }
                    }
                }
                "field-type" | "field-bound" => {
                    let id = item(&changed, "chat.Turn.attachments").id;
                    let IrItemKind::Field { ty, modifiers, .. } =
                        &mut changed.items[id.0 as usize].kind
                    else {
                        panic!("field")
                    };
                    if mode == "field-type" {
                        *ty = IrType::Known(ResolvedType::Scalar(Scalar::File));
                    } else {
                        modifiers.max.as_mut().unwrap().expr = IrExpr::Int(7);
                    }
                }
                "parameter-name" | "parameter-type" | "parameter-default" | "parameter-array" => {
                    let id = item(&changed, "chat.ask.attachments").id;
                    if mode == "parameter-name" {
                        changed.items[id.0 as usize].name = "foreign".into();
                    } else {
                        let IrItemKind::Param {
                            ty,
                            default,
                            array_bounds,
                            ..
                        } = &mut changed.items[id.0 as usize].kind
                        else {
                            panic!("parameter")
                        };
                        match mode {
                            "parameter-type" => {
                                *ty = IrType::Known(ResolvedType::Scalar(Scalar::File))
                            }
                            "parameter-default" => *default = None,
                            "parameter-array" => {
                                *ty = IrType::Known(ResolvedType::Array {
                                    element: Box::new(ResolvedType::Scalar(Scalar::File)),
                                    ordered: true,
                                    nonempty: true,
                                })
                            }
                            _ => unreachable!(),
                        }
                        assert!(array_bounds.is_none());
                    }
                }
                "create-binding" | "create-order" | "create-input" | "create-missing" => {
                    let effects = effects_mut(&mut changed, parent);
                    if mode == "create-order" {
                        effects.swap(0, 1);
                    } else if mode == "create-missing" {
                        effects.remove(0);
                    } else {
                        let IrStmt::Create { binding, input, .. } = &mut effects[0] else {
                            panic!("preceding Create")
                        };
                        if mode == "create-binding" {
                            *binding = Some("foreign".into());
                        } else {
                            let IrExpr::Object(entries) = &mut input.expr else {
                                panic!("Create inputs")
                            };
                            entries[1].1.expr = IrExpr::Name("foreign".into());
                        }
                    }
                }
                "model-canonical" => {
                    let id = item(&changed, "chat.Branch").id;
                    changed.items[id.0 as usize].canonical = "foreign.Branch".into();
                }
                "source-metadata" => {
                    let ScenarioDisclosure::Complete(proof) =
                        changed.scenario_disclosures.get_mut(&owner).unwrap()
                    else {
                        panic!("Complete")
                    };
                    for dependency in proof
                        .returns
                        .iter_mut()
                        .flat_map(|returned| &mut returned.dependencies)
                        .filter(|dependency| dependency.field_name == "attachments")
                    {
                        dependency.type_id = "file".into();
                    }
                }
                "parent-edge" | "parent-base" => {
                    let value = &mut call_inputs_mut(&mut changed, parent)[5].1;
                    let IrExpr::Member { base, field } = &mut value.expr else {
                        panic!("two-parent")
                    };
                    if mode == "parent-edge" {
                        *field = "changed".into();
                    } else {
                        let IrExpr::Member { base, .. } = &mut base.expr else {
                            panic!("first parent")
                        };
                        base.expr = IrExpr::Name("foreign".into());
                    }
                }
                "containment" => {
                    let id = item(&changed, "chat.Turn").id;
                    let IrItemKind::Model { owner, .. } = &mut changed.items[id.0 as usize].kind
                    else {
                        panic!("model")
                    };
                    *owner = ir::IrOwner::App;
                }
                "nullable-default" | "scalar-default" => {
                    let id = item(
                        &changed,
                        if mode == "nullable-default" {
                            "creative.generate.conversation"
                        } else {
                            "creative.generate.width"
                        },
                    )
                    .id;
                    let IrItemKind::Param { default, .. } = &mut changed.items[id.0 as usize].kind
                    else {
                        panic!("parameter")
                    };
                    let Some(IrDefault::Literal(value)) = default else {
                        panic!("literal default")
                    };
                    value.expr = if mode == "nullable-default" {
                        IrExpr::Name("template".into())
                    } else {
                        IrExpr::Int(513)
                    };
                }
                "parameter-order" => {
                    let id = item(&changed, child).id;
                    let IrItemKind::Scenario { params, .. } =
                        &mut changed.items[id.0 as usize].kind
                    else {
                        panic!("child")
                    };
                    params.swap(0, 1);
                }
                _ => unreachable!("{mode}"),
            }
            assert_call_refused(&changed, &db, parent, mode);
        }
        // Canonical interface edits are tested against the original eligible
        // parent, rather than obtaining credit from already-refused changed IR.
        for mode in [
            "model",
            "version",
            "declaration-order",
            "default",
            "file-array",
            "file-type",
        ] {
            if parent != "chat.regenerate" && mode.starts_with("file-") {
                continue;
            }
            let mut operations = emitted.operations.clone();
            let operation = operations
                .iter_mut()
                .find(|operation| operation.name == child)
                .unwrap();
            match mode {
                "model" | "version" => {
                    let js::JsMcpField::Ref {
                        model,
                        require_version,
                    } = &mut operation.inputs[0].field
                    else {
                        panic!("Ref")
                    };
                    if mode == "model" {
                        *model = "foreign.Model".into();
                    } else {
                        *require_version = false;
                    }
                }
                "declaration-order" => operation.inputs.swap(0, 1),
                "default" => {
                    let index = if parent == "chat.regenerate" { 2 } else { 3 };
                    operation.inputs[index].default = None;
                }
                "file-array" => operation.inputs[2].array_required = Some(true),
                "file-type" => operation.inputs[2].value_type = Some("file".into()),
                _ => unreachable!(),
            }
            assert!(
                collect_static_scenario_calls(
                    &ir,
                    &ir.items[owner.0 as usize],
                    &operations,
                    &db,
                    &emitted.entry.path
                )
                .is_none(),
                "{parent}: {mode}"
            );
        }
    }
}

#[test]
fn source_call_omission_alias_and_computed_file_profiles_remain_refused() {
    let exact_call = "call ask {branch,prompt=turn.content,attachments=turn.attachments} as run";
    for (source, owner) in [
        (CHAT.replace(exact_call, "call ask {branch,prompt=turn.content} as run"), "chat.regenerate"),
        (CHAT.replace("attachments=turn.attachments", "attachments=[]"), "chat.regenerate"),
        (CHAT.replace(exact_call, "let copied=turn.attachments\n    call ask {branch,prompt=turn.content,attachments=copied} as run"), "chat.regenerate"),
        (CHAT.replace("attachments=turn.attachments", "attachments=turn.attachments+[]"), "chat.regenerate"),
        (CHAT.replace("turn:Turn,title", "turn:Turn?,title"), "chat.regenerate"),
        (CREATIVE.replace("call generate {template,prompt=turn.content", "let copied=template\n    call generate {template=copied,prompt=turn.content"), "creative.from_turn"),
    ] {
        let mut db = SourceDb::new();
        let file = db.add("scenario-call-references.can".into(), source);
        let path = root().join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest { flag: Some(&path), env: None, cwd: &root(), primary: Span::new(file, 0, 0) });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        if !diagnostics.is_empty() {
            assert!(diagnostics.iter().any(|diagnostic| diagnostic.severity == canlang_compiler::diagnostic::Severity::Error));
            continue;
        }
        let (ir, diagnostics) = ir::build(&program, &db, catalog.as_ref());
        if !diagnostics.is_empty() {
            assert!(diagnostics.iter().any(|diagnostic| diagnostic.severity == canlang_compiler::diagnostic::Severity::Error));
            continue;
        }
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(collect_static_scenario_calls(&ir, item(&ir, owner), &emitted.operations, &db, &emitted.entry.path).is_none(), "unsupported authored CALL profile");
        assert!(emitted.operations.iter().find(|operation| operation.name == owner).unwrap().disclosure.is_none());
    }
}

#[test]
fn actual_cli_verified_calls_keep_original_carriers_and_installed_descriptor_metadata() {
    for (label, source_text, parent, child, names) in [
        (
            "chat",
            CHAT,
            "chat.regenerate",
            "chat.ask",
            vec!["branch", "prompt", "attachments"],
        ),
        (
            "creative",
            CREATIVE,
            "creative.from_turn",
            "creative.generate",
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
        let scratch = tempfile::tempdir().unwrap();
        let source = scratch.path().join(format!("{label}-call-references.can"));
        std::fs::write(&source, source_text).unwrap();
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
            "{label}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(artifact["sources"][0]["path"], source.to_str().unwrap());
        assert_eq!(
            artifact["sources"][0]["sha256"],
            sha256_hex(source_text.as_bytes())
        );
        let target = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == child)
            .unwrap();
        assert_eq!(
            target["inputs"]["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|input| input["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            names
        );
        let artifact_path = scratch.path().join("artifact.json");
        std::fs::write(&artifact_path, output.stdout).unwrap();
        let runner = scratch.path().join("call-references.mjs");
        std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3])),parent=process.argv[6],child=process.argv[7];
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const loaded=loadArtifactDescriptors(artifact,{by:'members'});
const operations=artifact.operations,caller=operations.find(operation=>operation.name===parent),target=operations.find(operation=>operation.name===child);
assert.ok(caller.result.disclosure);assert.ok(target.result.disclosure);
for(const operation of [caller,target])assert.deepEqual(loaded.registry.get(operation.name).descriptor.result.disclosure,operation.result.disclosure);
const callable=artifact.callables.find(callable=>callable.id===parent),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
let handler=factory;for(const member of callable.member)handler=handler[member];assert.equal(typeof handler,'function');
const sites=module.appDefinition.operations[parent].callSites;assert.equal(sites.length,1);
const site=sites[0];assert.equal(site.kind,'operation');assert.deepEqual(site.targets,[child]);assert.equal(site.resultType,target.result.type);
assert.deepEqual(site.source,caller.result.disclosure.source);
const body=handler.toString(),called=body.indexOf('await invokeScenarioReceiptCall('),returned=body.lastIndexOf('return ');
assert.equal((body.match(/\bawait invokeScenarioReceiptCall\(/g)||[]).length,1);assert.ok(called>=0&&called<returned);assert.ok(body.includes(JSON.stringify(site.id)));
const canonical=loaded.registry.get(child).descriptor.inputs,fields=target.inputs.fields;
if(parent==='chat.regenerate') {
 const created=body.indexOf('await create(');assert.ok(created>=0&&created<called);assert.equal((body.match(/\bawait create\(/g)||[]).length,1);
 const dependencies=caller.result.disclosure.returns.flatMap(returned=>returned.dependencies),files=dependencies.filter(dependency=>dependency.field==='attachments');assert.ok(files.length>0);
 assert.ok(files.every(dependency=>dependency.id===files[0].id&&dependency.type==='file[]'&&dependency.model==='chat.Turn'));
 assert.deepEqual(site.fileInputs,[{name:'attachments',dependencyId:files[0].id}]);
 const captured=`await observeScenarioReceiptDependency(c,"chat.Turn",$receiptRow,"attachments",${JSON.stringify(files[0].id)});`;
 assert.equal(body.split(captured).length-1,1,'owning stored File array capture is awaited once with the original dependency');
 const input=fields.find(input=>input.name==='attachments');assert.deepEqual(input.field,{kind:'file'});assert.equal(input.valueType,'file[]');assert.deepEqual(input.array,{required:false});assert.equal(input.required,false);assert.deepEqual(input.default,{kind:'literal',value:[]});
 const installed=canonical.find(input=>input.name==='attachments');assert.equal(installed.kind,'file');assert.equal(installed.valueType,'file[]');assert.deepEqual(installed.default,input.default);
 const model=artifact.models.find(model=>model.name==='chat.Turn'),field=model.fields.find(field=>field.name==='attachments');assert.equal(field.max,8);assert.deepEqual(field.array,{required:false});
 assert.equal((body.match(/\["attachments"\]/g)||[]).length,1);
 const createdBinding=body.match(/\bconst ([$\w]+) = await create\(c,"chat\.Branch"/);assert.ok(createdBinding,body);
 const branch=body.indexOf('{branch:'+createdBinding[1]+',prompt:',called),prompt=body.indexOf(',prompt:',branch),attachments=body.indexOf(',attachments:',prompt);
 assert.ok(called<branch&&branch<prompt&&prompt<attachments&&attachments<returned,body);
 for(const slot of ['branch','prompt','attachments'])assert.equal((body.match(new RegExp('\\b'+slot+':','g'))||[]).length,1,slot);
 assert.equal((body.match(/\["content"\]/g)||[]).length,1);
} else {
 assert.equal(Object.hasOwn(site,'fileInputs'),false);assert.equal((body.match(/\bawait create\(/g)||[]).length,0);
 const input=fields.find(input=>input.name==='template');assert.deepEqual(input.field,{kind:'ref',model:'creative.Template',requireVersion:true});assert.equal(input.required,true);
 const conversation=fields.find(input=>input.name==='conversation');assert.equal(conversation.field.model,'chat.Conversation');assert.equal(conversation.field.requireVersion,true);assert.equal(conversation.nullable,true);assert.equal(conversation.required,false);assert.deepEqual(conversation.default,{kind:'literal',value:null});
 for(const [name,value]of [['negative',''],['width','512'],['height','512']])assert.deepEqual(fields.find(input=>input.name===name).default,{kind:'literal',value});
 assert.equal(canonical.find(input=>input.name==='conversation').nullable,true);
}
// These are actual compiled/source/installed descriptor and carrier joins.
// Do not execute synthetic rows, references or Files; Dev owns native CALL,
// File observations, atomic rollback, recovery and full original applications.
console.log(`${parent}: actual CLI/verified carrier/installed descriptors; native execution unqualified`);
"#).unwrap();
        let run = Command::new("node")
            .arg(&runner)
            .arg(root())
            .arg(&artifact_path)
            .arg(&source)
            .arg(scratch.path().join("modules"))
            .arg(parent)
            .arg(child)
            .current_dir(scratch.path())
            .output()
            .unwrap();
        assert!(
            run.status.success(),
            "{label}: {}\n{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        );
        eprint!("{}", String::from_utf8_lossy(&run.stdout));
    }
}
