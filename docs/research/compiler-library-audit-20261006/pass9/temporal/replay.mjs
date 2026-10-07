import fs from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../../../..',import.meta.url));
const req=createRequire(root+'/packages/values/package.json');
const resolved=req.resolve('@canlang/values');
const values=await import(pathToFileURL(resolved));
const vectors=JSON.parse(fs.readFileSync(new URL('vectors.json',import.meta.url)));
const outcomes=[];
for(const v of vectors){
 const fixture='/private/tmp/canlang-pass9-temporal-'+v.id+'.can';
 const source=`app T\nGiven\nWhen\n scenario s() by=members\n  do\n   let value = ${v.kind}(${JSON.stringify(v.text)})\nThen\n`;
 fs.writeFileSync(fixture,source);
 let runtime;try{runtime={ok:true,value:values[v.kind](v.text)};}catch(e){runtime={ok:false,code:e.code,message:e.message};}
 const c=spawnSync(root+'/compiler/target/debug/can',['check','--format=json','--catalog='+root+'/packages/values/dist/catalog.json',fixture],{encoding:'utf8'});
 outcomes.push({...v,runtime,compiler:{exit:c.status,stdout:c.stdout,stderr:c.stderr,signal:c.signal},source});
}
fs.writeFileSync(new URL('outcomes.json',import.meta.url),JSON.stringify({profile:{node:process.version,resolved,compiler:root+'/compiler/target/debug/can'},outcomes},(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n');
console.log(JSON.stringify(outcomes.map(v=>({id:v.id,expected:v.expected,runtime:v.runtime.ok,compiler:v.compiler.exit,diagnostic:v.compiler.stdout.slice(0,100)}))));
