import assert from 'node:assert/strict';
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
import { buildModelTableFromCanonical } from '../src/mutation/models.js';

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
    '../../../../implementation/compiler-completion/numeric-control-producer/artifact.json', import.meta.url,
  ), 'utf8')) as ArtifactDescriptorSlice;
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
