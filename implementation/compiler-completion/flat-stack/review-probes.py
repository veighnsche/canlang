#!/usr/bin/env python3
"""Independent compiled-source review witnesses. No package/compiler writes."""
import hashlib, json, os, pathlib, subprocess, tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PINS = ['compiler/src/analysis/resolve.rs', 'compiler/src/analysis/types.rs',
        'compiler/src/codegen/ir.rs', 'compiler/src/codegen/js.rs',
        'compiler/tests/flat_expression_runtime.rs']
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
receipt = {'source_pins': {p: sha(ROOT / p) for p in PINS}, 'results': []}
zeros = '+'.join(['0'] * 80)
trues = ' and '.join(['true'] * 80)
falses = ' or '.join(['false'] * 80)
source = '''app Review
Given
 contract Row { a:int,b:int,c:int,maybe:int?,flag:bool,s:enum(draft,approved),items:int[] }
 derive identity(value:int):int = value
 derive boolIdentity(value:bool):bool = value
'''
expressions = [
 ('awaitOrder','int',f'identity(row.a)+identity(row.b)+{zeros}+identity(row.c)'),
 ('overflow','int',f'9223372036854775807+1+row.a+{zeros}'),
 ('overflowAsync','int',f'identity(row.a)+9223372036854775807+row.b+{zeros}'),
 ('coalesce','int',f'row.maybe??({zeros}+identity(row.a))'),
 ('andTaken','bool',f'{trues} and boolIdentity(row.flag)'),
 ('orTaken','bool',f'{falses} or boolIdentity(row.flag)'),
 ('nestedLazy','bool',f'{trues} and (row.flag or boolIdentity(row.a>0))'),
 ('enumExpected','bool',f'{trues} and draft==row.s and row.s in [draft,approved]'),
 ('narrowAnd','bool',f'{trues} and row.maybe!=null and identity(row.maybe)>0'),
 ('narrowOr','bool',f'{falses} or row.maybe==null or identity(row.maybe)>0'),
 ('membership','bool',f'{trues} and row.a in row.items'),
]
for name,ty,expr in expressions:
    source += f' derive {name}(row:Row):{ty} = {expr}\n'
source += ' derive textScope(binary0:text,c:text):bool = '+trues+r' and binary0=="\u0000binary-left\u0000\u0000binary-right\u0000" and c=="B"'+'\nWhen\nThen\n'
(HERE/'review-source.can').write_text(source)

