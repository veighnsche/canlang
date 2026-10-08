//! OUT-R01: real CLI artifacts imported unchanged and invoked through their
//! recorded callable paths. A strict host stdlib seam verifies ambient context,
//! argument identity and order; this is not full application-runtime qualification.

#[cfg(unix)]
#[test]
fn legal_bindings_execute_through_artifact_callables() {
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = Scratch(std::env::temp_dir().join(format!("can-bindings-{}-{}",
        std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())));
    std::fs::create_dir_all(&scratch.0).unwrap();
    let names = [
        "value",
        "class",
        "await",
        "default",
        "c",
        "arguments",
        "eval",
        "check",
        "records",
        "int64",
        "_forRows0",
        "__proto__",
        "row",
        "event",
        "bindings",
        "crudWhen",
        "canApp",
        "appDefinition",
    ];
    let mut source = "app Bindings\nGiven\n contract Box { class:text }\n derive identity(default:text):text = default\n derive class(await:text):text = await\nWhen\n".to_string();
    for (index, name) in names.iter().enumerate() {
        source.push_str(&format!(" scenario echo{index}({name}:text) read=true -> text by=members\n  do\n   let local={name}\n   return identity(local)\n"));
    }
    source.push_str(
        " scenario box(class:text) read=true -> Box by=members\n  do return Box {class}\n",
    );
    source.push_str(" scenario context(c:text) read=true -> user by=members\n  do return actor\n");
    source.push_str(" scenario scope(value:text) read=true -> text by=members\n  do\n   if true\n    let value=\"inner\"\n    require value==\"inner\"\n   return value\n");
    source.push_str(" scenario query(c:int[],records:text) read=true -> int[] by=members\n  do\n   let selected=c as class where class>0\n   return selected as await select await\n");
    source.push_str("Then\n");
    let input = scratch.0.join("bindings.can");
    std::fs::write(&input, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "CLI: {}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.0.join("artifact.json"), compiled.stdout).unwrap();
    let multi = scratch.0.join("multi.can");
    let mut source = "app Combined uses=[alpha,ALPHA]\n".to_string();
    for owner in ["alpha", "ALPHA"] {
        source.push_str(&format!("package {owner}\n Given\n  export M {{ title:text }}\n  policy M read=members\n  derive same(c:text):text = c\n  derive M.label:text = row.title\n When\n  scenario echo(c:text) read=true -> text by=members\n   do return same(c)\n  crud M by=members fields=title\n Then\n"));
    }
    std::fs::write(&multi, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&multi)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "multi CLI: {}",
        String::from_utf8_lossy(&compiled.stdout)
    );
    std::fs::write(scratch.0.join("multi.json"), compiled.stdout).unwrap();
    let hooks = scratch.0.join("hooks.can");
    std::fs::write(&hooks, "app Hooks\nGiven\n M { t:text }\n N { t:text }\nWhen\n scenario h on=M.create\n  do\n   let input=event.after.t\n   require input==\"candidate\"\n crud N by=members fields=t\nThen\n").unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&hooks)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "hooks CLI: {}",
        String::from_utf8_lossy(&compiled.stdout)
    );
    std::fs::write(scratch.0.join("hooks.json"), compiled.stdout).unwrap();
    let imports = scratch.0.join("imports.can");
    let mut source = String::new();
    for owner in ["alpha", "ALPHA"] {
        source.push_str(&format!("package {owner}\n Given\n  export capability Svc version=1\n   ping(class:text) -> text\n When\n Then\n"));
    }
    source.push_str("app Consumer\nuse alpha {Svc as A}\nuse ALPHA {Svc as B}\nuse std {EmailV1 as Left} from=deployment.left\nuse std {EmailV1 as Right} from=deployment.right\nGiven\nWhen\n scenario dispatch(to:email,subject:text,body:text) by=members\n  do\n   send Left.send {to,subject,body} as first\n   send Right.send {to,subject,body} as second\n   send Left.send {to,subject,body} when=false as skipped\n scenario left(class:text) read=true -> text by=members\n  do return class\n scenario right(class:text) read=true -> text by=members\n  do return class\nThen\n");
    std::fs::write(&imports, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&imports)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "imports CLI: {}",
        String::from_utf8_lossy(&compiled.stdout)
    );
    let artifact =
        canlang_compiler::json::parse(&String::from_utf8_lossy(&compiled.stdout)).unwrap();
    let paths: Vec<_> = artifact
        .get("modules")
        .unwrap()
        .as_arr()
        .unwrap()
        .iter()
        .map(|module| module.get("path").unwrap().as_str().unwrap())
        .collect();
    assert_eq!(
        paths
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        paths.len(),
        "distinct legal owners must have distinct portable module paths: {paths:?}"
    );
    std::fs::write(scratch.0.join("imports.json"), compiled.stdout).unwrap();
    let package = scratch.0.join("node_modules/@canlang/stdlib");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(package.join("index.mjs"), r#"
import assert from 'node:assert/strict';
export const trace=[];
export function hasRole(context,role){assert.equal(context.marker,'ambient');trace.push(['role',role]);return context.memberships.includes(role);}
export function require(value,code){if(!value)throw Error(code);}
export async function send(context,operation,request,options){assert.equal(context.marker,'ambient');trace.push(['send',context,operation,request,options]);return {id:'receipt',status:'pending'};}
export function int64(value){assert.equal(typeof value,'bigint');return value;}
export async function create(context,model,input){assert.equal(context.marker,'ambient');trace.push(['create',model,input]);return {model,input};}
export async function set(context,record,changes){assert.equal(context.marker,'ambient');trace.push(['set',record,changes]);}
export async function deleteRecord(context,record){assert.equal(context.marker,'ambient');trace.push(['delete',record]);}
"#).unwrap();
    let runner = scratch.0.join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {trace} from '@canlang/stdlib';
const artifact=JSON.parse(readFileSync(new URL('./artifact.json',import.meta.url),'utf8'));
for(const module of artifact.modules){const path=resolve(dirname(new URL(import.meta.url).pathname),module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(dirname(new URL(import.meta.url).pathname),artifact.modules[0].path)));
const registry=entry.canApp();
const context={marker:'ambient',memberships:['members'],actor:'actor-from-context'};
function callable(name){const desc=artifact.callables.find(item=>item.id===`Bindings.${name}`);assert(desc,name);assert.equal(entry[desc.export],desc.id);let value=registry;for(const part of desc.member)value=value[part];assert.equal(typeof value,'function');return value;}
const names=['value','class','await','default','c','arguments','eval','check','records','int64','_forRows0','__proto__','row','event','bindings','crudWhen','canApp','appDefinition'];
for(const [index,key]of names.entries()){
 let accesses=0;const input={};Object.defineProperty(input,key,{enumerable:true,get(){accesses++;return `payload-${key}-é😀`;}});
 const result=await callable(`echo${index}`)(context,input);
 assert.equal(result,`payload-${key}-é😀`);assert.equal(accesses,1,'authored parameter read exactly once');
 const schema=entry.appDefinition.operations[`Bindings.echo${index}`].inputs;
 assert.deepEqual(Object.keys(schema),[key],'wire parameter spelling preserved');
}
const pure=artifact.callables.find(item=>item.id==='Bindings.class');let pureFn=registry;for(const part of pure.member)pureFn=pureFn[part];assert.equal(await pureFn(context,'reserved-function'),'reserved-function');
assert.deepEqual(await callable('box')(context,{class:'key-value'}),{class:'key-value'});
assert.equal(await callable('context')(context,{c:'source-c'}),'actor-from-context');
assert.equal(await callable('scope')(context,{value:'outer'}),'outer');
assert.deepEqual(await callable('query')(context,{c:[-1n,0n,2n,4n],records:'source-records'}),[2n,4n]);
assert.equal(trace.length,names.length+4,'admission evaluated once per callable');
const multi=JSON.parse(readFileSync(new URL('./multi.json',import.meta.url),'utf8'));
for(const module of multi.modules){const path=resolve(dirname(new URL(import.meta.url).pathname),'multi',module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const exports=await import(pathToFileURL(resolve(dirname(new URL(import.meta.url).pathname),'multi',multi.modules[0].path)));
const combined=exports.canApp();
for(const owner of ['alpha','ALPHA']){
 for(const name of ['echo','same','M.label','M.create']){
  const id=`${owner}.${name}`;const desc=multi.callables.find(item=>item.id===id);assert(desc,id);
  let fn=combined;for(const part of desc.member)fn=fn[part];assert.equal(typeof fn,'function',id);
  if(name==='echo')assert.equal(await fn(context,{c:`${owner}-payload`}),`${owner}-payload`);
  if(name==='same')assert.equal(await fn(context,`${owner}-derive`),`${owner}-derive`);
  if(name==='M.label')assert.equal(await fn(context,{title:`${owner}-field`}),`${owner}-field`);
  if(name==='M.create'){assert.equal(await fn(context,{title:owner}),undefined);assert.deepEqual(trace.at(-1),['create',`${owner}.M`,{title:owner}]);}
 }
}
assert.equal(new Set(multi.callables.map(item=>JSON.stringify(item.member))).size,multi.callables.length,'unique callable paths');
const hooks=JSON.parse(readFileSync(new URL('./hooks.json',import.meta.url),'utf8'));
for(const module of hooks.modules){const path=resolve(dirname(new URL(import.meta.url).pathname),'hooks',module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const hookEntry=await import(pathToFileURL(resolve(dirname(new URL(import.meta.url).pathname),'hooks',hooks.modules[0].path)));
const hookRegistry=hookEntry.canApp();
function hookCallable(id){const desc=hooks.callables.find(item=>item.id===id);assert(desc,id);let fn=hookRegistry;for(const part of desc.member)fn=fn[part];assert.equal(typeof fn,'function',id);return fn;}
const candidate={t:'candidate'};
assert.equal(await hookCallable('Hooks.h')(candidate,{triggerId:'trigger',before:null}),candidate);
assert.equal(await hookCallable('Hooks.N.create')(context,{t:'created'}),undefined);
assert.deepEqual(trace.at(-1),['create','Hooks.N',{t:'created'}]);
const record={id:'record',t:'before'};
await hookCallable('Hooks.N.update')(context,{record,changes:{t:'after'}});
assert.deepEqual(trace.at(-1),['set',record,{t:'after'}]);
await hookCallable('Hooks.N.delete')(context,{record});
assert.deepEqual(trace.at(-1),['delete',record]);
const imports=JSON.parse(readFileSync(new URL('./imports.json',import.meta.url),'utf8'));
for(const module of imports.modules){const path=resolve(dirname(new URL(import.meta.url).pathname),'imports',module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
for(const [owner,index]of [['alpha',1],['ALPHA',2]]){
 const module=await import(pathToFileURL(resolve(dirname(new URL(import.meta.url).pathname),'imports',imports.modules[index].path)));
 const functions=Object.values(module).filter(value=>typeof value==='function');assert.equal(functions.length,1);
 await assert.rejects(functions[0](context,owner),error=>error.message===`external capability operation ${owner}.Svc.ping binds at deployment`);
}
// Compiler ABI witness only: the host double does not authorize/stage Work.
const importsEntry=await import(pathToFileURL(resolve(dirname(new URL(import.meta.url).pathname),'imports',imports.modules[0].path)));
const definition=importsEntry.appDefinition;
for(const owner of ['alpha','ALPHA']){
 assert.deepEqual(definition.capabilities[`${owner}.Svc`].operations.ping,{inputs:{class:{type:'text'}},result:{type:'text'}});
}
assert.equal(definition.capabilities['std.EmailV1'].version,1n);
assert.deepEqual(definition.capabilities['std.EmailV1'].operations.send,{
 inputs:{to:{type:'email'},subject:{type:'text'},body:{type:'text'},attachments:{type:'file',array:true}},result:{type:'EmailAccepted'},
});
assert.equal(Object.keys(definition.capabilities).filter(key=>key==='std.EmailV1').length,1);
assert.deepEqual(definition.bindings['Consumer.Left'],{capability:'std.EmailV1',from:'deployment.left'});
assert.deepEqual(definition.bindings['Consumer.Right'],{capability:'std.EmailV1',from:'deployment.right'});
const dispatch=imports.callables.find(item=>item.id==='Consumer.dispatch');
let dispatchFn=importsEntry.canApp();for(const part of dispatch.member)dispatchFn=dispatchFn[part];
const reads=[];const dispatchInput={};
for(const [key,value]of [['to','a@b.test'],['subject','Authored'],['body','Body']])Object.defineProperty(dispatchInput,key,{enumerable:true,get(){reads.push(key);return value;}});
const sendStart=trace.length;
await dispatchFn(context,dispatchInput);
assert.deepEqual(reads,['to','subject','body']);
const sends=trace.slice(sendStart).filter(item=>item[0]==='send');
assert.equal(sends.length,3);
for(const item of sends){assert.equal(item[1],context);assert.equal(item[2],'std.EmailV1.send');assert.deepEqual(item[3],{to:'a@b.test',subject:'Authored',body:'Body'});}
assert.deepEqual(sends.map(item=>item[4].binding),['Consumer.Left','Consumer.Right','Consumer.Left']);
assert.equal(sends[0][4].when,undefined);assert.equal(sends[1][4].when,undefined);
assert.equal(typeof sends[2][4].when,'function');assert.equal(sends[2][4].when(),false);
// Actual installed artifact loader, module assembler and callable consumer.
const runtime=resolve(process.argv[2],'packages/cloudflare/dist/runtime');
const {loadArtifactFile}=await import(pathToFileURL(resolve(runtime,'artifact.js')));
const {assembleModules}=await import(pathToFileURL(resolve(runtime,'modules.js')));
const {invokeCallable}=await import(pathToFileURL(resolve(runtime,'invoke.js')));
const base=dirname(new URL(import.meta.url).pathname);
writeFileSync(resolve(base,'ui.mjs'),'export {};');
const loaded=loadArtifactFile(resolve(base,'multi.json'));
const assembled=await assembleModules(loaded,{workDir:resolve(base,'assembled'),
 stdlibUrl:pathToFileURL(resolve(base,'node_modules/@canlang/stdlib/index.mjs')).href,
 uiUrl:pathToFileURL(resolve(base,'ui.mjs')).href});
for(const owner of ['alpha','ALPHA']){
 for(const [name,input,expected]of [
  ['echo',{c:owner},owner],['same',owner,owner],['M.label',{title:owner},owner],['M.create',{title:owner},undefined]]){
   const result=await invokeCallable(assembled,loaded.artifact,`${owner}.${name}`,context,[input]);
   assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.value,expected);
 }
}
console.log('OUT-R01: bindings, scopes/queries, Unicode payloads, cross-module callable/CRUD/derive-field paths and distinct capability imports executed');
"#).unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .arg(&root)
        .output()
        .expect("Node required for binding runtime qualification");
    assert!(
        executed.status.success(),
        "Node: {}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}

#[test]
fn public_emitter_binding_and_import_seams_execute() {
    use canlang_compiler::analysis::{
        check_program,
        types::{ResolvedType, Scalar},
    };
    use canlang_compiler::codegen::{
        ir::{self, IrCallTarget, IrExpr, IrStmt, TypedExpr},
        js::{self, Emitter},
    };
    use canlang_compiler::source::SourceDb;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
    let stage = std::env::temp_dir().join(format!(
        "can-binding-seam-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&stage).unwrap();
    let mut db = SourceDb::new();
    let source = "app Consumer\nGiven\nWhen\nThen\npackage alpha\n Given\n  export capability Svc version=1\n   default(await:text) -> text\n When\n Then\npackage ALPHA\n Given\n  export capability Svc version=1\n   default(await:text) -> text\n When\n Then\n";
    let id = db.add("binding-seam.can".into(), source.into());
    let (checked, diagnostics) = check_program(&db, &[id], None);
    assert!(
        diagnostics.is_empty(),
        "checked declarations: {diagnostics:?}"
    );
    let (ir, diagnostics) = ir::build(&checked, &db, None);
    assert!(diagnostics.is_empty(), "IR declarations: {diagnostics:?}");
    let output = js::emit_program(&ir);
    assert!(
        output.diagnostics.is_empty(),
        "JS declarations: {:?}",
        output.diagnostics
    );
    for module in &output.packages {
        std::fs::write(stage.join(&module.path), &module.js).unwrap();
    }
    let span = ir.modules[0].span;
    let text = |value: &str| {
        TypedExpr::new(
            IrExpr::Text(value.into()),
            ResolvedType::Scalar(Scalar::Text),
            span,
        )
    };
    let name = |value: &str| {
        TypedExpr::new(
            IrExpr::Name(value.into()),
            ResolvedType::Scalar(Scalar::Text),
            span,
        )
    };
    let mut emitter = Emitter::new(&ir);
    let calls: Vec<_> = ["alpha", "ALPHA"]
        .iter()
        .map(|owner| {
            emitter.lower_expr(&TypedExpr::new(
                IrExpr::Call {
                    target: IrCallTarget::CapabilityOp(format!("{owner}.Svc.default")),
                    args: vec![text(owner)],
                },
                ResolvedType::Scalar(Scalar::Text),
                span,
            ))
        })
        .collect();
    let mut body = Vec::new();
    for (binding, value) in [
        ("$forRows0", "outer"),
        ("é", "accent"),
        ("_", "underscore"),
        ("__proto__", "own-value"),
    ] {
        body.extend(emitter.lower_stmt(
            &IrStmt::Let {
                name: binding.into(),
                value: text(value),
                span,
            },
            0,
        ));
    }
    body.extend(emitter.lower_stmt(
        &IrStmt::For {
            item: "$forRows0".into(),
            domain: TypedExpr::new(
                IrExpr::Array(vec![text("inner")]),
                ResolvedType::Unknown,
                span,
            ),
            limit: Some(TypedExpr::new(
                IrExpr::Int(1),
                ResolvedType::Scalar(Scalar::Int),
                span,
            )),
            body: vec![IrStmt::Let {
                name: "é".into(),
                value: text("inner-accent"),
                span,
            }],
            span,
        },
        0,
    ));
    let lambda = TypedExpr::new(
        IrExpr::Lambda {
            param: "class".into(),
            body: Box::new(name("class")),
        },
        ResolvedType::Unknown,
        span,
    );
    let object = TypedExpr::new(
        IrExpr::Object(vec![
            ("$forRows0".into(), name("$forRows0")),
            ("é".into(), name("é")),
            ("_".into(), name("_")),
            ("__proto__".into(), name("__proto__")),
            ("lambda".into(), lambda),
        ]),
        ResolvedType::Unknown,
        span,
    );
    let result = emitter.lower_expr(&object);
    let imports = emitter.import_lines().join("\n");
    let js = format!(
        "{imports}\nexport async function left(c){{return {};}}\nexport async function right(c){{return {};}}\nexport async function locals(c){{\n{}\nreturn {result};}}",
        calls[0],
        calls[1],
        body.iter()
            .map(|line| line.0.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
    let (diagnostics, _, _, _) = emitter.finish();
    assert!(
        diagnostics.is_empty(),
        "lowering diagnostics: {diagnostics:?}"
    );
    std::fs::write(stage.join("seams.mjs"), js).unwrap();
    let package = stage.join("node_modules/@canlang/stdlib");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(
        package.join("index.mjs"),
        "export function require(value,code){if(!value)throw Error(code);}",
    )
    .unwrap();
    std::fs::write(stage.join("run.mjs"), r#"
import assert from 'node:assert/strict';
import {left,right,locals} from './seams.mjs';
await assert.rejects(left({}),error=>error.message==='external capability operation alpha.Svc.default binds at deployment');
await assert.rejects(right({}),error=>error.message==='external capability operation ALPHA.Svc.default binds at deployment');
const value=await locals({});
assert.equal(value.$forRows0,'outer');assert.equal(value['é'],'accent');assert.equal(value._,'underscore');
assert.equal(value.__proto__,'own-value');assert.equal(Object.getPrototypeOf(value),Object.prototype);
assert.equal(value.lambda('reserved-lambda'),'reserved-lambda');
console.log('OUT-R01: public emitter distinct imports, reserved lambdas, temp collisions, Unicode identities and loop scopes executed');
"#).unwrap();
    let executed = Command::new("node")
        .arg(stage.join("run.mjs"))
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&stage);
    assert!(
        executed.status.success(),
        "Node seams: {}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}
