//! Test-authored bounded created-row/guarded Email source schema. Installed
//! descriptors and emitted wiring grant no dispatch, current row or rollback authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    CheckedDecisionStage, DependencyRole, DisclosureEffectKind, ScenarioDisclosure,
};
use canlang_compiler::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_decisions::collect_decision_sources;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/native-created-guarded-email.can");
const OWNER: &str = "CreatedGuardedEmail.deliver";
const MODEL: &str = "CreatedGuardedEmail.Entry";

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
    fixture_source(SOURCE)
}

fn fixture_source(source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("native-created-guarded-email.can".into(), source.into());
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

fn item<'a>(ir: &'a IrProgram, canonical: &str) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .unwrap()
}

fn effects_mut(owner: &mut IrItem) -> &mut Vec<IrStmt> {
    let IrItemKind::Scenario { effects, .. } = &mut owner.kind else {
        panic!("owning scenario")
    };
    effects
}

fn object_mut(expr: &mut ir::TypedExpr) -> &mut Vec<(String, ir::TypedExpr)> {
    let IrExpr::Object(fields) = &mut expr.expr else {
        panic!("authored object")
    };
    fields
}

fn prepared_artifact(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (Value, Vec<Diagnostic>) {
    use canlang_compiler::codegen::artifact::to_json;
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    let mut result = DiagnosticResult::new("created-guarded-source", "1.0", 1);
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

#[test]
fn void_created_guarded_send_keeps_order_and_does_not_invent_model_return() {
    let source = SOURCE
        .replace(" -> Entry", "")
        .replace("   return entry\n", "");
    let source = source.replace("attempt:delivery", "link:Entry?,fresh_link:Entry?,attempt:delivery")
        .replace("deliver(enabled", "deliver(existing:Entry,enabled")
        .replace("count=entry.count+1", "count=entry.count+1,link=existing,fresh_link=entry")
        .replace("subject=\"Created guarded Email\"", "subject=format(\"Created guarded Email\"@{nl=\"Oorspronkelijke melding\"},locale=null)");
    let (db, program, ir, catalog) = fixture_source(&source);
    let owner = item(&ir, OWNER);
    assert!(matches!(
        &owner.kind,
        IrItemKind::Scenario { result: None, .. }
    ));
    let ScenarioDisclosure::Complete(checked) = &ir.scenario_disclosures[&owner.id] else {
        panic!("{:?}", ir.scenario_disclosures[&owner.id]);
    };
    assert!(checked.source_facts.as_ref().unwrap().result.is_none());
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == OWNER)
        .unwrap();
    assert_ne!(
        operation["result"]["type"], MODEL,
        "no automatic created-model return: {operation}"
    );
    for mode in ["variant", "source-language", "formal"] {
        let mut changed = ir.clone();
        let effects = effects_mut(&mut changed.items[owner.id.0 as usize]);
        let IrStmt::Send { args, .. } = &mut effects[2] else {
            panic!("Send")
        };
        let subject = &mut object_mut(args)
            .iter_mut()
            .find(|(name, _)| name == "subject")
            .unwrap()
            .1;
        let IrExpr::Format {
            args,
            descriptor_index,
            locale_index,
            schemas,
        } = &mut subject.expr
        else {
            panic!("Format")
        };
        match mode {
            "formal" => std::mem::swap(descriptor_index, locale_index),
            "source-language" => schemas[0].source_lang = "fr".into(),
            _ => {
                let IrExpr::Message(message) = &mut args[*descriptor_index].expr else {
                    panic!("Message")
                };
                message.variants[0].1 = Some("Changed subject".into());
            }
        }
        assert!(
            collect_decision_sources(
                &program,
                &changed,
                &changed.items[owner.id.0 as usize],
                &db,
                Some(&catalog)
            )
            .is_none(),
            "{mode}"
        );
    }
    let copied = source
        .replace(
            "   create Entry {count=0} as entry",
            "   let copied=existing\n   create Entry {count=0} as entry",
        )
        .replace("link=existing", "link=copied");
    let (_, _, copied_ir, _) = fixture_source(&copied);
    assert!(
        matches!(
            copied_ir
                .scenario_disclosures
                .get(&item(&copied_ir, OWNER).id),
            Some(ScenarioDisclosure::Declined(_))
        ),
        "copied model input cannot become a SET reference"
    );
    let linked = source.replace(
        "   require accept",
        "   create Entry {count=0,link=entry} as receipt\n   require accept",
    );
    let (db, program, ir, catalog) = fixture_source(&linked);
    let owner = item(&ir, OWNER);
    assert!(collect_decision_sources(&program, &ir, owner, &db, Some(&catalog)).is_some());
    let mut changed = ir.clone();
    let effects = effects_mut(&mut changed.items[owner.id.0 as usize]);
    let IrStmt::Create { input, .. } = &mut effects[4] else {
        panic!("second Create")
    };
    let link = &mut object_mut(input)
        .iter_mut()
        .find(|(name, _)| name == "link")
        .unwrap()
        .1;
    link.expr = IrExpr::Name("existing".into());
    assert!(
        collect_decision_sources(
            &program,
            &changed,
            &changed.items[owner.id.0 as usize],
            &db,
            Some(&catalog)
        )
        .is_none(),
        "same-type parameter cannot replace original earlier CreateAs"
    );
}

#[test]
fn created_entry_then_guarded_send_retains_model_return_and_exact_written_order() {
    let (db, program, ir, catalog) = fixture();
    let owner = item(&ir, OWNER);
    let entry = item(&ir, MODEL);
    let count_field = item(&ir, "CreatedGuardedEmail.Entry.count");
    let attempt_field = item(&ir, "CreatedGuardedEmail.Entry.attempt");
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!(
            "bounded created-row guarded SEND must be Complete: {:?}",
            ir.scenario_disclosures[&owner.id]
        )
    };
    let facts = proof.source_facts.as_ref().unwrap();
    assert_eq!(
        facts.result,
        Some(ResolvedType::Record {
            symbol: entry.id,
            stored: true
        })
    );
    assert_eq!(facts.source.path, "native-created-guarded-email.can");
    assert_eq!(facts.source.sha256, sha256_hex(SOURCE.as_bytes()));
    assert_eq!(facts.source.module, "CreatedGuardedEmail");
    assert!(facts.calls.is_empty());
    assert!(facts.queries.as_ref().is_none_or(Vec::is_empty));
    assert_eq!(
        facts
            .parameters
            .iter()
            .map(|parameter| &parameter.ty)
            .collect::<Vec<_>>(),
        vec![
            &ResolvedType::Scalar(Scalar::Bool),
            &ResolvedType::Scalar(Scalar::Bool)
        ]
    );
    assert!(
        facts
            .parameters
            .iter()
            .all(|parameter| parameter.default.is_none())
    );
    let creates = facts.creates.as_ref().unwrap();
    assert_eq!(creates.len(), 1);
    let created = &creates[0];
    assert_eq!(created.model, entry.id);
    assert_eq!(created.binding, "entry");
    assert_eq!(created.source, facts.source);
    assert_eq!(created.definition.canonical, MODEL);
    assert_eq!(
        created
            .definition
            .fields
            .iter()
            .map(|field| field.name.as_str())
            .collect::<Vec<_>>(),
        ["count", "attempt"]
    );
    assert_eq!(created.inputs.len(), 1);
    assert_eq!(created.inputs[0].name, "count");
    assert_eq!(created.inputs[0].field, Some(count_field.id));
    assert_eq!(created.inputs[0].ty, ResolvedType::Scalar(Scalar::Int));
    let text = |node: NodeKey| {
        let source = db.get(node.file).unwrap();
        source.text[node.start as usize..node.end as usize]
            .trim()
            .to_owned()
    };
    assert_eq!(text(created.inputs[0].value_node), "0");
    let [create, first_set, send, last_set] = proof.effects.as_slice() else {
        panic!("exact Create/Set/Send/Set effect inventory")
    };
    assert!(
        matches!(&create.kind, DisclosureEffectKind::Create { model, binding, inputs, .. }
        if *model == entry.id && binding == "entry" && inputs.len() == 1)
    );
    assert!(
        matches!(&first_set.kind, DisclosureEffectKind::Set { model, fields, .. }
        if *model == entry.id && fields == &vec![count_field.id])
    );
    let DisclosureEffectKind::Send {
        operation,
        deployment_binding,
        when: Some(when),
    } = &send.kind
    else {
        panic!("exact guarded SEND")
    };
    assert_eq!(operation, "std.EmailV1.send");
    assert_eq!(
        deployment_binding.as_deref(),
        Some("CreatedGuardedEmail.Mail")
    );
    assert_eq!(text(*when), "enabled");
    assert!(
        matches!(&last_set.kind, DisclosureEffectKind::Set { model, fields, .. }
        if *model == entry.id && fields == &vec![attempt_field.id])
    );
    assert!(
        create.node.end <= first_set.node.start
            && first_set.node.end <= send.node.start
            && send.node.end <= last_set.node.start
    );
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner.kind
    else {
        panic!("scenario")
    };
    assert!(guards.is_empty());
    let [
        IrStmt::Create {
            input,
            binding: Some(binding),
            ..
        },
        IrStmt::Set {
            record: first_record,
            changes: first_changes,
            ..
        },
        IrStmt::Send {
            binding: Some(sent_binding),
            ..
        },
        IrStmt::Set {
            record: last_record,
            changes: last_changes,
            ..
        },
        IrStmt::Require {
            cond: accept,
            span: require_span,
        },
        IrStmt::Return {
            value: Some(returned),
            span: return_span,
        },
    ] = effects.as_slice()
    else {
        panic!("unchanged created guarded source body")
    };
    assert_eq!(binding, "entry");
    assert_eq!(sent_binding, "attempt");
    assert!(
        matches!(&input.expr, IrExpr::Object(fields) if fields.len() == 1 && fields[0].0 == "count" && matches!(fields[0].1.expr, IrExpr::Int(0)))
    );
    for record in [first_record, last_record, returned] {
        assert!(matches!(&record.expr, IrExpr::Name(name) if name == "entry"));
        assert_eq!(
            record.ty,
            ResolvedType::Record {
                symbol: entry.id,
                stored: true
            }
        );
    }
    assert!(
        matches!(&first_changes.expr, IrExpr::Object(fields) if fields.len() == 1 && fields[0].0 == "count")
    );
    assert!(
        matches!(&last_changes.expr, IrExpr::Object(fields) if fields.len() == 1 && fields[0].0 == "attempt" && matches!(&fields[0].1.expr, IrExpr::Name(name) if name == "attempt"))
    );
    assert!(matches!(&accept.expr, IrExpr::Name(name) if name == "accept"));
    assert!(last_set.node.end <= require_span.start && require_span.end <= return_span.start);
    assert_eq!(proof.returns.len(), 1);
    let returned = &proof.returns[0];
    assert!(
        returned.decisions.is_empty(),
        "SEND false never prunes the owning model return"
    );
    let count_reads = returned
        .dependencies
        .iter()
        .filter(|dependency| dependency.model == entry.id && dependency.field == count_field.id)
        .collect::<Vec<_>>();
    assert_eq!(count_reads.len(), 1);
    assert_eq!(count_reads[0].role, DependencyRole::Data);
    assert_eq!(text(count_reads[0].node), "entry.count");
    assert_eq!(count_reads[0].type_id, "int");
    let sites = collect_decision_sources(&program, &ir, owner, &db, Some(&catalog)).unwrap();
    assert_eq!(sites.len(), 2);
    assert_eq!(sites[0].stage, CheckedDecisionStage::SendDispatch);
    assert_eq!(sites[0].statement, send.node);
    assert_eq!(sites[0].node, *when);
    assert!(sites[0].calls.is_empty());
    assert_eq!(sites[1].stage, CheckedDecisionStage::BodyRequire);
    assert_eq!(text(sites[1].node), "accept");
}

