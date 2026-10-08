import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import * as stdlib from '@canlang/stdlib';
import * as values from '@canlang/values';
import * as ui from '@canlang/ui';
const here=dirname(fileURLToPath(import.meta.url));
assert.equal(stdlib.encodeValue,values.encodeValue,'installed facade retains the actual producer function');
const capture=fn=>{try{return {ok:true,value:fn()};}catch(e){return {ok:false,name:e.name,code:e.code,message:e.message};}};
const cases=[
 ['date0001','date',stdlib.date('0001-01-01'),'0001-01-01','{x,date}'],
 ['date0099','date',stdlib.date('0099-01-01'),'0099-01-01','{x,date}'],
 ['date2001','date',stdlib.date('2001-01-01'),'2001-01-01','{x,date}'],
 ['date2024','date',stdlib.date('2024-02-29'),'2024-02-29','{x,date}'],
 ['instant','datetime',stdlib.datetime('2024-03-31T22:30:00+02:00'),'2024-03-31T20:30:00.000Z','{x,time}'],
 ['decimal','decimal',new stdlib.Decimal(150n,2),'1.5','{x,number}'],
 ['decimalexact','decimal',new stdlib.Decimal(12345678901234567890123456789012345678n,18),'12345678901234567890.123456789012345678','{x,number}'],
];
const rows=[];
for(const [id,type,native,expected,pattern] of cases) {
 const encoded=stdlib.encodeValue(type,native);
 assert.equal(encoded,expected);
 assert.equal(typeof encoded,'string');
 const descriptor=ui.message(pattern,{}, {x:{type,value:encoded}});
 const rendered=capture(()=>ui.formatMessage(descriptor,{appDefaultLocale:'en',preferredLocales:[],timeZone:'UTC'}));
 if(id==='date0001'||id==='date0099')assert.equal(rendered.ok,false,'existing low-year validation remains independent');
 else assert.equal(rendered.ok,true,'existing codec output meets existing UI operand contract');
 const nativeFormatter=capture(()=>values.renderMessage(pattern,{x:{type,value:encoded}},'en',{timeZone:'UTC'}));
 assert.equal(nativeFormatter.ok,false,'Values formatter retains native carrier precondition');
 rows.push({id,type,expected,encoded,rendered,nativeFormatter});
}
const invalid=[];
for(const [id,type,input] of [['null-date','date',null],['null-datetime','datetime',null],['null-decimal','decimal',null],['date-string','date','2001-01-01'],['datetime-string','datetime','2001-01-01T00:00:00.000Z'],['decimal-string','decimal','1.5']]) {
 const result=capture(()=>stdlib.encodeValue(type,input));assert.equal(result.ok,false);assert.equal(result.code,'invalid-construction');invalid.push({id,type,result});
}
const output={scope:'existing public codec -> existing public UI descriptor/formatter only; generated modules unchanged; no compiler fix or canonical locale/timezone credit',facadeProducerIdentity:true,rows,invalid};
fs.writeFileSync(join(here,'conversion-map.json'),JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
