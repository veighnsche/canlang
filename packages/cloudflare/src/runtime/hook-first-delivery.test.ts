import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { CompileArtifact, MutationEnvelope, StoredRow, StoragePort } from '@canlang/contracts';
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
    const source = original.replace(' Budget {source:text,approved:bool}', ' Budget {source:text,approved:bool,intervals:Interval[]}')
      .replace('crud Budget by=owner fields=source,approved', 'crud Budget by=owner fields=source,approved,intervals')
      .replace('When\n', ' contract Interval {from:datetime,until:datetime}\n invariant Budget: all(row.intervals as interval,interval.from<interval.until)\n contract Snapshot {record:Budget,approved:bool}\n event Captured {value:Snapshot}\n event Observed {source:text}\n invariant Budget: trim(row.source)!="" and count(Budget as candidate where candidate.approved in [true,false] and now==now)>=0\nWhen\n')
      .replace(/ scenario probe on=Tick[\s\S]*?Then\n/, ` scenario probe on=Tick
  do
   let before=first(Budget as row where row.source==event.source order=row.id)
   require before!=null
   set before {approved=true}
   let after=first(Budget as row where row.source==event.source and row.approved order=row.id)
   require after!=null and after.id==before.id
   emit Captured {value=Snapshot {record=before,approved=before.approved}}
   set before {approved=false}
   require event.source!="reject"
 scenario observe on=Captured each=Budget as budget
  do
   set budget {approved=event.value.approved}
   emit Observed {source=budget.source}
Then
`);
    const path = join(scratch, 'original.can');
    await writeFile(path, source);
    world = await setup(true, relative(root, path));
    const intervals = [{ from: '2026-10-19T09:00:00.000Z', until: '2026-10-19T10:00:00.000Z' }];
    const invalid = await world.invoker.invokeMutation(envelope('Budget.create', { source: 'bad-interval', approved: false,
      intervals: [{ from: intervals[0]!.until, until: intervals[0]!.from }] }), world.identity);
    assert.partialDeepStrictEqual(invalid, { error: { code: 'rule_failed', message: 'Model invariant failed.' }, receipt: 'rejected' });
    for (const source of ['allow', 'reject']) {
      const created = await world.invoker.invokeMutation(envelope('Budget.create', { source, approved: false, intervals }), world.identity);
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
      assert.equal(rows.find(row => row.data.source === source)?.data.approved, false);
      const captured = await emittedSources(world, `${APP}.Captured`);
      assert.equal(captured.length, 1, 'late authored refusal publishes no event');
      const allowed = rows.find(row => row.data.source === 'allow')!;
      assert.deepEqual(captured[0]!.source.payload, { value: { record: { id: allowed.id, version: String(allowed.version) }, approved: true } },
        'nested reference retains the reserved version while scalar payload retains its at-emit value');
    }
    const { createTeamOwnerStorageBoundary } = await import('../worker/assembly.js');
    const { createBoundCohortTick } = await import('./cohort-tick.js');
    const selected = world;
    const ownerStorage = await createTeamOwnerStorageBoundary({ artifact: world.artifact, asm: world.asm,
      app: APP, identities: world.memberships, router: { ownerScopedStoragePort: async () => selected.store } });
    const tick = await createBoundCohortTick({ artifact: world.artifact, asm: world.asm, identities: world.memberships,
      ownerStorage, scope: world.scope, now: () => selected.at });
    await tick.tick();
    const rows = await world.store.query({ model: BUDGET, authority: 'owner' });
    assert.equal(rows.find(row => row.data.source === 'allow')?.data.approved, true);
    assert.equal(rows.find(row => row.data.source === 'reject')?.data.approved, false, 'cohort membership excludes later-created rows');
    const observed = await emittedSources(world, `${APP}.Observed`);
    assert.deepEqual(observed.map(value => value.source.payload), [{ source: 'allow' }], 'real retained cohort body can emit its own later source');
    await tick.tick();
    assert.equal((await emittedSources(world, `${APP}.Observed`)).length, 1, 'retained cohort replay publishes no duplicate');
  } finally {
    if (world !== undefined) await teardown(world);
    await rm(scratch, { recursive: true, force: true });
  }
});

