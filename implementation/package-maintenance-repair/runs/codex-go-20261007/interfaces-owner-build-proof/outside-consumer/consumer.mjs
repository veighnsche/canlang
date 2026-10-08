import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const result={scope:'real owner-produced outside-checkout package declared exports and distribution module preloads; no installed Worker or mount claim',node:process.version,execPath:process.execPath,exports:[],modulePreloads:[],consumers:[]};
const manifest=JSON.parse(fs.readFileSync(new URL('./node_modules/@canlang/interfaces/package.json',import.meta.url)));
let root,distribution;
for(const subpath of Object.keys(manifest.exports)){
 const specifier='@canlang/interfaces'+(subpath==='.'?'':subpath.slice(1));
 try{const resolved=import.meta.resolve(specifier);const module=await import(specifier);result.exports.push({specifier,resolved,ok:true,names:Object.keys(module)});if(subpath==='.')root=module;if(subpath==='./distribution')distribution=module.distribution;}
 catch(error){result.exports.push({specifier,ok:false,error:{name:error.name,code:error.code,message:error.message}});}
}
if(root){
 assert.equal(Object.hasOwn(root,'createAssetTable'),false);
 const envelope=root.buildBusinessError('not_found','Not found.');
 const response=root.jsonErrorResponse(envelope,404);const body=await response.text();
 assert.equal(body,'{"code":"not_found","message":"Not found.","retryable":false}');
 result.consumers.push({kind:'declared-root-real-business-error-projection',status:response.status,body});
}
if(distribution){
 result.distributionModules=distribution.modules.href;
 assert.ok(distribution.modules.href.includes('/outside-consumer/node_modules/@canlang/interfaces/dist/src/'));
 function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(f=>f.isDirectory()?walk(path.join(dir,f.name)):(f.name.endsWith('.js')?[path.join(dir,f.name)]:[]));}
 for(const file of walk(fileURLToPath(distribution.modules)).sort()){
  const relative=path.relative(fileURLToPath(distribution.modules),file);const url=new URL(relative,distribution.modules).href;
  try{const module=await import(url);result.modulePreloads.push({relative,url,ok:true,exports:Object.keys(module)});}
  catch(error){result.modulePreloads.push({relative,url,ok:false,error:{name:error.name,code:error.code,message:error.message}});}
 }
}
try{await import('@canlang/interfaces/dist/src/http/assets.js');throw new Error('unexpected deep import acceptance');}
catch(error){result.deepImport={ok:false,error:{name:error.name,code:error.code,message:error.message}};assert.equal(error.code,'ERR_PACKAGE_PATH_NOT_EXPORTED');}
result.passed=result.exports.every(r=>r.ok)&&result.modulePreloads.every(r=>r.ok)&&result.modulePreloads.length===43;
const label=process.version.startsWith('v26.')?'node26':'node24';
fs.writeFileSync(new URL(`../consumer-${label}.json`,import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({node:result.node,declaredExportCount:result.exports.length,preloadedModules:result.modulePreloads.length,passed:result.passed}));
if(!result.passed)process.exitCode=1;
