import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CanonicalModelDescriptor, ExecutionDescriptorSet, ModelName, OperationName } from '@canlang/contracts';
import {
  artifactToDescriptorSet,
  IncompatibleArtifactError,
  isGeneratedOperationDef,
  loadArtifactDescriptors,
  loadExecutionDescriptorSet,
  type ArtifactDescriptorSlice,
} from '../src/invocation/registry.js';
import { validateCallInputs } from '../src/invocation/admission.js';
import { prepareOperationInputs, validatePreparedInputs } from '../src/invocation/prepared-inputs.js';
import { buildModelTable, buildModelTableFromCanonical } from '../src/mutation/models.js';
import { runMutationWrites } from '../src/mutation/pipeline.js';
import { createTestMemoryStorage } from '../src/storage/memory.js';
import { pipelineContext, asId, captureStateError } from './mutation/fixtures.js';

const model = 'Example.Job' as ModelName;
const operation = 'Example.inspect' as OperationName;
const opts = { by: 'public' as const };
const sha256 = 'a'.repeat(64);

function artifact(): ArtifactDescriptorSlice {
  return {
    artifact_version: 1,
    models: [{ name: model, deleteMode: 'archive', fields: [
      { name: 'count', field: { kind: 'integer' }, required: false, serverOnly: false,
        default: { kind: 'literal', value: '1' } },
    ] }],
    operations: [{ name: operation, kind: 'scenario', description: '', inputs: { fields: [] } }],
  };
}

function intake(): ExecutionDescriptorSet {
  return {
    contractVersion: 1,
    models: [{ name: model, deleteMode: 'archive', fields: {
      count: { required: false, serverOnly: false, valueType: 'int' },
    } }],
    operations: [{ name: operation, kind: 'scenario', inputs: [] }],
  };
}

function descriptor(loaded: ReturnType<typeof loadExecutionDescriptorSet>) {
  const def = loaded.registry.get(operation);
  assert.ok(def !== undefined && isGeneratedOperationDef(def));
  return def.descriptor;
}

function incompatible(run: () => unknown) {
  assert.throws(run, (error: unknown) => error instanceof IncompatibleArtifactError &&
    error.reason === 'malformed_descriptor');
}

test('only exact own supported tags establish an association', () => {
  const raw = artifact();
  const field = raw.models![0]!.fields[0]!;
  const loaded = loadArtifactDescriptors(raw, opts);
  assert.equal(loaded.models[0]!.fields.count!.valueType, 'int');
  assert.deepEqual(loaded.models[0]!.fields.count!.default, { kind: 'literal', value: '1' });
  assert.ok(Object.isFrozen(loaded.models[0]!.fields.count));
  for (const replacement of [
    { ...field, field: { kind: 'string' } },
    { ...field, field: { kind: 'other', type: 'int' } },
    { ...field, field: Object.create({ kind: 'integer' }) },
    Object.assign(Object.create({ field: { kind: 'integer' } }),
      { name: 'count', required: false, serverOnly: false }),
    { name: 'count', required: false, serverOnly: false },
  ]) {
    const changed = { ...raw, models: [{ ...raw.models![0]!, fields: [replacement] }] } as ArtifactDescriptorSlice;
    assert.equal(Object.hasOwn(loadArtifactDescriptors(changed, opts).models[0]!.fields.count!, 'valueType'), false);
  }
});

test('canonical loading checks its own finite scalar profile without inferring defaults', () => {
  const set = intake();
  const loaded = loadExecutionDescriptorSet(set, opts);
  assert.equal(loaded.models[0]!.fields.count!.valueType, 'int');
  assert.equal(Object.hasOwn(loaded.models[0]!.fields.count!, 'default'), false);
  for (const extra of [{ valueType: 'string' }, { valueType: undefined },
    { valueType: 'int', array: { required: false } }, { valueType: 'int', nullable: true }]) {
    const changed = { ...set, models: [{ ...set.models[0]!, fields: {
      count: { required: false, serverOnly: false, ...extra },
    } }] } as unknown as ExecutionDescriptorSet;
    incompatible(() => loadExecutionDescriptorSet(changed, opts));
  }
  const inherited = Object.assign(Object.create({ valueType: 'int' }), { required: false, serverOnly: false });
  const changed = { ...set, models: [{ ...set.models[0]!, fields: { count: inherited } }] };
  assert.equal(Object.hasOwn(loadExecutionDescriptorSet(changed, opts).models[0]!.fields.count!, 'valueType'), false);
});

test('declared typed and void results are copied and frozen in both loading paths', () => {
  for (const type of ['int', 'int?', 'int[]', 'int[]?', 'datetime', 'datetime?', 'datetime[]', 'datetime[]?', 'text', 'text?', 'text[]', 'text[]?', 'bool', 'bool?', 'bool[]', 'bool[]?', 'decimal', 'decimal?', 'decimal[]', 'decimal[]?', 'money', 'money?', 'money[]', 'money[]?', 'date', 'date?', 'date[]', 'date[]?', 'duration', 'duration?', 'duration[]', 'duration[]?', 'user', 'user?', 'user[]', 'user[]?', 'void']) {
    const result = { type };
    const raw = artifact();
    raw.operations![0]!.result = result;
    const converted = artifactToDescriptorSet(raw);
    const loaded = loadArtifactDescriptors(raw, opts);
    const set = intake();
    const directResult = { type };
    const direct = loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!, result: directResult }] }, opts);
    result.type = 'string';
    directResult.type = 'string';
    assert.deepEqual(converted.set.operations[0]!.result, { type });
    assert.deepEqual(descriptor(loaded).result, { type });
    assert.deepEqual(descriptor(direct).result, { type });
    assert.ok(Object.isFrozen(converted.set.operations[0]!.result));
    assert.ok(Object.isFrozen(descriptor(loaded).result));
    assert.ok(Object.isFrozen(descriptor(direct).result));
  }
});

test('missing and inherited result claims stay unknown; explicit malformed claims reject', () => {
  assert.equal(Object.hasOwn(descriptor(loadArtifactDescriptors(artifact(), opts)), 'result'), false);
  assert.equal(Object.hasOwn(descriptor(loadExecutionDescriptorSet(intake(), opts)), 'result'), false);
  for (const result of [undefined, null, [], {}, { type: 'string' }, { type: 'integer' },
    { type: 'void?' }, { type: 'void[]' }, { type: 'int?[]' }, { type: 'datetime[][]' }, { type: 'decimal?[]' }, { type: 'money[][]' }, { type: 'date?[]' }, { type: 'duration[][]' }, { type: 'user?[]' }, { type: 'user[][]' },
    { type: 1 }, Object.create({ type: 'int' })]) {
    const raw = artifact();
    const changed = { ...raw, operations: [{ ...raw.operations![0]!, result }] } as unknown as ArtifactDescriptorSlice;
    incompatible(() => artifactToDescriptorSet(changed));
    incompatible(() => loadArtifactDescriptors(changed, opts));
    const set = intake();
    const direct = { ...set, operations: [{ ...set.operations[0]!, result }] } as unknown as ExecutionDescriptorSet;
    incompatible(() => loadExecutionDescriptorSet(direct, opts));
  }
  const raw = artifact();
  const inheritedOperation = Object.assign(Object.create({ result: { type: 'int' } }), raw.operations![0]);
  assert.equal(Object.hasOwn(descriptor(loadArtifactDescriptors({ ...raw, operations: [inheritedOperation] }, opts)), 'result'), false);
  const set = intake();
  const inheritedDirect = Object.assign(Object.create({ result: { type: 'int' } }), set.operations[0]);
  assert.equal(Object.hasOwn(descriptor(loadExecutionDescriptorSet({ ...set, operations: [inheritedDirect] }, opts)), 'result'), false);
});

