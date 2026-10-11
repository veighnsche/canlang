//! Original CanChat nested drawer profiles use real full/partial page dispatch,
//! verified generated assembly and the released installed UI. Supplied queried
//! RowViews qualify presentation producers, not native grants or application
//! acceptance. The UI interception delegates unchanged to the installed factory
//! and observes only original record/context and lazy body calls.
use std::path::Path;
use std::process::Command;

const SOURCE: &str = r#"app ChatDrawers uses=[chat]
package chat
 use std {TextMessage,TextRequest,TextRun,DeliveryResult}
 use std {TextGenerationV1 as LLM} from=deployment.llm
 Given
  role ai_manager label="AI administrator"@{nl="AI-beheerder"}
  Profile { name:text trim, provider_key:text, policy_revision:text, system_prompt:text max=8192, input_tokens:int=8192 min=1 max=32768, output_tokens:int=2048 min=1 max=8192, duration:duration=120s, active:bool=true } label="Model profile"@{nl="Modelprofiel"}
  Allowance { account:user unique, cap:int min=1, parallel:int=2 min=1 max=10, spent:int=0 min=0, held:int=0 min=0, running:int=0 min=0 max=10, active:bool=true } label="Token allowance"@{nl="Tokenbudget"}
  export Conversation { title:text trim max=200, account:user server=actor, active:bool=true } label="Conversation"@{nl="Gesprek"}
  export Branch in Conversation { title:text trim max=200, profile:Profile, prefix:TextMessage[] max=120, origin:Turn? } label="Branch"@{nl="Vertakking"}
  export Turn in Branch { position:int min=1, role:TextMessage.role label={text="Speaker"@{nl="Spreker"},values={user="You"@{nl="Jij"},assistant="Assistant"@{nl="Assistent"}}}, content:text max=65536, attachments:file[] max=8, run:Run } label="Message"@{nl="Bericht"}
  Run in Branch { account:user, allowance:Allowance, request_value:TextRequest, reserved:int min=1, request:delivery(LLM.generate)?, cancellation:delivery(LLM.cancel)?, reconciliation:delivery(LLM.reconcile)?, used:int? min=0, unfinished:bool=true, stop_requested:bool=false } label="Reply generation"@{nl="Antwoordgeneratie"}
  policy Conversation read=members
  policy Branch read=members
 When
  scenario revoke(conversation:Conversation) by=members label="Revoke conversation"@{nl="Gesprek intrekken"}
   require conversation.account==actor and conversation.active
   do
    set conversation {active=false}
  scenario inspect(branch:Branch,conversation:Conversation) by=members
   require branch.parent==conversation
   do
    set branch {title=branch.title}
 Then
  page /chat title="Conversations"@{nl="Gesprekken"}
   require members
   list Conversation as conversation where conversation.active order=-updated empty="No conversations yet"@{nl="Nog geen gesprekken"}
    pagination
    title row.title
    details "Open conversation"@{nl="Gesprek openen"} display=drawer
     form revoke arguments={conversation=row}
     text row.active
     list row.Branch order=created empty="No branches yet"@{nl="Nog geen vertakkingen"}
      pagination
      title row.title
      details "Open branch"@{nl="Vertakking openen"} display=drawer
       divider "Earlier messages"@{nl="Eerdere berichten"}
       list row.prefix empty="No earlier messages"@{nl="Geen eerdere berichten"}
        pagination
        chat_bubble
         slot header
          text row.role
         slot content
          content row.content
          text row.attachments
       text conversation.id,row.id
       form inspect arguments={branch=row,conversation=conversation}
       text "After inspected branch"
  page /gated title="Gated drawer"
   require members
   list Conversation as conversation
    title row.title
    details "Gated" display=drawer
     require row.active
     text row.title
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
fn original_nested_drawers_remain_lazy_on_real_full_and_partial_dispatch() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("drawers.can");
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
const {catalogFromArtifactOperations}=await load('@canlang/interfaces/http/operations');
const internals=name=>import(pathToFileURL(resolve(root,'packages/interfaces/dist/src/http/'+name+'.js')));
const {handlePageRequest}=await internals('pages');
const {createSourceFormBindings}=await internals('form-binding');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const installedUI=pathToFileURL(require.resolve('@canlang/ui')).href;
const observedUI=resolve(base,'observed-ui.mjs');
writeFileSync(observedUI,`import * as nativeUI from ${JSON.stringify(installedUI)};
export * from ${JSON.stringify(installedUI)};
export async function detailsDrawer(props){
 globalThis.drawerProbe.props(props);
 return nativeUI.detailsDrawer({...props,renderBody:async(record,context)=>{
  globalThis.drawerProbe.start(props,record,context);
  const children=await props.renderBody(record,context);
  globalThis.drawerProbe.end(props,record,context,children);return children;
 }});
}`);
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'drawers.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(observedUI).href,
});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const catalog=catalogFromArtifactOperations(artifact);
let context=null,props=[],bodies=[],trace=[],branchQueries=[],formRequests=[],failPrepare=null,failQuery=null;
const conversations=[
 {id:'conversation-one',version:'7',fields:{title:'First <&>',account:{id:'actor-one'}}},
 {id:'conversation-two',version:'9',fields:{title:'Second',account:{id:'actor-two'}}},
];
for(const row of conversations)Object.defineProperty(row.fields,'active',{enumerable:true,get(){trace.push('active:'+row.id);return true;}});
const branches=[
 {id:'branch-one',version:'11',fields:{title:'First branch',parent:conversations[1],profile:{id:'profile-one'}}},
 {id:'branch-two',version:'13',fields:{title:'Second branch',parent:conversations[1],profile:{id:'profile-two'}}},
];
for(const row of branches)Object.defineProperty(row.fields,'prefix',{enumerable:true,get(){
 assert.equal(this,row.fields,'copied transcript reads the exact original activated field container');
 trace.push('prefix:'+row.id);return [{role:'user',content:'Private <&> '+row.id,attachments:[]}];
}});
let returned=conversations,returnedBranches=branches;
globalThis.drawerProbe={
 props(actual){
  assert.equal(actual.context,context,'factory receives actual dispatched context');
  assert([...returned,...returnedBranches].includes(actual.record),'factory receives original queried RowView');
  assert.equal(Object.hasOwn(actual,'children'),false,'body is deferred');
  assert.equal(Object.hasOwn(actual,'open'),false);props.push(actual);
 },
 start(actual,record,actualContext){
  assert.equal(record,actual.record);assert.equal(actualContext,context);
  assert.equal(record.version,actual.record.version);bodies.push(record);trace.push('body:start:'+record.id);
 },
 end(actual,record,actualContext,children){
  assert.equal(record,actual.record);assert.equal(actualContext,context);
  assert(Array.isArray(children));assert(children.every(child=>child==null||typeof child==='string'),
   'source children settle sequentially before UI receives the body array');
  trace.push('body:end:'+record.id);
 },
};
const descriptors=entry.appDefinition.pages.map(page=>({...page,render:async(actual,bindings)=>{
 context=actual;const prepare=actual.prepareForm;
 assert.equal(typeof prepare,'function');
 actual.prepareForm=async function(spec){
  assert.equal(this,actual);formRequests.push(spec);
  const id=spec.arguments.conversation.id;trace.push('prepare:start:'+spec.operation+':'+id);
  await Promise.resolve();if(failPrepare)throw failPrepare;
  const result=await prepare(spec);assert.equal(result.status,'ready');
  assert.equal(typeof result.props.sourceBinding,'string');assert.deepEqual(spec.fields,[]);
  assert.equal(spec.arguments.conversation.version,9n);
  if(spec.operation==='chat.inspect'){
   assert.equal(spec.arguments.branch.id,'branch-two');assert.equal(spec.arguments.branch.version,13n);
   assert.equal(spec.arguments.conversation.id,'conversation-two','outer explicit alias survives nested row shadowing');
  }
  trace.push('prepare:end:'+spec.operation+':'+id);return result;
 };
 return page.render(actual,bindings);
}}));
const {deps,identity}=await createTestDeps({descriptors});
const bindings=await createSourceFormBindings(new Uint8Array(32).fill(96),'compiled-details-drawers');
let admittedPrincipal=null,scopes=0;
const configured={...deps,catalog,formBindings:bindings,
 app:{...deps.app,ownerLabels:new Map([['chat','Chat'],['ChatDrawers','Chat']])},
 createReadScope:(principal,source)=>{
  admittedPrincipal=principal;scopes++;assert(source.canonical.builtinRoles.includes('members'));
  return {query:async(invocation,model,args)=>{
   assert.equal(invocation,admittedPrincipal);trace.push('query:'+model);
   if(model==='chat.Conversation')return {rows:returned,columns:[]};
   assert.equal(model,'chat.Branch');assert.equal(args.parent.id,'conversation-two');
   assert.equal(args.parent.version,9n);branchQueries.push(args);
   await Promise.resolve();if(failQuery)throw failQuery;
   return {rows:returnedBranches,columns:[]};
  }};
 },
};
const decode=html=>html.replaceAll('&amp;','&');
const links=html=>[...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(decode(match[1]),'https://can.test'));
const drawers=html=>links(html).filter(url=>[...url.searchParams.keys()].some(key=>key.startsWith('can-row:can-details-')));
const selector=url=>[...url.searchParams.keys()].filter(key=>key.startsWith('can-row:can-details-'));
const reset=()=>{context=null;props=[];bodies=[];trace=[];branchQueries=[];formRequests=[];};
for(const partial of [false,true]){
 const baseParams=new URLSearchParams([['team',identity.teamId],['q','keep <&>'],['can-row:sibling','other']]);
 const request=(path,params,authenticated=true)=>testRequest(path+'?'+params,{
  ...(authenticated?{cookie:identity.cookie}:{}),headers:{'accept-language':'nl',...(partial?{'HX-Request':'true'}:{})},
 });
 const dispatch=async(params,path='/chat')=>{
  reset();const response=await handlePageRequest(configured,request(path,params));
  const html=await response.text();assert.equal(response.status,200,html);
  assert.equal(context.isPartial,partial);assert.equal(context.principal,admittedPrincipal);return html;
 };
 let html=await dispatch(baseParams);
 assert.equal(props.length,2);assert.equal(props[0].occurrence,props[1].occurrence,'one selector per repeated source site');
 assert.deepEqual(bodies,[]);assert.deepEqual(formRequests,[]);assert.deepEqual(branchQueries,[]);
 assert.deepEqual(trace,['query:chat.Conversation'],'inactive bodies read no body-only fields');
 assert(html.includes('Gesprek openen')&&html.includes('First &lt;&amp;&gt;'));
 const openers=drawers(html);assert.equal(openers.length,2);
 const outerKey=selector(openers[1])[0];assert.equal(openers[1].searchParams.get(outerKey),'conversation-two');
 assert.notEqual([...html.matchAll(/aria-controls="([^"]+)"/g)][0][1],[...html.matchAll(/aria-controls="([^"]+)"/g)][1][1]);
 for(const opener of openers){
  assert.equal(opener.pathname,'/chat');assert.equal(opener.searchParams.get('team'),identity.teamId);
  assert.equal(opener.searchParams.get('q'),'keep <&>');assert.equal(opener.searchParams.get('can-row:sibling'),'other');
 }
 const outerParams=new URLSearchParams(openers[1].search);
 html=await dispatch(outerParams);assert.deepEqual(bodies,[conversations[1]]);assert.equal(formRequests.length,1);
 assert.equal(branchQueries.length,1);assert.equal(props.length,4);
 assert.equal(props[2].occurrence,props[3].occurrence);assert.notEqual(props[0].occurrence,props[2].occurrence);
 assert.equal(trace.filter(item=>item.startsWith('prefix:')).length,0,'inactive nested transcript remains lazy');
 assert.deepEqual(trace,['query:chat.Conversation','body:start:conversation-two','prepare:start:chat.revoke:conversation-two',
  'prepare:end:chat.revoke:conversation-two','active:conversation-two','query:chat.Branch','body:end:conversation-two']);
 const inner=drawers(html).find(url=>selector(url).length===2&&url.searchParams.get(selector(url).find(key=>key!==outerKey))==='branch-two');
 assert(inner);const innerKey=selector(inner).find(key=>key!==outerKey),innerParams=new URLSearchParams(inner.search);
 html=await dispatch(innerParams);assert.deepEqual(bodies,[conversations[1],branches[1]]);assert.equal(formRequests.length,2);
 assert.equal(trace.filter(item=>item==='prefix:branch-two').length,1);assert(!trace.includes('prefix:branch-one'));
 assert(html.includes('Private &lt;&amp;&gt; branch-two')&&!html.includes('Private &lt;&amp;&gt; branch-one'));
 assert(html.includes('conversation-two')&&html.includes('branch-two')&&html.includes('After inspected branch'));
 assert(trace.indexOf('prefix:branch-two')<trace.indexOf('prepare:start:chat.inspect:conversation-two'));
 assert(trace.indexOf('prepare:end:chat.inspect:conversation-two')<trace.indexOf('body:end:branch-two'));
 assert(trace.indexOf('body:end:branch-two')<trace.indexOf('body:end:conversation-two'));
 const ids=[...html.matchAll(/ id="(can-details-[^"]+)"/g)].map(match=>match[1]);
 assert.equal(new Set(ids).size,ids.length);assert.equal((html.match(/<dialog open/g)||[]).length,2);
 const closes=[...html.matchAll(/data-can-split-close href="([^"]+)"/g)].map(match=>new URL(decode(match[1]),'https://can.test'));
 const innerClose=closes.find(url=>url.searchParams.has(outerKey));assert(innerClose);
 assert.equal(innerClose.searchParams.has(innerKey),false);assert.equal(innerClose.searchParams.get(outerKey),'conversation-two');
 assert.equal(innerClose.searchParams.get('q'),'keep <&>');assert.equal(innerClose.searchParams.get('can-row:sibling'),'other');
 assert(html.includes('Details sluiten'));
 // A current selector can render only rows returned by this admitted query.
 returned=[conversations[0]];html=await dispatch(outerParams);assert.deepEqual(bodies,[]);assert.deepEqual(formRequests,[]);returned=conversations;
 for(const [key,value] of [[outerKey,'forged-row'],['can-row:foreign','conversation-two']]){
  const params=new URLSearchParams(baseParams);params.set(key,value);html=await dispatch(params);
  assert.deepEqual(bodies,[]);assert.deepEqual(formRequests,[]);assert.deepEqual(trace,['query:chat.Conversation']);
 }
 const staleBranch=new URLSearchParams(innerParams);staleBranch.set(innerKey,'absent-branch');
 html=await dispatch(staleBranch);assert.deepEqual(bodies,[conversations[1]]);assert.equal(formRequests.length,1);
 assert.equal(trace.filter(item=>item.startsWith('prefix:')).length,0);
 failPrepare=new Error('prepare-first');reset();const failedPrepare=await handlePageRequest(configured,request('/chat',innerParams));
 assert.equal(failedPrepare.status,422);assert.equal((await failedPrepare.json()).code,'rule_failed');assert.deepEqual(trace,['query:chat.Conversation','body:start:conversation-two','prepare:start:chat.revoke:conversation-two']);failPrepare=null;
 failQuery=new Error('branch-query-first');reset();const failedQuery=await handlePageRequest(configured,request('/chat',innerParams));
 assert.equal(failedQuery.status,422);assert.equal((await failedQuery.json()).code,'rule_failed');assert.equal(bodies.length,1);assert.equal(trace.filter(item=>item.startsWith('prefix:')).length,0);failQuery=null;
 const gatedRow={id:'gated',version:'17',fields:{title:'Gated',active:true}};returned=[gatedRow];
 html=await dispatch(baseParams,'/gated');assert.equal(props.length,1);assert.deepEqual(bodies,[]);
 const gatedParams=new URLSearchParams(drawers(html)[0].search);
 // A previously visible current row loses its source gate; its actual source
 // selector must not evaluate the body or grant any additional authority.
 gatedRow.fields.active=false;
 html=await dispatch(gatedParams,'/gated');assert.deepEqual(bodies,[]);assert.equal(props.length,0);returned=conversations;
 reset();const beforeScopes=scopes;
 const denied=await handlePageRequest(configured,request('/chat',innerParams,false));
 assert.equal(denied.status,403);assert.equal(scopes,beforeScopes);assert.deepEqual(props,[]);assert.deepEqual(trace,[]);
 assert.deepEqual(deps.invoker.mutations,[],'presentation grants and native business invocations remain outside this test');
}
delete globalThis.drawerProbe;
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
fn drawer_source_refuses_unowned_open_slots_invalid_options_and_empty_bodies() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, source) in [
        ("open", SOURCE.replace("display=drawer", "display=drawer open=true")),
        ("id", SOURCE.replace("display=drawer", "display=drawer id=drawer")),
        ("display", SOURCE.replace("display=drawer", "display=modal")),
        ("caption", SOURCE.replace("details \"Open branch\"@{nl=\"Vertakking openen\"}", "details 1")),
        ("slot", SOURCE.replace("     form revoke", "     slot content\n      text \"Invalid\"\n     form revoke")),
        ("unowned", SOURCE.replace("   require members\n   list Conversation as conversation where", "   require members\n   details \"Unowned\" display=drawer\n    text \"Invalid\"\n   list Conversation as conversation where")),
        ("empty", SOURCE.replace("     require row.active\n     text row.title", "     require row.active")),
        ("missing-caption", SOURCE.replace("details \"Gated\" display=drawer", "details display=drawer")),
        ("foreign-alias", SOURCE.replace("       text conversation.id,row.id", "       text foreign.id,row.id")),
        ("field-owner", SOURCE.replace("     form revoke arguments={conversation=row}", "     form revoke arguments={conversation=row}\n      details \"Invalid field placement\" display=drawer\n       text \"Invalid\"")),
    ] {
        let (output, response) = compile(&source, &scratch.path().join(format!("{name}.can")));
        assert!(!output.status.success(), "{name} unexpectedly accepted: {response}");
        assert!(response["diagnostics"].as_array().is_some_and(|diags| diags.iter().any(|diag| diag["severity"] == "error")), "{name}: {response}");
    }
}

