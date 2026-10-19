//! Original bounded ask75 ancestor-count producer. Real source, CLI, installed
//! descriptors and factory imports are checked; no native authority is fabricated.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{DependencyRole, ScenarioDisclosure};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_queries::serialize_complete_query_receipt;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/native-ancestor-count.can");
const HASH: &str = "85dd7a5380cafdbb2b4c95f306bf29df9553e6632509c97a63fd5ae16f79909e";
const OWNER: &str = "AncestorCount.ask";
const ENTRY: &str = "$can$m$416e636573746f72436f756e74.mjs";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn native_owner_root() -> PathBuf {
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
    let catalog_path = native_owner_root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
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
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::codegen::artifact::to_json;
    let mut result = DiagnosticResult::new("ancestor-count-source", "1.0", 1);
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

fn assert_plan(plan: &Value, ir: &IrProgram, path: &str) {
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&item(ir, OWNER).id] else {
        panic!("Complete original source")
    };
    let facts = proof.source_facts.as_ref().unwrap();
    let [original_query] = facts.queries.as_ref().unwrap().as_slice() else {
        panic!("one original query")
    };
    assert_eq!(plan["source"]["path"], path);
    assert_eq!(plan["source"]["sha256"], HASH);
    let [query] = plan["queries"].as_array().unwrap().as_slice() else {
        panic!("sole unscoped Run query")
    };
    assert_eq!(query["id"], original_query.id);
    assert_eq!(query["source"], plan["source"]);
    assert_eq!(query["model"], "AncestorCount.Run");
    assert!(
        query.get("parent").is_none(),
        "ancestor equality must not become a contained selector"
    );
    assert_eq!(query["order"], serde_json::json!([]));
    assert!(query["limit"].is_null());
    assert_eq!(query["archived"], "exclude");
    let controls = query["dependencies"].as_array().unwrap();
    assert_eq!(controls.len(), 2);
    for (native, source, field, ty) in [
        (
            &controls[0],
            &original_query.dependencies[0],
            "parent",
            "AncestorCount.Branch",
        ),
        (
            &controls[1],
            &original_query.dependencies[1],
            "unfinished",
            "bool",
        ),
    ] {
        assert_eq!(native["id"], source.id);
        assert_eq!(native["source"], plan["source"]);
        assert_eq!(native["field"], field);
        assert_eq!(native["type"], ty);
        assert_eq!(native["role"], "control");
        assert!(native.get("queryId").is_none());
    }
    let returns = plan["returns"].as_array().unwrap();
    assert_eq!(returns.len(), proof.returns.len());
    assert!(!returns.is_empty());
    for (native, original) in returns.iter().zip(&proof.returns) {
        assert_eq!(native["id"], original.id);
        assert_eq!(native["source"], plan["source"]);
        assert!(native["projection"].is_null());
        let influences = native["influences"].as_array().unwrap();
        assert_eq!(influences.len(), 4);
        assert_eq!(
            influences
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
            influences
                .iter()
                .all(|influence| influence["queryId"] == query["id"])
        );
        let dependencies = native["dependencies"].as_array().unwrap();
        assert_eq!(dependencies.len(), 2);
        assert_ne!(dependencies[0]["id"], dependencies[1]["id"]);
        for (transported, read) in dependencies.iter().zip(&original.dependencies) {
            assert_eq!(transported["id"], read.id);
            assert_eq!(transported["source"], plan["source"]);
            assert_eq!(transported["role"], "control");
            assert_eq!(transported["model"], "AncestorCount.Branch");
            assert_eq!(transported["field"], "parent");
            assert_eq!(transported["type"], "AncestorCount.Conversation");
            assert_eq!(transported["queryId"], query["id"]);
        }
    }
}