test('generated read results admit only declared qualified ordinary model arrays in both loaders', () => {
  const type = `${model}[]`;
  const raw = artifact();
  raw.operations![0]!.kind = 'read';
  const result = { type };
  raw.operations![0]!.result = result;
  const converted = artifactToDescriptorSet(raw);
  const loaded = loadArtifactDescriptors(raw, opts);
  const set = intake();
  const direct = loadExecutionDescriptorSet({ ...set, operations: [
    { ...set.operations[0]!, kind: 'read', result },
  ] }, opts);
  result.type = 'Example.Unknown[]';
  for (const checked of [converted.set.operations[0]!.result, descriptor(loaded).result, descriptor(direct).result]) {
    assert.deepEqual(checked, { type });
    assert.ok(Object.isFrozen(checked));
  }
});

test('ordinary singular model results require a declared qualified nonnullable model in both loaders', () => {
  const check = (type: string, kind: 'scenario' | 'read' | 'create' | 'update' | 'delete', modelName = model) => {
    const raw = artifact();
    raw.models![0]!.name = modelName;
    raw.operations![0]!.kind = kind;
    const result = { type };
    raw.operations![0]!.result = result;
    const set = intake();
    const directResult = { type };
    return { result, directResult,
      artifact: () => loadArtifactDescriptors(raw, opts),
      direct: () => loadExecutionDescriptorSet({ ...set,
        models: [{ ...set.models[0]!, name: modelName }],
        operations: [{ ...set.operations[0]!, kind, result: directResult }],
      }, opts),
    };
  };
  for (const kind of ['scenario', 'read'] as const) {
    const claims = check(model, kind);
    const loaded = claims.artifact();
    const direct = claims.direct();
    claims.result.type = claims.directResult.type = 'Example.Unknown';
    for (const checked of [descriptor(loaded).result, descriptor(direct).result]) {
      assert.deepEqual(checked, { type: model });
      assert.ok(Object.isFrozen(checked));
    }
    const inline = check('enum(a,b)', kind);
    assert.deepEqual(descriptor(inline.artifact()).result, { type: 'enum(a,b)' });
    assert.deepEqual(descriptor(inline.direct()).result, { type: 'enum(a,b)' });
    for (const type of [`${model}?`, `${model}[][]`, `${model}[]!`, `${model}|Example.Other`,
      `ref ${model}`, 'Example.Unknown', 'Example.Contract', 'Job',
      'Example..Job', 'Example.Job ', 'member', 'json']) {
      const rejected = check(type, kind);
      incompatible(rejected.artifact);
      incompatible(rejected.direct);
    }
    // Membership cannot turn a bare name into a qualified model.
    for (const type of ['Job']) {
      const rejected = check(type, kind, type as ModelName);
      incompatible(rejected.artifact);
      incompatible(rejected.direct);
    }
  }
  for (const kind of ['create', 'update', 'delete'] as const) {
    const rejected = check(model, kind);
    incompatible(rejected.artifact);
    incompatible(rejected.direct);
  }
});

test('model array result claims refuse nullable/required/union/ref/unknown and non-read profiles', () => {
  for (const type of [`${model}?`, `${model}[]?`, `${model}[]!`, `${model}?[]`,
    `${model}[][]`, `${model}|${model}[]`, `ref ${model}[]`, 'ref(Example.Job)[]',
    'Example.Unknown[]', 'Example.Contract[]', ' Job[]', 'Job[]',
    'Example..Job[]', 'Example.Job []', 'member[]', 'json[]']) {
    const raw = artifact();
    raw.operations![0]!.kind = 'read';
    raw.operations![0]!.result = { type };
    const set = intake();
    const direct = { ...set, operations: [{ ...set.operations[0]!, kind: 'read' as const, result: { type } }] };
    incompatible(() => artifactToDescriptorSet(raw));
    incompatible(() => loadArtifactDescriptors(raw, opts));
    incompatible(() => loadExecutionDescriptorSet(direct, opts));
  }
  const inline = artifact();
  inline.operations![0]!.kind = 'read';
  inline.operations![0]!.result = { type: 'enum(a,b)[]' };
  assert.deepEqual(descriptor(loadArtifactDescriptors(inline, opts)).result, { type: 'enum(a,b)[]' });
  const inlineSet = intake();
  assert.deepEqual(descriptor(loadExecutionDescriptorSet({ ...inlineSet, operations: [
    { ...inlineSet.operations[0]!, kind: 'read', result: { type: 'enum(a,b)[]' } },
  ] }, opts)).result, { type: 'enum(a,b)[]' });
  // Membership alone does not admit an unqualified spelling.
  const unqualified = artifact();
  unqualified.models![0]!.name = 'Job';
  unqualified.operations![0]!.kind = 'read';
  unqualified.operations![0]!.result = { type: 'Job[]' };
  incompatible(() => loadArtifactDescriptors(unqualified, opts));
  const unqualifiedSet = intake();
  incompatible(() => loadExecutionDescriptorSet({ ...unqualifiedSet,
    models: [{ ...unqualifiedSet.models[0]!, name: 'Job' as ModelName }], operations: [
      { ...unqualifiedSet.operations[0]!, kind: 'read', result: { type: 'Job[]' } },
    ],
  }, opts));
  for (const kind of ['scenario', 'create', 'update', 'delete'] as const) {
    const raw = artifact();
    raw.operations![0]!.kind = kind;
    raw.operations![0]!.result = { type: `${model}[]` };
    const set = intake();
    incompatible(() => loadArtifactDescriptors(raw, opts));
    incompatible(() => loadExecutionDescriptorSet({ ...set, operations: [
      { ...set.operations[0]!, kind, result: { type: `${model}[]` } },
    ] }, opts));
  }
  const raw = artifact();
  raw.operations![0]!.kind = 'read';
  raw.operations![0]!.result = Object.create({ type: `${model}[]` });
  incompatible(() => loadArtifactDescriptors(raw, opts));
  const set = intake();
  incompatible(() => loadExecutionDescriptorSet({ ...set, operations: [
    { ...set.operations[0]!, kind: 'read', result: Object.create({ type: `${model}[]` }) },
  ] }, opts));
  const inherited = Object.assign(Object.create({ result: { type: `${model}[]` } }), raw.operations![0]);
  delete inherited.result;
  assert.equal(Object.hasOwn(descriptor(loadArtifactDescriptors({ ...raw, operations: [inherited] }, opts)), 'result'), false);
});

