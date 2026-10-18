import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { CompileArtifact, MutationEnvelope, StoredRow } from '@canlang/contracts';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createD1IdentityStore, ensureIdentitySchema } from '@canlang/identity';
import { WORK_SYSTEM_COMMANDS } from '@canlang/work/kernel/commands';
import {
  FIXED_NOW, asId, asModel, asOperationId, makeIdentity, makeBatch, makeRow, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';
import { createCheckoutScratch } from '../dev/checkout-scratch.js';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const FIXTURE = 'packages/cloudflare/test/fixtures/hook-first-delivery.can';
const APP = 'HookFirstDelivery';
const BUDGET = asModel(`${APP}.Budget`);
let sequence = 9000;

function envelope(operation: string, inputs: MutationEnvelope['inputs'], app = APP): MutationEnvelope {
  return { operation: `${app}.${operation}`, inputs,
    operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) };
}

async function compileFixture(native: boolean, fixture: string): Promise<CompileArtifact> {
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalog = process.env.CAN_NATIVE_CATALOG ??
    join(root, 'packages/cloudflare/dist/native-catalog.json');
  const args = ['compile', '--format=json', '--catalog', catalog,
    ...(native ? ['--native-scenario-receipts'] : []), fixture];
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  const { stdout } = await execFileAsync(compiler, args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!('diagnostics' in artifact), `delivery fixture emits clean (native=${native})`);
  return artifact;
}

async function setup(native: boolean, fixture = FIXTURE, app = APP) {
  const artifact = await compileFixture(native, fixture);
  const dir = await mkdtemp(join(tmpdir(), 'can-hook-first-delivery-'));
  const asm = await assembleModules({ artifact, sourcePath: join(root, fixture) }, {
    workDir: join(dir, 'modules'),
    stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    uiUrl: import.meta.resolve('@canlang/ui'),
  });
  const memberships = createMemoryIdentityStore();
  const user = await memberships.createUser({ email: 'hook-first-owner@example.test',
    email_verified: true, password_hash: 'unused' });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const membership = await memberships.createMembership({ team_id: team.team_id,
    user_id: user.user_id, is_owner: true, roles: [] });
  const identity = makeIdentity({ membership, team, email: user.email });
  const store = createTestMemoryStorage().store;
  const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
  const scope = { app, owner: team.team_id, ownerPackage: app };
  const at = FIXED_NOW + 60_000;
  const committed = async (operation: string, inputs: MutationEnvelope['inputs']) => {
    const outcome = await invoker.invokeMutation(envelope(operation, inputs, app), identity);
    assert.ok('result' in outcome, JSON.stringify(outcome));
    assert.equal(outcome.result.status, 'committed');
    return outcome.result;
  };
  const slot = (await committed('Slot.create', { label: 'key' })).records![0] as {
    id: string; version: number };
  return { artifact, asm, dir, store, memberships, invoker, identity, scope, at, slot, app };
}

async function armAndDeliver(world: Awaited<ReturnType<typeof setup>>, source: string) {
  const { invoker, identity, scope, at, slot, store, app } = world;
  const arm = await world.invoker.invokeMutation(
    envelope('arm', { slot: { id: slot.id, version: String(slot.version) },
      at: new Date(at).toISOString(), source }, app), identity);
  assert.ok('result' in arm && arm.result.status === 'committed', JSON.stringify(arm));
  const { invokeDueScheduleCanonical } = await import('@canlang/cloudflare/runtime/invoke');
  const { scheduleByKeyQuery } = await import('@canlang/work/kernel/tables');
  const rows = await store.query(scheduleByKeyQuery(scope, slot.id));
  const row = rows.find((entry: { data: Record<string, unknown> }) =>
    entry.data['state'] === 'pending');
  assert.ok(row, 'arm stages one pending occurrence');
  return invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact, app,
    handler: `${app}.probe`, due: { key: slot.id, scope, occurrenceId: row.id,
      event: `${app}.Tick`, at },
    store, identities: world.memberships, now: () => at });
}

