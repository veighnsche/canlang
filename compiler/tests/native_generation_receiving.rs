//! Byte-exact Images producer. Source/artifact correspondence grants no File,
//! receiving row identity, provider execution or rollback authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog, nominal_schema};
use canlang_compiler::analysis::resolve::SymbolId;
use canlang_compiler::analysis::scenario_disclosure::{
    DependencyRole, DisclosureEffectKind, ScenarioDisclosure,
};
use canlang_compiler::analysis::{ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType, TypedExpr,
};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str =
    include_str!("../../packages/cloudflare/test/fixtures/native-generation-receiving.can");
const OWNER: &str = "NativeGenerationReceiving.generate";

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

fn fixture() -> (SourceDb, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("native-generation-receiving.can".into(), SOURCE.into());
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
    (db, ir, catalog)
}

fn item<'a>(ir: &'a IrProgram, canonical: &str) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .unwrap()
}

fn effects_mut(ir: &mut IrProgram, owner: SymbolId) -> &mut Vec<IrStmt> {
    let IrItemKind::Scenario { effects, .. } = &mut ir.items[owner.0 as usize].kind else {
        panic!("scenario")
    };
    effects
}

fn object_mut(value: &mut TypedExpr) -> &mut Vec<(String, TypedExpr)> {
    let IrExpr::Object(fields) = &mut value.expr else {
        panic!("original constructor object")
    };
    fields
}

fn standard_schema(value: &TypedExpr, name: &str) {
    let ResolvedType::StdNominal {
        name: actual,
        fields,
    } = &value.ty
    else {
        panic!("original {name} must retain its owning standard nominal")
    };
    assert_eq!(*actual, name);
    let expected = nominal_schema(name).unwrap();
    assert_eq!(
        fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        expected
            .fields
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>()
    );
}

