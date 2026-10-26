//! Bounded original-purpose Run -> counted Turn -> same Run producer. Real
//! compiler/installed metadata checks issue no rows, contexts or grant authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{DisclosureEffectKind, ScenarioDisclosure};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrExpr, IrItem, IrItemKind, IrOwner, IrProgram, IrStmt, IrType,
};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_queries::serialize_complete_query_receipt;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/native-count-run-turn.can");
const HASH: &str = "7090d4f48984a925aed07b001dab6e68682da01ae81d1916ef40f6fc76cc76f3";
const OWNER: &str = "CreatedPair.append";
const ENTRY: &str = "$can$m$4372656174656450616972.mjs";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_owner() -> PathBuf {
    let primary = Path::new("/Users/vince/Projects/canlang");
    if primary
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        primary.into()
    } else {
        root()
    }
}

fn checked(source: &str, path: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let path = native_owner().join("packages/cloudflare/dist/native-catalog.json");
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

fn prepared(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (Value, Vec<Diagnostic>) {
    use canlang_compiler::codegen::artifact::to_json;
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    let mut result = DiagnosticResult::new("created-pair-source", "1.0", 1);
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

fn operation(artifact: &Value) -> &Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == OWNER)
        .unwrap()
}

fn compile_cli(source: &str, directory: &Path) -> (Value, PathBuf) {
    let path = directory.join("native-count-run-turn.can");
    std::fs::write(&path, source.as_bytes()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_owner().join("packages/cloudflare/dist/native-catalog.json"))
        .arg(&path)
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
    let artifact = serde_json::from_slice(&output.stdout).unwrap();
    std::fs::write(directory.join("artifact.json"), output.stdout).unwrap();
    (artifact, path)
}

fn assert_plan(plan: &Value, path: &str, hash: &str) {
    assert_eq!(plan["source"]["path"], path);
    assert_eq!(plan["source"]["sha256"], hash);
    let [query] = plan["queries"].as_array().unwrap().as_slice() else {
        panic!("sole count query")
    };
    assert_eq!(query["model"], "CreatedPair.Turn");
    assert_eq!(
        query["parent"],
        serde_json::json!({"source":plan["source"],"model":"CreatedPair.Branch",
        "origin":{"kind":"admitted-reference","parameter":"branch"}})
    );
    assert_eq!(query["source"], plan["source"]);
    assert_eq!(query["order"], serde_json::json!([]));
    assert!(query["limit"].is_null());
    assert_eq!(query["archived"], "exclude");
    assert_eq!(query["dependencies"], serde_json::json!([]));
    assert!(!plan["returns"].as_array().unwrap().is_empty());
    for returned in plan["returns"].as_array().unwrap() {
        assert_eq!(returned["source"], plan["source"]);
        assert!(returned["projection"].is_null());
        assert_eq!(
            returned["influences"]
                .as_array()
                .unwrap()
                .iter()
                .map(|influence| influence["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "query-existence",
                "query-cardinality",
                "query-membership",
                "query-order"
            ]
        );
        assert!(
            returned["influences"]
                .as_array()
                .unwrap()
                .iter()
                .all(|influence| influence["queryId"] == query["id"])
        );
    }
}

#[test]
fn genuine_two_creates_cli_factory_and_state_keep_counted_turn_and_original_run_return() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let (db, program, ir, catalog) = checked(SOURCE, "native-count-run-turn.can");
    let owner = item(&ir, OWNER);
    let branch = item(&ir, "CreatedPair.Branch").id;
    let run = item(&ir, "CreatedPair.Run").id;
    let turn = item(&ir, "CreatedPair.Turn").id;
    for child in [run, turn] {
        assert!(
            matches!(&ir.items[child.0 as usize].kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..} if *parent == branch)
        );
    }
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!("exact two-create source Complete")
    };
    let facts = proof.source_facts.as_ref().unwrap();
    assert_eq!(facts.source.sha256, HASH);
    assert_eq!(
        facts.result,
        Some(ResolvedType::Record {
            symbol: run,
            stored: true
        })
    );
    let [first, second] = facts.creates.as_ref().unwrap().as_slice() else {
        panic!("exact owning Create inventory")
    };
    assert_eq!((first.model, first.binding.as_str()), (run, "run"));
    assert_eq!((second.model, second.binding.as_str()), (turn, "turn"));
    assert_eq!(first.source, facts.source);
    assert_eq!(second.source, facts.source);
    assert_eq!(
        first
            .inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["parent", "marker"]
    );
    assert_eq!(
        second
            .inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["parent", "position", "run"]
    );
    assert_eq!(
        second.inputs[2].ty,
        ResolvedType::Record {
            symbol: run,
            stored: true
        }
    );
    let reference_node = second.inputs[2].value_node;
    assert_eq!(
        &db.get(reference_node.file).unwrap().text
            [reference_node.start as usize..reference_node.end as usize],
        "run"
    );
    assert!(first.node.end <= second.node.start);
    let [first_effect, second_effect] = proof.effects.as_slice() else {
        panic!("two effect proofs")
    };
    assert!(
        matches!(&first_effect.kind,DisclosureEffectKind::Create{model,binding,..} if *model == run && binding == "run")
    );
    assert!(
        matches!(&second_effect.kind,DisclosureEffectKind::Create{model,binding,..} if *model == turn && binding == "turn")
    );
    let [query] = facts.queries.as_ref().unwrap().as_slice() else {
        panic!("one count occurrence")
    };
    assert_eq!(query.count.as_ref().unwrap().statement, second.node);
    assert!(query.first.is_none() && query.alias.is_none() && query.predicate.is_none());
    assert!(
        proof
            .returns
            .iter()
            .all(|returned| returned.influences == query.influences)
    );
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        panic!("scenario")
    };
    let [
        IrStmt::Create {
            model: first_model,
            input: first_input,
            binding: Some(first_binding),
            ..
        },
        IrStmt::Create {
            model: second_model,
            input: second_input,
            binding: Some(second_binding),
            ..
        },
        IrStmt::Return {
            value: Some(returned),
            ..
        },
    ] = effects.as_slice()
    else {
        panic!("two Creates then direct Return")
    };
    assert_eq!(first_model, "CreatedPair.Run");
    assert_eq!(second_model, "CreatedPair.Turn");
    assert_ne!(first_binding, second_binding);
    let IrExpr::Object(first_fields) = &first_input.expr else {
        panic!("Run input")
    };
    assert!(matches!(first_fields[1].1.expr, IrExpr::Int(0)));
    let IrExpr::Object(second_fields) = &second_input.expr else {
        panic!("Turn input")
    };
    assert!(matches!(&second_fields[2].1.expr,IrExpr::Name(name) if name == first_binding));
    assert!(matches!(&returned.expr,IrExpr::Name(name) if name == first_binding));
    assert_eq!(
        returned.ty,
        ResolvedType::Record {
            symbol: run,
            stored: true
        }
    );
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(operation(&artifact)["result"]["type"], "CreatedPair.Run");
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        "native-count-run-turn.can",
        HASH,
    );
    let scratch = tempfile::tempdir().unwrap();
    let (artifact, source_path) = compile_cli(SOURCE, scratch.path());
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        source_path.to_str().unwrap(),
        HASH,
    );
    let runner = scratch.path().join("created-pair.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const ownerRequire=createRequire(resolve(process.argv[6],'package.json')),ownerLoad=name=>import(pathToFileURL(ownerRequire.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3])),hash=createHash('sha256').update(readFileSync(process.argv[4])).digest('hex');assert.equal(hash,process.argv[7]);
const stdlibUrl=pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,stdlib=await import(stdlibUrl);
assert.equal(typeof stdlib.countQuery,'function');assert.equal(typeof stdlib.executeScenarioReceiptQuery,'function');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await ownerLoad('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],stdlibUrl,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const operation=artifact.operations.find(operation=>operation.name==='CreatedPair.append'),plan=operation.result.disclosure,query=plan.queries[0];
assert.equal(operation.result.type,'CreatedPair.Run');assert.equal(plan.source.sha256,hash);assert.equal(plan.source.path,process.argv[4]);
assert.deepEqual(query.parent,{source:plan.source,model:'CreatedPair.Branch',origin:{kind:'admitted-reference',parameter:'branch'}});assert.equal(query.model,'CreatedPair.Turn');
const loaded=loadArtifactDescriptors(artifact,{by:'members'}),installed=loaded.registry.get(operation.name).descriptor;
assert.deepEqual(installed.result.disclosure,plan);assert.equal(installed.result.type,'CreatedPair.Run');
assert.deepEqual(operation.inputs.fields[0].field,{kind:'ref',model:'CreatedPair.Branch',requireVersion:true});assert.equal(operation.inputs.fields[0].required,true);
for(const name of ['CreatedPair.Run','CreatedPair.Turn'])assert.equal(loaded.containment.get(name).parent,'CreatedPair.Branch');
assert.equal(loaded.containment.get('CreatedPair.Branch').parent,'CreatedPair.Conversation');
const turn=artifact.models.find(model=>model.name==='CreatedPair.Turn');assert.deepEqual(turn.fields.find(field=>field.name==='run').field,{kind:'ref',model:'CreatedPair.Run'});
const callable=artifact.callables.find(callable=>callable.id===operation.name),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
assert.equal(module.appDefinition.operations[operation.name].by,'members');
let handler=factory;for(const member of callable.member)handler=handler[member];const body=handler.toString();
assert.equal((body.match(/\bawait create\(/g)||[]).length,2);
for(const expression of [/\bcountQuery\(/g,/\bexecuteScenarioReceiptQuery\(/g,/\bint64\(/g,/\bawait bindScenarioReceiptModelResult\(/g,/\bselectScenarioReceiptReturn\(/g])assert.equal((body.match(expression)||[]).length,1);
const first=/\bconst ([$\w]+) = await create\(c,"CreatedPair\.Run",\{parent:([$\w]+),marker:0n\}\);/.exec(body);
const second=/\bconst ([$\w]+) = await create\(c,"CreatedPair\.Turn",/.exec(body);assert.ok(first&&second);assert.ok(first.index<second.index);assert.notEqual(first[1],second[1]);
const bound=body.indexOf('await bindScenarioReceiptModelResult('),turnClause=body.slice(second.index,bound);
assert.ok(turnClause.includes(`parent:${first[2]},position:int64(await `));assert.ok(turnClause.includes(`run:${first[1]}}`),'Turn stores original earlier Run');
assert.match(turnClause,/int64\(await [\s\S]*countQuery\([\s\S]*\+ 1n\)/);
const direct=/\bawait countQuery\(c,await executeScenarioReceiptQuery\(c,/.test(turnClause);
const wrapped=/\bawait \(\(([$\w]+)\)=>countQuery\(c,\1\[0\]\)\)\(\[await executeScenarioReceiptQuery\(c,/.test(turnClause);assert.ok(direct||wrapped);
assert.ok(turnClause.includes(`await executeScenarioReceiptQuery(c,${JSON.stringify(query.id)},`));
assert.ok(body.includes(`const $receiptValue=${first[1]};`),'same first Run enters result binder');
const selected=body.indexOf('selectScenarioReceiptReturn('),returned=body.lastIndexOf('return ');assert.ok(second.index<bound&&bound<selected&&selected<returned);assert.equal(body.includes('return $receiptModelResult;'),true);
assert.equal(/\brecords\(/.test(body),false);assert.equal(/\bcount\(/.test(body),false);
console.log('Bounded Run then counted Turn: actual compiler/CLI/verified factory/installed State preserve original Run reference, query parent and ordered two creates; native execution unqualified');
"#).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(scratch.path().join("artifact.json"))
        .arg(source_path)
        .arg(scratch.path().join("modules"))
        .arg(native_owner())
        .arg(HASH)
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

#[test]
fn same_span_pair_order_binding_reference_type_guard_and_source_mutants_refuse() {
    let (db, program, ir, catalog) = checked(SOURCE, "native-count-run-turn.can");
    let owner = item(&ir, OWNER).id;
    assert!(
        serialize_complete_query_receipt(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &db,
            Some(&catalog),
            ENTRY
        )
        .is_some()
    );
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(operation(&artifact)["result"]["disclosure"].is_object());
    for mode in [
        "create-order",
        "binding-collision",
        "second-target",
        "run-reference",
        "run-reference-type",
        "return-second",
        "count-owning-create",
        "create-input-order",
        "create-guard",
        "run-marker",
        "run-field-type",
        "facts-source",
    ] {
        let mut changed = ir.clone();
        if mode == "run-field-type" {
            let field = item(&changed, "CreatedPair.Turn.run").id;
            let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
                panic!("run field")
            };
            *ty = IrType::Known(ResolvedType::Record {
                symbol: item(&ir, "CreatedPair.Branch").id,
                stored: true,
            });
        } else if matches!(mode, "count-owning-create" | "facts-source") {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("Complete")
            };
            let facts = proof.source_facts.as_mut().unwrap();
            let first_node = facts.creates.as_ref().unwrap()[0].node;
            let query = &mut facts.queries.as_mut().unwrap()[0];
            if mode == "count-owning-create" {
                query.count.as_mut().unwrap().statement = first_node;
            } else {
                query.source.sha256 = "0".repeat(64);
            }
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "create-order" {
                effects.swap(0, 1);
            } else if mode == "return-second" {
                let IrStmt::Return {
                    value: Some(value), ..
                } = effects.last_mut().unwrap()
                else {
                    panic!("return")
                };
                value.expr = IrExpr::Name("turn".into());
                value.ty = ResolvedType::Record {
                    symbol: item(&ir, "CreatedPair.Turn").id,
                    stored: true,
                };
            } else {
                let index = usize::from(mode != "run-marker");
                let IrStmt::Create {
                    model,
                    input,
                    binding,
                    when,
                    ..
                } = &mut effects[index]
                else {
                    panic!("create")
                };
                match mode {
                    "binding-collision" => *binding = Some("run".into()),
                    "second-target" => *model = "CreatedPair.Run".into(),
                    "create-guard" => *when = Some("forged".into()),
                    _ => {
                        let IrExpr::Object(fields) = &mut input.expr else {
                            panic!("input")
                        };
                        match mode {
                            "create-input-order" => fields.swap(1, 2),
                            "run-marker" => fields[1].1.expr = IrExpr::Int(1),
                            "run-reference" => fields[2].1.expr = IrExpr::Name("branch".into()),
                            _ => {
                                fields[2].1.ty = ResolvedType::Record {
                                    symbol: item(&ir, "CreatedPair.Branch").id,
                                    stored: true,
                                }
                            }
                        }
                    }
                }
            }
        }
        assert!(
            serialize_complete_query_receipt(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog),
                ENTRY
            )
            .is_none(),
            "{mode}"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "native-count-run-turn.can".into(),
        SOURCE.replace("marker=0", "marker=1"),
    );
    assert!(
        serialize_complete_query_receipt(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &stale,
            Some(&catalog),
            ENTRY
        )
        .is_none()
    );
    let raw = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{:?}",
        raw.diagnostics
    );
    assert!(
        raw.operations
            .iter()
            .find(|operation| operation.name == OWNER)
            .is_none_or(|operation| operation.disclosure.is_none())
    );
    for field in ["CreatedPair.Run.marker", "CreatedPair.Turn.run"] {
        let (db, mut program, ir, catalog) = checked(SOURCE, "native-count-run-turn.can");
        program
            .types
            .symbol_types
            .insert(item(&ir, field).id, ResolvedType::Scalar(Scalar::Text));
        let (artifact, diagnostics) = prepared(&program, &db, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{field}: {diagnostics:?}"
        );
        assert!(
            artifact["operations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|operation| operation["name"] == OWNER)
                .is_none_or(|operation| operation["result"]["disclosure"].is_null()),
            "{field}"
        );
    }
    let copied = SOURCE
        .replace("   create Turn", "   let copied=run\n   create Turn")
        .replace("+1,run}", "+1,run=copied}");
    let (db, program, ir, catalog) = checked(&copied, "copied-pair.can");
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    // A source-authored alias is supported by the shared LET mechanism. It
    // must retain the original CREATE identity and the same counted domain.
    assert!(diagnostics.is_empty(), "copied Run: {diagnostics:?}");
    assert_eq!(operation(&artifact)["result"]["type"], "CreatedPair.Run");
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        "copied-pair.can",
        &sha256_hex(copied.as_bytes()),
    );
    let owner = item(&ir, OWNER).id;
    for mode in ["alias-receiver", "alias-type", "alias-order"] {
        let mut changed = ir.clone();
        let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind else {
            panic!("scenario")
        };
        if mode == "alias-order" {
            effects.swap(0, 1);
        } else {
            let IrStmt::Let { value, .. } = &mut effects[1] else {
                panic!("source-authored alias")
            };
            if mode == "alias-receiver" {
                value.expr = IrExpr::Name("branch".into());
            } else {
                value.ty = ResolvedType::Record {
                    symbol: item(&ir, "CreatedPair.Branch").id,
                    stored: true,
                };
            }
        }
        assert!(
            serialize_complete_query_receipt(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog),
                ENTRY,
            )
            .is_none(),
            "{mode} must not borrow the genuine alias proof"
        );
    }
}

#[test]
fn bounded_pair_keeps_existing_guarded_send_tail_after_both_creates() {
    let source = SOURCE.replace("app CreatedPair\n","app CreatedPair\nuse std {EmailV1 as Mail} from=deployment.mail\n")
        .replace("Run in Branch {marker:int}","Run in Branch {marker:int,request:delivery(Mail.send)?}")
        .replace("append(branch:Branch)","append(branch:Branch,enabled:bool,accept:bool)")
        .replace("   return run",concat!(
            "   set run {marker=run.marker+1}\n",
            "   send Mail.send {to=\"recipient@example.test\",subject=\"Created pair\",body=\"Original ordered pair\"} when=enabled as request\n",
            "   set run {request}\n   require accept\n   return run"));
    let hash = sha256_hex(source.as_bytes());
    let (db, program, ir, catalog) = checked(&source, "guarded-created-pair.can");
    let owner = item(&ir, OWNER);
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!("bounded pair and existing guarded tail Complete")
    };
    let [first, second, updated, sent, linked] = proof.effects.as_slice() else {
        panic!("Create/Create/Set/Send/Set")
    };
    assert!(matches!(first.kind, DisclosureEffectKind::Create { .. }));
    assert!(matches!(second.kind, DisclosureEffectKind::Create { .. }));
    assert!(matches!(updated.kind, DisclosureEffectKind::Set { .. }));
    assert!(matches!(linked.kind, DisclosureEffectKind::Set { .. }));
    let DisclosureEffectKind::Send {
        operation: send_target,
        when: Some(when),
        ..
    } = &sent.kind
    else {
        panic!("original guarded SEND")
    };
    assert_eq!(send_target, "std.EmailV1.send");
    assert_eq!(
        &db.get(when.file).unwrap().text[when.start as usize..when.end as usize],
        "enabled"
    );
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        "guarded-created-pair.can",
        &hash,
    );
    let scratch = tempfile::tempdir().unwrap();
    let (artifact, path) = compile_cli(&source, scratch.path());
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        path.to_str().unwrap(),
        &hash,
    );
    let module = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|module| {
            module["path"] == operation(&artifact)["result"]["disclosure"]["source"]["module"]
        })
        .unwrap();
    let body = module["js"].as_str().unwrap();
    assert_eq!(body.matches("await create(").count(), 2);
    for expression in [
        "countQuery(",
        "executeScenarioReceiptQuery(",
        "await send(",
        "await bindScenarioReceiptModelResult(",
        "selectScenarioReceiptReturn(",
    ] {
        assert_eq!(body.matches(expression).count(), 1, "{expression}");
    }
    assert_eq!(body.matches("await set(").count(), 2);
    let first_create = body.find("await create(").unwrap();
    let second_create = body[first_create + 1..].find("await create(").unwrap() + first_create + 1;
    let count = body.find("countQuery(").unwrap();
    let first_set = body.find("await set(").unwrap();
    let send = body.find("await send(").unwrap();
    let second_set = body[send..].find("await set(").unwrap() + send;
    let late = body[second_set..].find("check(").unwrap() + second_set;
    let bound = body.find("await bindScenarioReceiptModelResult(").unwrap();
    assert!(
        first_create < second_create
            && second_create < count
            && count < first_set
            && first_set < send
            && send < second_set
            && second_set < late
            && late < bound
    );
    assert!(body.contains("when:{rule:"));
    assert!(!body.contains("when:()=>"));
    assert!(body.contains("return $receiptModelResult;"));
}