async function teardown(world: Awaited<ReturnType<typeof setup>>) {
  await rm(world.dir, { recursive: true, force: true });
}

test('plain delivery of the admitted hook shape completes on a granted row', async () => {
  const world = await setup(false);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: true }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const completed = await armAndDeliver(world, 'acme-renewal');
    assert.deepEqual(completed, { status: 'completed',
      occurrenceId: (completed as { occurrenceId: string }).occurrenceId, result: null });
    const budgets = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(budgets.length, 1);
  } finally {
    await teardown(world);
  }
});

test('plain delivery of the admitted hook shape fails closed on the empty domain', async () => {
  const world = await setup(false);
  try {
    const failed = await armAndDeliver(world, 'acme-renewal') as {
      status: string; occurrenceId: string };
    assert.equal(failed.status, 'failed');
    const { WORK_OCCURRENCE_MODEL } = await import('@canlang/work/kernel/tables');
    const occurrence = await world.store.load(WORK_OCCURRENCE_MODEL, asId(failed.occurrenceId));
    assert.equal(occurrence?.data['status'], 'failed');
    assert.deepEqual(await world.store.query({ model: BUDGET, authority: 'owner' }), []);
  } finally {
    await teardown(world);
  }
});

test('plain delivery of the admitted hook shape fails closed on an unapproved row', async () => {
  const world = await setup(false);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: false }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const failed = await armAndDeliver(world, 'acme-renewal');
    assert.equal((failed as { status: string }).status, 'failed');
    const budgets = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(budgets.length, 1);
  } finally {
    await teardown(world);
  }
});

test('plain delivery refuses a foreign-scope occurrence for the admitted hook shape', async () => {
  const world = await setup(false);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: true }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const { invokeDueScheduleCanonical } = await import('@canlang/cloudflare/runtime/invoke');
    const { scheduleByKeyQuery } = await import('@canlang/work/kernel/tables');
    const arm = await world.invoker.invokeMutation(
      envelope('arm', { slot: { id: world.slot.id, version: String(world.slot.version) },
        at: new Date(world.at).toISOString(), source: 'acme-renewal' }), world.identity);
    assert.ok('result' in arm && arm.result.status === 'committed');
    const pending = (await world.store.query(scheduleByKeyQuery(world.scope, world.slot.id)))
      .find((entry: { data: Record<string, unknown> }) => entry.data['state'] === 'pending');
    assert.ok(pending);
    const revision = await world.store.readRevision();
    const refused = await invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact,
      app: APP, handler: `${APP}.probe`, due: { key: world.slot.id,
        scope: { ...world.scope, owner: 'foreign-owner' }, occurrenceId: pending.id,
        event: `${APP}.Tick`, at: world.at },
      store: world.store, identities: world.memberships, now: () => world.at });
    assert.deepEqual(refused, { status: 'refused', reason: 'mismatched' });
    assert.equal(await world.store.readRevision(), revision);
  } finally {
    await teardown(world);
  }
});

test('native delivery of the admitted hook shape completes on a granted row', async () => {
  const world = await setup(true);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: true }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    // C24 scope-1 (REVIEW-20 successor): the admitted compiled handler runs
    // natively inside its internal trusted-handler session — private
    // invocation disclosure, verified module query inventory and the same
    // State fence — so approved/granted completes like plain delivery.
    const completed = await armAndDeliver(world, 'acme-renewal');
    assert.deepEqual(completed, { status: 'completed',
      occurrenceId: (completed as { occurrenceId: string }).occurrenceId, result: null });
    const budgets = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(budgets.length, 1);
  } finally {
    await teardown(world);
  }
});

