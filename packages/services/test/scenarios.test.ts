/**
 * S9a: scenario tables drive the REAL adapters through REAL harness
 * servers. Every table parses, survives a JSON round-trip, and
 * produces the documented completion when decoded to its harness
 * scenario — proving tables ≡ harness behavior, so workerd playback
 * of the same tables evidences the same adapter paths.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmailV1Adapter } from '../src/mail/adapter.js';
import { OllamaChatAdapter } from '../src/models/ollama.js';
import { SystemOneAdapter } from '../src/judgments/systemone.js';
import {
  ComfyUINativeAdapter,
} from '../src/media/comfyui.js';
import { digestGraph } from '../src/media/mapping.js';
import {
  fixedAttachmentSizes,
  fixedClock,
  startControlledMailServer,
} from '../src/ports.js';
import { startControlledOllamaServer } from '../src/models/harness.js';
import { startControlledSystemOneServer } from '../src/judgments/harness.js';
import { startControlledComfyServer } from '../src/media/harness.js';
import {
  JUDGMENTS_SCENARIO_TABLES,
  MAIL_SCENARIO_TABLES,
  MEDIA_SCENARIO_TABLES,
  MODELS_SCENARIO_TABLES,
  SCENARIO_TABLES,
  ScenarioTableError,
  checkJudgmentsScript,
  checkMailScript,
  checkModelsScript,
  decodeMediaScript,
  encodeMediaBytes,
  findScenarioTable,
  parseScenarioTable,
} from '../src/scenarios.js';
import type {
  EmailSendInput,
  ImageGenerateInput,
  JudgmentBatchInput,
  ModelChatInput,
  WorkflowNodeMapping,
  ApiGraph,
} from '@canlang/contracts';

const CLOCK_NOW = 1_758_000_000_000;

const PNG_A = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41,
]);
const PNG_B = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42,
]);

describe('scenarios: catalog', () => {
  it('ships 41 tables with the documented per-provider counts', () => {
    assert.equal(MAIL_SCENARIO_TABLES.length, 11);
    assert.equal(MODELS_SCENARIO_TABLES.length, 10);
    assert.equal(JUDGMENTS_SCENARIO_TABLES.length, 7);
    assert.equal(MEDIA_SCENARIO_TABLES.length, 13);
    assert.equal(SCENARIO_TABLES.length, 41);
  });

  it('every table parses and survives a JSON round-trip intact', () => {
    for (const table of SCENARIO_TABLES) {
      const parsed = parseScenarioTable(table);
      assert.equal(parsed.provider, table.provider);
      assert.equal(parsed.scenario, table.scenario);
      const roundTripped = JSON.parse(JSON.stringify(table)) as unknown;
      assert.deepEqual(roundTripped, table);
      parseScenarioTable(roundTripped);
    }
  });

  it('scenario names are unique per provider and resolvable', () => {
    for (const provider of ['mail', 'models', 'judgments', 'media'] as const) {
      const names = SCENARIO_TABLES.filter(
        (table) => table.provider === provider,
      ).map((table) => table.scenario);
      assert.equal(new Set(names).size, names.length);
      for (const name of names) {
        assert.ok(findScenarioTable(provider, name) !== null);
      }
    }
    assert.equal(findScenarioTable('mail', 'no-such-scenario'), null);
    assert.equal(findScenarioTable('files', 'up-ok'), null);
  });
});

describe('scenarios: fail-closed parsing', () => {
  it('rejects unknown providers and non-kebab scenario names', () => {
    assert.throws(
      () =>
        parseScenarioTable({
          provider: 'files',
          scenario: 'up-ok',
          script: { kind: 'accept' },
        }),
      ScenarioTableError,
    );
    for (const scenario of ['', 'Send', 'send_ok', '-send', 'send-', 'se--nd']) {
      assert.throws(
        () =>
          parseScenarioTable({
            provider: 'mail',
            scenario,
            script: { kind: 'accept' },
          }),
        ScenarioTableError,
        JSON.stringify(scenario),
      );
    }
  });

  it('rejects extra table-level keys and freezes the catalog', () => {
    assert.throws(
      () =>
        parseScenarioTable({
          provider: 'mail',
          scenario: 'send-ok',
          script: { kind: 'accept' },
          calls: [],
        }),
      /unknown key "calls"/,
    );
    assert.ok(Object.isFrozen(SCENARIO_TABLES));
    for (const table of SCENARIO_TABLES) {
      assert.ok(Object.isFrozen(table));
      assert.ok(Object.isFrozen(table.script));
    }
  });

  it('rejects cross-provider kinds and unknown script keys', () => {
    assert.throws(
      () =>
        parseScenarioTable({
          provider: 'mail',
          scenario: 'send-ok',
          script: { kind: 'final', body: {} },
        }),
      /unknown kind/,
    );
    // Harness-shaped `files` is a typo in table land (base64 only).
    assert.throws(
      () =>
        parseScenarioTable({
          provider: 'media',
          scenario: 'run-succeeded',
          script: { kind: 'accept', files: { 'a.png': PNG_A } },
        }),
      /unknown key "files"/,
    );
    assert.throws(
      () => checkMailScript({ kind: 'accept', extra: 1 }),
      /unknown key/,
    );
    assert.throws(
      () => checkModelsScript({ kind: 'stream' }),
      /needs a lines array/,
    );
    assert.throws(
      () => checkJudgmentsScript({ kind: 'reject', status: 500 }),
      /needs a body/,
    );
  });

  it('rejects malformed statuses, delays and reconcile outcomes', () => {
    assert.throws(
      () => checkMailScript({ kind: 'reject', status: 99, body: {} }),
      /HTTP status/,
    );
    assert.throws(
      () => checkMailScript({ kind: 'hang', reconcile: 'maybe' }),
      /accepted, rejected or pending/,
    );
    assert.throws(
      () => checkMailScript({ kind: 'flaky-then-accept', failures: -1 }),
      /integer >= 0/,
    );
    assert.throws(
      () =>
        checkModelsScript({ kind: 'stream', lines: [], lineDelayMs: -5 }),
      /delay >= 0/,
    );
  });

  it('rejects non-JSON bodies, cyclic scripts and bad base64', () => {
    assert.throws(
      () => checkMailScript({ kind: 'reject', status: 400 }),
      /needs a body/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    assert.throws(
      () => checkModelsScript({ kind: 'final', body: cyclic }),
      /cyclic/,
    );
    assert.throws(
      () => checkJudgmentsScript({ kind: 'accept', body: { p: Number.NaN } }),
      /finite JSON/,
    );
    assert.throws(
      () =>
        decodeMediaScript({
          kind: 'accept',
          filesBase64: { 'a.png': '!!!not-base64!!!' },
        }),
      /base64/,
    );
    assert.throws(
      () =>
        decodeMediaScript({
          kind: 'accept',
          filesBase64: { 'a.png': 'iVBORw0KGgpB===' },
        }),
      /base64/,
    );
  });
});

describe('scenarios: media bytes', () => {
  it('table base64 decodes to the exact PNG fixtures', () => {
    const table = findScenarioTable('media', 'run-succeeded');
    assert.ok(table !== null);
    const decoded = decodeMediaScript(table.script);
    assert.equal(decoded.cancelStatus, undefined);
    assert.deepEqual(
      (decoded.scenario as { files: Record<string, Uint8Array> }).files['a.png'],
      PNG_A,
    );
    assert.deepEqual(
      (decoded.scenario as { files: Record<string, Uint8Array> }).files['b.png'],
      PNG_B,
    );
  });

  it('encodeMediaBytes round-trips through decodeMediaScript', () => {
    const encoded = encodeMediaBytes({ 'a.png': PNG_A, 'empty.bin': new Uint8Array(0) });
    assert.deepEqual(encoded, { 'a.png': 'iVBORw0KGgpB', 'empty.bin': '' });
    const decoded = decodeMediaScript({ kind: 'accept', filesBase64: encoded });
    assert.deepEqual(
      (decoded.scenario as { files: Record<string, Uint8Array> }).files,
      { 'a.png': PNG_A, 'empty.bin': new Uint8Array(0) },
    );
  });
});

function mailTable(scenario: string) {
  const table = findScenarioTable('mail', scenario);
  assert.ok(table !== null);
  return checkMailScript(parseScenarioTable(table).script);
}

function mailInput(): EmailSendInput {
  return {
    to: 'reviewer@example.test',
    subject: 'Review',
    body: 'Plan',
    attachments: [],
  };
}

function mailAdapter(baseUrl: string, timeoutMs = 5000): EmailV1Adapter {
  return new EmailV1Adapter({
    baseUrl,
    timeoutMs,
    maxBodyBytes: 1_000_000,
    maxTransportBytes: 10_000_000,
    clock: fixedClock(CLOCK_NOW),
    sizes: fixedAttachmentSizes({ file_a: 1000, file_b: 2000 }),
  });
}

describe('scenarios: mail equivalence', () => {
  it('send-ok accepts with the first reference', async () => {
    const server = await startControlledMailServer(mailTable('send-ok'));
    try {
      const completion = await mailAdapter(server.url).send(mailInput(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      assert.deepEqual(completion.result, { reference: 'mail_1' });
    } finally {
      await server.close();
    }
  });

  it('send-reject fails closed with the provider message', async () => {
    const server = await startControlledMailServer(mailTable('send-reject'));
    try {
      const completion = await mailAdapter(server.url).send(mailInput(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'failed');
      assert.deepEqual(completion.error, {
        code: 'provider_rejected',
        message: 'No mailbox here',
      });
    } finally {
      await server.close();
    }
  });

  it('send-rate-limited and send-client-timeout stay unknown', async () => {
    for (const [scenario, code] of [
      ['send-rate-limited', 'provider_rate_limited'],
      ['send-client-timeout', 'provider_client_timeout'],
    ] as const) {
      const server = await startControlledMailServer(mailTable(scenario));
      try {
        const completion = await mailAdapter(server.url).send(mailInput(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'unknown', scenario);
        assert.equal(completion.error?.code, code, scenario);
      } finally {
        await server.close();
      }
    }
  });

  it('send-retry-success goes unknown then succeeds on one identity', async () => {
    const server = await startControlledMailServer(
      mailTable('send-retry-success'),
    );
    try {
      const adapter = mailAdapter(server.url);
      const first = await adapter.send(mailInput(), { deliveryId: 'del_1' });
      assert.equal(first.status, 'unknown');
      assert.equal(first.error?.code, 'provider_transient');
      const second = await adapter.send(mailInput(), { deliveryId: 'del_1' });
      assert.equal(second.status, 'succeeded');
      assert.deepEqual(second.result, { reference: 'mail_1' });
    } finally {
      await server.close();
    }
  });

  it('send-unknown-* reconciles through the original identity', async () => {
    for (const [scenario, status, code] of [
      ['send-unknown-accepted', 'succeeded', null],
      ['send-unknown-rejected', 'failed', 'provider_rejected'],
      ['send-unknown-pending', 'unknown', null],
    ] as const) {
      const server = await startControlledMailServer(mailTable(scenario));
      try {
        const adapter = mailAdapter(server.url, 50);
        const lost = await adapter.send(mailInput(), { deliveryId: 'del_1' });
        assert.equal(lost.status, 'unknown', scenario);
        const found = await adapter.reconcile('del_1');
        assert.equal(found.status, status, scenario);
        assert.equal(found.error?.code ?? null, code, scenario);
      } finally {
        await server.close();
      }
    }
  });

  it('send-invalid-schema fails, never pending', async () => {
    const server = await startControlledMailServer(
      mailTable('send-invalid-schema'),
    );
    try {
      const completion = await mailAdapter(server.url).send(mailInput(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
    } finally {
      await server.close();
    }
  });

  it('send-redirect-refused stays unknown with no live second server', async () => {
    const server = await startControlledMailServer(
      mailTable('send-redirect-refused'),
    );
    try {
      const completion = await mailAdapter(server.url).send(mailInput(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'redirect_refused');
    } finally {
      await server.close();
    }
  });

  it('send-redirect-loop maps to unknown with the original identity', async () => {
    const server = await startControlledMailServer(
      mailTable('send-redirect-loop'),
    );
    try {
      const completion = await mailAdapter(server.url).send(mailInput(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.delivery_id, 'del_1');
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'too_many_redirects');
    } finally {
      await server.close();
    }
  });
});

const MODELS_MODEL = 'llama-test';

function modelsTable(scenario: string) {
  const table = findScenarioTable('models', scenario);
  assert.ok(table !== null);
  return checkModelsScript(parseScenarioTable(table).script);
}

function modelsInput(): ModelChatInput {
  return {
    model: MODELS_MODEL,
    messages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 64,
  };
}

function modelsAdapter(baseUrl: string, timeoutMs = 5000): OllamaChatAdapter {
  return new OllamaChatAdapter({
    baseUrl,
    timeoutMs,
    maxBodyBytes: 1_000_000,
    models: [MODELS_MODEL],
    maxOutputTokens: 4096,
    clock: fixedClock(CLOCK_NOW),
  });
}

describe('scenarios: models equivalence', () => {
  it('generate-ok accepts the final reply with usage', async () => {
    const server = await startControlledOllamaServer(modelsTable('generate-ok'));
    try {
      const completion = await modelsAdapter(server.url).generate(
        modelsInput(),
        { deliveryId: 'del_1' },
      );
      assert.equal(completion.status, 'succeeded');
      assert.deepEqual(completion.result, {
        content: 'Hi there',
        model: MODELS_MODEL,
        finish: 'stop',
        inputTokens: 12,
        outputTokens: 4,
      });
    } finally {
      await server.close();
    }
  });

  it('generate-reject/transient/rate-limited map exactly', async () => {
    for (const [scenario, status, code] of [
      ['generate-reject', 'failed', 'provider_rejected'],
      ['generate-transient', 'unknown', 'provider_transient'],
      ['generate-rate-limited', 'unknown', 'provider_rate_limited'],
    ] as const) {
      const server = await startControlledOllamaServer(modelsTable(scenario));
      try {
        const completion = await modelsAdapter(server.url).generate(
          modelsInput(),
          { deliveryId: 'del_1' },
        );
        assert.equal(completion.status, status, scenario);
        assert.equal(completion.error?.code, code, scenario);
      } finally {
        await server.close();
      }
    }
  });

  it('generate-timeout-unknown cannot be reconciled by lookup', async () => {
    const server = await startControlledOllamaServer(
      modelsTable('generate-timeout-unknown'),
    );
    try {
      const adapter = modelsAdapter(server.url, 100);
      const completion = await adapter.generate(modelsInput(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'transport_timeout');
      const reconciled = await adapter.reconcile('del_1');
      assert.equal(reconciled.status, 'unknown');
      assert.equal(reconciled.error?.code, 'no_run_resume');
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('generate-invalid-schema fails with invalid_response', async () => {
    const server = await startControlledOllamaServer(
      modelsTable('generate-invalid-schema'),
    );
    try {
      const completion = await modelsAdapter(server.url).generate(
        modelsInput(),
        { deliveryId: 'del_1' },
      );
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
    } finally {
      await server.close();
    }
  });

  it('stream-ok assembles deltas with ordered snapshots', async () => {
    const server = await startControlledOllamaServer(modelsTable('stream-ok'));
    try {
      const run = modelsAdapter(server.url).generateStream(modelsInput(), {
        deliveryId: 'del_9',
      });
      const completion = await run.done();
      assert.equal(completion.status, 'succeeded');
      assert.equal(
        (completion.result as { content: string }).content,
        'Hi there',
      );
      assert.deepEqual(
        run.snapshots().map((snapshot) => snapshot.sequence),
        [0, 1, 2, 3],
      );
    } finally {
      await server.close();
    }
  });

  it('stream-mid-error fails with partial evidence kept', async () => {
    const server = await startControlledOllamaServer(
      modelsTable('stream-mid-error'),
    );
    try {
      const run = modelsAdapter(server.url).generateStream(modelsInput(), {
        deliveryId: 'del_9',
      });
      const completion = await run.done();
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'provider_error');
      const snapshots = run.snapshots();
      assert.equal(snapshots[snapshots.length - 1]?.content, 'Hi');
    } finally {
      await server.close();
    }
  });

  it('stream-truncated fails with partial evidence kept', async () => {
    const server = await startControlledOllamaServer(
      modelsTable('stream-truncated'),
    );
    try {
      const run = modelsAdapter(server.url).generateStream(modelsInput(), {
        deliveryId: 'del_9',
      });
      const completion = await run.done();
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
      const snapshots = run.snapshots();
      assert.equal(snapshots[snapshots.length - 1]?.content, 'Hi');
    } finally {
      await server.close();
    }
  });

  it('stream-cancel cancels the paced run with a cancelled snapshot', async () => {
    const server = await startControlledOllamaServer(
      modelsTable('stream-cancel'),
    );
    try {
      const run = modelsAdapter(server.url).generateStream(modelsInput(), {
        deliveryId: 'del_9',
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const cancelled = await run.cancel();
      assert.equal(cancelled.status, 'failed');
      assert.equal(cancelled.error?.code, 'run_cancelled');
      const snapshots = run.snapshots();
      assert.equal(snapshots[snapshots.length - 1]?.state, 'cancelled');
    } finally {
      await server.close();
    }
  });
});

const JUDGMENTS_MODEL = 'jev-latest';

function judgmentsTable(scenario: string) {
  const table = findScenarioTable('judgments', scenario);
  assert.ok(table !== null);
  return checkJudgmentsScript(parseScenarioTable(table).script);
}

function judgmentsInput(): JudgmentBatchInput {
  return {
    model: JUDGMENTS_MODEL,
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

function judgmentsAdapter(baseUrl: string, timeoutMs = 5000): SystemOneAdapter {
  return new SystemOneAdapter({
    baseUrl,
    timeoutMs,
    maxBodyBytes: 1_000_000,
    models: [JUDGMENTS_MODEL],
    minChoiceOptions: 1,
    maxChoiceOptions: 255,
    minScoreLevels: 2,
    maxScoreLevels: 10,
    maxRequestBytes: null,
    clock: fixedClock(CLOCK_NOW),
  });
}

describe('scenarios: judgments equivalence', () => {
  it('evaluate-ok accepts the mixed batch in request order', async () => {
    const server = await startControlledSystemOneServer(
      judgmentsTable('evaluate-ok'),
    );
    try {
      const completion = await judgmentsAdapter(server.url).evaluate(
        judgmentsInput(),
        { deliveryId: 'del_1' },
      );
      assert.equal(completion.status, 'succeeded');
      const result = completion.result as {
        model: string;
        answers: Array<{ kind: string; id: string }>;
      };
      assert.equal(result.model, 'jev-1.13.0');
      assert.deepEqual(
        result.answers.map((answer) => [answer.kind, answer.id]),
        [
          ['noul', 'human'],
          ['choice', 'route'],
          ['score', 'severity'],
        ],
      );
    } finally {
      await server.close();
    }
  });

  it('evaluate-reject/unauthorized/rate-limited/transient map exactly', async () => {
    for (const [scenario, status, code] of [
      ['evaluate-reject', 'failed', 'provider_rejected'],
      ['evaluate-unauthorized', 'failed', 'provider_unauthorized'],
      ['evaluate-rate-limited', 'unknown', 'provider_rate_limited'],
      ['evaluate-transient', 'unknown', 'provider_transient'],
    ] as const) {
      const server = await startControlledSystemOneServer(
        judgmentsTable(scenario),
      );
      try {
        const completion = await judgmentsAdapter(server.url).evaluate(
          judgmentsInput(),
          { deliveryId: 'del_1' },
        );
        assert.equal(completion.status, status, scenario);
        assert.equal(completion.error?.code, code, scenario);
      } finally {
        await server.close();
      }
    }
  });

  it('evaluate-timeout-unknown cannot be reconciled by lookup', async () => {
    const server = await startControlledSystemOneServer(
      judgmentsTable('evaluate-timeout-unknown'),
    );
    try {
      const adapter = judgmentsAdapter(server.url, 100);
      const completion = await adapter.evaluate(judgmentsInput(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'transport_timeout');
      const reconciled = await adapter.reconcile('del_1');
      assert.equal(reconciled.status, 'unknown');
      assert.equal(reconciled.error?.code, 'no_run_resume');
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('evaluate-invalid-schema fails on the missing answer', async () => {
    const server = await startControlledSystemOneServer(
      judgmentsTable('evaluate-invalid-schema'),
    );
    try {
      const completion = await judgmentsAdapter(server.url).evaluate(
        judgmentsInput(),
        { deliveryId: 'del_1' },
      );
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
    } finally {
      await server.close();
    }
  });
});

const MEDIA_GRAPH: ApiGraph = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 1, steps: 20, latent_image: ['5', 0], model: ['4', 0] },
  },
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'x.safetensors' },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 512, height: 512, batch_size: 1 },
  },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '9': {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] },
  },
};

function mediaMapping(): WorkflowNodeMapping {
  return {
    workflow: 'poster-v1',
    graphDigest: digestGraph(MEDIA_GRAPH),
    inputs: {
      prompt: { node: '6', key: 'text' },
      negative: { node: '7', key: 'text' },
      width: { node: '5', key: 'width' },
      height: { node: '5', key: 'height' },
      seed: { node: '3', key: 'seed' },
    },
    outputs: ['9'],
  };
}

function mediaTable(scenario: string) {
  const table = findScenarioTable('media', scenario);
  assert.ok(table !== null);
  return decodeMediaScript(parseScenarioTable(table).script);
}

function mediaInput(): ImageGenerateInput {
  return {
    prompt: 'a poster',
    negative: 'blurry',
    width: 512,
    height: 768,
    seed: 42,
  };
}

function mediaAdapter(baseUrl: string, timeoutMs = 5000): ComfyUINativeAdapter {
  return new ComfyUINativeAdapter({
    baseUrl,
    timeoutMs,
    maxBodyBytes: 1_000_000,
    graph: MEDIA_GRAPH,
    mapping: mediaMapping(),
    clientId: 'test-binding',
    maxDownloadBytes: 1_000_000,
    maxOutputs: 8,
  });
}

async function withMediaTable<T>(
  scenario: string,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const decoded = mediaTable(scenario);
  const server = await startControlledComfyServer(
    decoded.scenario,
    decoded.cancelStatus === undefined
      ? undefined
      : { cancelStatus: decoded.cancelStatus },
  );
  try {
    return await run(server.url);
  } finally {
    await server.close();
  }
}

describe('scenarios: media equivalence', () => {
  it('submit-ok queues with the caller job id', async () => {
    await withMediaTable('submit-ok', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).submit(mediaInput(), {
        deliveryId: 'del_1',
        jobId: 'job_1',
      });
      assert.equal(completion.status, 'succeeded');
      assert.deepEqual(completion.result, { job: 'job_1' });
    });
  });

  it('submit-reject and submit-transient map exactly', async () => {
    await withMediaTable('submit-reject', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).submit(mediaInput(), {
        deliveryId: 'del_1',
        jobId: 'job_1',
      });
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'provider_rejected');
    });
    await withMediaTable('submit-transient', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).submit(mediaInput(), {
        deliveryId: 'del_1',
        jobId: 'job_1',
      });
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'provider_transient');
    });
  });

  it('submit-unknown-recover reconciles the lost submit by job id', async () => {
    await withMediaTable('submit-unknown-recover', async (baseUrl) => {
      const adapter = mediaAdapter(baseUrl, 100);
      const submitted = await adapter.submit(mediaInput(), {
        deliveryId: 'del_1',
        jobId: 'job_7',
      });
      assert.equal(submitted.status, 'unknown');
      assert.equal(submitted.error?.code, 'transport_timeout');
      const recovered = await adapter.reconcile('job_7', {
        deliveryId: 'del_1',
      });
      assert.equal(recovered.status, 'succeeded');
      const run = recovered.result as {
        state: string;
        outputs: Array<{ bytes: Uint8Array }>;
      };
      assert.equal(run.state, 'succeeded');
      assert.deepEqual(run.outputs[0]?.bytes, PNG_A);
    });
  });

  it('run-succeeded downloads declared outputs with stable positions', async () => {
    await withMediaTable('run-succeeded', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      const run = completion.result as {
        state: string;
        outputs: Array<{ node: string; position: number; bytes: Uint8Array }>;
      };
      assert.equal(run.state, 'succeeded');
      assert.deepEqual(
        run.outputs.map((output) => [output.node, output.position]),
        [
          ['9', 0],
          ['9', 1],
        ],
      );
      assert.deepEqual(run.outputs[0]?.bytes, PNG_A);
      assert.deepEqual(run.outputs[1]?.bytes, PNG_B);
    });
  });

  it('run-running and run-queued-unknown observe honest states', async () => {
    await withMediaTable('run-running', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.deepEqual(completion.result, {
        job: 'job_1',
        state: 'running',
        outputs: [],
        detail: null,
      });
    });
    await withMediaTable('run-queued-unknown', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(
        (completion.result as { state: string }).state,
        'unknown',
      );
    });
  });

  it('run-failed-partial keeps outputs as data', async () => {
    await withMediaTable('run-failed-partial', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      const run = completion.result as {
        state: string;
        outputs: unknown[];
        detail: string;
      };
      assert.equal(run.state, 'failed');
      assert.equal(run.outputs.length, 1);
      assert.equal(run.detail, 'VAE decode failed');
    });
  });

  it('run-failed-detail carries the default failure detail', async () => {
    await withMediaTable('run-failed-detail', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.deepEqual(completion.result, {
        job: 'job_1',
        state: 'failed',
        outputs: [],
        detail: 'Image provider reported run failure.',
      });
    });
  });

  it('run-malformed fails the observation loudly', async () => {
    await withMediaTable('run-malformed', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'failed');
      assert.equal(completion.error?.code, 'invalid_response');
    });
  });

  it('run-bytes-missing keeps the run unknown with partials', async () => {
    await withMediaTable('run-bytes-missing', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      const run = completion.result as {
        state: string;
        outputs: unknown[];
        detail: string;
      };
      assert.equal(run.state, 'unknown');
      assert.equal(run.outputs.length, 1);
      assert.ok(run.detail.includes('unavailable'));
    });
  });

  it('poll-timeout fails the observation, not the run', async () => {
    await withMediaTable('poll-timeout', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl, 100).reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'transport_timeout');
    });
  });

  it('cancel-observed returns the post-cancel observation', async () => {
    await withMediaTable('cancel-observed', async (baseUrl) => {
      const completion = await mediaAdapter(baseUrl).cancel('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      const run = completion.result as {
        state: string;
        outputs: unknown[];
        detail: string;
      };
      assert.equal(run.state, 'succeeded');
      assert.equal(run.outputs.length, 1);
      assert.ok(run.detail.startsWith('Cancellation requested;'));
    });
  });
});
