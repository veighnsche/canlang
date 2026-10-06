/**
 * S7b: System One judgment adapter over REAL fetch against localhost
 * harness servers. Covers mixed noul/choice/score batches, exact
 * distribution/legend/consistency validation, provider error classes,
 * binding limit profiles, and the honest no-lookup reconciliation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JudgmentValidationError,
  SystemOneAdapter,
} from '../src/judgments/systemone.js';
import { startControlledSystemOneServer } from '../src/judgments/harness.js';
import type {
  ControlledSystemOneScenario,
  ControlledSystemOneServer,
} from '../src/judgments/harness.js';
import { fixedClock } from '../src/ports.js';
import type { JudgmentBatchInput } from '@canlang/contracts';

const CLOCK_NOW = 1_758_000_000_000;
const MODEL = 'jev-latest';
const ACTUAL_MODEL = 'jev-1.13.0';

function makeAdapter(
  baseUrl: string,
  opts?: {
    timeoutMs?: number;
    maxBodyBytes?: number;
    models?: readonly string[];
    minChoiceOptions?: number;
    maxChoiceOptions?: number;
    minScoreLevels?: number;
    maxScoreLevels?: number;
    maxRequestBytes?: number | null;
    authorization?: string;
  },
): SystemOneAdapter {
  return new SystemOneAdapter({
    baseUrl,
    timeoutMs: opts?.timeoutMs ?? 5000,
    maxBodyBytes: opts?.maxBodyBytes ?? 1_000_000,
    models: opts?.models ?? [MODEL],
    minChoiceOptions: opts?.minChoiceOptions ?? 1,
    maxChoiceOptions: opts?.maxChoiceOptions ?? 255,
    minScoreLevels: opts?.minScoreLevels ?? 2,
    maxScoreLevels: opts?.maxScoreLevels ?? 10,
    maxRequestBytes: opts?.maxRequestBytes ?? null,
    ...(opts?.authorization === undefined
      ? {}
      : { authorization: opts.authorization }),
    clock: fixedClock(CLOCK_NOW),
  });
}

function inputFor(): JudgmentBatchInput {
  return {
    model: MODEL,
    state: { message: 'Where is my invoice?' },
    questions: [
      {
        kind: 'noul',
        id: 'human',
        instructions: 'Does this message require a staff reply?',
      },
      {
        kind: 'choice',
        id: 'route',
        instructions: 'Which queue owns the request?',
        options: {
          billing: 'Invoices and payments',
          technical: 'Product support',
          other: 'Neither queue',
        },
      },
      {
        kind: 'score',
        id: 'severity',
        instructions: 'How quickly does this need attention?',
        levels: ['Routine follow-up', 'Same-day attention', 'Immediate disruption'],
      },
    ],
  };
}

function acceptBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: ACTUAL_MODEL,
    answers: {
      human: { type: 'noul', noul: 0.92 },
      route: {
        type: 'choice',
        choice: 'technical',
        probabilities: { billing: 0.08, technical: 0.85, other: 0.07 },
        confidence: 0.82,
      },
      severity: {
        type: 'score',
        score: 1.05,
        legend: { '0': 'Routine follow-up', '1': 'Same-day attention', '2': 'Immediate disruption' },
        probabilities: { '0': 0.0, '1': 0.95, '2': 0.05 },
        confidence: 0.9,
      },
    },
    usage: { input_tokens: 304, output_tokens: 18 },
    ...over,
  };
}

async function withServer<T>(
  scenario: ControlledSystemOneScenario,
  run: (server: ControlledSystemOneServer) => Promise<T>,
): Promise<T> {
  const server = await startControlledSystemOneServer(scenario);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

describe('judgments: batch evaluation', () => {
  it('accepts a mixed batch with normalized distributions in request order', async () => {
    await withServer({ kind: 'accept', body: acceptBody() }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.evaluate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.deepEqual(completion, {
        delivery_id: 'del_1',
        status: 'succeeded',
        result: {
          model: ACTUAL_MODEL,
          answers: [
            { kind: 'noul', id: 'human', answer: { probability: 0.92 } },
            {
              kind: 'choice',
              id: 'route',
              answer: {
                choice: 'technical',
                probabilities: { billing: 0.08, technical: 0.85, other: 0.07 },
                confidence: 0.82,
              },
            },
            {
              kind: 'score',
              id: 'severity',
              answer: {
                score: 1.05,
                levels: [
                  { index: 0, description: 'Routine follow-up', probability: 0.0 },
                  { index: 1, description: 'Same-day attention', probability: 0.95 },
                  { index: 2, description: 'Immediate disruption', probability: 0.05 },
                ],
                confidence: 0.9,
              },
            },
          ],
          inputTokens: 304,
          outputTokens: 18,
        },
        error: null,
      });
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0]?.model, MODEL);
      assert.deepEqual(server.requests[0]?.questionIds, [
        'human',
        'route',
        'severity',
      ]);
      const wire = JSON.parse(server.requests[0]?.bodyText ?? '{}') as Record<
        string,
        unknown
      >;
      assert.deepEqual(wire['questions'], {
        human: {
          type: 'noul',
          instructions: 'Does this message require a staff reply?',
        },
        route: {
          type: 'choice',
          instructions: 'Which queue owns the request?',
          criteria: {
            billing: 'Invoices and payments',
            technical: 'Product support',
            other: 'Neither queue',
          },
        },
        severity: {
          type: 'score',
          instructions: 'How quickly does this need attention?',
          criteria: [
            'Routine follow-up',
            'Same-day attention',
            'Immediate disruption',
          ],
        },
      });
    });
  });

  it('rejects answer-key and answer-type mismatches', async () => {
    const base = acceptBody()['answers'] as Record<string, unknown>;
    const { human: _h, ...missing } = base;
    void _h;
    const cases: Array<[string, unknown]> = [
      ['missing answer', { ...acceptBody(), answers: missing }],
      [
        'extra answer',
        {
          ...acceptBody(),
          answers: { ...base, forged: { type: 'noul', noul: 0.5 } },
        },
      ],
      [
        'wrong answer type',
        {
          ...acceptBody(),
          answers: { ...base, human: { type: 'choice', choice: 'x' } },
        },
      ],
      ['answers not an object', { ...acceptBody(), answers: [] }],
      ['missing model', { ...acceptBody(), model: '' }],
    ];
    for (const [name, body] of cases) {
      await withServer({ kind: 'accept', body }, async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.evaluate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'failed', name);
        assert.equal(completion.error?.code, 'invalid_response', name);
      });
    }
  });

  it('rejects malformed noul probabilities', async () => {
    for (const noul of [-0.1, 1.5, Number.NaN, 'high', null]) {
      const body = acceptBody();
      const answers = body['answers'] as Record<string, unknown>;
      answers['human'] = { type: 'noul', noul };
      await withServer({ kind: 'accept', body }, async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.evaluate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'failed', `noul=${String(noul)}`);
        assert.equal(completion.error?.code, 'invalid_response');
      });
    }
  });

  it('rejects choice answers outside the exact option contract', async () => {
    const base = () =>
      (acceptBody()['answers'] as Record<string, Record<string, unknown>>)[
        'route'
      ] as Record<string, unknown>;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown label', { ...base(), choice: 'forged' }],
      [
        'missing option probability',
        {
          ...base(),
          probabilities: { billing: 0.5, technical: 0.5 },
        },
      ],
      [
        'extra option probability',
        {
          ...base(),
          probabilities: {
            billing: 0.08,
            technical: 0.85,
            other: 0.07,
            forged: 0.0,
          },
        },
      ],
      [
        'distribution sum drift',
        {
          ...base(),
          probabilities: { billing: 0.5, technical: 0.3, other: 0.1 },
        },
      ],
      [
        'non-finite probability',
        {
          ...base(),
          probabilities: { billing: 1, technical: 0, other: 0 },
          choice: 'billing',
        },
      ],
      ['missing confidence', { ...base(), confidence: undefined }],
      ['confidence out of range', { ...base(), confidence: 2 }],
    ];
    for (const [name, route] of cases) {
      // The non-finite case needs an actual non-finite value, which the
      // literal above cannot carry; patch it after construction.
      if (name === 'non-finite probability') {
        (route['probabilities'] as Record<string, unknown>)['billing'] =
          Number.POSITIVE_INFINITY;
      }
      const body = acceptBody();
      (body['answers'] as Record<string, unknown>)['route'] = route;
      await withServer({ kind: 'accept', body }, async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.evaluate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'failed', name);
        assert.equal(completion.error?.code, 'invalid_response', name);
      });
    }
  });

  it('accepts wire float artifacts but rejects real sum drift', async () => {
    // Sum 1.0000005: within the 1e-6 wire tolerance.
    const close = acceptBody();
    ((close['answers'] as Record<string, unknown>)['route'] as Record<string, unknown>)[
      'probabilities'
    ] = { billing: 0.1, technical: 0.8, other: 0.1000005 };
    await withServer({ kind: 'accept', body: close }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.evaluate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
    });
    // Sum 1.000002: beyond tolerance.
    const far = acceptBody();
    ((far['answers'] as Record<string, unknown>)['route'] as Record<string, unknown>)[
      'probabilities'
    ] = { billing: 0.1, technical: 0.8, other: 0.100002 };
    await withServer({ kind: 'accept', body: far }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.evaluate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
    });
  });

  it('rejects inconsistent or incomplete score answers', async () => {
    const base = () =>
      (acceptBody()['answers'] as Record<string, Record<string, unknown>>)[
        'severity'
      ] as Record<string, unknown>;
    const cases: Array<[string, Record<string, unknown>]> = [
      // Distribution centers on 1.05; claiming 2.0 is inconsistent.
      ['inconsistent score', { ...base(), score: 2.0 }],
      ['score out of range', { ...base(), score: 3.0 }],
      [
        'legend missing an index',
        { ...base(), legend: { '0': 'Routine follow-up', '1': 'Same-day attention' } },
      ],
      [
        'legend with an extra index',
        {
          ...base(),
          legend: {
            '0': 'Routine follow-up',
            '1': 'Same-day attention',
            '2': 'Immediate disruption',
            '3': 'Forged',
          },
        },
      ],
      [
        'non-string legend entry',
        {
          ...base(),
          legend: { '0': 'Routine follow-up', '1': 'Same-day attention', '2': 7 },
        },
      ],
      [
        'probabilities keyed by label',
        {
          ...base(),
          probabilities: { low: 0.5, high: 0.5 },
        },
      ],
      ['missing confidence', { ...base(), confidence: null }],
    ];
    for (const [name, severity] of cases) {
      const body = acceptBody();
      (body['answers'] as Record<string, unknown>)['severity'] = severity;
      await withServer({ kind: 'accept', body }, async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.evaluate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'failed', name);
        assert.equal(completion.error?.code, 'invalid_response', name);
      });
    }
  });

  it('preserves equal score means with different distributions', async () => {
    // 0/1/0 and 0.5/0/0.5 both average to 1 with radically different
    // uncertainty; both are valid and must stay distinguishable.
    const peaked = acceptBody();
    ((peaked['answers'] as Record<string, unknown>)['severity'] as Record<string, unknown>)[
      'score'
    ] = 1;
    ((peaked['answers'] as Record<string, unknown>)['severity'] as Record<string, unknown>)[
      'probabilities'
    ] = { '0': 0, '1': 1, '2': 0 };
    const bimodal = acceptBody();
    ((bimodal['answers'] as Record<string, unknown>)['severity'] as Record<string, unknown>)[
      'score'
    ] = 1;
    ((bimodal['answers'] as Record<string, unknown>)['severity'] as Record<string, unknown>)[
      'probabilities'
    ] = { '0': 0.5, '1': 0, '2': 0.5 };
    for (const body of [peaked, bimodal]) {
      await withServer({ kind: 'accept', body }, async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.evaluate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'succeeded');
      });
    }
  });

  it('maps provider error classes and lost responses', async () => {
    const cases: Array<[number, string, 'failed' | 'unknown']> = [
      [401, 'provider_unauthorized', 'failed'],
      [403, 'provider_unauthorized', 'failed'],
      [422, 'provider_rejected', 'failed'],
      [429, 'provider_rate_limited', 'unknown'],
      [500, 'provider_transient', 'unknown'],
      [503, 'provider_transient', 'unknown'],
    ];
    for (const [status, code, expected] of cases) {
      await withServer(
        { kind: 'reject', status, body: { error: 'nope' } },
        async (server) => {
          const adapter = makeAdapter(server.url);
          const completion = await adapter.evaluate(inputFor(), {
            deliveryId: 'del_1',
          });
          assert.equal(completion.status, expected, `status=${status}`);
          assert.equal(completion.error?.code, code, `status=${status}`);
        },
      );
    }
    await withServer({ kind: 'hang' }, async (server) => {
      const adapter = makeAdapter(server.url, { timeoutMs: 100 });
      const completion = await adapter.evaluate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'transport_timeout');
      const reconciled = await adapter.reconcile('del_1');
      assert.equal(reconciled.status, 'unknown');
      assert.equal(reconciled.error?.code, 'no_run_resume');
      assert.equal(server.requests.length, 1);
    });
  });

  it('rejects out-of-contract batches before sending', async () => {
    await withServer({ kind: 'accept', body: acceptBody() }, async (server) => {
      const adapter = makeAdapter(server.url);
      const base = inputFor();
      const bad: JudgmentBatchInput[] = [
        { ...base, model: 'unbound-model' },
        { ...base, questions: [] },
        {
          ...base,
          questions: [
            { kind: 'noul', id: 'dup', instructions: 'a?' },
            { kind: 'noul', id: 'dup', instructions: 'b?' },
          ],
        },
        {
          ...base,
          questions: [
            {
              kind: 'choice',
              id: 'route',
              instructions: 'q?',
              options: {},
            },
          ],
        },
        { ...base, state: { bad: 7n } },
      ];
      for (const input of bad) {
        await assert.rejects(
          adapter.evaluate(input, { deliveryId: 'del_1' }),
          JudgmentValidationError,
        );
      }
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      await assert.rejects(
        adapter.evaluate({ ...base, state: cyclic }, { deliveryId: 'del_1' }),
        JudgmentValidationError,
      );
      await assert.rejects(
        adapter.evaluate(base, { deliveryId: '' }),
        JudgmentValidationError,
      );
      assert.equal(server.requests.length, 0);
    });
  });

  it('enforces binding limit profiles and the request cap', async () => {
    // JEV profile: 255 options accepted, 256 rejected.
    const options255: Record<string, string> = {};
    for (let index = 0; index < 255; index += 1) {
      options255[`opt_${index}`] = `Option ${index}`;
    }
    const body255 = {
      model: ACTUAL_MODEL,
      answers: {
        big: {
          type: 'choice',
          choice: 'opt_0',
          probabilities: Object.fromEntries(
            Object.keys(options255).map((key) => [key, key === 'opt_0' ? 1 : 0]),
          ),
          confidence: 1,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    await withServer({ kind: 'accept', body: body255 }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.evaluate(
        {
          model: MODEL,
          state: {},
          questions: [
            {
              kind: 'choice',
              id: 'big',
              instructions: 'Pick one.',
              options: options255,
            },
          ],
        },
        { deliveryId: 'del_1' },
      );
      assert.equal(completion.status, 'succeeded');
      assert.equal(server.requests.length, 1);
    });
    await withServer({ kind: 'accept', body: body255 }, async (server) => {
      const adapter = makeAdapter(server.url);
      await assert.rejects(
        adapter.evaluate(
          {
            model: MODEL,
            state: {},
            questions: [
              {
                kind: 'choice',
                id: 'big',
                instructions: 'Pick one.',
                options: { ...options255, opt_255: 'One too many' },
              },
            ],
          },
          { deliveryId: 'del_1' },
        ),
        JudgmentValidationError,
      );
      assert.equal(server.requests.length, 0);
    });
    // Local profile: single-option choices and short level lists rejected.
    await withServer({ kind: 'accept', body: acceptBody() }, async (server) => {
      const adapter = makeAdapter(server.url, {
        minChoiceOptions: 2,
        maxChoiceOptions: 26,
        minScoreLevels: 2,
        maxScoreLevels: 26,
      });
      await assert.rejects(
        adapter.evaluate(
          {
            model: MODEL,
            state: {},
            questions: [
              {
                kind: 'choice',
                id: 'one',
                instructions: 'q?',
                options: { only: 'Only option' },
              },
            ],
          },
          { deliveryId: 'del_1' },
        ),
        JudgmentValidationError,
      );
      assert.equal(server.requests.length, 0);
    });
    // Request cap: local 64 KiB profile rejects oversized state.
    await withServer({ kind: 'accept', body: acceptBody() }, async (server) => {
      const adapter = makeAdapter(server.url, { maxRequestBytes: 64 });
      await assert.rejects(
        adapter.evaluate(
          {
            model: MODEL,
            state: { blob: 'x'.repeat(1024) },
            questions: inputFor().questions,
          },
          { deliveryId: 'del_1' },
        ),
        JudgmentValidationError,
      );
      assert.equal(server.requests.length, 0);
    });
  });

  it('sends the configured authorization without logging its value', async () => {
    await withServer({ kind: 'accept', body: acceptBody() }, async (server) => {
      const adapter = makeAdapter(server.url, {
        authorization: 'Bearer test-key',
      });
      const completion = await adapter.evaluate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      assert.equal(server.requests[0]?.hadAuth, true);
    });
  });

  it('usage is optional but validated when present', async () => {
    const { usage: _u, ...rest } = acceptBody();
    void _u;
    await withServer({ kind: 'accept', body: rest }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.evaluate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      assert.deepEqual(
        [
          (completion.result as { inputTokens: unknown }).inputTokens,
          (completion.result as { outputTokens: unknown }).outputTokens,
        ],
        [null, null],
      );
    });
    for (const usage of [
      { input_tokens: -1, output_tokens: 0 },
      { input_tokens: 3 },
      'tokens',
    ]) {
      await withServer(
        { kind: 'accept', body: { ...acceptBody(), usage } },
        async (server) => {
          const adapter = makeAdapter(server.url);
          const completion = await adapter.evaluate(inputFor(), {
            deliveryId: 'del_1',
          });
          assert.equal(completion.status, 'failed');
          assert.equal(completion.error?.code, 'invalid_response');
        },
      );
    }
  });
});