test('own source revisions are validated, copied and frozen without inventing load authority', () => {
  const raw = artifact();
  const source = { path: 'Example.can', sha256 };
  raw.sources = [source];
  const converted = artifactToDescriptorSet(raw);
  const loaded = loadArtifactDescriptors(raw, opts);
  source.path = 'changed.can';
  raw.sources.push({ path: 'extra.can', sha256 });
  assert.deepEqual(converted.sources, [{ path: 'Example.can', sha256 }]);
  assert.deepEqual(loaded.sources, [{ path: 'Example.can', sha256 }]);
  assert.ok(Object.isFrozen(loaded.sources));
  assert.ok(Object.isFrozen(loaded.sources![0]));
  assert.equal(Object.hasOwn(loadArtifactDescriptors(artifact(), opts), 'sources'), false);
  const inherited = Object.assign(Object.create({ sources: [{ path: 'inherited.can', sha256 }] }), artifact());
  assert.equal(Object.hasOwn(loadArtifactDescriptors(inherited, opts), 'sources'), false);
  for (const sources of [undefined, null, {}, [null], new Array(1), [{ path: '', sha256 }],
    [{ path: 'Example.can', sha256: 'A'.repeat(64) }], [Object.create({ path: 'Example.can', sha256 })]]) {
    const changed = { ...artifact(), sources } as unknown as ArtifactDescriptorSlice;
    incompatible(() => artifactToDescriptorSet(changed));
    incompatible(() => loadArtifactDescriptors(changed, opts));
  }
});

test('model table retains the checked association and the existing wire default', () => {
  const loaded = loadArtifactDescriptors(artifact(), opts);
  const table = buildModelTableFromCanonical(loaded.models);
  const field = table.get(model)!.fields.count!;
  assert.equal(field.valueType, 'int');
  assert.equal(field.default, '1');
  assert.ok(Object.isFrozen(field));
  const invalid = [{ ...loaded.models[0]!, fields: {
    count: { required: false, serverOnly: false, valueType: 'string' },
  } }] as CanonicalModelDescriptor[];
  assert.throws(() => buildModelTableFromCanonical(invalid), /Invalid valueType/);
});

test('released NumericControl artifact retains integer metadata and unknown legacy result', () => {
  const raw = JSON.parse(readFileSync(new URL(
    '../../test/fixtures/numeric-control/artifact.json', import.meta.url,
  ), 'utf8')) as ArtifactDescriptorSlice;
  const source = readFileSync(new URL('../../test/fixtures/numeric-control/source.can', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), raw.sources![0]!.sha256);
  const loaded = loadArtifactDescriptors(raw, opts);
  const numericModel = 'NumericControl.Job' as ModelName;
  const count = loaded.models.find((entry) => entry.name === numericModel)!.fields.count!;
  assert.equal(count.valueType, 'int');
  assert.deepEqual(count.default, { kind: 'literal', value: '1' });
  const def = loaded.registry.get('NumericControl.increment');
  assert.ok(def !== undefined && isGeneratedOperationDef(def));
  assert.equal(Object.hasOwn(def.descriptor, 'result'), false);
  const table = buildModelTableFromCanonical(loaded.models);
  assert.equal(table.get(numericModel)!.fields.count!.valueType, 'int');
  assert.equal(table.get(numericModel)!.fields.count!.default, '1');
  assert.deepEqual(loaded.sources, raw.sources);
});


test('artifact model tags and scenario input tags preserve arrays and nullable containers', () => {
  for (const kind of ['integer', 'datetime'] as const) {
    for (const array of [undefined, { required: false }, { required: true }]) {
      for (const nullable of [false, true]) {
        const type = `${kind === 'integer' ? 'int' : kind}${array ? '[]' : ''}${nullable ? '?' : ''}`;
        const raw = artifact();
        const field = { name: 'count', field: { kind }, required: false, serverOnly: false,
          nullable, ...(array ? { array } : {}) };
        raw.models![0]!.fields = [field];
        raw.operations![0]!.inputs.fields = [{ name: 'value', field: { kind }, required: false,
          nullable, ...(array ? { array } : {}), default: { kind: 'literal', value: '1' } }];
        const loaded = loadArtifactDescriptors(raw, opts);
        const scalar = descriptor(loaded).inputs[0]!;
        assert.ok(scalar.kind !== 'ref' && scalar.kind !== 'delivery');
        assert.equal(scalar.valueType, type);
        assert.ok(Object.isFrozen(scalar));
        assert.deepEqual(scalar.default, { kind: 'literal', value: '1' });
        assert.equal(loaded.models[0]!.fields.count!.valueType, type);
        assert.equal(loaded.models[0]!.fields.count!.nullable, nullable);
        const table = buildModelTableFromCanonical(loaded.models, { nullableFields: loaded.nullableFields });
        assert.equal(table.get(model)!.fields.count!.valueType, type);
        assert.equal(table.get(model)!.fields.count!.nullable === true, nullable);
      }
    }
  }
});

test('direct scalar input claims agree with kind and engine array markers', () => {
  for (const kind of ['integer', 'datetime'] as const) {
    for (const array of [false, true]) {
      for (const nullable of [false, true]) {
        const type = `${kind === 'integer' ? 'int' : kind}${array ? '[]' : ''}${nullable ? '?' : ''}`;
        const set = intake();
        const typed = { ...set, operations: [{ ...set.operations[0]!, inputs: [
          { name: 'value', kind, required: false, valueType: type },
        ] }] };
        const markers = array ? { inputArrays: { [operation]: { value: { required: false } } } } : {};
        const loaded = descriptor(loadExecutionDescriptorSet(typed, { ...opts, ...markers }));
        const scalar = loaded.inputs[0]!;
        assert.ok(scalar.kind !== 'ref' && scalar.kind !== 'delivery');
        assert.equal(scalar.valueType, type);
        assert.ok(Object.isFrozen(scalar));
        incompatible(() => loadExecutionDescriptorSet(typed, { ...opts,
          ...(array ? {} : { inputArrays: { [operation]: { value: { required: true } } } }) }));
      }
    }
  }
  for (const valueType of [undefined, 'integer', 'datetime[][]', 'int?[]', 'string', 'void', 'datetime']) {
    const set = intake();
    const changed = { ...set, operations: [{ ...set.operations[0]!, inputs: [
      { name: 'value', kind: 'integer', required: false, valueType },
    ] }] } as unknown as ExecutionDescriptorSet;
    incompatible(() => loadExecutionDescriptorSet(changed, opts));
  }
  const set = intake();
  const untyped = { ...set, operations: [{ ...set.operations[0]!, inputs: [
    Object.assign(Object.create({ valueType: 'int' }),
      { name: 'value', kind: 'integer', required: false, default: { kind: 'literal', value: '1' } }),
  ] }] };
  const scalar = descriptor(loadExecutionDescriptorSet(untyped, opts)).inputs[0]!;
  assert.equal(Object.hasOwn(scalar, 'valueType'), false);
});