#[test]
fn checked_source_and_prepared_native_plan_retain_original_unscoped_ancestor_count() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let (db, program, ir, catalog) = checked(SOURCE, "native-ancestor-count.can");
    let owner = item(&ir, OWNER);
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!("original bounded count Complete")
    };
    let facts = proof.source_facts.as_ref().unwrap();
    let [query] = facts.queries.as_ref().unwrap().as_slice() else {
        panic!("one real query")
    };
    let count = query.count.as_ref().unwrap();
    assert!(count.contained_parent.is_none());
    assert!(query.first.is_none());
    let text = |node: canlang_compiler::analysis::NodeKey| {
        db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
    };
    assert_eq!(
        text(count.statement),
        "require count(Run as run where run.parent.parent==branch.parent and run.unfinished)<10"
    );
    assert_eq!(text(query.domain), "Run");
    assert_eq!(
        text(query.predicate.unwrap()),
        "run.parent.parent==branch.parent and run.unfinished"
    );
    assert_eq!(
        count
            .parent_edges
            .iter()
            .map(|edge| text(edge.node))
            .collect::<Vec<_>>(),
        ["run.parent", "run.parent.parent", "branch.parent"]
    );
    assert_eq!(
        query
            .dependencies
            .iter()
            .map(|dependency| dependency.field_name.as_str())
            .collect::<Vec<_>>(),
        ["parent", "unfinished"]
    );
    let [candidate, supplied] = proof.returns[0].dependencies.as_slice() else {
        panic!("two ordinary reads")
    };
    assert_ne!(candidate.id, supplied.id);
    assert_eq!(text(candidate.node), "run.parent.parent");
    assert_eq!(text(supplied.node), "branch.parent");
    for read in [candidate, supplied] {
        assert_eq!(read.role, DependencyRole::Control);
        assert_eq!(read.query_id.as_deref(), Some(query.id.as_str()));
    }
    let IrItemKind::Scenario {
        guards,
        effects,
        params,
        ..
    } = &owner.kind
    else {
        panic!("scenario")
    };
    assert_eq!(guards.len(), 1);
    assert_eq!(params.len(), 1);
    let [
        IrStmt::Create {
            model,
            binding: Some(binding),
            ..
        },
        IrStmt::Return {
            value: Some(value), ..
        },
    ] = effects.as_slice()
    else {
        panic!("single original Create and Return")
    };
    assert_eq!(model, "AncestorCount.Run");
    assert!(matches!(&value.expr,IrExpr::Name(name)if name==binding));
    assert_eq!(
        value.ty,
        ResolvedType::Record {
            symbol: item(&ir, "AncestorCount.Run").id,
            stored: true
        }
    );
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(operation(&artifact)["result"]["type"], "AncestorCount.Run");
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        &ir,
        "native-ancestor-count.can",
    );
}

