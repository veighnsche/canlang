//! Checked duration operators through emitted code and the installed native facade.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

#[test]
fn duration_operators_keep_values_semantics_and_authored_evaluation_order() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut db = SourceDb::new();
    let id = db.add(
        "duration-operators.can".into(),
        r#"app DurationOperators
Given
 contract Operands {factor:int,left:duration,right:duration}
 contract Interval {start:datetime,finish:datetime,unit:duration}
 derive elapsed_ratio(interval:Interval):decimal = (interval.finish-interval.start)/interval.unit
 derive elapsed_remainder(interval:Interval):duration = (interval.finish-interval.start)%interval.unit
 derive ratio(pair:Operands):decimal = pair.left/pair.right
 derive remainder(pair:Operands):duration = pair.left%pair.right
 derive read_factor(pair:Operands):int = pair.factor
 derive read_duration(pair:Operands):duration = pair.left
 derive scaled(pair:Operands):duration = read_factor(pair)*read_duration(pair)
 derive nested(pair:Operands):decimal = (read_factor(pair)*read_duration(pair))/pair.right
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
    let mut result = DiagnosticResult::new("duration-operators", LANGUAGE_VERSION, SCHEMA_VERSION);
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
    let script = r#"import assert from 'node:assert/strict';
import {decimalToString, datetime, ValueError, INT64_MAX, INT64_MIN} from '@canlang/values';
const text=__ENTRY__.replaceAll('"@canlang/stdlib"',JSON.stringify(import.meta.resolve('@canlang/cloudflare/runtime/stdlib')));
const entry=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const registry=entry.canApp();
const ratio=registry['DurationOperators.ratio'], remainder=registry['DurationOperators.remainder'];
const scaled=registry['DurationOperators.scaled'], nested=registry['DurationOperators.nested'];
const pair=(left,right,factor=1n)=>({left,right,factor});
const interval={start:datetime('2026-10-15T00:00:00Z'),finish:datetime('2026-10-15T00:00:07Z'),unit:2000n};
assert.equal(decimalToString(await registry['DurationOperators.elapsed_ratio']({},interval)),'3.5');
assert.equal(await registry['DurationOperators.elapsed_remainder']({},interval),1000n);
assert.equal(decimalToString(await ratio({},pair(7n,2n))),'3.5');
assert.equal(decimalToString(await ratio({},pair(-7n,2n))),'-3.5');
assert.equal(decimalToString(await ratio({},pair(1n,6n))),'0.166666666666666667');
assert.equal(decimalToString(await ratio({},pair(INT64_MIN,-1n))),'9223372036854775808');
assert.equal(decimalToString(await ratio({},pair(INT64_MAX,INT64_MAX))),'1');
for(const [left,right,expected] of [[7n,3n,1n],[-7n,3n,-1n],[7n,-3n,1n],[-7n,-3n,-1n],[INT64_MIN,-1n,0n]]) {
 assert.equal(await remainder({},pair(left,right)),expected);
}
for(const [factor,duration,expected] of [[3n,5000n,15000n],[-3n,5000n,-15000n],[3n,-5000n,-15000n],[0n,INT64_MAX,0n]]) {
 assert.equal(await scaled({},pair(duration,1n,factor)),expected);
}
assert.equal(decimalToString(await nested({},pair(7n,2n,3n))),'10.5');
const fails=async(fn,value,code)=>assert.rejects(()=>fn({},value),error=>error instanceof ValueError&&error.code===code);
await fails(ratio,pair(1n,0n),'division-by-zero');
await fails(remainder,pair(1n,0n),'division-by-zero');
await fails(ratio,pair(INT64_MAX+1n,0n),'overflow');
await fails(ratio,pair(1n,INT64_MAX+1n),'overflow');
await fails(scaled,pair(INT64_MAX,1n,2n),'overflow');
await fails(scaled,pair(INT64_MIN,1n,-1n),'overflow');
await fails(ratio,pair('bad',1n),'invalid-construction');
await fails(remainder,pair(1n,'bad'),'invalid-construction');
await fails(scaled,pair(1n,1n,'bad'),'invalid-construction');
for(const [fn,names] of [[ratio,['left','right']],[remainder,['left','right']],[scaled,['factor','left']]]) {
 for(const throwing of [undefined,names[0],names[1]]) {
  const seen=[], sentinel=new Error('original operand failure');
  const value={};
  for(const name of names) Object.defineProperty(value,name,{get(){seen.push(name);if(name===throwing)throw sentinel;return 3n;}});
  if(throwing===undefined) await fn({},value);
  else await assert.rejects(()=>fn({},value),error=>error===sentinel);
  assert.deepEqual(seen,throwing===names[0]?[names[0]]:names,'operands evaluate once in authored order and exceptions stop later evaluation');
 }
}
const seen=[], value={get factor(){seen.push('factor');return 3n;},get left(){seen.push('duration');return 7n;}};
const pending=scaled({},value);
assert.deepEqual(seen,['factor'],'first awaited source derive completes before the second begins');
assert.equal(await pending,21n);
assert.deepEqual(seen,['factor','duration']);
"#.replace("__ENTRY__", &serde_json::to_string(&artifact.modules[0].js).unwrap());
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "--eval", &script])
        .current_dir(root)
        .output()
        .expect("execute emitted duration operators");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