test('canonical model nullable claims are checked without adding omission fills', () => {
  const set = intake();
  const typed = { ...set, models: [{ ...set.models[0]!, fields: {
    count: { required: false, serverOnly: false, valueType: 'datetime[]?',
      array: { required: true }, nullable: true },
  } }] };
  const loaded = loadExecutionDescriptorSet(typed, opts);
  assert.ok(Object.isFrozen(loaded.models[0]!.fields.count));
  assert.equal(buildModelTableFromCanonical(loaded.models).get(model)!.fields.count!.nullable, undefined);
  for (const nullable of [false, undefined, 'true']) {
    const changed = { ...typed, models: [{ ...typed.models[0]!, fields: {
      count: { ...typed.models[0]!.fields.count, nullable },
    } }] } as unknown as ExecutionDescriptorSet;
    incompatible(() => loadExecutionDescriptorSet(changed, opts));
    assert.throws(() => buildModelTableFromCanonical(changed.models), /Invalid valueType/);
  }
  const raw = artifact();
  const bad = { ...raw, models: [{ ...raw.models![0]!, fields: [
    { ...raw.models![0]!.fields[0]!, nullable: 'true' },
  ] }] } as unknown as ArtifactDescriptorSlice;
  incompatible(() => loadArtifactDescriptors(bad, opts));
});


test('legacy input carriers/defaults and inherited tags do not invent associations', () => {
  for (const field of [{ kind: 'string' }, Object.create({ kind: 'integer' })]) {
    const raw = artifact();
    raw.operations![0]!.inputs.fields = [{ name: 'value', field, required: false,
      default: { kind: 'literal', value: '1' } }];
    const scalar = descriptor(loadArtifactDescriptors(raw, opts)).inputs[0]!;
    assert.equal(Object.hasOwn(scalar, 'valueType'), false);
  }
  for (const valueType of [undefined, 'string', 'datetime']) {
    const raw = artifact();
    const bad = { ...raw, models: [{ ...raw.models![0]!, fields: [
      { ...raw.models![0]!.fields[0]!, valueType },
    ] }] } as unknown as ArtifactDescriptorSlice;
    incompatible(() => artifactToDescriptorSet(bad));
  }
});


test('own artifact associations require an exact owning supported tag for models and inputs', () => {
  const tagVariants = [
    { field: { kind: 'string' } },
    { field: { kind: 'ref', model, requireVersion: false } },
    {},
    { field: Object.create({ kind: 'integer' }) },
  ];
  for (const tag of tagVariants) {
    const raw = artifact();
    const claimedModelField = { name: 'count', required: false, serverOnly: false,
      ...tag, valueType: 'int' };
    const claimedInput = { name: 'value', required: false, ...tag, valueType: 'int' };
    for (const changed of [
      { ...raw, models: [{ ...raw.models![0]!, fields: [claimedModelField] }] },
      { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [claimedInput] } }] },
    ]) {
      incompatible(() => artifactToDescriptorSet(changed as unknown as ArtifactDescriptorSlice));
      incompatible(() => loadArtifactDescriptors(changed as unknown as ArtifactDescriptorSlice, opts));
    }
  }
  const raw = artifact();
  const inheritedField = Object.assign(Object.create({ field: { kind: 'integer' } }),
    { name: 'count', required: false, serverOnly: false, valueType: 'int' });
  const inheritedInput = Object.assign(Object.create({ field: { kind: 'integer' } }),
    { name: 'value', required: false, valueType: 'int' });
  for (const changed of [
    { ...raw, models: [{ ...raw.models![0]!, fields: [inheritedField] }] },
    { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [inheritedInput] } }] },
  ]) {
    incompatible(() => artifactToDescriptorSet(changed));
    incompatible(() => loadArtifactDescriptors(changed, opts));
  }
});


test('checked text, bool, decimal, money and user associations preserve scalar, array and nullable profiles', () => {
  for (const kind of ['string', 'boolean', 'decimal', 'money', 'user'] as const) {
    const base = kind === 'string' ? 'text' : kind === 'boolean' ? 'bool' : kind;
    for (const array of [undefined, { required: false }, { required: true }]) {
      for (const nullable of [false, true]) {
        const valueType = `${base}${array ? '[]' : ''}${nullable ? '?' : ''}`;
        const raw = artifact();
        const shape = { field: { kind }, required: false, nullable, ...(array ? { array } : {}),
          ...(kind === 'string' ? { valueType } : {}) };
        raw.models![0]!.fields = [{ name: 'count', serverOnly: false, ...shape }];
        raw.operations![0]!.inputs.fields = [{ name: 'value', ...shape }];
        const loaded = loadArtifactDescriptors(raw, opts);
        assert.equal(loaded.models[0]!.fields.count!.valueType, valueType);
        const input = descriptor(loaded).inputs[0]!;
        assert.ok(input.kind !== 'ref' && input.kind !== 'delivery');
        assert.equal(input.valueType, valueType);
        assert.ok(Object.isFrozen(input));
        assert.ok(Object.isFrozen(loaded.models[0]!.fields.count));
        const table = buildModelTableFromCanonical(loaded.models, { nullableFields: loaded.nullableFields });
        assert.equal(table.get(model)!.fields.count!.valueType, valueType);
        const direct = intake();
        const typed = { ...direct, models: loaded.models, operations: [{ ...direct.operations[0]!,
          inputs: [{ name: 'value', kind, required: false, valueType }] }] };
        const canonical = loadExecutionDescriptorSet(typed, { ...opts,
          ...(array ? { inputArrays: { [operation]: { value: array } } } : {}) });
        assert.deepEqual(descriptor(canonical).inputs[0], input);
      }
    }
  }
});

test('text requires an own source claim and mismatched text/bool associations reject', () => {
  for (const claimed of [false, true]) {
    const raw = artifact();
    const field = Object.assign(Object.create(claimed ? { valueType: 'text' } : null),
      { name: 'count', field: { kind: 'string' }, required: false, serverOnly: false,
        default: { kind: 'literal', value: 'text carrier' } });
    const input = Object.assign(Object.create(claimed ? { valueType: 'text' } : null),
      { name: 'value', field: { kind: 'string' }, required: false,
        default: { kind: 'literal', value: 'text carrier' } });
    raw.models![0]!.fields = [field];
    raw.operations![0]!.inputs.fields = [input];
    const loaded = loadArtifactDescriptors(raw, opts);
    assert.equal(Object.hasOwn(loaded.models[0]!.fields.count!, 'valueType'), false);
    assert.equal(Object.hasOwn(descriptor(loaded).inputs[0]!, 'valueType'), false);
  }
  for (const kind of ['string', 'boolean'] as const) {
    const mismatch = kind === 'string' ? 'bool' : 'text';
    const raw = artifact();
    for (const changed of [
      { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count', field: { kind },
        required: false, serverOnly: false, valueType: mismatch }] }] },
      { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [{ name: 'value',
        field: { kind }, required: false, valueType: mismatch }] } }] },
    ]) incompatible(() => loadArtifactDescriptors(changed, opts));
    const direct = intake();
    incompatible(() => loadExecutionDescriptorSet({ ...direct, operations: [{ ...direct.operations[0]!,
      inputs: [{ name: 'value', kind, required: false, valueType: mismatch }] }] }, opts));
  }
  for (const valueType of ['text', 'bool']) {
    const raw = artifact();
    for (const tag of [{ field: Object.create({ kind: 'string' }) }, {},
      { field: { kind: 'ref', model, requireVersion: false } }]) {
      const changed = { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count',
        required: false, serverOnly: false, ...tag, valueType }] }] } as unknown as ArtifactDescriptorSlice;
      incompatible(() => loadArtifactDescriptors(changed, opts));
    }
    for (const extra of [{ array: { required: false } }, { nullable: true }]) {
      const direct = intake();
      const changed = { ...direct, models: [{ ...direct.models[0]!, fields: {
        count: { required: false, serverOnly: false, valueType, ...extra },
      } }] };
      incompatible(() => loadExecutionDescriptorSet(changed, opts));
      assert.throws(() => buildModelTableFromCanonical(changed.models), /Invalid valueType/);
    }
  }
});


