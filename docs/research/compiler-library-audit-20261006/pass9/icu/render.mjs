import * as v from '@canlang/values';
function capture(f){try{return {ok:true,value:f()}}catch(e){return {ok:false,code:e.code??null,message:e.message}}}
const cases=[
 ['int-exact-above-safe','{n,plural,=9007199254740993 {exact} other {category}}',{n:{type:'int',value:9007199254740993n}},'exact'],
 ['decimal-exact','{n,plural,=1.50 {exact} other {category}}',{n:{type:'decimal',value:v.parseDecimal('1.500')}},'exact'],
 ['decimal-number-precision','{n,number}',{n:{type:'decimal',value:v.parseDecimal('9007199254740993.123456789012345678')}},'9,007,199,254,740,993.123456789012345678'],
 ['unsafe-category','{n,plural,other {#}}',{n:{type:'int',value:9007199254740993n}},null],
 ['nearest-through-select','{n,plural,other {{s,select,active {#} other {#}}}}',{n:{type:'int',value:21n},s:{type:'text',value:'active'}},'21'],
 ['nearest-inner-plural','{n,plural,other {{m,plural,other {#}} #}}',{n:{type:'int',value:21n},m:{type:'int',value:2n}},'2 21']
].map(([id,pattern,args,expected])=>({id,pattern,args,expected,result:capture(()=>v.renderMessage(pattern,args,'en'))}));
console.log(JSON.stringify({ownerEntry:import.meta.resolve('@canlang/values'),cases},(_,value)=>typeof value==='bigint'?value.toString()+'n':value,2));
