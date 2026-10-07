// Execute production-emitted pure registry members with actual installed imports.
import { readFileSync,writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { format } from '@canlang/stdlib';
const observations=[];
for(const id of ['format-message-positional','format-plain-positional']){
 const observed=JSON.parse(readFileSync(resolve(process.argv[2],`extra-${id}.stdout`),'utf8'));
 if(observed.analysis.diagnostics.length || observed.emission.diagnostics.length)throw new Error('unqualified compiler emission');
 const file=resolve(`${id}.mjs`);writeFileSync(file,observed.emission.modules[0].js);
 const entry=await import(pathToFileURL(file));
 try {observations.push({id,success:true,value:await entry.canApp().g({})});}
 catch(e){observations.push({id,success:false,error:{name:e.name,code:e.code,message:e.message}});}
}
observations.push({id:'public-format-plain-control',success:true,value:format('Hi {n}',{n:'Bo'})});
console.log(JSON.stringify({scope:'Actual production-emitted pure functions/imports; empty context caller, no activation/server/browser or installed app path.',observations}));
