//! Original Creative gallery source reaches the installed collection consumer
//! and the genuine full/partial dispatcher image resolver. Supplied current
//! RowViews and protected image views qualify presentation only: real PNG/JPEG
//! serving, current native File grants and application acceptance are Dev-owned.
use std::path::Path;
use std::process::Command;

const SOURCE: &str = r#"app CreativeGallery uses=[chat,creative]
package chat
 Given
  export Conversation { title:text trim max=200, account:user server=actor, active:bool=true } label="Conversation"@{nl="Gesprek"}
 When
 Then
package creative
 use chat {Conversation}
 use std {WorkflowInput,WorkflowDefinition,WorkflowInspection,WorkflowValidation,ImageRequest,ImageRun,GeneratedImage,DeliveryResult}
 use std {ImagesV1 as Images} from=deployment.images
 Given
  role creative_manager label="Creative administrator"@{nl="Creatief beheerder"}
  Template { name:text trim max=200, owner:user server=actor, graph:file, prompt_node:text="6", prompt_key:text="text", negative_node:text="7", negative_key:text="text", width_node:text="5", width_key:text="width", height_node:text="5", height_key:text="height", outputs:int=1 min=1 max=4, duration:duration=120s, active:bool=true, current:Revision?, inspection:delivery(Images.inspect)? } label="Image workflow"@{nl="Beeldworkflow"}
  Revision in Template { number:int min=1, definition:WorkflowDefinition, outputs:int min=1 max=4, duration:duration, validation:delivery(Images.validate)?, published:bool=false, digest:text? } label="Immutable workflow revision"@{nl="Onveranderlijke workflowversie"}
  Budget { account:user unique, cap:int min=1, parallel:int=2 min=1 max=10, spent:int=0 min=0, held:int=0 min=0, running:int=0 min=0 max=10, active:bool=true } label="Image-job allowance"@{nl="Budget voor beeldtaken"}
  export Run { source:text unique, author:user server=actor, conversation:Conversation?, revision:Revision, budget:Budget, prompt:ImageRequest.prompt, negative:ImageRequest.negative, width:ImageRequest.width, height:ImageRequest.height, request:delivery(Images.submit)?, cancellation:delivery(Images.cancel)?, reconciliation:delivery(Images.reconcile)?, used:int? min=0 max=1, unfinished:bool=true, stop_requested:bool=false } label="Image generation"@{nl="Beeldgeneratie"}
  export Output in Run { position:int min=0 max=3, image:file } label="Finalized image"@{nl="Afgerond beeldbestand"}
  policy Run read=members
  policy Output read=members
  policy Template read=members
 When
 Then
  page /images title="Images"@{nl="Beelden"}
   require members
   list Run as run order=-created
    gallery row.Output image=image order=position empty="No images yet"@{nl="Nog geen beelden"}
     pagination
  page /behavior title="Gallery behavior"
   require members
   list Run as run order=-created
    gallery row.Output as output where output.position>=0 image=image order=position empty="No images yet"@{nl="Nog geen beelden"}
     require run.unfinished
     text "Before image fields"
     count label="Images"@{nl="Beelden"}
     pagination
     text run.source,row.position
     text "After image body"
    text "After images"
  page /search title="Search gallery"
   require members
   gallery Template image=graph order=name search=name
    count label="Templates"@{nl="Sjablonen"}
    pagination
    text row.name
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
fn original_gallery_uses_original_rows_and_trusted_resolver_on_full_and_partial_requests() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("gallery.can");
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
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=process.argv[2],base=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(root,'package.json'));
const load=name=>import(pathToFileURL(require.resolve(name)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {createTestDeps,testRequest}=await load('@canlang/interfaces/testing');
const {collectionCursorName}=await load('@canlang/contracts');
const {makeFileValue}=await load('@canlang/values');
const {handlePageRequest}=await import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/pages.js')));
const {buildPresentationContext,buildPageSourceContext}=await import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/presentation.js')));
const installedUI=pathToFileURL(require.resolve('@canlang/ui')).href;
const observedUI=resolve(base,'observed-ui.mjs');
writeFileSync(observedUI,`import * as nativeUI from ${JSON.stringify(installedUI)};
export * from ${JSON.stringify(installedUI)};
export async function gallery(props){globalThis.galleryProbe.props(props);
 const renderRow=props.renderRow;
 return nativeUI.gallery(renderRow===undefined?props:{...props,renderRow:async(row,context)=>{
  globalThis.galleryProbe.body(row,context);const children=await renderRow(row,context);
  globalThis.galleryProbe.end(children);return children;
 }});
}
export async function text(props){globalThis.galleryProbe.text(props);return nativeUI.text(props);}
`);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'gallery.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(observedUI).href,
});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const runs=[
 {id:'run-one',version:'7',fields:{source:'First <&> job',unfinished:true}},
 {id:'run-two',version:'9',fields:{source:'Second job',unfinished:true}},
];
// Repeated files are resolved separately in the original current row context;
// the producer must never collapse rows into a file-ID-derived gallery.
const sharedFile=makeFileValue('private-file-identity');
const outputs=[
 {id:'output-one',version:'11',fields:{parent:runs[0],position:0,image:sharedFile}},
 {id:'output-two',version:'13',fields:{parent:runs[0],position:1,image:sharedFile}},
 {id:'output-three',version:'17',fields:{parent:runs[1],position:0,image:makeFileValue('private-other-file')}},
];
const templates=[{id:'template-one',version:'19',fields:{name:'Own template <&>',graph:sharedFile}}];
const originalRecords=[...outputs,...templates];
let current=null,lastPrincipal=null,context=null,scopes=0,closes=0,trace=[],props=[],queries=[],locators=[],bodies=[];
let returnedRuns=runs,returnedOutputs=outputs,withheld=new Set(),failResolver=null,failQuery=null,
 missingResolver=false,wrongColumn=false,missingImage=false,invalidImageView=false,
 failFirstText=false,failPosition=null,unusedReads=0;
