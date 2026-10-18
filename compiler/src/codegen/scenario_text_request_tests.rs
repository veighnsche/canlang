//! Exact original constructor correspondence and checked receipt admission.
use super::*;
use crate::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use crate::analysis::scenario_disclosure::{CheckedScenarioCreate, CheckedScenarioDisclosure};
use crate::analysis::{CheckedProgram, check_program};
use crate::codegen::{EmitOptions, EmitSources, emit};
use crate::diagnostic::DiagnosticResult;
use std::path::Path;

const SOURCE: &str = include_str!("../../tests/fixtures/source-text-request.can");
const HASH: &str = "f1e2b2aa7581a73de310d7ac9f140e6e46083ee29b7dca37854ddb3d9b39e69d";
const OWNER: &str = "SourceTextRequest.compose";

fn fixture(source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("source-text-request.can".into(), source.into());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/profile-native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}
fn owner(ir: &IrProgram) -> &IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == OWNER)
        .unwrap()
}
fn source(ir: &IrProgram) -> (&CheckedScenarioDisclosure, &CheckedScenarioCreate) {
    let ScenarioDisclosure::Complete(checked) = &ir.scenario_disclosures[&owner(ir).id] else {
        panic!("actual source must be Complete")
    };
    let [original] = checked
        .source_facts
        .as_ref()
        .unwrap()
        .creates
        .as_deref()
        .unwrap()
    else {
        panic!("one real scenario-owned Create")
    };
    (checked, original)
}

#[test]
fn original_eight_entry_request_and_messages_are_checked_before_same_created_run_return() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let original_chat = include_str!("../../tests/fixtures/original-a850/CanChat.can");
    assert!(original_chat.contains("let value=TextRequest {source=operation.id,revision=1,profile=branch.profile.provider_key,policy_revision=branch.profile.policy_revision,messages,max_input_tokens=branch.profile.input_tokens,max_output_tokens=branch.profile.output_tokens,max_duration=branch.profile.duration}"));
    let (db, _, ir, _) = fixture(SOURCE);
    let (checked, original) = source(&ir);
    assert_eq!(checked.source.sha256, HASH);
    assert_eq!(checked.effects.len(), 1);
    assert_eq!(checked.returns.len(), 1);
    assert_eq!(original.binding, "run");
    assert_eq!(original.inputs.len(), 1);
    assert_eq!(original.inputs[0].name, "request_value");
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner(&ir).kind
    else {
        panic!("scenario")
    };
    assert!(guards.is_empty());
    let [
        IrStmt::Let {
            name: messages_name,
            value: messages,
            span: messages_span,
        },
        IrStmt::Let {
            name: value_name,
            value: request,
            span: request_span,
        },
        IrStmt::Create {
            input,
            binding,
            span: create_span,
            ..
        },
        IrStmt::Return {
            value: Some(returned),
            span: return_span,
        },
    ] = effects.as_slice()
    else {
        panic!("original once/evaluation source order")
    };
    assert_eq!(messages_name, "messages");
    assert_eq!(value_name, "value");
    assert!(
        messages_span.end <= request_span.start
            && request_span.end <= create_span.start
            && create_span.end <= return_span.start
    );
    let IrExpr::Array(messages) = &messages.expr else {
        panic!("genuine TextMessage array")
    };
    assert_eq!(messages.len(), 2);
    for message in messages {
        let ResolvedType::StdNominal { name, fields } = &message.ty else {
            panic!("actual std message")
        };
        assert_eq!(*name, "TextMessage");
        assert_eq!(
            fields
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["role", "content", "attachments"]
        );
        assert_eq!(
            fields[2].1,
            ResolvedType::Array {
                element: Box::new(ResolvedType::Scalar(Scalar::File)),
                ordered: true,
                nonempty: false
            }
        );
    }
    let ResolvedType::StdNominal {
        name,
        fields: schema,
    } = &request.ty
    else {
        panic!("actual std request")
    };
    assert_eq!(*name, "TextRequest");
    let IrExpr::Object(entries) = &request.expr else {
        panic!("checked std constructor")
    };
    let keys = [
        "source",
        "revision",
        "profile",
        "policy_revision",
        "messages",
        "max_input_tokens",
        "max_output_tokens",
        "max_duration",
    ];
    assert_eq!(
        entries
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        keys
    );
    assert_eq!(
        schema
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        keys
    );
    assert!(matches!(&entries[4].1.expr, IrExpr::Name(name) if name == "messages"));
    let shorthand = entries[4].1.span;
    assert_eq!(
        &SOURCE[shorthand.start as usize..shorthand.end as usize],
        "messages"
    );
    assert!(matches!(entries[1].1.expr, IrExpr::Int(1)));
    assert!(matches!(entries[5].1.expr, IrExpr::Int(8192)));
    assert!(matches!(entries[6].1.expr, IrExpr::Int(2048)));
    assert!(matches!(entries[7].1.expr, IrExpr::DurationMs(120000)));
    assert!(
        matches!(&input.expr, IrExpr::Object(entries) if entries.len() == 1 && matches!(&entries[0].1.expr, IrExpr::Name(name) if name == "value"))
    );
    assert_eq!(binding.as_deref(), Some("run"));
    assert!(matches!(&returned.expr, IrExpr::Name(name) if name == "run"));
    assert!(
        checked.returns[0]
            .intrinsics
            .iter()
            .any(|intrinsic| matches!(intrinsic.kind, DisclosureIntrinsicKind::OperationId))
    );
    assert!(
        checked_created_statements(&ir, owner(&ir), checked, original, &db).is_some(),
        "real private statement consumer"
    );
    let models =
        super::super::js::Emitter::source_models(&ir, &db).expect("sealed owning nominal schema");
    assert!(
        super::super::scenario_create_sources::checked_created_schema(
            &ir,
            owner(&ir),
            &models,
            original,
            &db, None
        )
        .is_some(),
        "actual owning field/descriptor correspondence"
    );
}

