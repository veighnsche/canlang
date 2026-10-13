/**
 * BGI-08 Given computed-key seam tests (colocated): fingerprint-verified
 * resolution of checked `state.unique-key@1` bindings against assembled
 * artifact modules, per-model rule join with single-evaluator reuse, and
 * one vertical slice (resolved rules on a canonical table stage computed
 * claims through the pipeline into a fenced memory commit).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type {
  ArtifactModule,
  CompileArtifact,
  ModelName,
  OperationName,
  RecordId,
  SourceMap,
  StateUniqueKeyProducerBinding,
} from '@canlang/contracts';
import { sha256HexText } from '@canlang/identity';
import { loadArtifactDescriptors } from '@canlang/state/invocation/registry';
import { buildContext } from '@canlang/state/invocation/context';
import { buildModelTableFromCanonical } from '@canlang/state/mutation/models';
import { runMutationWrites } from '@canlang/state/mutation/pipeline';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  FIXED_NOW,
  asModel,
  createMemoryIdentityStore,
  makeBatch,
  makeIdentity,
  seedMember,
  uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { AssemblyCorrespondenceError } from './assembly-verification.js';
import { givenUnitModulePath, joinGivenUniqueKeys, resolveGivenKeywordExport } from './given-unique-keys.js';

const EMPTY_MAP: SourceMap = {
  version: 3, file: '', sources: [], sourcesContent: [], names: [], mappings: '',
};

const SAVED_JS = `export function canonicalKey(value) { return value.normalize("NFKC").toLowerCase(); }
`;
const FINGERPRINT = createHash('sha256').update(SAVED_JS, 'utf8').digest('hex');

function module(path: string, js: string): ArtifactModule {
  return { path, js, map: { ...EMPTY_MAP, file: path } };
}

function artifact(modules: ArtifactModule[]): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: '1.0.0',
    tool_version: '0.1.0',
    sources: [],
    modules,
    callables: [],
    pages: [],
    requires: [],
    tests: [],
  };
}

function binding(overrides: Partial<StateUniqueKeyProducerBinding['implementation']> = {}): StateUniqueKeyProducerBinding {
  return {
    abi: 'state.unique-key@1',
    rule: 'Tasks.Account.handle#canonical_identity',
    model: 'Tasks.Account' as ModelName,
    field: 'handle',
    semantics: 'nfkc-ascii-lowercase',
    lifecycle: 'commit-keys',
    input: { name: 'field', type: 'text' },
    result: { type: 'text' },
    implementation: { unit: 'u3', export: 'canonicalKey', fingerprint: FINGERPRINT, ...overrides },
  };
}

/** Stub producer dists for the assembler (mirrors modules.test.ts). */
function stubProducers(): { stdlibUrl: string; uiUrl: string } {
  const distRoot = mkdtempSync(join(tmpdir(), 'bgi08-dist-'));
  const uiEntry = join(distRoot, 'ui', 'dist', 'ui', 'src', 'index.js');
  mkdirSync(join(distRoot, 'ui', 'dist', 'ui', 'src'), { recursive: true });
  writeFileSync(uiEntry, 'export const uiMarker = "ui-stub";\n');
  const stdlibPath = join(distRoot, 'stdlib.mjs');
  writeFileSync(stdlibPath, 'export const stdlibMarker = "stdlib-stub";\n');
  return { stdlibUrl: pathToFileURL(stdlibPath).href, uiUrl: pathToFileURL(uiEntry).href };
}

async function assemble(modules: ArtifactModule[]): Promise<{ asm: Awaited<ReturnType<typeof assembleModules>>; art: CompileArtifact }> {
  const { stdlibUrl, uiUrl } = stubProducers();
  const workDir = mkdtempSync(join(tmpdir(), 'bgi08-work-'));
  const art = artifact(modules);
  const asm = await assembleModules(
    { artifact: art, sourcePath: '/tmp/bgi08.artifact.json' },
    { workDir, stdlibUrl, uiUrl },
  );
  return { asm, art };
}

