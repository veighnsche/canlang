//! Checked native dispatch correspondence for record email send inputs.
//! A guarded `send` whose arguments read a stored `email` field keeps the
//! same sealed Rule/occurrence correspondence as any other checked scalar:
//! the native recipe consumes the actual checked guard and occurrence, and
//! stale or foreign authority never publishes a dispatch recipe.
use canlang_compiler::analysis::CheckedProgram;
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    CheckedDecisionStage, DisclosureEffectKind, ScenarioDisclosure,
};
use canlang_compiler::analysis::{NodeKey, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_decisions::collect_decision_sources;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::path::{Path, PathBuf};

const SOURCE: &str = "app DispatchEmailInputs
use std {EmailV1 as Mail} from=deployment.mail
Given
 Member {email:email}
 policy Member read=members fields=email
When
 scenario notify(member:Member,enabled:bool) -> int by=members
  do
   send Mail.send {to=member.email,subject=\"Sealed dispatch\",body=\"Original lexical values\"} when=enabled as attempt
   return 1
Then
";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_owner_root() -> PathBuf {
    let public = Path::new("/Users/vince/Projects/canlang");
    if public
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        public.into()
    } else {
        root()
    }
}

fn native_catalog() -> PathBuf {
    native_owner_root().join("packages/cloudflare/dist/native-catalog.json")
}

fn fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    fixture_for(SOURCE)
}

fn fixture_for(source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("dispatch-email-inputs.can".into(), source.into());
    let path = native_catalog();
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

fn item<'a>(ir: &'a IrProgram, name: &str) -> &'a IrItem {
    ir.items.iter().find(|item| item.canonical == name).unwrap()
}

#[test]
fn guarded_send_with_record_email_input_keeps_sealed_dispatch() {
    let (db, program, ir, catalog) = fixture();
    let owner = item(&ir, "DispatchEmailInputs.notify");
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!(
            "email-input guarded SEND must disclose: {:?}",
            ir.scenario_disclosures[&owner.id]
        )
    };
    assert_eq!(proof.effects.len(), 1);
    let DisclosureEffectKind::Send {
        operation,
        deployment_binding,
        when: Some(when),
    } = &proof.effects[0].kind
    else {
        panic!("guarded SEND proof")
    };
    assert_eq!(operation, "std.EmailV1.send");
    assert_eq!(
        deployment_binding.as_deref(),
        Some("DispatchEmailInputs.Mail")
    );
    assert_eq!(
        SOURCE[when.start as usize..when.end as usize].trim(),
        "enabled"
    );
    let source = proof.source_facts.as_ref().unwrap();
    let sites: Vec<_> = source
        .decision_sites
        .as_ref()
        .unwrap()
        .iter()
        .filter(|site| site.stage == CheckedDecisionStage::SendDispatch)
        .collect();
    assert_eq!(sites.len(), 1);
    assert_eq!(sites[0].node, *when);
    assert_eq!(sites[0].statement, proof.effects[0].node);
    assert_eq!(sites[0].owner, owner.id);
    assert_eq!(sites[0].source.sha256, sha256_hex(SOURCE.as_bytes()));
    assert!(
        collect_decision_sources(&program, &ir, owner, &db, Some(&catalog)).is_some(),
        "sealed dispatch recipe must be collectible"
    );
    // Positive emission runs through the production CLI, the only path that
    // prepares the whole-program sealed Rule inventory.
    let scratch = tempfile::tempdir().unwrap();
    let source_path = scratch.path().join("dispatch-email-inputs.can");
    std::fs::write(&source_path, SOURCE.as_bytes()).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_catalog())
        .arg(&source_path)
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
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let rule = format!(
        "DispatchEmailInputs.notify.sendWhen.{}.",
        sha256_hex(SOURCE.as_bytes())
    );
    let callables = artifact["callables"].as_array().unwrap();
    assert!(
        callables.iter().any(|callable| callable["id"]
            .as_str()
            .is_some_and(|id| id.starts_with(&rule))
            && callable["kind"] == "rule"),
        "{callables:?}"
    );
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "DispatchEmailInputs.notify")
        .unwrap();
    let disclosure = operation["result"]["disclosure"].as_object().unwrap();
    let dependencies = disclosure["returns"].as_array().unwrap();
    assert!(
        dependencies.iter().any(|returned| returned["dependencies"]
            .as_array()
            .unwrap()
            .iter()
            .any(|read| read["field"] == "email"
                && read["model"] == "DispatchEmailInputs.Member"
                && read["role"] == "data")),
        "{disclosure:?}"
    );
    let body = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    // Effects publish once, in source order, through the sealed Rule: one
    // deferred staging call carrying the checked occurrence identity.
    assert_eq!(body.matches("await send(").count(), 1, "{body}");
    assert!(body.contains(&format!("when:{{rule:\"{rule}")), "{body}");
    assert!(!body.contains("when:()=>"), "{body}");
    assert!(body.contains("sendGuards:"), "{body}");
    // The email read is a sealed receipt observation, never an inline value.
    assert!(body.contains("observeScenarioReceiptDependency"), "{body}");
    let send_at = body.find("await send(").unwrap();
    let returned_at = body.rfind("return ").unwrap();
    assert!(send_at < returned_at, "{body}");
}