test('decimal and money claims require owning kinds and reject malformed containers', () => {
  for (const kind of ['decimal', 'money'] as const) {
    const raw = artifact();
    for (const claim of [kind === 'decimal' ? 'money' : 'decimal', `${kind}[][]`, `${kind}?[]`,
      `${kind}[]`, `${kind}?`, undefined]) {
      const modelField = { name: 'count', field: { kind }, required: false, serverOnly: false,
        valueType: claim };
      const inputField = { name: 'value', field: { kind }, required: false, valueType: claim };
      for (const changed of [
        { ...raw, models: [{ ...raw.models![0]!, fields: [modelField] }] },
        { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [inputField] } }] },
      ]) incompatible(() => loadArtifactDescriptors(changed as unknown as ArtifactDescriptorSlice, opts));
    }
    const ownKindMissing = [undefined, Object.create({ kind }), { kind: 'ref', model, requireVersion: false }];
    for (const field of ownKindMissing) {
      const modelField = { name: 'count', field, required: false, serverOnly: false, valueType: kind };
      const inputField = { name: 'value', field, required: false, valueType: kind };
      for (const changed of [
        { ...raw, models: [{ ...raw.models![0]!, fields: [modelField] }] },
        { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [inputField] } }] },
      ]) incompatible(() => loadArtifactDescriptors(changed as unknown as ArtifactDescriptorSlice, opts));
    }
    for (const extra of [{ array: { required: false } }, { nullable: true }]) {
      const direct = intake();
      const changed = { ...direct, models: [{ ...direct.models[0]!, fields: {
        count: { required: false, serverOnly: false, valueType: kind, ...extra },
      } }] };
      incompatible(() => loadExecutionDescriptorSet(changed, opts));
      assert.throws(() => buildModelTableFromCanonical(changed.models), /Invalid valueType/);
    }
    const direct = intake();
    incompatible(() => loadExecutionDescriptorSet({ ...direct, operations: [{ ...direct.operations[0]!,
      inputs: [{ name: 'value', kind, required: false, valueType: kind === 'decimal' ? 'money' : 'decimal' }] }] }, opts));
    const legacy = { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count',
      field: Object.create({ kind }), required: false, serverOnly: false,
      default: { kind: 'literal' as const, value: kind === 'decimal' ? '1.25' : { minor: '125', currency: 'USD' } },
    }] }] };
    assert.equal(Object.hasOwn(loadArtifactDescriptors(legacy, opts).models[0]!.fields.count!, 'valueType'), false);
  }
});


test('date models and claimed string inputs retain date profiles while duration keeps its own kind', () => {
  for (const kind of ['date', 'duration'] as const) {
    for (const array of [undefined, { required: false }, { required: true }]) {
      for (const nullable of [false, true]) {
        const valueType = `${kind}${array ? '[]' : ''}${nullable ? '?' : ''}`;
        const raw = artifact();
        const shape = { required: false, nullable, ...(array ? { array } : {}) };
        raw.models![0]!.fields = [{ name: 'count', serverOnly: false, field: { kind }, ...shape }];
        raw.operations![0]!.inputs.fields = [{ name: 'value', field: { kind: kind === 'date' ? 'string' : kind },
          ...shape, ...(kind === 'date' ? { valueType } : {}) }];
        const loaded = loadArtifactDescriptors(raw, opts);
        const input = descriptor(loaded).inputs[0]!;
        assert.ok(input.kind !== 'ref' && input.kind !== 'delivery');
        assert.equal(input.valueType, valueType);
        assert.equal(input.kind, kind === 'date' ? 'string' : kind);
        assert.equal(loaded.models[0]!.fields.count!.valueType, valueType);
        assert.ok(Object.isFrozen(input));
        assert.ok(Object.isFrozen(loaded.models[0]!.fields.count));
        const table = buildModelTableFromCanonical(loaded.models, { nullableFields: loaded.nullableFields });
        assert.equal(table.get(model)!.fields.count!.valueType, valueType);
        const direct = intake();
        const typed = { ...direct, models: loaded.models, operations: [{ ...direct.operations[0]!,
          inputs: [{ name: 'value', kind: kind === 'date' ? 'string' as const : kind, required: false, valueType }] }] };
        const canonical = loadExecutionDescriptorSet(typed, { ...opts,
          ...(array ? { inputArrays: { [operation]: { value: array } } } : {}) });
        assert.deepEqual(descriptor(canonical).inputs[0], input);
      }
    }
  }
});

test('date and duration claims reject mismatched owners and malformed container markers', () => {
  const raw = artifact();
  for (const kind of ['date', 'duration'] as const) {
    for (const valueType of [kind === 'date' ? 'duration' : 'int', `${kind}[][]`, `${kind}?[]`, undefined]) {
      const changed = { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count', field: { kind },
        required: false, serverOnly: false, valueType }] }] } as unknown as ArtifactDescriptorSlice;
      incompatible(() => loadArtifactDescriptors(changed, opts));
    }
    for (const extra of [{ array: { required: false } }, { nullable: true }]) {
      const direct = intake();
      const changed = { ...direct, models: [{ ...direct.models[0]!, fields: {
        count: { required: false, serverOnly: false, valueType: kind, ...extra },
      } }] };
      incompatible(() => loadExecutionDescriptorSet(changed, opts));
      assert.throws(() => buildModelTableFromCanonical(changed.models), /Invalid valueType/);
    }
    for (const field of [{ kind: 'string' }, Object.create({ kind }), undefined]) {
      const changed = { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count', field,
        required: false, serverOnly: false, valueType: kind }] }] } as unknown as ArtifactDescriptorSlice;
      incompatible(() => loadArtifactDescriptors(changed, opts));
    }
  }
  for (const kind of ['string', 'integer', 'duration'] as const) {
    const valueType = kind === 'duration' ? 'int' : 'duration';
    const direct = intake();
    incompatible(() => loadExecutionDescriptorSet({ ...direct, operations: [{ ...direct.operations[0]!,
      inputs: [{ name: 'value', kind, required: false, valueType }] }] }, opts));
  }
  for (const field of [Object.create({ kind: 'string' }), undefined]) {
    const changed = { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [{ name: 'value', field,
      required: false, valueType: 'date' }] } }] } as unknown as ArtifactDescriptorSlice;
    incompatible(() => loadArtifactDescriptors(changed, opts));
  }
  const unsupportedDateTag = { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [
    { name: 'value', field: Object.create({ kind: 'date' }), required: false, valueType: 'date' },
  ] } }] };
  assert.throws(() => loadArtifactDescriptors(unsupportedDateTag, opts),
    (error: unknown) => error instanceof IncompatibleArtifactError && error.reason === 'unknown_input_kind');
  const legacy = { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [
    Object.assign(Object.create({ valueType: 'date' }), { name: 'value', field: { kind: 'string' },
      required: false, default: { kind: 'literal', value: '2026-01-02' } }),
  ] } }] };
  assert.equal(Object.hasOwn(descriptor(loadArtifactDescriptors(legacy, opts)).inputs[0]!, 'valueType'), false);
});


