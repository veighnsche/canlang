//! Bounded original authorization source/producer checks; no native authority is issued here.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, Effects, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    CheckedDecisionCallTarget, CheckedDecisionStage, DependencyRole, DisclosureEffectKind,
    ScenarioDisclosure,
};
use canlang_compiler::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, TypedExpr,
};
use canlang_compiler::codegen::scenario_decisions::{
    collect_decision_sources, serialize_decision_sources,
};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, js};
use canlang_compiler::codegen::artifact::to_json;
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const SOURCE: &str = include_str!("fixtures/native-authorization-can-use.can");
const HASH: &str = "ce1ff3db9faf692bf641bf329c2f46f2897d9bfe1d51bc6913a5a18010429558";
const OWNER: &str = "AuthorizationCanUse.ask";
const DERIVE: &str = "AuthorizationCanUse.can_use";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn native_owner() -> PathBuf {
    // Each new capture consumes this worker's unchanged released SDK closure.
    root()
}
fn native_catalog() -> PathBuf {
    root().join("packages/cloudflare/dist/native-catalog.json")
}
fn load(db: &SourceDb, path: &Path) -> Catalog {
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(path),
        env: None,
        cwd: &root(),
        primary: Span::new(db.iter().next().unwrap().0, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}
fn checked(source: &str, path: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let catalog = load(&db, &native_catalog());
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}
fn item<'a>(ir: &'a IrProgram, name: &str) -> &'a IrItem {
    ir.items.iter().find(|item| item.canonical == name).unwrap()
}
fn text(db: &SourceDb, node: NodeKey) -> &str {
    db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
}
fn prepared(program: &CheckedProgram, db: &SourceDb, catalog: &Catalog) -> Value {
    let mut result = DiagnosticResult::new("authorization-source", "1.0", 1);
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
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    serde_json::from_str(&to_json(&artifact)).unwrap()
}
fn operation(artifact: &Value) -> &Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == OWNER)
        .unwrap()
}