#[test]
fn source_execution_and_owning_schema_mutants_never_publish_created_guarded_recipe() {
    let (db, program, ir, catalog) = fixture();
    let owner = item(&ir, OWNER).id;
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
    for mode in [
        "set-receiver",
        "set-operand",
        "attempt-receiver",
        "attempt-operand",
        "statement-order",
        "send-target",
        "send-input",
        "send-input-order",
        "guard",
        "guard-erased",
        "binding",
        "return",
        "create-input",
    ] {
        let mut changed = ir.clone();
        let effects = effects_mut(&mut changed.items[owner.0 as usize]);
        match mode {
            "statement-order" => effects.swap(1, 2),
            "set-receiver" | "set-operand" => {
                let IrStmt::Set {
                    record, changes, ..
                } = &mut effects[1]
                else {
                    panic!("first Set")
                };
                if mode == "set-receiver" {
                    record.expr = IrExpr::Name("attempt".into());
                } else {
                    let IrExpr::Binary { right, .. } = &mut object_mut(changes)[0].1.expr else {
                        panic!("increment")
                    };
                    right.expr = IrExpr::Int(2);
                }
            }
            "attempt-receiver" | "attempt-operand" => {
                let IrStmt::Set {
                    record, changes, ..
                } = &mut effects[3]
                else {
                    panic!("last Set")
                };
                if mode == "attempt-receiver" {
                    record.expr = IrExpr::Name("attempt".into());
                } else {
                    object_mut(changes)[0].1.expr = IrExpr::Name("entry".into());
                }
            }
            "create-input" => {
                let IrStmt::Create { input, .. } = &mut effects[0] else {
                    panic!("Create")
                };
                object_mut(input)[0].1.expr = IrExpr::Int(1);
            }
            "return" => {
                let IrStmt::Return {
                    value: Some(value), ..
                } = &mut effects[5]
                else {
                    panic!("Return")
                };
                value.expr = IrExpr::Name("attempt".into());
            }
            _ => {
                let IrStmt::Send {
                    operation,
                    args,
                    when,
                    binding,
                    ..
                } = &mut effects[2]
                else {
                    panic!("Send")
                };
                match mode {
                    "send-target" => *operation = "std.EmailV1.other".into(),
                    "send-input" => {
                        object_mut(args)[1].1.expr = IrExpr::Text("Changed guarded Email".into())
                    }
                    "send-input-order" => object_mut(args).swap(0, 1),
                    "guard" => when.as_mut().unwrap().expr = IrExpr::Bool(true),
                    "guard-erased" => *when = None,
                    "binding" => *binding = Some("foreign".into()),
                    _ => unreachable!(),
                }
            }
        }
        // Raw native emission is intentionally unprepared. The separate
        // correspondence refusal proves these mutants changed actual source
        // semantics; the CLI positive below exercises genuine preparation.
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
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == OWNER)
                .is_none_or(|operation| operation.disclosure.is_none()),
            "{mode}"
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
    let mut stale = SourceDb::new();
    stale.add(
        "native-created-guarded-email.can".into(),
        SOURCE.replace("Original request", "Modified request"),
    );
    assert!(
        collect_decision_sources(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &stale,
            Some(&catalog)
        )
        .is_none()
    );
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &stale);
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
            .find(|operation| operation.name == OWNER)
            .unwrap()
            .disclosure
            .is_none()
    );

    // The public codegen driver uses the genuine sealed guard preparer. These
    // editable checked declaration mutations must fail from a positive driver
    // baseline, independently of raw/unprepared IR refusal above.
    let (baseline, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        baseline["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == OWNER)
            .unwrap()["result"]["disclosure"]
            .is_object()
    );
    for canonical in [
        "CreatedGuardedEmail.Entry.count",
        "CreatedGuardedEmail.deliver.enabled",
    ] {
        let (db, mut program, ir, catalog) = fixture();
        let declaration = item(&ir, canonical).id;
        let altered_type = if canonical.ends_with(".count") {
            Scalar::Bool
        } else {
            Scalar::Int
        };
        program
            .types
            .symbol_types
            .insert(declaration, ResolvedType::Scalar(altered_type));
        let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{canonical}: {diagnostics:?}"
        );
        assert!(
            artifact["operations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|operation| operation["name"] == OWNER)
                .is_none_or(|operation| operation["result"]["disclosure"].is_null()),
            "{canonical}"
        );
    }
}

