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
import type {
  CanonicalInputDef,
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
