//! Bounded original first Budget + counted Turn composition. Real source,
//! compiler and installed descriptors are exercised; native execution is separate.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    DependencyRole, DisclosureEffectKind, DisclosureIntrinsicKind, ScenarioDisclosure,
};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_queries::serialize_complete_query_receipt;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/native-first-count-run-turn.can");
const HASH: &str = "8378ca9b432348f1e5c4b4ab1ecb7b544da7454d0a117b8121398b6f6b3e5813";
const OWNER: &str = "FirstCountPair.generate";
const ENTRY: &str = "$can$m$4669727374436f756e7450616972.mjs";

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
    let catalog_path = native_owner().join("packages/cloudflare/dist/native-catalog.json");
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
    use canlang_compiler::codegen::artifact::to_json;
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    let mut result = DiagnosticResult::new("first-count-pair", "1.0", 1);
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

fn role(value: DependencyRole) -> &'static str {
    match value {
        DependencyRole::Data => "data",
        DependencyRole::Control => "control",
    }
}

fn assert_plan(plan: &Value, ir: &IrProgram, path: &str) {
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&item(ir, OWNER).id] else {
        panic!("complete original source")
    };
    let facts = proof.source_facts.as_ref().unwrap();
    let [first, count] = plan["queries"].as_array().unwrap().as_slice() else {
        panic!("two original queries")
    };
    assert_eq!(plan["source"]["path"], path);
    assert_eq!(plan["source"]["sha256"], HASH);
    assert_eq!(first["model"], "FirstCountPair.Budget");
    assert!(first.get("parent").is_none());
    assert_eq!(
        first["order"],
        serde_json::json!([{"field":"id","direction":"asc"}])
    );
    assert_eq!(first["dependencies"].as_array().unwrap().len(), 1);
    let candidate = &first["dependencies"][0];
    assert_eq!(candidate["field"], "account");
    assert_eq!(candidate["type"], "user");
    assert_eq!(candidate["role"], "control");
    assert_eq!(count["model"], "FirstCountPair.Turn");
    assert_eq!(count["dependencies"], serde_json::json!([]));
    assert_eq!(count["order"], serde_json::json!([]));
    assert_eq!(
        count["parent"],
        serde_json::json!({"source":plan["source"],"model":"FirstCountPair.Branch",
        "origin":{"kind":"admitted-reference","parameter":"branch"}})
    );
    for query in [first, count] {
        assert_eq!(query["source"], plan["source"]);
        assert!(query["limit"].is_null());
        assert_eq!(query["archived"], "exclude");
    }
    let queries = facts.queries.as_ref().unwrap();
    assert_eq!(first["id"], queries[0].id);
    assert_eq!(count["id"], queries[1].id);
    let returns = plan["returns"].as_array().unwrap();
    assert_eq!(returns.len(), proof.returns.len());
    assert!(!returns.is_empty());
    for (native, original) in returns.iter().zip(&proof.returns) {
        assert_eq!(native["id"], original.id);
        assert_eq!(native["source"], plan["source"]);
        assert!(native["projection"].is_null());
        let influences = native["influences"].as_array().unwrap();
        assert_eq!(influences.len(), 8);
        for (query, group) in [first, count]
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
        for (transported, source) in dependencies.iter().zip(&original.dependencies) {
            assert_eq!(transported["id"], source.id);
            assert_eq!(transported["model"], source.model_name);
            assert_eq!(transported["field"], source.field_name);
            assert_eq!(transported["type"], source.type_id);
            assert_eq!(transported["role"], role(source.role));
            assert_eq!(transported["source"]["path"], source.source.path);
            assert_eq!(transported["source"]["sha256"], source.source.sha256);
            assert_eq!(transported["source"]["module"], plan["source"]["module"]);
        }
        let intrinsics = native["intrinsics"].as_array().cloned().unwrap_or_default();
        assert_eq!(intrinsics.len(), original.intrinsics.len());
        for (transported, source) in intrinsics.iter().zip(&original.intrinsics) {
            assert_eq!(transported["id"], source.id);
            assert_eq!(transported["type"], source.type_id);
            assert_eq!(transported["role"], role(source.role));
            assert_eq!(transported["source"]["path"], source.source.path);
            assert_eq!(transported["source"]["sha256"], source.source.sha256);
            match &source.kind {
                DisclosureIntrinsicKind::OperationId => {
                    assert_eq!(transported["kind"], "operation-id")
                }
                DisclosureIntrinsicKind::AdmittedInput { parameter_name, .. } => {
                    assert_eq!(transported["kind"], "admitted-input");
                    assert_eq!(transported["parameter"], parameter_name.as_str());
                }
                DisclosureIntrinsicKind::AdmittedReferenceVersion {
                    parameter_name,
                    model_name,
                    ..
                } => {
                    assert_eq!(transported["kind"], "admitted-reference-version");
                    assert_eq!(transported["parameter"], parameter_name.as_str());
                    assert_eq!(transported["model"], model_name.as_str());
                }
            }
        }
    }
    for field in ["active", "running", "parallel", "spent", "held", "cap"] {
        assert!(
            returns
                .iter()
                .flat_map(|returned| returned["dependencies"].as_array().unwrap())
                .any(|dependency| dependency["model"] == "FirstCountPair.Budget"
                    && dependency["field"] == field),
            "ordinary selected Budget read {field}"
        );
    }
}

