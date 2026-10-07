import {writeFileSync} from 'node:fs';
import {format} from '@canlang/stdlib';
import {makeMessageDescriptor,date,datetime} from '@canlang/values';
import {message} from '@canlang/ui';
const observations=[];
async function probe(id,fn){try{const value=await fn();observations.push(value===undefined?{id,success:true,resultKind:'undefined'}:{id,success:true,value})}catch(e){observations.push({id,success:false,error:{name:e.name,code:e.code,message:e.message}})}}
for(const id of ['plain-positional','message-positional','message-dynamic','message-param-default','derive-default']){
 await probe('production-'+id,async()=>{const entry=await import('./'+id+'.mjs');return entry.canApp()['T.g']({team:{timezone:'Europe/Brussels'}},'nl')});
}
await probe('actual-plain-control',()=>format('Hi {n}',{n:'Bo'}));
await probe('actual-values-descriptor-control',()=>format(makeMessageDescriptor('Hi',{nl:'Hoi'}),{locale:'nl',appDefault:'en'}));
await probe('actual-values-descriptor-no-default',()=>format(makeMessageDescriptor('Hi',{}),{locale:null}));
await probe('actual-ui-descriptor-with-options',()=>format(message('Hi',{nl:'Hoi'}),{locale:'nl',appDefault:'en'}));
await probe('values-descriptor-url-param',()=>makeMessageDescriptor('Hi {u}',{},{u:{type:'url',value:'https://example.com'}}));
await probe('values-tagged-date-control',()=>format(makeMessageDescriptor('{d,date}',{},{d:{type:'date',value:date('0001-01-01')}}),{locale:'en',appDefault:'en'}));
await probe('values-tagged-datetime-control',()=>format(makeMessageDescriptor('{d,date}',{},{d:{type:'datetime',value:datetime('2026-01-01T00:00:00Z')}}),{locale:'en',appDefault:'en',timeZone:'Europe/Brussels'}));
const out={scope:'Actual production CLI artifacts and actual installed public exports; no installed facade mutation or mocked imports. Tagged values carrier cases are direct owner controls only.',observations};
writeFileSync(new URL('./runtime-observations.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify(out,null,2));
