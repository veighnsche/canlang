import fs from 'node:fs';
import { Miniflare } from '/Users/vince/Projects/canlang/packages/cloudflare/node_modules/miniflare/dist/src/index.js';
const root='/private/tmp/canlang-rust-port-codex-step10-20261007T015711Z/identity';
const nodeSource=`import { timingSafeEqual } from 'node:crypto'; export function nativeCompare(a,b){return timingSafeEqual(a,b)};`;
const workerSource=`export function nativeCompare(a,b){const s=globalThis.crypto?.subtle;if(typeof s?.timingSafeEqual!=='function')throw new Error('Identity host does not provide a native timing-safe comparison.');return s.timingSafeEqual(a,b)}`;
const neutral=`import { nativeCompare } from '#identity-byte-compare';export function compare(a,b){if(a.byteLength!==b.byteLength)return false;return nativeCompare(a,b)}`;
const recipe=`function run(compare){const view=new Uint8Array([9,1,2,9]).subarray(1,3);return {equal:compare(new Uint8Array([1,2]),view),different:compare(new Uint8Array([1,3]),view),length:compare(new Uint8Array([1]),view),empty:compare(new Uint8Array(),new Uint8Array()),subarray:compare(view,new Uint8Array([1,2]))}}`;
fs.mkdirSync(root+'/host',{recursive:true});
fs.writeFileSync(root+'/host/package.json',JSON.stringify({type:'module',imports:{'#identity-byte-compare':{node:'./node.js',default:'./worker.js'}}}));
fs.writeFileSync(root+'/host/node.js',nodeSource);fs.writeFileSync(root+'/host/worker.js',workerSource);fs.writeFileSync(root+'/host/index.js',neutral);
fs.writeFileSync(root+'/host/check.mjs',`import{compare}from'./index.js';${recipe};console.log(JSON.stringify({version:process.version,results:run(compare)}));`);
const {compare}=await import(root+'/host/index.js');const nodeResult=Function('compare',recipe+';return run(compare)')(compare);
const mf=new Miniflare({modules:[{type:'ESModule',path:root+'/host/main.js',contents:`import{compare}from './index.js';${recipe};export default{fetch(){return Response.json({extension:typeof crypto.subtle.timingSafeEqual,results:run(compare)})}}`},{type:'ESModule',path:root+'/host/index.js',contents:neutral.replace("'#identity-byte-compare'","'./worker.js'")},{type:'ESModule',path:root+'/host/worker.js',contents:workerSource}],modulesRoot:root+'/host',compatibilityDate:'2026-07-15'});
try{const response=await mf.dispatchFetch('http://localhost/');const worker=await response.json();const result={node:{version:process.version,results:nodeResult},worker,recipe:{miniflare:'4.20260730.0',compatibilityDate:'2026-07-15',compatibilityFlags:[],binding:'package imports node/default, owned Worker rewrite #identity-byte-compare to relative worker leaf'}};fs.writeFileSync(root+'/host-observations.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}finally{await mf.dispose()}
