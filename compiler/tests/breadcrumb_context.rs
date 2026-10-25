//! Bare compiled breadcrumbs consume the released dispatcher-issued context.
//! Registry fault/dynamic descriptors are dispatcher test inputs, not dynamic
//! compiler route emission or native business/application acceptance.
use std::path::Path;
use std::process::Command;

const SOURCE: &str = r#"app Breadcrumbs
Given
When
Then
 page / title="Home"@{nl="Start"}
  text "Root body"
 page /office title="Office <&>"@{nl="Kantoor <&>"}
  require members
  text "Office body"
 page /office/hidden title="Hidden secret" nav=none
  text "Hidden body"
 page /office/hidden/denied title="Denied secret"
  require false
  text "Denied body"
 page /office/hidden/denied/unavailable title="Unavailable secret"
  text "Unavailable body"
 page /office/hidden/denied/unavailable/missing/tasks title="Tasks"@{nl="Taken"}
  text "Tasks body"
 page /office/hidden/denied/unavailable/missing/tasks/current title="Current <&>"@{nl="Huidig <&>"}
  require members
  breadcrumbs
 page /elsewhere title="Unrelated secret"
  text "Unrelated body"
 page /gated title="Gated trail"
  card "Unavailable trail"
   require false
   breadcrumbs
"#;

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
    let response = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
    (output, response)
}

#[test]
fn compiled_breadcrumbs_consume_admitted_full_and_partial_dispatcher_trails() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("breadcrumbs.can");
    let (refused, diagnostics) =
        compile(&SOURCE.replace("Current <&>", "Current <script>"), &source);
    assert!(
        !refused.status.success(),
        "rich markup is outside the source caption profile"
    );
    assert!(
        diagnostics["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E5007"),
        "{diagnostics}"
    );
    assert!(diagnostics.get("modules").is_none());
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
const {createTestDeps,testRequest}=await load('@canlang/interfaces/testing');
const {handlePageRequest}=await import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/pages.js')));
const {buildPageSourceContext,buildPresentationContext}=await import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/presentation.js')));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'breadcrumbs.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const pages=entry.appDefinition.pages;
const prefix='/office/hidden/denied/unavailable/missing/tasks';
const compiledCurrent=pages.find(page=>page.path===prefix+'/current');assert(compiledCurrent);
let captured=null,carrierReads=0,trailHtml='',admissions=[],currentPath=compiledCurrent.path;
const descriptors=pages.map(page=>({ ...page,
 admit:async(source,bindings)=>{
  admissions.push(page.path);
  if(page.path==='/office/hidden/denied/unavailable')throw new Error('private ancestor failure');
  return page.admit(source,bindings);
 },
 render:page===compiledCurrent?async(context,bindings)=>{
  captured=context;
  assert(context.breadcrumbs,'actual defining dispatcher supplies the carrier');
  assert(Object.isFrozen(context.breadcrumbs));assert(Object.isFrozen(context.breadcrumbs.ancestry));
  assert.equal(context.path,currentPath);assert.equal(context.principal,context.invocation);
  // Census the compiled consumer's property read over the unchanged genuine carrier.
  const counted=new Proxy(context,{get(target,key,receiver){
   if(key==='breadcrumbs')carrierReads++;
   return Reflect.get(target,key,receiver);
  }});
  trailHtml=await page.render(counted,bindings);return trailHtml;
 }:page.render,
}));
const current=descriptors.find(page=>page.path===compiledCurrent.path);
const {deps,identity}=await createTestDeps({descriptors});
const configured={...deps,app:{...deps.app,ownerLabels:new Map([['Breadcrumbs','Breadcrumbs']])}};
for(const dynamic of [false,true])for(const partial of [false,true]) {
 // Dynamic current route matching is a defining dispatcher input only; retain
 // the original compiled body and title, without claiming dynamic codegen.
 current.path=dynamic?prefix+'/{Task.id}':compiledCurrent.path;
 currentPath=dynamic?prefix+'/task-42':compiledCurrent.path;
 admissions=[];carrierReads=0;trailHtml='';captured=null;
 const request=testRequest(currentPath+'?team='+identity.teamId,{cookie:identity.cookie,
  headers:{'accept-language':'nl',...(partial?{'HX-Request':'true'}:{})},
 });
 const response=await handlePageRequest(configured,request);
 assert.equal(response.status,200,await response.clone().text());
 const html=await response.text();assert(html.includes(trailHtml));assert.equal(carrierReads,1);
 assert.equal(captured.breadcrumbs.label,'Breadcrumbs');
 assert.deepEqual(captured.breadcrumbs.ancestry.map(value=>value.path),['/','/office',prefix,currentPath]);
 assert.deepEqual(captured.breadcrumbs.ancestry.map(value=>value.active),[false,false,false,true]);
 assert(trailHtml.includes('<nav aria-label="Breadcrumbs">'));
 assert(trailHtml.includes('<a href="/">Start</a>'));
 assert(trailHtml.includes('<a href="/office">Kantoor &lt;&amp;&gt;</a>'));
 assert(trailHtml.includes('<a href="'+prefix+'">Taken</a>'));
 assert(trailHtml.includes('<span aria-current="page">Huidig &lt;&amp;&gt;</span>'));
 assert(!trailHtml.includes('href="'+currentPath+'"'));
 for(const hidden of ['Hidden secret','Denied secret','Unavailable secret','Unrelated secret',
  'private ancestor failure','/office/hidden/denied/unavailable/missing"','<script>'])assert(!trailHtml.includes(hidden),hidden);
 for(const ancestor of ['/','/office','/office/hidden/denied','/office/hidden/denied/unavailable',prefix]){
  assert.equal(admissions.filter(value=>value===ancestor).length,1,ancestor);
 }
 assert(!admissions.includes('/office/hidden'),'nav=none ancestry never admits or discloses the hidden page');
 assert.equal(admissions.includes('/elsewhere'),!partial,'partial only admits actual declared ancestors');
}
assert(captured);
const originalCarrier=captured.breadcrumbs;
const principal=captured.principal,sourceContext=buildPageSourceContext(principal);
const contextInput={request:testRequest(currentPath),pathname:currentPath,isPartial:true,appDefaultLocale:'en',
 csrfToken:captured.csrfToken,principal,query:captured.query};
