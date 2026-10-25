//! Bounded original-purpose ancestor count -> first Budget -> counted Turn.
//! Real source, compiler, verified factory and installed State metadata only.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{DependencyRole, ScenarioDisclosure};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrCallTarget, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType,
};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_queries::serialize_complete_query_receipt;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const SOURCE: &str = include_str!("fixtures/native-three-query-run-turn.can");
const HASH: &str = "e0ecc8305cb132f5730a7bf08680b303929a0f1ad2f39dff255fd831f0ad2150";
const OWNER: &str = "ThreeQueryPair.generate";
const ENTRY: &str = "$can$m$5468726565517565727950616972.mjs";

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
    let mut result = DiagnosticResult::new("three-query-pair", "1.0", 1);
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
        panic!("Complete original composition")
    };
    let facts = proof.source_facts.as_ref().unwrap();
    let originals = facts.queries.as_ref().unwrap();
    let [ancestor, first, contained] = plan["queries"].as_array().unwrap().as_slice() else {
        panic!("exact three queries")
    };
    assert_eq!(plan["source"]["path"], path);
    assert_eq!(plan["source"]["sha256"], HASH);
    assert_eq!(ancestor["model"], "ThreeQueryPair.Run");
    assert_eq!(first["model"], "ThreeQueryPair.Budget");
    assert_eq!(contained["model"], "ThreeQueryPair.Turn");
    assert!(ancestor.get("parent").is_none() && first.get("parent").is_none());
    assert_eq!(
        ancestor["dependencies"]
            .as_array()
            .unwrap()
            .iter()
            .map(|dependency| (
                dependency["field"].as_str().unwrap(),
                dependency["type"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [("parent", "ThreeQueryPair.Branch"), ("unfinished", "bool")]
    );
    assert_eq!(first["dependencies"][0]["field"], "account");
    assert_eq!(first["dependencies"][0]["type"], "user");
    assert_eq!(
        first["order"],
        serde_json::json!([{"field":"id","direction":"asc"}])
    );
    assert_eq!(ancestor["order"], serde_json::json!([]));
    assert_eq!(contained["order"], serde_json::json!([]));
    assert_eq!(
        contained["parent"],
        serde_json::json!({"source":plan["source"],"model":"ThreeQueryPair.Branch","origin":{"kind":"admitted-reference","parameter":"branch"}})
    );
    assert_eq!(contained["dependencies"], serde_json::json!([]));
    for (query, original) in [ancestor, first, contained].into_iter().zip(originals) {
        assert_eq!(query["id"], original.id);
        assert_eq!(query["source"], plan["source"]);
        assert!(query["limit"].is_null());
        assert_eq!(query["archived"], "exclude");
        for dependency in query["dependencies"].as_array().unwrap() {
            assert_eq!(dependency["role"], "control");
        }
    }
    let returns = plan["returns"].as_array().unwrap();
    assert_eq!(returns.len(), proof.returns.len());
    assert!(!returns.is_empty());
    for (native, original) in returns.iter().zip(&proof.returns) {
        assert_eq!(native["id"], original.id);
        assert!(native["projection"].is_null());
        let influences = native["influences"].as_array().unwrap();
        assert_eq!(influences.len(), 12);
        for (query, group) in [ancestor, first, contained]
            .into_iter()
            .zip(influences.as_chunks::<4>().0)
        {
            assert_eq!(
                group
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
                group
                    .iter()
                    .all(|influence| influence["queryId"] == query["id"])
            );
        }
        let dependencies = native["dependencies"].as_array().unwrap();
        assert_eq!(dependencies.len(), original.dependencies.len());
        for read in &original.dependencies {
            let transported = dependencies
                .iter()
                .find(|dependency| dependency["id"] == read.id)
                .unwrap();
            assert_eq!(transported["model"], read.model_name);
            assert_eq!(transported["field"], read.field_name);
            assert_eq!(transported["type"], read.type_id);
            assert_eq!(transported["source"]["path"], read.source.path);
            assert_eq!(transported["source"]["sha256"], read.source.sha256);
            assert_eq!(
                transported["role"],
                match read.role {
                    DependencyRole::Control => "control",
                    DependencyRole::Data => "data",
                }
            );
            match &read.query_id {
                Some(id) => assert_eq!(transported["queryId"], id.as_str()),
                None => assert!(transported.get("queryId").is_none()),
            }
        }
        let parents = dependencies
            .iter()
            .filter(|dependency| dependency.get("queryId").is_some())
            .collect::<Vec<_>>();
        assert_eq!(parents.len(), 2);
        assert_ne!(parents[0]["id"], parents[1]["id"]);
        assert!(
            parents
                .iter()
                .all(|dependency| dependency["model"] == "ThreeQueryPair.Branch"
                    && dependency["field"] == "parent"
                    && dependency["role"] == "control"
                    && dependency["queryId"] == ancestor["id"])
        );
    }
    for field in ["active", "running", "parallel", "spent", "held", "cap"] {
        assert!(
            returns
                .iter()
                .flat_map(|returned| returned["dependencies"].as_array().unwrap())
                .any(|dependency| dependency["model"] == "ThreeQueryPair.Budget"
                    && dependency["field"] == field),
            "original Budget read {field}"
        );
    }
}

#[test]
fn original_source_and_fresh_preparation_preserve_all_three_query_owners() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let base = include_str!("fixtures/native-first-count-run-turn.can");
    for line in base.lines().filter(|line| {
        !line.starts_with("##")
            && !line.starts_with("app ")
            && !line.starts_with(" Run in")
            && !line.starts_with(" policy Run")
            && !line.starts_with("   create Run")
    }) {
        assert!(
            SOURCE.lines().any(|preserved| preserved == line),
            "unchanged original-purpose clause: {line}"
        );
    }
    let (db, program, ir, catalog) = checked(SOURCE, "native-three-query-run-turn.can");
    let owner = item(&ir, OWNER);
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!("exact three-query source Complete")
    };
    let facts = proof.source_facts.as_ref().unwrap();
    let [ancestor, first, contained] = facts.queries.as_ref().unwrap().as_slice() else {
        panic!("three source-ordered queries")
    };
    assert!(ancestor.count.is_some() && ancestor.first.is_none());
    assert!(first.first.is_some() && first.count.is_none());
    assert!(contained.count.is_some() && contained.first.is_none());
    assert!(ancestor.node.end <= first.node.start && first.node.end <= contained.node.start);
    let text = |node: canlang_compiler::analysis::NodeKey| {
        db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
    };
    assert_eq!(
        text(ancestor.count.as_ref().unwrap().statement),
        "require count(Run as run where run.parent.parent==branch.parent and run.unfinished)<10"
    );
    assert_eq!(
        ancestor.inputs[0].1,
        contained
            .count
            .as_ref()
            .unwrap()
            .contained_parent
            .unwrap()
            .1
    );
    assert_eq!(text(ancestor.inputs[0].0), "branch");
    assert_eq!(
        text(first.first.as_ref().unwrap().call),
        "first(Budget as row where row.account==actor order=row.id)"
    );
    assert_eq!(text(contained.node), "branch.Turn");
    let creates = facts.creates.as_ref().unwrap();
    assert_eq!(creates.len(), 2);
    assert_eq!(creates[0].binding, "run");
    assert_eq!(creates[1].binding, "turn");
    assert_eq!(contained.count.as_ref().unwrap().statement, creates[1].node);
    assert_eq!(text(creates[1].inputs[2].value_node), "run");
    let union = [ancestor, first, contained]
        .into_iter()
        .flat_map(|query| query.influences.clone())
        .collect::<Vec<_>>();
    assert_eq!(union.len(), 12);
    assert!(
        proof
            .returns
            .iter()
            .all(|returned| returned.influences == union)
    );
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(operation(&artifact)["result"]["type"], "ThreeQueryPair.Run");
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        &ir,
        "native-three-query-run-turn.can",
    );
}