/** Keep declarations and handler text byte-for-byte from the draft owners.
 * Selection follows named dependencies and every selected model's existing
 * policies/invariants/locks/uniques; fixtures and unrelated derives stay out.
 */
async function originalHandlerSource(owner: string, handlerName: string, app = 'OriginalVenueCleanup') {
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
      const handler = (content.match(new RegExp(`^  scenario ${handlerName} on=[^\n]+\n(?:   [^\n]*\n|\n)*`, 'm'))?.[0] ?? '').split(/\n   examples\b/)[0]!;
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

async function originalHandlerWorld(owner = 'events', handlerName = 'venue_cleanup', app = 'OriginalVenueCleanup') {
  const original = await originalHandlerSource(owner, handlerName, app);
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
    assert.equal(typeof event, 'string', 'the original declared handler event remains compiled');
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
    const scope = { app: original.app, owner: team.team_id, ownerPackage: owner };
    const producers = await loadDispatchSystemProducers();
    const registry = producers.createSystemRegistry([...producers.l3Commands, ...WORK_SYSTEM_COMMANDS]);
    const seed = async (model: string, id: string, data: Record<string, unknown>, parent?: { model: string; id: string }) => {
      const row: StoredRow = { ...makeRow({ id, data }), parent: parent ? { model: asModel(parent.model), id: asId(parent.id) } : null };
      await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel(model), row }] }));
      return row;
    };
    let index = 0;
    const deliver = (due: import('@canlang/work/kernel/schedule-staging').DueScheduleInput, selectedStore: StoragePort = store) => invokeDueScheduleCanonical({
      asm, artifact, app: original.app, handler: original.handler, due, store: selectedStore, identities, now: () => FIXED_NOW });
    const stage = async (payload: Record<string, unknown>) => {
      const key = `original-venue-${++index}`, occurrenceId = `original-venue-occurrence-${index}`;
      await registry.run('work.schedule.put', { key, scope, at: FIXED_NOW, event,
        payload, occurrenceId },
        { actor: 'original-venue-test', now: FIXED_NOW, operation: 'test.schedule-original', operationId: uuidv7(FIXED_NOW, ++sequence) }, { store });
      return { key, scope, at: FIXED_NOW, event, occurrenceId };
    };
    const arm = (eventId: string, revision = '2') => stage({ event: { id: eventId, version: '1' }, revision, reason: 'Original cancellation' });
    const continuation = async (eventId: string) => {
      const { scheduleByKeyQuery, readScheduleRow } = await import('@canlang/work/kernel/tables');
      const rows = await store.query(scheduleByKeyQuery(scope, `${eventId}:venues`));
      const pending = rows.map(readScheduleRow).filter(row => row.state === 'pending');
      assert.equal(pending.length, 1, 'one original continuation is retained');
      const row = pending[0]!;
      assert.deepEqual(row.payload, { event: { id: eventId, version: '1' }, revision: '2', reason: 'Original cancellation' });
      return { key: row.key, scope, at: row.at, event: row.event, occurrenceId: row.occurrenceId };
    };
    return { ...original, event, dir, worker, store, identities, scope, person, seed, arm, stage, deliver, continuation, registry, asm, artifact };
  } catch (error) {
    await worker?.dispose(); await rm(dir, { recursive: true, force: true }); throw error;
  }
}

