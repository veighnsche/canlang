/** Native compiler pages through the actual assembled HTTP host; isolated memory owners. */
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

test('assembled native paged HTTP collections bind once after physical owner selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-owner-page-'));
  try {
    const path = join(dir, 'OwnerPages.can');
    await writeFile(path, `app OwnerPages
Given
 Entry {name:text,state:enum(open,closed)=open}
 policy Entry read=members
When
 crud Entry by=members fields=name,state
Then
 page / title="Entries"
  require members
  list Entry columns=name empty="No entries yet."
   pagination
 page /board title="Board"
  require members
  board Entry by=state columns=name empty="No entries yet."
   pagination
`);
    const artifact = JSON.parse(execFileSync(process.env['CAN_COMPILER_BIN'] ?? resolve('compiler/target/debug/can'),
      ['compile', '--format=json', '--catalog=packages/values/dist/catalog.json', path],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const owners = await Promise.all(['cedar', 'oak'].map(async name => {
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: `${name}@page.test`, email_verified: true, password_hash: 'unused' });
      const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
      const token = `${name}-page-session`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
      return { name, team, identity: makeIdentity({ membership, team, email: user.email }),
        cookie: buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!, store: createTestMemoryStorage().store };
    }));
    const stores = new Map(owners.map(owner => [owner.team.team_id, owner.store]));
    const events: string[] = [];
    const cursors = await createPageCursorCodec(new Uint8Array(32).fill(71));
    const workerDeps: AssemblyDeps = {
      store: createTestMemoryStorage().store, identityStore: identities, now: () => FIXED_NOW,
      ownerStorage: { app: 'OwnerPages', forIdentity: async identity => {
        events.push('select');
        const store = stores.get(identity.team!.team_id); assert.ok(store); return store;
      }, forTrustedScope: async () => { throw new Error('not a background work test'); } },
      pageReads: (identity, store: StoragePort) => {
        events.push('bind'); assert.equal(store, stores.get(identity.team!.team_id));
        return { scope: { app: 'OwnerPages', ownerPackage: 'OwnerPages', owner: identity.team!.team_id },
          sourceIdentity: JSON.stringify(artifact.sources), cursors };
      },
      http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) },
    };
    const worker = await assembleWorker(artifact, asm, workerDeps, { active: true });
    const page = async (owner: typeof owners[number], href = '/', status = 200) => {
      events.length = 0;
      const url = new URL(href, 'https://page.test');
      url.searchParams.set('team', owner.team.team_id);
      const response = await worker.fetch(new Request(url, { headers: { cookie: owner.cookie } }));
      const html = await response.text(); assert.equal(response.status, status, html);
      assert.deepEqual(events, ['select', 'bind']); return html;
    };
    for (const owner of owners) assert.match(await page(owner), /No entries yet\./);
    let sequence = 0;
    for (const owner of owners) {
      const invoker = buildInvoker(artifact, asm, owner.store, { memberships: identities, now: () => FIXED_NOW });
      for (let index = 1; index <= (owner.name === 'cedar' ? 26 : 1); index++) {
        const outcome = await invoker.invokeMutation({ operation: 'OwnerPages.Entry.create',
          operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
          inputs: { name: `${owner.name} private entry ${index}` } }, owner.identity);
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
      }
    }
    const cedar = owners[0]!, oak = owners[1]!;
    const first = await page(cedar);
    assert.equal((first.match(/<li class="list-row">/g) ?? []).length, 25);
    assert.doesNotMatch(first, /oak private entry/);
    const href = /<a rel="next" href="([^"]+)"/.exec(first)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(href, 'actual first page must emit a next-page cursor link');
    const second = await page(cedar, href);
    assert.equal((second.match(/<li class="list-row">/g) ?? []).length, 1);
    assert.doesNotMatch(second, /oak private entry|rel="next"/);
    const names = (html: string) => [...html.matchAll(/cedar private entry \d+/g)].map(match => match[0]);
    assert.equal(new Set([...names(first), ...names(second)]).size, 26);
    const boardFirst = await page(cedar, '/board');
    assert.equal((boardFirst.match(/<li data-row=/g) ?? []).length, 25);
    assert.doesNotMatch(boardFirst, /oak private entry/);
    const boardHref = /<a rel="next" href="([^"]+)"/.exec(boardFirst)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(boardHref, 'paged board emits the same source-owned continuation link');
    const boardSecond = await page(cedar, boardHref);
    assert.equal((boardSecond.match(/<li data-row=/g) ?? []).length, 1);
    assert.doesNotMatch(boardSecond, /oak private entry|rel="next"/);
    assert.equal(new Set([...names(boardFirst), ...names(boardSecond)]).size, 26);
    const boardRefused = await page(oak, boardHref, 409);
    assert.equal(JSON.parse(boardRefused).code, 'conflict');
    assert.doesNotMatch(boardRefused, /cedar private entry|oak private entry/);
    const other = await page(oak);
    assert.match(other, /oak private entry 1/);
    assert.doesNotMatch(other, /cedar private entry/);
    const refused = await page(oak, href, 409);
    assert.equal(JSON.parse(refused).code, 'conflict');
    assert.doesNotMatch(refused, /cedar private entry|oak private entry/);
    const misconfigured = await assembleWorker(artifact, asm, { ...workerDeps,
      pageReads: { scope: { app: 'OwnerPages', ownerPackage: 'OwnerPages', owner: oak.team.team_id },
        sourceIdentity: JSON.stringify(artifact.sources), cursors },
    }, { active: true });
    events.length = 0;
    const denied = await misconfigured.fetch(new Request(`https://page.test/?team=${cedar.team.team_id}`,
      { headers: { cookie: cedar.cookie } }));
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { code: string }).code, 'forbidden');
    assert.deepEqual(events, [], 'static mismatch must refuse before potentially initializing an owner store');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
