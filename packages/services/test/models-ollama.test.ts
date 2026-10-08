/**
 * S7a: Ollama chat adapter over REAL fetch against localhost harness
 * servers. Covers final-only generation, NDJSON streaming with
 * partial/final/cancelled distinctions, mid-stream errors, per-run
 * cancellation isolation, model/limit validation, and the honest
 * no-resume reconciliation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelValidationError,
  OllamaChatAdapter,
  classifyStreamLine,
  readFinalChatReply,
} from '../src/models/ollama.js';
import type {
  FrozenChatRequest,
  OllamaTextGenerationInstallation,
} from '../src/models/ollama.js';
import { startControlledOllamaServer } from '../src/models/harness.js';
import type {
  ControlledOllamaScenario,
  ControlledOllamaServer,
} from '../src/models/harness.js';
import { fixedClock } from '../src/ports.js';
import type {
  ModelChatInput,
  ModelRunSnapshot,
  TextRequest,
} from '@canlang/contracts';

const CLOCK_NOW = 1_758_000_000_000;
const MODEL = 'llama-test';

function makeAdapter(
  baseUrl: string,
  opts?: {
    timeoutMs?: number;
    maxBodyBytes?: number;
    models?: readonly string[];
    maxOutputTokens?: number;
    authorization?: string;
  },
): OllamaChatAdapter {
  return new OllamaChatAdapter({
    baseUrl,
    timeoutMs: opts?.timeoutMs ?? 5000,
    maxBodyBytes: opts?.maxBodyBytes ?? 1_000_000,
    models: opts?.models ?? [MODEL],
    maxOutputTokens: opts?.maxOutputTokens ?? 4096,
    ...(opts?.authorization === undefined
      ? {}
      : { authorization: opts.authorization }),
    clock: fixedClock(CLOCK_NOW),
  });
}

function inputFor(over: Partial<ModelChatInput> = {}): ModelChatInput {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 64,
    ...over,
  };
}

async function withServer<T>(
  scenario: ControlledOllamaScenario,
  run: (server: ControlledOllamaServer) => Promise<T>,
): Promise<T> {
  const server = await startControlledOllamaServer(scenario);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

function finalBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    message: { role: 'assistant', content: 'Hi there' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    eval_count: 4,
    ...over,
  };
}

function doneLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    eval_count: 4,
    ...over,
  };
}

function textInput(over: Partial<TextRequest> = {}): TextRequest {
  return {
    source: 'operation_1',
    revision: 1,
    profile: 'local-chat',
    policy_revision: 'policy-1',
    messages: [{ role: 'user', content: 'Hello', attachments: [] }],
    max_input_tokens: 12,
    max_output_tokens: 64,
    max_duration: 1000n,
    ...over,
  };
}

function textInstallation(
  over: Partial<OllamaTextGenerationInstallation> = {},
): OllamaTextGenerationInstallation {
  return {
    binding: {
      capability: 'std.TextGenerationV1', capabilityVersion: 1,
      deployment: 'deployment.llm', account: 'local',
    },
    profile: 'local-chat', policyRevision: 'policy-1', model: MODEL,
    maxInputTokens: 1024,
    // Controlled deployment-count result, not a production tokenizer implementation.
    countInputTokens: () => 12,
    ...over,
  };
}

describe('models: installed std text generation', () => {
  it('derives identity and ceilings from the same adapter and sends the counted frozen request', async () => {
    await withServer({ kind: 'final', body: finalBody() }, async (server) => {
      const adapter = makeAdapter(server.url, { maxOutputTokens: 128, timeoutMs: 2000 });
      const input = textInput();
      let counted: FrozenChatRequest | undefined;
      const config = textInstallation({ countInputTokens: request => {
        counted = request;
        assert.ok(Object.isFrozen(request));
        assert.ok(Object.isFrozen(request.messages));
        assert.ok(Object.isFrozen(request.messages[0]));
        input.messages[0]!.content = 'Changed after authorization';
        input.max_output_tokens = 9000;
        return 12;
      } });
      const installed = adapter.installTextGeneration(config);
      config.binding.deployment = 'deployment.changed';
      assert.equal(installed.binding.deployment, 'deployment.llm');
      assert.deepEqual(installed.profile, {
        name: 'local-chat', policyRevision: 'policy-1', provider: 'ollama', model: MODEL,
        maxInputTokens: 1024, maxOutputTokens: 128, maxDurationMs: 2000,
        inputTokenization: 'deployment', attachments: 'unsupported',
      });
      assert.ok(Object.isFrozen(installed));
      const completion = await installed.text.generate(input, { deliveryId: 'text_1' });
      assert.equal(completion.status, 'succeeded');
      assert.equal(counted?.createdAt, CLOCK_NOW);
      const wire = JSON.parse(server.requests[0]!.bodyText);
      assert.equal(wire.model, counted?.model);
      assert.deepEqual(wire.messages, counted?.messages);
      assert.deepEqual(wire.options, { num_predict: counted?.maxTokens });
      assert.deepEqual(wire.messages, [{ role: 'user', content: 'Hello' }]);
      assert.equal(wire.options.num_predict, 64);
    });
  });

  it('refuses unsupported mapping/tokenization and mismatched or over-budget requests before bytes', async () => {
    await withServer({ kind: 'final', body: finalBody() }, async (server) => {
      const adapter = makeAdapter(server.url);
      const installed = adapter.installTextGeneration(textInstallation());
      const inputs = [
        textInput({ source: '' }),
        textInput({ revision: -1 }),
        textInput({ revision: 1.5 }),
        textInput({ revision: Number.MAX_SAFE_INTEGER + 1 }),
        textInput({ profile: 'other-profile' }),
        textInput({ policy_revision: 'other-policy' }),
        textInput({ messages: [{ role: 'user', content: 'Hello', attachments: ['file_1'] }] }),
        textInput({ max_input_tokens: 11 }),
        textInput({ max_input_tokens: 1025 }),
        textInput({ max_input_tokens: 0 }),
        textInput({ max_output_tokens: 4097 }),
        textInput({ max_duration: 5001n }),
        textInput({ max_duration: 0n }),
      ];
      for (const input of inputs) {
        await assert.rejects(installed.text.generate(input, { deliveryId: 'text_1' }), ModelValidationError);
        assert.throws(() => installed.text.generateStream(input, { deliveryId: 'text_1' }), ModelValidationError);
      }
      const unsupported = adapter.installTextGeneration(textInstallation({ countInputTokens: undefined }));
      assert.equal(unsupported.profile.inputTokenization, 'unsupported');
      await assert.rejects(unsupported.text.generate(textInput(), { deliveryId: 'text_1' }), ModelValidationError);
      assert.throws(() => unsupported.text.generateStream(textInput(), { deliveryId: 'text_1' }), ModelValidationError);
      assert.equal(server.requests.length, 0);
    });
  });

  it('refuses invalid token counts, count failure and mutations of the original input budget', async () => {
    await withServer({ kind: 'final', body: finalBody() }, async (server) => {
      const adapter = makeAdapter(server.url);
      for (const count of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const installed = adapter.installTextGeneration(textInstallation({ countInputTokens: () => count }));
        await assert.rejects(installed.text.generate(textInput(), { deliveryId: 'text_1' }), ModelValidationError);
      }
      const broken = adapter.installTextGeneration(textInstallation({ countInputTokens: () => { throw new Error('private tokenizer failure'); } }));
      await assert.rejects(broken.text.generate(textInput(), { deliveryId: 'text_1' }), /could not count/);
      const input = textInput({ max_input_tokens: 11 });
      const mutating = adapter.installTextGeneration(textInstallation({ countInputTokens: () => {
        input.max_input_tokens = 1024;
        return 12;
      } }));
      await assert.rejects(mutating.text.generate(input, { deliveryId: 'text_1' }), /requested input budget/);
      assert.equal(server.requests.length, 0);
    });
  });

  it('refuses unsupported installation identities and deadline ceilings before bytes', async () => {
    await withServer({ kind: 'final', body: finalBody() }, async (server) => {
      const adapter = makeAdapter(server.url);
      const config = textInstallation();
      for (const over of [
        { model: 'not-bound' }, { profile: '' }, { policyRevision: '' }, { maxInputTokens: 0 },
        { binding: { ...config.binding, capability: 'ai.ChatV1' } },
        { binding: { ...config.binding, capabilityVersion: 2 } },
      ]) {
        assert.throws(() => adapter.installTextGeneration(textInstallation(over)), ModelValidationError);
      }
      for (const timeoutMs of [1.5, 2_147_483_648]) {
        assert.throws(() => makeAdapter(server.url, { timeoutMs }).installTextGeneration(config), ModelValidationError);
      }
      assert.equal(server.requests.length, 0);
    });
  });

  it('uses each requested duration for final and streamed transport instead of the larger adapter timeout', async () => {
    await withServer({ kind: 'hang' }, async (server) => {
      const installed = makeAdapter(server.url).installTextGeneration(textInstallation());
      const input = textInput({ max_duration: 80n });
      const startedAt = performance.now();
      const final = await installed.text.generate(input, { deliveryId: 'text_final' });
      assert.equal(final.status, 'unknown');
      assert.equal(final.error?.code, 'transport_timeout');
      const stream = installed.text.generateStream(input, { deliveryId: 'text_stream' });
      const streamed = await stream.done();
      assert.equal(streamed.status, 'unknown');
      assert.equal(streamed.error?.code, 'transport_timeout');
      assert.ok(performance.now() - startedAt < 1500, 'two 80ms requests must not use the 5000ms adapter timeout');
      assert.equal(server.requests.length, 2);
      const expired = installed.text.generateStream(textInput({ max_duration: 20n }), {
        deliveryId: 'text_observer_expired',
        onSnapshot: snapshot => {
          if (snapshot.sequence === 0) {
            const observerEndsAt = performance.now() + 30;
            while (performance.now() < observerEndsAt) {
              // The synchronous initial observer consumes the same request deadline.
            }
          }
        },
      });
      const beforeTransport = await expired.done();
      assert.equal(beforeTransport.status, 'failed');
      assert.equal(beforeTransport.error?.code, 'transport_timeout');
      assert.match(beforeTransport.error?.message ?? '', /before provider transport/);
      assert.equal(expired.snapshots().at(-1)?.state, 'failed');
      assert.equal(server.requests.length, 2, 'an expired initial observer must send no provider request');
      const reconciled = await installed.text.reconcile('text_final');
      assert.equal(reconciled.status, 'unknown');
      assert.equal(reconciled.error?.code, 'no_run_resume');
      assert.equal(server.requests.length, 2);
    });
  });

  it('counts once and uses that frozen transcript and output budget for a successful stream', async () => {
    await withServer({ kind: 'stream', lines: [
      { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false }, doneLine(),
    ] }, async (server) => {
      let calls = 0;
      let counted: FrozenChatRequest | undefined;
      const installed = makeAdapter(server.url).installTextGeneration(textInstallation({ countInputTokens: request => {
        calls += 1;
        counted = request;
        return 12;
      } }));
      const seen: ModelRunSnapshot[] = [];
      const run = installed.text.generateStream(textInput(), { deliveryId: 'text_stream', onSnapshot: snapshot => seen.push(snapshot) });
      assert.equal((await run.done()).status, 'succeeded');
      assert.equal(calls, 1);
      assert.deepEqual(seen, run.snapshots());
      const wire = JSON.parse(server.requests[0]!.bodyText);
      assert.equal(wire.stream, true);
      assert.deepEqual(wire.messages, counted?.messages);
      assert.deepEqual(wire.options, { num_predict: counted?.maxTokens });
    });
  });
});

describe('models: final-only generation', () => {
  it('accepts a valid final reply with usage', async () => {
    await withServer({ kind: 'final', body: finalBody() }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.generate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.deepEqual(completion, {
        delivery_id: 'del_1',
        status: 'succeeded',
        result: {
          content: 'Hi there',
          model: MODEL,
          finish: 'stop',
          inputTokens: 12,
          outputTokens: 4,
        },
        error: null,
      });
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0]?.stream, false);
      assert.equal(server.requests[0]?.model, MODEL);
      const wire = JSON.parse(server.requests[0]?.bodyText ?? '{}') as Record<
        string,
        unknown
      >;
      assert.deepEqual(wire['messages'], [
        { role: 'user', content: 'Hello' },
      ]);
      assert.deepEqual(wire['options'], { num_predict: 64 });
    });
  });

  it('HTTP 200 without done:true is not a completed reply', async () => {
    for (const body of [
      finalBody({ done: false }),
      finalBody({ message: { role: 'assistant', content: 7 } }),
      finalBody({ done_reason: '' }),
      { unexpected: 'shape' },
      'plain text, not json',
    ]) {
      await withServer({ kind: 'final', body }, async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.generate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'failed');
        assert.equal(completion.error?.code, 'invalid_response');
      });
    }
  });

  it('absent usage never fails an otherwise complete reply', async () => {
    const { prompt_eval_count: _p, eval_count: _e, ...rest } = finalBody();
    void _p;
    void _e;
    await withServer({ kind: 'final', body: rest }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.generate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      assert.deepEqual(completion.result, {
        content: 'Hi there',
        model: MODEL,
        finish: 'stop',
        inputTokens: null,
        outputTokens: null,
      });
    });
  });

  it('maps rejection, transient and rate-limit statuses', async () => {
    await withServer(
      { kind: 'reject', status: 400, body: { error: 'bad request' } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.generate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.deepEqual(completion, {
          delivery_id: 'del_1',
          status: 'failed',
          result: null,
          error: {
            code: 'provider_rejected',
            message: 'Model provider rejected the request.',
          },
        });
      },
    );
    await withServer(
      { kind: 'reject', status: 500, body: { error: 'boom' } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.generate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'unknown');
        assert.equal(completion.error?.code, 'provider_transient');
      },
    );
    await withServer(
      { kind: 'reject', status: 429, body: { error: 'slow down' } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.generate(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'unknown');
        assert.equal(completion.error?.code, 'provider_rate_limited');
      },
    );
  });

  it('lost responses stay unknown and cannot be reconciled by lookup', async () => {
    await withServer({ kind: 'hang' }, async (server) => {
      const adapter = makeAdapter(server.url, { timeoutMs: 100 });
      const completion = await adapter.generate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'transport_timeout');
      const reconciled = await adapter.reconcile('del_1');
      assert.deepEqual(reconciled, {
        delivery_id: 'del_1',
        status: 'unknown',
        result: null,
        error: {
          code: 'no_run_resume',
          message:
            'Ollama documents no run lookup; this uncertain generation cannot be reconciled.',
        },
      });
      // Reconciliation performs no lookup request.
      assert.equal(server.requests.length, 1);
    });
  });

  it('rejects unknown models, bad inputs and over-budget requests before sending', async () => {
    await withServer({ kind: 'final', body: finalBody() }, async (server) => {
      const adapter = makeAdapter(server.url);
      await assert.rejects(
        adapter.generate(inputFor({ model: 'evil-model' }), {
          deliveryId: 'del_1',
        }),
        ModelValidationError,
      );
      await assert.rejects(
        adapter.generate(inputFor({ messages: [] }), {
          deliveryId: 'del_1',
        }),
        ModelValidationError,
      );
      await assert.rejects(
        adapter.generate(inputFor({ maxTokens: 4097 }), {
          deliveryId: 'del_1',
        }),
        ModelValidationError,
      );
      await assert.rejects(
        adapter.generate(inputFor(), { deliveryId: '' }),
        ModelValidationError,
      );
      assert.equal(server.requests.length, 0);
    });
  });

  it('sends the configured authorization without logging its value', async () => {
    await withServer({ kind: 'final', body: finalBody() }, async (server) => {
      const adapter = makeAdapter(server.url, {
        authorization: 'Bearer test-key',
      });
      const completion = await adapter.generate(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      assert.equal(server.requests[0]?.hadAuth, true);
    });
  });
});

describe('models: streaming runs', () => {
  it('streams deltas to a final reply with ordered snapshots', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false },
      { model: MODEL, message: { role: 'assistant', content: ' there' }, done: false },
      doneLine(),
    ];
    await withServer({ kind: 'stream', lines }, async (server) => {
      const adapter = makeAdapter(server.url);
      const seen: ModelRunSnapshot[] = [];
      const run = adapter.generateStream(inputFor(), {
        deliveryId: 'del_9',
        onSnapshot: (snapshot) => {
          seen.push(snapshot);
        },
      });
      const completion = await run.done();
      assert.deepEqual(completion, {
        delivery_id: 'del_9',
        status: 'succeeded',
        result: {
          content: 'Hi there',
          model: MODEL,
          finish: 'stop',
          inputTokens: 12,
          outputTokens: 4,
        },
        error: null,
      });
      const snapshots = run.snapshots();
      assert.deepEqual(
        snapshots.map((snapshot) => snapshot.sequence),
        [0, 1, 2, 3],
      );
      assert.deepEqual(
        snapshots.map((snapshot) => snapshot.state),
        ['running', 'running', 'running', 'succeeded'],
      );
      assert.deepEqual(
        snapshots.map((snapshot) => snapshot.content),
        ['', 'Hi', 'Hi there', 'Hi there'],
      );
      assert.deepEqual(seen, snapshots);
      assert.equal(server.requests[0]?.stream, true);
    });
  });

  it('mid-stream errors fail with the safe provider message and keep partials', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false },
      { error: 'model overloaded, try again' },
    ];
    await withServer({ kind: 'stream', lines }, async (server) => {
      const adapter = makeAdapter(server.url);
      const run = adapter.generateStream(inputFor(), { deliveryId: 'del_9' });
      const completion = await run.done();
      assert.deepEqual(completion, {
        delivery_id: 'del_9',
        status: 'failed',
        result: null,
        error: {
          code: 'provider_error',
          message: 'model overloaded, try again',
        },
      });
      const snapshots = run.snapshots();
      assert.equal(snapshots[snapshots.length - 1]?.state, 'failed');
      assert.equal(snapshots[snapshots.length - 1]?.content, 'Hi');
    });
  });

  it('streams ending without done:true fail and keep partial evidence', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false },
    ];
    await withServer({ kind: 'stream', lines }, async (server) => {
      const adapter = makeAdapter(server.url);
      const run = adapter.generateStream(inputFor(), { deliveryId: 'del_9' });
      const completion = await run.done();
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
      assert.equal(
        completion.error?.message,
        'Model stream ended without a completed reply.',
      );
      const snapshots = run.snapshots();
      assert.equal(snapshots[snapshots.length - 1]?.state, 'failed');
      assert.equal(snapshots[snapshots.length - 1]?.content, 'Hi');
    });
  });

  it('malformed stream lines fail loudly with partial evidence', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false },
      'this is not json',
    ];
    await withServer({ kind: 'stream', lines }, async (server) => {
      const adapter = makeAdapter(server.url);
      const run = adapter.generateStream(inputFor(), { deliveryId: 'del_9' });
      const completion = await run.done();
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
      const snapshots = run.snapshots();
      assert.equal(snapshots[snapshots.length - 1]?.content, 'Hi');
    });
  });

  it('settling early releases the connection while the server keeps sending', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false },
      { error: 'model overloaded, try again' },
      ...Array.from({ length: 20 }, () => ({
        model: MODEL,
        message: { role: 'assistant', content: 'more' },
        done: false,
      })),
    ];
    await withServer(
      { kind: 'stream', lines, lineDelayMs: 30 },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const run = adapter.generateStream(inputFor(), {
          deliveryId: 'del_9',
        });
        const completion = await run.done();
        assert.equal(completion.status, 'failed');
        assert.equal(completion.error?.code, 'provider_error');
        // The server still has ~600ms of lines scheduled; the client
        // must have hung up promptly instead of waiting for them.
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(server.activeConnections(), 0);
      },
    );
  });

  it('provider thinking never surfaces in user-visible content', async () => {
    const lines = [
      {
        model: MODEL,
        message: { role: 'assistant', content: 'Hi' },
        thinking: 'private chain of thought',
        done: false,
      },
      doneLine({ thinking: 'more private reasoning' }),
    ];
    await withServer({ kind: 'stream', lines }, async (server) => {
      const adapter = makeAdapter(server.url);
      const run = adapter.generateStream(inputFor(), { deliveryId: 'del_9' });
      const completion = await run.done();
      assert.equal(completion.status, 'succeeded');
      assert.equal(
        (completion.result as { content: string }).content,
        'Hi',
      );
      for (const snapshot of run.snapshots()) {
        assert.ok(!snapshot.content.includes('private'));
      }
    });
  });

  it('cancelling one run cannot cancel a concurrent run', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'a' }, done: false },
      { model: MODEL, message: { role: 'assistant', content: 'b' }, done: false },
      { model: MODEL, message: { role: 'assistant', content: 'c' }, done: false },
      doneLine(),
    ];
    await withServer(
      { kind: 'stream', lines, lineDelayMs: 50 },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const first = adapter.generateStream(inputFor(), {
          deliveryId: 'del_a',
        });
        const second = adapter.generateStream(inputFor(), {
          deliveryId: 'del_b',
        });
        // Let both runs observe at least one delta, then cancel only the first.
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.equal(first.cancelRequested, false);
        const cancelled = await first.cancel();
        assert.equal(first.cancelRequested, true);
        assert.deepEqual(cancelled, {
          delivery_id: 'del_a',
          status: 'failed',
          result: null,
          error: {
            code: 'run_cancelled',
            message: 'Run cancelled at request; no result was produced.',
          },
        });
        const snapshots = first.snapshots();
        assert.equal(snapshots[snapshots.length - 1]?.state, 'cancelled');
        const completed = await second.done();
        assert.equal(completed.status, 'succeeded');
        assert.equal(
          (completed.result as { content: string }).content,
          'abc',
        );
        assert.equal(server.requests.length, 2);
      },
    );
  });

  it('a final that raced cancellation still wins', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false },
      doneLine(),
    ];
    await withServer({ kind: 'stream', lines }, async (server) => {
      const adapter = makeAdapter(server.url);
      const run = adapter.generateStream(inputFor(), { deliveryId: 'del_9' });
      const completion = await run.done();
      assert.equal(completion.status, 'succeeded');
      const late = await run.cancel();
      assert.deepEqual(late, completion);
      assert.equal(run.cancelRequested, false);
      void server;
    });
  });

  it('stream timeouts stay unknown with partial evidence', async () => {
    await withServer({ kind: 'hang' }, async (server) => {
      const adapter = makeAdapter(server.url, { timeoutMs: 100 });
      const run = adapter.generateStream(inputFor(), { deliveryId: 'del_9' });
      const completion = await run.done();
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'transport_timeout');
      const snapshots = run.snapshots();
      assert.equal(snapshots[snapshots.length - 1]?.state, 'unknown');
      void server;
    });
  });

  it('stream error statuses map before any segment', async () => {
    await withServer(
      { kind: 'reject', status: 500, body: { error: 'boom' } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const run = adapter.generateStream(inputFor(), {
          deliveryId: 'del_9',
        });
        const completion = await run.done();
        assert.equal(completion.status, 'unknown');
        assert.equal(completion.error?.code, 'provider_transient');
        void server;
      },
    );
  });

  it('streams exceeding the byte cap fail with partial evidence', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'aaa' }, done: false },
      { model: MODEL, message: { role: 'assistant', content: 'bbb' }, done: false },
      doneLine(),
    ];
    // Paced lines arrive in separate reads, so the first delta is
    // observed before the second read trips the byte cap.
    await withServer(
      { kind: 'stream', lines, lineDelayMs: 30 },
      async (server) => {
        const adapter = makeAdapter(server.url, { maxBodyBytes: 120 });
      const run = adapter.generateStream(inputFor(), { deliveryId: 'del_9' });
      const completion = await run.done();
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
      // At least the first delta was observed before the cap tripped.
      assert.ok(
        run.snapshots().some((snapshot) => snapshot.content.includes('a')),
      );
      void server;
      },
    );
  });

  it('throwing observers never break generation', async () => {
    const lines = [
      { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false },
      doneLine(),
    ];
    await withServer({ kind: 'stream', lines }, async (server) => {
      const adapter = makeAdapter(server.url);
      const run = adapter.generateStream(inputFor(), {
        deliveryId: 'del_9',
        onSnapshot: () => {
          throw new Error('observer blew up');
        },
      });
      const completion = await run.done();
      assert.equal(completion.status, 'succeeded');
      void server;
    });
  });

  it('retained snapshots are a bounded tail with dense sequences', async () => {
    const lines: unknown[] = [];
    for (let index = 0; index < 300; index += 1) {
      lines.push({
        model: MODEL,
        message: { role: 'assistant', content: 'x' },
        done: false,
      });
    }
    lines.push(doneLine());
    await withServer({ kind: 'stream', lines }, async (server) => {
      const adapter = makeAdapter(server.url);
      const run = adapter.generateStream(inputFor(), { deliveryId: 'del_9' });
      const completion = await run.done();
      assert.equal(completion.status, 'succeeded');
      const snapshots = run.snapshots();
      assert.equal(snapshots.length, 256);
      const sequences = snapshots.map((snapshot) => snapshot.sequence);
      for (let index = 1; index < sequences.length; index += 1) {
        assert.equal(sequences[index], (sequences[index - 1] as number) + 1);
      }
      assert.equal(snapshots[snapshots.length - 1]?.state, 'succeeded');
      void server;
    });
  });

  it('stream validation throws synchronously with nothing sent', async () => {
    await withServer({ kind: 'final', body: finalBody() }, async (server) => {
      const adapter = makeAdapter(server.url);
      assert.throws(
        () =>
          adapter.generateStream(inputFor({ model: 'nope' }), {
            deliveryId: 'del_9',
          }),
        ModelValidationError,
      );
      assert.equal(server.requests.length, 0);
    });
  });
});

describe('models: stream shape classification', () => {
  it('reads final replies with nullable usage', () => {
    assert.deepEqual(readFinalChatReply(finalBody(), ''), {
      content: 'Hi there',
      model: MODEL,
      finish: 'stop',
      inputTokens: 12,
      outputTokens: 4,
    });
    assert.equal(readFinalChatReply(finalBody({ done: false }), ''), null);
    assert.equal(readFinalChatReply(null, ''), null);
    // Final-chunk content appends to streamed deltas.
    assert.equal(
      readFinalChatReply(finalBody({ message: { content: '!' } }), 'Hi')?.content,
      'Hi!',
    );
  });

  it('error lines win over done flags', () => {
    assert.deepEqual(
      classifyStreamLine({ error: 'boom', done: true }, ''),
      { kind: 'error', message: 'boom' },
    );
    assert.deepEqual(classifyStreamLine(null, ''), { kind: 'malformed' });
    assert.deepEqual(
      classifyStreamLine({ message: { content: 'a' } }, ''),
      { kind: 'delta', content: 'a' },
    );
    assert.deepEqual(classifyStreamLine({ message: {} }, ''), {
      kind: 'malformed',
    });
  });
});