async function seedOriginalVenue(world: Awaited<ReturnType<typeof originalHandlerWorld>>) {
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
    const world = await originalHandlerWorld();
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

type OriginalHandlerWorld = Awaited<ReturnType<typeof originalHandlerWorld>>;
async function emittedSources(world: Pick<OriginalHandlerWorld, 'store'>, event: string) {
  const { WORK_OCCURRENCE_MODEL, readOccurrenceRow } = await import('@canlang/work/kernel/tables');
  const rows = await world.store.query({ model: WORK_OCCURRENCE_MODEL, authority: 'owner' });
  return rows.flatMap(row => {
    const receipt = readOccurrenceRow(row);
    if (receipt.result === null || typeof receipt.result !== 'object' || Array.isArray(receipt.result)) return [];
    const source = receipt.result as Record<string, unknown>;
    return source.kind === 'declared-event-source' && source.event === event ? [{ row, receipt, source }] : [];
  });
}

async function seedInspectionCancellation(world: OriginalHandlerWorld) {
  const ids = { site: uuidv7(FIXED_NOW, 401), asset: uuidv7(FIXED_NOW, 402), otherAsset: uuidv7(FIXED_NOW, 403),
    firstPlan: uuidv7(FIXED_NOW, 404), secondPlan: uuidv7(FIXED_NOW, 405), otherPlan: uuidv7(FIXED_NOW, 406),
    eligible: uuidv7(FIXED_NOW, 407), old: uuidv7(FIXED_NOW, 408), passed: uuidv7(FIXED_NOW, 409), cancellation: uuidv7(FIXED_NOW, 410) };
  await world.seed('rent_catalog.Location', ids.site, { name: 'Original inspection site', address: '1 Road', timezone: 'UTC',
    currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true });
  const asset = { location: { id: ids.site }, identifier: 'original-asset', name: 'Original equipment', category: 'Cooling',
    supplier: null, resource: null, serial: null, warranty: null, manual: null, inspection_epoch: '2', retired: true };
  await world.seed('maintain.Asset', ids.asset, asset);
  await world.seed('maintain.Asset', ids.otherAsset, { ...asset, identifier: 'other-asset' });
  const plan = { name: 'Original inspection plan', assignee: { id: world.person.user_id }, assignee_email: 'inspector@example.test',
    cadence_days: '7', next_due: '2026-10-19', checklist: ['Cooling works'], revision: '1', asset_epoch: '1', active: true };
  // Reverse insertion order pins the authored ID ordering across emitted occurrences.
  await world.seed('maintain.Plan', ids.secondPlan, { ...plan, name: 'Second original plan' }, { model: 'maintain.Asset', id: ids.asset });
  await world.seed('maintain.Plan', ids.firstPlan, plan, { model: 'maintain.Asset', id: ids.asset });
  await world.seed('maintain.Plan', ids.otherPlan, plan, { model: 'maintain.Asset', id: ids.otherAsset });
  const inspection = { cancelled: false, cancellation: null, cancelled_by: null, cancelled_at: null,
    reminder_email: 'inspector@example.test', reminded_at: null, occurrence: 'original-inspection', due: '2026-10-19',
    checklist: ['Cooling works'], asset_epoch: '1', template_version: '1', inspector: { id: world.person.user_id },
    answers: [], result: 'pending', evidence: null, inspected_at: null, repair: null };
  await world.seed('maintain.Inspection', ids.eligible, inspection, { model: 'maintain.Plan', id: ids.firstPlan });
  await world.seed('maintain.Inspection', ids.old, { ...inspection, occurrence: 'old-inspection', due: '2018-12-31' },
    { model: 'maintain.Plan', id: ids.firstPlan });
  await world.seed('maintain.Inspection', ids.passed, { ...inspection, occurrence: 'passed-inspection', result: 'passed',
    answers: ['Cooling works'], evidence: 'Original measured evidence', inspected_at: '2026-10-01T09:00:00.000Z' },
  { model: 'maintain.Plan', id: ids.firstPlan });
  await world.seed('maintain.Cancellation', ids.cancellation, { plan: null, through: '1', cutoff: '2019-12-31', reason: 'asset_retired',
    author: { id: world.person.user_id }, at: new Date(FIXED_NOW).toISOString(), after: null, phase: 'plans' },
  { model: 'maintain.Asset', id: ids.asset });
  return ids;
}

test('whole original inspection cancellation persists emissions atomically and advances through real retained handlers once',
  { timeout: 120_000 }, async () => {
    const world = await originalHandlerWorld('maintain', 'cancel_inspection_step', 'OriginalInspectionCancellation');
    try {
      const ids = await seedInspectionCancellation(world);
      const { WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow } = await import('@canlang/work/kernel/handler-occurrence');
      const { invokeRetainedHandlerOccurrenceCanonical } = await import('./invoke.js');
      const model = (name: string) => asModel(`maintain.${name}`);
      const load = (name: string, id: string) => world.store.load(model(name), asId(id));
      const domain = () => Promise.all(['Asset', 'Plan', 'Inspection', 'Cancellation'].map(async name => ({ name,
        rows: await world.store.query({ model: model(name), authority: 'owner' }) })));
      const initial = await world.stage({ cancellation: { id: ids.cancellation, version: '1' } });
      const before = await domain();
      let failCommit = true;
      const unavailable: StoragePort = { ...world.store, commit: async batch => {
        if (failCommit && batch.writes.some(write => write.model === 'maintain.Plan')) {
          failCommit = false; throw new Error('transient original cancellation commit outage');
        }
        return world.store.commit(batch);
      } };
      await assert.rejects(world.deliver(initial, unavailable));
      assert.deepEqual(await domain(), before, 'failed commit retains neither business changes nor published events');
      assert.deepEqual(await emittedSources(world, world.event), []);
      assert.deepEqual(await world.store.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner' }), []);
      assert.equal((await world.deliver(initial)).status, 'completed');
      assert.equal((await load('Plan', ids.firstPlan))!.data.active, false);
      assert.equal((await load('Plan', ids.secondPlan))!.data.active, true);
      let revision = await world.store.readRevision();
      assert.equal((await world.deliver(initial)).status, 'replayed');
      assert.equal(await world.store.readRevision(), revision);
      const seenSources = new Set<string>();
      for (let turn = 0; turn < 4; turn++) {
        const sources = await emittedSources(world, world.event);
        assert.equal(sources.length, turn + 1, 'each original branch publishes exactly one next event');
        const fresh = sources.filter(source => !seenSources.has(source.row.id));
        assert.equal(fresh.length, 1);
        const source = fresh[0]!;
        assert.equal(source.receipt.status, 'completed');
        assert.deepEqual(source.source.scope, world.scope);
        const payload = source.source.payload as { cancellation: { id: string; version?: string } };
        assert.deepEqual(Object.keys(payload), ['cancellation']);
        assert.equal(payload.cancellation.id, ids.cancellation);
        const routes = (await world.store.query({ model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner' }))
          .map(readHandlerOccurrenceRow).filter(route => route.sourceOccurrence === source.row.id);
        assert.equal(routes.length, 1);
        assert.equal(routes[0]!.handler, world.handler);
        assert.equal(routes[0]!.event, world.event);
        assert.deepEqual(routes[0]!.payload, payload);
        assert.deepEqual(source.source.handlers, [{ handler: world.handler, kind: 'ordinary', occurrenceId: routes[0]!.occurrenceId }]);
        const selector = { sourceOccurrence: source.row.id, handler: world.handler, event: world.event, scope: world.scope };
        const consume = () => invokeRetainedHandlerOccurrenceCanonical({ asm: world.asm, artifact: world.artifact, app: world.app,
          selector, store: world.store, identities: world.identities, now: () => FIXED_NOW });
        if (turn === 0) {
          const other = await world.identities.createTeam({ timezone: 'UTC' });
          const beforeWrongOwner = await world.store.readRevision();
          assert.partialDeepStrictEqual(await invokeRetainedHandlerOccurrenceCanonical({ asm: world.asm, artifact: world.artifact,
            app: world.app, selector: { ...selector, scope: { ...selector.scope, owner: other.team_id } },
            store: world.store, identities: world.identities, now: () => FIXED_NOW }), { status: 'refused' });
          assert.equal(await world.store.readRevision(), beforeWrongOwner);
        }
        assert.partialDeepStrictEqual(await consume(), { status: 'completed' });
        seenSources.add(source.row.id);
        revision = await world.store.readRevision();
        assert.partialDeepStrictEqual(await consume(), { status: 'replayed' });
        assert.equal(await world.store.readRevision(), revision);
      }
      assert.equal((await load('Cancellation', ids.cancellation))!.data.phase, 'complete');
      assert.equal((await load('Plan', ids.secondPlan))!.data.active, false);
      assert.equal((await load('Plan', ids.otherPlan))!.data.active, true, 'another asset stays outside the original contained query');
      const cancelled = (await load('Inspection', ids.eligible))!;
      assert.equal(cancelled.data.cancelled, true);
      assert.equal(cancelled.data.cancellation, 'Asset retired');
      assert.deepEqual(cancelled.data.cancelled_by, { id: world.person.user_id });
      assert.equal(cancelled.data.cancelled_at, new Date(FIXED_NOW).toISOString());
      assert.equal((await load('Inspection', ids.old))!.data.cancelled, false);
      const passed = (await load('Inspection', ids.passed))!;
      assert.equal(passed.data.cancelled, false);
      assert.deepEqual(passed.data.answers, ['Cooling works']);
      assert.equal(passed.data.evidence, 'Original measured evidence');
      assert.equal((await emittedSources(world, world.event)).length, 4);
      assert.deepEqual(await world.store.outboxPending(), []);
    } finally { await world.worker.dispose(); await rm(world.dir, { recursive: true, force: true }); }
  });

async function seedOriginalInvoiceSettlement(world: OriginalHandlerWorld) {
  const ids = { site: uuidv7(FIXED_NOW, 501), customer: uuidv7(FIXED_NOW, 502), invoice: uuidv7(FIXED_NOW, 503),
    draft: uuidv7(FIXED_NOW, 504), collection: uuidv7(FIXED_NOW, 505), refund: uuidv7(FIXED_NOW, 506),
    pending: uuidv7(FIXED_NOW, 507), external: uuidv7(FIXED_NOW, 508), externalRefund: uuidv7(FIXED_NOW, 509) };
  const eur = (minor: string) => ({ minor, currency: 'EUR' });
  await world.seed('rent_catalog.Location', ids.site, { name: 'Original invoice location', address: '1 Road', timezone: 'UTC',
    currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true });
  await world.seed('customer.Customer', ids.customer, { name: 'Original customer', kind: 'company', locations: [{ id: ids.site }], active: true });
  const invoice = { first_paid_at: null, attempt_limit: '3', retry_delay: '172800000', retry_until: null,
    next_collection: null, ledger_revision: '7', location: { id: ids.site }, source: 'original-invoice-source',
    issuer: 'Original operator', recipient: 'Original customer', recipient_email: 'customer@example.test',
    address: '1 Road', tax_reference: null, currency: 'EUR', description: 'Original invoice', terms: null,
    source_items: null, due: '2026-10-18', number: 'ORIGINAL-SELECTED', state: 'issued', total: eur('1000'),
    issued_at: '2026-10-01T00:00:00.000Z', consent: null, needs_review: false };
  const parent = { model: 'customer.Customer', id: ids.customer };
  await world.seed('invoice.Invoice', ids.invoice, invoice, parent);
  await world.seed('invoice.Invoice', ids.draft, { ...invoice, source: 'original-draft-source', state: 'draft', number: null, issued_at: null }, parent);
  const attempt = { mode: 'interactive', requested: '2026-10-01T00:00:00.000Z', outcome_at: null,
    provider_revision: '0', failure: null, disabled: false, reference: 'collection-receipt', amount: eur('400'),
    kind: 'collection', payment: null, status: 'succeeded', provider_reference: null, checkout: null,
    received: '2026-10-02T00:00:00.000Z', delivery: null, reason: null };
  const invoiceParent = { model: 'invoice.Invoice', id: ids.invoice };
  await world.seed('invoice.Attempt', ids.collection, attempt, invoiceParent);
  await world.seed('invoice.Attempt', ids.refund, { ...attempt, reference: 'refund-receipt', amount: eur('50'),
    kind: 'refund', payment: 'collection-receipt', reason: 'Original refund' }, invoiceParent);
  await world.seed('invoice.Attempt', ids.pending, { ...attempt, reference: 'pending-receipt', amount: eur('200'), status: 'pending', received: null }, invoiceParent);
  await world.seed('invoice.ExternalPayment', ids.external, { reference: 'bank-receipt', amount: eur('100'),
    received: '2026-10-03T00:00:00.000Z', evidence: 'Bank statement', author: { id: world.person.user_id } }, invoiceParent);
  await world.seed('invoice.ExternalRefund', ids.externalRefund, { payment: { id: ids.external }, reference: 'bank-refund', amount: eur('25'),
    received: '2026-10-04T00:00:00.000Z', evidence: 'Bank statement', reason: 'Original correction', author: { id: world.person.user_id } }, invoiceParent);
  return { ids, expected: { source: invoice.source, value: { source: invoice.source, invoice: ids.invoice, revision: '7',
    amount: eur('1000'), collected: eur('500'), refunded: eur('75'), collection_pending: true, refund_pending: false,
    state: 'issued', recorded_at: new Date(FIXED_NOW).toISOString() } } };
}

test('whole original invoice reconciliation emits its exact settlement or absence and refuses a draft without publishing',
  { timeout: 120_000 }, async () => {
    const world = await originalHandlerWorld('invoice', 'source_reconcile', 'OriginalInvoiceReconcile');
    try {
      const { expected } = await seedOriginalInvoiceSettlement(world);
      const snapshot = () => Promise.all(['invoice.Invoice', 'invoice.Attempt', 'invoice.Credit', 'invoice.ExternalPayment', 'invoice.ExternalRefund']
        .map(async name => ({ name, rows: await world.store.query({ model: asModel(name), authority: 'owner' }) })));
      const originalDomain = await snapshot();
      const event = 'invoice.ReconcileOutcome';
      for (const [source, payload] of [['missing-original-source', { source: 'missing-original-source', value: null }],
        ['original-invoice-source', expected]] as const) {
        const due = await world.stage({ source });
        const previous = (await emittedSources(world, event)).length;
        assert.equal((await world.deliver(due)).status, 'completed');
        const sources = await emittedSources(world, event);
        assert.equal(sources.length, previous + 1);
        const emitted = sources.find(entry => (entry.source.payload as { source: string }).source === source)!;
        assert.ok(emitted);
        assert.equal(emitted.receipt.status, 'completed');
        assert.deepEqual(emitted.source.payload, payload);
        assert.deepEqual(emitted.source.scope, world.scope);
        assert.deepEqual(emitted.source.handlers, [], 'no invented subscriber is attached to the original outcome');
        const revision = await world.store.readRevision();
        assert.equal((await world.deliver(due)).status, 'replayed');
        assert.equal(await world.store.readRevision(), revision);
      }
      const beforeRefusal = await emittedSources(world, event);
      const draft = await world.stage({ source: 'original-draft-source' });
      assert.equal((await world.deliver(draft)).status, 'failed');
      assert.deepEqual(await emittedSources(world, event), beforeRefusal);
      const rejectedRevision = await world.store.readRevision();
      assert.equal((await world.deliver(draft)).status, 'replayed');
      assert.equal(await world.store.readRevision(), rejectedRevision);
      assert.deepEqual(await snapshot(), originalDomain, 'all original settlement paths leave business rows unchanged');
      assert.deepEqual(await world.store.outboxPending(), []);
    } finally { await world.worker.dispose(); await rm(world.dir, { recursive: true, force: true }); }
  });
