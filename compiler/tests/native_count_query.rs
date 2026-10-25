//! Bounded test-authored count(branch.Turn)+1 producer. Compilation and real
//! installed metadata/imports issue no rows, grants or native execution claim.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrBinOp, IrCallTarget, IrDefault, IrExpr, IrItem, IrItemKind, IrOwner, IrProgram,
    IrQueryDomain, IrStmt, TypedExpr,
};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_queries::serialize_complete_query_receipt;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/native-count-turn.can");
const HASH: &str = "4a6ee93932c1d4695145eb3b099ed5be8302c1b1fc68c7928f5205fe352fc28b";
const OWNER: &str = "CountSources.append";
const ENTRY: &str = "$can$m$436f756e74536f7572636573.mjs";

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

fn fixture(path: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let mut db = SourceDb::new();
    let file = db.add(path.into(), SOURCE.into());
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

fn item<'a>(ir: &'a IrProgram, canonical: &str) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .unwrap()
}

fn prepared(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (Value, Vec<Diagnostic>) {
    use canlang_compiler::codegen::artifact::to_json;
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    let mut result = DiagnosticResult::new("count-query-source", "1.0", 1);
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

fn assert_plan(plan: &Value, path: &str, returns: &[&str]) {
    assert_eq!(plan["version"], 1);
    assert_eq!(plan["source"]["path"], path);
    assert_eq!(plan["source"]["sha256"], HASH);
    let [query] = plan["queries"].as_array().unwrap().as_slice() else {
        panic!("one original contained count query")
    };
    assert_eq!(query["source"], plan["source"]);
    assert_eq!(query["model"], "CountSources.Turn");
    assert_eq!(
        query["parent"],
        serde_json::json!({
            "source": plan["source"], "model": "CountSources.Branch",
            "origin": {"kind": "admitted-reference", "parameter": "branch"},
        })
    );
    assert_eq!(query["order"], serde_json::json!([]));
    assert!(query["limit"].is_null());
    assert_eq!(query["archived"], "exclude");
    assert_eq!(query["dependencies"], serde_json::json!([]));
    assert_eq!(
        plan["returns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|returned| returned["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        returns
    );
    assert!(!returns.is_empty());
    for returned in plan["returns"].as_array().unwrap() {
        assert_eq!(returned["source"], plan["source"]);
        assert!(returned["projection"].is_null());
        assert_eq!(returned["dependencies"], serde_json::json!([]));
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
fn genuine_driver_cli_and_installed_count_keep_original_parent_and_once_arithmetic() {
    let (db, program, ir, catalog) = fixture("native-count-turn.can");
    let owner = item(&ir, OWNER);
    let branch = item(&ir, "CountSources.Branch");
    let conversation = item(&ir, "CountSources.Conversation");
    let turn = item(&ir, "CountSources.Turn");
    assert!(
        matches!(&branch.kind, IrItemKind::Model {owner:IrOwner::ChildOf(id),..}
        if *id == conversation.id)
    );
    assert!(
        matches!(&turn.kind, IrItemKind::Model {owner:IrOwner::ChildOf(id),..}
        if *id == branch.id)
    );
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!("bounded count source must be Complete")
    };
    let [query] = proof
        .source_facts
        .as_ref()
        .unwrap()
        .queries
        .as_ref()
        .unwrap()
        .as_slice()
    else {
        panic!("one real contained query source")
    };
    let count = query.count.as_ref().unwrap();
    let text = |key: canlang_compiler::analysis::NodeKey| {
        db.get(key.file).unwrap().text[key.start as usize..key.end as usize].trim()
    };
    assert_eq!(text(count.call), "count(branch.Turn)");
    assert_eq!(text(query.node), "branch.Turn");
    assert_eq!(query.domain, query.node);
    assert!(query.alias.is_none() && query.predicate.is_none() && query.first.is_none());
    assert!(query.projection.is_none() && count.parent_edges.is_empty());
    let (parent_node, parameter) = count.contained_parent.unwrap();
    assert_eq!(text(parent_node), "branch");
    assert_eq!(parameter, item(&ir, "CountSources.append.branch").id);
    assert_eq!(query.inputs, vec![(parent_node, parameter)]);
    let selected = &program.types.selected_calls[&count.call];
    assert_eq!(selected.slots, vec![Some(0)]);
    assert_eq!(selected.slots, count.slots);
    assert!(matches!(&selected.target,
        canlang_compiler::analysis::types::SelectedCallTarget::Builtin {id,overload}
        if id == "count" && *overload == count.overload));
    assert_eq!(
        program.types.node_types[&count.call],
        ResolvedType::Scalar(Scalar::Int)
    );
    assert_eq!(query.model, turn.id);
    let IrItemKind::Scenario {
        params, effects, ..
    } = &owner.kind
    else {
        panic!("scenario")
    };
    assert_eq!(params, &[parameter]);
    assert!(matches!(&ir.items[parameter.0 as usize].kind,
        IrItemKind::Param {index:0,ty:ir::IrType::Known(ResolvedType::Record{symbol,stored:true}),default:None,..}
        if *symbol == branch.id));
    let [
        IrStmt::Create {
            input,
            binding: Some(binding),
            span,
            ..
        },
        IrStmt::Return {
            value: Some(returned),
            ..
        },
    ] = effects.as_slice()
    else {
        panic!("single populated Create then same row Return")
    };
    assert_eq!(
        *span,
        Span::new(
            count.statement.file,
            count.statement.start,
            count.statement.end
        )
    );
    assert!(matches!(&returned.expr, IrExpr::Name(name) if name == binding));
    let IrExpr::Object(fields) = &input.expr else {
        panic!("owning inputs")
    };
    assert_eq!(
        fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["parent", "position"]
    );
    assert!(matches!(&fields[0].1.expr, IrExpr::Name(name) if name == "branch"));
    let IrExpr::Binary {
        op: IrBinOp::Add,
        left,
        right,
    } = &fields[1].1.expr
    else {
        panic!("original count+1")
    };
    assert_eq!(
        left.span,
        Span::new(count.call.file, count.call.start, count.call.end)
    );
    assert_eq!(left.ty, ResolvedType::Scalar(Scalar::Int));
    assert!(matches!(right.expr, IrExpr::Int(1)));
    let (IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. }) = &left.expr
    else {
        panic!("count")
    };
    assert!(matches!(target, IrCallTarget::Builtin {id,awaited:false} if id == "count"));
    let [domain] = args.as_slice() else {
        panic!("one count operand")
    };
    let IrExpr::Query(actual) = &domain.expr else {
        panic!("real contained query lowering")
    };
    assert!(matches!(&actual.domain,IrQueryDomain::Model(name) if name == "CountSources.Turn"));
    assert_eq!(
        actual.parent.as_ref().unwrap().span,
        Span::new(parent_node.file, parent_node.start, parent_node.end)
    );
    assert!(matches!(&actual.parent.as_ref().unwrap().expr,IrExpr::Name(name) if name == "branch"));
    assert!(
        actual.source.is_none() && actual.collection_call.is_none() && actual.where_pred.is_none()
    );
    let returns: Vec<_> = proof
        .returns
        .iter()
        .map(|returned| returned.id.as_str())
        .collect();
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(operation(&artifact)["result"]["type"], "CountSources.Turn");
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        "native-count-turn.can",
        &returns,
    );

    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("native-count-turn.can");
    std::fs::write(&source, SOURCE.as_bytes()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_owner_root().join("packages/cloudflare/dist/native-catalog.json"))
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
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    let (_, _, cli_ir, _) = fixture(source.to_str().unwrap());
    let ScenarioDisclosure::Complete(cli_proof) =
        &cli_ir.scenario_disclosures[&item(&cli_ir, OWNER).id]
    else {
        panic!("CLI source Complete")
    };
    let returns: Vec<_> = cli_proof
        .returns
        .iter()
        .map(|returned| returned.id.as_str())
        .collect();
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        source.to_str().unwrap(),
        &returns,
    );
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let runner = scratch.path().join("native-count-query.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const ownerRequire=createRequire(resolve(process.argv[6],'package.json')),ownerLoad=name=>import(pathToFileURL(ownerRequire.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3])),source=readFileSync(process.argv[4],'utf8'),hash=createHash('sha256').update(source).digest('hex');
assert.equal(hash,process.argv[7]);
const stdlibUrl=pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,stdlib=await import(stdlibUrl);
assert.equal(typeof stdlib.countQuery,'function','released genuine countQuery export');assert.equal(typeof stdlib.executeScenarioReceiptQuery,'function');
const state=await ownerLoad('@canlang/state/invocation');assert.equal(typeof state.bindScenarioReceiptQueryCount,'function');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await ownerLoad('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],stdlibUrl,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const operation=artifact.operations.find(operation=>operation.name==='CountSources.append'),plan=operation.result.disclosure,query=plan.queries[0];
assert.equal(operation.result.type,'CountSources.Turn');
assert.equal(plan.source.path,process.argv[4]);assert.equal(plan.source.sha256,hash);assert.deepEqual(query.source,plan.source);
assert.equal(query.model,'CountSources.Turn');assert.deepEqual(query.parent,{source:plan.source,model:'CountSources.Branch',origin:{kind:'admitted-reference',parameter:'branch'}});
assert.deepEqual(query.order,[]);assert.equal(query.limit,null);assert.equal(query.archived,'exclude');assert.deepEqual(query.dependencies,[]);
assert.equal(operation.inputs.fields.length,1);const input=operation.inputs.fields[0];assert.equal(input.name,'branch');assert.equal(input.required,true);
assert.deepEqual(input.field,{kind:'ref',model:'CountSources.Branch',requireVersion:true});assert.equal(Object.hasOwn(input,'default'),false);
assert.equal(artifact.models.find(model=>model.name==='CountSources.Turn').parent,'CountSources.Branch');
assert.equal(artifact.models.find(model=>model.name==='CountSources.Branch').parent,'CountSources.Conversation');
assert.ok(plan.returns.length>0);for(const returned of plan.returns){assert.deepEqual(returned.dependencies,[]);assert.equal(Object.hasOwn(returned,'projection'),false);
 assert.deepEqual(returned.influences.map(influence=>influence.kind),['query-existence','query-cardinality','query-membership','query-order']);assert.ok(returned.influences.every(influence=>influence.queryId===query.id));}
const callable=artifact.callables.find(callable=>callable.id===operation.name),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
assert.equal(module.appDefinition.operations[operation.name].by,'members');assert.equal(module.appDefinition.operations[operation.name].read,false);
let handler=factory;for(const member of callable.member)handler=handler[member];const body=handler.toString();
for(const pattern of [/\bexecuteScenarioReceiptQuery\(/g,/\bcountQuery\(/g,/\bint64\(/g,/\bawait create\(/g,/\bawait bindScenarioReceiptModelResult\(/g,/\bselectScenarioReceiptReturn\(/g])assert.equal((body.match(pattern)||[]).length,1);
const wrapped=/\bawait \(\(([$\w]+)\)=>countQuery\(c,\1\[0\]\)\)\(\[await executeScenarioReceiptQuery\(c,/.test(body);
const direct=/\bawait countQuery\(c,await executeScenarioReceiptQuery\(c,/.test(body);
assert.ok(wrapped||direct,'original issued result feeds one awaited countQuery');
assert.ok(body.includes(`await executeScenarioReceiptQuery(c,${JSON.stringify(query.id)},`));
assert.match(body,/(?:parent|"parent"):([$\w]+),(?:position|"position"):int64\(await /,'authored parent then position input order');
assert.match(body,/int64\(await [\s\S]*countQuery\([\s\S]*\+ 1n\)/,'count settles before original +1');
const create=body.indexOf('await create('),count=body.indexOf('countQuery('),execute=body.indexOf('executeScenarioReceiptQuery(');
const bound=body.indexOf('await bindScenarioReceiptModelResult('),selected=body.indexOf('selectScenarioReceiptReturn('),returned=body.lastIndexOf('return ');
// Arguments settle before create is invoked even though its name is printed
// before its input expression. The wrapped callback likewise executes last.
assert.ok(create>=0&&count>create&&execute>create&&count<bound&&execute<bound&&bound<selected&&selected<returned);
assert.equal(body.includes('return $receiptModelResult;'),true);assert.equal(/\bcount\(/.test(body),false);assert.equal(/\brecords\(/.test(body),false);
console.log('Bounded Turn count: prepared compiler/CLI/verified factory source, real installed countQuery and State count binder imports passed; installed descriptor acceptance follows');
const installed=loadArtifactDescriptors(artifact,{by:'members'}).registry.get(operation.name).descriptor;
assert.deepEqual(installed.result.disclosure,plan);
console.log('Bounded Turn count: actual compiler/CLI/verified factory/installed State retain original required parent, count +1 and once awaited ordering; native execution unqualified');
"#).unwrap();
    let output = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact_path)
        .arg(&source)
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
fn same_span_count_cst_ir_parent_schema_and_prepared_type_mutations_refuse() {
    let (db, program, ir, catalog) = fixture("native-count-turn.can");
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
        "genuine prepared positive collector baseline"
    );
    let (artifact, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(operation(&artifact)["result"]["disclosure"].is_object());
    for mode in [
        "count-target",
        "count-type",
        "count-slot",
        "query-model",
        "query-parent",
        "query-parent-type",
        "arithmetic-literal",
        "input-order",
        "parent-declaration",
        "parameter-default",
        "return-name",
        "facts-source",
        "facts-parent",
        "facts-count-node",
        "facts-overload",
        "facts-influence",
    ] {
        let mut changed = ir.clone();
        if mode.starts_with("facts-") {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("Complete")
            };
            let query = &mut proof
                .source_facts
                .as_mut()
                .unwrap()
                .queries
                .as_mut()
                .unwrap()[0];
            match mode {
                "facts-source" => query.source.sha256 = "0".repeat(64),
                "facts-parent" => {
                    query
                        .count
                        .as_mut()
                        .unwrap()
                        .contained_parent
                        .as_mut()
                        .unwrap()
                        .1 = item(&ir, "CountSources.Conversation").id
                }
                "facts-count-node" => query.count.as_mut().unwrap().call.end -= 1,
                "facts-overload" => query.count.as_mut().unwrap().overload += 1,
                _ => {
                    query.influences.pop().unwrap();
                }
            }
        } else if mode == "parent-declaration" {
            let child = item(&changed, "CountSources.Turn").id;
            let parent = item(&changed, "CountSources.Conversation").id;
            let IrItemKind::Model { owner, .. } = &mut changed.items[child.0 as usize].kind else {
                panic!("model")
            };
            *owner = IrOwner::ChildOf(parent);
        } else if mode == "parameter-default" {
            let id = item(&changed, "CountSources.append.branch").id;
            let span = changed.items[id.0 as usize].span;
            let IrItemKind::Param { default, .. } = &mut changed.items[id.0 as usize].kind else {
                panic!("parameter")
            };
            *default = Some(IrDefault::Literal(TypedExpr::new(
                IrExpr::Null,
                ResolvedType::Null,
                span,
            )));
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "return-name" {
                let IrStmt::Return {
                    value: Some(value), ..
                } = effects.last_mut().unwrap()
                else {
                    panic!("return")
                };
                value.expr = IrExpr::Name("branch".into());
            } else {
                let IrStmt::Create { input, .. } = &mut effects[0] else {
                    panic!("create")
                };
                let IrExpr::Object(fields) = &mut input.expr else {
                    panic!("input")
                };
                if mode == "input-order" {
                    fields.swap(0, 1);
                } else {
                    let IrExpr::Binary { left, right, .. } = &mut fields[1].1.expr else {
                        panic!("count+1")
                    };
                    if mode == "arithmetic-literal" {
                        right.expr = IrExpr::Int(2);
                    } else if mode == "count-type" {
                        left.ty = ResolvedType::Scalar(Scalar::Text);
                    } else if mode == "count-slot" {
                        let (IrExpr::Call { target, args }
                        | IrExpr::BoundCall { target, args, .. }) = &left.expr
                        else {
                            panic!("count")
                        };
                        left.expr = IrExpr::BoundCall {
                            target: target.clone(),
                            args: args.clone(),
                            slots: vec![None],
                        };
                    } else {
                        let (IrExpr::Call { target, args }
                        | IrExpr::BoundCall { target, args, .. }) = &mut left.expr
                        else {
                            panic!("count")
                        };
                        if mode == "count-target" {
                            let IrCallTarget::Builtin { id, .. } = target else {
                                panic!("builtin")
                            };
                            *id = "sum".into();
                        } else {
                            let IrExpr::Query(query) = &mut args[0].expr else {
                                panic!("contained query")
                            };
                            match mode {
                                "query-model" => {
                                    query.domain =
                                        IrQueryDomain::Model("CountSources.Branch".into())
                                }
                                "query-parent" => {
                                    query.parent.as_mut().unwrap().expr =
                                        IrExpr::Name("turn".into())
                                }
                                _ => {
                                    query.parent.as_mut().unwrap().ty = ResolvedType::Record {
                                        symbol: item(&ir, "CountSources.Conversation").id,
                                        stored: true,
                                    }
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
            "{mode}: original query source correspondence survived mutation"
        );
    }
    let raw = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "raw unprepared: {:?}",
        raw.diagnostics
    );
    assert!(
        raw.operations
            .iter()
            .find(|operation| operation.name == OWNER)
            .is_none_or(|operation| operation.disclosure.is_none())
    );
    let mut stale = SourceDb::new();
    stale.add(
        "native-count-turn.can".into(),
        SOURCE.replace("count(branch.Turn)+1", "count(branch.Turn)+2"),
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
    for canonical in ["CountSources.append.branch", "CountSources.Turn.position"] {
        let (db, mut program, ir, catalog) = fixture("native-count-turn.can");
        let id = item(&ir, canonical).id;
        program
            .types
            .symbol_types
            .insert(id, ResolvedType::Scalar(Scalar::Text));
        let (artifact, diagnostics) = prepared(&program, &db, &catalog);
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