#[test]
fn actual_cli_verified_assembly_and_state_keep_created_model_guard_and_awaited_return_wiring() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("native-created-guarded-email.can");
    std::fs::write(&source, SOURCE.as_bytes()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_catalog())
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
    let runner = scratch.path().join("native-created-guarded-send.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const stdlibRequire=createRequire(resolve(process.argv[6],'package.json'));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(stdlibRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact),factory=module.canApp();
const loaded=loadArtifactDescriptors(artifact,{by:'members'}),name='CreatedGuardedEmail.deliver',modelName='CreatedGuardedEmail.Entry';
const operation=artifact.operations.find(operation=>operation.name===name),plan=operation.result.disclosure;
assert.equal(operation.result.type,modelName);assert.equal(plan.version,1);assert.equal(plan.returns.length,1);
assert.deepEqual(loaded.registry.get(name).descriptor.result.disclosure,plan);
assert.equal(loaded.registry.get(name).descriptor.result.type,modelName);
const model=artifact.models.find(model=>model.name===modelName);assert.deepEqual(model.fields.map(field=>field.name),['count','attempt']);
assert.deepEqual(model.fields[0].default,{kind:'literal',value:'0'});assert.deepEqual(model.fields[0].field,{kind:'integer'});assert.equal(model.fields[1].nullable,true);
assert.deepEqual(Object.keys(module.appDefinition.models[modelName].fields),['count','attempt']);
assert.deepEqual(artifact.operations.filter(operation=>operation.name.startsWith(modelName+'.')).map(operation=>operation.name),[modelName+'.read'],'only the original read policy is public on this created model');
const source=readFileSync(process.argv[4],'utf8'),sourceHash=createHash('sha256').update(source).digest('hex');
assert.equal(plan.source.path,process.argv[4]);assert.equal(plan.source.sha256,sourceHash);assert.equal(plan.source.module,artifact.modules[0].path);
const guards=module.appDefinition.operations[name].sendGuards;assert.equal(guards.length,1);const guard=guards[0];
assert.equal(guard.owner,name);assert.equal(guard.target,'std.EmailV1.send');assert.equal(guard.binding,'CreatedGuardedEmail.Mail');assert.equal(guard.sourceBinding,'attempt');
assert.equal(guard.source.path,process.argv[4]);assert.equal(guard.source.sha256,sourceHash);assert.equal(source.slice(guard.node.start,guard.node.end),'enabled');
assert.deepEqual(guard.inputs,[{name:'enabled',type:'bool'}]);assert.equal(guard.inputDeclaration.kind,'inputs');
for(const inputs of [guard.inputDeclaration.canonical,guard.inputDeclaration.artifact]) {
 assert.deepEqual(inputs.map(input=>input.name),['enabled']);assert.equal(inputs[0].required,true);assert.equal(Object.hasOwn(inputs[0],'default'),false);
}
assert.equal(guard.inputDeclaration.artifact[0].valueType,'bool');
const ruleCallable=artifact.callables.find(callable=>callable.id===guard.rule);assert.equal(ruleCallable.kind,'rule');assert.deepEqual(ruleCallable.member,['sendWhen',guard.rule]);
let rule=factory;for(const part of ruleCallable.member)rule=rule[part];assert.equal(typeof rule,'function');
const callable=artifact.callables.find(callable=>callable.id===name);let handler=factory;for(const part of callable.member)handler=handler[part];
assert.equal(module[callable.export],name);const body=handler.toString();
const once=pattern=>assert.equal((body.match(pattern)||[]).length,1);
once(/\bawait create\(/g);once(/\bawait send\(/g);once(/\bawait bindScenarioReceiptModelResult\(/g);once(/\bselectScenarioReceiptReturn\(/g);
assert.equal((body.match(/\bawait set\(/g)||[]).length,2);assert.equal((body.match(/\["count"\]/g)||[]).length,1);
const created=body.indexOf('await create('),firstSet=body.indexOf('await set('),sent=body.indexOf('await send('),lastSet=body.indexOf('await set(',firstSet+1);
const required=body.indexOf('check(',lastSet),bound=body.indexOf('await bindScenarioReceiptModelResult('),selected=body.indexOf('selectScenarioReceiptReturn('),returned=body.lastIndexOf('return ');
assert.ok(created>=0&&created<firstSet&&firstSet<sent&&sent<lastSet&&lastSet<required&&required<bound&&bound<selected&&selected<returned);
const binding=/\bconst ([$\w]+) = await create\(c,"CreatedGuardedEmail\.Entry"/.exec(body)?.[1];assert.ok(binding);
assert.equal(body.includes(`const $receiptValue=${binding};`),true,'same original created view is evaluated once before the awaited native binder');
assert.equal(body.includes('return $receiptModelResult;'),true);assert.equal(body.includes('when:{rule:'),true);assert.equal(body.includes('when:()=>'),false);
const writes=[...body.matchAll(/\bawait set\(c,([^,]+),/g)].map(match=>match[1]);assert.deepEqual(writes,[binding,binding]);
// Inspect genuine imported consumers only. No fabricated context/row or Rule
// execution can qualify true/false/skipped dispatch or late rollback.
console.log('Test-authored created guarded Email: actual CLI, verified factory and installed State preserve ModelReturn/Rule/once source order; native journey remains Dev-owned');
"#).unwrap();
    let output = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact)
        .arg(&source)
        .arg(scratch.path().join("modules"))
        .arg(native_owner_root())
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&output.stdout));
}