#[test]
fn changed_email_dispatch_source_or_inputs_never_publish_recipe() {
    let (db, program, ir, catalog) = fixture();
    let owner = item(&ir, "DispatchEmailInputs.notify").id;
    assert!(
        collect_decision_sources(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &db,
            Some(&catalog)
        )
        .is_some()
    );
    let mut changed_source = SourceDb::new();
    changed_source.add(
        "dispatch-email-inputs.can".into(),
        SOURCE.replace("Sealed dispatch", "Changed dispatch"),
    );
    assert!(
        collect_decision_sources(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &changed_source,
            Some(&catalog)
        )
        .is_none(),
        "changed source text is stale authority"
    );
    for mode in [
        "guard-value",
        "guard-erased",
        "binding",
        "deployment",
        "input-value",
        "input-order",
    ] {
        let mut changed = ir.clone();
        {
            let effects = match &mut changed.items[owner.0 as usize].kind {
                IrItemKind::Scenario { effects, .. } => effects,
                _ => panic!("scenario"),
            };
            let IrStmt::Send {
                args,
                when,
                binding,
                deployment_binding,
                ..
            } = &mut effects[0]
            else {
                panic!("send")
            };
            match mode {
                "guard-value" => when.as_mut().unwrap().expr = IrExpr::Bool(true),
                "guard-erased" => *when = None,
                "binding" => *binding = Some("foreign".into()),
                "deployment" => *deployment_binding = Some("DispatchEmailInputs.Foreign".into()),
                "input-value" | "input-order" => {
                    let IrExpr::Object(inputs) = &mut args.expr else {
                        panic!("inputs")
                    };
                    if mode == "input-order" {
                        inputs.swap(0, 1);
                    } else {
                        inputs[0].1.expr = IrExpr::Text("other@example.test".into());
                    }
                }
                _ => unreachable!(),
            }
        }
        assert!(
            collect_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog)
            )
            .is_none(),
            "{mode}"
        );
        let raw = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            raw.operations
                .iter()
                .find(|operation| operation.name == "DispatchEmailInputs.notify")
                .unwrap()
                .disclosure
                .is_none(),
            "{mode}"
        );
        assert!(
            raw.diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}: {:?}",
            raw.diagnostics
        );
    }
}

#[test]
fn email_dependency_keeps_checked_scalar_identity() {
    let (db, program, ir, _catalog) = fixture();
    let owner = item(&ir, "DispatchEmailInputs.notify");
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!("disclosure")
    };
    let _ = (db, program);
    let returns: Vec<_> = proof.returns.iter().collect();
    assert!(!returns.is_empty());
    let read = returns
        .iter()
        .flat_map(|returned| returned.dependencies.iter())
        .find(|read| read.field_name == "email")
        .expect("email field dependency");
    assert_eq!(read.model_name, "DispatchEmailInputs.Member");
    assert_eq!(
        read.ty,
        canlang_compiler::analysis::ResolvedType::Scalar(Scalar::Email)
    );
    assert_eq!(read.type_id, "email");
    let _ = NodeKey {
        file: read.node.file,
        start: read.node.start,
        end: read.node.end,
        kind: read.node.kind,
    };
}