// A supplied enumerable getter is not a request to read the field. Both the
// explicit Output alias and default Template row scope must preserve it.
for(const row of originalRecords)Object.defineProperty(row.fields,'unused',{
 enumerable:true,get(){unusedReads++;throw new Error('unused-field');},
});
for(const row of outputs){
 const position=row.fields.position;
 Object.defineProperty(row.fields,'position',{enumerable:true,get(){
  trace.push('read-position:'+row.id);
  if(failPosition===row.id)throw new Error('position-first');
  return position;
 }});
}
globalThis.galleryProbe={
 props(actual){assert.equal(actual.context,context);assert(['creative.Output','creative.Template'].includes(actual.model));
  assert.equal(actual.image,actual.model==='creative.Output'?'image':'graph');assert.equal(typeof actual.occurrence,'string');
  assert(actual.occurrence.startsWith('can-collection-'));assert(!Object.hasOwn(actual,'columns'));
  assert(!Object.hasOwn(actual,'display'));assert(!Object.hasOwn(actual,'previewUrl'));
  props.push(actual);
 },
 body(row,actual){assert.equal(actual,context);assert(originalRecords.includes(row));
  assert.equal(row.version,originalRecords.find(original=>original.id===row.id).version);
  trace.push('body:'+row.id);bodies.push(row);
 },
 end(children){assert(Array.isArray(children));assert(children.every(child=>child==null||typeof child==='string'));},
 text(actual){if(actual.values.includes('Before image fields')){
   trace.push('before-fields');if(failFirstText)throw new Error('before-fields-first');
  }
  if(actual.values.includes('After images'))trace.push('after-images');
  if(actual.values.includes('After image body'))trace.push('after-body');},
};
const descriptors=entry.appDefinition.pages.map(page=>({...page,render:async(actual,bindings)=>{
 context=actual;assert.equal(actual.principal,current);assert.equal(Object.hasOwn(actual,'close'),false);
 const html=await page.render(actual,bindings);trace.push('render-done');return html;
}}));
const {deps,identity}=await createTestDeps({descriptors});
const configured={...deps,app:{...deps.app,ownerLabels:new Map([['creative','Creative'],['CreativeGallery','Creative']])},
 createReadScope:(principal,source)=>{
  current=principal;lastPrincipal=principal;scopes++;assert(source.canonical.builtinRoles.includes('members'));
  const scope={
   query:async function(invocation,model,args){assert.equal(this,scope);assert.equal(invocation,current);
    queries.push({model,args});trace.push('query:'+model+(args.parent?':'+args.parent.id:''));
    if(model==='creative.Run')return {rows:returnedRuns,columns:[]};
    if(model==='creative.Template'){
     assert.equal(Object.hasOwn(args,'parent'),false);assert.deepEqual(args.order,['name']);
     assert.equal(args.page,true);assert.equal(args.occurrence,props.at(-1).occurrence);
     return {rows:templates,columns:[{field:'graph',type:'file',label:'Workflow graph'}],totalCount:templates.length};
    }
    assert.equal(model,'creative.Output');assert(runs.some(row=>row.id===args.parent.id));
    assert.equal(args.parent.version,BigInt(runs.find(row=>row.id===args.parent.id).version));
    assert.deepEqual(args.order,['position']);assert.equal(args.page,true);assert.equal(args.occurrence,props.at(-1).occurrence);
    if(failQuery)throw failQuery;
    const currentRows=returnedOutputs.filter(row=>row.fields.parent.id===args.parent.id);
    const rows=args.cursor===undefined?currentRows:currentRows.slice(1);
    if(args.cursor!==undefined)assert.equal(args.cursor,'next-page');
    return {rows:missingImage?rows.map(row=>({...row,fields:{parent:row.fields.parent,position:row.fields.position}})):rows,
     columns:wrongColumn?[{field:'image',type:'text',label:'Image'}]:[{field:'image',type:'file',label:'Image'}],
     emptyDeclarations:[{field:'image',type:'file',label:'Image'}],totalCount:currentRows.length,
     nextCursor:rows.length&&args.cursor===undefined?'next-page':undefined};
   },
   close:async function(){assert.equal(this,scope);closes++;trace.push('scope-close');},
  };
  if(!missingResolver)scope.resolveFileImage=async function(locator){
   assert.equal(this,scope,'dispatcher binds the original read-scope receiver');
   const field=locator.model==='creative.Output'?'image':'graph';
   assert(['creative.Output','creative.Template'].includes(locator.model));assert.equal(locator.field,field);
   assert((locator.model==='creative.Output'?returnedOutputs:templates).includes(locator.record),
    'resolver consumes the exact currently admitted original RowView');
   assert.equal(locator.record.fields[field],originalRecords.find(row=>row.id===locator.record.id).fields[field]);
   locators.push(locator);trace.push('resolve:start:'+locator.record.id);await Promise.resolve();
   if(failResolver&&locator.record.id===failResolver)throw new Error('resolve-first');
   trace.push('resolve:end:'+locator.record.id);
   if(withheld.has(locator.record.id))return null;
   if(invalidImageView)return {previewUrl:'https://foreign.invalid/image',originalUrl:'/protected-original'};
   // These are supplied trusted host resolver views. The compiler neither
   // derives them from File IDs nor claims their native serving/grant policy.
   return {previewUrl:'/admitted-preview/'+locator.record.id+'?v='+locator.record.version+'&s=own',
    originalUrl:'/admitted-original/'+locator.record.id+'?v='+locator.record.version+'&s=own'};
  };
  return scope;
 },
};
const reset=()=>{current=null;context=null;trace=[];props=[];queries=[];locators=[];bodies=[];};
for(const partial of [false,true]){
 const request=(path,authenticated=true)=>{
  const url=new URL(path,'https://can.test');
  if(!url.searchParams.has('team'))url.searchParams.set('team',identity.teamId);
  if(!url.searchParams.has('q'))url.searchParams.set('q','keep <&>');
  if(!url.searchParams.has('can-row:sibling'))url.searchParams.set('can-row:sibling','other');
  if(!url.searchParams.has('can-cursor:foreign'))url.searchParams.set('can-cursor:foreign','other-cursor');
  return testRequest(url.pathname+url.search,{
   ...(authenticated?{cookie:identity.cookie}:{}),headers:{'accept-language':'nl',...(partial?{'HX-Request':'true'}:{})},
  });
 };
 const dispatch=async(path='/images')=>{reset();const beforeCloses=closes;
  const response=await handlePageRequest(configured,request(path));const html=await response.text();
  assert.equal(response.status,200,html);assert.equal(closes,beforeCloses+1);assert.equal(context.isPartial,partial);return html;
 };
 let html=await dispatch();
 assert.deepEqual(locators.map(locator=>locator.record),outputs);assert.deepEqual(bodies,[]);
 assert.equal(props.length,2);assert.notEqual(props[0].occurrence,props[1].occurrence);
 const stable=props.map(prop=>prop.occurrence);
 const nextLinks=[...html.matchAll(/<a rel="next" href="([^"]+)"/g)]
  .map(match=>new URL(match[1].replaceAll('&amp;','&'),'https://can.test'));
 assert.equal(nextLinks.length,2);
 for(const [index,url]of nextLinks.entries()){
  assert.equal(url.pathname,'/images');assert.equal(url.searchParams.get('team'),identity.teamId);
  assert.equal(url.searchParams.get('q'),'keep <&>');assert.equal(url.searchParams.get('can-row:sibling'),'other');
  assert.equal(url.searchParams.get('can-cursor:foreign'),'other-cursor');
  assert.equal(url.searchParams.get(collectionCursorName(stable[index])),'next-page');
  assert.equal(url.searchParams.has(collectionCursorName(stable[1-index])),false);
 }
 assert(html.includes('data-can-preview-url="/admitted-preview/output-one?v=11&amp;s=own"'));
 assert(html.includes('data-can-gallery-original href="/admitted-original/output-two?v=13&amp;s=own"'));
 assert(html.includes('Afbeelding bekijken')&&html.includes('Origineel openen')&&html.includes('Voorbeeld sluiten'));
 assert(html.includes('data-cursor="next-page"')&&html.includes('Meer rijen beschikbaar.'),
  'gallery continuation retains the actual dispatched locale context');
 assert(!html.includes('private-file-identity')&&!html.includes('private-other-file'));
 assert.equal((html.match(/data-can-gallery-dialog/g)||[]).length,2);
 const ids=[...html.matchAll(/ id="(can-gallery-[^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(ids).size,2);
 assert.equal(trace.at(-2),'render-done');assert.equal(trace.at(-1),'scope-close');
 html=await dispatch(nextLinks[0].pathname+nextLinks[0].search);
 assert.deepEqual(props.map(prop=>prop.occurrence),stable);
 assert.deepEqual(locators.map(locator=>locator.record),[outputs[1],outputs[2]]);
 const continued=queries.filter(query=>query.model==='creative.Output');
 assert.equal(continued[0].args.cursor,'next-page');assert.equal(Object.hasOwn(continued[1].args,'cursor'),false,
  'cursor belongs only to the actual authored collection occurrence');
 assert(!html.includes('/admitted-preview/output-one'));
 for(const duplicate of [false,true]){
  const url=new URL(nextLinks[0]);const key=collectionCursorName(stable[0]);
  if(duplicate)url.searchParams.append(key,'other');else url.searchParams.set(key,'');
  reset();const beforeCloses=closes,response=await handlePageRequest(configured,request(url.pathname+url.search));
  assert.equal(response.status,422);assert.equal((await response.json()).code,'rule_failed');
  assert.equal(closes,beforeCloses+1);assert.deepEqual(locators,[]);assert.deepEqual(bodies,[]);
  assert.equal(queries.length,1,'invalid cursor fails before the collection query');
 }
 html=await dispatch();assert.deepEqual(props.map(prop=>prop.occurrence),stable,'unchanged source occurrence is stable');
 withheld=new Set(['output-two']);html=await dispatch('/behavior');
 assert.deepEqual(bodies,outputs);assert(html.includes('Afbeelding niet beschikbaar'));
 assert(!html.includes('/admitted-preview/output-two'));assert(html.includes('First &lt;&amp;&gt; job'));
 assert(html.includes('Beelden: 2')&&html.includes('Beelden: 1'));
 for(const {model,args} of queries.filter(query=>query.model==='creative.Output')){
  assert.equal(model,'creative.Output');assert.equal(args.limit,25);assert.equal(Object.hasOwn(args,'cursor'),false);
  assert.equal(Object.hasOwn(args,'search'),false);assert.equal(args.includeCount,true);
  assert.equal(typeof args.where,'function');
 }
 assert(trace.indexOf('resolve:end:output-two')<trace.indexOf('body:output-one'));
 assert(trace.indexOf('body:output-one')<trace.indexOf('body:output-two'));
 assert(trace.indexOf('body:output-two')<trace.indexOf('after-images'));
 assert(trace.indexOf('after-images')<trace.indexOf('resolve:start:output-three'));
 for(const row of outputs){
  const body=trace.indexOf('body:'+row.id),read=trace.indexOf('read-position:'+row.id);
  assert(body<trace.indexOf('before-fields',body)&&trace.indexOf('before-fields',body)<read,
   'field access follows the earlier authored child');
  assert.equal(trace.filter(event=>event==='read-position:'+row.id).length,1);
 }
 assert.equal(unusedReads,0,'gallery exposure never evaluates unused enumerable getters');
 html=await dispatch('/search');assert.deepEqual(bodies,templates);
 assert.deepEqual(locators.map(locator=>locator.record),templates);assert(html.includes('Own template &lt;&amp;&gt;'));
 assert(html.includes('Sjablonen: 1')&&html.includes('method="get"')&&html.includes('value="keep &lt;&amp;&gt;"'));
 assert.deepEqual(queries[0].args.search,{fields:['name'],query:'keep <&>'});assert.equal(queries[0].args.includeCount,true);
 assert.equal(queries[0].args.limit,25);
 assert.equal(unusedReads,0,'default gallery row scope preserves unused getters too');
 for(const failure of ['first-text','position']){
  reset();failFirstText=failure==='first-text';failPosition=failure==='position'?'output-one':null;
  const beforeCloses=closes,response=await handlePageRequest(configured,request('/behavior'));
  assert.equal(response.status,422,failure);assert.equal((await response.json()).code,'rule_failed');
  assert.equal(closes,beforeCloses+1);assert.deepEqual(bodies,[outputs[0]]);
  assert.deepEqual(locators.map(locator=>locator.record),outputs.slice(0,2));
  assert(trace.includes('before-fields'));assert(!trace.includes('after-body'));
  assert(!trace.includes('after-images'));assert(!trace.includes('body:output-two'));
  const reads=trace.filter(event=>event.startsWith('read-position:'));
  assert.deepEqual(reads,failure==='first-text'?[]:['read-position:output-one']);
  if(failure==='position')assert(trace.indexOf('before-fields')<trace.indexOf('read-position:output-one'));
  assert.equal(unusedReads,0,'first authored failure wins before any unused getter');
  failFirstText=false;failPosition=null;
 }
 withheld=new Set();runs[0].fields.unfinished=false;html=await dispatch('/behavior');
 assert.equal(props.length,1);assert.deepEqual(locators.map(locator=>locator.record),[outputs[2]]);assert.deepEqual(bodies,[outputs[2]]);
 runs[0].fields.unfinished=true;
 // A stale/non-current output is simply absent from the admitted query result.
 returnedOutputs=[outputs[2]];html=await dispatch();assert.deepEqual(locators.map(locator=>locator.record),[outputs[2]]);
 assert(html.includes('Nog geen beelden'));assert(!html.includes('/admitted-preview/output-one'));returnedOutputs=outputs;
 for(const variant of ['resolver-failure','query-failure','missing-resolver','wrong-column','missing-image','foreign-image-view']){
  reset();failResolver=variant==='resolver-failure'?'output-two':null;failQuery=variant==='query-failure'?new Error('query-first'):null;
  missingResolver=variant==='missing-resolver';wrongColumn=variant==='wrong-column';missingImage=variant==='missing-image';invalidImageView=variant==='foreign-image-view';
  const beforeCloses=closes,response=await handlePageRequest(configured,request('/behavior'));
  assert.equal(response.status,422,variant);assert.equal((await response.json()).code,'rule_failed');assert.equal(closes,beforeCloses+1);
  assert.deepEqual(bodies,[]);assert(!trace.includes('after-images'),'first resolver/query failure suppresses later authored siblings');
  if(variant==='resolver-failure')assert.deepEqual(locators.map(locator=>locator.record),outputs.slice(0,2));
  if(['missing-resolver','wrong-column','query-failure','missing-image'].includes(variant))assert.deepEqual(locators,[]);
  failResolver=null;failQuery=null;missingResolver=false;wrongColumn=false;missingImage=false;invalidImageView=false;
 }
 reset();const beforeScopes=scopes,response=await handlePageRequest(configured,request('/images',false));
 assert.equal(response.status,403);assert.equal(scopes,beforeScopes);assert.deepEqual(trace,[]);assert.deepEqual(props,[]);
 assert.deepEqual(deps.invoker.mutations,[]);
}
// Source extras may not supply or spoof the dispatcher-owned image resolver.
let spoofCalls=0;
const absent=buildPresentationContext({request:testRequest('/images'),pathname:'/images',isPartial:true,
 appDefaultLocale:'en',csrfToken:'',principal:lastPrincipal,source:{...buildPageSourceContext(lastPrincipal),
  resolveFileImage:async()=>{spoofCalls++;return null;}},
 query:async()=>({rows:[],columns:[]})});assert.equal(Object.hasOwn(absent,'resolveFileImage'),false);
assert.equal(spoofCalls,0);
delete globalThis.galleryProbe;
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
fn gallery_source_refuses_nonowning_nonsingular_images_slots_and_unconsumed_options() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, source) in [
        ("missing-image", SOURCE.replace(" image=image", "")),
        (
            "duplicate-image",
            SOURCE.replace("image=image", "image=image image=image"),
        ),
        (
            "two-images",
            SOURCE.replace("image=image", "image=image,position"),
        ),
        (
            "foreign-image",
            SOURCE.replace("image=image", "image=Template.graph"),
        ),
        (
            "scalar-image",
            SOURCE.replace("image=image", "image=position"),
        ),
        (
            "nullable-image",
            SOURCE.replace(
                "position:int min=0 max=3, image:file",
                "position:int min=0 max=3, image:file?",
            ),
        ),
        (
            "array-image",
            SOURCE.replace(
                "position:int min=0 max=3, image:file",
                "position:int min=0 max=3, image:file[]",
            ),
        ),
        (
            "display",
            SOURCE.replace("image=image", "image=image display=split"),
        ),
        (
            "columns",
            SOURCE.replace("image=image", "image=image columns=position"),
        ),
        (
            "limit",
            SOURCE.replace("image=image", "image=image limit=2"),
        ),
        (
            "nontext-search",
            SOURCE.replace("image=image", "image=image search=position"),
        ),
        (
            "cursor",
            SOURCE.replace("image=image", "image=image cursor=\"forged\""),
        ),
        (
            "filter",
            SOURCE.replace("image=image", "image=image filter=missing"),
        ),
        (
            "defaults",
            SOURCE.replace("image=image", "image=image defaults={missing=0}"),
        ),
        (
            "slot",
            SOURCE.replace(
                "     text run.source,row.position",
                "     slot content\n      text row.position",
            ),
        ),
        (
            "pagination-body",
            SOURCE.replace("     pagination", "     pagination\n      text \"Invalid\""),
        ),
    ] {
        let (output, response) = compile(&source, &scratch.path().join(format!("{name}.can")));
        assert!(
            !output.status.success(),
            "{name} unexpectedly accepted: {response}"
        );
        assert!(
            response["diagnostics"]
                .as_array()
                .is_some_and(|diags| diags.iter().any(|diag| diag["severity"] == "error")),
            "{name}: {response}"
        );
    }
}

