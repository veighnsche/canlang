//! Actual checked source emission; native observation authority has its owning join.
use canlang_compiler::analysis::catalog::{Availability, Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, ir, js};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::io::Write;
use std::process::{Command, Stdio};

const SOURCE: &str = "app Membership\nGiven\n Person {account:user}\n event Received {person:user}\n derive can_use(person:user?):bool = person!=null and active_member(person,team)\n policy Person read=can_use(actor)\nWhen\n scenario run(person:user) -> bool by=members\n  require can_use(person)\n  do return true\n scenario observed on=Received\n  do\n   if not active_member(event.person,team)\n    require false\nThen\n page /people title=\"People\"\n  list Person as person where can_use(person.account)\n   text row.account\n";

fn checked() -> (SourceDb, Catalog, CheckedProgram) {
    checked_source(SOURCE)
}

fn checked_source(source: &str) -> (SourceDb, Catalog, CheckedProgram) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut db = SourceDb::new();
    let file = db.add("membership.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, catalog, program)
}

#[test]
fn native_query_predicates_require_fresh_context_and_exact_original_occurrences() {
    let source =
        format!("{SOURCE}  list Person as person where can_use(actor)\n   text row.account\n");
    let (db, catalog, program) = checked_source(&source);
    let (lowered, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let sites = canlang_compiler::codegen::scenario_decisions::serialize_read_predicate_sources(
        &program,
        &lowered,
        &db,
        Some(&catalog),
    )
    .unwrap();
    assert_eq!(sites.len(), 2);
    assert_ne!(sites[0].statement.start, sites[1].statement.start);
    // The two original outer predicates share the same helper membership call.
    assert_eq!(
        sites[0].calls.last().unwrap().node.start,
        sites[1].calls.last().unwrap().node.start
    );
    let mut result = DiagnosticResult::new("membership", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.complete = true;
    let mut options = EmitOptions::new();
    options.native_scenario_receipts = true;
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options,
        },
    );
    assert!(
        diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code == "E6007"),
        "{diagnostics:?}"
    );
    let emitted = &artifact.modules[0].js;
    assert_eq!(
        emitted
            .matches(",$can$read$c)=>{const c=$can$read$c;return ")
            .count(),
        2,
        "{emitted}"
    );
    assert!(!emitted.contains("$can$read$c=c"), "{emitted}");
    for site in &sites {
        let identity = serde_json::json!({
            "source":site.source,"owner":site.owner,"node":site.node,"statement":site.statement,
        });
        assert!(
            emitted.contains(&format!("whereSource:{identity}")),
            "{identity}: {emitted}"
        );
    }
    // Consume the actual emitted own-data getter through the released State
    // checker; neither a physical helper node nor a page owner picks a query.
    let getter = emitted
        .lines()
        .find(|line| line.starts_with("export function canMembershipSources()"))
        .unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let state = root.join("packages/state/dist/src/invocation/scenario-membership-plan.js");
    let script = format!(
        r#"
import assert from 'node:assert/strict';
import {{checkScenarioReceiptMembershipSites}} from {};
{}
const sources=canMembershipSources();
const page=Object.values(sources).find(sites=>sites[0]?.stage==='read-predicate');
const checked=checkScenarioReceiptMembershipSites(page);
assert.equal(checked.length,2);
assert.deepEqual(checked,page);
assert.ok(Object.isFrozen(checked));
assert.notDeepEqual(checked[0].statement,checked[1].statement);
assert.deepEqual(checked[0].calls.at(-1).node,checked[1].calls.at(-1).node);
sources[checked[0].owner][0].statement.start++;
assert.deepEqual(canMembershipSources()[checked[0].owner],checked);
"#,
        serde_json::to_string(&format!("file://{}", state.display())).unwrap(),
        getter
    );
    let mut node = Command::new("node")
        .args(["--input-type=module"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    node.stdin
        .take()
        .unwrap()
        .write_all(script.as_bytes())
        .unwrap();
    let output = node.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut node = Command::new("node")
        .args(["--check", "--input-type=module"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    node.stdin
        .take()
        .unwrap()
        .write_all(emitted.as_bytes())
        .unwrap();
    let output = node.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn checked_membership_emits_exact_source_arguments_and_true_site_stages() {
    let (db, catalog, program) = checked();
    let mut result = DiagnosticResult::new("membership", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.complete = true;
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions::new(),
        },
    );
    if catalog.lookup("active_member").unwrap().availability == Availability::External {
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        assert_eq!(diagnostics[0].code, "E6007", "{diagnostics:?}");
    } else {
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }
    let emitted = &artifact.modules[0].js;
    assert!(
        emitted.contains("export function canMembershipSources()"),
        "{emitted}"
    );
    assert!(emitted.contains("read-policy"), "{emitted}");
    assert!(emitted.contains("read-predicate"), "{emitted}");
    assert!(emitted.contains("body-condition"), "{emitted}");
    assert!(emitted.contains("leading-require"), "{emitted}");
    assert!(emitted.contains("Membership.Person.read.1"), "{emitted}");
    assert!(emitted.contains("await active_member(c,"), "{emitted}");
    let file = db.iter().next().unwrap().1;
    for original in [
        "active_member(person,team)",
        "active_member(event.person,team)",
    ] {
        let node = program
            .types
            .selected_calls
            .keys()
            .find(|node| SOURCE[node.start as usize..node.end as usize].trim() == original)
            .unwrap();
        let metadata = serde_json::json!({
            "source":{"path":file.path,"sha256":file.sha256,"module":"Membership"},
            "node":{"start":node.start,"end":node.end},
        });
        assert!(
            emitted.contains(&metadata.to_string()),
            "{metadata}: {emitted}"
        );
    }
    let mut node = Command::new("node")
        .args(["--check", "--input-type=module"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    node.stdin
        .take()
        .unwrap()
        .write_all(emitted.as_bytes())
        .unwrap();
    let node = node.wait_with_output().unwrap();
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
}

#[test]
fn raw_ir_keeps_the_missing_checked_membership_source_refusal() {
    let (db, catalog, program) = checked();
    let (lowered, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let raw = js::emit_program_with_native_source_receipts(&lowered, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("membership observation")),
        "{:?}",
        raw.diagnostics
    );
}

#[test]
fn original_pure_and_role_where_functions_have_private_source_markers() {
    let source = "app ReadPredicates\nGiven\n role reviewer\n Person {account:user,enabled:bool}\n policy Person read=members\nWhen\nThen\n page /people title=\"People\"\n  list Person as person where person.enabled\n   text row.account\n  list Person as person where reviewer\n   text row.account\n";
    let (db, catalog, program) = checked_source(source);
    let mut result = DiagnosticResult::new("membership", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.complete = true;
    let mut options = EmitOptions::new();
    options.native_scenario_receipts = true;
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options,
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let emitted = &artifact.modules[0].js;
    assert!(!emitted.contains("active_member"));
    assert!(!emitted.contains("canMembershipSources"));
    assert_eq!(
        emitted.matches("where:$can$read$issue(").count(),
        2,
        "{emitted}"
    );
    assert_eq!(
        emitted
            .matches(",$can$read$c)=>{const c=$can$read$c;return ")
            .count(),
        2,
        "{emitted}"
    );
    let (generic, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions::new(),
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let raw = js::emit_program_with_native_source_receipts(&lowered, true, &db);
    for text in [&generic.modules[0].js, &raw.entry.js] {
        assert!(!text.contains("canReadPredicateSource"), "{text}");
        assert!(!text.contains("$can$read$issue"), "{text}");
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::fs::write(
        scratch.path().join("native.json"),
        canlang_compiler::codegen::artifact::to_json(&artifact),
    )
    .unwrap();
    std::fs::write(
        scratch.path().join("generic.json"),
        canlang_compiler::codegen::artifact::to_json(&generic),
    )
    .unwrap();
    std::fs::write(scratch.path().join("raw.js"), &raw.entry.js).unwrap();
    std::fs::write(scratch.path().join("membership.can"), source).unwrap();
    let runner = scratch.path().join("predicates.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const url=specifier=>pathToFileURL(require.resolve(specifier)).href;
const {assembleModules}=await import(url('@canlang/cloudflare/runtime/modules'));
const ui=url('@canlang/ui'),stdlib=url('@canlang/stdlib');
// Capture original factory arguments before any native query or UI authority
// is consulted. All other UI/stdlib bindings are the installed producers.
const trap=resolve(base,'captured-ui.mjs');
writeFileSync(trap,`export * from ${JSON.stringify(ui)};
export async function list(props){globalThis.originalWhereProps.push(props);return '';}
`);
const artifact=JSON.parse(readFileSync(resolve(base,'native.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'membership.can')},{
 workDir:resolve(base,'native'),stdlibUrl:stdlib,uiUrl:pathToFileURL(trap).href,
});
const entry=await import(assembly.entryUrl);
assert.equal(entry.canMembershipSources,undefined);
assert.equal(entry.$can$read$issue,undefined,'no public issuer');
assert.equal(typeof entry.canReadPredicateSource,'function');
globalThis.originalWhereProps=[];
const rootContext={memberships:[]};
await entry.appDefinition.pages[0].render(rootContext,{});
const [pure,role]=globalThis.originalWhereProps;
assert.equal(globalThis.originalWhereProps.length,2);
const pureIdentity=entry.canReadPredicateSource(pure.where);
const roleIdentity=entry.canReadPredicateSource(role.where);
assert.deepEqual(pureIdentity,pure.whereSource);
assert.deepEqual(roleIdentity,role.whereSource);
assert.notDeepEqual(pureIdentity.node,roleIdentity.node);
assert.notDeepEqual(pureIdentity.statement,roleIdentity.statement);
for(const [props,text] of [[pure,'person.enabled'],[role,'reviewer']]){
 const identity=entry.canReadPredicateSource(props.where);
 const source=readFileSync(resolve(base,'membership.can'),'utf8');
 assert.equal(source.slice(identity.node.start,identity.node.end).trim(),text);
 assert.equal(source.slice(identity.statement.start,identity.statement.end).trim(),`Person as person where ${text}`);
 assert.equal(identity.source.module,'ReadPredicates');
 assert.ok(identity.owner.startsWith('ReadPredicates.'));
 assert.notStrictEqual(identity,entry.canReadPredicateSource(props.where));
 identity.source.module='edited';identity.node.start++;
 assert.deepEqual(entry.canReadPredicateSource(props.where),props.whereSource);
}
assert.equal(await pure.where({enabled:true},{memberships:[]}),true);
assert.equal(await pure.where({enabled:false},{memberships:['ReadPredicates.reviewer']}),false);
assert.equal(await role.where({}, {memberships:['ReadPredicates.reviewer']}),true,
 'fresh callback context shadows denied rendering context');
rootContext.memberships=['ReadPredicates.reviewer'];
assert.equal(await role.where({}, {memberships:[]}),false,
 'fresh callback context shadows allowed rendering context');
await assert.rejects(async()=>role.where({}),TypeError,'missing fresh context is not replaced by root context');
const foreign=()=>true,wrapped=(...args)=>role.where(...args),bound=role.where.bind(null);
for(const substitute of [foreign,wrapped,bound]){
 substitute.whereSource=structuredClone(role.whereSource);
 assert.equal(entry.canReadPredicateSource(substitute),null);
}
role.whereSource.source.module='forged';
assert.deepEqual(entry.canReadPredicateSource(role.where),roleIdentity,
 'mutable factory metadata cannot change the private callable identity');
const genericArtifact=JSON.parse(readFileSync(resolve(base,'generic.json'),'utf8'));
const genericAssembly=await assembleModules({artifact:genericArtifact,sourcePath:resolve(base,'membership.can')},{
 workDir:resolve(base,'generic'),stdlibUrl:stdlib,uiUrl:pathToFileURL(trap).href,
});
const generic=await import(genericAssembly.entryUrl);
assert.equal(generic.canReadPredicateSource,undefined);
globalThis.originalWhereProps=[];
await generic.appDefinition.pages[0].render(rootContext,{});
for(const props of globalThis.originalWhereProps)assert.equal(entry.canReadPredicateSource(props.where),null);
const rawText=readFileSync(resolve(base,'raw.js'),'utf8')
 .replaceAll('"@canlang/stdlib"',JSON.stringify(stdlib))
 .replaceAll('"@canlang/ui"',JSON.stringify(pathToFileURL(trap).href));
const raw=await import('data:text/javascript;base64,'+Buffer.from(rawText).toString('base64'));
assert.equal(raw.canReadPredicateSource,undefined);
globalThis.originalWhereProps=[];
await raw.appDefinition.pages[0].render(rootContext,{});
for(const props of globalThis.originalWhereProps)assert.equal(entry.canReadPredicateSource(props.where),null);
"#).unwrap();
    let output = Command::new("node")
        .arg(&runner)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
