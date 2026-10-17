import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from '/Users/vince/Projects/canlang/node_modules/typescript/lib/typescript.js';
import {parseCookie,stringifySetCookie} from './cookie/package/dist/index.js';
const root='/Users/vince/Projects/canlang/';
const out='/private/tmp/canlang-rust-port-codex-step10-20261007T015711Z/identity/';
for(const name of ['ports','sessions/cookies','sessions/tokens','accounts/passwords']){const source=fs.readFileSync(root+'packages/identity/src/'+name+'.ts','utf8');const path=out+'old/'+name+'.js';fs.mkdirSync(path.slice(0,path.lastIndexOf('/')),{recursive:true});fs.writeFileSync(path,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);}
fs.writeFileSync(out+'old/package.json','{"type":"module"}');
const old=await import('./old/sessions/cookies.js');
const parse=header=>{if(header===undefined)return null;const all=parseCookie(typeof header==='string'?header:header.join('; '),{decode:s=>s});for(const [key,raw] of Object.entries(all)){if(key.trim()!=='can_session')continue;try{return decodeURIComponent(raw.trim())||null}catch{return null}}return null};
const headers=[undefined,'','can_session=x','can_session=; can_session=ok','can_session=%ZZ; can_session=ok',['can_session=%ZZ','can_session=ok'],'other=%ZZ; can_session=ok','can_session=%252F','can_session=%3B%3D','can_session="foo"',' can_session = foo ', '\u00a0can_session\u2028=\ufefffoo\u2029', '\u00a0can_session=; can_session=ok', 'can_session=%ZZ; \u00a0can_session=ok', 'can_session; can_session=ok', 'bad;can_session=x','__proto__=a;can_session=x','can_session="a;b";can_session=ok','can_session=foo=bar','can_session=%ED%A0%80'];
const vectors=headers.map(header=>({header:header??null,old:old.parseSessionCookie(header),expected:parse(header)}));
for(const v of vectors)if(v.old!==v.expected)throw Error(JSON.stringify(v));
const domains=[undefined,'example.com','.example.com','EXAMPLE.com','localhost','','a;b','a\rb','a\nb','a\0b','a b','a,b','a=b','a:b','a_b','-a','a.','é.example','a'.repeat(64)+'.com'];
const domainResults=domains.map(domain=>{try{return {domain:domain??null,serialized:stringifySetCookie({name:'can_session',value:'x',maxAge:1,domain,path:'/',httpOnly:true,secure:true,sameSite:'lax'},{encode:encodeURIComponent})}}catch(e){return {domain,error:e.constructor.name}}});
const paths=['packages/identity/src/sessions/cookies.ts','packages/identity/src/sessions/tokens.ts','packages/identity/src/accounts/passwords.ts','packages/identity/src/ports.ts','packages/identity/src/authentication/context.ts','packages/identity/src/authentication/oauth.ts','packages/identity/src/storage/d1.ts','packages/interfaces/src/http/auth.ts','packages/identity/test/sessions.test.ts','packages/identity/package.json'];
const hashes=Object.fromEntries(paths.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(root+p)).digest('hex')]));
fs.writeFileSync(out+'cookie-observations.json',JSON.stringify({node:process.version,parse:vectors,domains:domainResults,sourceSha256:hashes},null,2)+'\n');
console.log(JSON.stringify({parseVectors:vectors.length,allPreserved:true,domainResults}));