test('user metadata requires an exact own user kind and never infers id-shaped carriers', () => {
  const raw = artifact();
  for (const claim of [undefined, 'text', 'user[][]', 'user?[]', 'user[]', 'user?']) {
    const modelField = { name: 'count', field: { kind: 'user' }, required: false, serverOnly: false,
      valueType: claim };
    const inputField = { name: 'value', field: { kind: 'user' }, required: false, valueType: claim };
    for (const changed of [
      { ...raw, models: [{ ...raw.models![0]!, fields: [modelField] }] },
      { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [inputField] } }] },
    ]) incompatible(() => loadArtifactDescriptors(changed as unknown as ArtifactDescriptorSlice, opts));
  }
  for (const field of [{ kind: 'string' }, { kind: 'ref', model, requireVersion: false },
    Object.create({ kind: 'user' }), undefined]) {
    for (const changed of [
      { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count', field,
        required: false, serverOnly: false, valueType: 'user' }] }] },
      { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [{ name: 'value', field,
        required: false, valueType: 'user' }] } }] },
    ]) incompatible(() => loadArtifactDescriptors(changed as unknown as ArtifactDescriptorSlice, opts));
  }
  for (const value of ['user-id', { id: 'user-id' }]) {
    const legacy = { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count',
      required: false, serverOnly: false, default: { kind: 'literal' as const, value },
    }] }] } as unknown as ArtifactDescriptorSlice;
    assert.equal(Object.hasOwn(loadArtifactDescriptors(legacy, opts).models[0]!.fields.count!, 'valueType'), false);
  }
  for (const extra of [{ array: { required: false } }, { nullable: true }]) {
    const direct = intake();
    const changed = { ...direct, models: [{ ...direct.models[0]!, fields: {
      count: { required: false, serverOnly: false, valueType: 'user', ...extra },
    } }] };
    incompatible(() => loadExecutionDescriptorSet(changed, opts));
    assert.throws(() => buildModelTableFromCanonical(changed.models), /Invalid valueType/);
  }
  const direct = intake();
  incompatible(() => loadExecutionDescriptorSet({ ...direct, operations: [{ ...direct.operations[0]!,
    inputs: [{ name: 'value', kind: 'user', required: false, valueType: 'text' }] }] }, opts));
});


test('checked File profiles preserve metadata and owning admission without inferring legacy claims', () => {
  for (const array of [undefined, { required: false }, { required: true }]) {
    for (const nullable of [false, true]) {
      const valueType = `file${array ? '[]' : ''}${nullable ? '?' : ''}`;
      const raw = artifact();
      const shape = { field: { kind: 'file' as const }, required: false, nullable, ...(array ? { array } : {}) };
      raw.models![0]!.fields = [{ name: 'count', serverOnly: false, ...shape }];
      raw.operations![0]!.inputs.fields = [{ name: 'value', ...shape }];
      raw.operations![0]!.result = { type: valueType };
      const loaded = loadArtifactDescriptors(raw, opts);
      const input = descriptor(loaded).inputs[0]!;
      assert.ok(input.kind === 'file');
      assert.equal(input.valueType, valueType);
      assert.equal(loaded.models[0]!.fields.count!.valueType, valueType);
      assert.deepEqual(descriptor(loaded).result, { type: valueType });
      assert.ok(Object.isFrozen(input));
      assert.ok(Object.isFrozen(descriptor(loaded).result));
      const table = buildModelTableFromCanonical(loaded.models, { nullableFields: loaded.nullableFields });
      assert.equal(table.get(model)!.fields.count!.valueType, valueType);
      assert.equal(table.get(model)!.fields.count!.nullable === true, nullable);
      const direct = intake();
      const canonical = loadExecutionDescriptorSet({ ...direct, models: loaded.models,
        operations: [{ ...direct.operations[0]!, inputs: [{ name: 'value', kind: 'file',
          required: false, valueType }], result: { type: valueType } }] }, { ...opts,
        ...(array ? { inputArrays: { [operation]: { value: array } } } : {}) });
      assert.deepEqual(descriptor(canonical).inputs[0], input);
      assert.deepEqual(descriptor(canonical).result, { type: valueType });
      const def = canonical.registry.get(operation)!;
      assert.ok(isGeneratedOperationDef(def));
      for (const value of [array ? [{ id: 'file-id' }] : { id: 'file-id' }, null]) {
        const supplied = { value };
        assert.deepEqual(validateCallInputs(def, supplied).normalized, supplied);
        assert.deepEqual(validatePreparedInputs(prepareOperationInputs(def), supplied),
          validateCallInputs(def, supplied));
      }
      assert.deepEqual(validatePreparedInputs(prepareOperationInputs(def), {}), validateCallInputs(def, {}));
    }
  }
  const direct = intake();
  const legacy = loadExecutionDescriptorSet({ ...direct, operations: [{ ...direct.operations[0]!,
    inputs: [{ name: 'value', kind: 'file', required: false }] }] }, opts);
  const def = legacy.registry.get(operation)!;
  assert.ok(isGeneratedOperationDef(def));
  assert.equal(Object.hasOwn(def.descriptor.inputs[0]!, 'valueType'), false);
  assert.deepEqual(validateCallInputs(def, { value: 'legacy-presence-only' }).normalized,
    { value: 'legacy-presence-only' });
});