test('native delivery of the admitted hook shape fails closed on the empty domain', async () => {
  const world = await setup(true);
  try {
    const failed = await armAndDeliver(world, 'acme-renewal') as {
      status: string; occurrenceId: string };
    assert.equal(failed.status, 'failed');
    const { WORK_OCCURRENCE_MODEL } = await import('@canlang/work/kernel/tables');
    const occurrence = await world.store.load(WORK_OCCURRENCE_MODEL, asId(failed.occurrenceId));
    assert.equal(occurrence?.data['status'], 'failed');
    assert.deepEqual(await world.store.query({ model: BUDGET, authority: 'owner' }), []);
  } finally {
    await teardown(world);
  }
});

test('native delivery of the admitted hook shape fails closed on an unapproved row', async () => {
  const world = await setup(true);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: false }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const failed = await armAndDeliver(world, 'acme-renewal');
    assert.equal((failed as { status: string }).status, 'failed');
    const budgets = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(budgets.length, 1);
  } finally {
    await teardown(world);
  }
});

test('native delivery refuses a foreign-scope occurrence for the admitted hook shape', async () => {
  const world = await setup(true);
  try {
    const created = await world.invoker.invokeMutation(
      envelope('Budget.create', { source: 'acme-renewal', approved: true }), world.identity);
    assert.ok('result' in created && created.result.status === 'committed');
    const { invokeDueScheduleCanonical } = await import('@canlang/cloudflare/runtime/invoke');
    const { scheduleByKeyQuery } = await import('@canlang/work/kernel/tables');
    const arm = await world.invoker.invokeMutation(
      envelope('arm', { slot: { id: world.slot.id, version: String(world.slot.version) },
        at: new Date(world.at).toISOString(), source: 'acme-renewal' }), world.identity);
    assert.ok('result' in arm && arm.result.status === 'committed');
    const pending = (await world.store.query(scheduleByKeyQuery(world.scope, world.slot.id)))
      .find((entry: { data: Record<string, unknown> }) => entry.data['state'] === 'pending');
    assert.ok(pending);
    const revision = await world.store.readRevision();
    const refused = await invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact,
      app: APP, handler: `${APP}.probe`, due: { key: world.slot.id,
        scope: { ...world.scope, owner: 'foreign-owner' }, occurrenceId: pending.id,
        event: `${APP}.Tick`, at: world.at },
      store: world.store, identities: world.memberships, now: () => world.at });
    assert.deepEqual(refused, { status: 'refused', reason: 'mismatched' });
    assert.equal(await world.store.readRevision(), revision);
  } finally {
    await teardown(world);
  }
});

test('whole handler queries retain their own staged prefix and a late require rolls back', async () => {
  const scratch = await createCheckoutScratch(root, 'handler-query-prefix-');
  let world: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const original = await readFile(join(root, FIXTURE), 'utf8');
    const source = original.replace('When\n', ' invariant Budget: trim(row.source)!="" and count(Budget as candidate where candidate.approved in [true,false] and now==now)>=0\nWhen\n')
      .replace(/ scenario probe on=Tick[\s\S]*?Then\n/, ` scenario probe on=Tick
  do
   let before=first(Budget as row where row.source==event.source order=row.id)
   require before!=null
   set before {approved=true}
   let after=first(Budget as row where row.source==event.source and row.approved order=row.id)
   require after!=null and after.id==before.id
   require event.source!="reject"
Then
`);
    const path = join(scratch, 'original.can');
    await writeFile(path, source);
    world = await setup(true, relative(root, path));
    for (const source of ['allow', 'reject']) {
      const created = await world.invoker.invokeMutation(envelope('Budget.create', { source, approved: false }), world.identity);
      assert.ok('result' in created && created.result.status === 'committed');
      const { loadDispatchSystemProducers, invokeDueScheduleCanonical } = await import('./invoke.js');
      const producers = await loadDispatchSystemProducers();
      const registry = producers.createSystemRegistry([...producers.l3Commands, ...WORK_SYSTEM_COMMANDS]);
      const key = `prefix-${source}`, occurrenceId = uuidv7(world.at, ++sequence);
      await registry.run('work.schedule.put', { key, scope: world.scope, at: world.at,
        event: `${APP}.Tick`, payload: { source }, occurrenceId },
        { actor: 'prefix-test', now: world.at, operation: 'test.stage', operationId: uuidv7(world.at, ++sequence) }, { store: world.store });
      const result = await invokeDueScheduleCanonical({ asm: world.asm, artifact: world.artifact, app: APP,
        handler: `${APP}.probe`, due: { key, scope: world.scope, at: world.at, event: `${APP}.Tick`, occurrenceId },
        store: world.store, identities: world.memberships, now: () => world!.at });
      assert.equal(result.status, source === 'allow' ? 'completed' : 'failed');
      const rows = await world.store.query({ model: BUDGET, authority: 'owner' });
      assert.equal(rows.find(row => row.data.source === source)?.data.approved, source === 'allow');
    }
  } finally {
    if (world !== undefined) await teardown(world);
    await rm(scratch, { recursive: true, force: true });
  }
});

