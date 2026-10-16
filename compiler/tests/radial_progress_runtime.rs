//! Lane B12: radialProgress numeric presentation boundary consumer.
//!
//! The B7/B8 factory admission lets `radial_progress` carry int|decimal
//! values with an int max, but the JS presentation boundary only converted
//! `progress` props to JS numbers. An actual compiled `radial_progress 50
//! max=100` emitted `max:100n` (BigInt), and the real UI contracts/UI
//! (`RadialProgressProps` numbers, `assertValidMax`) threw
//! `RangeError: progress max must be a finite number > 0, got 100` before
//! render. This consumer drives the fixed emission (int via the shared
//! progress conversion, decimal via canonical exact Values text to a finite
//! number) through the emitted pages into the real UI, reusing the existing
//! UI invalid matrix unchanged: bad values alert, bad max throws, max wins.
use std::{path::Path, process::Command};

const SOURCE: &str = include_str!("fixtures/radial-progress-boundary.can");

fn compile(source: &str, path: &Path) -> (std::process::Output, serde_json::Value) {
    std::fs::write(path, source).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let value = serde_json::from_slice(&output.stdout).unwrap();
    (output, value)
}

#[test]
fn radial_progress_int_decimal_and_bounds_render_through_real_ui() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("radial.can");
    let (output, artifact) = compile(SOURCE, &source);
    assert!(output.status.success(), "{artifact}");
    std::fs::write(
        scratch.path().join("artifact.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    let runner = scratch.path().join("render.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=process.argv[2],base=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(root,'package.json'));
const load=name=>import(pathToFileURL(require.resolve(name)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {parseDecimal}=await load('@canlang/values');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'radial.can')},{workDir:resolve(base,'modules'),
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
let done=5n,total=10n,progress=parseDecimal('0.5');
const fields={};for(const [name,value] of Object.entries({title:()=>'T',done:()=>done,total:()=>total,progress:()=>progress}))
 Object.defineProperty(fields,name,{enumerable:true,get(){return value();}});
const row={id:'account',version:1,fields};
const context={memberships:['public'],preferredLocales:['en'],appDefaultLocale:'en',theme:{},path:'/',isPartial:false,
 csrfToken:'csrf',principal:{},invocation:{},query:async(invocation,model)=>{
 assert.equal(model,'RadialBoundary.Account');return {rows:[row],columns:[]};}};
const literal=()=>entry.appDefinition.pages[0].render(context,{});
const completion=()=>entry.appDefinition.pages[1].render(context,{});
const bounds=()=>entry.appDefinition.pages[2].render(context,{});
let html=await literal();assert(html.includes('radial-progress')&&html.includes('--value:50'));
assert(html.includes('aria-valuenow="50"')&&html.includes('aria-valuemax="100"')&&html.includes('>50%</div>'));
html=await completion();assert(html.includes('radial-progress')&&html.includes('--value:0.5'));
assert(html.includes('aria-valuenow="0.5"')&&html.includes('aria-valuemax="100"')&&html.includes('>0.5%</div>'));
progress=parseDecimal('-1');html=await completion();assert(html.includes('role="alert"')&&!html.includes('radial-progress'));progress=parseDecimal('0.5');
html=await bounds();assert(html.includes('aria-valuenow="5"')&&html.includes('--value:50')&&html.includes('>50%</div>'));
done=null;html=await bounds();assert(html.includes('role="alert"'));assert(!html.includes('radial-progress'));
done=11n;html=await bounds();assert(html.includes('role="alert"'));assert(!html.includes('radial-progress'));
done=9007199254740993n;html=await bounds();assert(html.includes('role="alert"')&&!html.includes('radial-progress'));done=5n;
total=0n;await assert.rejects(bounds,/max/);total=10n;
total=9007199254740993n;await assert.rejects(bounds,/maximum is not exactly displayable/);total=10n;
done=11n;total=0n;await assert.rejects(bounds,/max/);done=5n;total=10n;
console.log('radial boundary: literal int, decimal completion, null/alert/unsafe and max-throw order passed');
"#).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