#[test]
fn edited_drawer_ir_cannot_fabricate_original_rows_or_payload_profiles() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::analysis::types::{ResolvedType, Scalar};
    use canlang_compiler::codegen::ir::{self, IrExpr, IrUi, TypedExpr};
    use canlang_compiler::codegen::js::Emitter;
    use canlang_compiler::source::{SourceDb, Span};
    fn drawer(nodes: &mut [IrUi]) -> &mut IrUi {
        for node in nodes {
            if node.factory == "detailsDrawer" {
                return node;
            }
            if node
                .children
                .iter()
                .any(|child| child.factory == "detailsDrawer")
            {
                return drawer(&mut node.children);
            }
        }
        panic!("drawer not found")
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let id = db.add("drawers.can".into(), SOURCE.into());
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
    let collection = program
        .modules
        .iter()
        .find(|module| module.name == "chat")
        .unwrap()
        .pages
        .iter()
        .find(|page| page.path == "/chat")
        .unwrap()
        .render[0]
        .clone();
    for variant in ["open", "model", "record", "children", "row-scope"] {
        let mut node = collection.clone();
        let target = drawer(std::slice::from_mut(&mut node));
        match variant {
            "open" => target.props.push((
                "open".into(),
                TypedExpr::new(
                    IrExpr::Bool(true),
                    ResolvedType::Scalar(Scalar::Bool),
                    target.span,
                ),
            )),
            "model" => {
                target
                    .props
                    .iter_mut()
                    .find(|(key, _)| key == "model")
                    .unwrap()
                    .1
                    .expr = IrExpr::Text("chat.Branch".into())
            }
            "record" => {
                target
                    .props
                    .iter_mut()
                    .find(|(key, _)| key == "record")
                    .unwrap()
                    .1
                    .expr = IrExpr::Object(vec![])
            }
            "children" => target.children.clear(),
            "row-scope" => target.row_scope = Some(("foreign".into(), "context".into())),
            _ => unreachable!(),
        }
        let mut emitter = Emitter::new(&program);
        let output = emitter.lower_ui(&node);
        let (diagnostics, _, _, _) = emitter.finish();
        assert!(
            diagnostics
                .iter()
                .any(|diag| diag.code == "E6008" && diag.message.contains("details drawer")),
            "{variant}: {diagnostics:?}"
        );
        assert!(
            output.contains("unsupported details drawer profile"),
            "{variant}: {output}"
        );
    }
}
