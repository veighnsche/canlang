// Finite registered-native differential. Frozen donor expectations are inputs,
// never regenerated from either candidate. All mutable output stays private.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
assert.equal(args.length, 1, 'usage: registered-differential.mjs PRIVATE_ROOT; external emitted JS is not admitted');
const [privateRoot] = args;
assert.ok(privateRoot, 'private output root required');
assert.ok(resolve(privateRoot).startsWith('/private/tmp/'), 'mutable output must be private');
mkdirSync(privateRoot, { recursive: true });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
// Original independent donor captures. A mismatch is a gate failure, never a
// new expected result or a newly accepted digest from the current checkout.
const FIXTURE_PINS = {
  'numeric-text.json':'7e4ee0155f23a7f21b62dc44a62c8a8e6e567e911ae515c1bcba1b8b1d028fa2',
  'receipts/linkage.json':'f5d2c38ef5ba3d72796343d42874de1587fdb08cace9d0d16330d31d9259dccd',
  'receipts/recovery.json':'b5b64fda283461e245230a668c31afb42021e0ff99b37ace58efa1e0cc897d8c',
  'receipts/receipt.json':'b18cf4101947da95942a212223d9517ab3629543b6c73642457cc07e6eb44751',
  'traces/refs.json':'84a141dbca6ae1a8d06c74c0a593e85db89ae4b44fabda528f2cf6ca7473d962',
  'rows/fanout_child.json':'f45c5057aed0573582b6bfefaa8e677b77dcba95650bd4c7d75862a2ded8f37f',
  'rows/dispatch.json':'ebd1abdc187b7f5e21ed39428067c4ab151b94bb633f74bcf32098e4602b1941',
  'rows/fanout_intent.json':'bbf074dd2aa4bb14cb769e43a19f0bb2226f5160f0bce7952bcbb9699ce9c175',
  'rows/fanout_checkpoint.json':'e7b03ae84429c3772fdd5109bcabfc357582379d1a5291c2520734ba7a25227a',
  'rows/supersession.json':'c7f1f6f2a5924f4dbc5009554472d9d6ea14349a1ddb83ebf22fd0422f6ca17f',
  'rows/schedule.json':'222364093c4e0f2a9f5938d28720967542d26d77f97727309e9d1513c66222b6',
  'rows/every_slot.json':'902db640c1a669aa26ff158aeeba3c16016688bebc353866bdb02155ac657c57',
  'rows/occurrence.json':'77829dda1425300b0a1b1fae57cd05a12d199704cfe9b07a4453aa2700a10c4a',
  'policy/every.json':'48d193bc044174293e2f19f2cea0826b22b22fce6d106dc9f503168e46b3deab',
  'policy/lifecycle.json':'a78374dcd84bc3be4077cbba57e2012aebf9fb16628c8f93cd05803221fe9751',
  'policy/retry.json':'630bafad41c27b5ffb8023f4d6a6f92f353c80a75f51d079d9b6748275c30018',
};
function assertFixturePins() {
  for (const [relative,expected] of Object.entries(FIXTURE_PINS))
    assert.equal(hash(join(here,'fixtures',relative)),expected,`${relative}: immutable original fixture digest`);
}
function filesBelow(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry => {
    const path=join(directory,entry.name);
    return entry.isDirectory()?filesBelow(path):[path];
  });
}
const packageRoot=join(repo,'packages/work-kernel');
function sourceSnapshot() {
  const paths=[
    ...filesBelow(join(packageRoot,'src')).filter(path=>path.endsWith('.ts')),
    ...filesBelow(join(packageRoot,'bindings')).filter(path=>path.endsWith('.ts')),
    ...filesBelow(here).filter(path=>path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.mjs')),
    ...filesBelow(join(packageRoot,'decisions')).filter(path=>path.endsWith('.rs')),
    join(packageRoot,'rust/lib.rs'),join(here,'registered-native.rs'),join(here,'native-numeric-text.rs'),
    join(packageRoot,'Cargo.toml'),join(packageRoot,'Cargo.lock'),join(packageRoot,'tsconfig.json'),join(packageRoot,'package.json'),
    join(repo,'node_modules/typescript/bin/tsc'),join(repo,'node_modules/typescript/lib/_tsc.js'),join(repo,'node_modules/typescript/package.json'),
  ];
  return Object.fromEntries([...new Set(paths)].sort().map(path=>[path.slice(repo.length+1),hash(path)]));
}
assertFixturePins();
const sourceInputsBefore=sourceSnapshot();
const tsRoot=mkdtempSync(join(privateRoot,'checked-ts-'));
const compileCommand=[process.execPath,join(repo,'node_modules/typescript/bin/tsc'),'-p',join(packageRoot,'tsconfig.json'),
  '--outDir',tsRoot,'--declaration','false','--declarationMap','false','--sourceMap','false'];
const compile=spawnSync(compileCommand[0],compileCommand.slice(1),{cwd:repo,encoding:'utf8'});
writeFileSync(join(privateRoot,'shared-tsc.log'),compile.stdout+'\n'+compile.stderr);
assert.equal(compile.status,0,`actual strict package compilation failed; see ${privateRoot}/shared-tsc.log`);
assert.deepStrictEqual(sourceSnapshot(),sourceInputsBefore,'source inputs changed during actual package compilation');
writeFileSync(join(tsRoot,'package.json'),'{'+'"type":"module"'+'}\n');
const leaves=['rows','retry','every','lifecycle','receipt','recovery','linkage'];
const emittedHashesBefore=Object.fromEntries(leaves.map(leaf=>[leaf,hash(join(tsRoot,'src',`${leaf}.js`))]));
const modules=Object.fromEntries(await Promise.all(leaves.map(async leaf=>
  [leaf,await import(pathToFileURL(join(tsRoot,'src',`${leaf}.js`)).href)])));
function bits(n) { const v=new DataView(new ArrayBuffer(8)); v.setFloat64(0,n); return v.getBigUint64(0).toString(16).padStart(16,'0'); }
function units(s) { return Array.from({length:s.length},(_,i)=>s.charCodeAt(i)); }
function encode(x) {
  if (x===undefined) return {$undefined:true};
  if (typeof x==='number') return {$bits:bits(x)};
  if (typeof x==='string') return {$u16:units(x)};
  if (Array.isArray(x)) return x.map(encode);
  if (x && typeof x==='object') return {$entries:Object.entries(x).map(([k,v])=>[units(k),encode(v)])};
  assert.ok(x===null || typeof x==='boolean', 'unsupported candidate input/output channel');
  return x;
}
function thaw(x) {
  if (Array.isArray(x)) return x.map(thaw);
  if (!x || typeof x!=='object') return x;
  if (Object.keys(x).length===1 && '$num' in x) return ({NaN,Infinity,'-Infinity':-Infinity,'-0':-0})[x.$num];
  if (Object.keys(x).length===1 && '$undef' in x) return undefined;
  return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,thaw(v)]));
}
const specifications = [
  ['rows','rows/supersession.json', c=>c.fn==='readSupersessionRow'],
  ['rows','rows/every_slot.json', c=>c.fn==='everySlotRowId'],
  ['retry','policy/retry.json', c=>c.fn==='computeBackoff' && c.id!=='backoff-nan-now'],
  ['every','policy/every.json', c=>c.fn==='computeEverySlot'],
  ['lifecycle','policy/lifecycle.json', ()=>true],
  ['receipt','receipts/receipt.json', c=>['isConsistentCompletion','isStoredReceiptPayload','isTerminalReceiptStatus'].includes(c.fn)],
  ['recovery','receipts/recovery.json', c=>c.fn==='isClaimStale'],
  ['linkage','receipts/linkage.json', c=>c.fn==='assertDispatchJoin'],
];
const records=[], coverage=[];
for (const [leaf,relative,selected] of specifications) {
  const path=join(here,'fixtures',relative), fixture=JSON.parse(readFileSync(path,'utf8'));
  const sampled=fixture.cases.filter(selected);
  coverage.push({leaf,fixture:relative,sha256:hash(path),total:fixture.cases.length,sampled:sampled.map(c=>c.id),unsampled:fixture.cases.filter(c=>!selected(c)).map(c=>c.id)});
  for (const c of sampled) records.push({key:`${leaf}/${relative}/${c.id}`,leaf,fn:c.fn,args:thaw(c.input),expect:c.expect});
}
const sourceHashes=Object.fromEntries(Object.keys(modules).map(leaf=>[leaf,hash(join(repo,'packages/work-kernel/src',`${leaf}.ts`))]));
const wire=records.map(({key,leaf,fn,args})=>({key,leaf,fn,args:encode(args)}));
const fixturePath=join(privateRoot,'shared-original-inputs.json');
writeFileSync(fixturePath,JSON.stringify(wire,null,2)+'\n');

