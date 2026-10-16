//! Actual checked source emission; native observation authority has its owning join.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
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
    // Bound observations resolve to their defining State membership producer,
    // so the generic catalog's external marker no longer reports — even when
    // the installed catalog leaves `active_member` external.
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
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

#[test]
fn checked_boolean_observers_emit_original_predicates_and_async_derived_reads() {
    let source = include_str!("../../packages/cloudflare/test/fixtures/native-read-boolean.can");
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
    assert!(
        diagnostics.iter().all(|d| d.code == "E6007"),
        "{diagnostics:?}"
    );
    let text = &artifact.modules[0].js;
    assert!(
        text.contains("export function canReadBooleanSource"),
        "{text}"
    );
    assert!(text.contains("routeBindings[\"Item.id\"]"), "{text}");
    assert!(
        text.contains("await nativeReadBoolean(c,$can$boolean$"),
        "{text}"
    );
    assert!(text.contains("async(c,row)=>"), "{text}");
    assert!(!text.contains("type:\"unknown\""), "{text}");
    // Parse and consume actual emitted functions; substitute only the runtime
    // boundary, recording the exact original function/subject it receives.
    let (_, generic_diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions::new(),
        },
    );
    assert!(
        generic_diagnostics.iter().any(|d| d.code == "E6008"
            && d.message
                .contains("native Boolean observation backend required")),
        "{generic_diagnostics:?}"
    );
    let route_render_source = source.replace("text \"Allowed\"", "text row.author");
    let (route_db, route_catalog, route_program) = checked_source(&route_render_source);
    let mut route_result = DiagnosticResult::new("route", LANGUAGE_VERSION, SCHEMA_VERSION);
    route_result.add_sources(&route_db);
    route_result.complete = true;
    let mut route_options = EmitOptions::new();
    route_options.native_scenario_receipts = true;
    let (route_artifact, route_diagnostics) = emit(
        &route_program,
        &EmitSources {
            db: &route_db,
            result: &route_result,
            catalog: Some(&route_catalog),
            options: route_options,
        },
    );
    assert!(
        route_diagnostics.iter().all(|d| d.code == "E6007"),
        "{route_diagnostics:?}"
    );
    assert!(route_artifact.modules[0].js.contains("bindings.row"));
    let scratch = tempfile::tempdir().unwrap();
    let runner = scratch.path().join("boolean.mjs");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    std::fs::write(scratch.path().join("entry.js"), text).unwrap();
    let script = format!(
        r#"
import assert from 'node:assert/strict';
import {{createRequire}} from 'node:module';
import {{readFileSync,writeFileSync}} from 'node:fs';
import {{pathToFileURL}} from 'node:url';
const require=createRequire({root});
const stdlib=pathToFileURL(require.resolve('@canlang/stdlib')).href;
const ui=pathToFileURL(require.resolve('@canlang/ui')).href;
writeFileSync(new URL('trap.mjs',import.meta.url),`export * from ${{JSON.stringify(stdlib)}};
export async function nativeReadBoolean(c,f,subject){{globalThis.seen.push({{f,subject}});return f(c,typeof subject==='string'?{{author:'person',enabled:false}}:subject);}}
export async function nativeReadReference(c,value){{return value;}}
export async function records(){{throw Error('skipped route row lookup executed');}}
export async function active_member(){{throw Error('lazy membership operand executed');}}`);
const entry=readFileSync(new URL('entry.js',import.meta.url),'utf8').replaceAll('"@canlang/stdlib"',JSON.stringify(new URL('trap.mjs',import.meta.url).href)).replaceAll('"@canlang/ui"',JSON.stringify(ui));
writeFileSync(new URL('entry.mjs',import.meta.url),entry);
const {{appDefinition,canApp,canReadBooleanSource,canReadPredicateSource}}=await import(new URL('entry.mjs',import.meta.url));
const seen=globalThis.seen=[];
const derived=canApp().derives['NativeBoolean.Item.met'];
assert.equal(await derived({{}},{{enabled:false}}),false);
assert.equal(canReadBooleanSource(seen[0].f).kind,'derived-field');
assert.equal(canReadBooleanSource(seen[0].f).field,'met');
assert.deepEqual(Object.keys(canReadPredicateSource(seen[0].f)).sort(),['node','owner','source','statement']);
assert.equal(canReadBooleanSource(async()=>true),null);
const marker=canReadBooleanSource(seen[0].f); marker.kind='foreign';
assert.equal(canReadBooleanSource(seen[0].f).kind,'derived-field');
const page=appDefinition.pages.find(page=>page.path.endsWith('/access'));
await assert.rejects(()=>page.admit({{actor:null}},{{'Item.id':'one'}}),error=>error.code==='forbidden');
assert.equal(seen.at(-1).subject,'one');
assert.equal(canReadBooleanSource(seen.at(-1).f).kind,'page-require');
"#,
        root = serde_json::to_string(&root.join("package.json").to_string_lossy()).unwrap(),
    );
    std::fs::write(&runner, script).unwrap();
    let output = Command::new("node").arg(runner).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn boolean_callee_queries_await_lazy_reference_reads_without_changing_ordinary_helpers() {
    let source = "app Closure\nGiven\n Target {active:bool}\n Item {author:user,target:Target,enabled:bool}\n derive allowed(item:Item):bool = item.enabled and active_member(item.author,team) and any(Item as candidate,candidate.enabled and candidate.target.active)\n derive Item.met:bool = allowed(row)\n policy Target read=members\n policy Item read=members\nWhen\nThen\n page /items title=\"Items\"\n  list Item as item\n   text row.met\n";
    let (db, catalog, program) = checked_source(source);
    let mut result = DiagnosticResult::new("closure", LANGUAGE_VERSION, SCHEMA_VERSION);
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
        diagnostics.iter().all(|d| d.code == "E6007"),
        "{diagnostics:?}"
    );
    let text = &artifact.modules[0].js;
    assert!(text.contains("nativeReadReference(c,"), "{text}");
    assert!(
        text.contains("const $verdict=await $predicate($item)"),
        "{text}"
    );
    let scratch = tempfile::tempdir().unwrap();
    std::fs::write(scratch.path().join("entry.js"), text).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let script = format!(
        r#"
import assert from 'node:assert/strict';
import {{createRequire}} from 'node:module';
import {{readFileSync,writeFileSync}} from 'node:fs';
import {{pathToFileURL}} from 'node:url';
const require=createRequire({root});
const stdlib=pathToFileURL(require.resolve('@canlang/stdlib')).href;
const ui=pathToFileURL(require.resolve('@canlang/ui')).href;
writeFileSync(new URL('trap.mjs',import.meta.url),`export * from ${{JSON.stringify(stdlib)}};
export async function nativeReadBoolean(c,f,row){{return f(c,row);}}
export async function nativeReadReference(c,row){{globalThis.visits.push(row);if(row.denied)throw Error('withheld target');return row;}}
export async function active_member(){{globalThis.members++;return true;}}
export async function records(c,model,query){{globalThis.queries++;return globalThis.rows;}}`);
const text=readFileSync(new URL('entry.js',import.meta.url),'utf8').replaceAll('"@canlang/stdlib"',JSON.stringify(new URL('trap.mjs',import.meta.url).href)).replaceAll('"@canlang/ui"',JSON.stringify(ui));
writeFileSync(new URL('entry.mjs',import.meta.url),text);
const entry=await import(new URL('entry.mjs',import.meta.url));
const derived=entry.canApp().derives['Closure.Item.met'];
globalThis.visits=[];globalThis.members=0;globalThis.queries=0;
assert.equal(await derived({{}},{{enabled:false}}),false);
assert.equal(globalThis.members,0);assert.equal(globalThis.queries,0);
const skipped={{enabled:false,get target(){{throw Error('unreached reference');}}}};
globalThis.rows=[skipped,{{enabled:true,target:{{active:true}}}}];
assert.equal(await derived({{}},{{enabled:true,author:'person'}}),true);
assert.equal(globalThis.members,1);assert.equal(globalThis.queries,1);
globalThis.rows=[{{enabled:true,target:{{denied:true}}}}];
await assert.rejects(()=>derived({{}},{{enabled:true,author:'person'}}),/withheld target/);
"#,
        root = serde_json::to_string(&root.join("package.json").to_string_lossy()).unwrap()
    );
    let runner = scratch.path().join("closure.mjs");
    std::fs::write(&runner, script).unwrap();
    let output = Command::new("node").arg(runner).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn original_query_reference_boolean_graph_emits_both_observers() {
    let source =
        include_str!("../../packages/cloudflare/test/fixtures/native-read-boolean-graph.can");
    let (db, catalog, program) = checked_source(source);
    let mut result = DiagnosticResult::new("graph", LANGUAGE_VERSION, SCHEMA_VERSION);
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
        diagnostics.iter().all(|d| d.code == "E6007"),
        "{diagnostics:?}"
    );
    let text = &artifact.modules[0].js;
    assert!(
        text.contains("export function canReadBooleanSource"),
        "{text}"
    );
    assert!(text.contains("routeBindings[\"Customer.id\"]"), "{text}");
    assert!(text.contains("nativeReadReference(c,"), "{text}");
    assert!(
        text.contains("const $verdict=await $predicate($item)"),
        "{text}"
    );
}