#[test]
fn actual_native_cli_verified_factory_and_primary_state_preserve_three_lazy_query_consumers() {
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("native-three-query-run-turn.can");
    std::fs::write(&path, SOURCE.as_bytes()).unwrap();
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
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    let (_, _, ir, _) = checked(SOURCE, path.to_str().unwrap());
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        &ir,
        path.to_str().unwrap(),
    );
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let runner = scratch.path().join("three-query-pair.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));const ownerRequire=createRequire(resolve(process.argv[6],'package.json')),ownerLoad=name=>import(pathToFileURL(ownerRequire.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3])),hash=createHash('sha256').update(readFileSync(process.argv[4])).digest('hex');assert.equal(hash,process.argv[7]);
const stdlibUrl=pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,stdlib=await import(stdlibUrl);for(const name of ['countQuery','firstQuery','executeScenarioReceiptQuery','readScenarioReceiptQueryParent'])assert.equal(typeof stdlib[name],'function');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');const {loadArtifactDescriptors}=await ownerLoad('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],stdlibUrl,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const operation=artifact.operations.find(operation=>operation.name==='ThreeQueryPair.generate'),plan=operation.result.disclosure,[ancestor,first,contained]=plan.queries;assert.equal(plan.queries.length,3);assert.equal(plan.source.sha256,hash);assert.equal(plan.source.path,process.argv[4]);
assert.deepEqual(plan.queries.map(query=>query.model),['ThreeQueryPair.Run','ThreeQueryPair.Budget','ThreeQueryPair.Turn']);assert.equal(Object.hasOwn(ancestor,'parent'),false);assert.equal(Object.hasOwn(first,'parent'),false);assert.equal(contained.parent.origin.parameter,'branch');
const loaded=loadArtifactDescriptors(artifact,{by:'members'});assert.deepEqual(loaded.registry.get(operation.name).descriptor.result.disclosure,plan);assert.equal(loaded.registry.get(operation.name).descriptor.result.type,'ThreeQueryPair.Run');
for(const child of ['ThreeQueryPair.Run','ThreeQueryPair.Turn'])assert.equal(loaded.containment.get(child).parent,'ThreeQueryPair.Branch');assert.equal(loaded.containment.get('ThreeQueryPair.Branch').parent,'ThreeQueryPair.Conversation');
for(const returned of plan.returns){assert.equal(returned.influences.length,12);for(const [index,query] of plan.queries.entries())assert.ok(returned.influences.slice(index*4,index*4+4).every(influence=>influence.queryId===query.id));}
const [candidate,supplied]=plan.returns[0].dependencies.filter(dependency=>dependency.queryId===ancestor.id);assert.ok(candidate&&supplied);assert.notEqual(candidate.id,supplied.id);
const callable=artifact.callables.find(callable=>callable.id===operation.name),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();let handler=factory;for(const member of callable.member)handler=handler[member];const body=handler.toString();
for(const [pattern,n] of [[/\bexecuteScenarioReceiptQuery\(/g,3],[/\bcountQuery\(/g,2],[/\bfirstQuery\(/g,1],[/\bawait readScenarioReceiptQueryParent\(/g,1],[/\bawait create\(/g,2],[/\bawait set\(/g,2],[/\bawait send\(/g,1],[/\bawait bindScenarioReceiptModelResult\(/g,1],[/\bselectScenarioReceiptReturn\(/g,1]])assert.equal((body.match(pattern)||[]).length,n);
for(const query of plan.queries)assert.equal(body.split(`await executeScenarioReceiptQuery(c,${JSON.stringify(query.id)},`).length-1,1);
const directCounts=(body.match(/\bawait countQuery\(c,await executeScenarioReceiptQuery\(c,/g)||[]).length;
const capturedCounts=(body.match(/\bawait \(\(([$\w]+)\)=>countQuery\(c,\1\[0\]\)\)\(\[await executeScenarioReceiptQuery\(c,/g)||[]).length;assert.equal(directCounts+capturedCounts,2);
const firstDirect=/\bawait firstQuery\(c,await executeScenarioReceiptQuery\(c,/.test(body),firstCaptured=/\bawait \(\(([$\w]+)\)=>firstQuery\(c,\1\[0\]\)\)\(\[await executeScenarioReceiptQuery\(c,/.test(body);assert.ok(firstDirect||firstCaptured);
const bridge=/await readScenarioReceiptQueryParent\(c,([$\w]+),"([^"\\]+)"\)/.exec(body);assert.ok(bridge);assert.equal(bridge[2],candidate.id);
const parentMarker=`observeScenarioReceiptQueryDependency(c,"ThreeQueryPair.Run",${bridge[1]},"parent",${JSON.stringify(ancestor.dependencies[0].id)});`;assert.ok(body.includes(`${bridge[1]}["parent"];${parentMarker}`));
for(const read of [candidate,supplied]){const marker=`await observeScenarioReceiptDependency(c,"ThreeQueryPair.Branch",$receiptRow,"parent",${JSON.stringify(read.id)});`;assert.equal(body.split(marker).length-1,1);}
const same=body.indexOf('same('),candidateRead=body.indexOf(`"parent",${JSON.stringify(candidate.id)}`),suppliedRead=body.indexOf(`"parent",${JSON.stringify(supplied.id)}`),and=body.indexOf('&&',same),unfinished=body.indexOf('["unfinished"]');assert.ok(same<candidateRead&&candidateRead<suppliedRead&&suppliedRead<and&&and<unfinished);
const run=/const ([$\w]+) = await create\(c,"ThreeQueryPair\.Run",\{parent:([$\w]+),budget:([$\w]+),unfinished:true\}\);/.exec(body),turn=/const ([$\w]+) = await create\(c,"ThreeQueryPair\.Turn",/.exec(body);assert.ok(run&&turn);
const ancestorExec=body.indexOf(`executeScenarioReceiptQuery(c,${JSON.stringify(ancestor.id)},`),firstExec=body.indexOf(`executeScenarioReceiptQuery(c,${JSON.stringify(first.id)},`),containedExec=body.indexOf(`executeScenarioReceiptQuery(c,${JSON.stringify(contained.id)},`);
const budgetSet=body.indexOf('await set('),send=body.indexOf('await send('),runSet=body.indexOf('await set(',budgetSet+1),late=body.indexOf('check(',runSet),bound=body.indexOf('await bindScenarioReceiptModelResult('),selected=body.indexOf('selectScenarioReceiptReturn('),returned=body.lastIndexOf('return ');
assert.ok(ancestorExec<firstExec&&firstExec<run.index&&run.index<turn.index&&turn.index<containedExec&&containedExec<budgetSet&&budgetSet<send&&send<runSet&&runSet<late&&late<bound&&bound<selected&&selected<returned);
const turnClause=body.slice(turn.index,budgetSet);assert.ok(turnClause.includes(`parent:${run[2]},position:int64(await `));assert.ok(turnClause.includes(`run:${run[1]}}`));assert.match(turnClause,/\+ 1n\)/);assert.ok(body.includes(`const $receiptValue=${run[1]};`));assert.ok(body.includes('return $receiptModelResult;'));
const selectedBudget=new RegExp(`const ${run[3].replace(/[$]/g,'\\$')} = await `).exec(body);assert.ok(selectedBudget&&selectedBudget.index<run.index);
assert.equal((body.match(/\["account"\]/g)||[]).length,1);assert.equal((body.match(/\["unfinished"\]/g)||[]).length,1);
const policy=artifact.modelPolicies.find(policy=>policy.model==='ThreeQueryPair.Budget');assert.equal(policy.abi,'state.owner-model-policies@1');assert.deepEqual(policy.rules.map(rule=>rule.kind),['invariant','lock']);assert.deepEqual(policy.rules[1].fields,['account']);
const guard=module.appDefinition.operations[operation.name].sendGuards[0];assert.deepEqual(guard.inputs,[{name:'enabled',type:'bool'}]);assert.equal(guard.source.sha256,hash);assert.ok(body.includes('when:{rule:'));assert.equal(body.includes('when:()=>'),false);assert.equal(/\brecords\(/.test(body),false);
console.log('Bounded original three-query business composition: actual compiler/CLI/verified factory/PRIMARY State preserve unscoped ancestors, first Budget, counted Turn, twelve associations and sameRun ordered effects; native execution remains separate');
"#).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(artifact_path)
        .arg(path)
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
fn source_ir_three_query_associations_and_foreign_same_typed_parent_mutants_refuse() {
    let (db, program, ir, catalog) = checked(SOURCE, "native-three-query-run-turn.can");
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
        "authentic producer baseline"
    );
    for mode in [
        "order",
        "duplicate",
        "count-call",
        "count-slot",
        "count-owner",
        "missing-union",
        "wrong-union",
        "guard-stage",
        "schema",
        "return-turn",
        "run-link",
        "ordinary-association",
    ] {
        let mut changed = ir.clone();
        if matches!(
            mode,
            "order"
                | "duplicate"
                | "count-owner"
                | "missing-union"
                | "wrong-union"
                | "ordinary-association"
        ) {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("Complete")
            };
            let facts = proof.source_facts.as_mut().unwrap();
            let queries = facts.queries.as_mut().unwrap();
            match mode {
                "order" => queries.swap(0, 2),
                "duplicate" => queries.push(queries[0].clone()),
                "count-owner" => {
                    queries[2].count.as_mut().unwrap().statement =
                        facts.creates.as_ref().unwrap()[0].node
                }
                "missing-union" => {
                    proof.returns[0].influences.pop().unwrap();
                }
                "wrong-union" => {
                    proof.returns[0].influences[8].query_id = Some(queries[0].id.clone())
                }
                _ => {
                    proof.returns[0]
                        .dependencies
                        .iter_mut()
                        .find(|dependency| dependency.query_id.is_some())
                        .unwrap()
                        .query_id = Some(queries[1].id.clone())
                }
            }
        } else if mode == "schema" {
            let id = item(&changed, "ThreeQueryPair.Budget.account").id;
            let IrItemKind::Field { ty, .. } = &mut changed.items[id.0 as usize].kind else {
                panic!("schema")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
        } else {
            let IrItemKind::Scenario {
                guards, effects, ..
            } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "guard-stage" {
                effects.insert(0, guards.remove(0));
            } else if mode == "return-turn" {
                let IrStmt::Return {
                    value: Some(value), ..
                } = effects.last_mut().unwrap()
                else {
                    panic!("Return")
                };
                value.expr = IrExpr::Name("turn".into());
                value.ty = ResolvedType::Record {
                    symbol: item(&ir, "ThreeQueryPair.Turn").id,
                    stored: true,
                };
            } else {
                let IrStmt::Create { input, .. } = &mut effects[3] else {
                    panic!("Turn")
                };
                let IrExpr::Object(fields) = &mut input.expr else {
                    panic!("Turn inputs")
                };
                if mode == "run-link" {
                    fields[2].1.expr = IrExpr::Name("branch".into());
                } else {
                    let IrExpr::Binary { left: call, .. } = &mut fields[1].1.expr else {
                        panic!("count+1")
                    };
                    if mode == "count-slot" {
                        let (IrExpr::Call { target, args }
                        | IrExpr::BoundCall { target, args, .. }) = &call.expr
                        else {
                            panic!("count")
                        };
                        call.expr = IrExpr::BoundCall {
                            target: target.clone(),
                            args: args.clone(),
                            slots: vec![None],
                        };
                    } else {
                        let (IrExpr::Call { target, .. } | IrExpr::BoundCall { target, .. }) =
                            &mut call.expr
                        else {
                            panic!("count")
                        };
                        let IrCallTarget::Builtin { id, .. } = target else {
                            panic!("builtin")
                        };
                        *id = "first".into();
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
    // A second required Branch is a legal declaration and has the same type;
    // it cannot replace the original source receiver merely by type equality.
    let alternate = SOURCE.replace(
        "generate(branch:Branch,",
        "generate(branch:Branch,altBranch:Branch,",
    );
    let (alt_db, alt_program, mut alt_ir, alt_catalog) =
        checked(&alternate, "alternate-branch.can");
    let alt_owner = item(&alt_ir, OWNER).id;
    assert!(
        serialize_complete_query_receipt(
            &alt_program,
            &alt_ir,
            &alt_ir.items[alt_owner.0 as usize],
            &alt_db,
            Some(&alt_catalog),
            ENTRY
        )
        .is_some(),
        "legal unused same-typed parameter baseline"
    );
    let IrItemKind::Scenario { effects, .. } = &mut alt_ir.items[alt_owner.0 as usize].kind else {
        panic!("scenario")
    };
    let IrStmt::Create { input, .. } = &mut effects[3] else {
        panic!("Turn")
    };
    let IrExpr::Object(fields) = &mut input.expr else {
        panic!("input")
    };
    let IrExpr::Binary { left: call, .. } = &mut fields[1].1.expr else {
        panic!("count")
    };
    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &mut call.expr else {
        panic!("Call")
    };
    let IrExpr::Query(query) = &mut args[0].expr else {
        panic!("Query")
    };
    query.parent.as_mut().unwrap().expr = IrExpr::Name("altBranch".into());
    assert!(
        serialize_complete_query_receipt(
            &alt_program,
            &alt_ir,
            &alt_ir.items[alt_owner.0 as usize],
            &alt_db,
            Some(&alt_catalog),
            ENTRY
        )
        .is_none(),
        "foreign same-typed parent receiver"
    );
    let mut stale = SourceDb::new();
    stale.add(
        "native-three-query-run-turn.can".into(),
        SOURCE.replace(
            "position=count(branch.Turn)+1",
            "position=count(branch.Turn)+2",
        ),
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
    let (db, mut program, ir, catalog) = checked(SOURCE, "native-three-query-run-turn.can");
    let id = item(&ir, "ThreeQueryPair.Run.unfinished").id;
    program
        .types
        .symbol_types
        .insert(id, ResolvedType::Scalar(Scalar::Text));
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
    let copied = SOURCE
        .replace("   create Run", "   let copy=budget\n   create Run")
        .replace("{parent=branch,budget,", "{parent=branch,budget=copy,");
    let (db, program, _, catalog) = checked(&copied, "copied-three-query.can");
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "copied first Budget: {diagnostics:?}"
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
