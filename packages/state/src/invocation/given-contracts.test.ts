/**
 * BGI-08 Given contracts at runtime (colocated): the loader folds checked
 * trait instantiations into effective models and validates keyword rules
 * into `state.unique-key@1` bindings; the pipeline then stages State-owned
 * computed claims/releases beside builtin uniques through the single fenced
 * commit. Covers the canonical-identity fixture (`"Ａlice"` vs `"Alice"`
 * conflict, `"Bob"` succeeds, spelling preserved), second-model reuse with
 * one saved evaluator, swaps, removal/archive, rollback, permission
 * refusal without evaluation, and replay without rerunning generated code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArtifactGivenKeyword,
  ArtifactGivenTrait,
  ArtifactModel,
  ArtifactModelField,
  ArtifactOperation,
  ArtifactOperationInput,
  ModelName,
  OperationName,
  RecordId,
} from '@canlang/contracts';
import {
  IncompatibleArtifactError,
  artifactToDescriptorSet,
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
} from './registry.js';
import { buildContext } from './context.js';
import { invoke } from './invoke.js';
import { buildModelTable, buildModelTableFromCanonical, type InterimModelDef } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { runMutationWrites } from '../mutation/pipeline.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { StorageConstraintError } from '../storage/port.js';
import { StateError } from '../errors.js';
import type { GivenUniqueKeyRule } from '../effects/staging.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  createMemoryIdentityStore,
  makeBatch,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
} from '../../test/invocation/fixtures.js';

const APP = 'tasks-app';
const ACCOUNT = 'Tasks.Account';
const MEMBER = 'Tasks.Member';
const TODO = 'Tasks.Todo';
const NOTE = 'Tasks.Note';
const QUOTE = 'Tasks.Quote';
const RULE = 'Tasks.Account.handle#canonical_identity';
const MEMBER_RULE = 'Tasks.Member.code#canonical_identity';
const FINGERPRINT = '0'.repeat(64);

/** Saved-implementation fixture: NFKC-normalize, then lowercase. */
function canonicalKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function modelField(
  name: string,
  field: ArtifactModelField['field'],
  opts: {
    required?: boolean;
    serverOnly?: boolean;
    valueType?: ArtifactModelField['valueType'];
    nullable?: boolean;
    array?: { required: boolean };
    trim?: boolean;
    min?: number;
    max?: number;
    default?: ArtifactModelField['default'];
  } = {},
): ArtifactModelField {
  return {
    name,
    field,
    required: opts.required ?? false,
    serverOnly: opts.serverOnly ?? false,
    ...(opts.valueType !== undefined ? { valueType: opts.valueType } : {}),
    ...(opts.nullable !== undefined ? { nullable: opts.nullable } : {}),
    ...(opts.array !== undefined ? { array: opts.array } : {}),
    ...(opts.trim !== undefined ? { trim: opts.trim } : {}),
    ...(opts.min !== undefined ? { min: opts.min } : {}),
    ...(opts.max !== undefined ? { max: opts.max } : {}),
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  };
}

function accountModel(): ArtifactModel {
  return {
    name: ACCOUNT,
    fields: [
      modelField('handle', { kind: 'string' }, { required: true }),
      modelField('title', { kind: 'string' }),
    ],
    deleteMode: 'archive',
  };
}

function scalarInput(name: string, kind: 'string' | 'integer', required: boolean): ArtifactOperationInput {
  return { name, field: { kind } as ArtifactOperationInput['field'], required };
}

function crudOps(model: string, fields: ArtifactOperationInput[]): ArtifactOperation[] {
  return [
    { name: `${model}.create`, kind: 'create', description: '', inputs: { fields } },
    {
      name: `${model}.update`,
      kind: 'update',
      description: '',
      inputs: { fields: [{ name: 'record', field: { kind: 'ref', model, requireVersion: true }, required: true }, ...fields] },
    },
    {
      name: `${model}.delete`,
      kind: 'delete',
      description: '',
      inputs: { fields: [{ name: 'record', field: { kind: 'ref', model, requireVersion: true }, required: true }] },
    },
  ];
}

function traitInstance(overrides: Partial<ArtifactGivenTrait> & { target: string }): ArtifactGivenTrait {
  return {
    id: `g-${overrides.target}`,
    owner: 'Tasks',
    inline: false,
    anchor: 'Tasks:trait:completable:',
    unitId: 'u1',
    fields: [],
    fingerprint: FINGERPRINT,
    order: 0,
    ...overrides,
  };
}

function keywordRule(overrides: Partial<ArtifactGivenKeyword> = {}): ArtifactGivenKeyword {
  return {
    ruleId: RULE,
    owner: 'Tasks',
    keyword: 'canonical_identity',
    anchor: 'Tasks:keyword:canonical_identity:',
    unitId: 'u3',
    producer: 'state.unique-key@1',
    semantics: 'nfkc-ascii-lowercase',
    lifecycle: 'commit-keys',
    export: 'canonicalKey',
    input: { name: 'field', type: 'text' },
    result: { type: 'text' },
    reads: [],
    effects: [],
    authority: [],
    dependencies: ['Tasks.Account.handle'],
    fingerprint: FINGERPRINT,
    targetModel: ACCOUNT,
    targetField: 'Tasks.Account.handle',
    args: [
      { name: 'target', value: ACCOUNT },
      { name: 'field', value: 'Tasks.Account.handle' },
    ],
    order: 0,
    ...overrides,
  };
}

