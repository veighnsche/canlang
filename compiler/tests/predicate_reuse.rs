//! Equivalent pure predicates keep their meaning when extracted into helpers.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

#[test]
fn ordinary_async_any_all_preserve_helper_reuse_order_and_failures() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut db = SourceDb::new();
    let id = db.add(
        "predicate-reuse.can".into(),
        r#"app PredicateReuse
Given
 contract Flag {enabled:bool}
 derive enabled(flag:Flag):bool = flag.enabled
 derive inline_any(flags:Flag[]):bool = any(flags as flag,flag.enabled)
 derive helper_any(flags:Flag[]):bool = any(flags as flag,enabled(flag))
 derive inline_all(flags:Flag[]):bool = all(flags as flag,flag.enabled)
 derive helper_all(flags:Flag[]):bool = all(flags as flag,enabled(flag))
 derive nested(flags:Flag[]):bool = all(flags as flag,any([flag] as candidate,enabled(candidate)))
When
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
}
for(const [inline,helper] of [['inline_any','helper_any'],['inline_all','helper_all']]) {
 for(const invalid of [null,new Set(),[{enabled:'bad'}]]) {
  let original;try{await call(inline,invalid);}catch(error){original=error;}
  assert(original instanceof ValueError);
  await assert.rejects(()=>call(helper,invalid),error=>error instanceof ValueError&&error.code===original.code&&error.message===original.message);
 }
}
const sentinel=new Error('original predicate failure');
for(const [name,stop,continueValue] of [['helper_any',true,false],['helper_all',false,true]]) {
 const seen=[];
 const flags=[{get enabled(){seen.push(0);return continueValue;}},{get enabled(){seen.push(1);return stop;}},{get enabled(){throw Error('visited after verdict');}}];
 const pending=call(name,flags);assert.deepEqual(seen,[0],'helper predicate begins before any next element');
 assert.equal(await pending,stop);assert.deepEqual(seen,[0,1]);
 const failed=[];
 await assert.rejects(()=>call(name,[{get enabled(){failed.push(0);throw sentinel;}},{get enabled(){failed.push(1);return stop;}}]),error=>error===sentinel);
 assert.deepEqual(failed,[0]);
}
"#.replace("__ENTRY__",&serde_json::to_string(&artifact.modules[0].js).unwrap());
    let output = std::process::Command::new("node")
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
