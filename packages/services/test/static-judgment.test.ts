import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { JudgmentChoiceAnswer, JudgmentNoulAnswer, JudgmentScoreAnswer } from '@canlang/contracts';
import { parseDecimal } from '@canlang/values';
import { createInstalledSystemOneJudgment, JudgmentValidationError } from '../src/judgments/systemone.js';
import type { SystemOneConfig } from '../src/judgments/systemone.js';
import { freezeJudgmentSource } from '../src/judgments/specification.js';
import { startControlledSystemOneServer } from '../src/judgments/harness.js';

const binding = { judgment: 'inbox.Triage', version: 1n, deployment: 'production.Triage', account: 'production.JudgmentAccount' };
function config(baseUrl: string): SystemOneConfig {
  return { baseUrl, timeoutMs: 1000, maxBodyBytes: 1000000, models: ['model-exact'],
    minChoiceOptions: 2, maxChoiceOptions: 26, minScoreLevels: 2, maxScoreLevels: 10, maxRequestBytes: 200000 };
}
const authoredInstructions = { source: 'How urgent?', key: 'display.urgency', params: {}, variants: {} };
const source = freezeJudgmentSource(binding.judgment, { version: binding.version, questions: [
  { name: 'urgency', kind: 'score', instructions: authoredInstructions, levels: [
    { id: 'routine', description: 'Routine' }, { id: 'urgent', description: 'Urgent' },
  ] },
  { name: 'human', kind: 'noul', instructions: 'Needs a human?', yes: 'Staff action required', no: 'Fully automatic' },
  { name: 'route', kind: 'choice', instructions: 'Which queue?', options: [
    { id: 'billing', description: 'Invoices' }, { id: 'support', description: 'Product help' },
  ] },
  { name: '__proto__', kind: 'noul', instructions: 'Own named answer?' },
] }, 'en');
const body = `{"model":"actual-model-1","answers":{
  "urgency":{"type":"score","score":8e-1,"legend":{"0":"Routine","1":"Urgent"},"probabilities":{"0":0.2,"1":0.8},"confidence":0.9},
  "human":{"type":"noul","noul":0.123456789012345678},
  "route":{"type":"choice","choice":"support","probabilities":{"support":0.8,"billing":0.2},"confidence":0.9},
  "__proto__":{"type":"noul","noul":1}},"usage":{"input_tokens":9007199254740993,"output_tokens":18}}`;

