//! One read-dependent scenario default through generated imports and the
//! installed canonical Cloudflare/State Memory invocation owners.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn computed_read_default_uses_admitted_context_and_skips_explicit_override() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};
    use canlang_compiler::codegen::ir::{self, IrCallTarget, IrDefault, IrExpr, IrItemKind};
    use canlang_compiler::source::{SourceDb, Span};

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("default-read.can");
    let source = r#"app DefaultRead
Given
 Entry {count:int=1}
 policy Entry read=members
 derive entry_count():int = count(Entry)
When
 crud Entry by=members fields=count
 scenario selected(total:int=entry_count()) -> int by=members
  do return total
Then
"#;
    std::fs::write(&input, source).unwrap();
    let mut db = SourceDb::new();
    let id = db.add(input.display().to_string(), source.into());
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let selected = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "DefaultRead.selected")
        .unwrap();
    let helper = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "DefaultRead.entry_count")
        .unwrap();
    let parameter = &checked.effects.scenarios[&selected.id].params[0];
    let default_key = parameter.default.as_ref().expect("authored read default");
    assert!(
        matches!(&checked.types.selected_calls[default_key].target, SelectedCallTarget::DeriveFn(id) if *id == helper.id)
    );
    assert_eq!(
        checked.types.node_types[default_key],
        ResolvedType::Scalar(Scalar::Int)
    );
    let (ir, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let default_item = ir
        .items
        .iter()
        .find(|item| item.id == parameter.param)
        .unwrap();
    let IrItemKind::Param {
        default: Some(IrDefault::Computed { expr, .. }),
        ..
    } = &default_item.kind
    else {
        panic!("owning computed parameter default")
    };
    assert_eq!(expr.ty, ResolvedType::Scalar(Scalar::Int));
    assert!(
        matches!(&expr.expr, IrExpr::Call { target: IrCallTarget::DeriveFn(name), args } if name == "DefaultRead.entry_count" && args.is_empty())
    );
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        r#"
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile}=await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,asId,asModel,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const loaded=loadArtifactFile(resolve(base,'artifact.json')),artifact=loaded.artifact;
const model='DefaultRead.Entry',operation='DefaultRead.selected';
const descriptor=artifact.operations.find(item=>item.name===operation);
assert.equal(descriptor.kind,'scenario');
assert.equal(descriptor.inputs.fields.length,1);
const total=descriptor.inputs.fields[0];
assert.equal(total.name,'total');assert.equal(total.field.kind,'integer');
assert.equal(total.computedDefault,true);assert.equal(Object.hasOwn(total,'default'),false);
assert.equal(artifact.callables.find(item=>item.id===operation).inputStyle,'parameters');
for(const capability of ['state','state.parameters'])assert.ok(artifact.requires.some(item=>item.capability===capability));
assert.ok(artifact.modules.some(module=>module.js.includes('records(')&&module.js.includes('count(')));
// Observe only; every read, count and role decision delegates unchanged to
// the installed runtime. The native context and row objects are retained.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {records as nativeRecords,count as nativeCount,hasRole as nativeHasRole} from ${JSON.stringify(seamUrl)};
export function hasRole(...args){const value=nativeHasRole(...args);globalThis.defaultReadTrace.push({kind:'admission',args,value});return value;}
export async function records(...args){
 globalThis.defaultReadTrace.push({kind:'records-call',args});
 const rows=await nativeRecords(...args);
 globalThis.defaultReadTrace.push({kind:'records-return',rows});return rows;
}
export function count(...args){const value=nativeCount(...args);globalThis.defaultReadTrace.push({kind:'count',args,value});return value;}
`);
const asm=await assembleModules(loaded,{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const trace=[];globalThis.defaultReadTrace=trace;let sequence=0;
async function invoke(name,inputs,operationId=uuidv7(FIXED_NOW,++sequence)){
 trace.length=0;
 const outcome=await invoker.invokeMutation({operation:name,operation_id:operationId,inputs},identity);
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
 return outcome.result.result;
}
const ids=[];
for(let index=0;index<2;index++){
 const id=uuidv7(FIXED_NOW,++sequence);
 assert.equal(await invoke(model+'.create',{},id),null);
 const row=await store.load(asModel(model),asId(id));
 assert.ok(row);assert.equal(row.id,id);
 assert.equal(row.data.count,'1');assert.equal(row.version,1);ids.push(id);
}
assert.notEqual(ids[0],ids[1]);
async function domainSnapshot(){return {
 rows:await Promise.all(ids.map(id=>store.load(asModel(model),asId(id)))),
 history:await Promise.all(ids.map(id=>store.historyFor(asModel(model),asId(id)))),
};}
const before=await domainSnapshot();
assert.equal(await invoke(operation,{}),'2');
const admission=trace[0];assert.equal(admission.kind,'admission');
const helperTrace=trace.filter(event=>event.kind!=='admission');
assert.deepEqual(helperTrace.map(event=>event.kind),['records-call','records-return','count']);
const [read,returned,counted]=helperTrace;
assert.equal(admission.args[1],'members');assert.equal(admission.value,true);
assert.equal(read.args[0],admission.args[0],'default derive receives admitted handler context unchanged');
assert.equal(read.args[1],model);assert.equal(returned.rows.length,2);
assert.equal(counted.args[0],returned.rows,'count receives identical native domain array');
assert.equal(counted.value,2n);
assert.deepEqual(returned.rows.map(row=>row.id).sort(),[...ids].sort());
assert.deepEqual(returned.rows.map(row=>row.count),[1n,1n],'native integer projection');
assert.deepEqual(await domainSnapshot(),before,'default read/body do not alter domain rows, versions or history');
assert.equal(await invoke(operation,{total:'9'}),'9');
assert.equal(trace[0].kind,'admission');
assert.ok(trace.every(event=>event.kind==='admission'),'explicit total skips default helper/read/count');
assert.deepEqual(await domainSnapshot(),before,'explicit pure body leaves domain intact');
console.log('computed read default: real generated native read/count, admitted context identity, omission2/override9 and unchanged domain history passed');
"#,
    )
    .unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}
