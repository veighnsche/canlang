/** REAL compiled parent-child first (Lane C outcome-5 parent-edge runtime honoring).
 *
 * The compiler join 7b7b14e6 emits an AdmittedReference parent edge for
 * param-qualified child-domain first queries (`term.Seat`). This test compiles
 * the canonical `.can` with the real built compiler and the real native
 * catalog, loads the real emitted assembly (disclosure plan, queryFirst
 * spans, Require sites/dependencies — no hand mirrors), and drives canonical
 * invocation over actual rows: grant/output correct; foreign-parent, denied
 * and tampered cases refuse.
 *
 * Only the invocation driver mirrors the emitted `DomainProbe.assign` body
 * branch-for-branch; every checked value (plan, parent edge, spans, sites,
 * dependency ids, return ids) is read from real emission at runtime.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { invoke } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, IncompatibleArtifactError } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptMembershipSource,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  selectScenarioReceiptQueryFirstRow, observeScenarioReceiptDependency,
  bindScenarioReceiptReferenceProducer, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

/** Exact compiler-fixture source for the contained-domain first slice. */
const SOURCE = 'app DomainProbe\nGiven\n Term {name:text}\n Seat in Term {account:user,active:bool}\n policy Term read=members\n policy Seat read=members\nWhen\n scenario assign(term:Term,account:user) -> bool by=members\n  do\n   let seat=first(term.Seat as seat where seat.account==account order=seat.id)\n   require seat!=null and seat.active\n   return true\nThen\n';

const TERM = asModel('DomainProbe.Term'), SEAT = asModel('DomainProbe.Seat');
const OP = 'DomainProbe.assign', APP = 'DomainProbe', TEAM = 'domain-probe-team';
const CALLER = 'caller', OTHER = 'other';
const cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
let sequence = 98_000;

