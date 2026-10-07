import {readFileSync} from "node:fs";
import {decodeMappings,lookup} from "./pinned/packages/cloudflare/src/runtime/sourcemap.ts";
const corpus=JSON.parse(readFileSync("/private/tmp/canlang-pass8-consumer/pinned/packages/cloudflare/test/fixtures/raw-source-map-contract.json","utf8"));
function observe(fn:()=>unknown){try{return {value:fn()};}catch(e:any){return {error:{name:e.name,message:e.message}};}}
let n=0;for(const c of corpus.cases){if(JSON.stringify(observe(()=>decodeMappings(c.map.mappings)))!==JSON.stringify(c.decode))throw Error(c.id+": decode");for(const q of c.lookups){const {line,column,...expected}=q;if(JSON.stringify(observe(()=>lookup(c.map,line,column)))!==JSON.stringify(expected))throw Error(c.id+": lookup");n++;}}
console.log(JSON.stringify({cases:corpus.cases.length,lookups:n,oracle:corpus.oracle},null,2));
