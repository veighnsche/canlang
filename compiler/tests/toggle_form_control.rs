//! Toggle create-form control: the admitted `toggle` factory must travel the
//! same prepared-field contract as `checkbox` (authoredFields + prepared
//! field props), rendering real checked/unchecked states through the
//! installed UI, and submitted values must persist through the real
//! Interfaces operation handler into compiled `Item.create`. Before the
//! `is_form_field_control` repair, the emitted toggle carried a raw
//! `field:"urgent"` string and the real UI threw
//! `field "undefined": type must be a string`.
use std::path::Path;
use std::process::Command;

fn source(default: bool) -> String {
    format!(
        "app Toggle\nGiven\n Item {{ title:text, urgent:bool={} }}\n policy Item read=public\nWhen\n crud Item by=public fields=title,urgent\nThen\n page / title=\"Page\"\n  form Item.create\n   input title\n   toggle urgent\n  list Item columns=title,urgent\n",
        default
    )
}

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
fn toggle_create_form_renders_prepared_bool_states() {
    let scratch = tempfile::tempdir().unwrap();
    for default in [false, true] {
        let name = format!("toggle-{default}.can");
        let dir = scratch.path().join(default.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("artifact.json"),
            serde_json::to_vec(&compile(&source(default), &dir.join(&name)).1).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join("expect.json"),
            serde_json::json!({"default": default, "can": name}).to_string(),
        )
        .unwrap();
        let runner = dir.join("render.mjs");
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
const {catalogFromArtifactOperations}=await load('@canlang/interfaces/http/operations');
const {deriveCsrfToken}=await load('@canlang/identity');
const internals=name=>import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/'+name+'.js')));
const {resolveRequestIdentity}=await internals('context');
const {buildPresentationContext}=await internals('presentation');
const {createSourceFormBindings}=await internals('form-binding');
const {createOperationFormPreparer}=await internals('forms');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const expect=JSON.parse(readFileSync(resolve(base,'expect.json'),'utf8'));
assert.deepEqual(artifact.diagnostics??[],[],'compile clean');
const assembly=await assembleModules({artifact,sourcePath:resolve(base,expect.can)},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const catalog=catalogFromArtifactOperations(artifact);
const {deps,identity}=await createTestDeps();
const request=testRequest('/',{cookie:identity.cookie});
const {identity:principal}=await resolveRequestIdentity(deps.identity.store,request,{clock:deps.clock,teamId:identity.teamId});
const service=await createSourceFormBindings(new Uint8Array(32).fill(7),'compiler-toggle');
const context=buildPresentationContext({request,pathname:'/',isPartial:false,appDefaultLocale:'en',
 csrfToken:await deriveCsrfToken(identity.sessionToken),principal,catalog,clock:deps.clock,
 formBindings:service,appId:deps.app.appId,sessionToken:identity.sessionToken,
 query:async()=>({rows:[],columns:[{field:'title',label:'Title',type:'text'},{field:'urgent',label:'Urgent',type:'bool'}]}),
});
const genuine=createOperationFormPreparer(context,catalog,deps.clock,{
 service,appId:deps.app.appId,sessionToken:identity.sessionToken,identity:principal,
});
let spec=null;
context.prepareForm=async function(s){spec=s;return genuine(s);};
const page=entry.appDefinition.pages.find(page=>page.path==='/');assert(page);
const html=await page.render(context,{});
assert.deepEqual(spec.authoredFields,['title','urgent']);
assert.match(html,/name="inputs\[urgent\]"/,'toggle submits under its field name');
const checked=/name="inputs\[urgent\]"[^>]*checked|checked[^>]*name="inputs\[urgent\]"/.test(html);
assert.equal(checked,expect.default,'toggle checked tracks the prepared bool default');
"#)
        .unwrap();
        let out = Command::new("node")
            .arg(&runner)
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "default={default}: {}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn toggle_create_form_submit_persists_bool_states() {
    let scratch = tempfile::tempdir().unwrap();
    for default in [false, true] {
        // Checked submit persists true; unchecked (presence marker only)
        // persists false — including against a true default.
        let cases: &[(&str, bool, bool)] = if default {
            &[("Seed row", true, true), ("Unchecked row", false, false)]
        } else {
            &[("Checked row", true, true), ("Unchecked row", false, false)]
        };
        let name = format!("toggle-submit-{default}.can");
        let dir = scratch.path().join(format!("submit-{default}"));
        std::fs::create_dir_all(&dir).unwrap();
        let (_, artifact) = compile(&source(default), &dir.join(&name));
        std::fs::write(
            dir.join("artifact.json"),
            serde_json::to_vec(&artifact).unwrap(),
        )
        .unwrap();
        let runner = dir.join("submit.mjs");
        std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=process.argv[2],base=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(root,'package.json'));
const load=name=>import(pathToFileURL(require.resolve(name)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {assembleWorker}=await load('@canlang/cloudflare/worker/assembly');
const {createIdentityFixture}=await load('@canlang/interfaces/testing');
const {handlePageRequest}=await load('@canlang/interfaces');
const {catalogFromArtifactOperations,handleOperationRequest}=await load('@canlang/interfaces/http/operations');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
assert.deepEqual(artifact.diagnostics??[],[],'compile clean');
const canFiles=JSON.parse(readFileSync(resolve(base,'cases.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,canFiles.can)},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage();
const identity=await createIdentityFixture({});
const catalog=catalogFromArtifactOperations(artifact);
const derived={};
for (const op of artifact.operations) derived[op.name]=catalog.derivedFor(op.name);
const worker=await assembleWorker(artifact,assembly,{store,identityStore:identity.store,
 http:{createPageHandler:(actual)=>(req)=>handlePageRequest(actual,req),
 createOperationHandler:(d)=>(req,op)=>handleOperationRequest(d,req,op),derivedInputs:derived},
},{active:true});
const get=async(path)=>worker.fetch(new Request('https://test.invalid'+path,{headers:{cookie:identity.cookie}}));
const badge=(html,title)=>{
 const m=html.match(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[\\s\\S]{0,400}?urgent</dt><dd>[^<]*<span class="badge">(true|false)</span>'));
 assert(m,title+' row with urgent badge served');
 return m[1];
};
for (const [title,checked,expected] of canFiles.cases) {
 const form=await (await get('/')).text();
 const opId=form.match(/name="operation_id" value="([^"]+)"/)[1];
 const csrf=form.match(/name="_csrf" value="([^"]+)"/)[1];
 const body={operation:'Toggle.Item.create',operation_id:opId,_csrf:csrf,timezone:'UTC','inputs[title]':title,'can_boolean_present:inputs[urgent]':'true'};
 if (checked) body['inputs[urgent]']='true';
 const res=await worker.fetch(new Request('https://test.invalid/api/operations/Toggle.Item.create',{
  method:'POST',headers:{cookie:identity.cookie,'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams(body).toString()}));
 assert.equal(res.status,200,title+' submit accepted');
 assert.equal((await res.json()).status,'committed',title+' submit committed');
 const html=await (await get('/')).text();
 assert.equal(badge(html,title),String(expected),title+' persists '+expected);
}
"#)
        .unwrap();
        std::fs::write(
            dir.join("cases.json"),
            serde_json::json!({
                "can": name,
                "cases": cases.iter().map(|(t, c, e)| (t, c, e)).collect::<Vec<_>>(),
            })
            .to_string(),
        )
        .unwrap();
        let out = Command::new("node")
            .arg(&runner)
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "default={default}: {}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