interface Compiled {
  readonly directory: string;
  readonly plan: Record<string, any>;
  readonly queryId: string;
  readonly accountDepId: string;
  readonly activeDepId: string;
  readonly first: { readonly query: { start: number; end: number }; readonly node: { start: number; end: number }; readonly statement: { start: number; end: number } };
  readonly sites: readonly Record<string, any>[];
  readonly execDeps: readonly Record<string, any>[];
  readonly evaluatedReturnId: string;
  readonly js: string;
}
let cached: Compiled | undefined;
function balanced(text: string, open: string, close: string, start: number): string {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      let escaped = false;
      while (++index < text.length) {
        if (escaped) escaped = false;
        else if (text[index] === '\\') escaped = true;
        else if (text[index] === '"') break;
      }
      continue;
    }
    if (char === open) depth++;
    else if (char === close && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error('Unbalanced emitted assembly');
}
function stringLiteral(text: string, start: number): string {
  assert.equal(text[start], '"');
  let index = start + 1, raw = '';
  while (index < text.length && text[index] !== '"') {
    if (text[index] === '\\') { raw += text.slice(index, index + 2); index += 2; continue; }
    raw += text[index]; index++;
  }
  assert.ok(index < text.length);
  return raw;
}
function jsObject(text: string): Record<string, any> {
  return JSON.parse(text.replace(/([{,])([A-Za-z_$][A-Za-z0-9_$]*):/g, '$1"$2":'));
}
function compiled(): Compiled {
  if (cached !== undefined) return cached;
  const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
  const compilerBin = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
  assert.ok(existsSync(compilerBin), `real built compiler required at ${compilerBin} (or CAN_COMPILER_BIN)`);
  assert.ok(existsSync(catalogPath), `real native catalog required at ${catalogPath} (or CAN_NATIVE_CATALOG)`);
  const directory = mkdtempSync(join(tmpdir(), 'can-contained-first-'));
  const canPath = join(directory, 'contained-first.can');
  writeFileSync(canPath, SOURCE);
  const output = execFileSync(compilerBin, ['compile', canPath, '--format=json',
    `--catalog=${catalogPath}`, '--native-scenario-receipts'],
  { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(output);
  writeFileSync(join(directory, 'artifact.json'), output);
  const operation = artifact.operations.find((entry: any) => entry.name === OP);
  assert.ok(operation && operation.kind === 'scenario');
  const plan = operation.result.disclosure;
  assert.ok(plan && plan.version === 1);
  const [query] = plan.queries ?? [];
  assert.ok(query, 'real emission carries the first query plan');
  // The compiler-join contract pin: the exact admitted parent edge.
  assert.equal(query.model, 'DomainProbe.Seat');
  assert.equal(query.parent?.model, 'DomainProbe.Term');
  assert.equal(query.parent?.origin?.kind, 'admitted-reference');
  assert.equal(query.parent?.origin?.parameter, 'term');
  assert.equal(query.limit, null);
  assert.equal(query.archived, 'exclude');
  assert.equal(query.dependencies.length, 1);
  assert.equal(query.dependencies[0].role, 'control');
  assert.equal(query.dependencies[0].field, 'account');
  assert.equal(query.dependencies[0].type, 'user');
  const callable = artifact.callables.find((entry: any) => entry.id === OP);
  assert.ok(callable);
  const module = artifact.modules.find((entry: any) => entry.path === callable.module);
  assert.ok(module && typeof module.js === 'string');
  const js: string = module.js;
  assert.match(js, new RegExp(`await firstQuery\\(c,await executeScenarioReceiptQuery\\(c,${JSON.stringify(query.id)}`));
  const firstStart = js.indexOf('queryFirst:[');
  assert.ok(firstStart !== -1);
  const [first] = jsObject(`{first:${balanced(js, '[', ']', js.indexOf('[', firstStart))}}`).first;
  assert.equal(first.queryId, query.id);
  assert.deepEqual(Object.keys(first).sort(), ['node', 'query', 'queryId', 'source', 'statement']);
  const appStart = js.indexOf('export const appDefinition=');
  assert.ok(appStart !== -1);
  const app = jsObject(balanced(js, '{', '}', js.indexOf('{', appStart)));
  const execDeps = app.operations[OP].executionDependencies;
  assert.ok(Array.isArray(execDeps) && execDeps.length === 1);
  assert.equal(execDeps[0].queryId, query.id);
  assert.equal(execDeps[0].dependency.model, 'DomainProbe.Seat');
  assert.equal(execDeps[0].dependency.field, 'active');
  assert.equal(execDeps[0].dependency.type, 'bool');
  const sourcesStart = js.indexOf('canMembershipSources(){return JSON.parse("');
  assert.ok(sourcesStart !== -1);
  const raw = stringLiteral(js, js.indexOf('"', js.indexOf('JSON.parse(', sourcesStart)));
  const sites = JSON.parse(JSON.parse(`"${raw}"`))[OP];
  assert.ok(Array.isArray(sites) && sites.length > 0 && sites[0].source !== undefined);
  const evaluated = js.match(/rhs-evaluated"\)\{\$receiptReturns\.push\("([0-9a-f]+)"\);\}/);
  assert.ok(evaluated, 'real emission maps the evaluated branch to its return');
  const evaluatedReturnId = evaluated[1]!;
  assert.ok(plan.returns.some((entry: any) => entry.id === evaluatedReturnId));
  cached = { directory, plan, queryId: query.id, accountDepId: query.dependencies[0].id,
    activeDepId: execDeps[0].dependency.id, first, sites, execDeps, evaluatedReturnId, js };
  return cached;
}

type Access = { seat: boolean; term: boolean };
async function world(c: Compiled, options: { domain?: 'empty' } = {}) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: CALLER, is_owner: false, roles: [] });
  const reader = await memberships.createMembership({ team_id: TEAM, user_id: 'seat-reader', is_owner: false, roles: [] });
  const parentReader = await memberships.createMembership({ team_id: TEAM, user_id: 'term-reader', is_owner: false, roles: [] });
  const store = createMemoryStorage();
  const raw = JSON.parse(readFileSync(join(c.directory, 'artifact.json'), 'utf8'));
  const loaded = loadArtifactDescriptors({
    artifact_version: raw.artifact_version, sources: raw.sources, modules: raw.modules,
    callables: raw.callables, models: raw.models, operations: raw.operations,
  }, { by: 'members' });
  const def = loaded.registry.get(OP);
  assert.ok(def && isGeneratedOperationDef(def));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  const rows: StoredRow[] = [];
  for (const id of ['term-a', 'term-b']) {
    const row = makeRow({ id, data: { name: id } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TERM, row }] }));
  }
  if (options.domain !== 'empty') for (const [id, parent, account, active] of [
    ['seat-00-foreign', 'term-b', CALLER, false], ['seat-00-other', 'term-a', OTHER, true],
    ['seat-01-mine', 'term-a', CALLER, true], ['seat-02-rest', 'term-a', CALLER, false],
  ] as const) {
    const row: StoredRow = { ...makeRow({ id, data: { account: { id: account }, active } }),
      parent: { model: TERM, id: asId(parent) } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: SEAT, row }] }));
    const stored = await store.load(SEAT, row.id); assert.ok(stored); rows.push(stored);
  }
  const scans: Parameters<typeof store.query>[0][] = [];
  const query = store.query; store.query = async spec => { scans.push(spec); return query(spec); };
  const access: Access = { seat: true, term: true };
  const policy = buildPolicyTable([
    { model: TERM, secretFields: [], grants: [{ by: 'members', fields: ['name'] }] },
    { model: SEAT, secretFields: [], grants: [{ by: 'members', fields: ['account', 'active'] }] },
  ], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const [model, fields] of [[SEAT, ['account', 'active']], [TERM, ['name']]] as const) {
    readPolicies.set(model, { ...(model === SEAT ? { parent: TERM } : {}), fields: [...fields],
      secretFields: [], grants: [{ fields: ['id', ...fields], read: async ({ context }) =>
      (model === SEAT ? access.seat : access.term) &&
      (await context.memberships.findMembership(TEAM, model === SEAT ? 'seat-reader' : 'term-reader'))?.status === 'active' &&
      context.membership?.status === 'active',
    }] });
  }
  const source = c.plan.source;
  const siteSource = (c.sites[0] as Record<string, any>).source;
  assert.ok(siteSource);
  bindScenarioReceiptMembershipSource(def, { logical: siteSource, transport: source });
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies,
    executionSites: c.sites as any, executionDependencies: c.execDeps as any });
  bindScenarioReceiptQueryProducer(def, { source, app: APP, policy,
    first: [{ queryId: c.queryId, source, ...c.first }] });
  return { store, memberships, caller, reader, parentReader, def, table, policy, access, readPolicies, rows, scans,
    registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ membership: caller }) };
}
type World = Awaited<ReturnType<typeof world>>;
const refuses = (error: unknown) => error instanceof StateError;

