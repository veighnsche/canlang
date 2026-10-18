//! Collection expressions retain meaning, read authority and failures through helper reuse.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

#[test]
fn ordinary_collection_helpers_preserve_order_authority_and_failures() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut db = SourceDb::new();
    let id = db.add(
        "predicate-reuse.can".into(),
        r#"app PredicateReuse
Given
 role sorter
 contract Flag {enabled:bool}
 Item {enabled:bool, rank:int=0}
 policy Item read=members fields=enabled
 policy Item read=sorter fields=rank
 fixture item=Item {enabled=true}
 derive read_enabled(item:Item):bool = item.enabled
 derive ordered_items(items:Item[]):Item[] = items as item order=-item.rank
 derive enabled(flag:Flag):bool = flag.enabled
 derive inline_any(flags:Flag[]):bool = any(flags as flag,flag.enabled)
 derive helper_any(flags:Flag[]):bool = any(flags as flag,enabled(flag))
 derive inline_all(flags:Flag[]):bool = all(flags as flag,flag.enabled)
 derive helper_all(flags:Flag[]):bool = all(flags as flag,enabled(flag))
 derive nested(flags:Flag[]):bool = all(flags as flag,any([flag] as candidate,enabled(candidate)))
 derive inline_filter(flags:Flag[]):Flag[] = flags as flag where flag.enabled
 derive helper_filter(flags:Flag[]):Flag[] = flags as flag where enabled(flag)
 derive inline_select(flags:Flag[]):bool[] = flags as flag select flag.enabled
 derive helper_select(flags:Flag[]):bool[] = flags as flag select enabled(flag)
 derive filter_select(flags:Flag[]):bool[] = flags as flag where enabled(flag) select enabled(flag)
 derive head(flags:Flag[]):Flag? = first(flags as flag where enabled(flag))
 derive literal_unit(pooled:bool):text = first(["seat-minute"] as unit where pooled) ?? "room-minute"
When
 scenario selected() read=true -> bool[] by=members
  do return Item as item select read_enabled(item)
  examples seed=[item]
   as -> result
   members -> [true]
   public -> error(forbidden)
 scenario sorted() read=true -> bool[] by=members
  do return ordered_items(Item) as item select read_enabled(item)
  examples seed=[item]
   as -> result
   sorter -> [true]
   members -> error(forbidden)
   public -> error(forbidden)
 scenario sorted_write() -> bool[] by=members
  do return ordered_items(Item) as item select read_enabled(item)
  examples seed=[item]
   as -> result
   sorter -> [true]
   members -> error(forbidden)
   public -> error(forbidden)
Then
"#
        .into(),
    );
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut result = DiagnosticResult::new("predicate-reuse", LANGUAGE_VERSION, SCHEMA_VERSION);
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
    let mut protected_db = SourceDb::new();
    let protected_id = protected_db.add("protected-first.can".into(),
        "app ProtectedFirst\nGiven\n Item {enabled:bool}\n policy Item read=members\n derive head():Item? = first(Item)\nWhen\nThen\n".into());
    let (protected, diagnostics) = check_program(&protected_db, &[protected_id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut protected_result =
        DiagnosticResult::new("protected-first", LANGUAGE_VERSION, SCHEMA_VERSION);
    protected_result.add_sources(&protected_db);
    protected_result.complete = true;
    let mut options = EmitOptions::new();
    options.native_scenario_receipts = true;
    let (_, diagnostics) = emit(
        &protected,
        &EmitSources {
            db: &protected_db,
            result: &protected_result,
            catalog: Some(&catalog),
            options,
        },
    );
    assert!(
        diagnostics.iter().any(|d| d.code == "E6008"
            && d.message
                .contains("original native query correspondence is unavailable")),
        "{diagnostics:?}"
    );
    let script=r#"
import assert from 'node:assert/strict';
import {ValueError} from '@canlang/values';
const text=__ENTRY__.replaceAll('"@canlang/stdlib"',JSON.stringify(import.meta.resolve('@canlang/cloudflare/runtime/stdlib')));
const {canApp}=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const registry=canApp(), call=(name,rows)=>registry['PredicateReuse.'+name]({},rows);
for(const flags of [[],[{enabled:true}],[{enabled:false}],[{enabled:false},{enabled:true}],[{enabled:true},{enabled:true}]]) {
 assert.equal(await call('helper_any',flags),await call('inline_any',flags));
 assert.equal(await call('helper_all',flags),await call('inline_all',flags));
 assert.equal(await call('nested',flags),await call('inline_all',flags));
 assert.deepEqual(await call('helper_filter',flags),await call('inline_filter',flags));
 assert.deepEqual(await call('helper_select',flags),await call('inline_select',flags));
 assert.equal(await call('head',flags),flags.find(flag=>flag.enabled)??null);
}
for(const [inline,helper] of [['inline_any','helper_any'],['inline_all','helper_all']]) {
 for(const invalid of [null,new Set(),[{enabled:'bad'}]]) {
  let original;try{await call(inline,invalid);}catch(error){original=error;}
  assert(original instanceof ValueError);
  await assert.rejects(()=>call(helper,invalid),error=>error instanceof ValueError&&error.code===original.code&&error.message===original.message);
 }
}
const selected=[], selection=[{get enabled(){selected.push(0);return true;}},{get enabled(){selected.push(1);return false;}}];
assert.deepEqual(await call('filter_select',selection),[true]);assert.deepEqual(selected,[0,1,0],'filter completes before projection in the original row order');
const sentinel=new Error('original predicate failure');
assert.equal(await call('literal_unit',true),'seat-minute');
assert.equal(await call('literal_unit',false),'room-minute');
await assert.rejects(()=>call('head',[{enabled:true},{get enabled(){throw sentinel;}}]),error=>error===sentinel,'first consumes the completed filter and cannot skip a later predicate failure');
for(const name of ['helper_filter','helper_select','filter_select']) {
 const seen=[];
 await assert.rejects(()=>call(name,[{get enabled(){seen.push(0);throw sentinel;}},{get enabled(){seen.push(1);return true;}}]),error=>error===sentinel);
 assert.deepEqual(seen,[0],'failed earlier element stops later filter/projection work');
}
for(const [name,stop,continueValue] of [['helper_any',true,false],['helper_all',false,true]]) {
 const seen=[];
 const flags=[{get enabled(){seen.push(0);return continueValue;}},{get enabled(){seen.push(1);return stop;}},{get enabled(){throw Error('visited after verdict');}}];
 const pending=call(name,flags);assert.deepEqual(seen,[0],'helper predicate begins before any next element');
 assert.equal(await pending,stop);assert.deepEqual(seen,[0,1]);
 const failed=[];
 await assert.rejects(()=>call(name,[{get enabled(){failed.push(0);throw sentinel;}},{get enabled(){failed.push(1);return stop;}}]),error=>error===sentinel);
 assert.deepEqual(failed,[0]);
}
const {randomUUID}=await import('node:crypto');
const {pathToFileURL}=await import('node:url');
const {resolve}=await import('node:path');
const {runCompiledExamples,loadInstalledExampleTestkit}=await import(pathToFileURL(resolve('packages/cloudflare/dist/runtime/example-bindings.test-support.js')));
const testkit=await loadInstalledExampleTestkit(process.cwd());
const checked=await runCompiledExamples({
 artifactBytes:Buffer.from(__ARTIFACT_BYTES__),artifactLabel:'predicate-reuse.can',
 sourceRevision:'predicate-reuse-fixture',workerName:`predicate-reuse-${randomUUID()}`,
 worker:{mainModule:'main.mjs',modules:{'main.mjs':'export default {fetch(){return new Response(null,{status:404})}};'}},
 compatibilityDate:'2026-07-15',d1Binding:'DB',testkit,signal:AbortSignal.timeout(30000),
});
assert.equal(checked.ok,true,JSON.stringify(checked.report));
assert.deepEqual(checked.report.summary,{total:8,passed:8,failed:0,setupFailed:0,unsupported:0});
"#.replace("__ENTRY__",&serde_json::to_string(&artifact.modules[0].js).unwrap())
 .replace("__ARTIFACT_BYTES__",&serde_json::to_string(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap());
    // Miniflare's worker threads must not inherit --input-type=module.
    // Keep the temporary module under the workspace's installed dependencies.
    let scratch = tempfile::Builder::new()
        .prefix("predicate-reuse-")
        .tempdir_in(root.join("compiler/target"))
        .unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, script).unwrap();
    let output = std::process::Command::new("node")
        .arg(&runner)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
