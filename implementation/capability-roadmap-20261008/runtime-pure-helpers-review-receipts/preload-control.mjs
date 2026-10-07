import assert from 'node:assert/strict';
import {readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root='/private/tmp/canlang-runtime-pure-after-db57c379';
const require=createRequire(`${root}/packages/cloudflare/package.json`);
const valuesPath=require.resolve('@canlang/values');
const runtime=await import(`${root}/packages/cloudflare/dist/runtime/stdlib.js`);
const values=await import(valuesPath);
const checks=[];
for(const n of ['int64','datetime','compareInstant']) { assert.equal(runtime[n],values[n]);checks.push(`${n} exact function identity`); }
for(const [input,code] of [[1,'invalid-construction'],['1','invalid-construction'],[2n**63n,'overflow'],[-(2n**63n)-1n,'overflow']]) {
 assert.throws(()=>runtime.int64(input),e=>e instanceof values.ValueError&&Object.getPrototypeOf(e)===values.ValueError.prototype&&e.code===code);checks.push(`int64 ${typeof input} rejection ${code}`);
}
assert.equal(runtime.int64(-(2n**63n)),-(2n**63n));assert.equal(runtime.int64(2n**63n-1n),2n**63n-1n);
const a=runtime.datetime('2026-10-08T00:00:00Z'),b=runtime.datetime('2026-10-08T02:00:00+02:00'),c=runtime.datetime('2026-10-08T00:00:00.001Z');
assert.equal(runtime.compareInstant(a,b),0);assert.equal(runtime.compareInstant(a,c),-1);assert.equal(runtime.compareInstant(c,a),1);assert.equal(Object.isFrozen(a),true);assert.equal(typeof a.ms,'bigint');
assert.throws(()=>runtime.datetime('malformed'),e=>e instanceof values.ValueError&&e.message==='invalid datetime text: malformed');
checks.push('int64 boundaries','datetime offset/order/frozen bigint carrier','datetime producer error identity');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const receipt={node:process.version,node_exec:process.execPath,node_exec_realpath:realpathSync(process.execPath),node_exec_sha256:sha(process.execPath),values_path:valuesPath,runtime_path:`${root}/packages/cloudflare/dist/runtime/stdlib.js`,checks,all_passed:true};
writeFileSync(fileURLToPath(new URL('./preload-control.json',import.meta.url)),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
