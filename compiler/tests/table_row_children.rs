//! Ordinary table descendants use the released installed renderRow consumer.
//! Supplied query/form/receipt snapshots qualify presentation producers only.
use std::path::Path;
use std::process::Command;

const SOURCE: &str = r#"app TableRows
use std {ImagesV1 as Images} from=deployment.images
Given
 Template {name:text,visible:bool=true,inspection:delivery(Images.inspect)?}
 policy Template read=members
When
 scenario inspect(template:Template,graph:file) by=members
  do
   send Images.inspect {graph} as inspection
   set template {inspection}
 scenario rename(template:Template,name:text) by=members
  do set template {name}
Then
 page / title="Templates"
  table Template as entry columns=name empty="No templates"@{nl="Geen sjablonen"}
   pagination
   status entry.visible
   card "Authorized details"
    require entry.visible
    list (entry.inspection?.result?.fields ?? []) as inspected
     text inspected.node
    form rename arguments={template=entry}
     input name
     text entry.name
 page /bare title="Bare table"
  table Template columns=name
   pagination
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
fn ordinary_table_rows_reach_installed_ui_with_aliases_and_ordered_protected_children() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("table.can");
    let (output, artifact) = compile(SOURCE, &source);
    assert!(output.status.success(), "{artifact}");
    let default_source = SOURCE
        .replace("table Template as entry", "table Template")
        .replace("entry.", "row.")
        .replace("template=entry", "template=row");
    let default_path = scratch.path().join("default.can");
    let (default_output, default_artifact) = compile(&default_source, &default_path);
    assert!(default_output.status.success(), "{default_artifact}");
    for (file, value) in [
        ("artifact.json", &artifact),
        ("default.json", &default_artifact),
    ] {
        std::fs::write(
            scratch.path().join(file),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
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
async function importArtifact(file,source,workDir) {
 const artifact=JSON.parse(readFileSync(resolve(base,file),'utf8'));
 const assembly=await assembleModules({artifact,sourcePath:resolve(base,source)},{
  workDir:resolve(base,workDir),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
  uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
 });
 return importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
}
const entry=await importArtifact('artifact.json','table.can','modules');
const defaultEntry=await importArtifact('default.json','default.can','default-modules');
const originals=[
 {id:'one',version:2,fields:{name:'First <unsafe>',visible:true,inspection:null}},
 {id:'hidden',version:3,fields:{name:'Hidden',visible:false,inspection:null}},
 {id:'two',version:4,fields:{name:'Second',visible:true,inspection:null}},
];
let rows=originals,trace=[],queries=[],requests=[],observeFailure=null,prepareFailure=null,fieldReads=[];
const context={memberships:['members'],preferredLocales:['en'],appDefaultLocale:'en',theme:{},path:'/',
 isPartial:false,csrfToken:'csrf',principal:{},invocation:{},canonical:{builtinRoles:['members'],
  observeDelivery:async(locator,selected)=>{
   assert(originals.includes(locator.record),'inspection reader gets exact original RowView');
   assert.equal(locator.field,'inspection');assert.deepEqual(selected,['result.fields']);
   trace.push('observe:start:'+locator.record.id);await Promise.resolve();
   if(observeFailure)throw observeFailure;
   trace.push('observe:end:'+locator.record.id);
   return {'result.fields':[Object.defineProperty({key:'k',kind:'text',label:'l'},'node',{
    get(){fieldReads.push(locator.record.id);return 'node-'+locator.record.id;},
   })]};
  },
 },
 query:async(invocation,model,args)=>{
  assert.equal(invocation,context.invocation);assert.equal(model,'TableRows.Template');queries.push(args);
  return {rows,columns:[{field:'name',label:'Name',type:'text'}],nextCursor:rows.length?'next':undefined};
 },
 prepareForm:async function(request){
  assert.equal(this,context,'row callback retains the actual presentation context');
  const record=request.arguments.template;
  const original=originals.find(row=>row.id===record.id);assert(original);
  assert.equal(record.version,BigInt(original.version));assert.equal(record.name,original.fields.name);
  assert.equal(request.operation,'TableRows.rename');assert.deepEqual(request.fields,['name']);
  assert.deepEqual(request.authoredFields,['name']);assert(request.occurrence.includes(original.id));
  requests.push(request);trace.push('prepare:start:'+record.id);await Promise.resolve();
  if(prepareFailure)throw prepareFailure;
  trace.push('prepare:end:'+record.id);
  const field={path:'name',label:'Name',type:'text',required:true,value:'draft-'+record.id};
  const props={context,action:'/canonical/rename',operation:request.operation,operationId:'key-'+record.id,
   mode:'create',timeZone:'UTC',fields:[field],authoredFields:['name'],idPrefix:'form-'+record.id,submit:'Rename'};
  return {status:'ready',props,field:path=>{
   assert.equal(path,'name');trace.push('control:'+record.id);
   return {context,field,idPrefix:props.idPrefix,mode:props.mode};
  }};
 },
};
const render=definition=>definition.appDefinition.pages[0].render(context,{});
for(const definition of [entry,defaultEntry]) {
 trace=[];queries=[];requests=[];fieldReads=[];
 const html=await render(definition);
 assert.equal(queries.length,1);assert.equal(queries[0].page,true);assert.equal(queries[0].limit,undefined);
 assert.equal(typeof queries[0].occurrence,'string');assert(queries[0].occurrence.length>0);
 assert.deepEqual(trace,[
  'observe:start:one','observe:end:one','prepare:start:one','prepare:end:one','control:one',
  'observe:start:two','observe:end:two','prepare:start:two','prepare:end:two','control:two',
 ],'all awaited descendants settle before the next row, in source order');
 assert.deepEqual(fieldReads,['one','two'],'original copied fields render once');
 assert.equal(requests.length,2,'false row gate does not prepare a form');
 assert.notEqual(requests[0].occurrence,requests[1].occurrence);
 assert.equal((html.match(/<tr>/g)||[]).length,7,'header plus summary/detail pairs for three rows');
 assert.equal((html.match(/<form /g)||[]).length,2,'installed form consumes prepared bodies');
 assert(html.includes('draft-one')&&html.includes('draft-two'));
 assert(html.includes('node-one')&&html.includes('node-two'));
 assert(!html.includes('node-hidden')&&!html.includes('key-hidden'));
 assert(html.includes('First &lt;unsafe&gt;')&&!html.includes('First <unsafe>'));
 assert(html.indexOf('node-one')<html.indexOf('draft-one')&&html.indexOf('draft-one')<html.indexOf('node-two'));
 assert(html.includes('data-cursor="next"'));
}
trace=[];queries=[];requests=[];fieldReads=[];
const bare=await entry.appDefinition.pages[1].render(context,{});
assert.equal(queries.length,1);assert.equal(queries[0].page,true);
assert.equal((bare.match(/<tr>/g)||[]).length,4,'bare table stays summary-only');
assert.deepEqual(trace,[]);assert.deepEqual(requests,[]);assert.deepEqual(fieldReads,[]);
const firstObservation=new Error('first-observation');observeFailure=firstObservation;trace=[];requests=[];
await assert.rejects(render(entry),error=>error===firstObservation);
assert.deepEqual(trace,['observe:start:one']);assert.deepEqual(requests,[]);observeFailure=null;
const firstPreparation=new Error('first-preparation');prepareFailure=firstPreparation;trace=[];fieldReads=[];
await assert.rejects(render(entry),error=>error===firstPreparation);
assert.deepEqual(trace,['observe:start:one','observe:end:one','prepare:start:one']);
assert.deepEqual(fieldReads,['one']);prepareFailure=null;
rows=[];context.preferredLocales=['nl'];trace=[];queries=[];requests=[];
const empty=await render(entry);assert(empty.includes('Geen sjablonen'));
assert.equal(queries.length,1);assert.deepEqual(trace,[]);assert.deepEqual(requests,[]);
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
fn table_children_keep_alias_slot_and_pagination_refusals() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, source) in [
        (
            "mixed-alias",
            SOURCE.replace("   status entry.visible", "   status row.visible"),
        ),
        (
            "slot",
            SOURCE.replace(
                "   status entry.visible",
                "   slot content\n    text entry.name",
            ),
        ),
        (
            "duplicate-page",
            SOURCE.replacen("   pagination", "   pagination\n   pagination", 1),
        ),
        (
            "page-payload",
            SOURCE.replacen("   pagination", "   pagination \"unexpected\"", 1),
        ),
    ] {
        let (output, response) = compile(&source, &scratch.path().join(format!("{name}.can")));
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