fn assert_refused(ir: &IrProgram, db: &SourceDb, mode: &str) {
    let emitted = js::emit_program_with_native_source_receipts(ir, true, db);
    assert!(
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == OWNER)
            .is_none_or(|operation| operation.disclosure.is_none()),
        "{mode}: original native disclosure survived"
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
fn original_images_graph_keeps_standard_schema_row_id_read_and_late_requirement_order() {
    let (db, ir, _) = fixture();
    let owner = item(&ir, OWNER);
    let job = item(&ir, "NativeGenerationReceiving.Job");
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!(
            "exact original Images void source needs Complete: {:?}",
            ir.scenario_disclosures[&owner.id]
        )
    };
    assert_eq!(proof.effects.len(), 2);
    assert!(matches!(&proof.effects[0].kind,
        DisclosureEffectKind::Send { operation, deployment_binding, when: None }
        if operation == "std.ImagesV1.submit" && deployment_binding.as_deref() == Some("NativeGenerationReceiving.Images")));
    assert!(matches!(
        proof.effects[1].kind,
        DisclosureEffectKind::Set { .. }
    ));
    assert_eq!(proof.source.path, "native-generation-receiving.can");
    assert_eq!(proof.source.sha256, sha256_hex(SOURCE.as_bytes()));
    let source = proof.source_facts.as_ref().unwrap();
    assert!(source.result.is_none());
    assert_eq!(
        source
            .parameters
            .iter()
            .map(|parameter| ir.items[parameter.parameter.0 as usize].name.as_str())
            .collect::<Vec<_>>(),
        ["job", "graph", "validation", "prompt", "revision", "accept"]
    );
    let IrItemKind::Scenario {
        guards,
        effects,
        result,
        ..
    } = &owner.kind
    else {
        panic!("scenario")
    };
    assert!(result.is_none());
    assert!(guards.is_empty());
    let [
        IrStmt::Let {
            name: workflow_name,
            value: workflow,
            span: workflow_span,
        },
        IrStmt::Let {
            name: value_name,
            value,
            span: value_span,
        },
        IrStmt::Send {
            args,
            binding,
            when: None,
            span: send_span,
            ..
        },
        IrStmt::Set {
            changes,
            span: set_span,
            ..
        },
        IrStmt::Require {
            cond,
            span: require_span,
        },
    ] = effects.as_slice()
    else {
        panic!("unchanged original body")
    };
    assert_eq!(workflow_name, "workflow");
    assert_eq!(value_name, "value");
    standard_schema(workflow, "WorkflowDefinition");
    standard_schema(value, "ImageRequest");
    let IrExpr::Object(workflow_fields) = &workflow.expr else {
        panic!("workflow")
    };
    assert_eq!(
        workflow_fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["graph", "prompt", "negative", "width", "height"]
    );
    assert!(matches!(&workflow_fields[0].1.expr, IrExpr::Name(name) if name == "graph"));
    assert_eq!(workflow_fields[0].1.ty, ResolvedType::Scalar(Scalar::File));
    for (_, input) in &workflow_fields[1..] {
        standard_schema(input, "WorkflowInput");
    }
    let IrExpr::Object(request_fields) = &value.expr else {
        panic!("request")
    };
    assert_eq!(
        request_fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        [
            "source",
            "revision",
            "workflow",
            "validation",
            "prompt",
            "negative",
            "width",
            "height",
            "max_outputs",
            "max_duration"
        ]
    );
    let source_value = &request_fields[0].1;
    assert_eq!(source_value.ty, ResolvedType::Scalar(Scalar::Text));
    assert!(matches!(&source_value.expr, IrExpr::Member { base, field }
        if field == "id" && matches!(&base.expr, IrExpr::Name(name) if name == "job")));
    let dependencies: Vec<_> = proof
        .returns
        .iter()
        .flat_map(|returned| &returned.dependencies)
        .filter(|dependency| {
            dependency.node.start == source_value.span.start
                && dependency.node.end == source_value.span.end
        })
        .collect();
    assert!(!dependencies.is_empty());
    for dependency in dependencies {
        assert_eq!(dependency.model, job.id);
        assert_eq!(dependency.field, job.id);
        assert_eq!(dependency.model_name, job.canonical);
        assert_eq!(dependency.field_name, "id");
        assert_eq!(dependency.type_id, "text");
        assert_eq!(dependency.ty, ResolvedType::Scalar(Scalar::Text));
        assert_eq!(dependency.role, DependencyRole::Data);
        assert_eq!(dependency.source.path, "native-generation-receiving.can");
        assert_eq!(dependency.source.sha256, sha256_hex(SOURCE.as_bytes()));
        assert_eq!(
            &SOURCE[dependency.node.start as usize..dependency.node.end as usize],
            "job.id"
        );
    }
    assert_eq!(binding.as_deref(), Some("attempt"));
    assert!(matches!(&args.expr, IrExpr::Object(fields)
        if fields.len() == 1 && fields[0].0 == "value" && matches!(&fields[0].1.expr, IrExpr::Name(name) if name == "value")));
    assert!(matches!(&changes.expr, IrExpr::Object(fields)
        if fields.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>() == ["request", "revision"]));
    assert!(matches!(&cond.expr, IrExpr::Name(name) if name == "accept"));
    assert!(
        workflow_span.end <= value_span.start
            && value_span.end <= send_span.start
            && send_span.end <= set_span.start
            && set_span.end <= require_span.start
    );
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    let operation = emitted
        .operations
        .iter()
        .find(|operation| operation.name == OWNER)
        .unwrap();
    assert_eq!(operation.result.as_deref(), Some("void"));
    assert!(operation.disclosure.is_some());
}