it('joins one frozen source to actual HTTP evaluation with exact numeric values and strict failure gates', async () => {
  const requests: { method: string | undefined; path: string | undefined; body: string }[] = [];
  let response = body;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk.toString();
    requests.push({ method: req.method, path: req.url, body: text });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const countedBodies: string[] = [];
  const installed = createInstalledSystemOneJudgment(config(baseUrl), binding, {
    model: 'model-exact', maxInputTokens: 50, countInputTokens: text => { countedBodies.push(text); return 50; },
  });
  const input = { source, state: 'The invoice is missing. 🌍' };
  try {
    // Changing a display key or original source object cannot alter the frozen request/revision.
    authoredInstructions.source = 'Translated display text';
    authoredInstructions.key = 'display.otherLocale';
    const completion = await installed.judgment.evaluate(input, { deliveryId: 'canonical-1' });
    assert.equal(completion.status, 'succeeded');
    assert.equal(completion.delivery_id, 'canonical-1');
    assert.ok(completion.result);
    const result = completion.result;
    assert.equal(result.specification_revision, source.specification.revision);
    assert.equal(result.model, 'actual-model-1');
    assert.equal(result.input_tokens, 9007199254740993n);
    assert.equal(result.output_tokens, 18n);
    assert.deepEqual((result.human as JudgmentNoulAnswer).probability, parseDecimal('0.123456789012345678'));
    assert.deepEqual((result.urgency as JudgmentScoreAnswer).score, parseDecimal('0.8'));
    assert.deepEqual((result.urgency as JudgmentScoreAnswer).levels.map(l => [l.level, l.index, l.description]), [
      ['routine', 0n, 'Routine'], ['urgent', 1n, 'Urgent'],
    ]);
    assert.deepEqual((result.route as JudgmentChoiceAnswer).probabilities.map(p => p.option), ['billing', 'support']);
    assert.ok(Object.hasOwn(result, '__proto__'));
    assert.deepEqual((result['__proto__'] as JudgmentNoulAnswer).probability, parseDecimal('1'));
    const sent = JSON.parse(requests[0].body);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].path, '/v1/systemone');
    assert.equal(sent.model, 'model-exact');
    assert.equal(sent.state, input.state);
    assert.deepEqual(Object.keys(sent.questions), source.order);
    assert.equal(sent.questions.urgency.instructions, 'How urgent?');
    assert.deepEqual(sent.questions.urgency.criteria, ['Routine', 'Urgent']);
    assert.deepEqual(sent.questions.human.criteria, { true: 'Staff action required', false: 'Fully automatic' });
    assert.deepEqual(Object.keys(sent.questions.route.criteria), ['billing', 'support']);
    assert.equal(countedBodies[0], requests[0].body);

    const invalidBodies = [
      body.replace(/,"usage":\{[^}]+\}/, ''),
      body.replace('"human":', '"extra":{"type":"noul","noul":0},"human":'),
      body.replace('"choice":"support"', '"choice":"billing"'),
      body.replace('"1":"Urgent"', '"1":"Provider invented legend"'),
      body.replace('0.123456789012345678', '0.1234567890123456789'),
      body.replace('"score":8e-1', '"score":0.7'),
      body.replace('"billing":0.2', '"billing":0.1'),
      body.replace('9007199254740993', '9223372036854775808'),
      body.replace('"output_tokens":18', '"output_tokens":1.5'),
      body.replace('"actual-model-1"', '""'),
      body.replace('"human":{"type":"noul"', '"human":{"type":"choice"'),
    ];
    for (const invalid of invalidBodies) {
      response = invalid;
      const failure = await installed.judgment.evaluate(input, { deliveryId: 'invalid' });
      assert.equal(failure.status, 'failed');
      assert.equal(failure.result, null);
      assert.equal(failure.error?.code, 'invalid_response');
      assert.ok(!JSON.stringify(failure).includes('Provider invented legend'));
    }
    const before = requests.length;
    const overBudget = createInstalledSystemOneJudgment(config(baseUrl), binding, {
      model: 'model-exact', maxInputTokens: 50, countInputTokens: () => 51,
    });
    await assert.rejects(overBudget.judgment.evaluate(input, { deliveryId: 'budget' }), JudgmentValidationError);
    const unavailableTokenizer = createInstalledSystemOneJudgment(config(baseUrl), binding, {
      model: 'model-exact', maxInputTokens: 50, countInputTokens: () => NaN,
    });
    await assert.rejects(unavailableTokenizer.judgment.evaluate(input, { deliveryId: 'tokenizer' }), JudgmentValidationError);
    const byteCap = createInstalledSystemOneJudgment({ ...config(baseUrl), maxRequestBytes: 1 }, binding, {
      model: 'model-exact', maxInputTokens: 50, countInputTokens: () => 1,
    });
    await assert.rejects(byteCap.judgment.evaluate(input, { deliveryId: 'bytes' }), JudgmentValidationError);
    assert.throws(() => createInstalledSystemOneJudgment(config(baseUrl), binding, {
      model: 'default', maxInputTokens: 50, countInputTokens: () => 1,
    }), JudgmentValidationError);
    await assert.rejects(installed.judgment.evaluate({ source, state: '🌍'.repeat(40001) }, { deliveryId: 'state' }), JudgmentValidationError);
    await assert.rejects(installed.judgment.evaluate({ ...input, source: { ...source, order: [...source.order].reverse() } }, { deliveryId: 'order' }), JudgmentValidationError);
    await assert.rejects(installed.judgment.evaluate({ ...input, source: { ...source, specification: { ...source.specification, version: 2n } } }, { deliveryId: 'binding' }), JudgmentValidationError);
    await assert.rejects(installed.judgment.evaluate({ ...input, source: { ...source, specification: { ...source.specification, revision: 'invented' } } }, { deliveryId: 'revision' }), JudgmentValidationError);
    const uncertain = await installed.judgment.reconcile('canonical-1');
    assert.equal(uncertain.status, 'unknown');
    assert.equal(uncertain.result, null);
    assert.equal(uncertain.delivery_id, 'canonical-1');
    assert.equal(requests.length, before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('reuses the controlled HTTP harness for canonical provider status classification and redaction', async () => {
  for (const [status, expected] of [[401, 'failed'], [429, 'unknown'], [503, 'unknown']] as const) {
    const server = await startControlledSystemOneServer({ kind: 'reject', status, body: { error: 'private-provider-secret' } });
    try {
      const installed = createInstalledSystemOneJudgment(config(server.url), binding, {
        model: 'model-exact', maxInputTokens: 1000, countInputTokens: () => 1,
      });
      const completion = await installed.judgment.evaluate({ source, state: 'Message' }, { deliveryId: 'rejected' });
      assert.equal(completion.status, expected);
      assert.equal(completion.result, null);
      assert.ok(!JSON.stringify(completion).includes('private-provider-secret'));
      assert.equal(server.requests.length, 1);
    } finally { await server.close(); }
  }
});

it('freezes runtime choices through the shared inventory and validates the actual provider union', async () => {
  const declaration = 'sample.Review';
  const inventory = {
    contracts: [
      { name: `${declaration}.pick.option`, fields: [
        { name: 'id', type: `${declaration}.pick.choice` },
        { name: 'description', type: 'text', min: 1, max: 2000 },
      ] },
      { name: `${declaration}.options`, fields: [
        { name: 'pick', type: `${declaration}.pick.option[]!`, min: 1, max: 25,
          distinctBy: 'id' as const, excludedIds: ['none'] },
      ] },
    ],
    aliases: [{ name: `${declaration}.pick.choice`, type: 'text' as const, min: 1, max: 80, format: 'name' as const }],
  };
  const descriptor = { version: 1n, valueTypes: inventory, questions: [
    { name: 'pick', kind: 'choice' as const, runtime: true as const, instructions: 'Choose a candidate',
      options: [{ id: 'none', description: 'No selection' }] },
  ] };
  const candidates = { pick: [{ id: 'alpha', description: 'First candidate' }] };
  const frozen = freezeJudgmentSource(declaration, descriptor, 'en', candidates);
  candidates.pick[0].description = 'Changed after freezing';
  assert.deepEqual(frozen.specification.choice[0].options, [
    { id: 'none', description: 'No selection' }, { id: 'alpha', description: 'First candidate' },
  ]);
  assert.notEqual(freezeJudgmentSource(declaration, descriptor, 'en', candidates).specification.revision,
    frozen.specification.revision);
  for (const options of [undefined, { extra: [] }, { pick: [] },
    { pick: [{ id: 'none', description: 'Collision' }] },
    { pick: [{ id: 'alpha', description: 'One' }, { id: 'alpha', description: 'Two' }] },
    { pick: [{ id: 'not-a-name', description: 'Invalid' }] },
    { pick: [{ id: 'a'.repeat(81), description: 'Invalid' }] },
    { pick: [{ id: 'valid', description: 'a'.repeat(2001) }] }]) {
    assert.throws(() => freezeJudgmentSource(declaration, descriptor, 'en', options));
  }
  const withFixedCount = (count: number) => ({ ...inventory, contracts: inventory.contracts.map(contract =>
    contract.name === `${declaration}.options` ? { ...contract, fields: [{ ...contract.fields[0],
      min: Math.max(0, 2 - count), max: 26 - count, ...(count === 0 ? {} : { excludedIds: ['none', 'later'] }) }] } : contract) });
  const noFixedInventory = withFixedCount(0);
  delete (noFixedInventory.contracts[1].fields[0] as { excludedIds?: string[] }).excludedIds;
  const noFixed = { ...descriptor, valueTypes: noFixedInventory, questions: [{
    name: 'pick', kind: 'choice' as const, runtime: true as const, instructions: 'Choose',
  }] };
  assert.equal(freezeJudgmentSource(declaration, noFixed, 'en', { pick: [
    { id: 'alpha', description: 'A' }, { id: 'beta', description: 'B' },
  ] }).specification.choice[0].options.length, 2);
  assert.throws(() => freezeJudgmentSource(declaration, { ...noFixed,
    questions: [{ ...noFixed.questions[0], options: [] }] }, 'en', candidates));
  const fixedOnly = { ...descriptor, valueTypes: withFixedCount(2), questions: [{ ...descriptor.questions[0],
    options: [{ id: 'none', description: 'No choice' }, { id: 'later', description: 'Later' }] }] };
  assert.equal(freezeJudgmentSource(declaration, fixedOnly, 'en', { pick: [] }).specification.choice[0].options.length, 2);
  let getterCalls = 0;
  const executable = { get pick() { getterCalls += 1; return candidates.pick; } };
  assert.throws(() => freezeJudgmentSource(declaration, descriptor, 'en', executable));
  assert.equal(getterCalls, 0);
  const staticDescriptor = { version: 1n, questions: [{ name: 'pick', kind: 'choice' as const,
    instructions: 'Pick one', options: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }] }] };
  assert.equal(freezeJudgmentSource(declaration, staticDescriptor, 'en').specification.revision,
    'sha256:27b3651a6dfb51f4bf7706b60533e72bee91a2d15700744b9d0ed6f429d99996');
  assert.throws(() => freezeJudgmentSource(declaration, staticDescriptor, 'en', { pick: [] }));
  const answer = { model: 'actual-model-1', answers: { pick: { type: 'choice', choice: 'alpha',
    probabilities: { alpha: 0.9, none: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  const server = await startControlledSystemOneServer({ kind: 'accept', body: answer });
  try {
    const provider = createInstalledSystemOneJudgment(config(server.url), {
      judgment: declaration, version: 1n, deployment: 'production.Review', account: 'production.JudgmentAccount',
    }, { model: 'model-exact', maxInputTokens: 50, countInputTokens: () => 1 });
    const accepted = await provider.judgment.evaluate({ source: frozen, state: 'Untrusted candidate evidence' }, { deliveryId: 'runtime-1' });
    assert.equal(accepted.status, 'succeeded');
    assert.equal(accepted.result?.specification_revision, frozen.specification.revision);
    assert.deepEqual((accepted.result?.pick as JudgmentChoiceAnswer).probabilities.map(entry => entry.option), ['none', 'alpha']);
    const sent = JSON.parse(server.requests[0].bodyText);
    assert.deepEqual(Object.keys(sent.questions.pick.criteria), ['none', 'alpha']);
    answer.answers.pick.choice = 'unknown';
    const rejected = await provider.judgment.evaluate({ source: frozen, state: 'Same evidence' }, { deliveryId: 'runtime-2' });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.result, null);
    assert.equal(rejected.error?.code, 'invalid_response');
  } finally { await server.close(); }
});


it('portable judgment revisions retain the Node SHA-256 UTF-8 protocol', () => {
  for (const instructions of ['plain', 'Français مرحبا {literal}', 'lone\ud800']) {
    const frozen = freezeJudgmentSource('sample.Portable', { version: 7n, questions: [
      { name: 'human', kind: 'noul', instructions, yes: 'Oui', no: 'Non' },
      { name: 'route', kind: 'choice', instructions: 'Queue?', options: [
        { id: 'first', description: 'Première' }, { id: 'second', description: 'ثانية' },
      ] },
    ] }, 'fr');
    const protocol = JSON.stringify(['can-static-judgment-v1', 'sample.Portable', '7', 'fr', [
      ['noul', frozen.specification.noul[0]], ['choice', frozen.specification.choice[0]],
    ]]);
    assert.equal(frozen.specification.revision, `sha256:${createHash('sha256').update(protocol, 'utf8').digest('hex')}`);
  }
});
