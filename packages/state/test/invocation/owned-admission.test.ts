/**
 * V02.4 owned-admission pins: the state prepared-inputs leaf
 * (`state-generated/v1`) over loader-produced generated defs.
 *
 * Every behavior below is pinned against the current-TS oracle
 * (`validateCallInputs`, `admission.js`) — the prepared validator must
 * agree with it exactly (same refs, same normalized copy, same
 * aggregated field errors), while the plan itself carries only copied
 * data-only metadata (never a cached loader result) and refuses
 * unproven interim defs.
 *
 * Pins: presence-only scalars; positive <=15-digit versions;
 * extra-ref-member permissiveness; fresh generated arrays/shallow
 * copies; interim identity unchanged; operation defaults host-owned
 * (never filled); no caching of permissive unknown-loader results.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeValue } from '@canlang/values';
import type {
  CanonicalInputDef,
  ExecutionDescriptorSet,
  CanonicalOperationDescriptor,
  ModelName,
  OperationName,
  RecordVersion,
} from '@canlang/contracts';
import type { ClosedInputs, FieldError } from '@canlang/contracts';
import {
  isGeneratedOperationDef,
  loadArtifactDescriptors,
  loadExecutionDescriptorSet,
  type GeneratedOperationDef,
  type ArtifactDescriptorSlice,
  IncompatibleArtifactError,
  type InterimOperationDef,
} from '../../src/invocation/registry.js';
import { validateCallInputs } from '../../src/invocation/admission.js';
import {
  PREPARED_INPUTS_PROFILE,
  prepareDescriptorInputs,
  prepareOperationInputs,
  validatePreparedInputs,
  type PreparedOperationPlan,
} from '../../src/invocation/prepared-inputs.js';
import { StateError } from '../../src/errors.js';
import {
  OwnedInputError,
  OwnedJsonToken,
  ownedJsonValue,
  parseOwnedJsonBody,
} from '@canlang/values/bindings/owned-input';
import { asModel, asOperation, makeDef } from './fixtures.js';

const MODEL = asModel('Acme.Expense');
const OP = asOperation('Acme.approve');

function scalar(name: string, required: boolean): CanonicalInputDef {
  return { name, kind: 'string', required };
}

function versionedRef(name: string, required: boolean): CanonicalInputDef {
  return { name, kind: 'ref', model: MODEL, versioned: true, required };
}

function makeGenerated(
  inputs: CanonicalInputDef[],
  inputArrays: Record<string, { required: boolean }> = {},
): GeneratedOperationDef {
  const descriptor: CanonicalOperationDescriptor = {
    name: OP,
    kind: 'scenario',
    inputs,
  };
  return {
    generated: true,
    name: OP,
    kind: 'scenario',
    descriptor,
    by: 'members',
    inputArrays,
  };
}

function captureFields(fn: () => unknown): FieldError[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StateError, 'expected a StateError');
    assert.equal(error.code, 'validation');
    assert.ok(Array.isArray(error.fields), 'expected field-level detail');
    return error.fields as FieldError[];
  }
  assert.fail('expected a validation rejection');
}

describe('V02.4 owned admission: prepared-inputs leaf', () => {
  it('prepares a data-only plan carrying the state-generated/v1 profile tag', () => {
    const plan = prepareOperationInputs(makeGenerated([scalar('note', false)]));
    assert.equal(plan.profile, PREPARED_INPUTS_PROFILE);
    assert.equal(PREPARED_INPUTS_PROFILE, 'state-generated/v1');
    assert.equal(plan.operation, OP as string);
    assert.equal(plan.rules.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  });

  it('forwards only explicit checked enum wire claims without widening State admission', () => {
    for (const kind of ['scenario', 'read'] as const) {
      for (const suffix of ['', '?', '[]', '[]?']) {
        const valueType = `enum(one,two)${suffix}`;
        const array = suffix.includes('[]');
        const nullable = suffix.endsWith('?');
        const raw: ArtifactDescriptorSlice = { artifact_version: 1, models: [], operations: [{
          name: OP, kind, description: '', inputs: { fields: [{
            name: 'choice', field: { kind: 'enum', values: ['one', 'two'] }, required: false,
            valueType, computedDefault: true, nullable, ...(array ? { array: { required: false } } : {}),
          }] },
        }] };
        const set: ExecutionDescriptorSet = { contractVersion: 1, models: [], operations: [{
          name: OP, kind, inputs: [{ name: 'choice', kind: 'enum',
            enumValues: ['one', 'two'], required: false, valueType, computedDefault: true }],
        }] };
        const opts = { by: 'public' as const,
          ...(array ? { inputArrays: { [OP]: { choice: { required: false } } } } : {}) };
        for (const loaded of [loadArtifactDescriptors(raw, { by: 'public' }), loadExecutionDescriptorSet(set, opts)]) {
          const def = loaded.registry.get(OP)!;
          assert.ok(isGeneratedOperationDef(def));
          const input = def.descriptor.inputs[0]!;
          assert.ok(input.kind !== 'ref' && input.kind !== 'delivery');
          assert.equal(input.valueType, valueType);
          assert.ok(Object.isFrozen(input));
          assert.equal(input.computedDefault, true);
          assert.equal(def.preparedInputs!.rules[0]!.arrayFill, false);
          assert.deepEqual(validateCallInputs(def, {}).normalized, {});
          assert.deepEqual(validatePreparedInputs(def.preparedInputs!, {}).normalized, {});
          const supplied = { choice: 'outside' };
          if (!array) {
            assert.deepEqual(validateCallInputs(def, supplied).normalized, supplied);
            assert.deepEqual(validatePreparedInputs(def.preparedInputs!, supplied).normalized, supplied);
          }
          assert.deepEqual(decodeValue(valueType, array ? ['two'] : 'two'), array ? ['two'] : 'two');
          assert.throws(() => decodeValue(valueType, array ? ['outside'] : 'outside'));
          assert.throws(() => decodeValue(valueType, undefined));
          assert.throws(() => decodeValue(valueType, array ? [1] : 1));
          if (nullable) assert.equal(decodeValue(valueType, null), null);
          else assert.throws(() => decodeValue(valueType, null));
        }
        const reject = (change: Record<string, unknown>) => {
          assert.throws(() => loadArtifactDescriptors({ ...raw, operations: [{ ...raw.operations![0]!,
            inputs: { fields: [{ ...raw.operations![0]!.inputs.fields[0]!, ...change }] },
          }] }, { by: 'public' }), IncompatibleArtifactError);
        };
        reject({ valueType: `enum(two,one)${suffix}` });
        reject({ valueType: `enum(one,other)${suffix}` });
        reject({ valueType: `enum(one,two,)${suffix}` });
        reject({ nullable: !nullable });
        reject({ required: true });
        reject({ default: undefined });
        reject({ default: { kind: 'literal', value: 'one' } });
        const inheritedDefault = Object.assign(Object.create({ default: { kind: 'literal', value: 'one' } }),
          raw.operations![0]!.inputs.fields[0]!);
        assert.throws(() => loadArtifactDescriptors({ ...raw, operations: [{ ...raw.operations![0]!,
          inputs: { fields: [inheritedDefault] },
        }] }, { by: 'public' }), IncompatibleArtifactError);
        reject({ valueType: undefined });
        if (array) reject({ array: { required: true } });
        if (array || nullable) {
          const { valueType: _claim, ...unclaimed } = raw.operations![0]!.inputs.fields[0]!;
          assert.throws(() => loadArtifactDescriptors({ ...raw, operations: [{ ...raw.operations![0]!,
            inputs: { fields: [unclaimed] },
          }] }, { by: 'public' }), IncompatibleArtifactError);
        }
        reject({ array: array ? undefined : { required: false } });
        assert.throws(() => loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!,
          inputs: [{ name: 'choice', kind: 'enum', enumValues: ['one', 'two'], required: false,
            valueType: `enum(two,one)${suffix}` }],
        }] }, opts), IncompatibleArtifactError);
        if (array) {
          assert.throws(() => loadExecutionDescriptorSet(set, { by: 'public',
            inputArrays: { [OP]: { choice: { required: true } } } }), IncompatibleArtifactError);
          const canonical = set.operations[0]!.inputs[0]!;
          assert.ok(canonical.kind === 'enum');
          const { valueType: _claim, ...unclaimed } = canonical;
          assert.throws(() => loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!,
            inputs: [unclaimed],
          }] }, opts), IncompatibleArtifactError);
        }
      }
    }
    const refSet: ExecutionDescriptorSet = { contractVersion: 1, models: [{ name: MODEL, fields: {}, uniqueKeys: [], deleteMode: 'none' }],
      operations: [{ name: OP, kind: 'scenario', inputs: [{ name: 'record', kind: 'ref', model: MODEL, versioned: true, required: false, computedDefault: true }] }] };
    assert.throws(() => loadExecutionDescriptorSet(refSet, { by: 'public',
      inputArrays: { [OP]: { record: { required: false } } } }), IncompatibleArtifactError);
    assert.throws(() => loadExecutionDescriptorSet(refSet, { by: 'public',
      inputNullableRefs: { [OP]: { record: true } } }), IncompatibleArtifactError);
    const legacy = loadArtifactDescriptors({ artifact_version: 1, models: [], operations: [{
      name: OP, kind: 'scenario', description: '', inputs: { fields: [{ name: 'choice',
        field: { kind: 'enum', values: ['arbitrary label'] }, required: false, nullable: true } ] },
    }] }, { by: 'public' }).registry.get(OP)!;
    assert.ok(isGeneratedOperationDef(legacy));
    assert.equal(Object.hasOwn(legacy.descriptor.inputs[0]!, 'valueType'), false);
    assert.deepEqual(validateCallInputs(legacy, { choice: null }).normalized, { choice: null });
  });


  it('accepts presence-only scalars of every kind without value checks', () => {
    const kinds = [
      'string',
      'integer',
      'decimal',
      'money',
      'datetime',
      'boolean',
      'file',
    ] as const;
    const inputs: CanonicalInputDef[] = kinds.map((kind, index) => ({
      name: `v${index}`,
      kind,
      required: true,
    }));
    inputs.push({ name: 'choice', kind: 'enum', required: true, enumValues: ['a', 'b'] });
    const plan = prepareOperationInputs(makeGenerated(inputs));
    // Deliberately wrong-typed values: presence is all that matters.
    const supplied: ClosedInputs = {
      v0: 42,
      v1: 'not-an-integer',
      v2: { nested: true },
      v3: [1, 2],
      v4: false,
      v5: null,
      v6: 'whatever',
      choice: 'zzz-not-a-member',
    };
    const result = validatePreparedInputs(plan, supplied);
    assert.deepEqual(result.refs, []);
    assert.deepEqual(result.normalized, supplied);
  });

  it('admits positive versions up to 15 digits with safe-number conversion', () => {
    const plan = prepareOperationInputs(makeGenerated([versionedRef('record', true)]));
    const valid: Array<[string, number]> = [
      ['1', 1],
      ['9', 9],
      ['10', 10],
      ['900719925474099', 900719925474099],
      ['999999999999999', 999999999999999],
    ];
    for (const [version, expected] of valid) {
      const result = validatePreparedInputs(plan, { record: { id: 'r1', version } });
      assert.equal(result.refs.length, 1);
      assert.equal(result.refs[0]?.expectedVersion, expected as RecordVersion);
      assert.ok(Number.isSafeInteger(result.refs[0]?.expectedVersion as number));
    }
  });

  it('rejects non-canonical versions with invalid_version', () => {
    const plan = prepareOperationInputs(makeGenerated([versionedRef('record', true)]));
    const bad: unknown[] = [
      '0',
      '00',
      '01',
      '1.5',
      '-1',
      '+1',
      '',
      ' 1',
      '1 ',
      '9999999999999999',
      '123456789012345678901234567890',
      'v1',
      42,
      null,
      {},
      [],
    ];
    for (const version of bad) {
      const fields = captureFields(() =>
        validatePreparedInputs(plan, { record: { id: 'r1', version } }),
      );
      assert.deepEqual(fields, [
        {
          path: '/record',
          code: 'invalid_version',
          message: 'Input "record" carries a malformed record version.',
        },
      ]);
    }
  });

  it('requires versions on versioned refs but tolerates them on unversioned refs', () => {
    const def = makeGenerated([
      versionedRef('must', true),
      { name: 'may', kind: 'ref', model: MODEL, versioned: false, required: true },
    ]);
    const plan = prepareOperationInputs(def);
    const missing = captureFields(() =>
      validatePreparedInputs(plan, { must: { id: 'a' }, may: { id: 'b' } }),
    );
    assert.deepEqual(missing, [
      {
        path: '/must',
        code: 'version_required',
        message: 'Input "must" requires an expected version.',
      },
    ]);
    const admitted = validatePreparedInputs(plan, {
      must: { id: 'a', version: '3' },
      may: { id: 'b', version: '4' },
    });
    assert.equal(admitted.refs.length, 2);
    assert.equal(admitted.refs[1]?.expectedVersion, 4 as RecordVersion);
    const unversionedBare = validatePreparedInputs(plan, {
      must: { id: 'a', version: '3' },
      may: { id: 'b' },
    });
    assert.equal(unversionedBare.refs[1]?.expectedVersion, null);
  });

  it('ignores extra members on record refs (extra-ref permissiveness)', () => {
    const plan = prepareOperationInputs(makeGenerated([versionedRef('record', true)]));
    const result = validatePreparedInputs(plan, {
      record: { id: 'r1', version: '7', extra: 'ignored', nested: { deep: [1] } },
    });
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0]?.param, 'record');
    assert.equal(result.refs[0]?.model, MODEL);
    assert.equal(result.refs[0]?.id, 'r1');
    assert.equal(result.refs[0]?.expectedVersion, 7 as RecordVersion);
  });

  it('rejects malformed refs with invalid_ref', () => {
    const plan = prepareOperationInputs(makeGenerated([versionedRef('record', true)]));
    const bad: unknown[] = [null, [], 'r1', 42, {}, { id: '' }, { id: 42 }, { version: '1' }];
    for (const record of bad) {
      const fields = captureFields(() => validatePreparedInputs(plan, { record }));
      assert.deepEqual(fields, [
        {
          path: '/record',
          code: 'invalid_ref',
          message: 'Input "record" must be a record reference with an id.',
        },
      ]);
    }
  });

  it('fills omitted optional ordinary arrays with a fresh array per call', () => {
    const def = makeGenerated([scalar('tags', false)], { tags: { required: false } });
    const plan = prepareOperationInputs(def);
    const first = validatePreparedInputs(plan, {});
    const second = validatePreparedInputs(plan, {});
    assert.deepEqual(first.normalized, { tags: [] });
    assert.deepEqual(second.normalized, { tags: [] });
    assert.notStrictEqual(first.normalized['tags'], second.normalized['tags']);
    assert.ok(!Object.isFrozen(first.normalized));
    assert.ok(!Object.isFrozen(first.normalized['tags']));
  });

  it('preserves omitted array defaults and update changes in both validators', () => {
    for (const kind of ['scenario', 'create', 'update', 'read'] as const) {
      for (const withDefault of [false, true]) {
        const input: CanonicalInputDef = { name: 'counts', kind: 'integer', required: false,
          ...(withDefault ? { default: { kind: 'literal' as const, value: ['1', '2'] } } : {}) };
        const base = makeGenerated([input], { counts: { required: false } });
        const def: GeneratedOperationDef = { ...base, kind, descriptor: { ...base.descriptor, kind } };
        const plan = prepareOperationInputs(def);
        const expected = kind === 'update' || withDefault ? {} : { counts: [] };
        assert.deepEqual(validateCallInputs(def, {}).normalized, expected);
        assert.deepEqual(validatePreparedInputs(plan, {}).normalized, expected);
        for (const supplied of [{ counts: [] }, { counts: ['3'] }, { counts: null }]) {
          assert.deepEqual(validateCallInputs(def, supplied).normalized, supplied);
          assert.deepEqual(validatePreparedInputs(plan, supplied).normalized, supplied);
        }
        assert.equal(typeof plan.rules[0]!.arrayFill, 'boolean');
      }
    }
  });

  it('preserves checked computed scenario/read default omission through loader admission', () => {
    const operation = asOperation('Acme.computed');
    const malformed = (run: () => unknown) => assert.throws(run, (error: unknown) =>
      error instanceof IncompatibleArtifactError && error.reason === 'malformed_descriptor');
    for (const kind of ['scenario', 'read'] as const) for (const nullable of [false, true]) {
      const valueType = `int[]${nullable ? '?' : ''}`;
      const raw: ArtifactDescriptorSlice = { artifact_version: 1, models: [], operations: [{
        name: operation, kind, description: '', inputs: { fields: [
          { name: 'values', field: { kind: 'integer' }, required: false, nullable,
            array: { required: false }, computedDefault: true },
          { name: 'flag', field: { kind: 'boolean' }, required: false, computedDefault: true },
          { name: 'zero', field: { kind: 'integer' }, required: false, computedDefault: true },
        ] },
      }] };
      const set: ExecutionDescriptorSet = { contractVersion: 1, models: [], operations: [{
        name: operation, kind, inputs: [
          { name: 'values', kind: 'integer', required: false, valueType, computedDefault: true },
          { name: 'flag', kind: 'boolean', required: false, valueType: 'bool', computedDefault: true },
          { name: 'zero', kind: 'integer', required: false, valueType: 'int', computedDefault: true },
        ],
      }] };
      const options = { by: 'public' as const,
        inputArrays: { [operation]: { values: { required: false } } } };
      for (const loaded of [loadArtifactDescriptors(raw, { by: 'public' }),
        loadExecutionDescriptorSet(set, options)]) {
        const def = loaded.registry.get(operation)!;
        assert.ok(isGeneratedOperationDef(def));
        assert.ok(Object.isFrozen(def.descriptor.inputs[0]));
        assert.equal(def.preparedInputs!.rules[0]!.arrayFill, false);
        for (const supplied of [{}, { values: null }, { values: [], flag: false, zero: 0 }]) {
          assert.deepEqual(validateCallInputs(def, supplied).normalized, supplied);
          assert.deepEqual(validatePreparedInputs(def.preparedInputs!, supplied), validateCallInputs(def, supplied));
        }
        const invalid = { values: 0 };
        assert.equal(captureFields(() => validateCallInputs(def, invalid))[0]!.code, 'invalid_array');
        assert.deepEqual(captureFields(() => validatePreparedInputs(def.preparedInputs!, invalid)),
          captureFields(() => validateCallInputs(def, invalid)));
      }
      for (const change of [{ computedDefault: false }, { computedDefault: undefined },
        { computedDefault: 'true' }, { required: true }, { valueType: undefined },
        { default: { kind: 'literal', value: [] } }, { default: undefined },
        { kind: 'ref', model: MODEL, versioned: false }]) {
        const bad = { ...set, operations: [{ ...set.operations[0]!, inputs: [
          { ...set.operations[0]!.inputs[0]!, ...change },
        ] }] } as unknown as ExecutionDescriptorSet;
        malformed(() => loadExecutionDescriptorSet(bad, options));
      }
      for (const change of [{ computedDefault: false }, { computedDefault: undefined },
        { required: true }, { default: { kind: 'literal', value: [] } },
        { array: { required: true } }, { field: { kind: 'enum', values: ['one'] } }]) {
        const bad = { ...raw, operations: [{ ...raw.operations![0]!, inputs: { fields: [
          { ...raw.operations![0]!.inputs.fields[0]!, ...change },
        ] } }] } as unknown as ArtifactDescriptorSlice;
        malformed(() => loadArtifactDescriptors(bad, { by: 'public' }));
      }
      malformed(() => loadExecutionDescriptorSet(set, { ...options,
        inputArrays: { [operation]: { values: { required: true } } } }));
      for (const mutationKind of ['create', 'update'] as const) {
        malformed(() => loadExecutionDescriptorSet({ ...set, operations: [
          { ...set.operations[0]!, kind: mutationKind },
        ] }, options));
        malformed(() => loadArtifactDescriptors({ ...raw, operations: [
          { ...raw.operations![0]!, kind: mutationKind },
        ] }, { by: 'public' }));
      }
    }
    // Finite enum cases are checked/copied by intake; this marker claims
    // omission only. The existing scalar admission profile is unchanged.
    for (const kind of ['scenario', 'read'] as const) {
      const cases = ['one', 'two'];
      const raw: ArtifactDescriptorSlice = { artifact_version: 1, models: [], operations: [{
        name: operation, kind, description: '', inputs: { fields: [{
          name: 'choice', field: { kind: 'enum', values: cases }, required: false, computedDefault: true,
        }] },
      }] };
      const set: ExecutionDescriptorSet = { contractVersion: 1, models: [], operations: [{
        name: operation, kind, inputs: [{
          name: 'choice', kind: 'enum', enumValues: cases, required: false, computedDefault: true,
        }],
      }] };
      const options = { by: 'public' as const };
      for (const loaded of [loadArtifactDescriptors(raw, options), loadExecutionDescriptorSet(set, options)]) {
        const def = loaded.registry.get(operation)!;
        assert.ok(isGeneratedOperationDef(def));
        const input = def.descriptor.inputs[0]!;
        assert.equal(input.kind, 'enum');
        assert.equal(Object.hasOwn(input, 'computedDefault'), true);
        assert.equal(input.computedDefault, true);
        assert.equal(Object.hasOwn(input, 'valueType'), false);
        assert.equal(Object.hasOwn(input, 'default'), false);
        assert.notStrictEqual(input.enumValues, cases);
        assert.deepEqual(input.enumValues, ['one', 'two']);
        assert.ok(Object.isFrozen(input.enumValues));
        for (const supplied of [{}, { choice: 'two' }]) {
          assert.deepEqual(validateCallInputs(def, supplied).normalized, supplied);
          assert.deepEqual(validatePreparedInputs(def.preparedInputs!, supplied).normalized, supplied);
        }
      }
      for (const change of [{ computedDefault: false }, { computedDefault: undefined },
        { computedDefault: 'true' }, { required: true }, { default: undefined },
        { nullable: true }, { nullable: 'true' }, { array: { required: false } },
        { default: { kind: 'literal', value: 'one' } }]) {
        malformed(() => loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!,
          inputs: [{ ...set.operations[0]!.inputs[0]!, ...change }],
        }] } as unknown as ExecutionDescriptorSet, options));
        malformed(() => loadArtifactDescriptors({ ...raw, operations: [{ ...raw.operations![0]!,
          inputs: { fields: [{ ...raw.operations![0]!.inputs.fields[0]!, ...change }] },
        }] } as unknown as ArtifactDescriptorSlice, options));
      }
      for (const required of [false, true]) {
        malformed(() => loadExecutionDescriptorSet(set, { ...options,
          inputArrays: { [operation]: { choice: { required } } },
        }));
      }
      for (const values of [undefined, 'one', [''], [1]]) {
        malformed(() => loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!,
          inputs: [{ ...set.operations[0]!.inputs[0]!, enumValues: values }],
        }] } as unknown as ExecutionDescriptorSet, options));
        malformed(() => loadArtifactDescriptors({ ...raw, operations: [{ ...raw.operations![0]!,
          inputs: { fields: [{ ...raw.operations![0]!.inputs.fields[0]!, field: { kind: 'enum', values } }] },
        }] } as unknown as ArtifactDescriptorSlice, options));
      }
      for (const mutationKind of ['create', 'update'] as const) {
        malformed(() => loadExecutionDescriptorSet({ ...set, operations: [
          { ...set.operations[0]!, kind: mutationKind },
        ] }, options));
        malformed(() => loadArtifactDescriptors({ ...raw, operations: [
          { ...raw.operations![0]!, kind: mutationKind },
        ] }, options));
      }
      const inheritedEnum = Object.assign(Object.create({ computedDefault: true }),
        { name: 'choice', kind: 'enum', enumValues: cases, required: false });
      const inheritedArtifactEnum = Object.assign(Object.create({ computedDefault: true }),
        { name: 'choice', field: { kind: 'enum', values: cases }, required: false });
      for (const loaded of [
        loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!, inputs: [inheritedEnum] }] }, options),
        loadArtifactDescriptors({ ...raw, operations: [{ ...raw.operations![0]!,
          inputs: { fields: [inheritedArtifactEnum] },
        }] }, options),
      ]) {
        const def = loaded.registry.get(operation)!;
        assert.ok(isGeneratedOperationDef(def));
        assert.equal(Object.hasOwn(def.descriptor.inputs[0]!, 'computedDefault'), false);
        assert.deepEqual(validateCallInputs(def, {}).normalized, {});
        assert.deepEqual(validatePreparedInputs(def.preparedInputs!, {}).normalized, {});
      }
    }
    const inherited = Object.assign(Object.create({ computedDefault: true }),
      { name: 'values', kind: 'integer', required: false, valueType: 'int[]' });
    const loaded = loadExecutionDescriptorSet({ contractVersion: 1, models: [], operations: [{
      name: operation, kind: 'scenario', inputs: [inherited],
    }] }, { by: 'public', inputArrays: { [operation]: { values: { required: false } } } });
    const def = loaded.registry.get(operation)!;
    assert.ok(isGeneratedOperationDef(def));
    assert.equal(Object.hasOwn(def.descriptor.inputs[0]!, 'computedDefault'), false);
    assert.deepEqual(validateCallInputs(def, {}).normalized, { values: [] });
    assert.deepEqual(validatePreparedInputs(def.preparedInputs!, {}).normalized, { values: [] });
  });

  it('retains computed singular nonnullable ref omission through both descriptor intakes', () => {
    const malformed = (run: () => unknown) => assert.throws(run, (error: unknown) =>
      error instanceof IncompatibleArtifactError && error.reason === 'malformed_descriptor');
    for (const kind of ['scenario', 'read'] as const) for (const versioned of [false, true]) {
      const models = [{ name: MODEL, fields: [], deleteMode: 'archive' as const }];
      const input = { name: 'expense', kind: 'ref' as const, model: MODEL, versioned,
        required: false, computedDefault: true as const };
      const artifactInput = { name: 'expense', field: { kind: 'ref' as const, model: MODEL,
        requireVersion: versioned }, required: false, computedDefault: true as const };
      const set: ExecutionDescriptorSet = { contractVersion: 1,
        models: [{ name: MODEL, fields: {}, deleteMode: 'archive' }],
        operations: [{ name: OP, kind, inputs: [input] }] };
      const artifact: ArtifactDescriptorSlice = { artifact_version: 1, models, operations: [{
        name: OP, kind, description: '', inputs: { fields: [artifactInput] },
      }] };
      const options = { by: 'members' as const };
      for (const loaded of [loadExecutionDescriptorSet(set, options), loadArtifactDescriptors(artifact, options)]) {
        const def = loaded.registry.get(OP)!;
        assert.ok(isGeneratedOperationDef(def));
        assert.deepEqual(def.descriptor.inputs[0], input);
        assert.ok(Object.isFrozen(def.descriptor.inputs[0]));
        const supplied = { expense: { id: 'earlier-expense', version: '7' } };
        for (const inputs of [{}, supplied]) {
          const admitted = validateCallInputs(def, inputs);
          assert.deepEqual(admitted, validatePreparedInputs(def.preparedInputs!, inputs));
          assert.deepEqual(admitted.normalized, inputs);
        }
        assert.deepEqual(validateCallInputs(def, supplied).refs, [{ param: 'expense', model: MODEL,
          id: 'earlier-expense', expectedVersion: 7 }]);
        assert.deepEqual(captureFields(() => validateCallInputs(def, { expense: null })),
          captureFields(() => validatePreparedInputs(def.preparedInputs!, { expense: null })));
      }
      for (const change of [{ computedDefault: false }, { computedDefault: undefined },
        { computedDefault: 'true' }, { required: true }, { default: undefined },
        { default: { kind: 'literal', value: null } }, { nullable: true }, { nullable: 'true' },
        { array: undefined }, { array: { required: false } }, { array: { required: true } }]) {
        malformed(() => loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!,
          inputs: [{ ...input, ...change }],
        }] } as unknown as ExecutionDescriptorSet, options));
        malformed(() => loadArtifactDescriptors({ ...artifact, operations: [{ ...artifact.operations![0]!,
          inputs: { fields: [{ ...artifactInput, ...change }] },
        }] } as unknown as ArtifactDescriptorSlice, options));
      }
      for (const required of [false, true]) {
        malformed(() => loadExecutionDescriptorSet(set, { ...options,
          inputArrays: { [OP]: { expense: { required } } } }));
      }
      malformed(() => loadExecutionDescriptorSet(set, { ...options,
        inputNullableRefs: { [OP]: { expense: true } } }));
      for (const mutationKind of ['create', 'update'] as const) {
        malformed(() => loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!, kind: mutationKind }] }, options));
        malformed(() => loadArtifactDescriptors({ ...artifact, operations: [{ ...artifact.operations![0]!, kind: mutationKind }] }, options));
      }
      const { computedDefault: _canonicalMarker, ...unmarkedInput } = input;
      const { computedDefault: _artifactMarker, ...unmarkedArtifactInput } = artifactInput;
      for (const loaded of [
        loadExecutionDescriptorSet({ ...set, operations: [{ ...set.operations[0]!,
          inputs: [Object.assign(Object.create({ computedDefault: true }), unmarkedInput)] }] }, options),
        loadArtifactDescriptors({ ...artifact, operations: [{ ...artifact.operations![0]!, inputs: {
          fields: [Object.assign(Object.create({ computedDefault: true }), unmarkedArtifactInput)],
        } }] }, options),
      ]) {
        const def = loaded.registry.get(OP)!;
        assert.ok(isGeneratedOperationDef(def));
        assert.equal(Object.hasOwn(def.descriptor.inputs[0]!, 'computedDefault'), false);
      }
    }
  });

  it('preserves checked nullable array omissions for the owning default stage', () => {
    for (const kind of ['integer', 'datetime'] as const) {
      for (const nullable of [false, true]) {
        const valueType = `${kind === 'integer' ? 'int' : kind}[]${nullable ? '?' : ''}`;
        const operation = asOperation('Acme.inspect');
        const loaded = loadExecutionDescriptorSet({
          contractVersion: 1,
          models: [],
          operations: [{ name: operation, kind: 'scenario', inputs: [
            { name: 'values', kind, required: false, valueType },
          ] }],
        }, { by: 'public', inputArrays: { [operation]: { values: { required: false } } } });
        const def = loaded.registry.get(operation)!;
        assert.ok(isGeneratedOperationDef(def));
        const plan = def.preparedInputs!;
        assert.equal(plan.rules[0]!.arrayFill, !nullable);
        const expected = nullable ? {} : { values: [] };
        assert.deepEqual(validateCallInputs(def, {}).normalized, expected);
        assert.deepEqual(validatePreparedInputs(plan, {}).normalized, expected);
        for (const supplied of [{ values: null }, { values: [] }]) {
          assert.deepEqual(validateCallInputs(def, supplied).normalized, supplied);
          assert.deepEqual(validatePreparedInputs(plan, supplied).normalized, supplied);
        }
      }
    }
  });

  it('returns a fresh unfrozen shallow copy and never mutates the caller inputs', () => {
    const withTags = makeGenerated([scalar('note', false), scalar('tags', false)], {
      tags: { required: false },
    });
    const plan = prepareOperationInputs(withTags);
    const supplied: ClosedInputs = { note: 'hi' };
    const before = { ...supplied };
    const result = validatePreparedInputs(plan, supplied);
    assert.notStrictEqual(result.normalized, supplied);
    assert.deepEqual(supplied, before);
    assert.deepEqual(result.normalized, { note: 'hi', tags: [] });
    assert.ok(!Object.isFrozen(result.normalized));
  });

  it('enforces array shape only for present non-null array-marked values', () => {
    const def = makeGenerated([scalar('tags', false)], { tags: { required: false } });
    const plan = prepareOperationInputs(def);
    const nulled = validatePreparedInputs(plan, { tags: null });
    assert.deepEqual(nulled.normalized, { tags: null });
    const fields = captureFields(() => validatePreparedInputs(plan, { tags: 'nope' }));
    assert.deepEqual(fields, [
      { path: '/tags', code: 'invalid_array', message: 'Input "tags" must be an array.' },
    ]);
  });

  it('does not fill omissions for required array markers', () => {
    const def = makeGenerated([scalar('tags', false)], { tags: { required: true } });
    const plan = prepareOperationInputs(def);
    const result = validatePreparedInputs(plan, {});
    assert.deepEqual(result.normalized, {});
    assert.ok(!Object.hasOwn(result.normalized, 'tags'));
  });

  it('never fills operation defaults: defaults stay host-owned', () => {
    const withDefault: CanonicalInputDef = {
      name: 'note',
      kind: 'string',
      required: false,
      default: { kind: 'literal', value: 'host-default' },
    };
    const plan = prepareOperationInputs(makeGenerated([withDefault]));
    const omitted = validatePreparedInputs(plan, {});
    assert.deepEqual(omitted.normalized, {});
    const present = validatePreparedInputs(plan, { note: 'caller-value' });
    assert.deepEqual(present.normalized, { note: 'caller-value' });
  });

  it('aggregates unknown, required, array, ref, and version errors in current order', () => {
    const def = makeGenerated(
      [scalar('need', true), scalar('tags', false), versionedRef('record', true)],
      { tags: { required: false } },
    );
    const plan = prepareOperationInputs(def);
    const fields = captureFields(() =>
      validatePreparedInputs(plan, {
        bogusB: 1,
        bogusA: 2,
        tags: 'nope',
        record: { id: 'r1', version: 'bad' },
      }),
    );
    assert.deepEqual(fields, [
      { path: '/bogusB', code: 'unknown_input', message: 'Unknown input "bogusB".' },
      { path: '/bogusA', code: 'unknown_input', message: 'Unknown input "bogusA".' },
      { path: '/need', code: 'required', message: 'Missing required input "need".' },
      { path: '/tags', code: 'invalid_array', message: 'Input "tags" must be an array.' },
      {
        path: '/record',
        code: 'invalid_version',
        message: 'Input "record" carries a malformed record version.',
      },
    ]);
  });

  it('refuses interim defs: hand-built descriptors carry no proven provenance', () => {
    const interim: InterimOperationDef = makeDef({
      inputs: { note: { type: 'scalar', required: false } },
    });
    assert.throws(() => prepareOperationInputs(interim), /provenance/);
  });

  it('leaves interim input identity unchanged through the shared oracle', () => {
    const interim: InterimOperationDef = makeDef({
      inputs: { note: { type: 'scalar', required: false } },
    });
    const supplied: ClosedInputs = { note: 'kept' };
    const validated = validateCallInputs(interim, supplied);
    assert.strictEqual(validated.normalized, supplied);
  });

  it('copies plan metadata: post-registration source mutation cannot alter the plan', () => {
    const inputs: CanonicalInputDef[] = [scalar('note', false)];
    const arrays: Record<string, { required: boolean }> = {};
    const def = makeGenerated(inputs, arrays);
    const plan = prepareOperationInputs(def);
    // Hostile post-registration mutation of the source descriptor
    // (through the still-mutable aliases the caller retains).
    inputs.push(versionedRef('injected', true));
    inputs[0] = scalar('renamed', true);
    arrays['note'] = { required: false };
    arrays['sneaky'] = { required: false };
    assert.equal(plan.rules.length, 1);
    assert.equal(plan.rules[0]?.name, 'note');
    const result = validatePreparedInputs(plan, {});
    assert.deepEqual(result.normalized, {});
    const injected = captureFields(() =>
      validatePreparedInputs(plan, { injected: { id: 'x', version: '1' } }),
    );
    assert.deepEqual(injected, [
      { path: '/injected', code: 'unknown_input', message: 'Unknown input "injected".' },
    ]);
  });

  it('builds fresh plans per registry load: no hashless cache by operation name', () => {
    const set = {
      contractVersion: 1 as const,
      operations: [
        {
          name: asOperation('Acme.approve'),
          kind: 'scenario' as const,
          inputs: [{ name: 'note', kind: 'string' as const, required: false }],
        },
      ],
      models: [],
    };
    const first = loadExecutionDescriptorSet(set, { by: 'members' });
    const second = loadExecutionDescriptorSet(set, { by: 'members' });
    const firstDef = first.registry.get('Acme.approve');
    const secondDef = second.registry.get('Acme.approve');
    assert.ok(firstDef !== undefined && isGeneratedOperationDef(firstDef));
    assert.ok(secondDef !== undefined && isGeneratedOperationDef(secondDef));
    assert.ok(firstDef.preparedInputs !== undefined);
    assert.ok(secondDef.preparedInputs !== undefined);
    assert.notStrictEqual(firstDef.preparedInputs, secondDef.preparedInputs);
    assert.ok(Object.isFrozen(firstDef.preparedInputs));
    assert.ok(Object.isFrozen(firstDef.preparedInputs.rules));
  });

  it('attaches prepared plans through the artifact join with frozen rules', () => {
    const loaded = loadArtifactDescriptors(
      {
        artifact_version: 1 as const,
        operations: [
          {
            name: 'Acme.approve',
            kind: 'scenario',
            description: 'V02.4 owned-admission fixture.',
            inputs: {
              fields: [
                {
                  name: 'note',
                  field: { kind: 'string' },
                  required: false,
                },
              ],
            },
          },
        ],
        models: [],
      },
      { by: 'members' },
    );
    const def = loaded.registry.get('Acme.approve');
    assert.ok(def !== undefined && isGeneratedOperationDef(def));
    const plan = def.preparedInputs;
    assert.ok(plan !== undefined);
    assert.equal(plan.profile, 'state-generated/v1');
    assert.equal(plan.rules.length, 1);
    assert.ok(Object.isFrozen(plan));
    const result = validatePreparedInputs(plan, {});
    assert.deepEqual(result.normalized, {});
  });

  it('matches the current-TS oracle exactly across a valid/invalid matrix', () => {
    const def = makeGenerated(
      [
        scalar('need', true),
        scalar('want', false),
        scalar('tags', false),
        versionedRef('record', true),
        { name: 'link', kind: 'ref', model: MODEL, versioned: false, required: false },
      ],
      { tags: { required: false } },
    );
    const plan = prepareOperationInputs(def);
    const cases: ClosedInputs[] = [
      {},
      { need: 'n' },
      { need: 'n', want: null, tags: ['a'], record: { id: 'r', version: '12' } },
      { need: 'n', record: { id: 'r', version: '12' }, link: { id: 'l' }, stray: 1 },
      { tags: 'nope', record: { id: 'r' } },
      { need: 'n', record: { id: '', version: '01' }, link: 'nope' },
      { need: 'n', record: { id: 'r', version: '1', extra: [1] }, want: undefined },
    ];
    for (const supplied of cases) {
      let oracle: unknown;
      let oracleError: FieldError[] | null = null;
      try {
        oracle = validateCallInputs(def, supplied);
      } catch (error) {
        assert.ok(error instanceof StateError);
        oracleError = (error.fields ?? null) as FieldError[] | null;
      }
      let prepared: unknown;
      let preparedError: FieldError[] | null = null;
      try {
        prepared = validatePreparedInputs(plan, supplied);
      } catch (error) {
        assert.ok(error instanceof StateError);
        preparedError = (error.fields ?? null) as FieldError[] | null;
      }
      assert.deepEqual(preparedError, oracleError);
      assert.deepEqual(prepared, oracle);
    }
  });

  it('prepares directly from a descriptor plus array markers', () => {
    const descriptor: CanonicalOperationDescriptor = {
      name: OP,
      kind: 'scenario',
      inputs: [scalar('tags', false)],
    };
    const plan = prepareDescriptorInputs(descriptor, { tags: { required: false } });
    assert.equal(plan.operation, OP as string);
    const result = validatePreparedInputs(plan, {});
    assert.deepEqual(result.normalized, { tags: [] });
  });

  it('registers nothing on whole-set rejection: no partial prepared plan escapes', () => {
    assert.throws(
      () =>
        loadExecutionDescriptorSet(
          {
            contractVersion: 1 as const,
            operations: [
              {
                name: asOperation('Acme.approve'),
                kind: 'scenario' as const,
                inputs: [{ name: 'note', kind: 'bogus' as never, required: false }],
              },
            ],
            models: [],
          },
          { by: 'members' },
        ),
      /Unknown input kind/,
    );
  });
});

// Narrow nullable-ref repair controls: artifact-produced defs remain the oracle.
describe('checked nullable singular-ref admission', () => {
  function artifactDef(extra: Record<string, unknown> = {}, name = 'expense'): GeneratedOperationDef {
    const artifact = {
      artifact_version: 1,
      models: [{ name: MODEL, fields: [], deleteMode: 'archive' }],
      operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
        { name, field: { kind: 'ref', model: MODEL, requireVersion: true }, required: false, ...extra },
      ] } }],
    };
    const loaded = loadArtifactDescriptors(artifact as Parameters<typeof loadArtifactDescriptors>[0], { by: 'members' });
    const def = loaded.registry.get(OP);
    assert.ok(def !== undefined && isGeneratedOperationDef(def));
    return def;
  }
  function parity(def: GeneratedOperationDef, inputs: ClosedInputs) {
    const plan = prepareOperationInputs(def);
    try {
      const current = validateCallInputs(def, inputs);
      assert.deepEqual(validatePreparedInputs(plan, inputs), current);
      return current;
    } catch (error) {
      assert.ok(error instanceof StateError);
      assert.deepEqual(captureFields(() => validatePreparedInputs(plan, inputs)), error.fields);
      throw error;
    }
  }
  it('retains explicit null without a pending ref, and leaves omission absent', () => {
    const def = artifactDef({ nullable: true });
    assert.deepEqual(parity(def, { expense: null }), { normalized: { expense: null }, refs: [] });
    assert.deepEqual(parity(def, {}), { normalized: {}, refs: [] });
    assert.ok(Object.isFrozen(def.inputNullableRefs));
    assert.ok(Object.isFrozen(def.preparedInputs?.rules[0]?.ref));
    assert.equal(def.preparedInputs?.profile, 'state-generated/v1');
    const input = def.descriptor.inputs[0]!;
    assert.ok(input.kind === 'ref');
    assert.equal(input.nullable, true);
  });
  it('keeps non-null reference/version checks and aggregate error order', () => {
    const def = artifactDef({ nullable: true });
    assert.equal(parity(def, { expense: { id: 'e', version: '1', extra: true } }).refs.length, 1);
    for (const value of [undefined, {}, [], { id: 'e' }, { id: 'e', version: '01' }, { id: 'e', version: '1000000000000000' }]) {
      assert.throws(() => parity(def, { unknown: 1, expense: value }), StateError);
      const fields = captureFields(() => validateCallInputs(def, { unknown: 1, expense: value }));
      assert.equal(fields[0]?.code, 'unknown_input');
      assert.equal(fields[1]?.path, '/expense');
    }
  });
  it('does not infer nullability from optional, false or array metadata and rejects malformed claims', () => {
    for (const extra of [{}, { nullable: false }, { array: { required: false } }]) {
      assert.throws(() => parity(artifactDef(extra), { expense: null }), StateError);
    }
    const input = Object.assign(Object.create({ nullable: true }) as Record<string, unknown>, {
      name: 'expense', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: false,
    });
    const slice = { artifact_version: 1, models: [{ name: MODEL, fields: [], deleteMode: 'archive' }],
      operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [input] } }] };
    assert.throws(() => artifactDef({ nullable: 'true' }), IncompatibleArtifactError);
    assert.throws(() => loadArtifactDescriptors(slice as Parameters<typeof loadArtifactDescriptors>[0], { by: 'members' }), IncompatibleArtifactError);
  });
  it('preserves own proof for special input names without prototype array markers', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const def = artifactDef({ nullable: true }, name);
      assert.equal(Object.hasOwn(def.inputNullableRefs!, name), true);
      const inputs = JSON.parse(`{"${name}":null}`) as ClosedInputs;
      assert.deepEqual(parity(def, inputs), { normalized: inputs, refs: [] });
    }
  });
  it('copies intake-direct proof and rejects bad associations as whole-set errors', () => {
    const descriptor: CanonicalOperationDescriptor = { name: OP, kind: 'scenario', inputs: [versionedRef('expense', false), scalar('note', false)] };
    const set = { contractVersion: 1 as const, operations: [descriptor], models: [{ name: MODEL, fields: {}, deleteMode: 'archive' as const }] };
    const markers: Record<string, true> = { expense: true };
    const loaded = loadExecutionDescriptorSet(set, { by: 'members', inputNullableRefs: { [OP]: markers } });
    const def = loaded.registry.get(OP);
    assert.ok(def !== undefined && isGeneratedOperationDef(def));
    delete markers['expense'];
    assert.deepEqual(parity(def, { expense: null }), { normalized: { expense: null }, refs: [] });
    for (const proof of [{ missing: true }, { note: true }, { expense: false }]) {
      assert.throws(() => loadExecutionDescriptorSet(set, { by: 'members', inputNullableRefs: { [OP]: proof } as unknown as Record<string, Record<string, true>> }));
    }
    assert.throws(() => loadExecutionDescriptorSet(set, { by: 'members', inputNullableRefs: { [OP]: undefined } as unknown as Record<string, Record<string, true>> }));
    assert.throws(() => loadExecutionDescriptorSet(set, { by: 'members', inputNullableRefs: { missing: { expense: true } } }));
    assert.throws(() => loadExecutionDescriptorSet(set, { by: 'members', inputArrays: { [OP]: { expense: { required: false } } }, inputNullableRefs: { [OP]: { expense: true } } }));
    const inherited = Object.create({ expense: true }) as Record<string, true>;
    const legacy = loadExecutionDescriptorSet(set, { by: 'members', inputNullableRefs: { [OP]: inherited } }).registry.get(OP);
    assert.ok(legacy !== undefined && isGeneratedOperationDef(legacy));
    assert.throws(() => parity(legacy, { expense: null }), StateError);
  });
});

// Source-current shared carrier controls; these exercise wire shape, not row authority.
describe('checked operation array carriers and outer bounds', () => {
  function direct(input: Record<string, unknown>, hints?: Record<string, { required: boolean }>, kind = 'scenario') {
    const set = {
      contractVersion: 1, models: [{ name: MODEL, fields: {}, deleteMode: 'archive' }],
      operations: [{ name: OP, kind, inputs: [...(kind === 'update' ? [{ name: 'record', kind: 'ref', model: MODEL, versioned: true, required: false }] : []), input] }],
    };
    const loaded = loadExecutionDescriptorSet(set as unknown as ExecutionDescriptorSet,
      { by: 'members', ...(hints === undefined ? {} : { inputArrays: { [OP]: hints } }) });
    const def = loaded.registry.get(OP);
    assert.ok(def !== undefined && isGeneratedOperationDef(def));
    return def;
  }
  function artifact(extra: Record<string, unknown>, kind = 'scenario') {
    const slice = { artifact_version: 1,
      models: [{ name: MODEL, fields: [], deleteMode: 'archive' }],
      operations: [{ name: OP, kind, inputs: { fields: [{ name: 'records',
        field: { kind: 'ref', model: MODEL, requireVersion: true }, required: false, ...extra }] } }],
    };
    const loaded = loadArtifactDescriptors(slice as unknown as ArtifactDescriptorSlice, { by: 'members' });
    const def = loaded.registry.get(OP);
    assert.ok(def !== undefined && isGeneratedOperationDef(def));
    return def;
  }
  const ref = { name: 'records', kind: 'ref', model: MODEL, versioned: true, required: false };
  function parity(def: GeneratedOperationDef, inputs: ClosedInputs) {
    const plan = prepareOperationInputs(def);
    try {
      const result = validateCallInputs(def, inputs);
      assert.deepEqual(validatePreparedInputs(plan, inputs), result);
      return result;
    } catch (error) {
      assert.ok(error instanceof StateError);
      assert.deepEqual(captureFields(() => validatePreparedInputs(plan, inputs)), error.fields);
      throw error;
    }
  }
  it('copies ref carriers through both loaders and retains ordered repeated wire slots', () => {
    const extra = { array: { required: false }, nullable: true, min: 0, max: 3 };
    for (const def of [direct({ ...ref, ...extra }), artifact(extra)]) {
      const input = def.descriptor.inputs[0]!;
      assert.ok(input.kind === 'ref');
      assert.deepEqual(input.array, { required: false });
      assert.equal(input.nullable, true);
      assert.equal(input.min, 0);
      assert.equal(input.max, 3);
      assert.ok(Object.isFrozen(input.array));
      assert.deepEqual(parity(def, {}), { refs: [], normalized: {} });
      assert.deepEqual(parity(def, { records: null }), { refs: [], normalized: { records: null } });
      assert.deepEqual(parity(def, { records: [] }), { refs: [], normalized: { records: [] } });
      const rows = [{ id: 'b', version: '2', extra: 'preserved' }, { id: 'a', version: '1' }, { id: 'b', version: '2' }];
      assert.deepEqual(parity(def, { records: rows }), { normalized: { records: rows }, refs: [
        { param: 'records/0', model: MODEL, id: 'b', expectedVersion: 2 },
        { param: 'records/1', model: MODEL, id: 'a', expectedVersion: 1 },
        { param: 'records/2', model: MODEL, id: 'b', expectedVersion: 2 },
      ] });
      assert.deepEqual(rows[0], { id: 'b', version: '2', extra: 'preserved' });
    }
  });
  it('joins canonical markers without accepting contradictory hints or nonarray bounds', () => {
    assert.deepEqual(direct({ ...ref, array: { required: false }, min: 0 }, { records: { required: false } }).inputArrays.records, { required: false });
    assert.throws(() => direct({ ...ref, array: { required: false } }, { records: { required: true } }), IncompatibleArtifactError);
    assert.throws(() => direct({ ...ref, min: 0 }), IncompatibleArtifactError);
    assert.throws(() => artifact({ min: 0 }), IncompatibleArtifactError);
    const scalar = direct({ name: 'values', kind: 'integer', required: false, min: 1, max: 2 }, { values: { required: false } });
    assert.equal(scalar.descriptor.inputs[0]!.min, 1);
    assert.deepEqual(captureFields(() => parity(scalar, {})).map(field => field.code), ['min_length']);
    assert.deepEqual(parity(scalar, { values: [1] }).normalized, { values: [1] });
  });
  it('refuses malformed, lossy and inherited bounds and ref carriers without executing accessors', () => {
    for (const bound of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n, null, undefined]) {
      for (const key of ['min', 'max']) {
        assert.throws(() => direct({ ...ref, array: { required: false }, [key]: bound }), IncompatibleArtifactError);
        assert.throws(() => artifact({ array: { required: false }, [key]: bound }), IncompatibleArtifactError);
      }
    }
    assert.throws(() => direct({ ...ref, array: { required: false }, min: 2, max: 1 }), IncompatibleArtifactError);
    assert.throws(() => artifact({ array: { required: false }, min: 2, max: 1 }), IncompatibleArtifactError);
    for (const extra of [{ array: undefined }, { array: { required: 'false' } }, { nullable: undefined }, { nullable: 'true' }]) {
      assert.throws(() => direct({ ...ref, ...extra }), IncompatibleArtifactError);
      assert.throws(() => artifact(extra), IncompatibleArtifactError);
    }
    for (const marker of [
      Object.assign(Object.create({ inherited: true }), { required: false }),
      { required: false, extra: true },
      { required: false, [Symbol('extra')]: true },
    ]) {
      assert.throws(() => direct({ ...ref, array: marker }), IncompatibleArtifactError);
      assert.throws(() => artifact({ array: marker }), IncompatibleArtifactError);
    }
    const plainMarker = Object.assign(Object.create(null), { required: false });
    assert.deepEqual(direct({ ...ref, array: plainMarker }).inputArrays.records, { required: false });
    assert.deepEqual(artifact({ array: plainMarker }).inputArrays.records, { required: false });
    assert.throws(() => direct(Object.assign(Object.create({ min: 1 }), { ...ref, array: { required: false } })), IncompatibleArtifactError);
    let reads = 0;
    for (const key of ['min', 'max', 'array', 'nullable']) {
      const input = Object.defineProperty({ ...ref }, key, { get: () => { reads += 1; return 1; } });
      assert.throws(() => direct(input), IncompatibleArtifactError);
      const extra = Object.defineProperty({}, key, { get: () => { reads += 1; return 1; }, enumerable: true });
      // Build an actual accessor-bearing artifact input rather than spreading the extra.
      const slice = { artifact_version: 1, models: [{ name: MODEL, fields: [], deleteMode: 'archive' }],
        operations: [{ name: OP, kind: 'scenario', inputs: { fields: [Object.defineProperty({ name: 'records',
          field: { kind: 'ref', model: MODEL, requireVersion: true }, required: false }, key,
          Object.getOwnPropertyDescriptor(extra, key)!)] } }] };
      assert.throws(() => loadArtifactDescriptors(slice as unknown as ArtifactDescriptorSlice, { by: 'members' }), IncompatibleArtifactError);
    }
    assert.equal(reads, 0);
  });
  it('retains immutable copied bounds and exact error order in both loaded validators', () => {
    const raw = { ...ref, array: { required: false }, min: 1, max: 2 };
    const def = direct(raw);
    raw.min = 0; raw.max = 100; raw.array.required = true;
    const rule = def.preparedInputs!.rules[0]!;
    assert.equal(rule.min, 1); assert.equal(rule.max, 2);
    assert.ok(Object.isFrozen(rule));
    assert.deepEqual(captureFields(() => parity(def, { unknown: 1, records: [] })).map(field => [field.path, field.code]),
      [['/unknown', 'unknown_input'], ['/records', 'min_length']]);
    assert.deepEqual(captureFields(() => parity(def, {})).map(field => field.code), ['min_length']);
    assert.deepEqual(captureFields(() => parity(def, { records: [{ id: 'a', version: '1' }, { id: 'b', version: '2' }, { id: 'c', version: '3' }] })).map(field => field.code), ['max_length']);
    assert.deepEqual(captureFields(() => parity(def, { records: 'no' })).map(field => field.code), ['invalid_array']);
    assert.deepEqual(captureFields(() => parity(def, { records: [null, { id: 'a' }] })).map(field => [field.path, field.code]),
      [['/records/0', 'invalid_ref'], ['/records/1', 'version_required']]);
    for (const version of ['0', '01', '-1', '1.0', '1000000000000000', 1]) {
      assert.deepEqual(captureFields(() => parity(def, { records: [{ id: 'a', version }] })).map(field => [field.path, field.code]), [['/records/0', 'invalid_version']]);
    }
    assert.deepEqual(parity(def, { records: [{ id: 'a', version: '999999999999999' }] }).refs[0]!.expectedVersion, 999999999999999);
  });
  it('preserves optional fills, defaults, required presence and update omissions', () => {
    assert.deepEqual(parity(direct({ ...ref, array: { required: false }, min: 0 }), {}), { refs: [], normalized: { records: [] } });
    for (const def of [direct({ ...ref, array: { required: false }, min: 1, default: { kind: 'literal', value: [] } }),
      direct({ ...ref, array: { required: false }, min: 1 }, undefined, 'update')]) {
      assert.deepEqual(parity(def, {}), { refs: [], normalized: {} });
    }
    const required = direct({ ...ref, required: true, array: { required: true }, min: 1 });
    assert.deepEqual(captureFields(() => parity(required, {})).map(field => field.code), ['required']);
    assert.deepEqual(captureFields(() => parity(direct({ ...ref, array: { required: false } }), { records: null })).map(field => field.code), ['invalid_ref']);
    assert.throws(() => direct({ ...ref, computedDefault: true, array: { required: false } }), IncompatibleArtifactError);
  });
});

it('rejects inherited or accessor engine array hint channels without evaluating them', () => {
  const set: ExecutionDescriptorSet = { contractVersion: 1,
    models: [{ name: MODEL, fields: {}, deleteMode: 'archive' }],
    operations: [{ name: OP, kind: 'scenario', inputs: [
      { name: 'records', kind: 'ref', model: MODEL, versioned: true, required: false },
    ] }],
  };
  let reads = 0;
  const getter = () => { reads += 1; return { required: false }; };
  const marker = { required: false };
  const valid = { [OP]: { records: marker } };
  const options = [
    Object.assign(Object.create({ inputArrays: valid }), { by: 'members' }),
    Object.defineProperty({ by: 'members' }, 'inputArrays', { get: getter }),
    { by: 'members', inputArrays: Object.create({ [OP]: { records: marker } }) },
    { by: 'members', inputArrays: Object.defineProperty({}, OP, { get: getter, enumerable: true }) },
    { by: 'members', inputArrays: { [OP]: Object.create({ records: marker }) } },
    { by: 'members', inputArrays: { [OP]: Object.defineProperty({}, 'records', { get: getter, enumerable: true }) } },
    { by: 'members', inputArrays: { [OP]: { records: Object.create({ required: false }) } } },
    { by: 'members', inputArrays: { [OP]: { records: Object.defineProperty({}, 'required', { get: getter, enumerable: true }) } } },
  ];
  for (const opts of options) {
    assert.throws(() => loadExecutionDescriptorSet(set, opts as Parameters<typeof loadExecutionDescriptorSet>[1]), IncompatibleArtifactError);
  }
  assert.equal(reads, 0);
  const loaded = loadExecutionDescriptorSet(set, { by: 'members', inputArrays: valid });
  const def = loaded.registry.get(OP);
  assert.ok(def !== undefined && isGeneratedOperationDef(def));
  marker.required = true;
  assert.deepEqual(validateCallInputs(def, {}), { refs: [], normalized: { records: [] } });
  assert.deepEqual(validatePreparedInputs(prepareOperationInputs(def), {}), { refs: [], normalized: { records: [] } });
});

describe('owned token admission into prepared inputs', () => {
  const tokenFor = async (body: string) => {
    const bytes = new TextEncoder().encode(body);
    return parseOwnedJsonBody(
      new Request('http://owned.test/input', { method: 'POST', body }),
      async () => bytes,
    );
  };

  it('validates genuine parser-owned tokens exactly like plain inputs', async () => {
    const plan = prepareOperationInputs(makeGenerated([scalar('note', true), versionedRef('record', true)]));
    const supplied: ClosedInputs = { note: 'hi', record: { id: 'r1', version: '7' } };
    const token = await tokenFor(JSON.stringify(supplied));
    const owned = ownedJsonValue(token);
    assert.ok(Object.isFrozen(owned), 'parser output stays frozen');
    const viaToken = validatePreparedInputs(plan, token);
    assert.deepEqual(viaToken, validatePreparedInputs(plan, supplied));
    assert.deepEqual(viaToken.normalized, supplied);
    assert.notStrictEqual(viaToken.normalized, owned, 'normalized output is a fresh copy');
    assert.ok(!Object.isFrozen(viaToken.normalized));
  });

  it('aggregates field errors from owned input in order', async () => {
    const plan = prepareOperationInputs(makeGenerated([scalar('note', true)]));
    const token = await tokenFor('{"extra":1}');
    assert.deepEqual(captureFields(() => validatePreparedInputs(plan, token)), [
      { path: '/extra', code: 'unknown_input', message: 'Unknown input "extra".' },
      { path: '/note', code: 'required', message: 'Missing required input "note".' },
    ]);
  });

  it('refuses forged tokens at lineage resolution', () => {
    const plan = prepareOperationInputs(makeGenerated([scalar('note', false)]));
    assert.throws(
      () => validatePreparedInputs(plan, new OwnedJsonToken()),
      (error: unknown) =>
        error instanceof OwnedInputError &&
        (error as OwnedInputError).code === 'forged-token',
    );
  });

  it('rejects tokens resolving to non-objects as caller misuse', async () => {
    const plan = prepareOperationInputs(makeGenerated([scalar('note', false)]));
    for (const body of ['"str"', '42', 'null', '[1]']) {
      const token = await tokenFor(body);
      assert.throws(
        () => validatePreparedInputs(plan, token),
        /must resolve to an object/,
        body,
      );
    }
  });
});