#[test]
fn actual_cli_verified_factory_and_installed_consumers_preserve_lazy_parent_observations() {
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("native-ancestor-count.can");
    std::fs::write(&path, SOURCE.as_bytes()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_owner_root().join("packages/cloudflare/dist/native-catalog.json"))
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
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    let (_, _, ir, _) = checked(SOURCE, path.to_str().unwrap());
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        &ir,
        path.to_str().unwrap(),
    );
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let runner = scratch.path().join("ancestor-count.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const ownerRequire=createRequire(resolve(process.argv[6],'package.json')),ownerLoad=name=>import(pathToFileURL(ownerRequire.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3])),hash=createHash('sha256').update(readFileSync(process.argv[4])).digest('hex');assert.equal(hash,process.argv[7]);
const stdlibUrl=pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,stdlib=await import(stdlibUrl);
for(const name of ['countQuery','executeScenarioReceiptQuery','readScenarioReceiptQueryParent'])assert.equal(typeof stdlib[name],'function',`actual released ${name} is required`);
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');const {loadArtifactDescriptors}=await ownerLoad('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],stdlibUrl,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const operation=artifact.operations.find(operation=>operation.name==='AncestorCount.ask'),plan=operation.result.disclosure,query=plan.queries[0];
assert.equal(plan.source.sha256,hash);assert.equal(plan.source.path,process.argv[4]);assert.equal(query.model,'AncestorCount.Run');assert.equal(Object.hasOwn(query,'parent'),false);
assert.deepEqual(query.dependencies.map(dependency=>[dependency.field,dependency.type,dependency.role]),[['parent','AncestorCount.Branch','control'],['unfinished','bool','control']]);
const loaded=loadArtifactDescriptors(artifact,{by:'members'});assert.deepEqual(loaded.registry.get(operation.name).descriptor.result.disclosure,plan);
assert.equal(loaded.containment.get('AncestorCount.Run').parent,'AncestorCount.Branch');assert.equal(loaded.containment.get('AncestorCount.Branch').parent,'AncestorCount.Conversation');
const [candidate,supplied]=plan.returns[0].dependencies;assert.notEqual(candidate.id,supplied.id);for(const read of [candidate,supplied]){assert.equal(read.queryId,query.id);assert.equal(read.field,'parent');assert.equal(read.role,'control');assert.equal(read.model,'AncestorCount.Branch');}
const callable=artifact.callables.find(callable=>callable.id===operation.name),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
assert.equal(module.appDefinition.operations[operation.name].by,'members');let handler=factory;for(const member of callable.member)handler=handler[member];const body=handler.toString();
for(const pattern of [/\bexecuteScenarioReceiptQuery\(/g,/\bcountQuery\(/g,/\bawait readScenarioReceiptQueryParent\(/g,/\bawait create\(/g,/\bawait bindScenarioReceiptModelResult\(/g,/\bselectScenarioReceiptReturn\(/g])assert.equal((body.match(pattern)||[]).length,1);
const direct=/\bawait countQuery\(c,await executeScenarioReceiptQuery\(c,/.test(body);
const wrapped=/\bawait \(\(([$\w]+)\)=>countQuery\(c,\1\[0\]\)\)\(\[await executeScenarioReceiptQuery\(c,/.test(body);assert.ok(direct||wrapped);
const queryRow=new RegExp(`await executeScenarioReceiptQuery\\(c,${JSON.stringify(query.id).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')},async\\(([$\\w]+)\\)=>`).exec(body);assert.ok(queryRow);
const bridge=/await readScenarioReceiptQueryParent\(c,([$\w]+),"([^"\\]+)"\)/.exec(body);assert.ok(bridge);assert.equal(bridge[2],candidate.id,'bridge uses original candidate Branch.parent dependency');
assert.ok(bridge[1]===queryRow[1] || (body.includes(`async(${bridge[1]})`)&&body.includes(`})(${queryRow[1]})`)),'bridge receiver is original query view through its lexical capture');
const parentQueryId=JSON.stringify(query.dependencies[0].id),unfinishedQueryId=JSON.stringify(query.dependencies[1].id);
const queryMarker=`observeScenarioReceiptQueryDependency(c,"AncestorCount.Run",${bridge[1]},"parent",${parentQueryId});`;
assert.equal(body.split(queryMarker).length-1,1,'original Run.parent query marker once');
assert.ok(body.includes(`${bridge[1]}["parent"];${queryMarker}`),'query marker immediately follows original first-hop read');
assert.equal((body.match(/\["parent"\]/g)||[]).length,3,'each original Run.parent and two Branch.parent reads occurs once');
assert.equal((body.match(/\["unfinished"\]/g)||[]).length,1);
for(const read of [candidate,supplied]){const marker=`await observeScenarioReceiptDependency(c,"AncestorCount.Branch",$receiptRow,"parent",${JSON.stringify(read.id)});`;assert.equal(body.split(marker).length-1,1,'ordinary source read marked once');}
const same=body.indexOf('same('),candidateMarker=body.indexOf(`"parent",${JSON.stringify(candidate.id)}`),suppliedMarker=body.indexOf(`"parent",${JSON.stringify(supplied.id)}`),and=body.indexOf('&&',same),unfinished=body.indexOf('["unfinished"]');
assert.ok(same>=0&&same<candidateMarker&&candidateMarker<suppliedMarker&&suppliedMarker<and&&and<unfinished,'both equality operands stay lazy and unfinished remains on short-circuit RHS');
assert.ok(body.includes(`"unfinished",${unfinishedQueryId}`));
const created=/const ([$\w]+) = await create\(c,"AncestorCount\.Run",/.exec(body);assert.ok(created);
const checked=body.indexOf('check('),count=body.indexOf('countQuery('),bound=body.indexOf('await bindScenarioReceiptModelResult('),selected=body.indexOf('selectScenarioReceiptReturn('),returned=body.lastIndexOf('return ');
assert.ok(checked<count&&count<created.index&&created.index<bound&&bound<selected&&selected<returned);assert.ok(body.includes(`const $receiptValue=${created[1]};`));assert.equal(body.includes('return $receiptModelResult;'),true);
assert.equal(/\brecords\(/.test(body),false);assert.equal(/\bcount\(/.test(body),false);
console.log('Bounded original ancestor count: real compiler/CLI/verified factory/installed State preserve unscoped candidates, immediate first-hop marker, genuine lazy parent bridge and query-associated ordinary reads; native execution unqualified');
"#).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(artifact_path)
        .arg(path)
        .arg(scratch.path().join("modules"))
        .arg(native_owner_root())
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
fn actual_producer_source_ir_marker_association_and_prepared_mutations_refuse() {
    let (db, program, ir, catalog) = checked(SOURCE, "native-ancestor-count.can");
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
        .is_some(),
        "genuine prepared collector baseline"
    );
    for mode in [
        "parent-marker",
        "ordinary-association",
        "unconsumed",
        "count-node",
        "count-bound",
        "slot",
        "alias",
        "candidate-type",
        "child-owner",
        "guard-stage",
        "copied-parent",
        "return",
    ] {
        let mut changed = ir.clone();
        if matches!(
            mode,
            "parent-marker" | "ordinary-association" | "unconsumed" | "count-node"
        ) {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("Complete")
            };
            match mode {
                "parent-marker" => {
                    proof
                        .source_facts
                        .as_mut()
                        .unwrap()
                        .queries
                        .as_mut()
                        .unwrap()[0]
                        .dependencies
                        .remove(0);
                }
                "ordinary-association" => proof.returns[0].dependencies[0].query_id = None,
                "unconsumed" => {
                    proof.returns[0].influences.pop().unwrap();
                }
                _ => {
                    proof
                        .source_facts
                        .as_mut()
                        .unwrap()
                        .queries
                        .as_mut()
                        .unwrap()[0]
                        .count
                        .as_mut()
                        .unwrap()
                        .call
                        .end -= 1
                }
            }
        } else if mode == "child-owner" {
            let id = item(&changed, "AncestorCount.Branch").id;
            let IrItemKind::Model { owner, .. } = &mut changed.items[id.0 as usize].kind else {
                panic!("Branch")
            };
            *owner = ir::IrOwner::Team;
        } else {
            let IrItemKind::Scenario {
                guards, effects, ..
            } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "guard-stage" {
                effects.insert(0, guards.remove(0));
            } else if mode == "return" {
                let IrStmt::Return {
                    value: Some(value), ..
                } = effects.last_mut().unwrap()
                else {
                    panic!("Return")
                };
                value.expr = IrExpr::Name("branch".into());
            } else {
                let IrStmt::Require { cond, .. } = &mut guards[0] else {
                    panic!("guard")
                };
                let IrExpr::Binary {
                    left: call,
                    right: bound,
                    ..
                } = &mut cond.expr
                else {
                    panic!("bound")
                };
                if mode == "count-bound" {
                    bound.expr = IrExpr::Int(9);
                } else if mode == "slot" {
                    let (IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. }) =
                        &call.expr
                    else {
                        panic!("count")
                    };
                    call.expr = IrExpr::BoundCall {
                        target: target.clone(),
                        args: args.clone(),
                        slots: vec![None],
                    };
                } else {
                    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) =
                        &mut call.expr
                    else {
                        panic!("count")
                    };
                    let IrExpr::Query(query) = &mut args[0].expr else {
                        panic!("query")
                    };
                    if mode == "alias" {
                        let canlang_compiler::analysis::types::CheckedQueryClauseKind::As { name } =
                            &mut query.source.as_mut().unwrap().clauses[0].kind
                        else {
                            panic!("alias")
                        };
                        *name = "foreign".into();
                    } else {
                        let IrExpr::Binary { left: equality, .. } =
                            &mut query.where_pred.as_mut().unwrap().expr
                        else {
                            panic!("predicate")
                        };
                        let IrExpr::Binary {
                            left: candidate,
                            right: supplied,
                            ..
                        } = &mut equality.expr
                        else {
                            panic!("equality")
                        };
                        if mode == "candidate-type" {
                            candidate.ty = ResolvedType::Scalar(Scalar::Text);
                        } else {
                            let IrExpr::Member { base, .. } = &mut supplied.expr else {
                                panic!("supplied parent")
                            };
                            base.expr = IrExpr::Name("run".into());
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
        "native-ancestor-count.can".into(),
        SOURCE.replace("unfinished=true", "unfinished=false"),
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
    let (db, mut program, ir, catalog) = checked(SOURCE, "native-ancestor-count.can");
    let unfinished = item(&ir, "AncestorCount.Run.unfinished").id;
    program
        .types
        .symbol_types
        .insert(unfinished, ResolvedType::Scalar(Scalar::Text));
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{diagnostics:?}"
    );
    assert!(
        artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == OWNER)
            .is_none_or(|operation| operation["result"]["disclosure"].is_null())
    );
}
