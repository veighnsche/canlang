/** Captured original Employee predicate -> imported leading Require -> real D1/Identity.
 * This fixture qualifies the helper workflow, without Employee.changed or provider ingress. */
import { createCheckoutScratch } from '../src/runtime/checkout-scratch.test-support.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, CompileArtifact, MutationEnvelope, ReceiptIdentity, StoragePort, StoredRow } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { asId, asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const APP = 'HelperPredicate', LOCATION = asModel('rent_catalog.Location'), EMPLOYEE = asModel('employee.Employee'), CREATED = asModel('intake.Created');
// Exact original owning declarations; unrelated Employee change hooks are omitted.
const EMPLOYEE_LINES = [
  "export role hr label=\"Human resources\"@{nl=\"Personeelszaken\"}",
  "export Employee { user:user unique, name:text? trim min=1 label=\"Work name\"@{nl=\"Werknaam\"}, home:Location label=\"Home location\"@{nl=\"Standplaats\"}, locations:Location[] label=\"Locations\"@{nl=\"Locaties\"}, operator_wide:bool=false label=\"All operator locations\"@{nl=\"Alle locaties van de exploitant\"}, active:bool=true, start:date label=\"Employment start\"@{nl=\"Start dienstverband\"}, end:date? label=\"Employment end\"@{nl=\"Einde dienstverband\"}, manager:user? label=\"Line manager\"@{nl=\"Leidinggevende\"}, role:text label=\"Work role\"@{nl=\"Werkrol\"}, skills:text[] label=\"Skills\"@{nl=\"Vaardigheden\"}, private_notes:text? label=\"Private HR notes\"@{nl=\"Privénotities personeelszaken\"}, document:file? label=\"HR document\"@{nl=\"Personeelsdocument\"} } label=\"Employee\"@{nl=\"Medewerker\"}",
  "export derive staff(person:user):bool = any(Employee as e,e.user==person and e.active and active_member(person,team))",
  "export derive can_work(person:user,location:Location):bool = any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))",
  "policy Employee read=hr",
  "policy Employee read=members and staff(actor) fields=user,name,home,locations,operator_wide,active,role,skills",
  "policy Employee read=authenticated where=row.user==actor",
  "invariant Employee: row.end==null or row.end>=row.start",
  "crud Employee by=hr fields=name,home,locations,operator_wide,start,end,manager,role,skills,private_notes,document create_fields=user,name,home,locations,start,manager,role,skills delete=none",
  "export scenario deactivate(employee:Employee,ended:date label=\"Employment end date\"@{nl=\"Einddatum dienstverband\"}) by=hr label=\"End active employment\"@{nl=\"Actief dienstverband beëindigen\"}",
  "require employee.active and ended>=employee.start",
  "set employee {active=false,end=ended}"
] as const;
const SOURCE = `app HelperPredicate uses=[rent_catalog,employee,intake]
package rent_catalog
 Given
  export Location {title:text,active:bool=true}
  policy Location read=members
 When
  crud Location by=members fields=title,active
 Then
package employee
 use rent_catalog {Location}
 Given
${EMPLOYEE_LINES.slice(0, 8).map(line => `  ${line}`).join('\n')}
 When
  ${EMPLOYEE_LINES[8]}
  ${EMPLOYEE_LINES[9]}
   ${EMPLOYEE_LINES[10]}
   do
    ${EMPLOYEE_LINES[11]}
 Then
package intake
 use rent_catalog {Location}
 use employee {can_work}
 Given
  contract WorkIntake {location:Location,title:text}
  Created {location:Location,title:text}
  policy Created read=members
 When
  scenario start(input:WorkIntake) -> Created by=members
   require can_work(actor,input.location)
   do
    create Created {location=input.location,title=input.title} as created
    return created
 Then
`;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function committed(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status); return outcome.result;
}
function referenceId(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  const wire = object(committed(outcome, status).result);
  assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string'); return wire.id as string;
}
const ref = (row: StoredRow) => ({ id: row.id, version: String(row.version) });

