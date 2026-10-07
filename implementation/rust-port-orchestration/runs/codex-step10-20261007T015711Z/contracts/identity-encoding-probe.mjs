import fs from 'node:fs';
import {pbkdf2Sync,createHash} from 'node:crypto';
import * as old from './old/sessions/tokens.js';
import {verifyPassword} from './old/accounts/passwords.js';
import {base64urlnopad,hex} from './scure-base/package/index.js';
const B64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function decode(s){if(!s.length||s.length%4===1||!/^[A-Za-z0-9_-]+$/.test(s))return null;const n=s.length%4;if(n===2||n===3){const v=B64.indexOf(s.at(-1));s=s.slice(0,-1)+B64[v & (n===2?48:60)];}try{return base64urlnopad.decode(s)}catch{return null}}
function strictHex(s){if(!s.length)return null;try{return hex.decode(s)}catch{return null}}
const texts=['','a','Zg','Zh','Zv','Zm8','Zm9','Zm_','Zg==','Zg=','Z+',' Zg','Zg\n','é','-_8','__8','___','AAAA','0g','\ud800'];
const decodeVectors=texts.map(text=>({text,expected:old.base64UrlToBytes(text)===null?null:[...old.base64UrlToBytes(text)],candidate:decode(text)===null?null:[...decode(text)]}));
for(const v of decodeVectors)if(JSON.stringify(v.expected)!==JSON.stringify(v.candidate))throw Error(JSON.stringify(v));
let checked=0;for(let len=1;len<=257;len++){const bytes=Uint8Array.from({length:len},(_,i)=>(len*13+i*79)&255);const text=base64urlnopad.encode(bytes);if(text!==old.bytesToBase64Url(bytes))throw Error('encode');for(let tail=0;tail<64;tail++){const alias=text.slice(0,-1)+B64[tail];if(JSON.stringify([...old.base64UrlToBytes(alias)])!==JSON.stringify([...decode(alias)]))throw Error('tail');checked++;}}
const hexVectors=['','0','00','FF','aB','0g','g0','+1','-1',' 1','1 ','0x','00\n0','٠٠'].map(text=>({text,oldEqualZero:old.timingSafeEqualHex(text,'00'),expected:strictHex(text)===null?null:[...strictHex(text)]}));
const bytes=Uint8Array.from({length:32},(_,i)=>i);const token=base64urlnopad.encode(bytes);const issued={bytes:[...bytes],token,sha256:createHash('sha256').update(token).digest('hex')};
const password='synthetic-contract-password';const salt=Uint8Array.from({length:16},(_,i)=>i);const key=pbkdf2Sync(password,salt,600000,32,'sha256');const saltText=base64urlnopad.encode(salt),keyText=base64urlnopad.encode(key);const canonical=`pbkdf2-sha256$600000$${saltText}$${keyText}`;const saltAlias=saltText.slice(0,-1)+B64[B64.indexOf(saltText.at(-1))|15];const keyAlias=keyText.slice(0,-1)+B64[B64.indexOf(keyText.at(-1))|3];const alias=`pbkdf2-sha256$600000$${saltAlias}$${keyAlias}`;
const passwordWitness={password,canonical,alias,canonicalVerifies:await verifyPassword(password,canonical),aliasVerifies:await verifyPassword(password,alias),wrongVerifies:await verifyPassword(password+'!',alias)};
const tokenTextWitness=['Zg','Zh'].map(text=>({text,sha256:createHash('sha256').update(text).digest('hex')}));
fs.writeFileSync('/private/tmp/canlang-rust-port-codex-step10-20261007T015711Z/identity/encoding-observations.json',JSON.stringify({node:process.version,decodeVectors,hexVectors,seedRecipe:'length=1..257, bytes[i]=(length*13+i*79)&255; replace last sextet by all64 alphabet characters',tailCasesChecked:checked,issued,passwordWitness,tokenTextWitness},null,2)+'\n');
console.log(JSON.stringify({tailCasesChecked:checked,passwordWitness,issued}));