/** Canonical driver mirroring the emitted `DomainProbe.assign` body: first
 * the contained query, select its Let with the real spans, require the live
 * row and its checked active read, return true. */
type Marker = { node: { start: number; end: number }; statement: { start: number; end: number } };
async function assign(call: AdmittedCall, w: World, c: Compiled, termId: string, marker?: Marker) {
  const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
  const result = await executeScenarioReceiptQuery(call, w.store, { queryId: c.queryId,
    predicate: ({ slot, record }: Parameters<Parameters<typeof executeScenarioReceiptQuery>[2]['predicate']>[0]) => {
      const account = (record.data as Record<string, unknown>).account as { id: string };
      observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: c.accountDepId });
      return account.id === CALLER;
    } });
  const seat = await selectScenarioReceiptQueryFirstRow(call, w.store, { query: result.query,
    first: marker ?? { node: c.first.node, statement: c.first.statement } });
  if (seat === null) throw new StateError('rule_failed', 'A seat is required.');
  await observeScenarioReceiptDependency(call, w.store,
    { dependencyId: c.activeDepId, model: SEAT, row: seat, field: 'active' });
  if (seat.data.active !== true) throw new StateError('rule_failed', 'Seat is inactive.');
  assert.equal(seat.parent?.model, TERM);
  assert.equal(seat.parent?.id, termId);
  selectScenarioReceiptReturn(call, w.store, c.evaluatedReturnId);
  return { ...await session.finalize(), result: true, outbox: [] };
}
function input(w: World, c: Compiled, termId: string, observed?: (receipt: Receipt) => void, marker?: Marker) {
  return { ...w, ...(observed === undefined ? {} : { observeCommittedReceipt: observed }),
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence),
      { term: { id: termId, version: '1' }, account: { id: CALLER } }),
    execute: (call: AdmittedCall) => assign(call, w, c, termId, marker) };
}
async function unchanged(w: World) {
  for (const id of ['term-a', 'term-b']) assert.ok(await w.store.load(TERM, asId(id)));
  for (const row of w.rows) assert.deepEqual(await w.store.load(SEAT, row.id), row);
  assert.deepEqual(await w.store.query({ model: SEAT, authority: 'owner' }), w.rows);
}