const spoof={label:'forged',ancestry:[{owner:'foreign',path:'/private',title:'Spoof secret',active:true}]};
const absent=buildPresentationContext({...contextInput,source:{...sourceContext,breadcrumbs:spoof}});
assert.equal(absent.breadcrumbs,undefined,'source extras cannot issue the presentation carrier');
await assert.rejects(compiledCurrent.render(absent,{}),/admitted declared ancestry is unavailable/);
const trusted=buildPresentationContext({...contextInput,source:{...sourceContext,breadcrumbs:spoof},breadcrumbs:originalCarrier});
assert.equal(trusted.breadcrumbs,originalCarrier,'retain the genuine issued carrier by reference');
const trustedHtml=await compiledCurrent.render(trusted,{});assert(!trustedHtml.includes('Spoof secret'));
const gated=pages.find(page=>page.path==='/gated');assert(gated);
let gatedReads=0;
const guarded=new Proxy(absent,{get(target,key,receiver){if(key==='breadcrumbs'){gatedReads++;throw Error('gated carrier read');}return Reflect.get(target,key,receiver);}});
assert.equal(await gated.render(guarded,{}),'');assert.equal(gatedReads,0);
"#).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let run = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
}

#[test]
fn bare_breadcrumbs_refuse_authored_headers_options_and_content() {
    let scratch = tempfile::tempdir().unwrap();
    let prefix = "app Trail\nGiven\nWhen\nThen\n page / title=\"Trail\"\n";
    for (name, body) in [
        ("header", "  breadcrumbs \"Alternative\"\n"),
        (
            "translated-header",
            "  breadcrumbs \"Alternative\"@{nl=\"Alternatief\"}\n",
        ),
        ("selector", "  breadcrumbs pages=[\"/\"]\n"),
        ("label", "  breadcrumbs label=\"Alternative\"\n"),
        ("body", "  breadcrumbs\n   text \"Alternative\"\n"),
    ] {
        let (output, response) = compile(
            &format!("{prefix}{body}"),
            &scratch.path().join(format!("{name}.can")),
        );
        assert!(!output.status.success(), "{name}: {response}");
        assert!(response.get("modules").is_none(), "{name}: {response}");
        assert!(
            response["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| { diagnostic["severity"] == "error" }),
            "{name}: {response}"
        );
    }
}