#[test]
fn original_parent_authorization_retains_membership_chain_without_scalar_return_expansion() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let original = include_str!("fixtures/original-a850/CanChat.can");
    for clause in [
        "export derive can_use(person:user?,conversation:Conversation):bool = person!=null and active_member(person,team) and conversation.account==person and conversation.active",
        "policy Conversation read=members and row.account==actor",
        "policy Branch read=can_use(actor,row.parent)",
        "policy Branch read=members and row.parent.account==actor fields=parent",
    ] {
        assert!(
            original.contains(clause) && SOURCE.contains(clause),
            "original privacy clause {clause}"
        );
    }
    let (db, program, ir, catalog) = checked(SOURCE, "authorization.can");
    assert_eq!(catalog.effects("active_member"), Some(Effects::StateRead));
    let owner = item(&ir, OWNER);
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!(
            "bounded original authorization must be Complete: {:?}",
            ir.scenario_disclosures[&owner.id]
        );
    };
    assert_eq!(proof.source.path, "authorization.can");
    assert_eq!(proof.source.sha256, HASH);
    assert_eq!(proof.effects.len(), 1);
    assert!(
        matches!(&proof.effects[0].kind, DisclosureEffectKind::Create { binding, .. } if binding == "run")
    );
    assert!(!proof.returns.is_empty());
    for returned in &proof.returns {
        assert_eq!(text(&db, returned.node), "return run");
        assert!(returned.influences.is_empty());
        assert!(returned.dependencies.iter().any(|read| read.model_name
            == "AuthorizationCanUse.Branch"
            && read.field_name == "parent"
            && read.type_id == "AuthorizationCanUse.Conversation"
            && read.role == DependencyRole::Control
            && text(&db, read.node) == "branch.parent"
            && read.query_id.is_none()));
    }
    let sites = collect_decision_sources(&program, &ir, owner, &db, Some(&catalog)).unwrap();
    let [site] = sites.as_slice() else {
        panic!("one leading original authorization")
    };
    assert_eq!(site.stage, CheckedDecisionStage::LeadingRequire);
    assert_eq!(text(&db, site.node), "can_use(actor,branch.parent)");
    assert_eq!(
        text(&db, site.statement),
        "require can_use(actor,branch.parent)"
    );
    let [derive, member] = site.calls.as_slice() else {
        panic!("derive then selected membership")
    };
    assert!(
        matches!(&derive.target, CheckedDecisionCallTarget::DeriveFn(id) if *id == item(&ir, DERIVE).id)
    );
    assert_eq!(derive.slots, [Some(0), Some(1)]);
    assert!(derive.defaults.is_empty() && derive.chain.is_empty());
    assert_eq!(text(&db, derive.arguments[0].0), "actor");
    assert_eq!(text(&db, derive.arguments[1].0), "branch.parent");
    assert!(
        derive.arguments[0].1 == ResolvedType::Scalar(Scalar::User)
            || derive.arguments[0].1
                == ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::User)))
    );
    assert!(
        matches!(&member.target, CheckedDecisionCallTarget::Builtin {id,overload:0} if id == "active_member")
    );
    assert_eq!(text(&db, member.node), "active_member(person,team)");
    assert_eq!(member.slots, [Some(0), Some(1)]);
    assert_eq!(
        member
            .arguments
            .iter()
            .map(|(node, _)| text(&db, *node))
            .collect::<Vec<_>>(),
        ["person", "team"]
    );
    assert_eq!(member.arguments[0].1, ResolvedType::Scalar(Scalar::User));
    assert_eq!(member.arguments[1].1, ResolvedType::Team);
    assert_eq!(member.chain.len(), 1);
    assert_eq!(member.chain[0].derive, item(&ir, DERIVE).id);
    assert_eq!(member.chain[0].node, derive.node);
    assert_eq!(member.source, site.source);
    let artifact = prepared(&program, &db, &catalog);
    let plan = &operation(&artifact)["result"]["disclosure"];
    assert_eq!(
        operation(&artifact)["result"]["type"],
        "AuthorizationCanUse.Run"
    );
    assert_eq!(plan["source"]["sha256"], HASH);
    assert_eq!(
        plan["returns"].as_array().unwrap().len(),
        proof.returns.len()
    );
    assert!(plan["returns"].as_array().unwrap().iter().all(|returned| {
        returned["dependencies"]
            .as_array()
            .unwrap()
            .iter()
            .any(|read| {
                read["field"] == "parent"
                    && read["model"] == "AuthorizationCanUse.Branch"
                    && read["role"] == "control"
            })
    }));
    // Ordinary account/active guard reads retain the established authorization
    // pruning; their source/body/chain correspondence is checked below.
    let body = match &item(&ir, DERIVE).kind {
        IrItemKind::DeriveFn {
            expr: Some(body), ..
        } => body,
        _ => panic!("derive"),
    };
    assert!(
        db.get(body.span.file).unwrap().text[body.span.start as usize..body.span.end as usize]
            .contains("conversation.account==person and conversation.active")
    );
}

