// Explicit capture only: immutable JS builtin and hashed owning-caller observations.
// Never run automatically from a candidate test to replace expected bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '../../..');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export function numberFromBits(hex) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt('0x' + hex), false);
  return view.getFloat64(0, false);
}
export function numberBits(n) {
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, n, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, '0');
}
export function observeError(error) {
  const fields = ['name', 'kind', 'code', 'message', 'violations'];
  const observed = { outcome: 'throw', fields: fields.map(key => ({ key, present: key in error, ...(key in error ? { value: error[key] } : {}) })) };
  if ('violations' in error) observed.violationFields = error.violations.map(v => ['path', 'code', 'message', 'expected', 'actual'].map(key => ({key, present: Object.hasOwn(v,key), ...(Object.hasOwn(v,key) ? {value:v[key]} : {})})));
  return observed;
}
export function callerCases(bits) {
  const n = hex => ({numberBits:hex});
  const cases = [];
  const add = (operation,args) => cases.push({id:`caller:${cases.length}`,operation,args});
  for (const hex of bits) {
    add('currency',[{bigint:'1'},n(hex)]);
    for (const scalar of ['int','decimal','money','date','datetime','duration']) add('decode',[scalar,n(hex)]);
  }
  for (const scale of [-1,19,-1e20,1e20,-1e21,1e21,-Number.MAX_VALUE,Number.MAX_VALUE,NaN,Infinity,-Infinity,0.5,-0,18]) {
    add('round',[{bigint:'1'},n(numberBits(scale))]);
    add('round',[{invalidOperand:true},n(numberBits(scale))]);
  }
  add('round',[{invalidOperand:true},'bad-scale']);
  for (const parts of [[1e20,1,1],[-1e20,1,1],[1e21,1,1],[0,1,1],[-0,1,1],[2024,2,30],[2024,13,1],[2024,1,0],[NaN,NaN,NaN],[2024,NaN,NaN],[2024,1,NaN],[0,1.5,1],[0,1,1.5],[2024,2,29]]) add('date',parts.map(x=>n(numberBits(x))));
  add('currency',[{invalidOperand:true},n(numberBits(1e20))]);
  for (const obj of [{extra:'a',other:'b'},{currency:7,extra:'a'}, {minor:7,currency:7,extra:'a'}]) add('decode',['money',obj]);
  return cases;
}
export function argument(v) {
  if (v && typeof v === 'object' && 'numberBits' in v) return numberFromBits(v.numberBits);
  if (v && typeof v === 'object' && 'bigint' in v) return BigInt(v.bigint);
  if (v && typeof v === 'object' && 'invalidOperand' in v) return null;
  return v;
}
export function invoke(c,kinds,decimal,wire) {
  const a=c.args.map(argument);
  try {
    const value = c.operation === 'date' ? kinds.makeDate(...a) : c.operation === 'round' ? decimal.round(...a) : c.operation === 'currency' ? kinds.makeMoney(...a) : wire.decodeValue(...a);
    // These finite successes contain only bigint coefficients and integral date parts.
    return {outcome:'return', value: Object.fromEntries(Object.entries(value).map(([key,v]) => [key,typeof v==='bigint'?{bigint:String(v)}:typeof v==='number'?{numberBits:numberBits(v)}:v]))};
  } catch (e) { return observeError(e); }
}
if (process.argv[1] === import.meta.filename) {
  const [dist,out] = process.argv.slice(2);
  assert.ok(dist && out,'usage: node numeric-text.oracle.mjs <private compiled src directory> <explicit output>');
  const frozenPath=path.join(root,'implementation/rust-port-orchestration/contracts-20261007/oracles/frozen-oracle.json.gz');
  const frozen=JSON.parse(gunzipSync(fs.readFileSync(frozenPath)));
  const numbers=[...frozen.seeded,...frozen.boundaries];
  for(const row of numbers) {
    const value=numberFromBits(row.inputBits);
    assert.equal(String(value),row.stringText,row.id); assert.equal(JSON.stringify(value),row.jsonTokenText,row.id);
  }
  const load=filename=>import(pathToFileURL(path.join(path.resolve(dist),filename)).href);
  const [kinds,decimal,wire]=await Promise.all(['kinds.js','decimal.js','wire.js'].map(load));
  const bits=[0,-0,1e20,-1e20,1e21,-1e21,1e-6,1e-7,NaN,Infinity,-Infinity,Number.MAX_VALUE].map(numberBits);
  const callers=callerCases(bits).map(c=>({...c,observation:invoke(c,kinds,decimal,wire)}));
  const donorFiles=['src/kinds.ts','src/decimal.ts','src/wire.ts','src/errors.ts'];
  const fixture={schemaVersion:1,contract:'n01.values-number-text.v1',engine:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch},frozenOracle:{path:path.relative(root,frozenPath),sha256:hash(frozenPath)},generatorSha256:hash(import.meta.filename),donorHashes:Object.fromEntries(donorFiles.map(f=>[f,hash(path.join(root,'packages/values',f))])),seed:frozen.seed,seededDistinctCount:frozen.seededDistinctCount,boundaryDistinctCount:frozen.boundaryDistinctCount,numbers,callers,limits:['Node engine observation only','Native Failure and transport tested separately','Public smoke backend SchemaError envelope unqualified','Lossless UTF-16, A03/A04/A07/default/installed acceptance unqualified']};
  fs.writeFileSync(out,JSON.stringify(fixture,null,2)+'\n');
  console.log(JSON.stringify({engine:fixture.engine,numbers:numbers.length,callers:callers.length,sha256:hash(out)}));
}
