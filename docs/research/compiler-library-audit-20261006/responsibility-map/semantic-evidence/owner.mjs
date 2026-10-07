// Actual installed public exports. Independent contracts are classified outside this observer.
import * as v from '@canlang/values';
import * as ui from '@canlang/ui';
const out=[];
function observe(id,owner,input,fn){
 try { const value=fn(); out.push({id,owner,input,accepted:true,value}); }
 catch(e){out.push({id,owner,input,accepted:false,error:{name:e.name,code:e.code,message:e.message}});}
}
for(const [i,s] of ['a@b.com','a@b','a@localhost','a@-x.com','a@例子.公司','a\u00a0@b.com'].entries()){
 observe(`email-${i}`,'values.decodeValue',s,()=>v.decodeValue('email',s));
 observe(`email-encode-${i}`,'values.encodeValue',s,()=>v.encodeValue('email',s));
}
for(const [i,s] of ['UTC','America/New_York','Mars/Olympus','GMT0','Etc/GMT+5'].entries())
 observe(`timezone-${i}`,'values.assertTimezone',s,()=>v.assertTimezone(s));
for(const s of ['9223372036854775807','9223372036854775808','-9223372036854775808','-9223372036854775809'])
 observe('int-'+s,'values.int64',s,()=>v.int64(BigInt(s)));
for(const [i,s] of ['1.2300','99999999999999999999999999999999999999','999999999999999999999999999999999999999','0.000000000000000001','0.0000000000000000001'].entries())
 observe('decimal-'+i,'values.parseDecimal',s,()=>v.parseDecimal(s));
for(const s of ['2000-02-29','1900-02-29','0001-01-01','0099-12-31','9999-12-31'])
 observe('date-'+s,'values.date',s,()=>v.date(s));
for(const [i,s] of ['2026-01-01T00:00:00Z','2026-01-01t00:00:00z','2026-01-01T00:00:00.123000Z','2026-01-01T00:00:00.123001Z','2026-01-01T00:00:60Z','2026-01-01T00:00:00+23:59','0001-01-01T00:00:00+00:01','9999-12-31T23:59:59-00:01'].entries())
 observe('datetime-'+i,'values.datetime',s,()=>v.datetime(s));
for(const [i,pattern,type,value] of [
 ['number','{d,number}','decimal','1.5'],['integer','{d,number,integer}','decimal','1.5'],
 ['ordinal','{d,selectordinal,one {one} other {other}}','decimal','1.5'],
 ['cardinal','{d,plural,one {one} other {other}}','decimal','1.5'],
 ['date-time','{d,time}','date','2026-01-01'],['date-date','{d,date}','date','2026-01-01'],
 ['url','{d}','url','https://example.com'],
]) {
 observe('icu-values-'+i,'values.validateMessagePattern',{pattern,type},()=>v.validateMessagePattern(pattern,{d:type}));
 observe('icu-ui-'+i,'ui.message + ui.formatMessage',{pattern,type,value},()=>ui.formatMessage(ui.message(pattern,{}, {d:{type,value}}),{locale:'en'}));
}
for(const [i,type,pattern,value] of [
 ['date-tagged','date','{d,date}',v.date('2026-01-01')],
 ['datetime-tagged','datetime','{d,date}',v.datetime('2026-01-01T00:00:00Z')],
 ['decimal-tagged','decimal','{d,number}',v.parseDecimal('1.5')],
 ['date-year1','date','{d,date}','0001-01-01'],['date-year99','date','{d,date}','0099-12-31']
])observe('ui-carrier-'+i,'ui.message + ui.formatMessage',{type,pattern,value},()=>ui.formatMessage(ui.message(pattern,{}, {d:{type,value}}),{locale:'en'}));
for(const code of ['USD','JPY','KWD','CLF','XAU','XXX','usd','ZZZ'])
 observe('currency-'+code,'values.isKnownCurrency/currencyScale',code,()=>({known:v.isKnownCurrency(code),scale:v.currencyScale(code)}));
for(const [i,s] of ['en-u-ca-gregory','en-x-private','iw','en-US-US'].entries())
 observe('locale-'+i,'values.canonicalLocale',s,()=>v.canonicalLocale(s));
console.log(JSON.stringify(out,(_,x)=>typeof x==='bigint'?{bigint:x.toString()}:x));