#[test]
fn actual_cli_verified_factory_and_installed_state_accept_original_leading_membership_sources() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("authorization.can");
    std::fs::write(&source, SOURCE).unwrap();
    // Isolate this capture from concurrent rebuilds of the installed catalogue.
    // Copy the real released input byte-for-byte; keep actual runtime imports.
    let catalog = scratch.path().join("native-catalog.json");
    std::fs::copy(native_catalog(), &catalog).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(&catalog)
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
    assert_eq!(
        operation(&artifact)["result"]["disclosure"]["source"]["sha256"],
        HASH
    );
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let runner = scratch.path().join("authorization.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));const ownerRequire=createRequire(resolve(process.argv[6],'package.json')),ownerLoad=name=>import(pathToFileURL(ownerRequire.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3])),source=readFileSync(process.argv[4],'utf8'),hash=createHash('sha256').update(source).digest('hex');assert.equal(hash,process.argv[7]);
const stdlibUrl=pathToFileURL(ownerRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,stdlib=await import(stdlibUrl);assert.equal(typeof stdlib.active_member,'function');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');const {loadArtifactDescriptors}=await ownerLoad('@canlang/state/invocation/registry');const {checkScenarioReceiptMembershipSites}=await import(pathToFileURL(resolve(process.argv[6],'packages/state/dist/src/invocation/scenario-membership-plan.js')));
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],stdlibUrl,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const operation=artifact.operations.find(operation=>operation.name==='AuthorizationCanUse.ask'),callable=artifact.callables.find(callable=>callable.id===operation.name),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
const loaded=loadArtifactDescriptors(artifact,{by:'members'});assert.deepEqual(loaded.registry.get(operation.name).descriptor.result.disclosure,operation.result.disclosure);assert.equal(loaded.containment.get('AuthorizationCanUse.Run').parent,'AuthorizationCanUse.Branch');assert.equal(loaded.containment.get('AuthorizationCanUse.Branch').parent,'AuthorizationCanUse.Conversation');
const sources=module.canMembershipSources(),sites=checkScenarioReceiptMembershipSites(sources[operation.name]);assert.equal(sites.length,1);assert.ok(Object.isFrozen(sites));const [site]=sites;assert.equal(site.stage,'leading-require');assert.equal(site.owner,operation.name);assert.equal(site.source.path,process.argv[4]);assert.equal(site.source.sha256,hash);assert.equal(source.slice(site.node.start,site.node.end).trim(),'can_use(actor,branch.parent)');
const [derive,member]=site.calls;assert.equal(derive.target.name,'AuthorizationCanUse.can_use');assert.deepEqual(derive.slots,[0,1]);assert.deepEqual(derive.defaults,[]);assert.equal(member.target.id,'active_member');assert.equal(member.target.overload,0);assert.deepEqual(member.slots,[0,1]);assert.deepEqual(member.arguments.map(argument=>argument.type),['user','Team']);assert.equal(member.chain.length,1);assert.equal(member.chain[0].derive,derive.target.name);assert.deepEqual(member.chain[0].node,derive.node);assert.equal(source.slice(member.node.start,member.node.end).trim(),'active_member(person,team)');
sources[operation.name][0].calls[1].chain[0].derive='forged';assert.deepEqual(module.canMembershipSources()[operation.name],sites);
for(const change of [s=>s.stage='unknown-stage',s=>s.calls[1].arguments[1].type='user',s=>s.calls[1].slots=[0,0],s=>s.calls[1].chain[0].derive='']){const edited=structuredClone(sites);change(edited[0]);assert.throws(()=>checkScenarioReceiptMembershipSites(edited));}
let handler=factory;for(const name of callable.member)handler=handler[name];const body=handler.toString();assert.equal((body.match(/\bawait create\(/g)||[]).length,1);assert.equal((body.match(/\bawait bindScenarioReceiptModelResult\(/g)||[]).length,1);assert.equal((body.match(/\bselectScenarioReceiptReturn\(/g)||[]).length,1);const checked=body.indexOf('check('),created=body.indexOf('await create('),bound=body.indexOf('await bindScenarioReceiptModelResult(');assert.ok(checked>=0&&checked<created&&created<bound);assert.ok(body.includes('return $receiptModelResult;'));
const js=artifact.modules.find(output=>output.path===callable.module).js,helper=js.split('\n').find(line=>line.startsWith('export async function')&&line.includes('active_member(')&&line.includes('.account')&&line.includes('.active'));assert.ok(helper);assert.equal((helper.match(/\bawait active_member\(/g)||[]).length,1);const memberCall=helper.indexOf('await active_member('),account=helper.indexOf('.account'),active=helper.indexOf('.active');assert.ok(helper.indexOf('null')<memberCall&&memberCall<account&&account<active);assert.equal((helper.match(/&&/g)||[]).length,3);assert.equal((helper.match(/\.account\b/g)||[]).length,1);assert.equal((helper.match(/\.active\b/g)||[]).length,1);
console.log('Bounded original can_use source/CLI/verified factory/installed State preserve leading membership, genuine parent identity and lazy helper order; native authority/execution remain separate');
"#).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(artifact_path)
        .arg(source)
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

fn expression_mut<'a>(
    expr: &'a mut TypedExpr,
    source: &str,
    needle: &str,
) -> Option<&'a mut TypedExpr> {
    if source[expr.span.start as usize..expr.span.end as usize].trim() == needle {
        return Some(expr);
    }
    match &mut expr.expr {
        IrExpr::Binary { left, right, .. } => {
            expression_mut(left, source, needle).or_else(|| expression_mut(right, source, needle))
        }
        IrExpr::Member { base, .. } => expression_mut(base, source, needle),
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => args
            .iter_mut()
            .find_map(|arg| expression_mut(arg, source, needle)),
        _ => None,
    }
}

#[test]
fn original_authorization_source_chain_and_same_span_semantic_edits_refuse() {
    let (db, program, ir, catalog) = checked(SOURCE, "authorization.can");
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
        "source",
        "chain",
        "slots",
        "subject",
        "team",
        "account",
        "active",
        "parent",
        "formal",
        "type",
        "stage",
        "call-span",
    ] {
        let mut changed = ir.clone();
        if matches!(mode, "source" | "chain") {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("Complete")
            };
            // Source facts are retained independently of mutable IR nodes.
            let facts = proof.source_facts.as_mut().expect("owning source facts");
            if mode == "source" {
                facts.source.sha256 = "0".repeat(64);
            } else {
                facts.decision_sites.as_mut().unwrap()[0].calls[1].chain[0].derive = owner;
            }
        } else if mode == "formal" {
            let derive = item(&changed, DERIVE).id;
            let IrItemKind::DeriveFn { params, .. } = &mut changed.items[derive.0 as usize].kind
            else {
                panic!("derive")
            };
            params.swap(0, 1);
        } else if matches!(mode, "parent" | "stage" | "call-span") {
            let IrItemKind::Scenario {
                guards, effects, ..
            } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "stage" {
                effects.insert(0, guards.remove(0));
            } else {
                let IrStmt::Require { cond, .. } = &mut guards[0] else {
                    panic!("guard")
                };
                if mode == "parent" {
                    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) =
                        &mut cond.expr
                    else {
                        panic!("outercall")
                    };
                    let IrExpr::Member { field, .. } = &mut args[1].expr else {
                        panic!("parent")
                    };
                    *field = "title".into();
                } else {
                    cond.span.start += 1;
                }
            }
        } else {
            let derive = item(&changed, DERIVE).id;
            let IrItemKind::DeriveFn {
                expr: Some(body), ..
            } = &mut changed.items[derive.0 as usize].kind
            else {
                panic!("body")
            };
            let needle = match mode {
                "slots" | "subject" => "active_member(person,team)",
                "team" => "team",
                "account" => "conversation.account",
                "active" | "type" => "conversation.active",
                _ => unreachable!(),
            };
            let expr = expression_mut(body, SOURCE, needle).unwrap();
            match mode {
                "slots" => {
                    let (IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. }) =
                        &expr.expr
                    else {
                        panic!("membership")
                    };
                    expr.expr = IrExpr::BoundCall {
                        target: target.clone(),
                        args: args.clone(),
                        slots: vec![Some(0), Some(0)],
                    };
                }
                "subject" => {
                    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) =
                        &mut expr.expr
                    else {
                        panic!("membership")
                    };
                    args[0].expr = IrExpr::Name("actor".into());
                }
                "team" => expr.expr = IrExpr::Name("actor".into()),
                "account" => {
                    let IrExpr::Member { field, .. } = &mut expr.expr else {
                        panic!("account")
                    };
                    *field = "active".into();
                }
                "active" => expr.expr = IrExpr::Bool(true),
                "type" => expr.ty = ResolvedType::Scalar(Scalar::User),
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
        assert!(
            serialize_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog)
            )
            .is_none(),
            "transport {mode}"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "authorization.can".into(),
        SOURCE.replace("conversation.active", "conversation.title!=\"\""),
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
    let raw = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("membership observation")),
        "{:?}",
        raw.diagnostics
    );
    // Raw JS output may retain authored descriptor metadata alongside refusal
    // diagnostics. E6008 prevents public artifact publication and execution.
    // A mutable checked type table cannot rewrite the original owning field
    // schema while leaving its original member occurrence and source intact.
    let (db, mut program, _, catalog) = checked(SOURCE, "authorization.can");
    let account = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "AuthorizationCanUse.Conversation.account")
        .unwrap()
        .id;
    program
        .types
        .symbol_types
        .insert(account, ResolvedType::Scalar(Scalar::Text));
    let mut result = DiagnosticResult::new("authorization-schema-mutant", "1.0", 1);
    result.add_sources(&db);
    let (artifact, diagnostics) = emit(
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
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "same-source schema mutation: {diagnostics:?}"
    );
    let artifact: Value = serde_json::from_str(&to_json(&artifact)).unwrap();
    assert!(
        operation(&artifact)["result"]["disclosure"].is_null(),
        "mutated owning Conversation schema has no native recipe"
    );
}

