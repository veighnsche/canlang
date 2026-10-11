//! Copied inspection presentation uses installed helpers and native browser CSS.
//! Supplied query/observation snapshots exercise rendering, not receipt authority.
use std::path::Path;
use std::process::Command;

const SOURCE: &str = r#"app InspectionList
use std {ImagesV1 as Images} from=deployment.images
Given
 Template {name:text,visible:bool=true,inspection:delivery(Images.inspect)?}
 policy Template read=members
When
 scenario inspect(template:Template,graph:file) by=members
  do
   send Images.inspect {graph} as inspection
   set template {inspection}
Then
 page / title="Inspection"
  list Template as template
   list (template.inspection?.result?.fields ?? []) as inspected empty="No input fields found"@{nl="Geen invoervelden gevonden"}
    require template.visible
    pagination
    text inspected.node,inspected.key,inspected.kind,inspected.label
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
fn copied_inspection_snapshot_renders_once_with_native_pagination_and_outer_identity() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("inspection.can");
    let (output, artifact) = compile(SOURCE, &source);
    assert!(output.status.success(), "{artifact}");
    let default_rows = SOURCE
        .replace("list Template as template", "list Template")
        .replace("(template.inspection", "(row.inspection")
        .replace(" as inspected empty=", " empty=")
        .replace("inspected.", "row.")
        .replace("    require template.visible\n", "");
    let (default_output, default_artifact) =
        compile(&default_rows, &scratch.path().join("default-rows.can"));
    assert!(default_output.status.success(), "{default_artifact}");
    std::fs::write(
        scratch.path().join("default-artifact.json"),
        serde_json::to_vec(&default_artifact).unwrap(),
    )
    .unwrap();
    let contracts = artifact["valueTypes"]["contracts"].as_array().unwrap();
    let fields = contracts
        .iter()
        .find(|contract| contract["name"] == "WorkflowField")
        .unwrap();
    assert_eq!(fields["fields"].as_array().unwrap().len(), 4);
    for field in fields["fields"].as_array().unwrap() {
        assert_eq!(field["type"], "text");
    }
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
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'inspection.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const {chromium}=require('@playwright/test');
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 const row={id:'template',version:1,fields:{name:'outer template',visible:true,inspection:null}};
 let snapshot=[],observations=0,queries=0,trace=[],rows=[row],observationFailure=null;
 const context={memberships:['members'],preferredLocales:['en'],appDefaultLocale:'en',theme:{},
  path:'/',isPartial:false,csrfToken:'csrf',principal:{},invocation:{},
  canonical:{builtinRoles:['members'],observeDelivery:async(locator,selected)=>{
   observations++;assert(rows.includes(locator.record),'preserve the original stored RowView');
   if(observationFailure)throw observationFailure;
   assert.equal(locator.field,'inspection');assert.deepEqual(selected,['result.fields']);
   return {'result.fields':snapshot};
  }},
  query:async(invocation,model)=>{
   queries++;assert.equal(invocation,context.invocation);assert.equal(model,'InspectionList.Template');
   return {rows,columns:[]};
  },
 };
 const render=()=>entry.appDefinition.pages[0].render(context,{});
 for(const count of [0,1,25,26,51]) {
  trace=[];observations=0;queries=0;
  snapshot=Array.from({length:count},(_,index)=>Object.fromEntries(
   ['node','key','kind','label'].map(field=>[field,`${field}-${index}`])));
  snapshot.forEach((value,index)=>['node','key','kind','label'].forEach(field=>{
   const stored=value[field];Object.defineProperty(value,field,{get(){trace.push(`${index}:${field}`);return stored;}});
  }));
  const html=await render();
  assert.equal(observations,1);assert.equal(queries,1);
  assert.deepEqual(trace,Array.from({length:count},(_,index)=>
   ['node','key','kind','label'].map(field=>`${index}:${field}`)).flat(),
   'read children once in source order, including later presentation pages');
  await page.setContent('<form id="business">'+html+'</form>');
  const visibleRows=()=>page.evaluate(()=>[...document.querySelectorAll('li.list-row')]
   .filter(row=>!row.querySelector('li.list-row')&&/^node-\d+/.test(row.textContent.replace(/[\u2066-\u2069]/g,'').trim())&&row.getBoundingClientRect().height>0)
   .map(row=>Number(/^node-(\d+)/.exec(row.textContent.replace(/[\u2066-\u2069]/g,'').trim())[1])));
  assert.deepEqual(await visibleRows(),Array.from({length:Math.min(25,count)},(_,i)=>i),html);
  if(count>25) {
   const radios=page.locator('input[type=radio]');
   assert.equal(await radios.count(),Math.ceil(count/25));
   assert.equal(await radios.evaluateAll(inputs=>inputs.every(input=>input.form===null)),true,'presentation radios never enter business form inputs');
   assert.equal(await page.getByRole('radio',{name:'Page 2',exact:true}).count(),1);
   assert.equal(await radios.nth(0).getAttribute('aria-controls'),await page.locator('[data-can-inspection-page]').nth(0).getAttribute('id'));
   for(let selected=1;selected<Math.ceil(count/25);selected++) {
    const id=await radios.nth(selected).getAttribute('id');assert(id);
    await page.locator(`label[for="${id}"]`).first().click();
    assert.deepEqual(await visibleRows(),Array.from({length:Math.min(25,count-selected*25)},(_,i)=>selected*25+i));
    assert.equal(observations,1,'presentation changes never read the receipt again');
   }
   if(count===51){await radios.nth(2).focus();await radios.nth(2).press('ArrowLeft');assert.deepEqual(await visibleRows(),Array.from({length:25},(_,i)=>25+i));}
  }
 }
 // Distinct original outer rows own distinct selection groups.
 snapshot=Array.from({length:26},(_,i)=>({node:`node-${i}`,key:'k',kind:'text',label:'l'}));
 rows=[row,{id:'template-two',version:1,fields:{...row.fields}}];
 observations=0;let multiple=await render();assert.equal(observations,2);
 await page.setContent(multiple);
 const sets=page.locator('fieldset');assert.equal(await sets.count(),2);
 assert.notEqual(await sets.nth(0).getAttribute('id'),await sets.nth(1).getAttribute('id'));
 const secondRadio=sets.nth(0).locator('input[type=radio]').nth(1);
 await page.locator(`label[for="${await secondRadio.getAttribute('id')}"]`).click();
 assert.equal(await sets.nth(0).locator('[data-can-inspection-page]').nth(0).isVisible(),false);
 assert.equal(await sets.nth(0).locator('[data-can-inspection-page]').nth(1).isVisible(),true);
 assert.equal(await sets.nth(1).locator('[data-can-inspection-page]').nth(0).isVisible(),true);
 assert.equal(observations,2,'independent paging never observes again');
 rows=[row];context.preferredLocales=['nl'];
 const translatedPages=await render();assert(translatedPages.includes('Pagina 2'));
 snapshot=null;observations=0;
 let html=await render();assert.equal(observations,1);assert(html.includes('Geen invoervelden gevonden'));
 snapshot=[{node:'<script>',key:'&',kind:'text',label:'"unsafe"'}];
 html=await render();assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));
 row.fields.visible=false;observations=0;trace=[];
 snapshot=[Object.defineProperty({},'node',{get(){throw Error('gated child evaluated');}})];
 html=await render();assert.equal(observations,0,'the original list gate precedes source observation');
 assert(!html.includes('node-'));assert.deepEqual(trace,[]);
 row.fields.visible=true;context.preferredLocales=['en'];
 const first=new Error('first-field');trace=[];
 snapshot=[Object.defineProperties({key:'k',kind:'text',label:'l'},{
  node:{get(){trace.push('first');throw first;}},key:{get(){trace.push('later');return 'k';}},
 })];
 await assert.rejects(render,error=>error===first);assert.deepEqual(trace,['first']);
 observationFailure=new Error('first-observation');
 await assert.rejects(render,error=>error===observationFailure);observationFailure=null;
 const defaultArtifact=JSON.parse(readFileSync(resolve(base,'default-artifact.json'),'utf8'));
 const defaultAssembly=await assembleModules({artifact:defaultArtifact,sourcePath:resolve(base,'default-rows.can')},{
  workDir:resolve(base,'default-modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
  uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
 });
 const defaultEntry=await importVerifiedAssemblyModule(defaultAssembly,defaultArtifact.modules[0].path,defaultArtifact);
 snapshot=[{node:'default-node',key:'k',kind:'text',label:'l'}];observations=0;
 assert((await defaultEntry.appDefinition.pages[0].render(context,{})).includes('default-node'));
 assert.equal(observations,1,'inner default row shadow retains actual original outer RowView');
 await page.close();
} finally {await browser.close();}
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
fn inspection_copy_refuses_invalid_pagination_mutation_and_foreign_sources() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, source) in [
        (
            "duplicate",
            SOURCE.replace("    pagination\n", "    pagination\n    pagination\n"),
        ),
        (
            "nested",
            SOURCE.replace("    pagination\n", "    alert\n     pagination\n"),
        ),
        (
            "payload",
            SOURCE.replace("    pagination\n", "    pagination \"extra\"\n"),
        ),
        (
            "mutation",
            SOURCE.replace("    pagination\n", "    action inspect\n"),
        ),
        (
            "foreign",
            SOURCE.replace(
                "(template.inspection?.result?.fields ?? [])",
                "[{node=\"n\",key=\"k\",kind=\"text\",label=\"l\"}]",
            ),
        ),
        (
            "clause",
            SOURCE.replace("as inspected empty=", "as inspected order=node empty="),
        ),
    ] {
        let (output, response) = compile(&source, &scratch.path().join(format!("{name}.can")));
        assert!(!output.status.success(), "{name}: {response}");
        assert!(response.get("modules").is_none(), "{name}: {response}");
        assert!(
            !response["diagnostics"].as_array().unwrap().is_empty(),
            "{name}: {response}"
        );
    }
}

#[test]
fn inspection_list_rejects_changed_original_ir_and_owner_closure() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::codegen::{ir, js};
    use canlang_compiler::source::{SourceDb, Span};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let file = db.add("inspection.can".into(), SOURCE.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (original, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        original.modules[0].pages[0].render[0].children[0].factory,
        "inspectionValueList"
    );
    for change in ["source", "marker", "children", "owner"] {
        let mut altered = original.clone();
        let list = &mut altered.modules[0].pages[0].render[0].children[0];
        match change {
            "source" => list.props[0].1.expr = ir::IrExpr::Array(vec![]),
            "marker" => {
                list.props
                    .iter_mut()
                    .find(|(name, _)| name == "page")
                    .unwrap()
                    .1
                    .expr = ir::IrExpr::Bool(false)
            }
            "children" => list.children.clear(),
            "owner" => altered.read_rules[0].id.push_str(".altered"),
            _ => unreachable!(),
        }
        let emitted = js::emit_program(&altered);
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("original checked readonly")),
            "{change}: {:?}",
            emitted.diagnostics
        );
    }
}
