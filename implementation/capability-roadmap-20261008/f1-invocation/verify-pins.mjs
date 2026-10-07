import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(await readFile(new URL('./pins.json',import.meta.url)));
const mismatches=[];let checked=0;
const pins={...manifest.source_and_outputs,...manifest.private_outputs,...manifest.external_tooling,...manifest.evidence,[manifest.metadata_pins.path]:manifest.metadata_pins.sha256,[manifest.compiler_binary.path]:manifest.compiler_binary.sha256};
for(const [path,expected] of Object.entries(pins)){
 let actual;try{actual=createHash('sha256').update(await readFile(path)).digest('hex')}catch(e){actual=`${e.code}: ${e.message}`}
 checked++;if(actual!==expected)mismatches.push({path,expected,actual});
}
console.log(JSON.stringify({checked,status:mismatches.length?'failed':'passed',mismatches},null,2));
if(mismatches.length)process.exitCode=1;
