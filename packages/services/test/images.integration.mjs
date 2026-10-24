// Deployment-reviewed workflow -> typed review -> real Comfy HTTP lifecycle.
// Local endpoint scripts acceptance/uncertainty; this does not qualify a live
// Comfy installation, receiving File custody or the runtime dispatch join.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ComfyUINativeAdapter, digestGraph, MappingValidationError } from '@canlang/services';
import { startControlledComfyServer } from '@canlang/services/media/harness';

function configuration() {
  const graph = {
    3: { class_type: 'KSampler', inputs: { seed: 42, steps: 20, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent: ['5', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'approved.safetensors' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    9: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'reviewed-output' } },
  };
  const mapping = { workflow: 'configured-graph', graphDigest: digestGraph(graph), inputs: {
    prompt: { node: '6', key: 'text' }, negative: { node: '7', key: 'text' },
    width: { node: '5', key: 'width' }, height: { node: '5', key: 'height' }, seed: { node: '3', key: 'seed' },
  }, outputs: ['9'] };
  const binding = { capability: 'std.ImagesV1', capabilityVersion: 1, account: 'local-account', deployment: 'deployment.images' };
  const literal = (...values) => ({ kind: 'literal', values });
  const link = (node, output = 0) => ({ kind: 'link', node, output });
  const integer = (label, min, max) => ({ kind: 'integer', label, min, max });
  const text = label => ({ kind: 'text', label, maxLength: 8192 });
  const policy = { revision: 'reviewed-v1', maxNodes: 6, maxGraphBytes: 16384, outputs: ['9'], nodes: {
    3: { classType: 'KSampler', inputs: { seed: integer('Seed', 42, 42), steps: literal(20),
      model: link('4'), positive: link('6'), negative: link('7'), latent: link('5') } },
    4: { classType: 'CheckpointLoaderSimple', inputs: { ckpt_name: literal('approved.safetensors') } },
    5: { classType: 'EmptyLatentImage', inputs: { width: integer('Width', 256, 1536), height: integer('Height', 256, 1536) } },
    6: { classType: 'CLIPTextEncode', inputs: { text: text('Prompt'), clip: link('4', 1) } },
    7: { classType: 'CLIPTextEncode', inputs: { text: text('Negative prompt'), clip: link('4', 1) } },
    9: { classType: 'SaveImage', inputs: { images: link('3'), filename_prefix: literal('reviewed-output') } },
  } };
  const { seed: _seed, ...workflowInputs } = mapping.inputs;
  return { graph, mapping, binding, policy, workflow: { graph: mapping.workflow, ...workflowInputs } };
}
function install(server, config, policy = config.policy) {
  return new ComfyUINativeAdapter({ baseUrl: server.url, timeoutMs: 5000, maxBodyBytes: 65536,
    graph: config.graph, mapping: config.mapping, clientId: 'workflow-review', maxDownloadBytes: 65536, maxOutputs: 4,
  }).installImages({ binding: config.binding, workflow: config.workflow, seed: { kind: 'fixed', value: 42 },
    ...(policy === null ? {} : { workflowPolicy: policy }) });
}
function request(config, validation) {
  return { source: 'creative-original', revision: 1, workflow: structuredClone(config.workflow), validation,
    prompt: 'A quiet garden', negative: '', width: 512, height: 512, max_outputs: 1, max_duration: 4000n };
}
function options(deliveryId) { return { deliveryId, jobId: randomUUID(), deadlineMs: Date.now() + 3500 }; }

test('reviewed installation inspects and validates without generation, then constrains real provider submission', async () => {
  const server = await startControlledComfyServer({ kind: 'accept' });
  try {
    const config = configuration(), installed = install(server, config);
    assert.ok(installed.workflows);
    const inspected = await installed.workflows.inspect(config.workflow.graph, { deliveryId: 'creative-inspect' });
    assert.equal(inspected.delivery_id, 'creative-inspect'); assert.equal(inspected.status, 'succeeded');
    assert.deepEqual(inspected.result.fields, [
      { node: '6', key: 'text', kind: 'text', label: 'Prompt' }, { node: '7', key: 'text', kind: 'text', label: 'Negative prompt' },
      { node: '5', key: 'width', kind: 'int', label: 'Width' }, { node: '5', key: 'height', kind: 'int', label: 'Height' },
    ]);
    const validated = await installed.workflows.validate(config.workflow, { deliveryId: 'creative-validation' });
    assert.deepEqual(validated, { delivery_id: 'creative-validation', status: 'succeeded', error: null,
      result: { valid: true, digest: installed.validation, detail: null } });
    assert.notEqual(installed.validation, config.mapping.graphDigest);
    assert.equal(server.requests.length, 0, 'inspection and validation never contact or queue the provider');
    for (const changed of [{ ...config.workflow, graph: 'other-file' },
      { ...config.workflow, prompt: config.workflow.negative }, { ...config.workflow, extra: 'unowned' }]) {
      assert.deepEqual((await installed.workflows.validate(changed, { deliveryId: 'invalid-review' })).result,
        { valid: false, digest: null, detail: 'Workflow does not match this reviewed installation.' });
    }
    assert.equal((await installed.workflows.inspect('other-file', { deliveryId: 'unknown-graph' })).status, 'failed');
    const dangerous = { ...config.workflow };
    Object.defineProperty(dangerous, 'prompt', { enumerable: true, get() { throw Error('Do not evaluate authored accessors'); } });
    assert.equal((await installed.workflows.validate(dangerous, { deliveryId: 'accessor' })).result.valid, false);
    const input = request(config, validated.result.digest);
    for (const changes of [{ validation: config.mapping.graphDigest }, { width: 2048 }, { height: 128 }, { prompt: 'x'.repeat(8193) }]) {
      await assert.rejects(installed.images.submit({ ...input, ...changes }, options('refused')), /workflow|policy/i);
    }
    const accessor = { ...input };
    Object.defineProperty(accessor, 'width', { enumerable: true, get() { throw Error('Do not evaluate mutable getters'); } });
    await assert.rejects(installed.images.submit(accessor, options('accessor-input')), /closed own data/);
    assert.equal(server.requests.length, 0, 'invalid frozen tokens and substitutions refuse before HTTP');
    const originalOptions = options('creative-submit');
    const submitted = await installed.images.submit(input, originalOptions);
    assert.equal(submitted.status, 'succeeded'); assert.equal(submitted.result.job, originalOptions.jobId);
    assert.equal(server.prompts.length, 1);
    const sent = JSON.parse(server.requests[0].bodyText).prompt;
    assert.equal(sent['6'].inputs.text, input.prompt); assert.equal(sent['5'].inputs.width, 512);
    assert.equal(sent['4'].inputs.ckpt_name, 'approved.safetensors'); assert.equal(sent['3'].inputs.seed, 42);
    // Mutable deployment inputs cannot rewrite the installed review or graph.
    config.policy.nodes['4'].inputs.ckpt_name.values[0] = 'unreviewed.safetensors';
    config.graph['4'].inputs.ckpt_name = 'unreviewed.safetensors';
    config.workflow.prompt.node = '7';
    inspected.result.fields[0].label = 'changed by caller';
    assert.equal((await installed.workflows.inspect('configured-graph', { deliveryId: 'again' })).result.fields[0].label, 'Prompt');
    assert.equal((await installed.workflows.validate(input.workflow, { deliveryId: 'again' })).result.digest, validated.result.digest);
    assert.equal(install(server, configuration()).validation, installed.validation, 'reopen the exact installation retains the same review token');
    const revised = configuration(); revised.policy.revision = 'reviewed-v2';
    const different = install(server, revised);
    assert.notEqual(different.validation, installed.validation);
    await assert.rejects(different.images.submit(input, options('old-review')), /validation/);
    assert.equal(server.prompts.length, 1);
    const legacy = install(server, configuration(), null);
    assert.equal(legacy.workflows, undefined, 'no implicit successful inspection without a whole-graph policy');
    assert.equal(legacy.validation, configuration().mapping.graphDigest);
  } finally { await server.close(); }
});

test('whole-graph admission rejects unmapped unsafe settings before a provider can execute them', async () => {
  const server = await startControlledComfyServer({ kind: 'accept' });
  try {
    for (const alter of [
      value => { value.graph.evil = { class_type: 'NetworkRequest', inputs: { url: 'https://unapproved.example' } }; },
      value => { value.graph['4'].inputs.ckpt_name = '../../unapproved.safetensors'; },
      value => { value.graph['9'].inputs.filename_prefix = '/tmp/escape'; },
      value => { value.graph['3'].inputs.steps = 1000000; },
      value => { value.graph['3'].inputs.credential = 'unowned-secret'; },
      value => { value.graph['3'].inputs.model = ['4', 99]; },
      value => { value.graph['3'].class_type = 'UnapprovedSampler'; },
      value => { value.graph['6'].inputs.text = ['4', 0]; },
      value => { value.mapping.outputs = ['4']; },
      value => { value.policy.maxNodes = 5; },
      value => { value.policy.maxGraphBytes = 10; },
    ]) {
      const config = configuration(); alter(config); config.mapping.graphDigest = digestGraph(config.graph);
      assert.throws(() => install(server, config), MappingValidationError);
    }
    assert.equal(server.requests.length, 0); assert.equal(server.prompts.length, 0);
  } finally { await server.close(); }
});


test('an uncertain reviewed submission keeps its original provider job on reconcile after installation reopen', async () => {
  const server = await startControlledComfyServer({ kind: 'hang-submit' });
  try {
    const config = configuration(), installed = install(server, config);
    const original = options('creative-uncertain'); original.deadlineMs = Date.now() + 100;
    const input = { ...request(config, installed.validation), max_duration: 100n };
    const submission = await installed.images.submit(input, original);
    assert.equal(submission.status, 'unknown'); assert.equal(submission.delivery_id, original.deliveryId);
    assert.deepEqual(server.prompts, [original.jobId]);
    const reopened = install(server, config), now = Date.now();
    const observed = await reopened.images.reconcile(input, { ...original,
      observation: { startedAtMs: now, deadlineMs: now + 500 } });
    assert.equal(observed.status, 'succeeded'); assert.equal(observed.result.state, 'unknown');
    assert.equal(observed.delivery_id, original.deliveryId);
    assert.deepEqual(server.prompts, [original.jobId], 'reconcile never submits a replacement job');
    assert.equal(server.requests.filter(value => value.method === 'POST').length, 1);
    assert.ok(server.requests.some(value => value.path === `/history/${original.jobId}`));
  } finally { await server.close(); }
});