#[test]
fn checked_source_preserves_original_budget_and_ordered_first_count_pair() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    // Owning Budget source and numeric controls remain verbatim from the
    // previously qualified first-query fixture, rather than a weaker substitute.
    let first_source = include_str!("fixtures/native-first-budget.can");
    for line in first_source.lines().filter(|line| {
        line.starts_with(" Budget {")
            || line.starts_with(" policy Budget")
            || line.starts_with(" invariant Budget")
            || line.starts_with(" lock Budget")
            || line.starts_with("   let budget=")
            || line.starts_with("   require budget")
            || line.starts_with("   set budget")
    }) {
        assert!(
            SOURCE.lines().any(|original| original == line),
            "original Budget clause: {line}"
        );
    }
    let (db, _, ir, _) = checked(SOURCE, "native-first-count-run-turn.can");
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&item(&ir, OWNER).id] else {
        panic!("first+count original business source Complete")
    };
    let facts = proof.source_facts.as_ref().unwrap();
    let [first, count] = facts.queries.as_ref().unwrap().as_slice() else {
        panic!("two source queries")
    };
    assert!(first.first.is_some() && first.count.is_none());
    assert!(count.count.is_some() && count.first.is_none());
    assert!(first.node.end <= count.node.start);
    assert_eq!(first.model_name, "FirstCountPair.Budget");
    assert_eq!(count.model_name, "FirstCountPair.Turn");
    let text = |node: canlang_compiler::analysis::NodeKey| {
        &db.get(node.file).unwrap().text[node.start as usize..node.end as usize]
    };
    assert_eq!(text(first.predicate.unwrap()).trim(), "row.account==actor");
    assert_eq!(text(first.order[0].node), "row.id");
    assert_eq!(text(count.node), "branch.Turn");
    assert!(count.alias.is_none() && count.predicate.is_none());
    let [run, turn] = facts.creates.as_ref().unwrap().as_slice() else {
        panic!("two original Creates")
    };
    assert_eq!(run.binding, "run");
    assert_eq!(turn.binding, "turn");
    assert_eq!(count.count.as_ref().unwrap().statement, turn.node);
    assert_eq!(
        run.inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["parent", "budget"]
    );
    assert_eq!(
        turn.inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["parent", "position", "run"]
    );
    assert_eq!(text(turn.inputs[2].value_node), "run");
    let expected = first
        .influences
        .iter()
        .chain(&count.influences)
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(expected.len(), 8);
    assert!(
        proof
            .returns
            .iter()
            .all(|returned| returned.influences == expected)
    );
    assert_eq!(
        proof
            .effects
            .iter()
            .map(|effect| match effect.kind {
                DisclosureEffectKind::Create { .. } => "create",
                DisclosureEffectKind::Set { .. } => "set",
                DisclosureEffectKind::Send { .. } => "send",
                _ => "other",
            })
            .collect::<Vec<_>>(),
        ["create", "create", "set", "send", "set"]
    );
    let IrItemKind::Scenario { effects, .. } = &item(&ir, OWNER).kind else {
        panic!("scenario")
    };
    let IrStmt::Let { value, .. } = &effects[0] else {
        panic!("first binding")
    };
    let budget = item(&ir, "FirstCountPair.Budget").id;
    assert_eq!(
        value.ty,
        ResolvedType::Nullable(Box::new(ResolvedType::Record {
            symbol: budget,
            stored: true
        }))
    );
    let IrStmt::Create { input, .. } = &effects[2] else {
        panic!("Run Create after original first guard")
    };
    let IrExpr::Object(fields) = &input.expr else {
        panic!("Run fields")
    };
    assert_eq!(
        fields[1].1.ty,
        ResolvedType::Record {
            symbol: budget,
            stored: true
        }
    );
    let IrStmt::Set { record, .. } = &effects[4] else {
        panic!("original Budget Set")
    };
    assert!(matches!(&record.expr,IrExpr::Name(name) if name == "budget"));
    assert_eq!(
        record.ty,
        ResolvedType::Record {
            symbol: budget,
            stored: true
        }
    );
}