async function nativeHelperCase(splitFiles: boolean) {
    const original = await readFile(join(root, 'draft/shared/Employees.can'), 'utf8');
    const originalLines = new Set(original.split('\n').map(line => line.trim()));
    for (const line of EMPLOYEE_LINES) assert.ok(originalLines.has(line), `original Employee declaration drift: ${line}`);
    assert.equal(SOURCE.match(/require can_work\(actor,input\.location\)/g)?.length, 1);
    const directory = await createCheckoutScratch(root, 'native-helper-predicate-');
    let worker: Miniflare | undefined;
    try {
      const sourcePath = join(directory, 'original-helper-predicate.can');
      const files = splitFiles ? [
        { path: sourcePath, text: SOURCE.slice(0, SOURCE.indexOf('package rent_catalog')) },
        ...['rent_catalog', 'employee', 'intake'].map((name, index, names) => ({
          path: join(directory, `${name}.can`),
          text: SOURCE.slice(SOURCE.indexOf(`package ${name}`),
            index + 1 === names.length ? undefined : SOURCE.indexOf(`package ${names[index + 1]}`)),
        })),
      ] : [{ path: sourcePath, text: SOURCE }];
      for (const file of files) await writeFile(file.path, file.text);
      const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { installedLocalPreviewInputInventory } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const compilerPath = join(root, 'compiler/target/debug/can');
      const inventory = installedLocalPreviewInputInventory(root, compilerPath);
      const capture = await captureSingleFileSource({ checkoutRoot: root, appPath: sourcePath,
        profile: 'native-helper-predicate', compilerPath, catalogPath: join(root, 'packages/cloudflare/dist/native-catalog.json'),
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
        ...inventory,
        extraInputPaths: [...inventory.extraInputPaths, ...files.slice(1).map(file => ({ name: `fixture:${relative(root, file.path)}`, path: file.path }))],
        // This explicit multi-file fixture captures every operand as an input;
        // preview inventory rediscovery is scoped to its single authored file.
        ...(splitFiles ? {} : { inputInventory: 'installed-local-preview' as const }),
        semanticOptions: { nativeScenarioReceipts: 'true' } });
      // The preview's first profile excludes imports. This test invokes the
      // captured CLI directly, keeping all capture/source checks around it.
      assert.equal(await captureIsCurrent(capture), true);
      const compiled = await promisify(execFile)(join(root, 'compiler/target/debug/can'),
        ['compile', '--format=json', '--native-scenario-receipts', `--catalog=${join(root, 'packages/cloudflare/dist/native-catalog.json')}`, capture.compilerOperand, ...files.slice(1).map(file => relative(root, file.path))],
        { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 30000 }).catch(error => {
          const report = JSON.parse(error.stdout || '{}');
          throw new Error(JSON.stringify(report.diagnostics ?? report));
        });
      assert.equal(await captureIsCurrent(capture), true);
      const artifact: CompileArtifact = JSON.parse(compiled.stdout), originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true,
        sources: artifact.sources.filter(source => source.path === capture.compilerOperand) }).ok, true);
      const expectedSources = [{ path: capture.compilerOperand, sha256: capture.sourceSha256 },
        ...capture.inputs.filter(input => input.name.startsWith('extra:fixture:')).map(input => ({
          path: relative(root, input.requestedPath!), sha256: input.sha256,
        }))];
      const byPath = (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path);
      assert.deepEqual(artifact.sources.map(({ path, sha256 }) => ({ path, sha256 })).sort(byPath), expectedSources.sort(byPath));
      const operation = artifact.operations?.find(operation => operation.name === 'intake.start');
      const plan = operation?.result?.disclosure; assert.ok(plan);
      assert.equal(plan.queries?.length, 1); const queryPlan = plan.queries![0]!;
      assert.equal(queryPlan.model, EMPLOYEE); assert.equal(queryPlan.parent, undefined);
      assert.ok(queryPlan.dependencies.length >= 5);
      assert.ok(queryPlan.dependencies.every(dependency => dependency.role === 'control'));
      assert.deepEqual(new Set(queryPlan.dependencies.map(dependency => dependency.field)), new Set(['user', 'active', 'operator_wide', 'home', 'locations']));
      const memberMarkers = artifact.modules.flatMap(module => [...module.js.matchAll(/active_member\(c,[^,\n]+,c\.team,(\{[^\n]+?\})\)/g)]
        .map(match => object(JSON.parse(match[1]!))));
      assert.ok(memberMarkers.some(marker => Object.hasOwn(marker, 'sourceCall')),
        'the actual emitted helper must issue an occurrence selector, rather than relying on a unique physical node');
      const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: { IDENTITY: 'helper-predicate-identity', OWNER: 'helper-predicate-owner' }, d1Persist: join(directory, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      let now = Date.now(), sequence = 0;
      const clock = { nowMs: () => now }, identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      async function actor(name: string, hr = false) {
        const user = await identities.createUser({ email: `${name}@helper.example.test`, password_hash: 'unused', email_verified: true });
        const roles = hr ? [{ role: 'employee.hr', granted_at: new Date(now).toISOString(), granted_by: user.user_id }] : [];
        const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles });
        const token = `helper-predicate-${user.user_id}`;
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600_000).toISOString() });
        const current = () => resolveIdentity(identities, { session_token: token }, { clock });
        return { user, membership, roles, current, identity: await current() };
      }
      const hr = await actor('hr', true), alice = await actor('alice'), bob = await actor('bob'), charlie = await actor('charlie'), outsider = await actor('outsider');
      const physical = createD1Storage(ownerDb), batches: CommitBatch[] = [];
      const store: StoragePort = { ...physical, async commit(batch) {
        const result = await physical.commit(batch); batches.push(batch); return result;
      } };
      const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, source: 'http', now: clock.nowMs });
      const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({
        operation, operation_id: uuidv7(now, ++sequence), inputs });
      const invoke = (input: MutationEnvelope, who = alice) => invoker.invokeMutation(input, who.identity);
      const receiptIdentity = (input: MutationEnvelope, who = alice): ReceiptIdentity => ({ app: APP, owner: team.team_id, principal: who.user.user_id,
        operation: asOperation(input.operation), operationId: asOperationId(input.operation_id) });
      async function seed(model: typeof LOCATION, inputs: MutationEnvelope['inputs']) {
        now += 1000;
        const result = committed(await invoke(envelope(`${model}.create`, inputs), hr));
        const projected = object(result.records![0]);
        const row = await store.load(model, asId(projected.id as string)); assert.ok(row); return row;
      }
      const home = await seed(LOCATION, { title: 'home' }), listed = await seed(LOCATION, { title: 'listed' }), unrelated = await seed(LOCATION, { title: 'unrelated' });
      async function employee(who: typeof alice, location: StoredRow, locations: StoredRow[], name: string) {
        const row = await seed(EMPLOYEE, { user: { id: who.user.user_id }, name, home: ref(location), locations: locations.map(ref),
          start: '2026-10-01', role: 'operator', skills: ['support'] });
        // Original create_fields excludes private_notes; only HR's ordinary update writes it.
        committed(await invoke(envelope(`${EMPLOYEE}.update`, { record: ref(row), private_notes: `${name} private HR` }), hr));
        const saved = await store.load(EMPLOYEE, row.id); assert.ok(saved); return saved;
      }
      const earlier = await employee(bob, unrelated, [], 'Earlier nonmatching');
      let currentEmployee = await employee(alice, home, [listed], 'Current worker');
      const suffix = await employee(charlie, unrelated, [], 'Skipped later employee');
      const invalidEnd = envelope(`${EMPLOYEE}.update`, { record: ref(currentEmployee), end: '2026-09-30' });
      const beforeInvalid = batches.length, invalidHistory = await store.historyFor(EMPLOYEE, currentEmployee.id);
      const invalid = await invoke(invalidEnd, hr);
      assert.ok('error' in invalid, JSON.stringify(invalid)); assert.equal(invalid.error.code, 'rule_failed');
      assert.deepEqual(await store.load(EMPLOYEE, currentEmployee.id), currentEmployee);
      assert.deepEqual(await store.historyFor(EMPLOYEE, currentEmployee.id), invalidHistory);
      assert.equal(batches.length, beforeInvalid + 1);
      for (const key of ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases'] as const) assert.deepEqual(batches.at(-1)![key], []);
      const invalidReceipt = await store.readReceipt(receiptIdentity(invalidEnd, hr)); assert.ok(invalidReceipt);
      assert.equal(invalidReceipt.outcome.status, 'rejected');
      const invalidReplay = await invoke(invalidEnd, hr); assert.ok('error' in invalidReplay); assert.equal(invalidReplay.error.code, 'rule_failed');
      assert.equal(batches.length, beforeInvalid + 1);
      async function readEmployees(who: typeof alice) {
        const outcome = await invoker.invokeRead({ operation: `${EMPLOYEE}.read`, inputs: {} }, await who.current());
        assert.ok('result' in outcome, JSON.stringify(outcome));
        const records = object(outcome.result).records; assert.ok(Array.isArray(records)); return records.map(object);
      }
      const hrRows = await readEmployees(hr); assert.equal(hrRows.length, 3);
      assert.ok(hrRows.every(row => typeof object(row.data).private_notes === 'string'));
      const activeRows = await readEmployees(alice); assert.equal(activeRows.length, 3);
      assert.equal(object(activeRows.find(row => row.id === currentEmployee.id)!.data).private_notes, 'Current worker private HR', 'original self grant retains complete own HR data');
      for (const row of activeRows.filter(row => row.id !== currentEmployee.id)) {
        const data = object(row.data);
        for (const name of ['private_notes', 'document', 'start', 'end', 'manager']) assert.equal(Object.hasOwn(data, name), false, `staff cannot read another employee ${name}`);
        for (const name of ['user', 'name', 'home', 'locations', 'operator_wide', 'active', 'role', 'skills']) assert.equal(Object.hasOwn(data, name), true);
      }
      assert.deepEqual(await readEmployees(outsider), []);
      const rows = () => store.query({ model: CREATED, authority: 'owner' });
      const call = (location: StoredRow, title: string) => envelope('intake.start', { input: { location: ref(location), title } });
      const firstCall = call(home, 'home match'), originalInput = structuredClone(firstCall.inputs), beforeFirst = batches.length;
      const firstId = referenceId(await invoke(firstCall));
      const created = await store.load(CREATED, asId(firstId)); assert.ok(created);
      assert.deepEqual(firstCall.inputs, originalInput, 'original Contract reference wire remains unchanged');
      assert.deepEqual(created.data, { location: { id: home.id }, title: 'home match' }, 'stored Model edges retain identity; input versions remain admission evidence');
      assert.equal(batches.length, beforeFirst + 1); assert.equal(batches.at(-1)!.writes.length, 1); assert.equal(batches.at(-1)!.history.length, 1);
      const receipt = await store.readReceipt(receiptIdentity(firstCall)); assert.ok(receipt);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.equal(association.changed.length, 1); assert.equal(association.changed[0]!.row.id, firstId);
      assert.equal(association.queries?.length, 1); const ledger = association.queries![0]!;
      assert.equal(ledger.queryId, queryPlan.id);
      assert.deepEqual(ledger.candidates.map(candidate => candidate.row.id), [earlier.id, currentEmployee.id, suffix.id]);
      assert.deepEqual(ledger.selectedIndices, [1]);
      assert.equal(ledger.candidates[0]!.dependencies.length, 1, 'nonmatching User short-circuits active/membership/location');
      assert.equal(ledger.candidates[2]!.dependencies.length, 0, 'first true leaves later predicate untouched');
      assert.equal(Object.hasOwn(ledger.candidates[2]!.record.data, 'private_notes'), false, 'skipped colleague retains original restricted grant');
      const fieldsById = new Map(queryPlan.dependencies.map(dependency => [dependency.id, dependency.field]));
      assert.deepEqual(ledger.candidates[1]!.dependencies.map(id => fieldsById.get(id)), ['user', 'active', 'operator_wide', 'home']);
      assert.ok(queryPlan.dependencies.every(dependency => !['private_notes', 'document', 'manager', 'start', 'end'].includes(dependency.field)));
      for (const candidate of ledger.candidates) for (const id of candidate.dependencies) {
        const field = fieldsById.get(id); assert.ok(field); assert.equal(Object.hasOwn(candidate.record.data, field), true);
      }
      const originalRows = await rows(), originalHistory = await store.historyFor(CREATED, created.id), replayCount = batches.length;
      assert.equal(referenceId(await invoke(firstCall), 'replayed'), firstId);
      assert.equal(referenceId(await invoker.invokeRetainedMutation(firstCall, await alice.current()), 'replayed'), firstId);
      assert.equal(batches.length, replayCount); assert.deepEqual(await rows(), originalRows);
      assert.deepEqual(await store.historyFor(CREATED, created.id), originalHistory); assert.deepEqual(await store.readReceipt(receiptIdentity(firstCall)), receipt);
      const listedCall = call(listed, 'explicit list match'); referenceId(await invoke(listedCall));
      const listedReceipt = await store.readReceipt(receiptIdentity(listedCall)); assert.ok(listedReceipt);
      const listedLedger = readScenarioReceiptAssociation(listedReceipt)!.queries![0]!;
      assert.deepEqual(listedLedger.candidates[1]!.dependencies.map(id => fieldsById.get(id)), ['user', 'active', 'operator_wide', 'home', 'locations']);
      async function deniedWithoutEffects(input: MutationEnvelope, who = alice, code = 'rule_failed') {
        const before = await rows(), count = batches.length;
        const outcome = await invoke(input, who); assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, code);
        assert.deepEqual(await rows(), before);
        assert.equal(batches.length, count + (code === 'rule_failed' ? 1 : 0));
        if (code === 'rule_failed') {
          const rejected = batches.at(-1)!;
          for (const key of ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases'] as const) assert.deepEqual(rejected[key], []);
          assert.equal(rejected.receipt?.outcome.status, 'rejected');
          assert.equal((await store.readReceipt(receiptIdentity(input, who)))?.outcome.status, 'rejected');
        }
        const after = batches.length;
        const replay = await invoke(input, who); assert.ok('error' in replay); assert.equal(replay.error.code, code); assert.equal(batches.length, after);
      }
      await deniedWithoutEffects(call(unrelated, 'unrelated denied'));
      await deniedWithoutEffects(call(home, 'HR visibility confers no work'), hr);
      committed(await invoke(envelope(`${EMPLOYEE}.update`, { record: ref(currentEmployee), operator_wide: true }), hr));
      currentEmployee = (await store.load(EMPLOYEE, currentEmployee.id))!;
      const wideCall = call(unrelated, 'operator wide match'); referenceId(await invoke(wideCall));
      const wideReceipt = await store.readReceipt(receiptIdentity(wideCall)); assert.ok(wideReceipt);
      const wideLedger = readScenarioReceiptAssociation(wideReceipt)!.queries![0]!;
      assert.deepEqual(wideLedger.candidates[1]!.dependencies.map(id => fieldsById.get(id)), ['user', 'active', 'operator_wide']);
      committed(await invoke(envelope('employee.deactivate', { employee: ref(currentEmployee), ended: '2026-10-15' }), hr));
      currentEmployee = (await store.load(EMPLOYEE, currentEmployee.id))!; assert.equal(currentEmployee.data.active, false);
      const inactiveRows = await readEmployees(alice); assert.equal(inactiveRows.length, 1); assert.equal(inactiveRows[0]!.id, currentEmployee.id);
      assert.equal(object(inactiveRows[0]!.data).private_notes, 'Current worker private HR');
      await deniedWithoutEffects(call(home, 'inactive worker denied'));
      await identities.removeMembership(alice.membership.membership_id);
      const revokedCount = batches.length, revokedRows = await rows();
      const withheld = committed(await invoke(firstCall), 'replayed'); assert.equal(withheld.result, null); assert.deepEqual(withheld.records, []);
      const retained = await invoker.invokeRetainedMutation(firstCall, alice.identity); assert.ok('error' in retained); assert.equal(retained.error.code, 'forbidden');
      await deniedWithoutEffects(call(home, 'current member revoked'), alice, 'forbidden');
      assert.equal(batches.length, revokedCount); assert.deepEqual(await rows(), revokedRows);
      for (const file of files) assert.equal(await readFile(file.path, 'utf8'), file.text);
      assert.equal(await captureIsCurrent(capture), true);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await readFile(join(root, 'draft/shared/Employees.can'), 'utf8'), original);
    } finally {
      await worker?.dispose(); await rm(directory, { recursive: true, force: true });
    }
}

test('native leading imported can_work retains the original lazy Employee predicate and current authority',
  { timeout: 180000 }, () => nativeHelperCase(false));
test('native cross-file imported can_work retains the same original workflow and source correspondence',
  { timeout: 180000 }, () => nativeHelperCase(true));