test('checked File claims reject mismatched kinds and malformed scalar containers', () => {
  for (const valueType of [undefined, 'File', 'user', 'file[][]', 'file?[]', 'file[]', 'file?']) {
    const raw = artifact();
    for (const changed of [
      { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count', field: { kind: 'file' },
        required: false, serverOnly: false, valueType }] }] },
      { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [{ name: 'value',
        field: { kind: 'file' }, required: false, valueType }] } }] },
    ]) incompatible(() => loadArtifactDescriptors(changed as unknown as ArtifactDescriptorSlice, opts));
  }
  for (const field of [{ kind: 'user' }, Object.create({ kind: 'file' }), undefined]) {
    const raw = artifact();
    for (const changed of [
      { ...raw, models: [{ ...raw.models![0]!, fields: [{ name: 'count', field,
        required: false, serverOnly: false, valueType: 'file' }] }] },
      { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [{ name: 'value', field,
        required: false, valueType: 'file' }] } }] },
    ]) incompatible(() => loadArtifactDescriptors(changed as unknown as ArtifactDescriptorSlice, opts));
  }
  for (const extra of [{ array: { required: false } }, { nullable: true }, { valueType: 'file[][]' }]) {
    const direct = intake();
    const field = { required: false, serverOnly: false, valueType: 'file', ...extra };
    const changed = { ...direct, models: [{ ...direct.models[0]!, fields: { count: field } }] };
    incompatible(() => loadExecutionDescriptorSet(changed, opts));
    assert.throws(() => buildModelTableFromCanonical(changed.models), /Invalid valueType/);
    assert.throws(() => buildModelTable([{ ...buildModelTableFromCanonical(direct.models).get(model)!, fields: { count: field } }]), /Invalid valueType/);
  }
  for (const kind of ['user', 'file'] as const) {
    const direct = intake();
    incompatible(() => loadExecutionDescriptorSet({ ...direct, operations: [{ ...direct.operations[0]!,
      inputs: [{ name: 'value', kind, required: false, valueType: kind === 'file' ? 'user' : 'file' }] }] }, opts));
  }
  for (const type of ['File', 'file[][]', 'file?[]']) {
    const raw = artifact();
    raw.operations![0]!.result = { type };
    incompatible(() => loadArtifactDescriptors(raw, opts));
    const direct = intake();
    incompatible(() => loadExecutionDescriptorSet({ ...direct,
      operations: [{ ...direct.operations[0]!, result: { type } }] }, opts));
  }
});


function nominalArtifact(): ArtifactDescriptorSlice {
  const raw = artifact();
  raw.valueTypes = { contracts: [
    { name: 'Example.Request', fields: [{ name: 'count', type: 'int' }] },
    { name: 'Example.Decision', fields: [{ name: 'status', type: 'Example.Status' }] },
  ], enums: [{ name: 'Example.Status', cases: ['accept', 'refuse'] }] };
  raw.models![0]!.fields.push({ name: 'requests', field: { kind: 'nominal', name: 'Example.Request' },
    valueType: 'Example.Request[]!', array: { required: true }, required: true, serverOnly: false, nullable: false });
  raw.operations![0]!.inputs.fields.push({ name: 'request', field: { kind: 'nominal', name: 'Example.Request' },
    valueType: 'Example.Request?', nullable: true, required: false });
  raw.operations![0]!.result = { type: 'Example.Decision' };
  return raw;
}

test('bounded nominal alias fields retain the owning alias through both loaders and mutation constraints', async () => {
  const aliasName = 'ChangeReview.pick.choice';
  const raw = artifact();
  raw.valueTypes = { contracts: [], aliases: [{ name: aliasName, type: 'text', min: 2, max: 6, format: 'name' }] };
  raw.models![0]!.fields = [{ name: 'choice', field: { kind: 'nominal', name: aliasName },
    valueType: aliasName, required: true, serverOnly: false, min: 1, max: 5 }];
  const converted = artifactToDescriptorSet(raw);
  const loaded = [loadArtifactDescriptors(raw, opts), loadExecutionDescriptorSet(converted.set, opts)];
  for (const descriptors of loaded) {
    assert.ok(descriptors.valueSchema);
    const table = buildModelTableFromCanonical(descriptors.models, { valueSchema: descriptors.valueSchema });
    assert.equal(table.get(model)!.fields.choice!.valueType, aliasName);
    assert.equal(descriptors.valueSchema!.aliases![aliasName]!.lengthMin, 2);
    assert.equal(descriptors.valueSchema!.aliases![aliasName]!.lengthMax, 6);
    assert.throws(() => buildModelTableFromCanonical(descriptors.models), /Invalid valueType/);
    const { store } = createTestMemoryStorage();
    const run = (choice: string) => runMutationWrites({ table, store, context: pipelineContext({ operation: 'Example.Job.create' }),
      writes: [{ op: 'create', model, id: asId('alias-row'), data: { choice } }] });
    const accepted = await run('ab');
    assert.ok(accepted.writes[0]?.kind === 'insert');
    assert.equal(accepted.writes[0].row.data.choice, 'ab');
    for (const choice of ['a', 'abcdef', 'a b']) {
      const error = await captureStateError(run(choice));
      assert.equal(error.code, 'validation');
      assert.match(error.message, /Invalid field "choice"/);
    }
    assert.equal(await store.load(model, asId('alias-row')), null);
    assert.equal(await store.readRevision(), 0);
  }
  const dangling = (action: () => unknown) => assert.throws(action,
    error => error instanceof IncompatibleArtifactError && error.reason === 'dangling_reference');
  const changes: Array<[(candidate: ArtifactDescriptorSlice) => void, 'dangling_reference' | 'malformed_descriptor']> = [
    [candidate => { delete candidate.valueTypes; }, 'dangling_reference'],
    [candidate => { candidate.models![0]!.fields[0]!.valueType = 'ChangeReview.other.choice'; }, 'dangling_reference'],
    [candidate => { candidate.models![0]!.fields[0]!.min = 7; candidate.models![0]!.fields[0]!.max = 8; }, 'malformed_descriptor'],
    [candidate => { (candidate.models![0]!.fields[0]! as unknown as Record<string, unknown>).trim = 'yes'; }, 'malformed_descriptor'],
  ];
  for (const [change, reason] of changes) {
    const candidate = structuredClone(raw); change(candidate);
    assert.throws(() => loadArtifactDescriptors(candidate, opts),
      error => error instanceof IncompatibleArtifactError && error.reason === reason);
  }
  const inherited = Object.assign(Object.create({ valueTypes: raw.valueTypes }), raw);
  delete inherited.valueTypes;
  dangling(() => loadArtifactDescriptors(inherited, opts));
  const { valueTypes: _valueTypes, ...unowned } = structuredClone(converted.set);
  incompatible(() => loadExecutionDescriptorSet(unowned, opts));
});

test('source nominal inventory reaches operation intake and the final model table', () => {
  const raw = nominalArtifact();
  const loaded = loadArtifactDescriptors(raw, opts);
  assert.ok(loaded.valueSchema);
  assert.ok(loaded.valueTypes);
  assert.notEqual(loaded.valueTypes, raw.valueTypes);
  assert.ok(Object.isFrozen(loaded.valueTypes.contracts));
  assert.equal(descriptor(loaded).inputs[0]!.kind, 'nominal');
  assert.equal(descriptor(loaded).result!.type, 'Example.Decision');
  const table = buildModelTableFromCanonical(loaded.models, { valueSchema: loaded.valueSchema });
  assert.equal(table.get(model)!.fields.requests!.valueType, 'Example.Request[]!');
  assert.equal(table.get(model)!.fields.requests!.nullable, false);
  assert.throws(() => buildModelTableFromCanonical(loaded.models), /Invalid valueType/);
  assert.throws(() => buildModelTable([...table.values()]), /Invalid valueType/);
  assert.throws(() => buildModelTable([...table.values()], { valueSchema: {
    kind: 'normalized-schema', contracts: {}, enums: {}, operations: {},
  } }), /Invalid valueType/);
  assert.ok(buildModelTable([...table.values()], { valueSchema: loaded.valueSchema }).has(model));
  assert.ok(Object.isFrozen(loaded.valueSchema.contracts['Example.Request']));
});