#[test]
fn original_images_constructor_source_schema_types_bindings_and_dependency_mutants_refuse() {
    let (db, ir, _) = fixture();
    let owner = item(&ir, OWNER).id;
    let job = item(&ir, "NativeGenerationReceiving.Job").id;
    let graph = item(&ir, "NativeGenerationReceiving.generate.graph").id;
    // Freshly check the unchanged original before any refusal, rather than
    // qualifying mutants on an already unsupported baseline.
    let baseline = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        baseline.diagnostics.is_empty(),
        "{:?}",
        baseline.diagnostics
    );
    assert!(
        baseline
            .operations
            .iter()
            .find(|operation| operation.name == OWNER)
            .unwrap()
            .disclosure
            .is_some()
    );
    let mut foreign = SourceDb::new();
    foreign.add(
        "native-generation-receiving.can".into(),
        SOURCE.replace("node=\"6\"", "node=\"8\""),
    );
    assert_refused(&ir, &foreign, "changed original source");
    for mode in [
        "foreign-constructor",
        "anonymous-constructor",
        "schema-member-type",
        "schema-order",
        "constructor-drop",
        "constructor-order",
        "nested-input-value",
        "nested-input-key",
        "request-width-literal",
        "request-entry-order",
        "request-let-substitution",
        "graph-binding",
        "graph-type",
        "source-member",
        "source-receiver",
        "source-type",
        "prefix-binding",
        "prefix-drop",
        "send-binding",
        "send-input",
        "statement-order",
        "late-require",
        "parameter-name",
        "parameter-type",
        "parameter-owner",
        "model-canonical",
        "dependency-source",
        "dependency-field",
        "dependency-type",
        "effect-target",
    ] {
        let mut changed = ir.clone();
        if matches!(
            mode,
            "parameter-name" | "parameter-type" | "parameter-owner"
        ) {
            let parameter = &mut changed.items[graph.0 as usize];
            if mode == "parameter-name" {
                parameter.name = "prompt".into();
            } else if let IrItemKind::Param { ty, owner, .. } = &mut parameter.kind {
                if mode == "parameter-type" {
                    *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
                } else {
                    *owner = job;
                }
            } else {
                panic!("graph parameter");
            }
        } else if mode == "model-canonical" {
            changed.items[job.0 as usize].canonical = "Foreign.Job".into();
        } else if matches!(
            mode,
            "dependency-source" | "dependency-field" | "dependency-type" | "effect-target"
        ) {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("source proof")
            };
            if mode == "effect-target" {
                let DisclosureEffectKind::Send { operation, .. } = &mut proof.effects[0].kind
                else {
                    panic!("send proof")
                };
                *operation = "std.ImagesV1.validate".into();
            } else {
                for dependency in proof
                    .returns
                    .iter_mut()
                    .flat_map(|returned| &mut returned.dependencies)
                    .filter(|dependency| dependency.field_name == "id")
                {
                    match mode {
                        "dependency-source" => dependency.source.sha256 = "0".repeat(64),
                        "dependency-field" => dependency.field_name = "label".into(),
                        "dependency-type" => {
                            dependency.type_id = "int".into();
                            dependency.ty = ResolvedType::Scalar(Scalar::Int);
                        }
                        _ => unreachable!(),
                    }
                }
            }
        } else {
            let effects = effects_mut(&mut changed, owner);
            match mode {
                "prefix-drop" => {
                    effects.remove(0);
                }
                "statement-order" => effects.swap(3, 4),
                "prefix-binding" => {
                    let IrStmt::Let { name, .. } = &mut effects[0] else {
                        panic!("workflow let")
                    };
                    *name = "foreign".into();
                }
                "send-binding" | "send-input" => {
                    let IrStmt::Send { args, binding, .. } = &mut effects[2] else {
                        panic!("send")
                    };
                    if mode == "send-binding" {
                        *binding = Some("foreign".into());
                    } else {
                        object_mut(args)[0].1.expr = IrExpr::Name("workflow".into());
                    }
                }
                "late-require" => {
                    let IrStmt::Require { cond, .. } = &mut effects[4] else {
                        panic!("late require")
                    };
                    cond.expr = IrExpr::Bool(true);
                }
                "request-width-literal" | "request-entry-order" | "request-let-substitution" => {
                    let IrStmt::Let { value, .. } = &mut effects[1] else {
                        panic!("request let")
                    };
                    if mode == "request-let-substitution" {
                        value.expr = IrExpr::Name("workflow".into());
                    } else {
                        let entries = object_mut(value);
                        if mode == "request-entry-order" {
                            entries.swap(6, 7);
                        } else {
                            let (_, width) = entries
                                .iter_mut()
                                .find(|(name, _)| name == "width")
                                .unwrap();
                            assert!(matches!(width.expr, IrExpr::Int(512)));
                            // Keep the exact original source span and int type.
                            width.expr = IrExpr::Int(513);
                        }
                    }
                }
                "source-member" | "source-receiver" | "source-type" => {
                    let IrStmt::Let { value, .. } = &mut effects[1] else {
                        panic!("request let")
                    };
                    let value = &mut object_mut(value)[0].1;
                    if mode == "source-type" {
                        value.ty = ResolvedType::Scalar(Scalar::Int);
                    } else {
                        let IrExpr::Member { base, field } = &mut value.expr else {
                            panic!("job.id")
                        };
                        if mode == "source-member" {
                            *field = "label".into();
                        } else {
                            base.expr = IrExpr::Name("foreign".into());
                        }
                    }
                }
                _ => {
                    let IrStmt::Let { value, .. } = &mut effects[0] else {
                        panic!("workflow let")
                    };
                    match mode {
                        "foreign-constructor" => {
                            let ResolvedType::StdNominal { name, .. } = &mut value.ty else {
                                panic!("std")
                            };
                            *name = "ImageRequest";
                        }
                        "anonymous-constructor" => {
                            let ResolvedType::StdNominal { fields, .. } = &value.ty else {
                                panic!("std")
                            };
                            value.ty = ResolvedType::Object(fields.clone());
                        }
                        "schema-member-type" => {
                            let ResolvedType::StdNominal { fields, .. } = &mut value.ty else {
                                panic!("std")
                            };
                            fields[0].1 = ResolvedType::Scalar(Scalar::Text);
                        }
                        "schema-order" => {
                            let ResolvedType::StdNominal { fields, .. } = &mut value.ty else {
                                panic!("std")
                            };
                            fields.swap(1, 2);
                        }
                        "constructor-drop" => {
                            object_mut(value).pop();
                        }
                        "constructor-order" => object_mut(value).swap(1, 2),
                        "nested-input-value" | "nested-input-key" => {
                            let entries = object_mut(&mut object_mut(value)[1].1);
                            let index = if mode == "nested-input-value" { 0 } else { 1 };
                            assert!(matches!(&entries[index].1.expr, IrExpr::Text(original)
                                if original == if index == 0 { "6" } else { "text" }));
                            // Both changes preserve original source spans and text types.
                            entries[index].1.expr =
                                IrExpr::Text(if index == 0 { "8" } else { "seed" }.into());
                        }
                        "graph-binding" => {
                            object_mut(value)[0].1.expr = IrExpr::Name("prompt".into())
                        }
                        "graph-type" => {
                            object_mut(value)[0].1.ty = ResolvedType::Scalar(Scalar::Text)
                        }
                        _ => unreachable!("{mode}"),
                    }
                }
            }
        }
        assert_refused(&changed, &db, mode);
    }
}