#[test]
fn trusted_model_loop_send_captures_original_versioned_item_and_refuses_changed_bindings() {
    let source = r#"app LoopDispatch
use std {EmailV1 as Mail} from=deployment.mail
Given
 Member {email:email,active:bool=true}
 event Notice {email:email}
When
 scenario notify on=Notice
  do
   for person in Member as candidate where candidate.email==event.email limit=1
    send Mail.send {to=person.email,subject="Original",body="Source bound"} when=person.active as delivery
Then
"#;
    let (db, program, original_ir, catalog) = fixture_for(source);
    let owner = item(&original_ir, "LoopDispatch.notify").id;
    assert!(
        collect_decision_sources(
            &program,
            &original_ir,
            &original_ir.items[owner.0 as usize],
            &db,
            Some(&catalog)
        )
        .is_some()
    );
    for mode in [
        "raw",
        "loop-binding",
        "guard",
        "payload",
        "trigger",
        "header",
    ] {
        let mut changed = original_ir.clone();
        let IrItemKind::Scenario {
            trusted,
            event_source,
            effects,
            ..
        } = &mut changed.items[owner.0 as usize].kind
        else {
            panic!("owner");
        };
        if mode == "trigger" {
            *event_source = Some(ir::IrEventSource::Declared("LoopDispatch.Foreign".into()));
        }
        if mode == "header" {
            *trusted = false;
        }
        let IrStmt::For { item, body, .. } = &mut effects[0] else {
            panic!("loop");
        };
        if mode == "loop-binding" {
            *item = "foreign".into();
        }
        let IrStmt::Send { when, args, .. } = &mut body[0] else {
            panic!("send");
        };
        if mode == "guard" {
            when.as_mut().unwrap().expr = IrExpr::Bool(true);
        }
        if mode == "payload" {
            let IrExpr::Object(fields) = &mut args.expr else {
                panic!("payload");
            };
            fields
                .iter_mut()
                .find(|(name, _)| name == "to")
                .unwrap()
                .1
                .expr = IrExpr::Text("foreign@example.test".into());
        }
        if !["raw", "trigger", "header"].contains(&mode) {
            assert!(
                collect_decision_sources(
                    &program,
                    &changed,
                    &changed.items[owner.0 as usize],
                    &db,
                    Some(&catalog)
                )
                .is_none(),
                "{mode}"
            );
        }
        let raw = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            raw.diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}: unprepared private source must refuse"
        );
    }
    let mut changed_source = SourceDb::new();
    changed_source.add(
        "dispatch-email-inputs.can".into(),
        source.replace("Source bound", "Substituted body"),
    );
    assert!(
        collect_decision_sources(
            &program,
            &original_ir,
            &original_ir.items[owner.0 as usize],
            &changed_source,
            Some(&catalog)
        )
        .is_none()
    );
    // Header and trigger correspondence belong to the complete private
    // preparation, not the narrower individual decision-site collector.
    // No editable raw IR acquires that prepared frame, even when its decisions
    // still match. A substituted original source is also rejected by the full
    // production emit driver before a private recipe can be installed.
    let mut result =
        canlang_compiler::diagnostic::DiagnosticResult::new("retained-send-source", "1.0", 1);
    result.add_sources(&changed_source);
    let (_, diagnostics) = canlang_compiler::codegen::emit(
        &program,
        &canlang_compiler::codegen::EmitSources {
            db: &changed_source,
            result: &result,
            catalog: Some(&catalog),
            options: canlang_compiler::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6011"),
        "{diagnostics:?}"
    );
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("loop-dispatch.can");
    for (name, text, accepted) in [
        ("original", source.to_string(), true),
        (
            "renamed",
            source
                .replace("person", "selected")
                .replace("candidate", "row"),
            true,
        ),
        ("unbounded", source.replace(" limit=1", ""), false),
        ("over-bound", source.replace("limit=1", "limit=201"), false),
        (
            "public",
            source
                .replace(
                    "scenario notify on=Notice",
                    "scenario notify(address:email) by=members",
                )
                .replace("event.email", "address"),
            false,
        ),
    ] {
        std::fs::write(&path, &text).unwrap();
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
            .args([
                "compile",
                "--native-scenario-receipts",
                "--format=json",
                "--catalog",
            ])
            .arg(native_catalog())
            .arg(&path)
            .current_dir(root())
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            accepted,
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if accepted {
            let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert!(
                artifact["operations"].as_array().unwrap().is_empty(),
                "private source publishes no operation"
            );
            let js = artifact["modules"][0]["js"].as_str().unwrap();
            let captured = if name == "renamed" {
                "selected"
            } else {
                "person"
            };
            assert!(js.contains(&format!("\"kind\":\"ref\",\"model\":\"LoopDispatch.Member\",\"name\":\"{captured}\",\"required\":true,\"versioned\":true")),"exact canonical versioned loop input");
            assert!(js.contains("retainedGuardedHandler"));
            assert!(
                js.contains("\"returns\":[]"),
                "source-only frame has no return path"
            );
            assert!(
                !js.contains("$receiptChoices"),
                "original owner body does not capture a result"
            );
        }
    }
}
