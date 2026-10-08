import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {datetime, parseDecimal, money, encodeValue} from '@canlang/stdlib';
const [root, can, scratch] = process.argv.slice(2);
function compile(name, source, expected = 0) {
  const path = resolve(scratch, name+'.can');
  writeFileSync(path, source);
  const output = spawnSync(can, ['compile','--format=json','--catalog',resolve(root,'packages/values/dist/catalog.json'),path], {encoding:'utf8',timeout:15000});
  assert.equal(output.status, expected, output.stdout+'\n'+output.stderr);
  return JSON.parse(output.stdout);
}
const artifact = compile('collections', `app Collections
Given
 contract Box { values:money[], currency:currency }
 derive integers(values:int[]):int = sum(values)
 derive decimals(values:decimal[]):decimal = sum(values)
 derive durations(values:duration[]):duration = sum(values)
 derive monetary(values:money[],code:currency):money = sum(values,code)
 derive inferred():money = sum([money(1,"EUR"),money(2,"EUR")])
 derive ordered(box:Box):money = sum(currency=box.currency,domain=box.values)
 derive every(values:datetime[],after:datetime):bool = all(values as instant,instant>after)
 derive some(values:int[]):bool = any(values as item,item>0)
 derive shadow(item:int,values:int[]):bool = all(values as item,item>0) and item==9
 derive nested(values:int[],more:int[]):bool = all(values as item,any(more as item,item>0) and item>0)
 derive reserved(values:int[]):bool = all(values as c,c>0)
 derive named(values:int[]):bool = all(domain=values as item,predicate=item>0)
 derive constant(values:int[]):bool = all(values,true)
When
Then
`);
assert.equal(artifact.modules.length, 1);
const modulePath = resolve(scratch, 'collections.mjs');
writeFileSync(modulePath, artifact.modules[0].js);
const registry = (await import(pathToFileURL(modulePath))).canApp();
const call = (name,...args) => registry['Collections.'+name]({},...args);
assert.equal(await call('integers',[1n,2n]),3n);
assert.equal(await call('integers',[]),0n);
assert.equal(encodeValue('decimal',await call('decimals',[parseDecimal('1.2'),parseDecimal('2.3')])), '3.5');
assert.equal(encodeValue('decimal',await call('decimals',[])), '0');
assert.equal(await call('durations',[1000n,2000n]),3000n);
assert.equal(await call('durations',[]),0n);
assert.deepEqual(encodeValue('money',await call('monetary',[money(1n,'EUR'),money(2n,'EUR')],'EUR')), {minor:'300',currency:'EUR'});
assert.deepEqual(encodeValue('money',await call('monetary',[],'EUR')), {minor:'0',currency:'EUR'});
assert.deepEqual(encodeValue('money',await call('inferred')), {minor:'300',currency:'EUR'});
const trace=[];
const box={get currency(){trace.push('currency');return 'EUR'},get values(){trace.push('values');return [money(3n,'EUR')]}};
assert.deepEqual(encodeValue('money',await call('ordered',box)),{minor:'300',currency:'EUR'});
assert.deepEqual(trace,['currency','values']);
trace.length=0;
await assert.rejects(call('ordered',{get currency(){trace.push('currency');throw new Error('first')},get values(){trace.push('values');throw new Error('second')}}),{message:'first'});
assert.deepEqual(trace,['currency']);
const after=datetime('2030-01-01T00:00:00Z');
assert.equal(await call('every',[datetime('2030-01-02T00:00:00Z')],after),true);
assert.equal(await call('every',[after],after),false);
assert.equal(await call('every',[],after),true);
assert.equal(await call('some',[-1n,2n]),true);
assert.equal(await call('some',[]),false);
assert.equal(await call('shadow',9n,[1n]),true);
assert.equal(await call('shadow',8n,[1n]),false);
assert.equal(await call('nested',[1n,2n],[-1n,1n]),true);
assert.equal(await call('nested',[1n,0n],[1n]),false);
for(const name of ['reserved','named','constant']) assert.equal(await call(name,[1n]),true,name);
// A synchronous Values predicate cannot receive an awaited generated body.
const refused=compile('async-predicate',`app Invalid\nGiven\n derive truth(value:int):bool = value>0\n derive test(values:int[]):bool = all(values as item,truth(item))\nWhen\nThen\n`,10);
assert(refused.diagnostics.some(d=>d.code==='E6008'),JSON.stringify(refused));
assert.equal(refused.operations,undefined);