#[test]
fn actual_prepared_cli_verified_factory_and_installed_state_keep_both_original_query_consumers() {
    let (db, program, ir, catalog) = checked(SOURCE, "native-first-count-run-turn.can");
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(operation(&artifact)["result"]["type"], "FirstCountPair.Run");
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        &ir,
        "native-first-count-run-turn.can",
    );
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("native-first-count-run-turn.can");
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
    let (_, _, cli_ir, _) = checked(SOURCE, path.to_str().unwrap());
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        &cli_ir,
        path.to_str().unwrap(),
    );
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let runner = scratch.path().join("first-count-pair.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const ownerRequire=createRequire(resolve(process.argv[6],'package.json')),ownerLoad=name=>import(pathToFileURL(ownerRequire.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3])),hash=createHash('sha256').update(readFileSync(process.argv[4])).digest('hex');assert.equal(hash,process.argv[7]);
const stdlibUrl=pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,stdlib=await import(stdlibUrl);
for(const name of ['firstQuery','countQuery','executeScenarioReceiptQuery'])assert.equal(typeof stdlib[name],'function');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await ownerLoad('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],stdlibUrl,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const operation=artifact.operations.find(operation=>operation.name==='FirstCountPair.generate'),plan=operation.result.disclosure,[first,count]=plan.queries;
assert.equal(plan.queries.length,2);assert.equal(first.model,'FirstCountPair.Budget');assert.equal(Object.hasOwn(first,'parent'),false);
assert.deepEqual(first.order,[{field:'id',direction:'asc'}]);assert.equal(first.dependencies[0].field,'account');assert.equal(first.dependencies[0].role,'control');assert.equal(first.dependencies[0].type,'user');
assert.equal(count.model,'FirstCountPair.Turn');assert.deepEqual(count.parent,{source:plan.source,model:'FirstCountPair.Branch',origin:{kind:'admitted-reference',parameter:'branch'}});
assert.equal(plan.source.sha256,hash);assert.equal(plan.source.path,process.argv[4]);assert.equal(operation.result.type,'FirstCountPair.Run');
for(const returned of plan.returns){assert.equal(returned.influences.length,8);for(const [index,query] of [first,count].entries()){
 const group=returned.influences.slice(index*4,index*4+4);assert.deepEqual(group.map(influence=>influence.kind),['query-existence','query-cardinality','query-membership','query-order']);assert.ok(group.every(influence=>influence.queryId===query.id));}}
const loaded=loadArtifactDescriptors(artifact,{by:'members'});assert.deepEqual(loaded.registry.get(operation.name).descriptor.result.disclosure,plan);
assert.equal(loaded.containment.get('FirstCountPair.Run').parent,'FirstCountPair.Branch');assert.equal(loaded.containment.get('FirstCountPair.Turn').parent,'FirstCountPair.Branch');
const callable=artifact.callables.find(callable=>callable.id===operation.name),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
let handler=factory;for(const member of callable.member)handler=handler[member];const body=handler.toString();
for(const [pattern,total] of [[/\bexecuteScenarioReceiptQuery\(/g,2],[/\bfirstQuery\(/g,1],[/\bcountQuery\(/g,1],[/\bawait create\(/g,2],[/\bawait set\(/g,2],[/\bawait send\(/g,1],[/\bawait bindScenarioReceiptModelResult\(/g,1],[/\bselectScenarioReceiptReturn\(/g,1]])assert.equal((body.match(pattern)||[]).length,total);
const consumed=name=>new RegExp(`\\bawait ${name}\\(c,await executeScenarioReceiptQuery\\(c,`).test(body)||new RegExp(`\\bawait \\(\\(([$\\w]+)\\)=>${name}\\(c,\\1\\[0\\]\\)\\)\\(\\[await executeScenarioReceiptQuery\\(c,`).test(body);
assert.ok(consumed('firstQuery'));assert.ok(consumed('countQuery'));
for(const query of [first,count])assert.equal(body.split(`await executeScenarioReceiptQuery(c,${JSON.stringify(query.id)},`).length-1,1);
const run=/\bconst ([$\w]+) = await create\(c,"FirstCountPair\.Run",\{parent:([$\w]+),budget:([$\w]+)\}\);/.exec(body);
const turn=/\bconst ([$\w]+) = await create\(c,"FirstCountPair\.Turn",/.exec(body);assert.ok(run&&turn);
const selectedBudget=new RegExp(`\\bconst ${run[3].replace(/[$]/g,'\\$')} = await `).exec(body);assert.ok(selectedBudget&&selectedBudget.index<run.index,'original typed first Budget supplies Run.budget');
const firstUse=body.indexOf('firstQuery('),countUse=body.indexOf('countQuery('),budgetSet=body.indexOf('await set('),send=body.indexOf('await send('),runSet=body.indexOf('await set(',budgetSet+1),late=body.indexOf('check(',runSet);
const bound=body.indexOf('await bindScenarioReceiptModelResult('),selected=body.indexOf('selectScenarioReceiptReturn('),returned=body.lastIndexOf('return ');
assert.ok(firstUse<run.index&&run.index<turn.index&&turn.index<countUse&&countUse<budgetSet&&budgetSet<send&&send<runSet&&runSet<late&&late<bound&&bound<selected&&selected<returned);
const turnClause=body.slice(turn.index,budgetSet);assert.ok(turnClause.includes(`parent:${run[2]},position:int64(await `));assert.ok(turnClause.includes(`run:${run[1]}}`));assert.match(turnClause,/\+ 1n\)/);
assert.ok(body.includes(`const $receiptValue=${run[1]};`));assert.equal(body.includes('return $receiptModelResult;'),true);
assert.equal((body.match(/\["account"\]/g)||[]).length,1,'one original candidate account read');
const dependencies=[...new Map(plan.returns.flatMap(returned=>returned.dependencies).map(dependency=>[dependency.id,dependency])).values()];
for(const field of ['active','running','parallel','spent','held','cap'])assert.ok(dependencies.some(dependency=>dependency.model==='FirstCountPair.Budget'&&dependency.field===field));
for(const dependency of dependencies){const marker=`await observeScenarioReceiptDependency(c,${JSON.stringify(dependency.model)},$receiptRow,${JSON.stringify(dependency.field)},${JSON.stringify(dependency.id)});`;assert.equal(body.split(marker).length-1,1);}
const budgetPolicy=artifact.modelPolicies.find(policy=>policy.model==='FirstCountPair.Budget');assert.equal(budgetPolicy.abi,'state.owner-model-policies@1');
assert.deepEqual(budgetPolicy.rules.map(rule=>[rule.kind,rule.id]),[['invariant','FirstCountPair.Budget.require.1'],['lock','FirstCountPair.Budget.lock.1']]);assert.deepEqual(budgetPolicy.rules[1].fields,['account']);
const guard=module.appDefinition.operations[operation.name].sendGuards[0];assert.deepEqual(guard.inputs,[{name:'enabled',type:'bool'}]);assert.equal(guard.source.sha256,hash);
assert.equal(body.includes('when:{rule:'),true);assert.equal(body.includes('when:()=>'),false);assert.equal(/\brecords\(/.test(body),false);
console.log('Bounded first Budget plus counted Turn: real compiler/CLI/verified factory/installed State preserve two original queries, eight influences, selected typed Budget reads and ordered pair/SEND; native authority and execution unqualified');
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
fn source_ir_schema_prepared_and_query_association_mutants_refuse() {
    let (db, program, ir, catalog) = checked(SOURCE, "native-first-count-run-turn.can");
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
        "genuine positive collector"
    );
    for mode in [
        "queries-order",
        "count-owning-create",
        "first-order",
        "count-parent",
        "create-order",
        "run-link",
        "account-schema",
        "return-second",
        "send-guard",
        "return-query-association",
    ] {
        let mut changed = ir.clone();
        if matches!(
            mode,
            "queries-order" | "count-owning-create" | "return-query-association"
        ) {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("Complete")
            };
            let facts = proof.source_facts.as_mut().unwrap();
            let queries = facts.queries.as_mut().unwrap();
            match mode {
                "queries-order" => queries.swap(0, 1),
                "count-owning-create" => {
                    queries[1].count.as_mut().unwrap().statement =
                        facts.creates.as_ref().unwrap()[0].node
                }
                _ => proof.returns[0].influences[4].query_id = Some(queries[0].id.clone()),
            }
        } else if mode == "account-schema" {
            let field = item(&changed, "FirstCountPair.Budget.account").id;
            let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
                panic!("field")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            match mode {
                "create-order" => effects.swap(2, 3),
                "return-second" => {
                    let IrStmt::Return {
                        value: Some(value), ..
                    } = effects.last_mut().unwrap()
                    else {
                        panic!("Return")
                    };
                    value.expr = IrExpr::Name("turn".into());
                    value.ty = ResolvedType::Record {
                        symbol: item(&ir, "FirstCountPair.Turn").id,
                        stored: true,
                    };
                }
                "send-guard" => {
                    let IrStmt::Send {
                        when: Some(when), ..
                    } = &mut effects[5]
                    else {
                        panic!("SEND")
                    };
                    when.ty = ResolvedType::Scalar(Scalar::Text);
                }
                "first-order" => {
                    let IrStmt::Let { value, .. } = &mut effects[0] else {
                        panic!("first")
                    };
                    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) =
                        &mut value.expr
                    else {
                        panic!("first Call")
                    };
                    let IrExpr::Query(query) = &mut args[0].expr else {
                        panic!("first Query")
                    };
                    query.order[0].descending = true;
                }
                _ => {
                    let IrStmt::Create { input, .. } = &mut effects[3] else {
                        panic!("Turn")
                    };
                    let IrExpr::Object(fields) = &mut input.expr else {
                        panic!("Turn inputs")
                    };
                    if mode == "run-link" {
                        fields[2].1.expr = IrExpr::Name("branch".into());
                    } else {
                        let IrExpr::Binary { left, .. } = &mut fields[1].1.expr else {
                            panic!("count+1")
                        };
                        let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) =
                            &mut left.expr
                        else {
                            panic!("count")
                        };
                        let IrExpr::Query(query) = &mut args[0].expr else {
                            panic!("count Query")
                        };
                        query.parent.as_mut().unwrap().expr = IrExpr::Name("budget".into());
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
    for symbol in [
        "FirstCountPair.Budget.held",
        "FirstCountPair.generate.branch",
    ] {
        let (db, mut program, ir, catalog) = checked(SOURCE, "native-first-count-run-turn.can");
        program
            .types
            .symbol_types
            .insert(item(&ir, symbol).id, ResolvedType::Scalar(Scalar::Text));
        let (artifact, diagnostics) = prepared(&program, &db, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{symbol}: {diagnostics:?}"
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
    let mut stale = SourceDb::new();
    stale.add(
        "native-first-count-run-turn.can".into(),
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
    let copied = SOURCE
        .replace("   create Run", "   let copied=budget\n   create Run")
        .replace("{parent=branch,budget}", "{parent=branch,budget=copied}");
    let (db, program, _, catalog) = checked(&copied, "copied-first-count.can");
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "copied selected Budget: {diagnostics:?}"
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
