// Legacy batch validation through the public adapter and real localhost HTTP.
// The endpoint scripts provider responses; fetch and adapter code are genuine.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemOneAdapter } from '@canlang/services/judgments/systemone';
import { startControlledSystemOneServer } from '@canlang/services/judgments/harness';

const options = { yes: 'Yes', no: 'No' };
const distribution = { yes: 0.5, no: 0.5 };

async function evaluate({ options: choices = options, choice = 'yes', probabilities = distribution,
  confidence = 0.5, succeeds = false }) {
  const server = await startControlledSystemOneServer({ kind: 'accept', body: {
    model: 'local-contract', answers: { route: { type: 'choice', choice, probabilities, confidence } },
    usage: { input_tokens: 4, output_tokens: 2 },
  } });
  try {
    const adapter = new SystemOneAdapter({ baseUrl: server.url, timeoutMs: 5000, maxBodyBytes: 65536,
      models: ['local-contract'], minChoiceOptions: 2, maxChoiceOptions: 26,
      minScoreLevels: 2, maxScoreLevels: 10, maxRequestBytes: 65536,
    });
    const result = await adapter.evaluate({ model: 'local-contract', state: { text: 'Classify this' },
      questions: [{ id: 'route', kind: 'choice', instructions: 'Choose a supplied option', options: choices }],
    }, { deliveryId: 'local-choice' });
    assert.equal(server.requests.length, 1, 'one request, without retry');
    const request = server.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/systemone');
    assert.deepEqual(JSON.parse(request.bodyText), {
      model: 'local-contract', state: { text: 'Classify this' }, questions: {
        route: { type: 'choice', instructions: 'Choose a supplied option', criteria: choices },
      },
    });
    assert.equal(result.delivery_id, 'local-choice');
    if (succeeds) {
      assert.equal(result.status, 'succeeded');
      assert.equal(result.error, null);
      assert.deepEqual(result.result, { model: 'local-contract', answers: [{ id: 'route', kind: 'choice',
        answer: { choice, probabilities, confidence },
      }], inputTokens: 4, outputTokens: 2 });
      const actual = result.result.answers[0].answer.probabilities;
      for (const key of Object.keys(choices)) assert.ok(Object.hasOwn(actual, key), `own probability: ${key}`);
      assert.equal(Object.getPrototypeOf(actual), Object.prototype, 'ordinary public distribution shape');
    } else {
      assert.equal(result.status, 'failed', `undeclared/malformed answer: ${JSON.stringify({ choice, probabilities, confidence })}`);
      assert.equal(result.result, null, 'never publish partial answers');
      assert.equal(result.error.code, 'invalid_response');
    }
  } finally {
    await server.close();
  }
}

test('legacy adapter rejects inherited or otherwise undeclared selected choices over HTTP', async () => {
  for (const choice of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'missing', 42]) {
    await evaluate({ choice });
  }
});

test('explicit prototype-named options and their complete own probabilities remain legal', async () => {
  for (const choice of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    await evaluate({ choice, options: Object.fromEntries([[choice, 'Declared option'], ['other', 'Other']]),
      probabilities: Object.fromEntries([[choice, 0.5], ['other', 0.5]]), succeeds: true });
  }
  await evaluate({ succeeds: true });
  await evaluate({ probabilities: { yes: 0.5000004, no: 0.5 }, succeeds: true });
});

test('own choice membership retains full distribution and confidence validation', async () => {
  for (const probabilities of [
    { yes: 1 }, { yes: 0.5, no: 0.5, extra: 0 }, { yes: 0.4, no: 0.4 },
    { yes: 0.500002, no: 0.5 }, { yes: -0.1, no: 1.1 }, { yes: '0.5', no: 0.5 },
    [0.5, 0.5], null,
  ]) await evaluate({ probabilities });
  for (const confidence of [-0.1, 1.1, '0.5', null]) await evaluate({ confidence });
});
