//! Source-owned copied transcripts with host-bound original File presentation.
use std::{path::Path, process::Command};

const SOURCE: &str = r#"app Transcript
use std {TextMessage as Message}
Given
 Branch {visible:bool=true,prefix:Message[]}
 policy Branch read=members
When
Then
 page / title="Transcript"
  list Branch as branch
   list branch.prefix as message empty="No earlier messages"@{nl="Geen eerdere berichten"}
    require branch.visible
    pagination
    chat_bubble
     slot header
      text message.role
     slot content
      content message.content
      text message.attachments
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
    let response = serde_json::from_slice(&output.stdout).unwrap();
    (output, response)
}

#[test]
fn original_attachment_slots_reach_the_released_text_sink() {
    let scratch = tempfile::tempdir().unwrap();
    let (output, artifact) = compile(SOURCE, &scratch.path().join("original.can"));
    assert!(output.status.success(), "{artifact}");
    let emitted = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(emitted.contains(".attachments"), "{emitted}");
    assert!(!emitted.contains("unsupported copied message attachment text"));
    let (_, _, original) = checked_ir(SOURCE);
    let copied = &original.modules[0].pages[0].render[0].children[0];
    assert_eq!(copied.factory, "textMessageValueList");
    assert_eq!(copied.children[0].factory, "chatBubble");
    let content = &copied.children[0].children[1];
    assert_eq!(
        content.children.len(),
        2,
        "never discard the attachment leaf"
    );
    assert_eq!(content.children[1].factory, "text");
}

