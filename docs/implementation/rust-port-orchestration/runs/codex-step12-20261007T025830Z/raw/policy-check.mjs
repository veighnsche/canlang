import fs from'node:fs';
import {buildDeployBundle,assertWorkerdLoadable,assertLinksResolve}from'@canlang/cloudflare/deploy/bundle';
let checks=0;const reject=(fn,match)=>{let error;try{fn()}catch(e){error=e}if(!error||!match.test(error.message))throw Error('missing refusal '+String(error));checks++};
for(const spec of ['cookie','@scure/base','csv-parse/browser/esm/sync','#identity-byte-compare','node:crypto'])reject(()=>{const modules={'a.js':`import x from ${JSON.stringify(spec)};export default x;`};assertWorkerdLoadable(modules);assertLinksResolve(modules)},/unloadable|bare|specifier|unsupported|built-in|builtin/i);
reject(()=>assertLinksResolve({'a.js':'import x from "./missing.js";export default x;'}),/no such staged module/);
const artifact={artifact_version:1,language_version:'1.0.0',tool_version:'0.1.0',sources:[{path:'refusal.can',sha256:'0'.repeat(64)}],modules:[{path:'refusal.js',js:'import x from "cookie";export default x;',map:{version:3,file:'refusal.can',sources:[],sourcesContent:[],names:[],mappings:''}}],callables:[],operations:[],pages:[],requires:[],tests:[]};
reject(()=>buildDeployBundle(artifact,{verdict:{active:true}}),/unloadable|unsupported|bare|specifier|import/i);
const manifest=new URL('./node_modules/cookie/package.json',import.meta.url);const bytes=fs.readFileSync(manifest);try{const m=JSON.parse(bytes);m.version='2.0.0';fs.writeFileSync(manifest,JSON.stringify(m));reject(()=>buildDeployBundle({...artifact,modules:[{...artifact.modules[0],js:'export const x=1;'}]},{verdict:{active:true}}),/unexpected pinned browser entry for cookie/)}finally{fs.writeFileSync(manifest,bytes)}
console.log(JSON.stringify({checks,artifactAuthorityUnexpanded:true,pinRefusal:true}));