runner = r'''
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const m of artifact.modules){const p=resolve(base,m.path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,m.js);assert(!m.js.includes('\0'),'unescaped marker');}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path)));
const registry=entry.canApp();
const call=name=>{const item=artifact.callables.find(x=>x.id.endsWith('.'+name));assert(item,name);let fn=registry;for(const p of item.member)fn=fn[p];return fn;};
const context={};
let trace=[];
const row={};
for(const [key,value]of [['a',1n],['b',2n],['c',3n]])Object.defineProperty(row,key,{get(){trace.push(key);queueMicrotask(()=>trace.push(key+' settled'));return value;}});
assert.equal(await call('awaitOrder')(context,row),6n);
assert.deepEqual(trace,['a','a settled','b','b settled','c','c settled']);
console.log('awaited order/once',JSON.stringify(trace));
trace=[];
const rejected={};Object.defineProperty(rejected,'a',{get(){trace.push('a');throw Error('first operand');}});Object.defineProperty(rejected,'b',{get(){trace.push('b');return 1n;}});
await assert.rejects(call('awaitOrder')(context,rejected),{message:'first operand'});assert.deepEqual(trace,['a']);
let reads=0;const skipped={};Object.defineProperty(skipped,'a',{get(){reads++;throw Error('later operand');}});
await assert.rejects(call('overflow')(context,skipped),{code:'overflow',message:'int64 out of range: 9223372036854775808'});assert.equal(reads,0);
trace=[];const asyncOverflow={};Object.defineProperty(asyncOverflow,'a',{get(){trace.push('a');return 1n;}});Object.defineProperty(asyncOverflow,'b',{get(){trace.push('b');throw Error('too late');}});
await assert.rejects(call('overflowAsync')(context,asyncOverflow),{code:'overflow',message:'int64 out of range: 9223372036854775808'});assert.deepEqual(trace,['a']);
console.log('overflow exact code/message and later operand skipped');
trace=[];const coalesce={maybe:null};Object.defineProperty(coalesce,'a',{get(){trace.push('a');return 9n;}});
assert.equal(await call('coalesce')(context,coalesce),9n);assert.deepEqual(trace,['a']);
coalesce.maybe=0n;trace=[];assert.equal(await call('coalesce')(context,coalesce),0n);assert.deepEqual(trace,[]);
for(const [name,flag]of [['andTaken',false],['orTaken',true]]){trace=[];const r={};Object.defineProperty(r,'flag',{get(){trace.push('flag');return flag;}});assert.equal(await call(name)(context,r),flag);assert.deepEqual(trace,['flag']);}
trace=[];const nested={flag:true};Object.defineProperty(nested,'a',{get(){trace.push('a');throw Error('nested skipped');}});assert.equal(await call('nestedLazy')(context,nested),true);assert.deepEqual(trace,[]);
assert.equal(await call('enumExpected')(context,{s:'draft'}),true);assert.equal(await call('enumExpected')(context,{s:'approved'}),false);
for(const [name,value,expected]of [['narrowAnd',null,false],['narrowAnd',1n,true],['narrowOr',null,true],['narrowOr',-1n,false]])assert.equal(await call(name)(context,{maybe:value}),expected);
assert.equal(await call('textScope')(context,'\0binary-left\0\0binary-right\0','B'),true);
console.log('taken/skipped conditional branches, enum expectation, narrowing, text escaping/scopes passed');
trace=[];const member={};Object.defineProperty(member,'a',{get(){trace.push('left');return 2n;}});Object.defineProperty(member,'items',{get(){trace.push('right');return [2n];}});assert.equal(await call('membership')(context,member),true);assert.deepEqual(trace,['left','right']);
console.log('long membership operand source order',JSON.stringify(trace));
'''
(HERE/'review-runner.mjs').write_text(runner)
with tempfile.TemporaryDirectory(prefix='can-flat-review-') as folder:
    scratch=pathlib.Path(folder)
    for stage in ['check','compile']:
        command=[str(ROOT/'compiler/target/debug/can'),stage,'--format=json','--catalog',str(ROOT/'packages/values/dist/catalog.json'),str(HERE/'review-source.can')]
        result=subprocess.run(command,cwd=ROOT,capture_output=True,timeout=30)
        (HERE/f'review-{stage}.stdout').write_bytes(result.stdout)
        (HERE/f'review-{stage}.stderr').write_bytes(result.stderr)
        receipt['results'].append({'name':stage,'command':command,'exit':result.returncode})
        if result.returncode: break
        if stage=='compile': (scratch/'artifact.json').write_bytes(result.stdout)
    else:
        packages=scratch/'node_modules/@canlang';packages.mkdir(parents=True)
        os.symlink(ROOT/'packages/stdlib',packages/'stdlib')
        (scratch/'runner.mjs').write_text(runner)
        result=subprocess.run(['node',str(scratch/'runner.mjs')],cwd=ROOT,capture_output=True,timeout=30)
        (HERE/'review-node.stdout').write_bytes(result.stdout);(HERE/'review-node.stderr').write_bytes(result.stderr)
        receipt['results'].append({'name':'node','exit':result.returncode})
receipt['node']=subprocess.check_output(['node','--version'],text=True).strip()
receipt['binary_sha256']=sha(ROOT/'compiler/target/debug/can')
(HERE/'review-probes.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt['results']))
