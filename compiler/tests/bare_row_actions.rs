//! Singular source actions reuse installed protected operation form rendering.
//! Supplied preparer/query snapshots do not qualify native invocation authority.
use std::path::Path;
use std::process::Command;

const SOURCE: &str = r#"app RowActions
Given
 Template {name:text,visible:bool=true}
 Revision in Template {number:int,published:bool=false}
 policy Template read=members
 policy Revision read=members
When
 scenario inspect(template:Template) by=members label="Inspect inputs"@{nl="Invoer inspecteren"}
  do set template {visible=true}
 scenario validate(template:Template) by=members -> Revision label="Validate snapshot"@{nl="Momentopname valideren"}
  do
   create Revision {parent=template,number=1} as revision
   return revision
 scenario publish(revision:Revision) by=members label="Publish revision"@{nl="Versie publiceren"}
  do set revision {published=true}
 scenario rename(template:Template,name:text) by=members label="Rename template"@{nl="Sjabloon hernoemen"}
  do set template {name}
Then
 page / title="Templates"
  list Template as template
   card "Template actions"
    require template.visible
    action inspect
    action validate
    list template.Revision as revision
     card "Revision actions"
      require revision.published==false
      action publish
    action rename
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
fn singular_row_actions_use_owning_forms_captions_nested_records_and_order() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("actions.can");
    let (output, artifact) = compile(SOURCE, &source);
    assert!(output.status.success(), "{artifact}");
    let default_source = SOURCE
        .replace("list Template as template", "list Template")
        .replace("require template.visible", "require row.visible")
        .replace("list template.Revision as revision", "list row.Revision")
        .replace("require revision.published", "require row.published");
    let (default_output, default_artifact) =
        compile(&default_source, &scratch.path().join("default.can"));
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
const entry=await importArtifact('artifact.json','actions.can','modules');
const defaultEntry=await importArtifact('default.json','default.can','default-modules');
const templates=[
 {id:'one',version:2,fields:{name:'First',visible:true}},
 {id:'hidden',version:3,fields:{name:'Hidden',visible:false}},
 {id:'two',version:4,fields:{name:'Second',visible:true}},
];
const revisions={one:[{id:'revision-one',version:5,fields:{number:1n,published:false}},
 {id:'published',version:6,fields:{number:2n,published:true}}],
 two:[{id:'revision-two',version:7,fields:{number:1n,published:false}}]};
