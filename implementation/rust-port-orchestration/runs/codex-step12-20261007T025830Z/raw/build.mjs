import fs from 'node:fs';
import {buildDeployBundle,writeDeployBundle}from'@canlang/cloudflare/deploy/bundle';
const artifact={artifact_version:1,language_version:'1.0.0',tool_version:'0.1.0',sources:[{path:'step10.can',sha256:'0'.repeat(64)}],modules:[{path:'step10.js',js:'export const marker="finite step10";',map:{version:3,file:'step10.can',sources:[],sourcesContent:[],names:[],mappings:''}}],callables:[],operations:[],pages:[],requires:[],tests:[]};
const b=buildDeployBundle(artifact,{verdict:{active:true}});writeDeployBundle(b,new URL('./staged/',import.meta.url).pathname);
if('vendor/identity/sessions/comparison-node.js'in b.modules)throw Error('Node comparison leaked');
for(const key of ['vendor/identity/sessions/comparison-worker.js','vendor/cookie/index.js','vendor/scure-base/index.js','vendor/csv-parse/sync.js'])if(!(key in b.modules))throw Error('Missing '+key);
for(const [key,src]of Object.entries(b.modules)){if(src.includes('#identity-byte-compare'))throw Error('Unresolved alias '+key);}
fs.writeFileSync(new URL('./bundle.json',import.meta.url),JSON.stringify(b));console.log(JSON.stringify({moduleCount:b.moduleCount,sha256:b.sha256,mcpBytes:b.mcpBundleBytes,nodeLeafAbsent:true}));