#[test]
fn builtin_actor_predicates_keep_canonical_permissions_and_lazy_boolean_order() {
    let source = r#"app ActorPredicates
Given
 contract Ticket {account:user,enabled:bool}
 derive own(ticket:Ticket):bool = authenticated and ticket.account==actor
 derive public_gate():bool = public
 derive member_gate():bool = members
 derive owner_gate():bool = owner
 derive and_gate(ticket:Ticket):bool = authenticated and ticket.enabled
 derive or_gate(ticket:Ticket):bool = authenticated or ticket.enabled
 derive left_gate(ticket:Ticket):bool = ticket.enabled and authenticated
 derive shadow(authenticated:bool):bool = authenticated
When
Then
 page /tickets title="Tickets"
  text "Public catalog"
  card "Own tickets"
   require authenticated
   text "Private ticket"
 page /protected title="Protected"
  require authenticated
  text "Protected page"
"#;
    let (db, catalog, program) = checked_source(source);
    let mut result = DiagnosticResult::new("actor-predicates", LANGUAGE_VERSION, SCHEMA_VERSION);
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
    let script = r#"
import assert from 'node:assert/strict';
import {makeUserRef} from '@canlang/values';
const text=__ENTRY__
 .replaceAll('"@canlang/stdlib"',JSON.stringify(import.meta.resolve('@canlang/cloudflare/runtime/stdlib')))
 .replaceAll('"@canlang/ui"',JSON.stringify(import.meta.resolve('@canlang/ui')));
const entry=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const registry=entry.canApp();
const call=(name,c,...args)=>registry['ActorPredicates.'+name](c,...args);
const context=roles=>({actor:roles.includes('authenticated')?makeUserRef('self'):null,
 memberships:['authenticated','members','owner'],canonical:{builtinRoles:roles},
 preferredLocales:['en'],appDefaultLocale:'en',theme:{},path:'/',isPartial:true,csrfToken:'csrf'});
const anonymous=context(['public']), external=context(['public','authenticated']);
const member=context(['public','authenticated','members']), owner=context(['public','authenticated','members','owner']);
const ticket={account:makeUserRef('self'),enabled:true};
assert.equal(await call('own',anonymous,{get account(){throw Error('anonymous read');}}),false);
assert.equal(await call('own',external,ticket),true);
assert.equal(await call('own',external,{account:makeUserRef('other')}),false);
for(const [c,isMember,isOwner] of [[anonymous,false,false],[external,false,false],[member,true,false],[owner,true,true]]) {
 assert.equal(await call('public_gate',c),true);
 assert.equal(await call('member_gate',c),isMember);
 assert.equal(await call('owner_gate',c),isOwner);
}
assert.equal(await call('own',context([]),ticket),false,'forged caller memberships cannot supply canonical authentication');
assert.equal(await call('public_gate',context([])),false,'missing canonical grant stays false');
assert.equal(await call('shadow',owner,false),false,'lexical boolean retains ownership');
assert.equal(await call('shadow',anonymous,true),true);
for(const [name,roles,enabled,expected,trace] of [
 ['and_gate',[],true,false,['role']],['and_gate',['authenticated'],true,true,['role','value']],
 ['or_gate',[],true,true,['role','value']],['or_gate',['authenticated'],false,true,['role']],
 ['left_gate',[],false,false,['value']],['left_gate',['authenticated'],true,true,['value','role']],
]) {
 const seen=[], c=context([]);
 Object.defineProperty(c.canonical,'builtinRoles',{get(){seen.push('role');return roles;}});
 const value={get enabled(){seen.push('value');return enabled;}};
 assert.equal(await call(name,c,value),expected);assert.deepEqual(seen,trace);
}
const sentinel=new Error('original failure');
await assert.rejects(()=>call('and_gate',external,{get enabled(){throw sentinel;}}),error=>error===sentinel);
await assert.rejects(()=>call('left_gate',external,{get enabled(){throw sentinel;}}),error=>error===sentinel);
const c=context([]);Object.defineProperty(c.canonical,'builtinRoles',{get(){throw sentinel;}});
await assert.rejects(()=>call('and_gate',c,{get enabled(){throw Error('later operand');}}),error=>error===sentinel);
assert.equal(await call('left_gate',c,{enabled:false}),false);
const page=entry.appDefinition.pages.find(page=>page.path.endsWith('/tickets'));
await page.admit(anonymous,{});
let html=await page.render(anonymous,{});
assert(html.includes('Public catalog'));assert(!html.includes('Private ticket'));
html=await page.render(external,{});
assert(html.includes('Public catalog'));assert(html.includes('Private ticket'));
const protectedPage=entry.appDefinition.pages.find(page=>page.path.endsWith('/protected'));
await assert.rejects(()=>protectedPage.admit(anonymous,{}),error=>error.code==='forbidden');
await protectedPage.admit(external,{});
"#.replace("__ENTRY__", &serde_json::to_string(&artifact.modules[0].js).unwrap());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let output = Command::new("node")
        .args(["--input-type=module", "--eval", &script])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// staff/can_work membership observations lower with their source closure
/// (CAN18-v1 lane A): the original shared/Employees.can derive bodies
/// (`staff`/`can_work` over `Employee` with `active_member`) and read-policy
/// shapes, consumed both inline and through an imported helper, compile
/// clean with no membership diagnostics, lower every `active_member`
/// observation inline with its source closure, and carry the membership
/// sources with the assembly. Runtime grant/denial/revocation behavior is
/// proven separately by the real compiled-Can host/State/Identity consumer
/// (`native-staff-can-work.integration.test.ts`); this test fabricates no
/// runtime and stubs nothing.
#[test]
fn staff_can_work_membership_observations_lower_with_source_closure() {
    const CATALOG_JSON: &str = r#"{"language_version":"1.0","catalog_version":"0.1.0","entries":[{"id":"active_member","js":"active_member","owner":"lane-03","kind":"builtin","signature":"active_member(person:user,team:Team)->bool","effects":"state-read","availability":"external"},{"id":"any","js":"any","owner":"lane-02","kind":"builtin","signature":"any(domain:C<T> as x,predicate:bool in x scope)->bool","effects":"pure","availability":"implemented"}]}"#;
    // Same derive bodies and read-policy shapes as shared/Employees.can; the
    // model keeps every field the permission logic reads.
    const EMPLOYEES: &str = "package employee\n Given\n  export Location {name:text}\n  export Employee {user:user unique,name:text,home:Location,locations:Location[],operator_wide:bool=false,active:bool=true,role:text}\n  export derive staff(person:user):bool = any(Employee as e,e.user==person and e.active and active_member(person,team))\n  export derive can_work(person:user,location:Location):bool = any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))\n  policy Employee read=members and staff(actor) fields=user,name,home,locations,operator_wide,active,role\n When\n  scenario deactivate(employee:Employee) by=members\n   require staff(actor)\n   do set employee {active=false}\n Then\n";
    const CONSUMER: &str = "app Probe uses=[shop]\npackage shop\n use employee {staff,can_work,Employee,Location}\n Given\n  Entry {owner:user,site:Location}\n  derive crew(person:user,place:Location):bool = can_work(person,place)\n  policy Entry read=members and staff(actor)\n  policy Entry read=members and crew(actor,row.site)\n When\n  scenario touch(entry:Entry) by=members\n   require staff(actor)\n   do let x = 1\n Then\n  page /entries title=\"Entries\"\n   list Entry as e where actor!=null and staff(actor)\n    text \"hi\"\n";
    let dir = tempfile::tempdir().unwrap();
    let catalog_path = dir.path().join("catalog.json");
    std::fs::write(&catalog_path, CATALOG_JSON).unwrap();
    let mut db = SourceDb::new();
    let anchor = db.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: dir.path(),
        primary: Span::new(anchor, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let employees = db.add("employees.can".into(), EMPLOYEES.into());
    let consumer = db.add("consumer.can".into(), CONSUMER.into());
    let (program, diagnostics) = check_program(&db, &[employees, consumer], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut result = DiagnosticResult::new("staff-can-work", LANGUAGE_VERSION, SCHEMA_VERSION);
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
    let membership: Vec<_> = diagnostics
        .iter()
        .filter(|diagnostic| {
            diagnostic.message.contains("membership observation")
                || diagnostic.message.contains("active_member")
        })
        .collect();
    assert!(membership.is_empty(), "{diagnostics:?}");
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let entry = artifact
        .modules
        .iter()
        .find(|module| module.js.contains("export function canApp"))
        .expect("entry module");
    assert!(
        entry.js.contains("await active_member(c,"),
        "observations lower inline with their source closure"
    );
    assert!(
        entry.js.contains("export function canMembershipSources()"),
        "membership sources travel with the assembly"
    );
}

#[test]
fn data_only_gaps_keep_membership_seal_without_masking() {
    const CATALOG_JSON: &str = r#"{"language_version":"1.0","catalog_version":"0.1.0","entries":[{"id":"active_member","js":"active_member","owner":"lane-03","kind":"builtin","signature":"active_member(person:user,team:Team)->bool","effects":"state-read","availability":"external"},{"id":"any","js":"any","owner":"lane-02","kind":"builtin","signature":"any(domain:C<T> as x,predicate:bool in x scope)->bool","effects":"pure","availability":"implemented"}]}"#;
    const EMPLOYEES: &str = "package employee\n Given\n  export Location {name:text}\n  export Employee {user:user unique,name:text,home:Location,locations:Location[],operator_wide:bool=false,active:bool=true,role:text}\n  export derive staff(person:user):bool = any(Employee as e,e.user==person and e.active and active_member(person,team))\n  export derive can_work(person:user,location:Location):bool = any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))\n  policy Employee read=members and staff(actor) fields=user,name,home,locations,operator_wide,active,role\n When\n  scenario deactivate(employee:Employee) by=members\n   require staff(actor)\n   do set employee {active=false}\n Then\n";
    const CONSUMER: &str = "app Probe uses=[shop]\npackage shop\n use employee {staff,can_work,Employee,Location}\n Given\n  Entry {owner:user,site:Location,stage:enum(open,done)=open,when:datetime}\n  policy Entry read=members and staff(actor)\n When\n  scenario touch(entry:Entry) by=members\n   require staff(actor)\n   do let x = 1\n Then\n  page /entries title=\"Entries\"\n   list Entry as e where actor!=null and staff(actor)\n    text \"hi\"\n  page /board title=\"Board\"\n   board Entry as e by=stage filter=site\n  page /soon title=\"Soon\"\n   table Entry as e where e.when>=now columns=site\n    text \"hi\"\n";
    let dir = tempfile::tempdir().unwrap();
    let catalog_path = dir.path().join("catalog.json");
    std::fs::write(&catalog_path, CATALOG_JSON).unwrap();
    let mut db = SourceDb::new();
    let anchor = db.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: dir.path(),
        primary: Span::new(anchor, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let employees = db.add("employees.can".into(), EMPLOYEES.into());
    let consumer = db.add("consumer.can".into(), CONSUMER.into());
    let (program, diagnostics) = check_program(&db, &[employees, consumer], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut result = DiagnosticResult::new("data-only-gaps", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.complete = true;
    let mut options = EmitOptions::new();
    options.native_scenario_receipts = true;
    let (_artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options,
        },
    );
    // The board filter over a model reference has no owned-enum profile, so
    // its own E6008 stays loud; the membership seal must still succeed.
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("board filters")),
        "unsupported board filter stays reported: {diagnostics:?}"
    );
    let membership: Vec<_> = diagnostics
        .iter()
        .filter(|diagnostic| {
            diagnostic.message.contains("membership observation")
                || diagnostic.message.contains("active_member")
        })
        .collect();
    assert!(membership.is_empty(), "{diagnostics:?}");
}
