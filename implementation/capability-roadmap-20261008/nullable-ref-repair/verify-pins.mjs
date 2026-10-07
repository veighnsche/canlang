import {readFile,readlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const p=JSON.parse(await readFile(new URL('./pins.json',import.meta.url),'utf8'));
const mismatches=[];let checked=0;
for(const group of ['source_after','private_source_and_outputs','private_runtime_outputs','external_tooling','evidence','immutable_before_refs'])for(const [path,expected] of Object.entries(p[group])){
 checked++;try{const actual=createHash('sha256').update(await readFile(path)).digest('hex');if(actual!==expected)mismatches.push({path,expected,actual});}catch(e){mismatches.push({path,error:e.message});}
}
for(const [path,expected] of Object.entries(p.workspace_links)){checked++;try{const actual=await readlink(path);if(actual!==expected)mismatches.push({path,expected,actual});}catch(e){mismatches.push({path,error:e.message});}}
console.log(JSON.stringify({checked,status:mismatches.length?'failed':'passed',mismatches},null,2));if(mismatches.length)process.exitCode=1;