test('nominal intake refuses dangling declarations and contradictory own wrappers', () => {
  for (const change of [
    (raw: ArtifactDescriptorSlice) => { delete raw.valueTypes; },
    (raw: ArtifactDescriptorSlice) => { raw.models![0]!.fields[1]!.field = { kind: 'nominal', name: 'Example.Missing' }; },
    (raw: ArtifactDescriptorSlice) => { raw.models![0]!.fields[1]!.valueType = 'Example.Request[]'; },
    (raw: ArtifactDescriptorSlice) => { raw.models![0]!.fields[1]!.array = { required: false }; },
    (raw: ArtifactDescriptorSlice) => { raw.models![0]!.fields[1]!.nullable = true; },
    (raw: ArtifactDescriptorSlice) => { raw.operations![0]!.inputs.fields[0]!.valueType = 'Example.Decision?'; },
    (raw: ArtifactDescriptorSlice) => { raw.operations![0]!.result = { type: 'Example.Missing' }; },
  ]) {
    const raw = nominalArtifact(); change(raw);
    assert.throws(() => loadArtifactDescriptors(raw, opts), IncompatibleArtifactError);
  }
});

test('value inventory rejects duplicates, malformed fields and dangling leaf types', () => {
  const invalid = [
    { contracts: [{ name: 'Example.Dup', fields: [] }, { name: 'Example.Dup', fields: [] }] },
    { contracts: [{ name: 'Example.Dup', fields: [] }], enums: [{ name: 'Example.Dup', cases: ['yes'] }] },
    { contracts: [{ name: 'Example.Value', fields: [{ name: 'x', type: 'int' }, { name: 'x', type: 'text' }] }] },
    { contracts: [{ name: 'Example.Value', fields: [{ name: 'x', type: 'Example.Missing' }] }] },
    { contracts: [{ name: 'Example.Value', fields: [{ name: 'x', type: 'int []' }] }] },
    { contracts: [], enums: [{ name: 'Example.Status', cases: ['yes', 'yes'] }] },
    { contracts: [{ name: 'Example.Value', fields: null }] },
    { contracts: [{ name: 'Example.Bad?', fields: [] }] },
    { contracts: [{ name: 'int', fields: [] }] },
  ];
  for (const [index, valueTypes] of invalid.entries()) {
    const raw = { ...artifact(), valueTypes } as unknown as ArtifactDescriptorSlice;
    const expected = index < 3 ? 'duplicate_name' : index === 3 ? 'dangling_reference' : 'malformed_descriptor';
    const mapped = (error: unknown) => error instanceof IncompatibleArtifactError && error.reason === expected;
    assert.throws(() => loadArtifactDescriptors(raw, opts), mapped);
    assert.throws(() => loadExecutionDescriptorSet({ ...intake(), valueTypes } as unknown as ExecutionDescriptorSet, opts), mapped);
  }
});

test('direct nominal input needs inventory and an exact required-array marker', () => {
  const set: ExecutionDescriptorSet = { ...intake(), valueTypes: { contracts: [{ name: 'Example.Request', fields: [] }] },
    operations: [{ name: operation, kind: 'scenario', inputs: [{ name: 'request', kind: 'nominal', valueType: 'Example.Request[]!', required: true }] }] };
  const loaded = loadExecutionDescriptorSet(set, { ...opts, inputArrays: { [operation]: { request: { required: true } } } });
  assert.equal(descriptor(loaded).inputs[0]!.kind, 'nominal');
  assert.throws(() => loadExecutionDescriptorSet(set, opts), IncompatibleArtifactError);
  assert.throws(() => loadExecutionDescriptorSet(set, { ...opts, inputArrays: { [operation]: { request: { required: false } } } }), IncompatibleArtifactError);
  const missing = { ...set }; delete missing.valueTypes;
  assert.throws(() => loadExecutionDescriptorSet(missing, { ...opts, inputArrays: { [operation]: { request: { required: true } } } }), IncompatibleArtifactError);
});

test('source Judgment deliveries preserve exact int64 versions and checked result leaves', () => {
  const raw = nominalArtifact();
  raw.models![0]!.fields.push({ name: 'decision', required: false, serverOnly: false, field: {
    kind: 'delivery', judgment: true, capability: 'Example.Decision', operation: 'evaluate', version: '9223372036854775807',
    result: { name: 'Example.Decision', fields: [{ name: 'status', type: 'Example.Status' }] },
  } });
  assert.ok(loadArtifactDescriptors(raw, opts).deliveryFields.get(model)!.has('decision'));
  for (const version of ['01', '-1', '9223372036854775808', '9'.repeat(20), 1]) {
    const changed = structuredClone(raw);
    (changed.models![0]!.fields[2]!.field as unknown as Record<string, unknown>).version = version;
    assert.throws(() => loadArtifactDescriptors(changed, opts), IncompatibleArtifactError);
  }
  const wrongOwner = structuredClone(raw);
  (wrongOwner.models![0]!.fields[2]!.field as unknown as Record<string, unknown>).capability = 'Example.Request';
  incompatible(() => loadArtifactDescriptors(wrongOwner, opts));
  const changed = structuredClone(raw);
  (changed.models![0]!.fields[2]!.field as unknown as { result: { fields: unknown[] } }).result.fields = [{ name: 'status', type: 'text' }];
  assert.throws(() => loadArtifactDescriptors(changed, opts), IncompatibleArtifactError);
});


test('named enums reuse ordered-case checks and checked nominal array requirements', () => {
  const raw = nominalArtifact();
  raw.operations![0]!.inputs.fields = [{ name: 'statuses', field: { kind: 'enum', values: ['accept', 'refuse'] },
    valueType: 'Example.Status[]!', array: { required: true }, nullable: false, required: true }];
  const loaded = loadArtifactDescriptors(raw, opts);
  assert.equal((descriptor(loaded).inputs[0] as { valueType: string }).valueType, 'Example.Status[]!');
  const changed = structuredClone(raw);
  changed.operations![0]!.inputs.fields[0]!.array = { required: false };
  assert.throws(() => loadArtifactDescriptors(changed, opts), IncompatibleArtifactError);
  changed.operations![0]!.inputs.fields[0]!.field = { kind: 'enum', values: ['refuse', 'accept'] };
  assert.throws(() => loadArtifactDescriptors(changed, opts), IncompatibleArtifactError);
});