#[test]
fn edited_gallery_ir_cannot_substitute_unowned_image_or_url_carriers() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::analysis::types::{ResolvedType, Scalar};
    use canlang_compiler::codegen::ir::{self, IrExpr, TypedExpr};
    use canlang_compiler::codegen::js::Emitter;
    use canlang_compiler::source::{SourceDb, Span};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let id = db.add("gallery.can".into(), SOURCE.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(
        !diagnostics
            .iter()
            .any(|diag| diag.severity == canlang_compiler::diagnostic::Severity::Error),
        "{diagnostics:?}"
    );
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let gallery = program
        .modules
        .iter()
        .find(|module| module.name == "creative")
        .unwrap()
        .pages
        .iter()
        .find(|page| page.path == "/behavior")
        .unwrap()
        .render[0]
        .children[0]
        .clone();
    for variant in [
        "image",
        "model",
        "missing",
        "duplicate",
        "row-scope",
        "url",
        "display",
    ] {
        let mut node = gallery.clone();
        match variant {
            "image" | "model" => {
                node.props
                    .iter_mut()
                    .find(|(key, _)| key == variant)
                    .unwrap()
                    .1
                    .expr = IrExpr::Text(
                    if variant == "image" {
                        "position"
                    } else {
                        "creative.Template"
                    }
                    .into(),
                )
            }
            "missing" => node.props.retain(|(key, _)| key != "image"),
            "duplicate" => node.props.push(
                node.props
                    .iter()
                    .find(|(key, _)| key == "image")
                    .unwrap()
                    .clone(),
            ),
            "row-scope" => node.row_scope = None,
            "url" | "display" => node.props.push((
                if variant == "url" {
                    "previewUrl"
                } else {
                    "display"
                }
                .into(),
                TypedExpr::new(
                    IrExpr::Text("forged".into()),
                    ResolvedType::Scalar(Scalar::Text),
                    node.span,
                ),
            )),
            _ => unreachable!(),
        }
        let mut emitter = Emitter::new(&program);
        let _ = emitter.lower_ui(&node);
        let (diagnostics, _, _, _) = emitter.finish();
        assert!(
            diagnostics
                .iter()
                .any(|diag| diag.code == "E6008" && diag.message.contains("gallery")),
            "{variant}: {diagnostics:?}"
        );
    }
}
