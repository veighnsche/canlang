import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
const [mode, specifier] = process.argv.slice(2);
const begin=performance.now();
function send(v){console.log(JSON.stringify({...v,mode,specifier,elapsed_ms:Number((performance.now()-begin).toFixed(3)),node:process.version}));process.exit(v.status==='refused'?1:0);}
try {
 if(mode==='import'){
  const m=await import(specifier);send({status:'loaded',exports:Object.keys(m).length});
 }else if(mode==='repo-denied'){
  fs.readFileSync('/Users/vince/Projects/canlang/package.json');send({status:'unexpected-read'});
 }else if(mode==='values-call'){
  const m=await import('@canlang/values');send({status:'called',result:String(m.addInt(1n,2n))});
 }else if(mode==='wasm'){
  const path=specifier==='current'?'./current-values-generated/values_semantics.js':'@canlang/values/bindings/generated/values_semantics.js';
  const m=await import(path);
  const bytes=fs.readFileSync(specifier==='current'?new URL('./current-values-generated/values_semantics_bg.wasm',import.meta.url):new URL('./node_modules/@canlang/values/dist/bindings/generated/values_semantics_bg.wasm',import.meta.url));
  m.initSync({module:bytes});send({status:'called',abi:m.abi_version(),response:JSON.parse(m.exact_call('{"v":1,"op":"add-int","args":[{"t":"bigint","v":"1"},{"t":"bigint","v":"2"}]}'))});
 }else if(mode==='bootstrap'){
  const m=await import('@canlang/values/bindings/bootstrap');
  const bytes=fs.readFileSync(new URL('./node_modules/@canlang/values/dist/bindings/generated/values_semantics_bg.wasm',import.meta.url));
  let g;
  if(specifier==='missing')g=m.bootstrapWasm(undefined);
  if(specifier==='corrupt')g=m.bootstrapWasm(new Uint8Array([0,1,2]));
  if(specifier==='precompiled')g=m.bootstrapWasm(new WebAssembly.Module(bytes));
  if(specifier==='valid-then-corrupt'){m.bootstrapWasm(bytes);g=m.bootstrapWasm(new Uint8Array([0,1,2]));}
  if(specifier==='valid')g=m.bootstrapWasm(bytes);
  send({status:'called',backend:g.name,result:String(g.call('add-int',[1n,2n]))});
 }else if(mode==='no-webassembly'){
  globalThis.WebAssembly=undefined;await import('@canlang/values/bindings/bootstrap');send({status:'loaded'});
 }else throw Error('unknown mode');
}catch(e){send({status:'refused',code:e.code??null,name:e.name,message:String(e.message).slice(0,900)});process.exitCode=1;}