#[test]
fn constructor_literal_schema_entries_shorthand_capture_and_foreign_import_edits_refuse() {
    let (db, _, ir, _) = fixture(SOURCE);
    let (checked, original) = source(&ir);
    assert!(checked_created_statements(&ir, owner(&ir), checked, original, &db).is_some());
    for mode in [
        "literal",
        "revision",
        "entry-order",
        "drop",
        "duplicate",
        "shorthand",
        "capture",
        "nominal",
        "file-schema",
        "nested-literal",
        "import",
        "source-node",
    ] {
        let mut changed = ir.clone();
        if mode == "import" {
            changed.modules[0].imports[0].provider = "foreign".into();
        } else {
            let owner_id = owner(&changed).id;
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner_id.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "capture" {
                let IrStmt::Let { name, .. } = &mut effects[0] else {
                    panic!("messages")
                };
                *name = "copied".into();
            } else if mode == "nested-literal" {
                let IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!("messages")
                };
                let IrExpr::Array(elements) = &mut value.expr else {
                    panic!("array")
                };
                let IrExpr::Object(fields) = &mut elements[0].expr else {
                    panic!("TextMessage")
                };
                fields[1].1.expr = IrExpr::Text("Changed system".into());
            } else {
                let IrStmt::Let { value, .. } = &mut effects[1] else {
                    panic!("request")
                };
                if mode == "source-node" {
                    value.span.start += 1;
                } else if matches!(mode, "nominal" | "file-schema") {
                    let ResolvedType::StdNominal { name, fields } = &mut value.ty else {
                        panic!("std")
                    };
                    if mode == "nominal" {
                        *name = "ForeignTextRequest";
                    } else {
                        let ResolvedType::Array { element, .. } = &mut fields[4].1 else {
                            panic!("messages")
                        };
                        let ResolvedType::StdNominal { fields, .. } = element.as_mut() else {
                            panic!("message")
                        };
                        fields[2].1 = ResolvedType::Array {
                            element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                            ordered: true,
                            nonempty: false,
                        };
                    }
                } else {
                    let IrExpr::Object(fields) = &mut value.expr else {
                        panic!("entries")
                    };
                    match mode {
                        "literal" => fields[2].1.expr = IrExpr::Text("Changed profile".into()),
                        "revision" => fields[1].1.expr = IrExpr::Int(2),
                        "entry-order" => fields.swap(2, 3),
                        "drop" => {
                            fields.pop().unwrap();
                        }
                        "duplicate" => fields[3].0 = "profile".into(),
                        "shorthand" => fields[4].1.expr = IrExpr::Name("value".into()),
                        _ => unreachable!(),
                    }
                }
            }
        }
        assert!(
            checked_created_statements(&changed, owner(&changed), checked, original, &db).is_none(),
            "{mode}"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "source-text-request.can".into(),
        SOURCE.replace("source-profile", "source-changed"),
    );
    assert!(
        checked_created_statements(&ir, owner(&ir), checked, original, &stale).is_none(),
        "original source identity"
    );
    // A constructor admitted in original explicit operands cannot be moved
    // into an owning model default under a mutable IR declaration.
    let mut defaulted = ir.clone();
    let request = match &owner(&ir).kind {
        IrItemKind::Scenario { effects, .. } => match &effects[1] {
            IrStmt::Let { value, .. } => value.clone(),
            _ => panic!("request"),
        },
        _ => panic!("scenario"),
    };
    let field = original.definition.fields[0].field;
    let IrItemKind::Field { default, .. } = &mut defaulted.items[field.0 as usize].kind else {
        panic!("field")
    };
    *default = Some(IrDefault::Literal(request));
    let models = super::super::js::Emitter::source_models(&defaulted, &db)
        .expect("unchanged nominal inventory");
    assert!(
        super::super::scenario_create_sources::checked_created_schema(
            &defaulted,
            owner(&defaulted),
            &models,
            original,
            &db, None
        )
        .is_none(),
        "operand constructor cannot authorize a new default scope"
    );
}

#[test]
fn source_sealing_publishes_checked_request_receipt_without_native_file_authority() {
    let (db, program, ir, catalog) = fixture(SOURCE);
    let (checked, original) = source(&ir);
    assert!(
        checked_created_statements(&ir, owner(&ir), checked, original, &db).is_some(),
        "source matcher positive before checked receipt emission"
    );
    let raw = super::super::js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        !raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "released checked TextRequest nominal receiving: {:?}",
        raw.diagnostics
    );
    assert!(
        raw.operations
            .iter()
            .find(|operation| operation.name == OWNER)
            .unwrap()
            .disclosure
            .is_some(),
        "checked constructor publishes a recipe; execution and File authority remain native"
    );
    let mut result = DiagnosticResult::new("text-request-source", "1.0", 1);
    result.add_sources(&db);
    let (_, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(
        !diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "released public preparation: {diagnostics:?}"
    );
}