#[test]
fn actual_cli_images_artifact_and_verified_factory_keep_schema_identity_and_once_order() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("native-generation-receiving.can");
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
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(artifact["sources"][0]["path"], source.to_str().unwrap());
    assert_eq!(
        artifact["sources"][0]["sha256"],
        sha256_hex(SOURCE.as_bytes())
    );
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == OWNER)
        .unwrap();
    assert_eq!(operation["result"]["type"], "void");
    let disclosure = &operation["result"]["disclosure"];
    assert_eq!(disclosure["source"]["path"], source.to_str().unwrap());
    assert_eq!(
        disclosure["source"]["sha256"],
        sha256_hex(SOURCE.as_bytes())
    );
    let dependencies: Vec<_> = disclosure["returns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|returned| returned["dependencies"].as_array().unwrap())
        .filter(|dependency| dependency["field"] == "id")
        .collect();
    assert!(!dependencies.is_empty());
    for dependency in dependencies {
        assert_eq!(dependency["model"], "NativeGenerationReceiving.Job");
        assert_eq!(dependency["type"], "text");
        assert_eq!(dependency["role"], "data");
    }
    let contracts = artifact["valueTypes"]["contracts"].as_array().unwrap();
    for name in ["WorkflowInput", "WorkflowDefinition", "ImageRequest"] {
        let schema = contracts
            .iter()
            .find(|contract| contract["name"] == name)
            .unwrap();
        let expected = nominal_schema(name).unwrap();
        assert_eq!(
            schema["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|field| (
                    field["name"].as_str().unwrap(),
                    field["type"].as_str().unwrap()
                ))
                .collect::<Vec<_>>(),
            expected
                .fields
                .iter()
                .map(|(name, declared)| (
                    *name,
                    if *declared == "CanDuration" {
                        "duration"
                    } else {
                        *declared
                    }
                ))
                .collect::<Vec<_>>()
        );
    }
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let runner = scratch.path().join("native-generation-receiving.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const nativeRequire=createRequire(resolve(process.argv[6],'package.json'));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(nativeRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const callable=artifact.callables.find(callable=>callable.id==='NativeGenerationReceiving.generate');
assert.equal(callable.kind,'operation');assert.equal(callable.inputStyle,'parameters');
const module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
let handler=factory;for(const member of callable.member)handler=handler[member];assert.equal(typeof handler,'function');
const body=handler.toString(),workflow=body.indexOf(' = {graph:'),value=body.indexOf(' = {source:');
const sent=body.indexOf('await send('),written=body.indexOf('await set('),required=body.indexOf('check(',written),returned=body.lastIndexOf('selectScenarioReceiptReturn(');
assert.ok(workflow>=0&&workflow<value&&value<sent&&sent<written&&written<required&&required<returned,body);
assert.equal((body.match(/\bawait send\(/g)||[]).length,1);assert.equal((body.match(/\bawait set\(/g)||[]).length,1);
assert.equal((body.match(/\bconst [\w$]+ = \{graph:/g)||[]).length,1);assert.equal((body.match(/\bconst [\w$]+ = \{source:/g)||[]).length,1);
assert.equal((body.match(/\["id"\]/g)||[]).length,1);assert.equal(body.includes('when:'),false);
assert.equal(Object.hasOwn(module.appDefinition.operations['NativeGenerationReceiving.generate'],'sendGuards'),false);
// Import the genuine module/factory only. Never execute a fabricated job/File
// context or substitute for Dev's pending native id/File receiving joins.
console.log('Byte-exact Images CLI/schema/source/verified factory once-order; native row/File/receiving/rollback unqualified');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact_path)
        .arg(&source)
        .arg(scratch.path().join("modules"))
        .arg(native_owner_root())
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

#[test]
fn cli_builtin_call_in_body_keeps_first_query_receipt() {
    let scratch = tempfile::tempdir().unwrap();
    let source_path = scratch.path().join("first-query-builtin-call.can");
    let source = "app T3\nGiven\n Budget {account:user,active:bool,running:int=0,parallel:int=1}\n Run {budget:Budget,label:text}\n policy Budget read=members\n policy Run read=members\nWhen\n crud Budget by=members fields=account,active,running,parallel\n crud Run by=members fields=budget,label\n scenario pick(label:text=\"x\") -> Run by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and budget.active\n   let note=trim(label)\n   create Run {budget,label=note} as run\n   return run\nThen\n";
    std::fs::write(&source_path, source.as_bytes()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
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
        "builtin call beside first() must keep native receipt: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn cli_derive_call_in_body_keeps_first_query_receipt() {
    let scratch = tempfile::tempdir().unwrap();
    let source_path = scratch.path().join("first-query-derive-call.can");
    let source = "app T4\nGiven\n Conversation {account:user,active:bool}\n Budget {account:user,active:bool,running:int=0,parallel:int=1}\n Run {budget:Budget,conversation:Conversation,label:text}\n policy Conversation read=members\n policy Budget read=members\n policy Run read=members\n derive can_use(person:user?,conversation:Conversation):bool = person!=null and conversation.account==person and conversation.active\nWhen\n crud Conversation by=members fields=account,active\n crud Budget by=members fields=account,active,running,parallel\n crud Run by=members fields=budget,conversation,label\n scenario pick(conversation:Conversation,label:text=\"x\") -> Run by=members\n  require can_use(actor,conversation)\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and budget.active\n   create Run {budget,conversation,label} as run\n   return run\nThen\n";
    std::fs::write(&source_path, source.as_bytes()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
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
        "derive call beside first() must keep native receipt: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
