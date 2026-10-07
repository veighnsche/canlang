#!/usr/bin/env python3
"""Independent admitted-source correction controls, real stdlib, no source edits."""
import hashlib,json,os,subprocess,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
pins=json.loads((HERE/'freeze.json').read_text())['files']
assert all(sha(ROOT/p)==h for p,h in pins.items())
prefix=' and '.join(['true']*80)
source='''app ReviewJoins
Given
 contract Row { v:enum(b,s,c,event,result,parent,preferences,count),a:int,items:int[],maybe:bool? }
 derive identity(value:int):int = value
 derive itemsIdentity(value:int[]):int[] = value
 derive enumIdentity(value:Row.v):Row.v = value
 derive arrayIdentity(values:Row.v[]):Row.v[] = values
 derive allCases(value:Row.v):bool = value in [b,s,c,event,result,parent,preferences,count]
 derive expected(row:Row):bool = enumIdentity(count)==row.v
 derive collectionExpected(row:Row):bool = row.v in arrayIdentity([b,s])
 derive bound(c:Row.v,b:Row.v,s:Row.v):bool = c==b and b in [s,c]
 derive nullableBound(b:Row.v?):bool = b==null or b in [s,c]
'''
source+=f' derive boundLong(c:Row.v,b:Row.v,s:Row.v):bool = {prefix} and c==b and b in [s,c]\n'
for name,expr in [
 ('awaited','identity(row.a) in itemsIdentity(row.items)'),
 ('awaitedGrouped',f'{prefix} and (identity(row.a) in itemsIdentity(row.items))'),
 ('orLazy','true or (identity(row.a) in itemsIdentity(row.items))'),
 ('orLazyLong',f'{prefix} and (true or (identity(row.a) in itemsIdentity(row.items)))'),
 ('nullishLazy','row.maybe??(identity(row.a) in itemsIdentity(row.items))'),
 ('nullishLong',f'{prefix} and (row.maybe??(identity(row.a) in itemsIdentity(row.items)))'),
]:source+=f' derive {name}(row:Row):bool = {expr}\n'
source+='When\nThen\n'
(HERE/'review-source.can').write_text(source)
runner=r'''
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const m of artifact.modules){const p=resolve(base,m.path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,m.js);}
const registry=(await import(pathToFileURL(resolve(base,artifact.modules[0].path)))).canApp();
const call=name=>{const item=artifact.callables.find(x=>x.id.endsWith('.'+name));assert(item,name);let fn=registry;for(const p of item.member)fn=fn[p];return fn;};
for(const value of ['b','s','c','event','result','parent','preferences','count'])assert.equal(await call('allCases')({},value),true);
for(const [value,expected]of [['count',true],['b',false]])assert.equal(await call('expected')({},{v:value}),expected);
for(const [value,expected]of [['b',true],['c',false]])assert.equal(await call('collectionExpected')({},{v:value}),expected);
for(const name of ['bound','boundLong']){
 assert.equal(await call(name)({},'event','event','c'),true);
 assert.equal(await call(name)({},'event','b','event'),false);
}
for(const [value,expected]of [[null,true],['s',true],['event',false]])assert.equal(await call('nullableBound')({},value),expected);
console.log('reserved/fixed/builtin case spellings and dynamic same-spelling enum parameters passed');
for(const name of ['awaited','awaitedGrouped']){
 for(const expected of [true,false]){
  const trace=[];const row={};
  Object.defineProperty(row,'a',{get(){trace.push('left');queueMicrotask(()=>trace.push('left settled'));return 2n;}});
  Object.defineProperty(row,'items',{get(){trace.push('right');queueMicrotask(()=>trace.push('right settled'));return expected?[2n]:[3n];}});
  assert.equal(await call(name)({},row),expected);assert.deepEqual(trace,['left','left settled','right','right settled']);
  console.log(name,expected,JSON.stringify(trace));
 }
 let trace=[];const leftError=Error('left rejected');const left={};Object.defineProperty(left,'a',{get(){trace.push('left');throw leftError;}});Object.defineProperty(left,'items',{get(){trace.push('right');return [2n];}});
 await assert.rejects(call(name)({},left),e=>e===leftError);assert.deepEqual(trace,['left']);
 trace=[];const rightError=Error('right rejected');const right={};Object.defineProperty(right,'a',{get(){trace.push('left');return 2n;}});Object.defineProperty(right,'items',{get(){trace.push('right');throw rightError;}});
 await assert.rejects(call(name)({},right),e=>e===rightError);assert.deepEqual(trace,['left','right']);
}
const skip={maybe:false};for(const key of ['a','items'])Object.defineProperty(skip,key,{get(){throw Error('skipped operand');}});
for(const name of ['orLazy','orLazyLong'])assert.equal(await call(name)({},skip),true);
for(const name of ['nullishLazy','nullishLong'])assert.equal(await call(name)({},skip),false);
for(const name of ['nullishLazy','nullishLong'])assert.equal(await call(name)({},{maybe:null,a:2n,items:[2n]}),true);
console.log('exact awaited failure order; compact/grouped-long or/coalesce lazy skips and taken coalesce passed');
'''
(HERE/'review-runner.mjs').write_text(runner)
receipt={'source_pins':pins,'results':[],'authored_sha256':sha(HERE/'review-source.can')}
with tempfile.TemporaryDirectory(prefix='can-joins-review-') as folder:
 scratch=Path(folder)
 for stage in ['check','compile']:
  cmd=[str(ROOT/'compiler/target/debug/can'),stage,'--format=json','--catalog',str(ROOT/'packages/values/dist/catalog.json'),str(HERE/'review-source.can')]
  result=subprocess.run(cmd,cwd=ROOT,capture_output=True,timeout=30)
  for ch in ['stdout','stderr']:(HERE/('review-'+stage+'.'+ch)).write_bytes(getattr(result,ch))
  receipt['results'].append({'name':stage,'command':cmd,'exit':result.returncode})
  if result.returncode:break
  if stage=='compile':(scratch/'artifact.json').write_bytes(result.stdout)
 else:
  p=scratch/'node_modules/@canlang';p.mkdir(parents=True);os.symlink(ROOT/'packages/stdlib',p/'stdlib')
  (scratch/'runner.mjs').write_text(runner)
  result=subprocess.run(['node',str(scratch/'runner.mjs')],capture_output=True,timeout=30)
  for ch in ['stdout','stderr']:(HERE/('review-node.'+ch)).write_bytes(getattr(result,ch))
  receipt['results'].append({'name':'node','exit':result.returncode})
receipt['binary_sha256']=sha(ROOT/'compiler/target/debug/can')
receipt['node']=subprocess.check_output(['node','--version'],text=True).strip()
receipt['runtime_pins']={p:sha(ROOT/p) for p in ['packages/stdlib/package.json','packages/stdlib/dist/src/index.js','packages/values/dist/src/index.js']}
receipt['retained_hashes']={p.name:sha(p) for p in HERE.glob('review-*') if p.suffix in ['.can','.mjs','.stdout','.stderr']}
assert all(sha(ROOT/p)==h for p,h in pins.items())
(HERE/'review-probes.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt['results']))
