/**
 * S7c: native ComfyUI media adapter over REAL fetch against localhost
 * harness servers. Covers workflow-map substitution and drift,
 * submit acceptance/rejection, history polling with declared-output
 * downloads, partial outputs on failure, cancel-then-reconcile, and
 * caller-owned job recovery after a lost submit response.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MappingValidationError,
  digestGraph,
  substituteAndValidate,
} from '../src/media/mapping.ts';
import {
  ComfyUINativeAdapter,
  readHistoryRun,
} from '../src/media/comfyui.ts';
import { startControlledComfyServer } from '../src/media/harness.ts';
import type {
  ControlledComfyScenario,
  ControlledComfyServer,
} from '../src/media/harness.ts';
import type {
  ApiGraph,
  ImageGenerateInput,
  WorkflowNodeMapping,
} from '../../contracts/src/services.js';

const GRAPH: ApiGraph = {
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

function mappingFor(graph: ApiGraph = GRAPH): WorkflowNodeMapping {
  return {
    workflow: 'poster-v1',
    graphDigest: digestGraph(graph),
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

function inputFor(over: Partial<ImageGenerateInput> = {}): ImageGenerateInput {
  return {
    prompt: 'a poster',
    negative: 'blurry',
    width: 512,
    height: 768,
    seed: 42,
    ...over,
  };
}

function makeAdapter(
  baseUrl: string,
  opts?: {
    timeoutMs?: number;
    maxBodyBytes?: number;
    maxDownloadBytes?: number;
    maxOutputs?: number;
    graph?: ApiGraph;
    mapping?: WorkflowNodeMapping;
    authorization?: string;
  },
): ComfyUINativeAdapter {
  return new ComfyUINativeAdapter({
    baseUrl,
    timeoutMs: opts?.timeoutMs ?? 5000,
    maxBodyBytes: opts?.maxBodyBytes ?? 1_000_000,
    graph: opts?.graph ?? GRAPH,
    mapping: opts?.mapping ?? mappingFor(opts?.graph ?? GRAPH),
    clientId: 'test-binding',
    maxDownloadBytes: opts?.maxDownloadBytes ?? 1_000_000,
    maxOutputs: opts?.maxOutputs ?? 8,
    ...(opts?.authorization === undefined
      ? {}
      : { authorization: opts.authorization }),
  });
}

async function withServer<T>(
  scenario: ControlledComfyScenario,
  run: (server: ControlledComfyServer) => Promise<T>,
  opts?: { readonly cancelStatus?: number },
): Promise<T> {
  const server = await startControlledComfyServer(scenario, opts);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

const PNG_A = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41,
]);
const PNG_B = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42,
]);

function successEntry(images: Array<{ filename: string; subfolder: string; type: string }>) {
  return {
    status: { status_str: 'success', completed: true },
    outputs: { '9': { images } },
  };
}

describe('media: workflow mapping', () => {
  it('substitutes every field and preserves edges byte-for-byte', () => {
    const before = JSON.parse(JSON.stringify(GRAPH)) as ApiGraph;
    const { graph, digest } = substituteAndValidate(
      GRAPH,
      mappingFor(),
      inputFor(),
    );
    assert.equal(digest, digestGraph(GRAPH));
    assert.equal(graph['6']?.inputs['text'], 'a poster');
    assert.equal(graph['7']?.inputs['text'], 'blurry');
    assert.equal(graph['5']?.inputs['width'], 512);
    assert.equal(graph['5']?.inputs['height'], 768);
    assert.equal(graph['3']?.inputs['seed'], 42);
    assert.deepEqual(graph['3']?.inputs['model'], ['4', 0]);
    assert.deepEqual(graph['6']?.inputs['clip'], ['4', 1]);
    assert.deepEqual(GRAPH, before);
    assert.ok(Object.isFrozen(graph));
  });

  it('fails visibly on drift, unknown, unmapped and link destinations', () => {
    const drifted = JSON.parse(JSON.stringify(GRAPH)) as ApiGraph;
    (drifted['6'] as { inputs: Record<string, unknown> }).inputs['text'] =
      'someone edited the workflow';
    assert.throws(
      () => substituteAndValidate(drifted, mappingFor(), inputFor()),
      MappingValidationError,
    );
    const extra = mappingFor();
    (extra.inputs as Record<string, { node: string; key: string }>)['style'] = {
      node: '6',
      key: 'text',
    };
    assert.throws(
      () => substituteAndValidate(GRAPH, extra, inputFor()),
      MappingValidationError,
    );
    const missing = mappingFor();
    delete (missing.inputs as Record<string, unknown>)['seed'];
    assert.throws(
      () => substituteAndValidate(GRAPH, missing, inputFor()),
      MappingValidationError,
    );
    const linked = mappingFor();
    linked.inputs['prompt'] = { node: '3', key: 'latent_image' };
    assert.throws(
      () => substituteAndValidate(GRAPH, linked, inputFor()),
      /link/,
    );
    const kindChanged = mappingFor();
    kindChanged.inputs['width'] = { node: '6', key: 'text' };
    assert.throws(
      () => substituteAndValidate(GRAPH, kindChanged, inputFor()),
      MappingValidationError,
    );
    const badOutput = mappingFor();
    badOutput.outputs = ['99'];
    assert.throws(
      () => substituteAndValidate(GRAPH, badOutput, inputFor()),
      MappingValidationError,
    );
  });

  it('rejects malformed business inputs before touching the graph', () => {
    for (const input of [
      inputFor({ width: 0 }),
      inputFor({ height: -1 }),
      inputFor({ seed: -1 }),
      inputFor({ width: 1.5 }),
      inputFor({ prompt: 7 as unknown as string }),
    ]) {
      assert.throws(
        () => substituteAndValidate(GRAPH, mappingFor(), input),
        MappingValidationError,
      );
    }
  });
});

describe('media: submit', () => {
  it('queues the substituted graph with the caller job id', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.submit(inputFor(), {
        deliveryId: 'del_1',
        jobId: 'job_1',
      });
      assert.deepEqual(completion, {
        delivery_id: 'del_1',
        status: 'succeeded',
        result: { job: 'job_1' },
        error: null,
      });
      assert.deepEqual(server.prompts, ['job_1']);
      const wire = JSON.parse(server.requests[0]?.bodyText ?? '{}') as Record<
        string,
        unknown
      >;
      assert.equal(wire['client_id'], 'test-binding');
      assert.equal(wire['prompt_id'], 'job_1');
      const prompt = wire['prompt'] as Record<string, { inputs: Record<string, unknown> }>;
      assert.equal(prompt['6']?.inputs['text'], 'a poster');
      assert.equal(prompt['5']?.inputs['height'], 768);
      assert.equal(prompt['3']?.inputs['seed'], 42);
    });
  });

  it('mints a job id when the caller supplies none', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.submit(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      const job = (completion.result as { job: string }).job;
      assert.ok(job.length > 0);
      assert.deepEqual(server.prompts, [job]);
    });
  });

  it('maps prompt validation failures without retrying blindly', async () => {
    await withServer(
      {
        kind: 'reject-prompt',
        status: 400,
        body: { error: 'bad prompt', node_errors: { '6': ['no text'] } },
      },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.submit(inputFor(), {
          deliveryId: 'del_1',
          jobId: 'job_1',
        });
        assert.equal(completion.status, 'failed');
        assert.equal(completion.error?.code, 'provider_rejected');
        assert.equal(server.requests.length, 1);
      },
    );
    await withServer(
      {
        kind: 'accept',
        promptBody: { error: 'bad prompt', node_errors: { '6': ['no text'] } },
      },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.submit(inputFor(), {
          deliveryId: 'del_1',
          jobId: 'job_1',
        });
        assert.equal(completion.status, 'failed');
        assert.equal(completion.error?.code, 'provider_rejected');
      },
    );
  });

  it('lost submit responses stay unknown and recover by caller job id', async () => {
    const history = {
      job_7: successEntry([{ filename: 'a.png', subfolder: '', type: 'output' }]),
    };
    await withServer(
      { kind: 'hang-submit', history, files: { 'a.png': PNG_A } },
      async (server) => {
        const adapter = makeAdapter(server.url, { timeoutMs: 100 });
        const submitted = await adapter.submit(inputFor(), {
          deliveryId: 'del_1',
          jobId: 'job_7',
        });
        assert.equal(submitted.status, 'unknown');
        assert.equal(submitted.error?.code, 'transport_timeout');
        assert.deepEqual(server.prompts, ['job_7']);
        const recovered = await adapter.reconcile('job_7', {
          deliveryId: 'del_1',
        });
        assert.equal(recovered.status, 'succeeded');
        assert.equal(
          (recovered.result as { state: string }).state,
          'succeeded',
        );
        assert.deepEqual(
          (recovered.result as { outputs: Array<{ bytes: Uint8Array }> }).outputs[0]?.bytes,
          PNG_A,
        );
      },
    );
  });

  it('mapping failures throw before anything is sent', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const drifted = JSON.parse(JSON.stringify(GRAPH)) as ApiGraph;
      (drifted['5'] as { inputs: Record<string, unknown> }).inputs['width'] = 1;
      const adapter = makeAdapter(server.url, {
        graph: drifted,
        mapping: mappingFor(),
      });
      await assert.rejects(
        adapter.submit(inputFor(), { deliveryId: 'del_1', jobId: 'job_1' }),
        MappingValidationError,
      );
      assert.equal(server.requests.length, 0);
    });
  });

  it('maps transient submit failures to unknown', async () => {
    await withServer(
      { kind: 'reject-prompt', status: 500, body: { error: 'boom' } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.submit(inputFor(), {
          deliveryId: 'del_1',
          jobId: 'job_1',
        });
        assert.equal(completion.status, 'unknown');
        assert.equal(completion.error?.code, 'provider_transient');
      },
    );
  });
});

describe('media: reconcile', () => {
  it('missing entries stay an honest unknown run state', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.deepEqual(completion, {
        delivery_id: 'del_1',
        status: 'succeeded',
        result: {
          job: 'job_1',
          state: 'unknown',
          outputs: [],
          detail:
            'No history entry for this job (queued, running, or unknown id).',
        },
        error: null,
      });
      void server;
    });
  });

  it('executing entries observe a running state', async () => {
    const history = {
      job_1: {
        status: { status_str: 'executing', completed: false },
        outputs: {},
      },
    };
    await withServer({ kind: 'accept', history }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.deepEqual(completion.result, {
        job: 'job_1',
        state: 'running',
        outputs: [],
        detail: null,
      });
      void server;
    });
  });

  it('successful runs download declared outputs with stable positions', async () => {
    const history = {
      job_1: {
        status: { status_str: 'success', completed: true },
        outputs: {
          '9': {
            images: [
              { filename: 'a.png', subfolder: '', type: 'output' },
              { filename: 'b.png', subfolder: 'x', type: 'output' },
            ],
          },
          '8': {
            images: [{ filename: 'sneaky.png', subfolder: '', type: 'output' }],
          },
        },
      },
    };
    const files = { 'a.png': PNG_A, 'b.png': PNG_B, 'sneaky.png': PNG_A };
    await withServer({ kind: 'accept', history, files }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'succeeded');
      const run = completion.result as {
        state: string;
        outputs: Array<{
          node: string;
          position: number;
          contentType: string;
          sizeBytes: number;
          bytes: Uint8Array;
        }>;
        detail: null;
      };
      assert.equal(run.state, 'succeeded');
      assert.equal(run.detail, null);
      assert.equal(run.outputs.length, 2);
      assert.deepEqual(
        run.outputs.map((output) => [output.node, output.position]),
        [
          ['9', 0],
          ['9', 1],
        ],
      );
      assert.deepEqual(run.outputs[0]?.bytes, PNG_A);
      assert.deepEqual(run.outputs[1]?.bytes, PNG_B);
      assert.equal(run.outputs[0]?.contentType, 'image/png');
      assert.equal(run.outputs[0]?.sizeBytes, PNG_A.length);
      // Undeclared node outputs are never collected.
      assert.ok(
        server.requests.every(
          (request) => !request.path.includes('sneaky.png'),
        ),
      );
    });
  });

  it('failed runs preserve partial outputs as data', async () => {
    const history = {
      job_1: {
        status: {
          status_str: 'error',
          completed: false,
          messages: ['VAE decode failed'],
        },
        outputs: {
          '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
        },
      },
    };
    await withServer(
      { kind: 'accept', history, files: { 'a.png': PNG_A } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.reconcile('job_1', {
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
        void server;
      },
    );
  });

  it('failed runs without outputs carry the failure detail', async () => {
    const history = {
      job_1: {
        status: { status_str: 'error', completed: false },
        outputs: {},
      },
    };
    await withServer({ kind: 'accept', history }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.deepEqual(completion.result, {
        job: 'job_1',
        state: 'failed',
        outputs: [],
        detail: 'Image provider reported run failure.',
      });
      void server;
    });
  });

  it('malformed entries fail the observation loudly', async () => {
    const entries = [
      { status: undefined, outputs: {} },
      { status: { status_str: 'mystery' }, outputs: {} },
      { status: { status_str: 'success' }, outputs: [] },
      {
        status: { status_str: 'success', completed: true },
        outputs: { '9': { images: [{ filename: '', subfolder: '', type: 'output' }] } },
      },
      {
        status: { status_str: 'success', completed: true },
        outputs: { '9': { images: 'a.png' } },
      },
      'done',
    ];
    for (const entry of entries) {
      await withServer(
        { kind: 'accept', history: { job_1: entry as never } },
        async (server) => {
          const adapter = makeAdapter(server.url);
          const completion = await adapter.reconcile('job_1', {
            deliveryId: 'del_1',
          });
          assert.equal(completion.status, 'failed');
          assert.equal(completion.error?.code, 'invalid_response');
        },
      );
    }
  });

  it('inaccessible bytes keep the run unknown with preserved partials', async () => {
    const history = {
      job_1: successEntry([
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'gone.png', subfolder: '', type: 'output' },
      ]),
    };
    await withServer(
      { kind: 'accept', history, files: { 'a.png': PNG_A } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.reconcile('job_1', {
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
        void server;
      },
    );
  });

  it('over-cap runs fail visibly instead of truncating', async () => {
    const history = {
      job_1: successEntry([
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'b.png', subfolder: '', type: 'output' },
      ]),
    };
    const files = { 'a.png': PNG_A, 'b.png': PNG_B };
    await withServer({ kind: 'accept', history, files }, async (server) => {
      const adapter = makeAdapter(server.url, { maxOutputs: 1 });
      const completion = await adapter.reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.deepEqual(completion.result, {
        job: 'job_1',
        state: 'failed',
        outputs: [],
        detail:
          'Run produced more outputs than the binding allows; refusing to truncate.',
      });
      assert.ok(server.requests.every((request) => !request.path.startsWith('/view')));
    });
  });

  it('over-cap and empty downloads stay unknown', async () => {
    const history = {
      job_1: successEntry([{ filename: 'a.png', subfolder: '', type: 'output' }]),
    };
    await withServer(
      { kind: 'accept', history, files: { 'a.png': PNG_A } },
      async (server) => {
        const adapter = makeAdapter(server.url, { maxDownloadBytes: 4 });
        const completion = await adapter.reconcile('job_1', {
          deliveryId: 'del_1',
        });
        assert.equal(
          (completion.result as { state: string }).state,
          'unknown',
        );
      },
    );
    await withServer(
      { kind: 'accept', history, files: { 'a.png': new Uint8Array(0) } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.reconcile('job_1', {
          deliveryId: 'del_1',
        });
        assert.equal(
          (completion.result as { state: string }).state,
          'unknown',
        );
      },
    );
  });

  it('poll failures fail the observation, not the run', async () => {
    await withServer({ kind: 'hang-all' }, async (server) => {
      const adapter = makeAdapter(server.url, { timeoutMs: 100 });
      const completion = await adapter.reconcile('job_1', {
        deliveryId: 'del_1',
      });
      assert.equal(completion.status, 'unknown');
      assert.equal(completion.error?.code, 'transport_timeout');
      void server;
    });
  });
});

describe('media: cancel', () => {
  it('cancelling returns the post-cancel observation', async () => {
    const history = {
      job_1: successEntry([{ filename: 'a.png', subfolder: '', type: 'output' }]),
    };
    await withServer(
      { kind: 'accept', history, files: { 'a.png': PNG_A } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.cancel('job_1', {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'succeeded');
        const run = completion.result as {
          state: string;
          outputs: unknown[];
          detail: string;
        };
        // Completion raced the cancel: the terminal success stands and
        // no cancelled state is fabricated.
        assert.equal(run.state, 'succeeded');
        assert.equal(run.outputs.length, 1);
        assert.ok(run.detail.startsWith('Cancellation requested;'));
        assert.ok(
          server.requests.some((request) =>
            request.path.endsWith('/api/jobs/job_1/cancel'),
          ),
        );
      },
    );
  });

  it('servers without targeted cancel report unsupported and still observe', async () => {
    await withServer(
      { kind: 'accept' },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.cancel('job_1', {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'succeeded');
        const run = completion.result as { state: string; detail: string };
        assert.equal(run.state, 'unknown');
        assert.ok(run.detail.startsWith('Targeted cancel unsupported'));
      },
      { cancelStatus: 404 },
    );
  });

  it('uncertain cancel attempts still reconcile', async () => {
    const history = {
      job_1: {
        status: { status_str: 'error', completed: false },
        outputs: {},
      },
    };
    await withServer(
      { kind: 'accept', history },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.cancel('job_1', {
          deliveryId: 'del_1',
        });
        const run = completion.result as { state: string; detail: string };
        assert.equal(run.state, 'failed');
        assert.ok(run.detail.startsWith('Cancel outcome uncertain;'));
        void server;
      },
      { cancelStatus: 500 },
    );
  });
});

describe('media: history evidence reading', () => {
  it('distinguishes absent, malformed and shaped entries', () => {
    assert.equal(readHistoryRun({}, 'job_1', ['9']), 'absent');
    assert.equal(readHistoryRun(null, 'job_1', ['9']), null);
    assert.equal(
      readHistoryRun({ job_1: { status: { status_str: 'success' } } }, 'job_1', ['9']) !== null,
      true,
    );
    const shaped = readHistoryRun(
      {
        job_1: {
          status: { status_str: 'success', completed: true },
          outputs: {
            '9': {
              images: [{ filename: 'a.png', subfolder: '', type: 'output' }],
            },
          },
        },
      },
      'job_1',
      ['9'],
    );
    assert.deepEqual(shaped, {
      statusStr: 'success',
      failureDetail: null,
      images: [{ node: '9', filename: 'a.png', subfolder: '', type: 'output' }],
    });
  });

  it('sends the configured authorization without logging its value', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url, {
        authorization: 'Bearer test-key',
      });
      const completion = await adapter.submit(inputFor(), {
        deliveryId: 'del_1',
        jobId: 'job_1',
      });
      assert.equal(completion.status, 'succeeded');
      assert.equal(server.requests[0]?.hadAuth, true);
    });
  });
});
