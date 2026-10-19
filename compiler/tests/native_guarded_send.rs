//! Byte-exact released guarded Email SEND producer qualification.
//! Installed metadata below issues no native dispatch, row or rollback authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    CheckedDecisionCallTarget, CheckedDecisionStage, DisclosureEffectKind, ScenarioDisclosure,
};
use canlang_compiler::analysis::{CheckedProgram, NodeKey, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_decisions::collect_decision_sources;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("../../packages/cloudflare/test/fixtures/native-guarded-email.can");
const CONDITION: &str = "enabled and (note==null or note!=\"deny\") and count(values)>=0 and active_member(person,team)";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_owner_root() -> PathBuf {
    // Local qualification consumes the exact public owner release. Portable
    // runs consume the same owner-generated catalog in their own checkout.
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
    let mut db = SourceDb::new();
    let file = db.add("native-guarded-email.can".into(), SOURCE.into());
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

fn effects_mut(owner: &mut IrItem) -> &mut Vec<IrStmt> {
    let IrItemKind::Scenario { effects, .. } = &mut owner.kind else {
        panic!("scenario")
    };
    effects
}

#[test]
fn original_guarded_send_keeps_dispatch_proof_and_late_failure_source_order() {
    let (db, program, ir, catalog) = fixture();
    let owner = item(&ir, "NativeGuardedEmail.deliver");
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner.id] else {
        panic!(
            "original guarded SEND must have a complete scalar result source proof: {:?}",
            ir.scenario_disclosures[&owner.id]
        )
    };
    assert_eq!(proof.effects.len(), 2);
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
        Some("NativeGuardedEmail.Mail")
    );
    assert_eq!(
        SOURCE[when.start as usize..when.end as usize].trim(),
        CONDITION
    );
    assert!(matches!(
        proof.effects[1].kind,
        DisclosureEffectKind::Set { .. }
    ));
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
    assert_eq!(sites[0].source.path, "native-guarded-email.can");
    assert_eq!(sites[0].source.sha256, sha256_hex(SOURCE.as_bytes()));
    assert_eq!(
        sites[0]
            .calls
            .iter()
            .filter_map(|call| match &call.target {
                CheckedDecisionCallTarget::Builtin { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        ["count", "active_member"]
    );
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner.kind
    else {
        panic!("scenario")
    };
    assert!(guards.is_empty());
    let [send, set, require, returned] = effects.as_slice() else {
        panic!("unchanged written body")
    };
    let IrStmt::Send {
        when: Some(condition),
        binding: Some(binding),
        span: send_span,
        ..
    } = send
    else {
        panic!("send")
    };
    assert_eq!(binding, "attempt");
    assert_eq!(condition.span, Span::new(when.file, when.start, when.end));
    let IrStmt::Set { span: set_span, .. } = set else {
        panic!("set")
    };
    let IrStmt::Require {
        cond,
        span: require_span,
    } = require
    else {
        panic!("late require")
    };
    assert!(matches!(&cond.expr, IrExpr::Name(name) if name == "accept"));
    let IrStmt::Return {
        value: Some(value),
        span: return_span,
    } = returned
    else {
        panic!("return")
    };
    assert!(matches!(&value.expr, IrExpr::Member {field, ..} if field == "count"));
    assert!(
        send_span.end <= set_span.start
            && set_span.end <= require_span.start
            && require_span.end <= return_span.start
    );
    assert!(!proof.returns.is_empty());
    for returned in &proof.returns {
        assert!(
            returned
                .decisions
                .iter()
                .all(|decision| decision.node.start < when.start || when.end < decision.node.end),
            "guard false must not prune the parent result path"
        );
        assert_eq!(
            returned.node,
            NodeKey {
                file: return_span.file,
                start: return_span.start,
                end: return_span.end,
                kind: canlang_compiler::syntax::SyntaxKind::Return as u8
            }
        );
    }
    assert!(collect_decision_sources(&program, &ir, owner, &db, Some(&catalog)).is_some());
    let plain = item(&ir, "NativeGuardedEmail.plain");
    let ScenarioDisclosure::Complete(plain) = &ir.scenario_disclosures[&plain.id] else {
        panic!("plain behavior remains supported")
    };
    assert!(matches!(
        plain.effects[0].kind,
        DisclosureEffectKind::Send { when: None, .. }
    ));
}

#[test]
fn raw_native_guard_and_changed_source_execution_or_input_declaration_never_publish_recipe() {
    let (db, program, ir, catalog) = fixture();
    let owner = item(&ir, "NativeGuardedEmail.deliver").id;
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
    let raw = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008" && diagnostic.message.contains("guard")),
        "raw IR cannot supply sealed dispatch preparation: {:?}",
        raw.diagnostics
    );
    assert!(
        raw.operations
            .iter()
            .find(|operation| operation.name == "NativeGuardedEmail.deliver")
            .unwrap()
            .disclosure
            .is_none()
    );
    let mut changed_source = SourceDb::new();
    changed_source.add(
        "native-guarded-email.can".into(),
        SOURCE.replace("Original guarded Email", "Changed guarded Email"),
    );
    assert!(
        collect_decision_sources(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &changed_source,
            Some(&catalog)
        )
        .is_none()
    );
    for mode in [
        "guard-value",
        "guard-type",
        "guard-erased",
        "input-value",
        "input-order",
        "binding",
        "deployment",
        "late-require",
        "statement-order",
        "declaration-type",
    ] {
        let mut changed = ir.clone();
        if mode == "declaration-type" {
            let parameter = item(&changed, "NativeGuardedEmail.deliver.enabled").id;
            let IrItemKind::Param { ty, .. } = &mut changed.items[parameter.0 as usize].kind else {
                panic!("parameter")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::Int));
        } else {
            let effects = effects_mut(&mut changed.items[owner.0 as usize]);
            if mode == "statement-order" {
                effects.swap(1, 2);
            } else if mode == "late-require" {
                let IrStmt::Require { cond, .. } = &mut effects[2] else {
                    panic!("require")
                };
                cond.expr = IrExpr::Bool(true);
            } else {
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
                    "guard-type" => when.as_mut().unwrap().ty = ResolvedType::Scalar(Scalar::Int),
                    "guard-erased" => *when = None,
                    "binding" => *binding = Some("foreign".into()),
                    "deployment" => *deployment_binding = Some("NativeGuardedEmail.Foreign".into()),
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
                .find(|operation| operation.name == "NativeGuardedEmail.deliver")
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
fn actual_cli_native_catalog_verified_rule_and_installed_state_keep_lazy_guard_metadata() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("native-guarded-email.can");
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
    let runner = scratch.path().join("native-guarded-send.mjs");
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
const loaded=loadArtifactDescriptors(artifact,{by:'owner'}),name='NativeGuardedEmail.deliver';
const operation=artifact.operations.find(operation=>operation.name===name);
assert.equal(operation.result.type,'int');assert.ok(operation.result.disclosure);
assert.deepEqual(loaded.registry.get(name).descriptor.result.disclosure,operation.result.disclosure);
const guards=module.appDefinition.operations[name].sendGuards;assert.equal(guards.length,1);
const guard=guards[0],names=['enabled','note','values','person'],types=['bool','text?','int[]','user'];
assert.equal(guard.owner,name);assert.equal(guard.target,'std.EmailV1.send');assert.equal(guard.binding,'NativeGuardedEmail.Mail');assert.equal(guard.sourceBinding,'attempt');
assert.deepEqual(guard.inputs,names.map((name,index)=>({name,type:types[index]})));
assert.equal(guard.source.path,process.argv[4]);assert.equal(guard.source.sha256,createHash('sha256').update(readFileSync(process.argv[4])).digest('hex'));
const source=readFileSync(process.argv[4],'utf8');
assert.equal(source.slice(guard.node.start,guard.node.end),'enabled and (note==null or note!="deny") and count(values)>=0 and active_member(person,team)');
const profile=guard.inputDeclaration;assert.equal(profile.kind,'inputs');
assert.deepEqual(profile.canonical.map(input=>input.name),names);assert.deepEqual(profile.artifact.map(input=>input.name),names);
assert.deepEqual(profile.artifact.map(input=>input.valueType),types);
for(const input of [...profile.canonical,...profile.artifact]) {assert.equal(input.required,true);assert.equal(Object.hasOwn(input,'default'),false);assert.equal(Object.hasOwn(input,'computedDefault'),false);}
assert.equal(profile.artifact[1].nullable,true);assert.deepEqual(profile.artifact[2].array,{required:false});
const callable=artifact.callables.find(callable=>callable.id===guard.rule);assert.equal(callable.kind,'rule');assert.deepEqual(callable.member,['sendWhen',guard.rule]);
assert.equal(module[callable.export],guard.rule);assert.equal(Object.hasOwn(callable,'inputStyle'),false);
let rule=factory;for(const member of callable.member)rule=rule[member];assert.equal(typeof rule,'function');
const owner=artifact.callables.find(callable=>callable.id===name);let handler=factory;for(const member of owner.member)handler=handler[member];
const body=handler.toString();
assert.equal((body.match(/\bawait send\(/g)||[]).length,1);assert.equal((body.match(/\bawait set\(/g)||[]).length,1);
const sent=body.indexOf('await send('),written=body.indexOf('await set('),required=body.indexOf('check(',written),returned=body.lastIndexOf('return ');
assert.ok(sent>=0 && sent<written && written<required && required<returned);
assert.ok(body.includes('when:{rule:'));assert.equal(body.includes('when:()=>'),false);
assert.equal(body.includes('active_member('),false);assert.equal(body.includes('count('),false);
const plain=module.appDefinition.operations['NativeGuardedEmail.plain'];assert.equal(Object.hasOwn(plain,'sendGuards'),false);
const plainCallable=artifact.callables.find(callable=>callable.id==='NativeGuardedEmail.plain');let plainHandler=factory;
for(const member of plainCallable.member)plainHandler=plainHandler[member];const plainBody=plainHandler.toString();
assert.equal((plainBody.match(/\bawait send\(/g)||[]).length,1);assert.equal(plainBody.includes('when:'),false);
// Do not execute fabricated contexts, rows or Rules. Dev owns genuine
// true/false/skipped dispatch, settlement and late-failure rollback.
console.log('Byte-exact guarded Email: actual native-catalog CLI/verified Rule/inputDeclaration/installed State scalar disclosure and lazy source order');
"#).unwrap();
    let run = Command::new("node")
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
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&run.stdout));
}
