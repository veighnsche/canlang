//! Fixed removal payload correspondence; no Identity issuance or ingress claim.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{self, IrEventSource, IrExpr, IrItemKind, IrStmt};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = r#"app TeamsRemoval
Given
When
 scenario removal on=teams.member_removed
  do
   let removal_actor=actor
   let subject=event.user
   require subject.id=="removed" and event.team_id=="team" and event.membership_id=="membership"
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn checked(source: &str) -> (SourceDb, CheckedProgram, Catalog) {
    let mut db = SourceDb::new();
    let id = db.add("teams-member-removed.can".into(), source.into());
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, catalog)
}

#[test]
fn original_subject_payload_is_ordered_readonly_and_separate_from_actor_and_cause() {
    let (db, program, catalog) = checked(SOURCE);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let handler = ir
        .items
        .iter()
        .find(|item| item.canonical == "TeamsRemoval.removal")
        .unwrap();
    let IrItemKind::Scenario {
        trusted,
        event_source,
        effects,
        ..
    } = &handler.kind
    else {
        panic!()
    };
    assert!(*trusted);
    assert_eq!(*event_source, Some(IrEventSource::TeamsMemberRemoved));
    let IrStmt::Let { value, .. } = &effects[0] else {
        panic!()
    };
    assert_eq!(value.ty, ResolvedType::Null);
    let IrStmt::Let { value, .. } = &effects[1] else {
        panic!()
    };
    assert_eq!(value.ty, ResolvedType::Scalar(Scalar::User));
    let IrExpr::Member { base, field } = &value.expr else {
        panic!()
    };
    assert_eq!(field, "user");
    assert_eq!(
        base.ty,
        ResolvedType::Object(vec![
            ("team_id".into(), ResolvedType::Scalar(Scalar::Text)),
            ("membership_id".into(), ResolvedType::Scalar(Scalar::Text)),
            ("user".into(), ResolvedType::Scalar(Scalar::User)),
        ])
    );
    for (statement, code) in [
        ("let subject=event.removedBy", "E2013"),
        ("let subject=event.operationId", "E2013"),
        ("let subject=event.namespace", "E2013"),
        ("set event {user=actor}", "E3009"),
        (
            "let subject=event.user\n   set subject {id=\"other\"}",
            "E3001",
        ),
    ] {
        let source = SOURCE.replace("let subject=event.user", statement);
        let mut altered = SourceDb::new();
        let file = altered.add("teams-member-removed.can".into(), source);
        let (_, diagnostics) = check_program(&altered, &[file], Some(&catalog));
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.code == code),
            "{statement}: {diagnostics:?}"
        );
    }
}

#[test]
fn source_raw_ir_owner_and_payload_type_mutations_never_qualify_this_profile() {
    let (db, program, catalog) = checked(SOURCE);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        js::emit_program_with_native_source_receipts(&ir, false, &db)
            .diagnostics
            .is_empty()
    );
    let raw = js::emit_program(&ir);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("teams.member_removed source"))
    );
    for mutation in 0..5 {
        let mut changed = ir.clone();
        let handler = changed
            .items
            .iter_mut()
            .find(|item| item.canonical == "TeamsRemoval.removal")
            .unwrap();
        if mutation == 0 {
            handler.name.push_str("Edited");
        } else if mutation == 1 {
            handler.span.start += 1;
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut handler.kind else {
                panic!()
            };
            let IrStmt::Let { value, .. } = &mut effects[1] else {
                panic!()
            };
            if mutation == 2 {
                value.ty = ResolvedType::Scalar(Scalar::Text);
            } else if mutation == 3 {
                let IrExpr::Member { base, .. } = &mut value.expr else {
                    panic!()
                };
                base.ty =
                    ResolvedType::Object(vec![("user".into(), ResolvedType::Scalar(Scalar::User))]);
            } else {
                let IrExpr::Member { field, .. } = &mut value.expr else {
                    panic!()
                };
                *field = "removedBy".into();
            }
        }
        let output = js::emit_program_with_native_source_receipts(&changed, false, &db);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("teams.member_removed source")),
            "mutation{mutation}: {:?}",
            output.diagnostics
        );
    }
    let mut altered = SourceDb::new();
    altered.add(
        "teams-member-removed.can".into(),
        SOURCE.replace("teams.member_removed", "instrumentation.error"),
    );
    let output = js::emit_program_with_native_source_receipts(&ir, false, &altered);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("teams.member_removed source"))
    );
}

#[test]
fn actual_cli_verified_module_keeps_private_schema_subject_and_handler_members() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("teams-member-removed.can");
    std::fs::write(&source, SOURCE).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let runner = scratch.path().join("removal.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const operation=module.appDefinition.operations['TeamsRemoval.removal'];
assert.equal(operation.event,'teams.member_removed');
assert.equal(operation.handler,'TeamsRemoval.removal');
assert.deepEqual(operation.invocation.inputs.fields,[
 {name:'team_id',field:{kind:'string'},valueType:'text',required:true},
 {name:'membership_id',field:{kind:'string'},valueType:'text',required:true},
 {name:'user',field:{kind:'user'},valueType:'user',required:true},
]);
assert.deepEqual(module.appDefinition.events['teams.member_removed'].inputs,
 {team_id:{type:'text'},membership_id:{type:'text'},user:{type:'user'}});
assert.equal(artifact.operations.some(operation=>operation.name==='TeamsRemoval.removal'),false);
const callable=artifact.callables.find(callable=>callable.id==='TeamsRemoval.removal');
assert.equal(callable.kind,'handler');assert.deepEqual(callable.member,['TeamsRemoval.removal']);
assert.equal(module[callable.export],callable.id);
let handler=module.canApp();for(const part of callable.member)handler=handler[part];
// Copied values exercise compiled behavior; no authentic occurrence is minted.
const payload={team_id:'team',membership_id:'membership',user:{id:'removed'}};
const envelope={membershipRemoval:payload,removedBy:{id:'remover'}};
await handler({actor:null},{event:envelope.membershipRemoval});
await assert.rejects(()=>handler({actor:null},{event:{...payload,user:envelope.removedBy}}));
await assert.rejects(()=>handler({actor:null},{event:{...payload,membership_id:'foreign'}}));
assert.equal(envelope.removedBy.id,'remover');assert.equal(payload.user.id,'removed');
console.log('Actual CLI fixed removal schema, original removed subject and verified private handler passed; Identity issuance/ingress remain external');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact)
        .arg(&source)
        .arg(scratch.path().join("modules"))
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