#[test]
fn catalog_pure_reclassification_and_defaulted_recursive_or_runtime_data_authorization_are_not_admitted()
 {
    let (db, _, _, catalog) = checked(SOURCE, "authorization.can");
    assert_eq!(catalog.effects("active_member"), Some(Effects::StateRead));
    let scratch = tempfile::tempdir().unwrap();
    let mut payload: Value =
        serde_json::from_slice(&std::fs::read(native_catalog()).unwrap()).unwrap();
    let entry = payload["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == "active_member")
        .unwrap();
    entry["effects"] = "pure".into();
    let path = scratch.path().join("pure-membership.json");
    std::fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
    let pure = load(&db, &path);
    let (program, diagnostics) = check_program(&db, &[db.iter().next().unwrap().0], Some(&pure));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let id = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == OWNER)
        .unwrap()
        .id;
    assert!(
        matches!(
            program.scenario_disclosures()[&id],
            ScenarioDisclosure::Declined(_)
        ),
        "Pure is not a checked membership authorization ABI"
    );
    for (mode, source) in [
        (
            "default",
            SOURCE.replace(
                "person:user?,conversation:",
                "person:user?=null,conversation:",
            ),
        ),
        (
            "recursive",
            SOURCE.replace(
                "conversation.active\n",
                "conversation.active and can_use(person,conversation)\n",
            ),
        ),
        (
            "copied-parent",
            SOURCE.replace(
                "  require can_use(actor,branch.parent)\n  do\n",
                "  do\n   let copied=branch.parent\n   require can_use(actor,copied)\n",
            ),
        ),
        (
            "runtime-data",
            SOURCE
                .replace(" by=members -> Run", " by=members -> bool")
                .replace("  require can_use(actor,branch.parent)\n", "")
                .replace(
                    "   create Run {parent=branch,unfinished=true} as run\n   return run",
                    "   return can_use(actor,branch.parent)",
                ),
        ),
    ] {
        let mut own = SourceDb::new();
        let file = own.add(format!("{mode}.can"), source);
        let (program, diagnostics) = check_program(&own, &[file], Some(&catalog));
        if diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == canlang_compiler::diagnostic::Severity::Error)
        {
            assert!(
                program.scenario_disclosures().is_empty(),
                "{mode}: rejected source cannot supply authorization facts"
            );
            continue;
        }
        assert!(diagnostics.is_empty(), "{mode}: {diagnostics:?}");
        let id = program
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == OWNER)
            .unwrap()
            .id;
        assert!(
            matches!(
                program.scenario_disclosures()[&id],
                ScenarioDisclosure::Declined(_)
            ),
            "{mode}: bounded authorization only"
        );
    }
}

