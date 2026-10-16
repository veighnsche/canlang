/** CAN18-v1 B20: actual emitted timeline through the real factory.
 *
 * A bound `timeline row.Movement` compiles from real `.can` source and serves
 * through the actual assembled HTTP host: source query rows drive the real
 * `timeline()` collection adapter (not a handwritten items array), preserving
 * parent scope, row order and the shared empty state. Uses the owner-page
 * assembly pattern with isolated memory owners.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { CompileArtifact, StoragePort } from '@canlang/contracts';
import { handlePageRequest, type PageHttpDeps } from '@canlang/interfaces';
import { buildSessionCookie, sha256HexText } from '@canlang/identity';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, asOperationId, makeIdentity, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assembleWorker, buildInvoker, type AssemblyDeps } from '../worker/assembly.js';
import { assembleModules } from './modules.js';
import { createPageCursorCodec } from './page-cursor.js';

test('assembled emitted timeline serves bound rows through the real factory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-timeline-serve-'));
  try {
    const path = join(dir, 'TimelineServe.can');
    await writeFile(path, `app TimelineServe
Given
 Account {title:text}
 Movement in Account {reason:text}
 policy Account read=members
 policy Movement read=members
When
 crud Account by=members fields=title
 crud Movement by=members fields=reason
Then
 page / title="Movements"
  require members
  list Account columns=title empty="No accounts yet."
   timeline row.Movement
    slot item
     text row.reason
`);
    const artifact = JSON.parse(execFileSync(process.env['CAN_COMPILER_BIN'] ?? resolve('compiler/target/debug/can'),
      ['compile', '--format=json', '--catalog=packages/values/dist/catalog.json', path],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as CompileArtifact;
    assert.ok(!('diagnostics' in artifact), 'timeline fixture emits clean');
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const owners = await Promise.all(['cedar', 'oak'].map(async name => {
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: `${name}@timeline.test`, email_verified: true, password_hash: 'unused' });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
      const token = `${name}-timeline-session`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
      return { name, team, identity: makeIdentity({ membership, team, email: user.email }),
        cookie: buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!, store: createTestMemoryStorage().store };
    }));
    const stores = new Map(owners.map(owner => [owner.team.team_id, owner.store]));
    const cursors = await createPageCursorCodec(new Uint8Array(32).fill(73));
    const workerDeps: AssemblyDeps = {
      store: createTestMemoryStorage().store, identityStore: identities, now: () => FIXED_NOW,
      ownerStorage: { app: 'TimelineServe', forIdentity: async identity => {
        const store = stores.get(identity.team!.team_id); assert.ok(store); return store;
      }, forTrustedScope: async () => { throw new Error('not a timeline work test'); } },
      pageReads: (identity, store: StoragePort) => {
        assert.equal(store, stores.get(identity.team!.team_id));
        return { scope: { app: 'TimelineServe', ownerPackage: 'TimelineServe', owner: identity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    const page = async (owner: typeof owners[number], href = '/') => {
      const url = new URL(href, 'https://timeline.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const html = await response.text(); assert.equal(response.status, 200, html);
      return html;
    };
    const cedar = owners[0]!, oak = owners[1]!;
    assert.match(await page(oak), /No accounts yet\./);
    const invoker = buildInvoker(artifact, asm, cedar.store, { memberships: identities, now: () => FIXED_NOW });
    let sequence = 0;
    const mutate = async (operation: string, inputs: Record<string, unknown>, identity = cedar.identity) => {
      const outcome = await invoker.invokeMutation({ operation: `TimelineServe.${operation}`,
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, identity);
      assert.ok('result' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.result.status, 'committed');
      return outcome.result.records![0] as { id: string; version: number };
    };
    const account = await mutate('Account.create', { title: 'Acme' });
    const parent = { id: account.id, version: String(account.version) };
    for (const reason of ['first', 'second', 'third']) {
      await mutate('Movement.create', { parent, reason });
    }
    const html = await page(cedar);
    const positions = ['first', 'second', 'third'].map(reason => {
      const index = html.indexOf(reason);
      assert.ok(index !== -1, `served timeline renders row body ${reason}`);
      return index;
    });
    assert.ok(positions[0]! < positions[1]! && positions[1]! < positions[2]!,
      'served timeline keeps admitted row order');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assembled emitted paged timeline follows its next link across pages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-timeline-page-'));
  try {
    const path = join(dir, 'TimelinePaged.can');
    await writeFile(path, `app TimelinePaged
Given
 Account {title:text}
 Movement in Account {reason:text}
 policy Account read=members
 policy Movement read=members
When
 crud Account by=members fields=title
 crud Movement by=members fields=reason
Then
 page / title="Movements"
  require members
  list Account columns=title empty="No accounts yet."
   timeline row.Movement
    slot item
     pagination
     text row.reason
`);
    const artifact = JSON.parse(execFileSync(process.env['CAN_COMPILER_BIN'] ?? resolve('compiler/target/debug/can'),
      ['compile', '--format=json', '--catalog=packages/values/dist/catalog.json', path],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as CompileArtifact;
    assert.ok(!('diagnostics' in artifact), 'paged timeline fixture emits clean');
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'pager@timeline.test', email_verified: true, password_hash: 'unused' });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const identity = makeIdentity({ membership, team, email: user.email });
    const token = 'pager-timeline-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!;
    const store = createTestMemoryStorage().store;
    const stores = new Map([[team.team_id, store]]);
    const cursors = await createPageCursorCodec(new Uint8Array(32).fill(73));
    const workerDeps: AssemblyDeps = {
      store: createTestMemoryStorage().store, identityStore: identities, now: () => FIXED_NOW,
      ownerStorage: { app: 'TimelinePaged', forIdentity: async forIdentity => {
        const resolved = stores.get(forIdentity.team!.team_id); assert.ok(resolved); return resolved;
      }, forTrustedScope: async () => { throw new Error('not a timeline work test'); } },
      pageReads: (forIdentity, forStore: StoragePort) => {
        assert.equal(forStore, stores.get(forIdentity.team!.team_id));
        return { scope: { app: 'TimelinePaged', ownerPackage: 'TimelinePaged', owner: forIdentity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    const fetchPage = async (href: string) => {
      const url = new URL(href, 'https://timeline.test');
      url.searchParams.set('team', team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie } }));
      const html = await response.text(); assert.equal(response.status, 200, html);
      return html;
    };
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => FIXED_NOW });
    let sequence = 0;
    const mutate = async (operation: string, inputs: Record<string, unknown>) => {
      const outcome = await invoker.invokeMutation({ operation: `TimelinePaged.${operation}`,
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs }, identity);
      assert.ok('result' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.result.status, 'committed');
      return outcome.result.records![0] as { id: string; version: number };
    };
    const account = await mutate('Account.create', { title: 'Acme' });
    const parent = { id: account.id, version: String(account.version) };
    const reasons = Array.from({ length: 26 }, (_, index) => `move-${String(index + 1).padStart(2, '0')}`);
    for (const reason of reasons) {
      await mutate('Movement.create', { parent, reason });
    }
    const first = await fetchPage('/');
    for (const reason of reasons.slice(0, 25)) {
      assert.ok(first.indexOf(reason) !== -1, `page one renders ${reason}`);
    }
    assert.ok(first.indexOf('move-26') === -1, 'page one holds back the final row');
    const next = first.match(/<a rel="next" href="([^"]+)">/);
    assert.ok(next?.[1], 'page one emits a followable next link');
    const second = await fetchPage(next[1]!.replace(/&amp;/g, '&'));
    assert.ok(second.indexOf('move-26') !== -1, 'page two renders the remaining row');
    assert.ok(second.indexOf('move-01') === -1, 'page two does not repeat page one');
    const tampered = new URL(next[1]!.replace(/&amp;/g, '&'), 'https://timeline.test');
    for (const key of [...tampered.searchParams.keys()]) {
      if (key !== 'team') tampered.searchParams.set(key, 'tampered-cursor');
    }
    const tamperedUrl = new URL(tampered.pathname + tampered.search, 'https://timeline.test');
    tamperedUrl.searchParams.set('team', team.team_id);
    const tamperedResponse = await worker.fetch(new Request(tamperedUrl, { headers: { cookie } }));
    assert.equal(tamperedResponse.status, 400, 'tampered cursor fails closed');
    const tamperedBody = await tamperedResponse.text();
    assert.match(tamperedBody, /Invalid collection cursor\./);
    assert.ok(tamperedBody.indexOf('move-01') === -1, 'tampered cursor discloses no rows');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
