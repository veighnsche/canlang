//! Actual CLI and installed UI consumers; supplied query/prepared form values
//! qualify presentation adapters, not current native mutation authority.
use std::{path::Path, process::Command};

const SOURCE: &str = r#"app LeafControls
Given
 Job {used:int?,reserved:int,unfinished:bool,visible:bool=true}
 Profile {amount:int min=1 max=10,graph:file}
 policy Job read=members
When
 crud Profile by=members fields=amount,graph delete=none
Then
 page / title="Controls"
  list Job
   progress row.used max=row.reserved
   loading row.unfinished
   tooltip "Send <message>"@{nl="Bericht verzenden"}
    require row.visible
    form Profile.create
     range amount
     file_input graph
 page /placeholder title="Placeholder"
  loading
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
    let value = serde_json::from_slice(&output.stdout).unwrap();
    (output, value)
}

#[test]
fn released_integer_progress_loading_tooltip_and_owned_controls_execute() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("controls.can");
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
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'controls.can')},{workDir:resolve(base,'modules'),
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
let used=5n,reserved=10n,unfinished=true,visible=true,reads=[],trace=[],queries=0,preparations=0,failure=null;
const fields={};for(const [name,value] of Object.entries({used:()=>used,reserved:()=>reserved,unfinished:()=>unfinished,visible:()=>visible}))
 Object.defineProperty(fields,name,{enumerable:true,get(){reads.push(name);return value();}});
const row={id:'job',version:1,fields};
const context={memberships:['members'],preferredLocales:['en'],appDefaultLocale:'en',theme:{},path:'/',isPartial:false,
 csrfToken:'csrf',principal:{},invocation:{},query:async(invocation,model)=>{queries++;assert.equal(invocation,context.invocation);
 assert.equal(model,'LeafControls.Job');return {rows:[row],columns:[]};},prepareForm:async(request)=>{
 preparations++;trace.push('prepare');if(failure)throw failure;
 assert.equal(request.operation,'LeafControls.Profile.create');assert.deepEqual(request.fields,['amount','graph']);
 assert.deepEqual(request.authoredFields,['amount','graph']);
 const preparedFields=[{path:'amount',type:'int',label:'Amount',required:true,value:'4',min:1,max:10},
 {path:'graph',type:'file',label:'Graph',required:true}];
 const props={context,action:'/canonical/configure',operation:request.operation,operationId:'key',mode:'create',
 fields:preparedFields,authoredFields:['amount','graph'],idPrefix:'controls',timeZone:'UTC',submit:'Save'};
 return {status:'ready',props,field:path=>{trace.push(path);return {context,field:preparedFields.find(field=>field.path===path),mode:'create',idPrefix:'controls'};}};
}};
const render=()=>entry.appDefinition.pages[0].render(context,{});
let html=await render();assert.equal(queries,1);assert.equal(preparations,1);assert.deepEqual(trace,['prepare','amount','graph']);
assert.equal(reads.filter(name=>name==='used').length,1);assert.equal(reads.filter(name=>name==='reserved').length,1);
assert(html.includes('<progress')&&html.includes('value="5" max="10"')&&html.includes('50%'));
assert(html.includes('loading-spinner')&&html.includes('data-tip="Send &lt;message&gt;"')&&html.includes('tabindex="0"'));
assert(html.includes('type="range"')&&html.includes('min="1" max="10"')&&html.includes('value="4"'));
assert(html.includes('type="file"')&&html.includes('name="inputs[graph]"'));
assert.equal((html.match(/name="inputs\[amount\]"/g)||[]).length,1);assert.equal((html.match(/name="inputs\[graph\]"/g)||[]).length,1);
assert.equal((html.match(/for="controls-amount"/g)||[]).length,1,'owning control label is not duplicated');
assert(html.indexOf('<progress')<html.indexOf('loading-spinner')&&html.indexOf('loading-spinner')<html.indexOf('<form'));
unfinished=false;visible=false;preparations=0;trace=[];html=await render();assert(!html.includes('loading-spinner'));assert(!html.includes('<form'));assert.equal(preparations,0);
used=null;html=await render();assert(html.includes('role="alert"'));assert(!html.includes('<progress'));
used=11n;html=await render();assert(html.includes('role="alert"'));assert(!html.includes('<progress'));
used=9007199254740993n;html=await render();assert(html.includes('role="alert"')&&!html.includes('<progress'));
reserved=9007199254740993n;await assert.rejects(render,/maximum is not exactly displayable/);reserved=10n;
used=5n;reserved=0n;await assert.rejects(render,/max/);reserved=10n;
context.preferredLocales=['nl'];unfinished=true;visible=true;html=await render();assert(html.includes('Laden'));assert(html.includes('Bericht verzenden'));
failure=new Error('first preparation');trace=[];await assert.rejects(render,error=>error===failure);assert.deepEqual(trace,['prepare']);failure=null;
html=await entry.appDefinition.pages[1].render(context,{});assert(html.includes('loading-spinner')&&html.includes('Laden'));
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

#[test]
fn unsupported_leaf_units_owners_headers_and_suites_keep_refusal() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, source) in [
        ("progress-unit", SOURCE.replace("progress row.used max=row.reserved", "progress row.used max=\"ten\"")),
        ("progress-max", SOURCE.replace("progress row.used max=row.reserved", "progress row.used")),
        ("progress-body", SOURCE.replace("progress row.used max=row.reserved", "progress row.used max=row.reserved\n    text \"body\"")),
        ("loading-value", SOURCE.replace("loading row.unfinished", "loading row.reserved")),
        ("loading-body", SOURCE.replace("loading row.unfinished", "loading row.unfinished\n    text \"body\"")),
        ("tooltip-empty", SOURCE.replace("   tooltip \"Send <message>\"@{nl=\"Bericht verzenden\"}\n    require row.visible\n    form Profile.create\n     range amount\n     file_input graph", "   tooltip \"Empty\"")),
        ("range-foreign", SOURCE.replace("range amount", "range graph")),
        ("file-foreign", SOURCE.replace("file_input graph", "file_input amount")),
        ("unowned", SOURCE.replace(" page /placeholder title=\"Placeholder\"\n  loading", " page /placeholder title=\"Placeholder\"\n  range amount")),
        ("control-option", SOURCE.replace("range amount", "range amount max=20")),
    ] {
        let (output, artifact) = compile(&source, &scratch.path().join(format!("{name}.can")));
        assert_eq!(output.status.code(), Some(10), "{name}: {artifact}");
        assert!(!artifact["diagnostics"].as_array().unwrap().is_empty(), "{name}: {artifact}");
        assert!(artifact.get("modules").is_none(), "{name}: {artifact}");
    }
    let enum_form = "app Tasks\nGiven\n Task { title:text, priority:enum(low,normal,high)=normal }\n policy Task read=members\nWhen\n crud Task by=members fields=title,priority\nThen\n page / title=\"Tasks\"\n  form Task.create fields=title,priority display=inline\n   input title\n   select priority\n";
    for (name, source) in [
        ("enum-input", enum_form.replace("select priority", "input priority")),
        ("enum-textarea", enum_form.replace("select priority", "textarea priority")),
        ("duration-textarea", enum_form.replace("priority:enum(low,normal,high)=normal", "priority:duration").replace("select priority", "textarea priority")),
        ("nullable-enum-input", enum_form.replace("enum(low,normal,high)=normal", "enum(low,normal,high)?").replace("select priority", "input priority")),
        ("scenario-enum-input", "app Tasks\nGiven\nWhen\n scenario save(priority:enum(low,normal,high)) by=members\n  do let accepted=priority\nThen\n page / title=\"Tasks\"\n  form save\n   input priority\n".to_string()),
        ("update-enum-input", enum_form.replace("  form Task.create fields=title,priority display=inline\n   input title\n   select priority", "  list Task\n   form Task.update arguments={record=row} fields=priority\n    input priority")),
    ] {
        let path = scratch.path().join(format!("{name}.can"));
        let (output, artifact) = compile(&source, &path);
        assert_eq!(output.status.code(), Some(10), "{name}: {artifact}");
        assert!(artifact["diagnostics"].as_array().unwrap().iter().any(|diagnostic|
            diagnostic["code"] == "E3001" && diagnostic["message"].as_str().is_some_and(|message|
                message.contains("priority") && message.contains("needs a text"))), "{name}: {artifact}");
        assert!(artifact.get("modules").is_none(), "{name}: {artifact}");
        let checked = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["check", "--format=json", "--catalog"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("packages/values/dist/catalog.json"))
            .arg(&path).env_remove("CAN_CATALOG").output().unwrap();
        assert_eq!(checked.status.code(), Some(10), "{name}: {}", String::from_utf8_lossy(&checked.stdout));
    }
    let (output, artifact) = compile(enum_form, &scratch.path().join("enum-select.can"));
    assert!(output.status.success(), "enum select: {artifact}");
}