#[test]
fn original_transcript_keeps_files_slots_gates_order_failure_and_paging() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("transcript.can");
    let (output, artifact) = compile(SOURCE, &source);
    assert!(output.status.success(), "{artifact}");
    let messages = artifact["valueTypes"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|contract| contract["name"] == "TextMessage")
        .unwrap();
    assert_eq!(messages["fields"].as_array().unwrap().len(), 3);
    assert_eq!(messages["fields"][0]["type"], "enum(system,user,assistant)");
    assert_eq!(messages["fields"][1]["type"], "text");
    assert_eq!(messages["fields"][2]["type"], "file[]");
    std::fs::write(
        scratch.path().join("artifact.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    let default = SOURCE
        .replace("list Branch as branch", "list Branch")
        .replace("list branch.prefix as message", "list row.prefix")
        .replace("message.", "row.")
        .replace("    require branch.visible\n", "");
    let (output, artifact) = compile(&default, &scratch.path().join("default.can"));
    assert!(output.status.success(), "{artifact}");
    std::fs::write(
        scratch.path().join("default-artifact.json"),
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
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {makeFileValue}=await load('@canlang/values');
const {createPageFilePresentation}=await load('@canlang/files/bridge');
const {message}=await load('@canlang/ui');
async function loadEntry(name){
 const artifact=JSON.parse(readFileSync(resolve(base,name==='transcript'?'artifact.json':'default-artifact.json')));
 const assembly=await assembleModules({artifact,sourcePath:resolve(base,name+'.can')},{workDir:resolve(base,name+'-modules'),
  stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
 return importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
}
const entry=await loadEntry('transcript'),defaults=await loadEntry('default');
let snapshot=[],trace=[],reads=0,queries=0,rows=[];
const fields={visible:true};Object.defineProperty(fields,'prefix',{enumerable:true,get(){reads++;return snapshot;}});
const row={id:'branch',version:1,fields};rows=[row];
const context={memberships:['members'],preferredLocales:['en'],appDefaultLocale:'en',theme:{},path:'/',isPartial:false,
 csrfToken:'csrf',principal:{},invocation:{},query:async(invocation,model)=>{queries++;assert.equal(invocation,context.invocation);assert.equal(model,'Transcript.Branch');return {rows,columns:[]};}};
const render=()=>entry.appDefinition.pages[0].render(context,{});
function messages(count){return Array.from({length:count},(_,index)=>{
 const value={};Object.defineProperties(value,{role:{enumerable:true,get(){trace.push(`${index}:role`);return 'user';}},content:{enumerable:true,get(){trace.push(`${index}:content`);return `message-${index}\n<script>`;}},attachments:{enumerable:true,get(){trace.push(`${index}:attachments`);return Object.freeze([]);}}});return Object.freeze(value);
});}
for(const count of [0,1,25,26,51]){
 snapshot=messages(count);trace=[];reads=0;queries=0;
 const html=await render();assert.equal(reads,1);assert.equal(queries,1);
 assert.deepEqual(trace,Array.from({length:count},(_,index)=>[`${index}:role`,`${index}:content`,`${index}:attachments`]).flat());
 assert.equal((html.match(/class="chat-header"/g)||[]).length,count);assert.equal((html.match(/class="chat-bubble"/g)||[]).length,count);
 if(count===0)assert(html.includes('No earlier messages'));
 if(count>0){assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(html.includes('<br>'));assert.equal((html.match(/No files/g)||[]).length,count);}
 assert.equal((html.match(/type="radio"/g)||[]).length,count>25?Math.ceil(count/25):0);
 if(count>25){assert(html.includes('Page 2'));assert(html.includes('data-can-inspection-page="1"'));assert(html.includes(':checked~[data-can-inspection-page="1"]'));}
}
context.preferredLocales=['nl'];snapshot=[];assert((await render()).includes('Geen eerdere berichten'));
snapshot=messages(26);const dutchPages=await render();assert(dutchPages.includes('Pagina 2'));assert(dutchPages.includes('Geen bestanden'));
fields.visible=false;reads=0;snapshot=[Object.defineProperty({},'role',{get(){throw Error('gated child');}})];
assert(!(await render()).includes('chat-header'));assert.equal(reads,0,'gate precedes the copied field getter');
fields.visible=true;context.preferredLocales=['en'];
for(const failed of ['role','content','attachments']){
 const failure=new Error(failed);trace=[];snapshot=[Object.defineProperties({},{role:{get(){trace.push('role');if(failed==='role')throw failure;return 'user';}},content:{get(){trace.push('content');if(failed==='content')throw failure;return 'before';}},attachments:{get(){trace.push('attachments');throw failure;}}}),Object.defineProperty({},'role',{get(){trace.push('later row');return 'user';}})];
 await assert.rejects(render,error=>error===failure);assert.deepEqual(trace,['role','content','attachments'].slice(0,['role','content','attachments'].indexOf(failed)+1));
}
// A rejected installed text factory must settle before the later content slot.
trace=[];snapshot=[{role:NaN,get content(){trace.push('later slot');return 'later';},attachments:[]}];
await assert.rejects(render,TypeError);assert.deepEqual(trace,[]);
snapshot=messages(1);reads=0;assert((await defaults.appDefinition.pages[0].render(context,{})).includes('message-0'));assert.equal(reads,1,'default inner row preserves the actual outer RowView');
snapshot=messages(26);rows=[row,{id:'branch-two',version:1,fields}];reads=0;
const multiple=await render();assert.equal(reads,2);const ids=[...multiple.matchAll(/<fieldset id="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);
rows=[row];
// These are owner-produced File identities and supplier-scoped occurrence
// associations. The test host resolver is not native File/application admission.
const first=makeFileValue('private-first'),second=makeFileValue('private-second'),denied=makeFileValue('private-denied');
const files=Object.freeze([first,second,first,denied]);
let seen=[],resolved=[];
const occurrence=(file,index)=>({model:'Transcript.Branch',recordId:'branch',field:'prefix',ref:file.id,path:[0,'attachments',index]});
const page=createPageFilePresentation(async captured=>{
 resolved.push(captured);assert(Object.isFrozen(captured));assert(Object.isFrozen(captured.path));
 assert.equal(captured.model,'Transcript.Branch');assert.equal(captured.recordId,'branch');assert.equal(captured.field,'prefix');
 await Promise.resolve();
 if(captured.ref===first.id)return {href:'/files/current-first?x=1&y=2',name:'<First>',status:'succeeded'};
 if(captured.ref===second.id)return {href:'/files/current-second',caption:message('Second',{nl:'Tweede'})};
 return null;
});
// The identical duplicate retains first's original path 0 binding. It does
// not establish a second per-position attachment grant or permit rebinding.
page.bind(first,occurrence(first,0));page.bind(second,occurrence(second,1));page.bind(denied,occurrence(denied,3));
context.presentFile=async file=>{seen.push(file);return page.presentFile(file);};
trace=[];reads=0;snapshot=[Object.freeze({get role(){trace.push('role');return 'user';},get content(){trace.push('content');return 'Before attachments';},get attachments(){trace.push('attachments');return files;}})];
const html=await render();assert.equal(reads,1);assert.deepEqual(trace,['role','content','attachments']);
assert.deepEqual(seen,[first,second,first,denied]);assert.equal(seen[0],first);assert.equal(seen[2],first);
assert.deepEqual(resolved.map(value=>value.path),[[0,'attachments',0],[0,'attachments',1],[0,'attachments',0],[0,'attachments',3]]);
assert.equal((html.match(/href="\/files\/current-first\?x=1&amp;y=2"/g)||[]).length,2);
assert(html.indexOf('Before attachments')<html.indexOf('&lt;First&gt;'));assert(html.indexOf('&lt;First&gt;')<html.indexOf('Second'));assert(html.indexOf('Second')<html.lastIndexOf('&lt;First&gt;'));assert(html.lastIndexOf('&lt;First&gt;')<html.indexOf('File unavailable'));
assert(!html.includes('private-'));assert(!html.includes('<First>'));assert.deepEqual(files,[first,second,first,denied]);assert(Object.isFrozen(files));
context.preferredLocales=['nl'];const dutch=await render();assert(dutch.includes('Tweede'));assert(dutch.includes('Bestand niet beschikbaar'));context.preferredLocales=['en'];
// Missing host scope is unavailable; ID copies, unbound values and closed
// associations remain withheld by the installed owner bridge.
delete context.presentFile;await assert.rejects(render,/source-bound presenter/);
const copy=Object.freeze({...first}),unbound=makeFileValue('private-unbound');
context.presentFile=async file=>{seen.push(file);return page.presentFile(file);};resolved=[];seen=[];
snapshot=[{role:'assistant',content:'Withheld',attachments:[copy,unbound]}];
const withheld=await render();assert.equal((withheld.match(/File unavailable/g)||[]).length,2);assert.deepEqual(seen,[copy,unbound]);assert.deepEqual(resolved,[]);assert(!withheld.includes('private-'));
page.close();snapshot=[{role:'assistant',content:'Closed',attachments:files}];resolved=[];
assert.equal(((await render()).match(/File unavailable/g)||[]).length,4);assert.deepEqual(resolved,[]);
// Current eligibility is resolved again for every original occurrence,
// including a duplicate whose earlier resolution had a link.
let permitted=true;
const changing=createPageFilePresentation(async captured=>{
 trace.push(`present:${captured.ref}`);await Promise.resolve();
 if(!permitted)return null;permitted=false;return {href:'/files/first-current-open'};
});
changing.bind(first,occurrence(first,0));context.presentFile=changing.presentFile;
trace=[];snapshot=[{role:'user',content:'Current',attachments:[first,first]}];
const current=await render();assert.equal((current.match(/href="\/files\/first-current-open"/g)||[]).length,1);assert(current.includes('File unavailable'));assert.deepEqual(trace,[`present:${first.id}`,`present:${first.id}`]);
// The UI sink snapshots each original attachment array before the first await.
const mutableFiles=[first,second,first],originalFiles=[...mutableFiles];
const mutating=createPageFilePresentation(async captured=>{
 if(seen.length===1){await Promise.resolve();mutableFiles.splice(0,mutableFiles.length,denied);}
 return {href:'/files/'+(captured.ref===first.id?'first':'second')};
});
mutating.bind(first,occurrence(first,0));mutating.bind(second,occurrence(second,1));seen=[];
context.presentFile=async file=>{seen.push(file);return mutating.presentFile(file);};snapshot=[{role:'user',content:'Snapshot',attachments:mutableFiles}];
const captured=await render();assert.deepEqual(seen,originalFiles);assert.equal((captured.match(/href="\/files\/first"/g)||[]).length,2);assert.equal((captured.match(/href="\/files\/second"/g)||[]).length,1);
// A resolver failure retains identity and stops the next file and next row.
const failure=new Error('current file resolver failed');
const failing=createPageFilePresentation(async captured=>{trace.push(`present:${captured.ref}`);await Promise.resolve();throw failure;});
failing.bind(first,occurrence(first,0));failing.bind(second,occurrence(second,1));context.presentFile=failing.presentFile;
trace=[];snapshot=[{role:'user',content:'Failure',attachments:[first,second]},Object.defineProperty({},'role',{get(){trace.push('later row');return 'user';}})];
await assert.rejects(render,error=>error===failure);assert.deepEqual(trace,[`present:${first.id}`]);
// Validate the complete typed File array before any resolver side effect.
for(const malformed of [[first,null],[first,'not File'],[first,{kind:'file',id:''}],new Array(1),[[first]]]){
 trace=[];snapshot=[{role:'user',content:'Malformed',attachments:malformed}];await assert.rejects(render,TypeError);assert.deepEqual(trace,[]);
}
fields.visible=false;reads=0;trace=[];snapshot=[{get role(){throw Error('gated File row');},attachments:[first]}];
assert(!(await render()).includes('chat-header'));assert.equal(reads,0);assert.deepEqual(trace,[]);
console.log('full copied TextMessage source: original header/content/File identities, installed source-bound text links, current denial, once/order/failure, translated empty/static paging and refusal controls passed');
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

fn checked_ir(
    source: &str,
) -> (
    canlang_compiler::source::SourceDb,
    canlang_compiler::analysis::CheckedProgram,
    canlang_compiler::codegen::ir::IrProgram,
) {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::source::{SourceDb, Span};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let file = db.add("transcript.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) =
        canlang_compiler::analysis::check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = canlang_compiler::codegen::ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, checked, ir)
}

#[test]
fn copied_messages_refuse_foreign_sources_mutation_clauses_and_changed_original_ir() {
    let scratch = tempfile::tempdir().unwrap();
    let source = SOURCE.to_string();
    for (name, source) in [
        (
            "duplicate-page",
            source.replace("    pagination\n", "    pagination\n    pagination\n"),
        ),
        (
            "nested-page",
            source.replace("    pagination\n", "    alert\n     pagination\n"),
        ),
        (
            "page-payload",
            source.replace("    pagination\n", "    pagination \"extra\"\n"),
        ),
        (
            "mutation",
            source.replace("    pagination\n", "    edit Branch\n"),
        ),
        (
            "query",
            source.replace(
                "as message empty=",
                "as message order=message.content empty=",
            ),
        ),
        (
            "constructed",
            source.replace(
                "list branch.prefix as message",
                "list [Message {role=user,content=\"x\",attachments=[]}] as message",
            ),
        ),
        (
            "foreign-shape",
            source.replace("prefix:Message[]", "prefix:text[]"),
        ),
        (
            "derived-array",
            source
                .replace(
                    "When\n",
                    " derive supplied(branch:Branch):Message[] = branch.prefix\nWhen\n",
                )
                .replace(
                    "list branch.prefix as message",
                    "list supplied(branch) as message",
                ),
        ),
    ] {
        let (output, artifact) = compile(&source, &scratch.path().join(format!("{name}.can")));
        assert!(!output.status.success(), "{name}: {artifact}");
        assert!(artifact.get("modules").is_none(), "{name}: {artifact}");
    }
    let (_, _, original) = checked_ir(&source);
    assert_eq!(
        original.modules[0].pages[0].render[0].children[0].factory,
        "textMessageValueList"
    );
    for mutation in ["source", "page", "children", "owner", "field-schema"] {
        let mut altered = original.clone();
        let list = &mut altered.modules[0].pages[0].render[0].children[0];
        match mutation {
            "source" => list.props[0].1.expr = canlang_compiler::codegen::ir::IrExpr::Array(vec![]),
            "page" => {
                list.props
                    .iter_mut()
                    .find(|(name, _)| name == "page")
                    .unwrap()
                    .1
                    .expr = canlang_compiler::codegen::ir::IrExpr::Bool(false)
            }
            "children" => list.children.clear(),
            "owner" => altered.read_rules[0].id.push_str(".changed"),
            "field-schema" => {
                use canlang_compiler::analysis::ResolvedType;
                use canlang_compiler::codegen::ir::{IrItemKind, IrType};
                let field = altered
                    .items
                    .iter_mut()
                    .find(|field| field.canonical == "Transcript.Branch.prefix")
                    .unwrap();
                let IrItemKind::Field {
                    ty: IrType::Known(ResolvedType::Array { element, .. }),
                    ..
                } = &mut field.kind
                else {
                    panic!("original owning field")
                };
                let ResolvedType::StdNominal { fields, .. } = element.as_mut() else {
                    panic!("original named message")
                };
                fields.pop();
            }
            _ => unreachable!(),
        }
        let emitted = canlang_compiler::codegen::js::emit_program(&altered);
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("original checked readonly")),
            "{mutation}: {:?}",
            emitted.diagnostics
        );
    }
}