function fault(error) {
  // Native leaf structs carry these decision channels. Keep the complete TS
  // envelope separately; absent native details/own-key identity remains a gap.
  return {name:encode(error.name),message:encode(error.name==='URIError'?'engine-variable':error.message),codePresent:'code' in error,
    code:encode(error.code),scopePresent:'scope' in error,scope:encode(error.scope)};
}
const observations=[];
for (const c of records) {
  let outcome, calls=0;
  const args=structuredClone(c.args);
  if (c.leaf==='retry') {
    const sample=args[0].random.$randomSample;
    args[0].random={nextUnit(){calls++;return sample;}};
  }
  let fullFault=null;
  try {
    const actual=modules[c.leaf][c.fn](...args);
    assert.ok(Object.hasOwn(c.expect,'ok'),`${c.key}: TS must throw original fault`);
    assert.deepStrictEqual(actual,thaw(c.expect.ok),`${c.key}: owning TS vs original frozen output`);
    outcome={ok:encode(actual)};
  } catch (error) {
    if (error.code==='ERR_ASSERTION') throw error;
    assert.ok(c.expect.throw,`${c.key}: unexpected TS fault`);
    assert.equal(error.name,c.expect.throw.name,`${c.key}: original name`);
    if (error.name!=='URIError' && error.name!=='DataCloneError') assert.equal(error.message,c.expect.throw.message,`${c.key}: original message`);
    if (Object.hasOwn(c.expect.throw,'code')) assert.equal(error.code,c.expect.throw.code,`${c.key}: original code`);
    outcome={throw:fault(error)};
    fullFault={name:encode(error.name),message:encode(error.message),ownKeys:Object.keys(error),entries:encode(Object.fromEntries(Object.entries(error)))};
  }
  observations.push({key:c.key,outcome,randomCalls:calls,fullTsFault:fullFault});
}
const native=spawnSync('cargo',['test','--offline','--locked','--manifest-path',join(repo,'packages/work-kernel/Cargo.toml'),'-j2',
  'registered_conformance::shared_original_observer','--','--exact','--ignored','--nocapture'],{
  cwd:repo,encoding:'utf8',env:{...process.env,CARGO_TARGET_DIR:join(privateRoot,'target'),CAN_WORK_SHARED_FIXTURE:fixturePath}});