/** Keep declarations and handler text byte-for-byte from the draft owners.
 * Selection follows named dependencies and every selected model's existing
 * policies/invariants/locks/uniques; fixtures and unrelated derives stay out.
 */
async function originalHandlerSource(owner: string, handlerName: string) {
  const paths: string[] = [];
  const collect = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.name.endsWith('.can')) paths.push(path);
    }
  };
  await collect(join(root, 'draft'));
  type Unit = { name: string; text: string; kind: string };
  type Package = { units: Unit[]; imports: Array<{ from: string; members: Array<{ original: string; local: string }>; suffix: string }>; selected: Set<Unit>; handlers: string };
  const packages = new Map<string, Package>();
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    const matches = [...source.matchAll(/^package ([A-Za-z_][A-Za-z_0-9]*)[^\n]*\n/gm)];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!, content = source.slice(match.index! + match[0].length, matches[i + 1]?.index);
      const given = content.indexOf(' Given\n'), when = content.indexOf(' When\n');
      if (given < 0 || when < 0) continue;
      const units: Unit[] = [];
      const lines = content.slice(given + ' Given\n'.length, when).split('\n');
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j]!;
        if (!/^  \S/.test(line) || /^  #/.test(line)) continue;
        let end = j + 1;
        while (end < lines.length && (/^   /.test(lines[end]!) || lines[end] === '')) end++;
        const text = lines.slice(j, end).join('\n').trimEnd() + '\n';
        const declaration = line.match(/^  (?:export )?(?:(message|role|event|contract|capability|derive) )?([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?)/);
        if (declaration && !/^(?:fixture|policy|invariant|unique|lock)$/.test(declaration[2]!)) {
          units.push({ kind: declaration[1] ?? 'model', name: declaration[2]!, text });
        } else {
          const rule = line.match(/^  (policy|invariant|unique|lock) ([A-Za-z_][A-Za-z_0-9]*)/);
          if (rule) units.push({ kind: rule[1]!, name: rule[2]!, text });
        }
        j = end - 1;
      }
      const imports = [...content.slice(0, given).matchAll(/^ use ([A-Za-z_][A-Za-z_0-9]*) \{([^}]+)\}(.*)$/gm)].map(entry => ({
        from: entry[1]!, suffix: entry[3]!, members: entry[2]!.split(',').map(member => {
          const [original, local = original] = member.trim().split(/ +as +/);
          return { original: original!, local: local! };
        }),
      }));
      const handler = content.match(new RegExp(`^  scenario ${handlerName} on=[^\n]+\n(?:   [^\n]*\n|\n)*`, 'm'))?.[0] ?? '';
      packages.set(match[1]!, { units, imports, selected: new Set(), handlers: match[1] === owner ? handler.trimEnd() + '\n' : '' });
    }
  }
  assert.ok(packages.get(owner)?.handlers.includes('first('), 'actual original whole handler was extracted');
  const identifiers = (text: string) => new Set(text.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []);
  // Capability interfaces contribute only the exact operations/events consumed
  // by retained declarations. Keep their original header/version and member
  // lines; every retained model still contributes all its owning rules.
  const capabilityText = (packageName: string, unit: Unit) => {
    const operations = new Set<string>();
    for (const [consumerName, consumer] of packages) {
      const aliases = consumer.imports.filter(imported => imported.from === packageName)
        .flatMap(imported => imported.members.filter(member => member.original === unit.name).map(member => member.local));
      if (consumerName === packageName) aliases.push(unit.name);
      const text = (consumer.handlers + [...consumer.selected].filter(selected => selected.kind !== 'capability')
        .map(selected => selected.text).join('')).replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (const alias of aliases) for (const match of text.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_][A-Za-z_0-9]*)`, 'g'))) {
        operations.add(match[1]!);
      }
    }
    assert.ok(operations.size > 0, `retained capability ${packageName}.${unit.name} needs an actual member consumer`);
    const lines = unit.text.trimEnd().split('\n');
    const members = lines.slice(1).filter(line => {
      const member = line.match(/^   (?:event )?([A-Za-z_][A-Za-z_0-9]*)[ ({]/);
      return member !== null && operations.has(member[1]!);
    });
    assert.equal(members.length, operations.size, `every consumed ${packageName}.${unit.name} member has its original declaration`);
    return [lines[0], ...members].join('\n') + '\n';
  };
  const retainedText = (name: string, pkg: Package) => pkg.handlers + [...pkg.selected]
    .map(unit => unit.kind === 'capability' ? capabilityText(name, unit) : unit.text).join('');
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, pkg] of packages) {
      const tokens = identifiers(retainedText(name, pkg));
      for (const unit of pkg.units) {
        const selectedModel = (name: string) => [...pkg.selected].some(candidate => candidate.kind === 'model' && candidate.name === name);
        const field = unit.kind === 'derive' ? unit.name.split('.') : [];
        const needed = ['policy', 'invariant', 'unique', 'lock'].includes(unit.kind) ? selectedModel(unit.name)
          : field.length === 2 ? selectedModel(field[0]!) && tokens.has(field[1]!) : tokens.has(unit.name);
        if (needed && !pkg.selected.has(unit)) { pkg.selected.add(unit); changed = true; }
      }
      for (const imported of pkg.imports) for (const member of imported.members) {
        if (!tokens.has(member.local)) continue;
        const provider = packages.get(imported.from);
        const unit = provider?.units.find(candidate => candidate.name === member.original && !['policy', 'invariant', 'unique', 'lock'].includes(candidate.kind));
        if (unit && !provider!.selected.has(unit)) { provider!.selected.add(unit); changed = true; }
      }
    }
  }
  const app = 'OriginalVenueCleanup';
  let result = `app ${app} uses=[${owner}]\n`;
  for (const [name, pkg] of packages) {
    if (pkg.selected.size === 0 && pkg.handlers === '') continue;
    const tokens = identifiers(retainedText(name, pkg));
    result += `package ${name}\n`;
    for (const imported of pkg.imports) {
      const members = imported.members.filter(member => tokens.has(member.local));
      if (members.length) result += ` use ${imported.from} {${members.map(member => member.original === member.local ? member.original : `${member.original} as ${member.local}`).join(',')}}${imported.suffix}\n`;
    }
    result += ' Given\n' + pkg.units.filter(unit => pkg.selected.has(unit)).map(unit => unit.kind === 'capability' ? capabilityText(name, unit) : unit.text).join('') + ' When\n' + pkg.handlers + ' Then\n';
  }
  return { app, source: result, handler: `${owner}.${handlerName}` };
}

async function originalVenueCleanupWorld() {
  const original = await originalHandlerSource('events', 'venue_cleanup');
  const dir = await mkdtemp(join(tmpdir(), 'can-original-venue-cleanup-'));
  let worker: Miniflare | undefined;
  try {
    const sourcePath = join(dir, 'original.can');
    await writeFile(sourcePath, original.source);
    const artifact = await compileFixture(true, sourcePath);
    const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const callable = artifact.callables.find(value => value.id === original.handler);
    assert.ok(callable, 'whole original handler is compiled');
    const { importVerifiedAssemblyModule } = await import('./modules.js');
    const module = await importVerifiedAssemblyModule(asm, callable.module, artifact) as {
      appDefinition: { operations: Record<string, { event: string }> } };
    const event = module.appDefinition.operations[original.handler]!.event;
    assert.equal(event, 'events.VenueCleanup');
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default {fetch(){return new Response("private")}}',
      d1Databases: { STATE: 'original-venue-state', IDENTITY: 'original-venue-identity' } });
    const stateDb = await worker.getD1Database('STATE') as unknown as D1Database;
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    await ensureSchema(stateDb); await ensureIdentitySchema(identityDb);
    const { loadDispatchSystemProducers, invokeDueScheduleCanonical, createWorkerDispatchJoinPort, withDispatchJoinPort } = await import('./invoke.js');
    const underlying = createD1Storage(stateDb);
    const store = withDispatchJoinPort(underlying, await createWorkerDispatchJoinPort(underlying));
    const identities = createD1IdentityStore(identityDb, { clock: { nowMs: () => FIXED_NOW } });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const person = await identities.createUser({ email: 'original-venue@example.test', password_hash: 'unused', email_verified: true });
    const scope = { app: original.app, owner: team.team_id, ownerPackage: 'events' };
    const producers = await loadDispatchSystemProducers();
    const registry = producers.createSystemRegistry([...producers.l3Commands, ...WORK_SYSTEM_COMMANDS]);
    const seed = async (model: string, id: string, data: Record<string, unknown>, parent?: { model: string; id: string }) => {
      const row: StoredRow = { ...makeRow({ id, data }), parent: parent ? { model: asModel(parent.model), id: asId(parent.id) } : null };
      await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel(model), row }] }));
      return row;
    };
    let index = 0;
    const deliver = (due: import('@canlang/work/kernel/schedule-staging').DueScheduleInput) => invokeDueScheduleCanonical({
      asm, artifact, app: original.app, handler: original.handler, due, store, identities, now: () => FIXED_NOW });
    const arm = async (eventId: string, revision = '2') => {
      const key = `original-venue-${++index}`, occurrenceId = `original-venue-occurrence-${index}`;
      await registry.run('work.schedule.put', { key, scope, at: FIXED_NOW, event,
        payload: { event: { id: eventId, version: '1' }, revision, reason: 'Original cancellation' }, occurrenceId },
        { actor: 'original-venue-test', now: FIXED_NOW, operation: 'test.schedule-original', operationId: uuidv7(FIXED_NOW, ++sequence) }, { store });
      return { key, scope, at: FIXED_NOW, event, occurrenceId };
    };
    const continuation = async (eventId: string) => {
      const { scheduleByKeyQuery, readScheduleRow } = await import('@canlang/work/kernel/tables');
      const rows = await store.query(scheduleByKeyQuery(scope, `${eventId}:venues`));
      const pending = rows.map(readScheduleRow).filter(row => row.state === 'pending');
      assert.equal(pending.length, 1, 'one original continuation is retained');
      const row = pending[0]!;
      assert.deepEqual(row.payload, { event: { id: eventId, version: '1' }, revision: '2', reason: 'Original cancellation' });
      return { key: row.key, scope, at: row.at, event: row.event, occurrenceId: row.occurrenceId };
    };
    return { ...original, event, dir, worker, store, identities, scope, person, seed, arm, deliver, continuation };
  } catch (error) {
    await worker?.dispose(); await rm(dir, { recursive: true, force: true }); throw error;
  }
}

async function seedOriginalVenue(world: Awaited<ReturnType<typeof originalVenueCleanupWorld>>) {
  const ids = { site: uuidv7(FIXED_NOW, 201), program: uuidv7(FIXED_NOW, 202), event: uuidv7(FIXED_NOW, 203),
    otherEvent: uuidv7(FIXED_NOW, 204), resource: uuidv7(FIXED_NOW, 205),
    excluded: uuidv7(FIXED_NOW, 206), foreign: uuidv7(FIXED_NOW, 207), first: uuidv7(FIXED_NOW, 208), second: uuidv7(FIXED_NOW, 209) };
  const eur = (minor: string) => ({ minor, currency: 'EUR' });
  await world.seed('rent_catalog.Location', ids.site, { name: 'Original site', address: '1 Road', timezone: 'UTC',
    currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true });
  await world.seed('events.Program', ids.program, { name: 'Original program' });
  const event = { location: { id: ids.site }, name: 'Original event', description: 'Original description', timezone: 'UTC',
    from: '2026-10-19T09:00:00.000Z', until: '2026-10-19T10:00:00.000Z', capacity: '10', price: eur('0'),
    sales_until: '2026-10-19T08:00:00.000Z', refund_before: '2026-10-18T08:00:00.000Z', terms: 'Original terms',
    venue: null, venue_name: null, pending_change: null, revision: '2', organizer: { id: world.person.user_id },
    cancellation_reason: 'Original cancellation', published: false, cancelled: true };
  for (const id of [ids.event, ids.otherEvent]) await world.seed('events.Event', id, event, { model: 'events.Program', id: ids.program });
  await world.seed('rent_reservations.Resource', ids.resource, { location: { id: ids.site }, name: 'Original venue',
    pooled: false, capacity: '1', party_limit: '20', kind: 'event_space', hold_for: '900000', active: true,
    timezone: 'UTC', currency: 'EUR', tax_rate: '0', discount_rate: '0', cancellation_fee: null,
    hourly: eur('100'), daily: null, price_unit: 'hour', increment: '3600000', minimum: '3600000',
    terms: 'Original venue terms', refund_notice: '86400000', buffer_before: '0', buffer_after: '0', amenities: [], accessibility: 'Step-free' });
  const change = { source: 'original-candidate', base_revision: '1', location: { id: ids.site }, timezone: 'UTC',
    from: event.from, until: event.until, capacity: '10', sales_until: event.sales_until, reason: 'Original proposed change',
    author: { id: world.person.user_id }, resource: null, customer: null, account: { id: world.person.user_id }, previous: null,
    state: 'holding', venue_state: 'pending', venue_revision: '0', reference: null, hold_delivery: null,
    confirm_delivery: null, release_reason: null, release_delivery: null, hold_status: null, confirm_status: null, release_status: null };
  return { ids, event, change };
}

test('whole original venue cleanup selects one contained candidate, releases or sends, continues and replays through D1 Work',
  { timeout: 120_000 }, async () => {
    const world = await originalVenueCleanupWorld();
    try {
      const { ids, change } = await seedOriginalVenue(world);
      const owners = await Promise.all(['events.Event', 'events.Program', 'rent_catalog.Location', 'rent_reservations.Resource']
        .map(async model => ({ model, rows: await world.store.query({ model: asModel(model), authority: 'owner' }) })));
      const changes = () => world.store.query({ model: asModel('events.Change'), authority: 'owner' });
      const empty = await world.arm(ids.event);
      assert.equal((await world.deliver(empty)).status, 'completed');
      assert.deepEqual(await changes(), []);
      assert.deepEqual(await world.store.outboxPending(), []);
      await world.seed('events.Change', ids.excluded, { ...change, source: 'already-releasing', state: 'releasing' }, { model: 'events.Event', id: ids.event });
      await world.seed('events.Change', ids.foreign, { ...change, source: 'other-event' }, { model: 'events.Event', id: ids.otherEvent });
      // Insert the larger eligible ID first: authored ID ordering, not storage
      // insertion order, must select the resource-free candidate below.
      await world.seed('events.Change', ids.second, { ...change, source: 'original-venue-source', resource: { id: ids.resource }, state: 'adopted' }, { model: 'events.Event', id: ids.event });
      await world.seed('events.Change', ids.first, { ...change, source: 'resource-free-source' }, { model: 'events.Event', id: ids.event });
      const first = await world.arm(ids.event);
      assert.equal((await world.deliver(first)).status, 'completed');
      const load = (id: string) => world.store.load(asModel('events.Change'), asId(id));
      assert.equal((await load(ids.first))!.data.state, 'released');
      assert.equal((await load(ids.second))!.data.state, 'adopted');
      assert.equal((await load(ids.foreign))!.data.state, 'holding');
      assert.equal((await load(ids.excluded))!.data.state, 'releasing');
      assert.deepEqual(await world.store.outboxPending(), []);
      let next = await world.continuation(ids.event);
      let revision = await world.store.readRevision();
      assert.equal((await world.deliver(first)).status, 'replayed');
      assert.equal(await world.store.readRevision(), revision);
      assert.equal((await world.deliver(next)).status, 'completed');
      const selected = (await load(ids.second))!;
      assert.equal(selected.data.state, 'releasing');
      assert.equal(selected.data.release_reason, 'Original cancellation');
      assert.equal(selected.data.release_status, 'pending');
      const outbox = await world.store.outboxPending();
      assert.equal(outbox.length, 1);
      const send = outbox[0]!;
      assert.equal(send.target, 'rent_reservations.RoomsV1.release');
      assert.deepEqual(send.arguments, { binding: 'events.Rooms', from: 'deployment.rooms',
        arguments: { source: 'original-venue-source', resource: ids.resource, reason: 'Original cancellation' } });
      assert.equal(selected.data.release_delivery, send.intentId);
      const selectedDomain = await changes();
      revision = await world.store.readRevision();
      assert.equal((await world.deliver(next)).status, 'replayed');
      assert.equal(await world.store.readRevision(), revision);
      assert.deepEqual(await world.store.outboxPending(), outbox);
      next = await world.continuation(ids.event);
      assert.equal((await world.deliver(next)).status, 'completed');
      assert.deepEqual(await changes(), selectedDomain, 'exhausted continuation changes no domain rows');
      assert.deepEqual(await world.store.outboxPending(), outbox, 'exhausted continuation stages no duplicate send');
      for (const owner of owners) assert.deepEqual(await world.store.query({ model: asModel(owner.model), authority: 'owner' }), owner.rows,
        'cleanup preserves original event, program, location and venue resource');
      const beforeGuards = await changes();
      const stale = await world.arm(ids.event, '1');
      assert.equal((await world.deliver(stale)).status, 'failed');
      const originalEvent = (await world.store.load(asModel('events.Event'), asId(ids.event)))!;
      await world.store.commit(makeBatch(await world.store.readRevision(), { writes: [{ kind: 'update', model: asModel('events.Event'),
        id: originalEvent.id, expectedVersion: originalEvent.version,
        row: { ...originalEvent, version: (originalEvent.version + 1) as StoredRow['version'], data: { ...originalEvent.data, cancelled: false } } }] }));
      const active = await world.arm(ids.event);
      assert.equal((await world.deliver(active)).status, 'failed');
      assert.deepEqual(await changes(), beforeGuards);
      assert.deepEqual(await world.store.outboxPending(), outbox);
    } finally { await world.worker.dispose(); await rm(world.dir, { recursive: true, force: true }); }
  });