#[test]
fn renamed_authorization_declaration_and_formals_keep_the_original_source_relation() {
    let source = SOURCE
        .replace("can_use", "may_access")
        .replace("person", "principal")
        .replace("conversation", "subject")
        .replace("Conversation", "Topic");
    let (db, program, ir, catalog) = checked(&source, "renamed-authorization.can");
    let owner = item(&ir, OWNER);
    let sites = collect_decision_sources(&program, &ir, owner, &db, Some(&catalog)).unwrap();
    assert_eq!(sites.len(), 1);
    assert!(matches!(&sites[0].calls[0].target,
        CheckedDecisionCallTarget::DeriveFn(id) if *id == item(&ir, "AuthorizationCanUse.may_access").id));
    assert_eq!(text(&db, sites[0].calls[1].arguments[0].0), "principal");
    let artifact = prepared(&program, &db, &catalog);
    assert!(!operation(&artifact)["result"]["disclosure"].is_null());
    assert_eq!(
        operation(&artifact)["result"]["disclosure"]["source"]["sha256"],
        sha256_hex(source.as_bytes())
    );
}

#[test]
fn aliased_exported_authorization_and_model_keep_binding_slots_and_body_sealed() {
    let library = SOURCE
        .replace("can_use", "may_access")
        .replace("person", "principal")
        .replace("conversation", "subject")
        .replace("\n Conversation {", "\n export Conversation {")
        .replace(" policy Conversation read=", " export derive other_access(principal:user?,subject:Conversation):bool = principal!=null and active_member(principal,team) and subject.account==principal and subject.active\n policy Conversation read=");
    let caller = "app AliasCaller\nuse AuthorizationCanUse {Conversation as Topic,may_access as authorize}\nGiven\n Result {active:bool=true}\n policy Result read=members\nWhen\n scenario ask(conversation:Topic?=null) by=members -> Result\n  require conversation==null or authorize(actor,conversation)\n  do\n   create Result {active=true} as run\n   return run\nThen\n";
    let mut db = SourceDb::new();
    let library_file = db.add("authorization.can".into(), library.clone());
    let caller_file = db.add("caller.can".into(), caller.into());
    let catalog = load(&db, &native_catalog());
    let (program, diagnostics) = check_program(&db, &[library_file, caller_file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = item(&ir, "AliasCaller.ask").id;
    let helper = item(&ir, "AuthorizationCanUse.may_access").id;
    let sites = collect_decision_sources(
        &program,
        &ir,
        &ir.items[owner.0 as usize],
        &db,
        Some(&catalog),
    )
    .unwrap();
    assert!(sites.iter().flat_map(|site| &site.calls).any(
        |call| matches!(&call.target, CheckedDecisionCallTarget::DeriveFn(id) if *id == helper)
    ));
    let artifact = prepared(&program, &db, &catalog);
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "AliasCaller.ask")
        .unwrap();
    assert!(!operation["result"]["disclosure"].is_null());
    assert_eq!(
        operation["inputs"]["fields"][0]["field"]["model"],
        "AuthorizationCanUse.Conversation"
    );
    for mode in ["import-binding", "formal-slot", "body"] {
        let mut changed = ir.clone();
        match mode {
            "import-binding" => {
                let module = changed.items[owner.0 as usize].module;
                let member = changed.modules[module.0 as usize]
                    .imports
                    .iter_mut()
                    .flat_map(|import| &mut import.members)
                    .find(|(_, alias, _)| alias == "authorize")
                    .unwrap();
                member.0 = "other_access".into();
                // The decision collector seals the executable target; its
                // source-expression consumer also checks the imported spelling.
                let IrItemKind::Scenario { guards, .. } = &mut changed.items[owner.0 as usize].kind
                else {
                    panic!("caller")
                };
                let IrStmt::Require { cond, .. } = &mut guards[0] else {
                    panic!("guard")
                };
                let call = expression_mut(cond, caller, "authorize(actor,conversation)").unwrap();
                let (IrExpr::Call { target, .. } | IrExpr::BoundCall { target, .. }) =
                    &mut call.expr
                else {
                    panic!("authorization")
                };
                *target = canlang_compiler::codegen::ir::IrCallTarget::DeriveFn(
                    "AuthorizationCanUse.other_access".into(),
                );
            }
            "formal-slot" => {
                let IrItemKind::DeriveFn { params, .. } =
                    &mut changed.items[helper.0 as usize].kind
                else {
                    panic!("helper")
                };
                params.swap(0, 1);
            }
            "body" => {
                let IrItemKind::DeriveFn {
                    expr: Some(body), ..
                } = &mut changed.items[helper.0 as usize].kind
                else {
                    panic!("body")
                };
                expression_mut(body, &library, "subject.active")
                    .unwrap()
                    .expr = IrExpr::Bool(true);
            }
            _ => unreachable!(),
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
        assert!(
            serialize_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog)
            )
            .is_none(),
            "transport {mode}"
        );
    }
}
