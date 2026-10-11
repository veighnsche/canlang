//! Original rich CALL reference operands retain checked source and IR facts.
//! Static/native eligibility remains explicitly declined at this checkpoint.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItem, IrItemKind, IrProgram, IrType};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_calls::{
    collect_scenario_source_calls, collect_static_scenario_calls,
};
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

// Keep the original Branch CreateAs, turn.content and named CALL operands.
// The original File[] slot is isolated below until its runtime owner releases it.
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
  export scenario ask(branch:Branch,prompt:TextMessage.content) by=members -> Run
   do
    create Run {parent=branch,account=actor} as run
    return run
  scenario regenerate(turn:Turn,title:text) by=members -> Run
   do
    create Branch {parent=turn.parent.parent,title} as branch
    call ask {branch,prompt=turn.content} as run
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

#[test]
fn original_rich_reference_calls_keep_source_inventory_and_explicit_runtime_refusal() {
    for (source, parent_name, child_name, names) in [
        (
            CHAT,
            "chat.regenerate",
            "chat.ask",
            vec!["branch", "prompt"],
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
                ScenarioDisclosure::Declined(_)
            ),
            "rich native eligibility is unfinished"
        );
        let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
        assert!(
            collect_static_scenario_calls(
                &ir,
                parent,
                &emitted.operations,
                &db,
                &emitted.entry.path
            )
            .is_none()
        );
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == parent_name)
                .unwrap()
                .disclosure
                .is_none()
        );
    }
}

#[test]
fn original_stored_file_array_call_is_source_inventory_without_native_admission() {
    let source = CHAT
        .replace(
            "prompt:TextMessage.content)",
            "prompt:TextMessage.content,attachments:file[]=[])",
        )
        .replace(
            "call ask {branch,prompt=turn.content} as run",
            "call ask {branch,prompt=turn.content,attachments=turn.attachments} as run",
        );
    let (db, ir) = lowered(&source);
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
        ScenarioDisclosure::Declined(_)
    ));
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        collect_static_scenario_calls(&ir, parent, &emitted.operations, &db, &emitted.entry.path)
            .is_none()
    );
    assert!(
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == parent.canonical)
            .unwrap()
            .disclosure
            .is_none()
    );
}
