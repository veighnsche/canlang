// Replay after building this directory's pinned scratch Cargo manifest.
// Usage: node probe.mjs /path/to/canlang-pass3-locale-candidate
import * as v from '@canlang/values';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const binary = process.argv[2];
if (!binary) throw new Error('Supply the pinned locale candidate binary');
const tags=['','en-u-ca-gregory','en-x-private','en-US-US','sl-rozaj-rozaj','EN-us','iw','he','en_US','x-private','und','i-klingon','en-GB-oed','zh-min-nan','en-123','en-12','en-1234','en-000','en-001','en-1A2','en-u-ca-gregory-ca-buddhist','en-u-abc-abc','en-a-foo-a-bar','abcd','abcde','abcdefgh','abcdefghi','abcde-US-u-ca-gregory','en-t-abcde','en-u-ca-islamicc','sh','mo','en-SU','en-u-kn-true','en-t-iw','en-x-a','en-t-en-us','en-t-m0-true','en-t-m0-foo-m0-bar','en-u-1a-abc','en-u-a1-abc','en-u-ca','en-u','en-x','en-a-a','en-a-12','en-t-en-US-US','en-t-sl-rozaj-rozaj','sl-ROZAJ-rozaj','en-Latn-US','en-US-Latn','en💥','💥💥💥'];
const lines=execFileSync(binary,tags,{encoding:'utf8',timeout:10000}).trimEnd().split('\n');
const core=lines.map(l=>{const [input,status,result]=l.split('\t');return {input,ok:status==='OK',result}});
function capture(f){try{return {ok:true,value:f()}}catch(e){return {ok:false,name:e.name,code:e.code??null,message:e.message,violations:e.violations??null}}}
const cases=tags.map((s,i)=>({input:s,core:core[i],canonical:capture(()=>v.canonicalLocale(s)),decode:capture(()=>v.decodeValue('locale',s)),encode:capture(()=>v.encodeValue('locale',s)),descriptor:capture(()=>v.makeMessageDescriptor('S',{[s]:'V'}).variants)}));
const duplicates=[['iw','he'],['nl','NL'],['en-u-ca-islamicc','en-u-ca-islamic-civil'],['sh','sr-Latn'],['en-u-kn-true','en-u-kn'],['en-t-iw','en-t-he']].map(tags=>({tags,result:capture(()=>v.makeMessageDescriptor('S',Object.fromEntries(tags.map(t=>[t,'V']))).variants)}));
const entry = import.meta.resolve('@canlang/values');
const result={host:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},entry,entry_sha256:createHash('sha256').update(readFileSync(fileURLToPath(entry))).digest('hex'),candidate:{crate:'icu_locale_core',version:'2.3.0',features:['alloc'],defaultFeatures:false,binary_sha256:createHash('sha256').update(readFileSync(binary)).digest('hex')},cases,duplicates};
console.log(JSON.stringify(result,null,2));
