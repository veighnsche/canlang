import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { CompileArtifact } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { loadInstalledExampleTestkit, runCompiledExamples } from './example-bindings.test-support.js';

const source = `app NestedFixture
Given
 Customer {active:bool=true,score:int=0}
 contract Input {customer:Customer,alias:Customer,customers:Customer[],value:money,kind:text,model:text,id:text,version:int}
 Evidence {input:Input}
 policy Customer read=members
 policy Evidence read=members
 invariant Customer: row.score>=0
 fixture company=Customer {active=true}
 fixture evidence=Evidence {input={customer=company,alias=company,customers=[company],value=money(1,"EUR"),kind="ref",model="business",id="authored",version=7}}
When
 scenario inspect(input:Input,also:Customer,stage:enum(open,closed)) by=members
  require input.customer.active and input.value.minor==200
  require input.customer==input.alias and input.customer in input.customers and also==input.customer
  do require stage==closed and input.kind=="ref" and input.model=="business" and input.id=="authored" and input.version==7
  examples seed=[evidence] input=evidence.input also=company stage=open
   as,input.customer.active,input.value,also.score,stage -> company.active,company.score,evidence.input.value.minor,evidence.input.kind,evidence.input.version
   members,true,money(2,"EUR"),1,closed -> true,1,100,"ref",7
   members,false,money(2,"EUR"),1,closed -> error(rule_failed)
   members,true,money(3,"EUR"),1,closed -> error(rule_failed)
Then
`;

async function run(text: string) {
  const directory = mkdtempSync(join(tmpdir(), 'can-example-nested-'));
  try {
    const path = join(directory, 'NestedFixture.can');
    writeFileSync(path, text);
    const artifact = JSON.parse(execFileSync(join(process.cwd(), 'compiler/target/debug/can'),
      ['compile', '--format=json', `--catalog=${fileURLToPath(distribution.catalog)}`, path],
      { encoding: 'utf8' })) as CompileArtifact;
    return await runCompiledExamples({
      artifactBytes: Buffer.from(JSON.stringify(artifact)), artifactLabel: path,
      sourceRevision: 'nested-fixture-source', workerName: `nested-fixture-${randomUUID()}`,
      worker: { mainModule: 'main.mjs', modules: { 'main.mjs': 'export default {fetch(){return new Response(null,{status:404})}};' } },
      compatibilityDate: '2026-07-15', d1Binding: 'DB',
      testkit: await loadInstalledExampleTestkit(process.cwd()),
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('canonical nested fixture Contracts and row cells retain all reference versions and ordinary input overrides', async () => {
  const result = await run(source);
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 3);
});

test('nested fixture row cells still validate the owning invariant before invocation', async () => {
  const invalid = source.slice(0, source.indexOf('  examples')) + `  examples seed=[evidence] input=evidence.input also=company stage=open
   as,input.customer.score,input.value,stage -> company.score
   members,-1,money(2,"EUR"),closed -> error(rule_failed)
Then
`;
  const result = await run(invalid);
  assert.equal(result.ok, false, 'invalid fixture setup cannot satisfy an expected business rejection');
  assert.match(JSON.stringify(result.report), /invariant/i);
});