function sliceWith(models: ArtifactModel[], givenContracts?: { traits: unknown[]; keywords: unknown[] }): ArtifactDescriptorSlice {
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, operations: [], models };
  if (givenContracts !== undefined) {
    slice.givenContracts = givenContracts as NonNullable<ArtifactDescriptorSlice['givenContracts']>;
  }
  return slice;
}

async function captureArtifactError(run: () => unknown): Promise<IncompatibleArtifactError> {
  try {
    await run();
  } catch (error) {
    assert.ok(
      error instanceof IncompatibleArtifactError,
      `expected IncompatibleArtifactError, got ${(error as Error)?.message}`,
    );
    return error;
  }
  throw new assert.AssertionError({ message: 'expected incompatible-artifact rejection' });
}

async function captureStateError(run: () => unknown): Promise<StateError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof StateError, `expected StateError, got ${(error as Error)?.message}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected StateError' });
}

describe('BGI-08 loader: trait fold', () => {
  it('loads artifacts without givenContracts with no bindings', () => {
    const loaded = loadArtifactDescriptors(sliceWith([accountModel()]), { by: 'members' });
    assert.deepEqual(loaded.givenUniqueKeys, []);
    assert.deepEqual(Object.keys(loaded.models[0]!.fields).sort(), ['handle', 'title']);
  });

  it('folds a named trait used twice into both models in order', () => {
    const todo: ArtifactModel = { name: TODO, fields: [modelField('title', { kind: 'string' }, { required: true })], deleteMode: 'archive' };
    const note: ArtifactModel = { name: NOTE, fields: [modelField('body', { kind: 'string' }, { required: true })], deleteMode: 'archive' };
    const done = { name: 'done', type: 'bool', default: 'false', trim: false };
    const loaded = loadArtifactDescriptors(
      sliceWith([todo, note], {
        traits: [
          traitInstance({ target: TODO, trait: 'completable', fields: [done], order: 0 }),
          traitInstance({ target: NOTE, trait: 'completable', fields: [done], order: 1 }),
        ],
        keywords: [],
      }),
      { by: 'members' },
    );
    for (const model of loaded.models) {
      const field = model.fields['done'];
      assert.ok(field !== undefined, `${model.name} gains done`);
      assert.deepEqual(field.default, { kind: 'literal', value: false });
      assert.equal(field.required, false);
    }
    assert.deepEqual(loaded.givenUniqueKeys, []);
  });

  it('folds an inline one-off onto its target only', () => {
    const quote: ArtifactModel = { name: QUOTE, fields: [modelField('title', { kind: 'string' }, { required: true })], deleteMode: 'archive' };
    const loaded = loadArtifactDescriptors(
      sliceWith([accountModel(), quote], {
        traits: [
          traitInstance({
            target: QUOTE, inline: true, unitId: 'u9', anchor: 'Tasks:inline:0:',
            fields: [{ name: 'archived', type: 'bool', default: 'false', trim: false }],
          }),
        ],
        keywords: [],
      }),
      { by: 'members' },
    );
    const names = new Map(loaded.models.map((model) => [model.name as string, Object.keys(model.fields)]));
    assert.ok(!names.get(ACCOUNT)!.includes('archived'));
    assert.ok(names.get(QUOTE)!.includes('archived'));
  });

  it('reuses exactly matching compiler-materialized fields once and refuses corruptions', () => {
    const done = modelField('done', { kind: 'boolean' }, {
      valueType: 'bool', default: { kind: 'literal', value: false },
    });
    const model: ArtifactModel = { name: TODO, fields: [done], deleteMode: 'archive' };
    const contribution = traitInstance({ target: TODO, trait: 'completable',
      fields: [{ name: 'done', type: 'bool', default: 'false', trim: false }] });
    const loaded = loadArtifactDescriptors(sliceWith([model], { traits: [contribution], keywords: [] }), { by: 'members' });
    assert.deepEqual(Object.keys(loaded.models[0]!.fields), ['done']);
    assert.deepEqual(loaded.models[0]!.fields['done']!.default, { kind: 'literal', value: false });
    const changes: Array<Partial<ArtifactModelField>> = [
      { default: { kind: 'literal', value: true } }, { required: true }, { serverOnly: true },
      { nullable: true }, { array: { required: false } }, { field: { kind: 'integer' } },
      { valueType: 'text' }, { trim: true }, { min: 0 }, { max: 5 },
    ];
    for (const change of changes) {
      assert.throws(() => loadArtifactDescriptors(sliceWith([{ ...model, fields: [{ ...done, ...change }] }],
        { traits: [contribution], keywords: [] }), { by: 'members' }), /conflicting runtime schema/);
    }
    assert.throws(() => loadArtifactDescriptors(sliceWith([model], {
      traits: [contribution, { ...contribution, unitId: 'u2', trait: 'other' }], keywords: [],
    }), { by: 'members' }), /already contributed by/);
    assert.throws(() => loadArtifactDescriptors(sliceWith([{ ...model, uniqueKeys: ['done'] }], {
      traits: [contribution], keywords: [],
    }), { by: 'members' }), /conflicting runtime schema/);
  });

  it('merges field-attachment constraints with strongest-wins bounds', () => {
    const quote: ArtifactModel = {
      name: QUOTE,
      fields: [modelField('title', { kind: 'string' }, { required: true, valueType: 'text', min: 1 })],
      deleteMode: 'archive',
    };
    const loaded = loadArtifactDescriptors(
      sliceWith([quote], {
        traits: [
          traitInstance({
            target: `${QUOTE}.title`, trait: 'clean', unitId: 'u2',
            fields: [{ name: 'v', type: 'text', trim: true, min: '5', max: '200' }],
          }),
        ],
        keywords: [],
      }),
      { by: 'members' },
    );
    const field = loaded.models[0]!.fields['title']!;
    assert.equal(field.trim, true);
    assert.equal(field.min, 5);
    assert.equal(field.max, 200);
  });

  it('refuses conflicting and unsupported contributions with reasons', async () => {
    const base: ArtifactModel = {
      name: QUOTE,
      fields: [modelField('title', { kind: 'string' }, { required: true, valueType: 'text' })],
      deleteMode: 'archive',
    };
    // Already declared.
    let error = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([base], {
        traits: [traitInstance({ target: QUOTE, trait: 'dup', fields: [{ name: 'title', type: 'text', default: '"x"', trim: false }] })],
        keywords: [],
      }),
      { by: 'members' },
    ));
    assert.equal(error.reason, 'duplicate_name');
    assert.match(error.message, /already declared/);
    // Already contributed by a sibling trait.
    error = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([base], {
        traits: [
          traitInstance({ target: QUOTE, trait: 'a', fields: [{ name: 'flag', type: 'bool', default: 'false', trim: false }] }),
          traitInstance({ target: QUOTE, trait: 'b', unitId: 'u2', fields: [{ name: 'flag', type: 'bool', default: 'true', trim: false }] }),
        ],
        keywords: [],
      }),
      { by: 'members' },
    ));
    assert.equal(error.reason, 'duplicate_name');
    assert.match(error.message, /already contributed by/);
    // New fields require their checked default.
    error = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([base], {
        traits: [traitInstance({ target: QUOTE, trait: 'bare', fields: [{ name: 'flag', type: 'bool', trim: false }] })],
        keywords: [],
      }),
      { by: 'members' },
    ));
    assert.equal(error.reason, 'malformed_descriptor');
    assert.match(error.message, /with no default/);
    // Types outside the v1 runtime set refuse explicitly.
    error = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([base], {
        traits: [traitInstance({ target: QUOTE, trait: 'rich', fields: [{ name: 'file', type: 'file', default: '"x"', trim: false }] })],
        keywords: [],
      }),
      { by: 'members' },
    ));
    assert.equal(error.reason, 'unsupported_given_contribution');
    assert.match(error.message, /explicit owner integration/);
    // Non-integer bounds refuse explicitly.
    error = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([base], {
        traits: [traitInstance({ target: QUOTE, trait: 'wide', fields: [{ name: 'nick', type: 'text', default: '"x"', trim: false, min: 'big' }] })],
        keywords: [],
      }),
      { by: 'members' },
    ));
    assert.equal(error.reason, 'unsupported_given_contribution');
    // Trim on a boolean field refuses.
    error = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([base], {
        traits: [traitInstance({ target: QUOTE, trait: 'scrub', fields: [{ name: 'flag', type: 'bool', default: 'false', trim: true }] })],
        keywords: [],
      }),
      { by: 'members' },
    ));
    assert.equal(error.reason, 'malformed_descriptor');
    assert.match(error.message, /trim needs a text field/);
    // Field attachments need a single-field template on a known field of the same kind.
    for (const patch of [
      { target: `${QUOTE}.title`, fields: [] },
      { target: `${QUOTE}.missing`, fields: [{ name: 'v', type: 'text', trim: true }] },
      { target: `${QUOTE}.title`, fields: [{ name: 'v', type: 'bool', default: 'false', trim: false }] },
    ]) {
      error = await captureArtifactError(() => loadArtifactDescriptors(
        sliceWith([base], { traits: [traitInstance({ trait: 'clean', ...patch })], keywords: [] }),
        { by: 'members' },
      ));
      assert.ok(['malformed_descriptor', 'dangling_reference'].includes(error.reason), error.message);
    }
    // Contradictory defaults and bounds refuse.
    const declared: ArtifactModel = {
      name: QUOTE,
      fields: [modelField('nick', { kind: 'string' }, {
        required: false, valueType: 'text', default: { kind: 'literal', value: 'a' }, max: 4,
      })],
      deleteMode: 'archive',
    };
    error = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([declared], {
        traits: [traitInstance({ target: `${QUOTE}.nick`, trait: 'clean', fields: [{ name: 'v', type: 'text', default: '"b"', trim: false }] })],
        keywords: [],
      }),
      { by: 'members' },
    ));
    assert.equal(error.reason, 'malformed_descriptor');
    assert.match(error.message, /contradicts the declared default/);
    error = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([declared], {
        traits: [traitInstance({ target: `${QUOTE}.nick`, trait: 'clean', fields: [{ name: 'v', type: 'text', trim: false, min: '9' }] })],
        keywords: [],
      }),
      { by: 'members' },
    ));
    assert.equal(error.reason, 'malformed_descriptor');
    assert.match(error.message, /bounds contradict/);
  });
});

describe('BGI-08 loader: keyword bindings', () => {
  it('binds the canonical-identity rule exactly', () => {
    const loaded = loadArtifactDescriptors(
      sliceWith([accountModel()], { traits: [], keywords: [keywordRule()] }),
      { by: 'members' },
    );
    assert.deepEqual(loaded.givenUniqueKeys, [{
      abi: 'state.unique-key@1',
      rule: RULE,
      model: ACCOUNT,
      field: 'handle',
      semantics: 'nfkc-ascii-lowercase',
      lifecycle: 'commit-keys',
      input: { name: 'field', type: 'text' },
      result: { type: 'text' },
      implementation: { unit: 'u3', export: 'canonicalKey', fingerprint: FINGERPRINT },
    }]);
  });

  it('refuses unknown producers, hidden authority and bad targets', async () => {
    const integerModel: ArtifactModel = {
      name: ACCOUNT,
      fields: [modelField('handle', { kind: 'integer' }, { required: true })],
      deleteMode: 'archive',
    };
    const nullableModel: ArtifactModel = {
      name: ACCOUNT,
      fields: [modelField('handle', { kind: 'string' }, { required: false, valueType: 'text?', nullable: true })],
      deleteMode: 'archive',
    };
    const arrayModel: ArtifactModel = {
      name: ACCOUNT,
      fields: [modelField('handle', { kind: 'string' }, { required: true, valueType: 'text[]', array: { required: false } })],
      deleteMode: 'archive',
    };
    const builtinModel: ArtifactModel = {
      name: ACCOUNT,
      fields: [modelField('handle', { kind: 'string' }, { required: true })],
      deleteMode: 'archive',
      uniqueKeys: ['handle'],
    };
    const cases: Array<{ reason: string; match: RegExp; rule: ArtifactGivenKeyword; models?: ArtifactModel[] }> = [
      { reason: 'unknown_producer', match: /unknown producer/, rule: keywordRule({ producer: 'state.evil@9' }) },
      { reason: 'unknown_producer', match: /not the checked/, rule: keywordRule({ semantics: 'other' }) },
      { reason: 'unknown_producer', match: /not the checked/, rule: keywordRule({ lifecycle: 'other' }) },
      { reason: 'malformed_descriptor', match: /checked text input/, rule: keywordRule({ input: { name: 'field', type: 'int' } }) },
      { reason: 'malformed_descriptor', match: /checked text input/, rule: keywordRule({ result: { type: 'bool' } }) },
      { reason: 'malformed_descriptor', match: /hidden authority/, rule: keywordRule({ reads: ['state.store'] }) },
      { reason: 'malformed_descriptor', match: /hidden authority/, rule: keywordRule({ effects: ['store.write'] }) },
      { reason: 'malformed_descriptor', match: /hidden authority/, rule: keywordRule({ authority: ['raw-claims'] }) },
      { reason: 'dangling_reference', match: /no descriptor/, rule: keywordRule({ targetModel: 'Tasks.Missing', targetField: 'Tasks.Missing.handle', ruleId: 'Tasks.Missing.handle#canonical_identity' }) },
      { reason: 'dangling_reference', match: /no descriptor/, rule: keywordRule({ targetField: 'Tasks.Account.missing', ruleId: 'Tasks.Account.missing#canonical_identity' }) },
      { reason: 'malformed_descriptor', match: /needs a checked text field/, rule: keywordRule(), models: [integerModel] },
      { reason: 'malformed_descriptor', match: /needs a checked text field/, rule: keywordRule(), models: [nullableModel] },
      { reason: 'malformed_descriptor', match: /needs a checked text field/, rule: keywordRule(), models: [arrayModel] },
      { reason: 'malformed_descriptor', match: /conflicts with the declared builtin unique/, rule: keywordRule(), models: [builtinModel] },
      { reason: 'malformed_descriptor', match: /lowercase SHA-256/, rule: keywordRule({ fingerprint: 'zz' }) },
      { reason: 'malformed_descriptor', match: /dependencies must name/, rule: keywordRule({ dependencies: [] }) },
      { reason: 'malformed_descriptor', match: /target field plus its keyword/, rule: keywordRule({ ruleId: 'Tasks.Account.handle#other' }) },
    ];
    for (const [index, { reason, match, rule, models }] of cases.entries()) {
      const error = await captureArtifactError(() => loadArtifactDescriptors(
        sliceWith(models ?? [accountModel()], { traits: [], keywords: [rule] }),
        { by: 'members' },
      ));
      assert.equal(error.reason, reason, `case ${index}: ${error.message}`);
      assert.match(error.message, match, `case ${index}`);
    }
    const duplicate = await captureArtifactError(() => loadArtifactDescriptors(
      sliceWith([accountModel()], { traits: [], keywords: [keywordRule(), keywordRule()] }),
      { by: 'members' },
    ));
    assert.equal(duplicate.reason, 'duplicate_name');
  });

  it('binds a rule on a trait-contributed text field', () => {
    const bare: ArtifactModel = { name: ACCOUNT, fields: [], deleteMode: 'archive' };
    const loaded = loadArtifactDescriptors(
      sliceWith([bare], {
        traits: [
          traitInstance({
            target: ACCOUNT, trait: 'handleable', unitId: 'u4',
            fields: [{ name: 'handle', type: 'text', default: '"n/a"', trim: false }],
          }),
        ],
        keywords: [keywordRule()],
      }),
      { by: 'members' },
    );
    assert.equal(loaded.givenUniqueKeys.length, 1);
    assert.equal(loaded.givenUniqueKeys[0]!.field, 'handle');
  });
});

let opSeq = 5000;

function nextOperationId(): string {
  opSeq += 1;
  return uuidv7(FIXED_NOW, opSeq);
}

function memberModel(): ArtifactModel {
  return {
    name: MEMBER,
    fields: [modelField('code', { kind: 'string' }, { required: true })],
    deleteMode: 'remove',
  };
}

function memberRule(): ArtifactGivenKeyword {
  return keywordRule({
    ruleId: MEMBER_RULE,
    targetModel: MEMBER,
    targetField: 'Tasks.Member.code',
    dependencies: ['Tasks.Member.code'],
    args: [
      { name: 'target', value: MEMBER },
      { name: 'field', value: 'Tasks.Member.code' },
    ],
    order: 1,
  });
}

interface GivenWorld {
  readonly store: Awaited<ReturnType<typeof createTestMemoryStorage>>['store'];
  readonly memberships: ReturnType<typeof createMemoryIdentityStore>;
  readonly alice: SeededMember;
  readonly table: ReturnType<typeof buildModelTableFromCanonical>;
  readonly registry: ReturnType<typeof loadArtifactDescriptors>['registry'];
  evaluations: number;
  readonly evaluate: (value: string) => string;
}

async function setupWorld(): Promise<GivenWorld> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(
    {
      artifact_version: 1,
      operations: [
        ...crudOps(ACCOUNT, [scalarInput('handle', 'string', true), scalarInput('title', 'string', false)]),
        ...crudOps(MEMBER, [scalarInput('code', 'string', true)]),
      ],
      models: [accountModel(), memberModel()],
      givenContracts: { traits: [], keywords: [keywordRule(), memberRule()] },
    },
    { by: 'members' },
  );
  const counter = { evaluations: 0 };
  // One saved evaluator shared by both rules: the second model reuses the
  // definition's implementation (zero additional loading, zero AI).
  const evaluate = (value: string): string => {
    counter.evaluations += 1;
    return canonicalKey(value);
  };
  const rulesByModel = new Map<ModelName, GivenUniqueKeyRule[]>();
  for (const binding of loaded.givenUniqueKeys) {
    const rules = rulesByModel.get(binding.model) ?? [];
    rules.push({ rule: binding.rule, field: binding.field, evaluate });
    rulesByModel.set(binding.model, rules);
  }
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    givenUniqueKeys: rulesByModel,
  });
  return {
    store,
    memberships,
    alice,
    table,
    registry: loaded.registry,
    evaluate,
    get evaluations(): number {
      return counter.evaluations;
    },
    set evaluations(value: number) {
      counter.evaluations = value;
    },
  };
}

function trackEvaluations(world: GivenWorld): void {
  world.evaluations = 0;
}

async function pipelineWrites(
  world: GivenWorld,
  writes: Array<{ op: 'create' | 'update' | 'remove'; model: string; id: string; data?: Record<string, unknown> }>,
): Promise<ReturnType<typeof runMutationWrites>> {
  const context = buildContext({
    identity: makeIdentity({ membership: world.alice.membership, email: world.alice.user.email }),
    operation: 'Tasks.test' as OperationName,
    operationId: nextOperationId(),
    app: APP,
    source: 'test',
    now: FIXED_NOW,
  });
  return runMutationWrites({
    table: world.table,
    writes: writes.map((write) => ({
      op: write.op,
      model: write.model as ModelName,
      id: write.id as RecordId,
      ...(write.data !== undefined ? { data: write.data } : {}),
    })),
    context,
    store: world.store,
    gateArchivedTargets: true,
  });
}

async function commitWrites(
  world: GivenWorld,
  result: Awaited<ReturnType<typeof runMutationWrites>>,
): Promise<void> {
  const revision = (await world.store.readRevision()) as number;
  await world.store.commit(makeBatch(revision, {
    writes: [...result.writes],
    history: [...result.history],
    uniqueClaims: [...result.uniqueClaims],
    uniqueReleases: [...result.uniqueReleases],
  }));
}

async function rowsOf(world: GivenWorld, model: string): Promise<string[]> {
  const rows = await world.store.query({ model: asModel(model), authority: 'owner' });
  return rows.map((row) => (row.data['handle'] ?? row.data['code']) as string).sort();
}

describe('BGI-08 runtime: canonical-identity fixture', () => {
  it('"Ａlice" then "Alice" conflicts while "Bob" succeeds, spelling preserved', async () => {
    const world = await setupWorld();
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a1', data: { handle: 'Alice' } },
    ]));
    assert.deepEqual(await rowsOf(world, ACCOUNT), ['Alice']);
    const collision = await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a2', data: { handle: 'Ａlice' } },
    ]);
    assert.equal(collision.uniqueClaims.length, 1);
    assert.equal(collision.uniqueClaims[0]!.keyValue, 'alice');
    let conflict: unknown;
    try {
      await commitWrites(world, collision);
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict instanceof StorageConstraintError, `expected unique conflict, got ${conflict}`);
    assert.match(conflict.message, /already claimed/);
    assert.deepEqual(await rowsOf(world, ACCOUNT), ['Alice']);
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a3', data: { handle: 'Bob' } },
    ]));
    assert.deepEqual(await rowsOf(world, ACCOUNT), ['Alice', 'Bob']);
    // Stored spelling is verbatim: no helper field, no normalization.
    const stored = await world.store.query({ model: asModel(ACCOUNT), authority: 'owner' });
    assert.deepEqual(stored.map((row) => row.data['handle']).sort(), ['Alice', 'Bob']);
    for (const row of stored) {
      assert.ok(Object.keys(row.data).every((key) => key === 'handle' || key === 'title'), 'no helper stored field');
    }
  });

  it('a second model reuses the one saved evaluator', async () => {
    const world = await setupWorld();
    const accountRules = world.table.get(asModel(ACCOUNT))!.givenUniqueKeys!;
    const memberRules = world.table.get(asModel(MEMBER))!.givenUniqueKeys!;
    assert.equal(accountRules.length, 1);
    assert.equal(memberRules.length, 1);
    assert.equal(accountRules[0]!.rule, RULE);
    assert.equal(memberRules[0]!.rule, MEMBER_RULE);
    assert.equal(memberRules[0]!.evaluate, accountRules[0]!.evaluate);
    trackEvaluations(world);
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'create', model: MEMBER, id: 'm1', data: { code: 'Alice' } },
    ]));
    // Same key text on another model is independent (claims are per-model).
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a1', data: { handle: 'Alice' } },
    ]));
    assert.ok(world.evaluations >= 2);
    assert.deepEqual(await rowsOf(world, MEMBER), ['Alice']);
    assert.deepEqual(await rowsOf(world, ACCOUNT), ['Alice']);
  });

  it('final-key swaps commit in one batch', async () => {
    const world = await setupWorld();
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a1', data: { handle: 'Xray' } },
      { op: 'create', model: ACCOUNT, id: 'a2', data: { handle: 'Yankee' } },
    ]));
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'update', model: ACCOUNT, id: 'a1', data: { handle: 'Yankee' } },
      { op: 'update', model: ACCOUNT, id: 'a2', data: { handle: 'Xray' } },
    ]));
    assert.deepEqual(await rowsOf(world, ACCOUNT), ['Xray', 'Yankee']);
    // Post-swap ownership is exact: 'Xray' now belongs to a2.
    const taken = await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a3', data: { handle: 'XRAY' } },
    ]);
    let conflict: unknown;
    try {
      await commitWrites(world, taken);
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict instanceof StorageConstraintError);
  });

  it('hard removal releases the key; archive keeps it reserved', async () => {
    const world = await setupWorld();
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'create', model: MEMBER, id: 'm1', data: { code: 'Gone' } },
      { op: 'create', model: ACCOUNT, id: 'a1', data: { handle: 'Kept' } },
    ]));
    const removed = await pipelineWrites(world, [{ op: 'remove', model: MEMBER, id: 'm1' }]);
    assert.equal(removed.uniqueReleases.length, 1);
    assert.equal(removed.uniqueReleases[0]!.keyValue, 'gone');
    await commitWrites(world, removed);
    // Released: the same key creates cleanly again.
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'create', model: MEMBER, id: 'm2', data: { code: 'GONE' } },
    ]));
    assert.deepEqual(await rowsOf(world, MEMBER), ['GONE']);
    // Archived: the row stays and the key stays reserved.
    const archived = await pipelineWrites(world, [{ op: 'remove', model: ACCOUNT, id: 'a1' }]);
    assert.deepEqual(archived.uniqueClaims, []);
    assert.deepEqual(archived.uniqueReleases, []);
    await commitWrites(world, archived);
    const stored = await world.store.load(asModel(ACCOUNT), asId('a1'));
    assert.ok(stored !== null && stored.archivedAt !== null);
    const retaken = await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a2', data: { handle: 'kept' } },
    ]);
    let conflict: unknown;
    try {
      await commitWrites(world, retaken);
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict instanceof StorageConstraintError);
  });

  it('a colliding batch commits nothing', async () => {
    const world = await setupWorld();
    const revision = await world.store.readRevision();
    const batch = await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a1', data: { handle: 'Alice' } },
      { op: 'create', model: ACCOUNT, id: 'a2', data: { handle: 'Ａlice' } },
    ]);
    let conflict: unknown;
    try {
      await commitWrites(world, batch);
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict instanceof StorageConstraintError);
    assert.deepEqual(await rowsOf(world, ACCOUNT), []);
    assert.equal(await world.store.readRevision(), revision);
  });

  it('a business failure stages nothing past the failure', async () => {
    const world = await setupWorld();
    const revision = await world.store.readRevision();
    const error = await captureStateError(() => pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a1', data: { handle: 'Alice' } },
      { op: 'create', model: ACCOUNT, id: 'a2', data: {} },
    ]));
    assert.equal(error.code, 'validation');
    assert.deepEqual(await rowsOf(world, ACCOUNT), []);
    assert.equal(await world.store.readRevision(), revision);
  });

  it('computed keys observe hook-adjusted values', async () => {
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    let evaluations = 0;
    const def: InterimModelDef = {
      model: asModel(ACCOUNT),
      fields: { handle: { required: true, serverOnly: false } },
      refs: [],
      uniqueKeys: [],
      deleteMode: 'archive',
      hooks: [{
        name: 'fix',
        ops: ['create'],
        run: (candidate) => ({ ...candidate, handle: 'Alice' }),
      }],
      invariants: [],
      locks: [],
      givenUniqueKeys: [{
        rule: RULE,
        field: 'handle',
        evaluate: (value: string) => { evaluations += 1; return canonicalKey(value); },
      }],
    };
    const table = buildModelTable([def]);
    const context = buildContext({
      identity: makeIdentity({ membership: alice.membership, email: alice.user.email }),
      operation: 'Tasks.test' as OperationName,
      operationId: nextOperationId(),
      app: APP,
      source: 'test',
      now: FIXED_NOW,
    });
    const staged = await runMutationWrites({
      table,
      writes: [{ op: 'create', model: asModel(ACCOUNT), id: asId('a1'), data: { handle: 'zzz' } }],
      context,
      store,
      gateArchivedTargets: true,
    });
    // The key comes from the hook-adjusted 'Alice', not the written 'zzz'.
    assert.equal(staged.uniqueClaims.length, 1);
    assert.equal(staged.uniqueClaims[0]!.keyValue, 'alice');
    assert.ok(evaluations >= 1);
    const revision = (await store.readRevision()) as number;
    await store.commit(makeBatch(revision, {
      writes: [...staged.writes],
      history: [...staged.history],
      uniqueClaims: [...staged.uniqueClaims],
      uniqueReleases: [...staged.uniqueReleases],
    }));
    // A colliding fullwidth spelling now conflicts through the same join.
    const context2 = buildContext({
      identity: makeIdentity({ membership: alice.membership, email: alice.user.email }),
      operation: 'Tasks.test' as OperationName,
      operationId: nextOperationId(),
      app: APP,
      source: 'test',
      now: FIXED_NOW,
    });
    const staged2 = await runMutationWrites({
      table,
      writes: [{ op: 'create', model: asModel(ACCOUNT), id: asId('a2'), data: { handle: 'zzz' } }],
      context: context2,
      store,
      gateArchivedTargets: true,
    });
    let conflict: unknown;
    try {
      const revision2 = (await store.readRevision()) as number;
      await store.commit(makeBatch(revision2, {
        writes: [...staged2.writes],
        history: [...staged2.history],
        uniqueClaims: [...staged2.uniqueClaims],
        uniqueReleases: [...staged2.uniqueReleases],
      }));
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict instanceof StorageConstraintError);
  });

  it('trait-contributed defaults and constraints run canonically', async () => {
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    const loaded = loadArtifactDescriptors(
      sliceWith(
        [
          {
            name: TODO,
            fields: [modelField('title', { kind: 'string' }, { required: true })],
            deleteMode: 'archive',
          },
          {
            name: QUOTE,
            fields: [modelField('title', { kind: 'string' }, { required: true, valueType: 'text' })],
            deleteMode: 'archive',
          },
        ],
        {
          traits: [
            traitInstance({
              target: TODO, trait: 'completable',
              fields: [{ name: 'done', type: 'bool', default: 'false', trim: false }],
            }),
            traitInstance({
              target: `${QUOTE}.title`, trait: 'clean', unitId: 'u2',
              fields: [{ name: 'v', type: 'text', trim: true, min: '1', max: '200' }],
            }),
          ],
          keywords: [],
        },
      ),
      { by: 'members' },
    );
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const stage = async (writes: Array<{ op: 'create'; model: string; id: string; data: Record<string, unknown> }>) => {
      const context = buildContext({
        identity: makeIdentity({ membership: alice.membership, email: alice.user.email }),
        operation: 'Tasks.test' as OperationName,
        operationId: nextOperationId(),
        app: APP,
        source: 'test',
        now: FIXED_NOW,
      });
      return runMutationWrites({
        table,
        writes: writes.map((write) => ({ ...write, model: write.model as ModelName, id: write.id as RecordId })),
        context,
        store,
        gateArchivedTargets: true,
      });
    };
    // The contributed default applies like an authored one.
    const created = await stage([{ op: 'create', model: TODO, id: 't1', data: { title: 'write tests' } }]);
    const revision = (await store.readRevision()) as number;
    await store.commit(makeBatch(revision, {
      writes: [...created.writes],
      history: [...created.history],
      uniqueClaims: [...created.uniqueClaims],
      uniqueReleases: [...created.uniqueReleases],
    }));
    const todo = await store.load(asModel(TODO), asId('t1'));
    assert.equal(todo!.data['done'], false);
    // The contributed trim bound runs; the min bound refuses.
    const trimmed = await stage([{ op: 'create', model: QUOTE, id: 'q1', data: { title: '  padded  ' } }]);
    const revision2 = (await store.readRevision()) as number;
    await store.commit(makeBatch(revision2, {
      writes: [...trimmed.writes],
      history: [...trimmed.history],
      uniqueClaims: [...trimmed.uniqueClaims],
      uniqueReleases: [...trimmed.uniqueReleases],
    }));
    const quote = await store.load(asModel(QUOTE), asId('q1'));
    assert.equal(quote!.data['title'], 'padded');
    const refused = await captureStateError(() =>
      stage([{ op: 'create', model: QUOTE, id: 'q2', data: { title: '' } }]),
    );
    assert.equal(refused.code, 'validation');
  });

  it('updates that keep the key stage no computed touches', async () => {
    const world = await setupWorld();
    await commitWrites(world, await pipelineWrites(world, [
      { op: 'create', model: ACCOUNT, id: 'a1', data: { handle: 'Alice', title: 'v1' } },
    ]));
    const touched = await pipelineWrites(world, [
      { op: 'update', model: ACCOUNT, id: 'a1', data: { title: 'v2' } },
    ]);
    assert.deepEqual(touched.uniqueClaims, []);
    assert.deepEqual(touched.uniqueReleases, []);
    await commitWrites(world, touched);
    assert.deepEqual(await rowsOf(world, ACCOUNT), ['Alice']);
  });
});

describe('BGI-08 runtime: permission, replay and invoke conflicts', () => {
  function identityFor(member: SeededMember): ReturnType<typeof makeIdentity> {
    return makeIdentity({ membership: member.membership, email: member.user.email });
  }

  it('permission refusal never evaluates generated behavior', async () => {
    const world = await setupWorld();
    const execute = generatedCrudExecute({ table: world.table, store: world.store });
    const stranger = await seedMember(world.memberships, { isOwner: false });
    const revision = await world.store.readRevision();
    const error = await captureStateError(() => invoke({
      registry: world.registry,
      envelope: makeEnvelope(`${ACCOUNT}.create`, nextOperationId(), { handle: 'Alice' }),
      identity: makeIdentity({
        membership: stranger.membership,
        teamId: world.alice.team.team_id,
        email: stranger.user.email,
      }),
      app: APP,
      source: 'test',
      store: world.store,
      memberships: world.memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    }));
    assert.equal(error.code, 'forbidden');
    assert.equal(world.evaluations, 0);
    assert.equal(await world.store.readRevision(), revision);
    const receipt = await world.store.readReceipt({
      app: APP,
      owner: world.alice.team.team_id,
      principal: stranger.user.user_id,
      operation: asOperation(`${ACCOUNT}.create`),
      operationId: asOperationId(nextOperationId()),
    });
    assert.equal(receipt, null);
  });

  it('replay returns the recorded outcome without rerunning the evaluator', async () => {
    const world = await setupWorld();
    const execute = generatedCrudExecute({ table: world.table, store: world.store });
    const base = {
      registry: world.registry,
      app: APP,
      source: 'test',
      store: world.store,
      memberships: world.memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
      identity: identityFor(world.alice),
    };
    const envelope = makeEnvelope(`${ACCOUNT}.create`, nextOperationId(), { handle: 'Bob' });
    const committed = await invoke({ ...base, envelope });
    assert.equal(committed.status, 'committed');
    const evaluations = world.evaluations;
    assert.ok(evaluations >= 1);
    const revision = await world.store.readRevision();
    const replayed = await invoke({ ...base, envelope });
    assert.equal(replayed.status, 'replayed');
    assert.deepEqual(replayed.result, committed.result);
    assert.equal(world.evaluations, evaluations);
    assert.equal(await world.store.readRevision(), revision);
  });

  it('a duplicate create through invoke conflicts and the first row stands', async () => {
    const world = await setupWorld();
    const execute = generatedCrudExecute({ table: world.table, store: world.store });
    const base = {
      registry: world.registry,
      app: APP,
      source: 'test',
      store: world.store,
      memberships: world.memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
      identity: identityFor(world.alice),
    };
    const first = await invoke({
      ...base,
      envelope: makeEnvelope(`${ACCOUNT}.create`, nextOperationId(), { handle: 'Alice' }),
    });
    assert.equal(first.status, 'committed');
    const revision = await world.store.readRevision();
    const conflict = await captureStateError(() => invoke({
      ...base,
      envelope: makeEnvelope(`${ACCOUNT}.create`, nextOperationId(), { handle: 'Ａlice' }),
    }));
    assert.equal(conflict.code, 'conflict');
    assert.equal(await world.store.readRevision(), revision);
    assert.deepEqual(await rowsOf(world, ACCOUNT), ['Alice']);
  });
});
