/**
 * Lane 03 S7 transition tests (engine worker): predecessor matching,
 * directive consistency, validated-plan views, and fresh-install
 * validation. Pure functions — no store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  InstalledSnapshot,
  MigrationDirective,
  ModelName,
} from '@canlang/contracts';
import { buildModelTable, type ModelTable } from '../../src/mutation/index.js';
import { freshInstallSnapshot, validateTransition } from '../../src/migration/index.js';
import { StateError } from '../../src/errors.js';
import {
  LEGACY_MODEL,
  TASK_MODEL,
  TODO_MODEL,
  asModel,
  captureStateError,
  desiredTodoDef,
  field,
  makeInstalled,
  makeTransition,
  modelDef,
  oldTodoDef,
  todoDirectives,
  todoTables,
} from './fixtures.js';

function tables(): { oldModels: ModelTable; desiredModels: ModelTable } {
  return todoTables();
}

function planWith(
  directives: ReadonlyArray<MigrationDirective>,
  opts: {
    installed?: InstalledSnapshot | null;
    oldModels?: ModelTable;
    desiredModels?: ModelTable;
    owner?: string;
    fromSnapshotId?: string;
    fromDigest?: string;
  } = {},
) {
  const { oldModels, desiredModels } = tables();
  return validateTransition(
    opts.installed === undefined ? makeInstalled() : opts.installed,
    makeTransition({
      directives,
      ...(opts.owner === undefined ? {} : { owner: opts.owner }),
      ...(opts.fromSnapshotId === undefined ? {} : { fromSnapshotId: opts.fromSnapshotId }),
      ...(opts.fromDigest === undefined ? {} : { fromDigest: opts.fromDigest }),
    }),
    opts.oldModels ?? oldModels,
    opts.desiredModels ?? desiredModels,
  );
}

describe('transition predecessor', () => {
  it('blocks fresh installs from applying any transition', async () => {
    const error = await captureStateError(() =>
      planWith(todoDirectives(), { installed: null }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /Fresh installs never apply transitions/);
  });

  it('blocks fresh installs even for an empty transition', async () => {
    const error = await captureStateError(() => planWith([], { installed: null }));
    assert.equal(error.code, 'validation');
  });

  it('blocks fromSnapshotId mismatch', async () => {
    const error = await captureStateError(() =>
      planWith([], { fromSnapshotId: 'snap-other' }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /predecessor mismatch/);
  });

  it('blocks fromDigest mismatch', async () => {
    const error = await captureStateError(() => planWith([], { fromDigest: 'digest-other' }));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /predecessor mismatch/);
  });

  it('blocks a transition from a snapshot to itself', async () => {
    const { oldModels, desiredModels } = tables();
    const error = await captureStateError(() =>
      validateTransition(
        makeInstalled(),
        makeTransition({ toSnapshotId: 'snap-1', toDigest: 'digest-1', directives: [] }),
        oldModels,
        desiredModels,
      ),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /to itself changes nothing/);
  });
});

describe('transition owner directives', () => {
  it('blocks renameOwner from a non-installed owner', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'renameOwner', from: 'other' }]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /renameOwner/);
  });

  it('accepts renameOwner from the installed owner', () => {
    const same = buildModelTable([oldTodoDef()]);
    const plan = planWith([{ kind: 'renameOwner', from: 'acme' }], {
      owner: 'acme2',
      oldModels: same,
      desiredModels: same,
    });
    assert.deepEqual(plan.ownerAction, { kind: 'rename', from: 'acme' });
    assert.equal(plan.owner, 'acme2');
  });

  it('blocks competing rename/drop owner directives', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'renameOwner', from: 'acme' }, { kind: 'dropOwner' }]),
    );
    assert.equal(error.code, 'validation');
  });

  it('blocks dropOwner whose owner survives in desired models', async () => {
    const error = await captureStateError(() => planWith([{ kind: 'dropOwner' }]));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /still carry it/);
  });

  it('accepts dropOwner with the owner gone from desired models', () => {
    const { oldModels } = tables();
    const desiredModels = buildModelTable([]);
    const plan = planWith([{ kind: 'dropOwner' }], { desiredModels });
    assert.deepEqual(plan.ownerAction, { kind: 'drop' });
    assert.equal(plan.models.get(asModel(TODO_MODEL))?.kind, 'drop');
    assert.equal(oldModels.size, 1);
  });

  it('blocks dropOwner carrying model directives', async () => {
    const desiredModels = buildModelTable([]);
    const error = await captureStateError(() =>
      planWith([{ kind: 'dropOwner' }, { kind: 'dropModel', model: TODO_MODEL }], { desiredModels }),
    );
    assert.equal(error.code, 'validation');
  });

  it('blocks an undeclared owner change without renameOwner', async () => {
    const error = await captureStateError(() => planWith([], { owner: 'acme2' }));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /without a renameOwner/);
  });
});

describe('transition model directives', () => {
  function renameTables() {
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { label: field({ required: true }) } }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(TASK_MODEL, { fields: { label: field({ required: true }) } }),
    ]);
    return { oldModels, desiredModels };
  }

  it('accepts a clean one-to-one model rename', () => {
    const { oldModels, desiredModels } = renameTables();
    const plan = planWith([{ kind: 'renameModel', from: TODO_MODEL, to: TASK_MODEL }], {
      oldModels,
      desiredModels,
    });
    const mapping = plan.models.get(asModel(TODO_MODEL));
    assert.equal(mapping?.kind, 'rename');
    assert.equal(mapping?.target as string, TASK_MODEL);
    assert.equal(plan.targets.get(asModel(TASK_MODEL)) as string, TODO_MODEL);
  });

  it('blocks renameModel from an unknown old model', async () => {
    const { oldModels, desiredModels } = renameTables();
    const error = await captureStateError(() =>
      planWith([{ kind: 'renameModel', from: 'acme.Nope', to: TASK_MODEL }], {
        oldModels,
        desiredModels,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /unknown old model/);
  });

  it('blocks renameModel to an unknown desired model', async () => {
    const { oldModels, desiredModels } = renameTables();
    const error = await captureStateError(() =>
      planWith([{ kind: 'renameModel', from: TODO_MODEL, to: 'acme.Nope' }], {
        oldModels,
        desiredModels,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /unknown desired model/);
  });

  it('blocks duplicate consumption of one old model', async () => {
    const { oldModels, desiredModels } = renameTables();
    const error = await captureStateError(() =>
      planWith(
        [
          { kind: 'renameModel', from: TODO_MODEL, to: TASK_MODEL },
          { kind: 'dropModel', model: TODO_MODEL },
        ],
        { oldModels, desiredModels },
      ),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /twice/);
  });

  it('blocks drop+map of the same source in either order', async () => {
    const { oldModels, desiredModels } = renameTables();
    const error = await captureStateError(() =>
      planWith(
        [
          { kind: 'dropModel', model: TODO_MODEL },
          { kind: 'renameModel', from: TODO_MODEL, to: TASK_MODEL },
        ],
        { oldModels, desiredModels },
      ),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /twice/);
  });

  it('blocks two sources targeting one model', async () => {
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { label: field() } }),
      modelDef(LEGACY_MODEL, { fields: { label: field() } }),
    ]);
    const desiredModels = buildModelTable([modelDef(TASK_MODEL, { fields: { label: field() } })]);
    const error = await captureStateError(() =>
      planWith(
        [
          { kind: 'renameModel', from: TODO_MODEL, to: TASK_MODEL },
          { kind: 'renameModel', from: LEGACY_MODEL, to: TASK_MODEL },
        ],
        { oldModels, desiredModels },
      ),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /two sources/);
  });

  it('blocks renameModel onto an existing unmapped desired model', async () => {
    const oldModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { label: field() } }),
      modelDef(LEGACY_MODEL, { fields: { label: field() } }),
    ]);
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, { fields: { label: field() } }),
      modelDef(LEGACY_MODEL, { fields: { label: field() } }),
    ]);
    const error = await captureStateError(() =>
      planWith([{ kind: 'renameModel', from: LEGACY_MODEL, to: TODO_MODEL }], {
        oldModels,
        desiredModels,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /collides/);
  });

  it('blocks dropModel of an unknown old model', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'dropModel', model: 'acme.Nope' }]),
    );
    assert.equal(error.code, 'validation');
  });

  it('blocks dropModel of a model still declared in desired', async () => {
    const error = await captureStateError(() => planWith([{ kind: 'dropModel', model: TODO_MODEL }]));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /still declare/);
  });

  it('blocks undeclared model removal', async () => {
    const desiredModels = buildModelTable([]);
    const error = await captureStateError(() => planWith([], { desiredModels }));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /without a drop or rename/);
  });

  it('accepts new desired models with no source', () => {
    const { oldModels } = tables();
    const desiredModels = buildModelTable([
      desiredTodoDef(),
      modelDef(TASK_MODEL, { fields: { label: field() } }),
    ]);
    const plan = planWith(
      [
        { kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'title' },
        { kind: 'backfill', model: TODO_MODEL },
        { kind: 'dropField', model: TODO_MODEL, field: 'legacy' },
      ],
      { oldModels, desiredModels },
    );
    assert.deepEqual(plan.newModels, [asModel(TASK_MODEL)]);
  });
});

describe('transition field directives', () => {
  it('blocks renameField on an unknown old model', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'renameField', model: 'acme.Nope', from: 'label', to: 'title' }]),
    );
    assert.equal(error.code, 'validation');
  });

  it('blocks renameField from an unknown old field', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'renameField', model: TODO_MODEL, from: 'nope', to: 'title' }]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /unknown old field/);
  });

  it('blocks renameField to an undeclared desired field', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'nope' }]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /undeclared desired field/);
  });

  it('blocks duplicate consumption of one old field', async () => {
    const error = await captureStateError(() =>
      planWith([
        { kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'title' },
        { kind: 'dropField', model: TODO_MODEL, field: 'label' },
      ]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /twice/);
  });

  it('blocks two sources targeting one field', async () => {
    const error = await captureStateError(() =>
      planWith([
        { kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'title' },
        { kind: 'renameField', model: TODO_MODEL, from: 'legacy', to: 'title' },
      ]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /two .*sources/);
  });

  it('blocks renameField onto a retained same-name field', async () => {
    // `legacy` -> `done` collides: old `done` is retained and desired keeps it.
    const error = await captureStateError(() =>
      planWith([
        { kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'title' },
        { kind: 'renameField', model: TODO_MODEL, from: 'legacy', to: 'done' },
        { kind: 'backfill', model: TODO_MODEL },
      ]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /collides/);
  });

  it('blocks dropField of an unknown old field', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'dropField', model: TODO_MODEL, field: 'nope' }]),
    );
    assert.equal(error.code, 'validation');
  });

  it('blocks dropField of a field still declared in desired', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'dropField', model: TODO_MODEL, field: 'done' }]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /still declare/);
  });

  it('blocks field directives under a dropped model', async () => {
    const desiredModels = buildModelTable([]);
    const error = await captureStateError(() =>
      planWith(
        [
          { kind: 'dropModel', model: TODO_MODEL },
          { kind: 'dropField', model: TODO_MODEL, field: 'legacy' },
        ],
        { desiredModels },
      ),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /dropped model/);
  });

  it('blocks undeclared field removal', async () => {
    // `legacy` vanishes from desired with no drop/rename directive.
    const desiredModels = buildModelTable([
      modelDef(TODO_MODEL, {
        fields: { label: field({ required: true }), done: field({ required: true }) },
      }),
    ]);
    const error = await captureStateError(() => planWith([], { desiredModels }));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /without .*a drop or rename/);
  });

  it('blocks desired fields with no source and no backfill', async () => {
    const error = await captureStateError(() =>
      planWith([
        { kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'title' },
        { kind: 'dropField', model: TODO_MODEL, field: 'legacy' },
      ]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /without a source or backfill/);
  });
});

describe('transition backfill and invalidate', () => {
  it('blocks backfill of an unknown desired model', async () => {
    const error = await captureStateError(() => planWith([{ kind: 'backfill', model: 'acme.Nope' }]));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /unknown desired model/);
  });

  it('blocks backfill of a dropped model', async () => {
    const desiredModels = buildModelTable([]);
    const error = await captureStateError(() =>
      planWith(
        [
          { kind: 'dropModel', model: TODO_MODEL },
          { kind: 'backfill', model: TODO_MODEL },
        ],
        { desiredModels },
      ),
    );
    assert.equal(error.code, 'validation');
  });

  it('blocks backfill of a renamed-away model', async () => {
    const { oldModels } = tables();
    const desiredModels = buildModelTable([
      desiredTodoDef(),
      modelDef(TASK_MODEL, {
        fields: {
          label: field({ required: true }),
          done: field({ required: true }),
          legacy: field(),
        },
      }),
    ]);
    const error = await captureStateError(() =>
      planWith(
        [
          { kind: 'renameModel', from: TODO_MODEL, to: TASK_MODEL },
          { kind: 'backfill', model: TODO_MODEL },
        ],
        { oldModels, desiredModels },
      ),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /dropped or unmapped/);
  });

  it('blocks backfill of an unmapped (new) model', async () => {
    const { oldModels } = tables();
    const desiredModels = buildModelTable([
      desiredTodoDef(),
      modelDef(TASK_MODEL, { fields: { label: field() } }),
    ]);
    const error = await captureStateError(() =>
      planWith(
        [
          { kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'title' },
          { kind: 'backfill', model: TODO_MODEL },
          { kind: 'dropField', model: TODO_MODEL, field: 'legacy' },
          { kind: 'backfill', model: TASK_MODEL },
        ],
        { oldModels, desiredModels },
      ),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /dropped or unmapped/);
  });

  it('blocks duplicate backfill of one model', async () => {
    const error = await captureStateError(() =>
      planWith([
        { kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'title' },
        { kind: 'backfill', model: TODO_MODEL },
        { kind: 'backfill', model: TODO_MODEL },
        { kind: 'dropField', model: TODO_MODEL, field: 'legacy' },
      ]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /twice/);
  });

  it('blocks invalidate with an empty handler contract', async () => {
    const same = buildModelTable([oldTodoDef()]);
    const error = await captureStateError(() =>
      planWith([{ kind: 'invalidate', handlerContract: '' }], {
        oldModels: same,
        desiredModels: same,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /non-empty handlerContract/);
  });

  it('dedupes repeated invalidate contracts', () => {
    const same = buildModelTable([oldTodoDef()]);
    const plan = planWith(
      [
        { kind: 'invalidate', handlerContract: 'acme.old@1' },
        { kind: 'invalidate', handlerContract: 'acme.old@1' },
      ],
      { oldModels: same, desiredModels: same },
    );
    assert.deepEqual(plan.invalidates, ['acme.old@1']);
  });

  it('blocks unknown directive kinds', async () => {
    const error = await captureStateError(() =>
      planWith([{ kind: 'mergeModels' } as unknown as MigrationDirective]),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /Unknown migration directive/);
  });
});

describe('transition validated views', () => {
  it('builds the Todo rename/backfill/drop view', () => {
    const plan = planWith(todoDirectives());
    assert.equal(plan.migrationId, 'mig-1');
    assert.deepEqual(plan.ownerAction, { kind: 'retain' });
    const mapping = plan.models.get(asModel(TODO_MODEL));
    assert.equal(mapping?.kind, 'retain');
    assert.equal(mapping?.target as string, TODO_MODEL);
    assert.equal(mapping?.needsBackfill, true);
    assert.equal(mapping?.needsStaging, true);
    assert.equal(mapping?.hasFieldDrops, true);
    assert.deepEqual(mapping?.fields.get('label'), { kind: 'rename', to: 'title' });
    assert.deepEqual(mapping?.fields.get('done'), { kind: 'retain' });
    assert.deepEqual(mapping?.fields.get('legacy'), { kind: 'drop' });
    assert.deepEqual(plan.invalidates, []);
  });

  it('marks pure retains as staging-free', () => {
    const same = buildModelTable([modelDef(TODO_MODEL, { fields: { label: field() } })]);
    const plan = planWith([], { oldModels: same, desiredModels: same });
    const mapping = plan.models.get(asModel(TODO_MODEL));
    assert.equal(mapping?.kind, 'retain');
    assert.equal(mapping?.needsStaging, false);
    assert.equal(mapping?.needsBackfill, false);
  });

  it('rejects malformed plan identity fields', async () => {
    const { oldModels, desiredModels } = tables();
    const error = await captureStateError(() =>
      validateTransition(
        makeInstalled(),
        makeTransition({ migrationId: '' }),
        oldModels,
        desiredModels,
      ),
    );
    assert.equal(error.code, 'validation');
  });
});

describe('fresh install validation', () => {
  it('validates snapshot shape and compiles desired defs', () => {
    const result = freshInstallSnapshot({ snapshot: makeInstalled(), desired: [desiredTodoDef()] });
    assert.equal(result.owner, 'acme');
    assert.equal(result.snapshotId, 'snap-1');
    assert.equal(result.digest, 'digest-1');
    assert.ok(result.models.has(asModel(TODO_MODEL) as ModelName));
  });

  it('blocks malformed snapshot fields', async () => {
    const error = await captureStateError(() =>
      freshInstallSnapshot({
        snapshot: { ...makeInstalled(), owner: '' },
        desired: [desiredTodoDef()],
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('blocks non-compiling desired defs', async () => {
    const error = await captureStateError(() =>
      freshInstallSnapshot({
        snapshot: makeInstalled(),
        desired: [modelDef('', { fields: {} })],
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /do not compile/);
  });

  it('blocks unknown StateError-free programmer values deterministically', () => {
    assert.throws(
      () =>
        freshInstallSnapshot({
          snapshot: makeInstalled(),
          desired: 'nope' as unknown as [],
        }),
      StateError,
    );
  });
});