writeFileSync(join(privateRoot,'shared-native.log'),native.stdout+'\n'+native.stderr);
assert.equal(native.status,0,`registered native observer failed; see ${privateRoot}/shared-native.log`);
const marker=native.stdout.split('\n').find(line=>line.startsWith('CAN_WORK_SHARED='));
assert.ok(marker,'actual native observation marker required');
const nativeObservations=JSON.parse(marker.slice('CAN_WORK_SHARED='.length));
assert.equal(nativeObservations.length,observations.length);
for(let i=0;i<observations.length;i++) {
  const {key,outcome,randomCalls}=observations[i];
  assert.deepStrictEqual(nativeObservations[i],{key,outcome,randomCalls},`${key}: actual registered Rust vs owning TS`);
}
// Detection controls mutate actual native observations, without changing frozen inputs.
const first=nativeObservations[0];assert.throws(()=>assert.deepStrictEqual({...first,key:'foreign'},first));
const bad=nativeObservations.find(x=>x.outcome.throw);assert.ok(bad);
assert.throws(()=>assert.deepStrictEqual({...bad,outcome:{throw:{...bad.outcome.throw,codePresent:!bad.outcome.throw.codePresent}}},bad));
const numeric=nativeObservations.find(x=>x.outcome.ok?.$entries?.some(([,v])=>v?.$bits));assert.ok(numeric);
assert.throws(()=>assert.deepStrictEqual({...numeric,randomCalls:numeric.randomCalls+1},numeric));
assertFixturePins();
const sourceInputsAfter=sourceSnapshot();
assert.deepStrictEqual(sourceInputsAfter,sourceInputsBefore,'TS/Rust/config inputs changed during differential execution');
const emittedHashesAfter=Object.fromEntries(leaves.map(leaf=>[leaf,hash(join(tsRoot,'src',`${leaf}.js`))]));
assert.deepStrictEqual(emittedHashesAfter,emittedHashesBefore,'executed private JS changed during differential execution');
const result={passed:true,runtime:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch},
  sourceHashes,inputSha256:hash(fixturePath),coverage,observations,nativeObservations,
  fixturePins:FIXTURE_PINS,sourceInputsBefore,sourceInputsAfter,
  executionBinding:{selfCompiled:true,freshPrivateEmit:tsRoot,compileCommand,compileExit:compile.status,
    compileLogSha256:hash(join(privateRoot,'shared-tsc.log')),emittedHashesBefore,emittedHashesAfter,externalTsRootAllowed:false},
  negativeControls:['foreign key','fault code presence','materialization/random demand'],
  limits:['finite function/case sample; unsampled cases listed',
    'comparison uses original owning work-kernel TS leaf implementations and independent frozen live-donor outputs',
    'full TS fault envelopes captured; native leaf structs do not implement details/own-key/StateError extra envelope identity',
    'no production parser/provenance/transport/opaque-ref lifecycle or Wasm/default/installed consumer proof',
    'retry original backoff-nan-now null input is outside typed f64 fact channel and is unsampled; frozen source tests remain separate']};
writeFileSync(join(privateRoot,'registered-differential.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({passed:true,cases:records.length,coverage:coverage.map(x=>({leaf:x.leaf,sampled:x.sampled.length,total:x.total}))}));
