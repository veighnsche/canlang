import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