test('BGI-08 sha256 fingerprint pins the known empty-string-adjacent vector', async () => {
  assert.equal(
    await sha256HexText('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(givenUnitModulePath('u3'), 'can.generated/u3/server.js');
});

test('BGI-08 resolver runs the saved export after fingerprint verification', async () => {
  const { asm, art } = await assemble([
    module('main.js', 'export const main = 1;\n'),
    module('can.generated/u3/server.js', SAVED_JS),
  ]);
  const evaluate = await resolveGivenKeywordExport(asm, art, binding());
  assert.equal(await evaluate('Ａlice'), 'alice');
  assert.equal(await evaluate('Bob'), 'bob');
});

test('BGI-08 resolver refuses unknown units, changed code and bad exports', async () => {
  const { asm, art } = await assemble([
    module('main.js', 'export const main = 1;\n'),
    module('can.generated/u3/server.js', SAVED_JS),
    module('can.generated/u9/server.js', 'export const canonicalKey = 42;\n'),
  ]);
  const unknown = await resolveGivenKeywordExport(asm, art, binding({ unit: 'missing' })).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(unknown instanceof AssemblyCorrespondenceError);
  assert.match(unknown.message, /unknown saved unit "missing"/);
  const changed = await resolveGivenKeywordExport(asm, art, binding({ fingerprint: 'f'.repeat(64) })).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(changed instanceof AssemblyCorrespondenceError);
  assert.match(changed.message, /saved implementation changed/);
  assert.match(changed.message, /re-validate and activate/);
  const noExport = await resolveGivenKeywordExport(asm, art, binding({ export: 'absent' })).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(noExport instanceof AssemblyCorrespondenceError);
  assert.match(noExport.message, /has no export "absent"/);
  // Prototype-chain names are not exports.
  const proto = await resolveGivenKeywordExport(asm, art, binding({ export: 'constructor' })).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(proto instanceof AssemblyCorrespondenceError);
  assert.match(proto.message, /has no export "constructor"/);
  // A non-function export refuses even with a matching fingerprint.
  const nonFunctionFp = createHash('sha256').update('export const canonicalKey = 42;\n', 'utf8').digest('hex');
  const nonFunction = await resolveGivenKeywordExport(
    asm,
    art,
    binding({ unit: 'u9', fingerprint: nonFunctionFp }),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(nonFunction instanceof AssemblyCorrespondenceError);
  assert.match(nonFunction.message, /is not a function/);
});

test('BGI-08 join shares one evaluator across applications and groups by model', async () => {
  const { asm, art } = await assemble([
    module('main.js', 'export const main = 1;\n'),
    module('can.generated/u3/server.js', SAVED_JS),
  ]);
  const empty = await joinGivenUniqueKeys(asm, art, []);
  assert.equal(empty.size, 0);
  const second: StateUniqueKeyProducerBinding = {
    ...binding(),
    rule: 'Tasks.Member.code#canonical_identity',
    model: 'Tasks.Member' as ModelName,
    field: 'code',
  };
  const joined = await joinGivenUniqueKeys(asm, art, [binding(), second]);
  assert.deepEqual([...joined.keys()].sort(), ['Tasks.Account', 'Tasks.Member']);
  const account = joined.get('Tasks.Account' as ModelName)!;
  const member = joined.get('Tasks.Member' as ModelName)!;
  assert.equal(account.length, 1);
  assert.equal(member.length, 1);
  assert.equal(account[0]!.rule, 'Tasks.Account.handle#canonical_identity');
  assert.equal(member[0]!.rule, 'Tasks.Member.code#canonical_identity');
  assert.equal(member[0]!.evaluate, account[0]!.evaluate);
});

test('BGI-08 resolved rules stage computed claims into the fenced commit', async () => {
  const { stdlibUrl, uiUrl } = stubProducers();
  const workDir = mkdtempSync(join(tmpdir(), 'bgi08-work-'));
  const art = artifact([
    module('main.js', 'export const main = 1;\n'),
    module('can.generated/u3/server.js', SAVED_JS),
  ]);
  art.models = [{
    name: 'Tasks.Account',
    fields: [{ name: 'handle', field: { kind: 'string' }, required: true, serverOnly: false }],
    deleteMode: 'archive',
  }];
  const asm = await assembleModules(
    { artifact: art, sourcePath: '/tmp/bgi08.artifact.json' },
    { workDir, stdlibUrl, uiUrl },
  );
  const loaded = loadArtifactDescriptors(
    {
      artifact_version: 1,
      operations: [],
      models: art.models,
      givenContracts: {
        traits: [],
        keywords: [{
          ruleId: 'Tasks.Account.handle#canonical_identity',
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
          targetModel: 'Tasks.Account',
          targetField: 'Tasks.Account.handle',
          args: [
            { name: 'target', value: 'Tasks.Account' },
            { name: 'field', value: 'Tasks.Account.handle' },
          ],
          order: 0,
        }],
      },
    },
    { by: 'members' },
  );
  assert.equal(loaded.givenUniqueKeys.length, 1);
  const rules = await joinGivenUniqueKeys(asm, art, loaded.givenUniqueKeys);
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, givenUniqueKeys: rules });
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const stage = async (handle: string, id: string) => {
    const context = buildContext({
      identity: makeIdentity({ membership: alice.membership, email: alice.user.email }),
      operation: 'Tasks.test' as OperationName,
      operationId: uuidv7(FIXED_NOW, 9000 + Number(id.slice(1))),
      app: 'tasks-app',
      source: 'test',
      now: FIXED_NOW,
    });
    return runMutationWrites({
      table,
      writes: [{ op: 'create', model: 'Tasks.Account' as ModelName, id: id as RecordId, data: { handle } }],
      context,
      store,
      gateArchivedTargets: true,
    });
  };
  const commit = async (result: Awaited<ReturnType<typeof runMutationWrites>>) => {
    const revision = (await store.readRevision()) as number;
    await store.commit(makeBatch(revision, {
      writes: [...result.writes],
      history: [...result.history],
      uniqueClaims: [...result.uniqueClaims],
      uniqueReleases: [...result.uniqueReleases],
    }));
  };
  await commit(await stage('Alice', 'a1'));
  let conflict: unknown;
  try {
    await commit(await stage('Ａlice', 'a2'));
  } catch (error) {
    conflict = error;
  }
  assert.ok(conflict instanceof Error);
  assert.match(conflict.message, /already claimed/);
  await commit(await stage('Bob', 'a3'));
  const rows = await store.query({ model: asModel('Tasks.Account'), authority: 'owner' });
  assert.deepEqual(rows.map((row) => row.data['handle']).sort(), ['Alice', 'Bob']);
});