const expectedLabels={inspect:'Inspect inputs',validate:'Validate snapshot',publish:'Publish revision',rename:'Rename template'};
let trace=[],requests=[],failure=null;
const context={memberships:['members'],canonical:{builtinRoles:['members']},preferredLocales:['nl'],appDefaultLocale:'en',
 theme:{},path:'/',isPartial:false,csrfToken:'csrf',principal:{},invocation:{},
 query:async(invocation,model,args)=>{
  assert.equal(invocation,context.invocation);
  if(model==='RowActions.Template'){trace.push('query:templates');assert.equal(args.parent,undefined);return {rows:templates,columns:[]};}
  assert.equal(model,'RowActions.Revision');assert(templates.some(row=>row.id===args.parent.id));
  assert.equal(args.parent.version,BigInt(templates.find(row=>row.id===args.parent.id).version));
  assert.notEqual(args.parent.id,'hidden','gated outer row never queries descendants');
  trace.push('query:revisions:'+args.parent.id);return {rows:revisions[args.parent.id],columns:[]};
 },
 prepareForm:async function(request){
  assert.equal(this,context,'prepared action retains actual row presentation context');
  const operation=request.operation.split('.').at(-1),key=operation==='publish'?'revision':'template';
  assert.equal(request.operation,'RowActions.'+operation);assert(operation in expectedLabels);
  assert.deepEqual(Object.keys(request.arguments),[key],'infer only the one protected record');
  const record=request.arguments[key];
  const original=key==='template'?templates.find(row=>row.id===record.id):Object.values(revisions).flat().find(row=>row.id===record.id);
  assert(original);assert.equal(record.version,BigInt(original.version));
  assert.notEqual(record.id,'hidden');assert.notEqual(record.id,'published');
  assert.equal(request.submit.source,expectedLabels[operation]);assert.equal(request.fields,undefined);
  assert.equal(request.authoredFields,undefined,'body-free action keeps native generated input selection');
  assert(request.occurrence.includes(record.id));
  if(key==='revision'){const parent=record.id==='revision-one'?'one':'two';assert(request.occurrence.includes(parent),'nested occurrence retains enclosing record identity');}
  requests.push(request);trace.push('prepare:start:'+operation+':'+record.id);await Promise.resolve();
  if(failure)throw failure;
  trace.push('prepare:end:'+operation+':'+record.id);
  const fields=operation==='rename'?[{path:'name',label:'Name',type:'text',required:true,value:'draft-'+record.id}]:[];
  return {status:'ready',props:{context,action:'/canonical/'+operation,operation:request.operation,
   operationId:'key-'+operation+'-'+record.id,mode:'create',timeZone:'UTC',fields,idPrefix:'form-'+operation+'-'+record.id,
   submit:request.submit},field(){throw Error('bare action has no authored field control');}};
 },
};
const render=definition=>definition.appDefinition.pages[0].render(context,{});
for(const definition of [entry,defaultEntry]){
 trace=[];requests=[];
 const html=await render(definition);
 assert.deepEqual(trace,[
  'query:templates','prepare:start:inspect:one','prepare:end:inspect:one',
  'prepare:start:validate:one','prepare:end:validate:one','query:revisions:one',
  'prepare:start:publish:revision-one','prepare:end:publish:revision-one','prepare:start:rename:one','prepare:end:rename:one',
  'prepare:start:inspect:two','prepare:end:inspect:two','prepare:start:validate:two','prepare:end:validate:two',
  'query:revisions:two','prepare:start:publish:revision-two','prepare:end:publish:revision-two','prepare:start:rename:two','prepare:end:rename:two',
 ],'each action preparation settles in source and nested row order');
 assert.equal(requests.length,8);assert.equal(new Set(requests.map(request=>request.occurrence)).size,8);
 assert.equal((html.match(/<form /g)||[]).length,8,'all controls use actual installed canonical form renderer');
 for(const caption of ['Invoer inspecteren','Momentopname valideren','Versie publiceren','Sjabloon hernoemen'])assert.equal(html.split(caption).length-1,2);
 assert(html.includes('draft-one')&&html.includes('draft-two'),'remaining scalar input uses the native generated form body');
 assert(!html.includes('key-inspect-hidden')&&!html.includes('key-publish-published'));
 assert(html.indexOf('key-inspect-one')<html.indexOf('key-validate-one'));
 assert(html.indexOf('key-validate-one')<html.indexOf('key-publish-revision-one'));
}
const first=new Error('first-preparation');failure=first;trace=[];requests=[];
await assert.rejects(render(entry),error=>error===first);
assert.deepEqual(trace,['query:templates','prepare:start:inspect:one']);assert.equal(requests.length,1);
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
fn singular_actions_refuse_missing_foreign_scalar_and_incomplete_record_bindings() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, source) in [
        (
            "missing-row",
            format!(
                "{}Then\n page / title=\"Missing row\"\n  action inspect\n",
                SOURCE.split("Then\n").next().unwrap()
            ),
        ),
        (
            "foreign-record",
            SOURCE
                .replace(
                    "scenario inspect(template:Template)",
                    "scenario inspect(template:Revision)",
                )
                .replace(
                    "do set template {visible=true}",
                    "do set template {published=true}",
                ),
        ),
        (
            "scalar-only",
            SOURCE
                .replace(
                    "scenario inspect(template:Template)",
                    "scenario inspect(value:text)",
                )
                .replace("do set template {visible=true}", "do require value!=\"\""),
        ),
        (
            "extra-record",
            SOURCE.replace(
                "scenario inspect(template:Template)",
                "scenario inspect(template:Template,revision:Revision)",
            ),
        ),
        (
            "nullable-extra-record",
            SOURCE.replace(
                "scenario inspect(template:Template)",
                "scenario inspect(template:Template,revision:Revision?)",
            ),
        ),
        (
            "extra-header",
            SOURCE.replace("    action inspect", "    action inspect,validate"),
        ),
        (
            "body",
            SOURCE.replace(
                "    action inspect",
                "    action inspect\n     text \"unsupported child\"",
            ),
        ),
        (
            "option",
            SOURCE.replace(
                "    action inspect",
                "    action inspect arguments={template=template}",
            ),
        ),
        (
            "read-target",
            SOURCE
                .replace(
                    "scenario inspect(template:Template) by=members",
                    "scenario inspect(template:Template) read=true by=members -> text",
                )
                .replace("do set template {visible=true}", "do return template.name"),
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