test('real compiled parent-child first grants the contained seat and saves the admitted parent witness', async () => {
  const c = compiled();
  const w = await world(c);
  let receipt: Receipt | undefined, executions = 0;
  const counting = input(w, c, 'term-a', value => { receipt = value; });
  const request = { ...counting, execute: async (call: AdmittedCall) => { executions++; return counting.execute(call); } };
  const outcome = await invoke(request);
  assert.equal(outcome.status, 'committed'); assert.equal(outcome.result, true); assert.ok(receipt);
  const association = readScenarioReceiptAssociation(receipt)!;
  // The guard-only first discloses no query rows; the saved plan still pins
  // the exact checked admitted edge that execution honored.
  assert.equal(association.queries, undefined);
  assert.equal(association.plan.queries?.[0]?.parent?.model, TERM);
  assert.equal(association.plan.queries?.[0]?.parent?.origin?.kind, 'admitted-reference');
  assert.equal(association.plan.queries?.[0]?.parent?.origin?.parameter, 'term');
  // Execution scanned the exact admitted parent's domain: the globally
  // earlier inactive term-b child never enters (an unscoped scan would
  // select it and refuse), so the live term-a seat is selected.
  const ownerScan = w.scans.find(scan => scan.model === SEAT && scan.authority === 'owner'); assert.ok(ownerScan);
  assert.deepEqual(ownerScan.parent, { model: TERM, id: 'term-a' });
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, true);
  const retained = structuredClone(receipt);
  assert.equal((await invoke(request)).status, 'replayed');
  assert.equal(executions, 1); assert.deepEqual(receipt, retained);
});

test('real compiled first binds the caller exact parent: another term selects its own inactive child and refuses', async () => {
  const c = compiled();
  const w = await world(c);
  // term-b's domain holds only the inactive foreign seat, so the business
  // rule fails — while term-a commits true. The differing outcome per
  // parent input proves the admitted term parameter binds the caller's
  // exact domain; the owner scan pins which one.
  await assert.rejects(invoke(input(w, c, 'term-b')),
    error => error instanceof StateError && error.code === 'rule_failed');
  const ownerScan = w.scans.find(scan => scan.model === SEAT && scan.authority === 'owner'); assert.ok(ownerScan);
  assert.deepEqual(ownerScan.parent, { model: TERM, id: 'term-b' });
  await unchanged(w);
});

test('real compiled first keeps null and failure identity on the empty domain', async () => {
  const c = compiled();
  const w = await world(c, { domain: 'empty' });
  await assert.rejects(invoke(input(w, c, 'term-a')),
    error => error instanceof StateError && error.code === 'rule_failed');
  await unchanged(w);
});

test('denied seat or parent grant refuses the real compiled first', async () => {
  for (const grant of ['seat', 'term'] as const) {
    const c = compiled();
    const w = await world(c);
    w.access[grant] = false;
    await assert.rejects(invoke(input(w, c, 'term-a')), refuses, grant);
    await unchanged(w);
  }
});

test('tampered first markers and foreign parent plans refuse', async () => {
  const c = compiled();
  // Shifted Let markers no longer name the checked occurrence.
  for (const marker of [{ node: { start: c.first.node.start + 1, end: c.first.node.end }, statement: c.first.statement },
    { node: c.first.node, statement: { start: c.first.statement.start, end: c.first.statement.end + 1 } }]) {
    const w = await world(c);
    await assert.rejects(invoke(input(w, c, 'term-a', undefined, marker)), refuses);
    await unchanged(w);
  }
  // A foreign parent model, an unknown parameter, or a mismatched source is
  // not the checked admitted edge.
  const raw = JSON.parse(readFileSync(join(c.directory, 'artifact.json'), 'utf8'));
  for (const mode of ['model', 'parameter', 'source'] as const) {
    const tampered = structuredClone(raw);
    const query = tampered.operations.find((entry: any) => entry.name === OP).result.disclosure.queries[0];
    if (mode === 'model') query.parent.model = 'DomainProbe.Seat';
    if (mode === 'parameter') query.parent.origin.parameter = 'absent';
    if (mode === 'source') query.parent.source.sha256 = 'e'.repeat(64);
    assert.throws(() => loadArtifactDescriptors({
      artifact_version: tampered.artifact_version, sources: tampered.sources, modules: tampered.modules,
      callables: tampered.callables, models: tampered.models, operations: tampered.operations,
    }, { by: 'members' }), (error: unknown) => error instanceof StateError || error instanceof IncompatibleArtifactError, mode);
  }
});
