import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, DerivedOperationInputs } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FIXED_NOW, asModel, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import {
  buildSessionCookie, createD1IdentityStore, deriveCsrfToken, ensureIdentitySchema,
  issueMcpGrant, sha256HexText,
} from '@canlang/identity';
import { catalogFromArtifactOperations, handleOperationRequest } from '@canlang/interfaces/http/operations';
import { createMcpHandler } from '@canlang/interfaces/mcp/server';
import type { HttpDeps, McpDeps } from '@canlang/interfaces';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { assembleWorker } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedContextScopes';
const MODEL = asModel(`${APP}.Trace`);
const fixturePath = resolve('packages/cloudflare/test/fixtures/typed-context-scopes.json');

test('generated context operations serve HTTP sessions and MCP grants over reopened D1', async () => {
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-context-serving-'));
  let miniflare: Miniflare | undefined;
  let now = FIXED_NOW;
  let sequence = 0;
  const clock = { nowMs: () => now };
  const operationId = () => uuidv7(now, ++sequence);
  const open = async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'typed-context-serving' }, d1Persist: join(dir, 'd1'),
    });
    const db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db);
    await ensureIdentitySchema(db);
    return { state: createD1Storage(db), identity: createD1IdentityStore(db, { clock }) };
  };
  try {
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    const catalog = catalogFromArtifactOperations(artifact);
    const derivedInputs: Record<string, DerivedOperationInputs> = {};
    for (const op of artifact.operations ?? []) {
      const derived = catalog.derivedFor(op.name);
      assert.ok(derived);
      derivedInputs[op.name] = derived;
    }
    let storage = await open();
    const team = await storage.identity.createTeam({ timezone: 'Europe/Brussels' });
    const otherTeam = await storage.identity.createTeam({ timezone: 'America/New_York' });
    const user = await storage.identity.createUser({
      email: 'context-serving@example.test', password_hash: 'unused', email_verified: true,
    });
    await storage.identity.createMembership({ team_id: team.team_id, user_id: user.user_id,
      is_owner: false, roles: [] });
    const token = 'context-serving-session';
    const session = await storage.identity.createSession({ user_id: user.user_id,
      token_sha256: await sha256HexText(token), expires_at: new Date(now + 3600_000).toISOString(),
      last_team_id: team.team_id });
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!;
    const csrf = await deriveCsrfToken(token);
    const grant = await issueMcpGrant(storage.identity, { user_id: user.user_id,
      team_id: team.team_id, client_id: 'context-serving' }, { clock });
    const assemble = () => assembleWorker(artifact, asm, {
      store: storage.state, identityStore: storage.identity, now: () => now,
      http: { derivedInputs, createOperationHandler: (deps) => (req, op) =>
        handleOperationRequest(deps as unknown as HttpDeps, req, op) },
      mcp: { derivedInputs, permissions: { canDiscover: () => true, canCall: () => true },
        createHandler: (deps) => createMcpHandler(deps as unknown as McpDeps) },
    }, { active: true });
    let worker = await assemble();
    const http = async (op: string, id: string, inputs = {}, authenticated = true) => {
      const response = await worker.fetch(new Request(`https://test.invalid/api/operations/${APP}.${op}`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(authenticated ? { cookie, 'x-csrf-token': csrf } : {}) },
        body: JSON.stringify({ operation_id: id, inputs }),
      }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const mcp = async (op: string, id: string, inputs = {}, authenticated = true,
      bearer = grant.token) => {
      const response = await worker.fetch(new Request('https://test.invalid/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(authenticated ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call',
          params: { name: `${APP}.${op}`, arguments: { operation_id: id, ...inputs } } }),
      }));
      const rpc = await response.json() as {
        [key: string]: unknown; result?: { content: Array<{ text: string }> };
      };
      return { status: response.status, body: rpc.result === undefined ? rpc :
        JSON.parse(rpc.result.content[0]!.text) as Record<string, unknown> };
    };
    const captures: Array<{ id: string; source: string; instant: number }> = [];
    for (const [source, call] of [['http', http], ['mcp', mcp]] as const) {
      const id = operationId();
      const result = await call('capture', id);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.body['status'], 'committed');
      assert.equal(result.body['result'], id);
      captures.push({ id, source, instant: now });
      const row = (await storage.state.query({ model: MODEL, authority: 'owner' }))
        .find((row) => row.data['invocation'] === id);
      assert.ok(row);
      assert.deepEqual(row.data, { who: user.user_id, scope: team.team_id, zone: team.timezone,
        origin: source, invocation: id, instant: new Date(now).toISOString(),
        callerEmail: user.email, verified: true });
      assert.equal(row.created, now);
      assert.equal(row.createdBy, user.user_id);
      const history = await storage.state.historyFor(MODEL, row.id);
      assert.equal(history[0]?.actor, user.user_id);
      assert.equal(history[0]?.operation, `${APP}.capture`);
      assert.equal(history[0]?.operationId, id);
      assert.equal((await call('identify', operationId())).body['result'], user.user_id);
      assert.equal((await call('anonymous', operationId())).body['result'], false);
      assert.equal((await call('source', operationId())).body['result'], source);
      assert.equal((await call('clock', operationId())).body['result'], new Date(now).toISOString());
      const before = await storage.state.readRevision();
      const forged = await call('capture', operationId(), { actor: { id: 'forged' },
        team: { id: otherTeam.team_id, timezone: 'UTC' }, now: '2000-01-01T00:00:00.000Z',
        operation: { id: 'forged', source: 'forged' }, email: 'forged@example.test' });
      if (source === 'http') assert.equal(forged.body['code'], 'validation', JSON.stringify(forged));
      else assert.equal((forged.body as { error?: { code: number } }).error?.code, -32602,
        JSON.stringify(forged));
      assert.equal(await storage.state.readRevision(), before);
      now += 1000;
    }
    await storage.identity.setSessionTeam(session.session_id, otherTeam.team_id);
    const beforeDenied = await storage.state.readRevision();
    assert.equal((await http('capture', operationId())).body['code'], 'forbidden');
    const wrongGrant = await issueMcpGrant(storage.identity, { user_id: user.user_id,
      team_id: otherTeam.team_id, client_id: 'context-wrong-team' }, { clock });
    const wrongMcp = await mcp('capture', operationId(), {}, true, wrongGrant.token);
    assert.equal(wrongMcp.status, 401, JSON.stringify(wrongMcp));
    assert.equal(await storage.state.readRevision(), beforeDenied);
    await storage.identity.setSessionTeam(session.session_id, team.team_id);
    // Native mutation transports require credentials even for by=public. This
    // case qualifies their refusal, not an actor-null public invocation.
    assert.equal((await http('anonymous', operationId(), {}, false)).status, 403);
    assert.equal((await mcp('anonymous', operationId(), {}, false)).status, 401);

    await miniflare!.dispose();
    miniflare = undefined;
    storage = await open();
    worker = await assemble();
    const beforeReplay = await storage.state.readRevision();
    for (const capture of captures) {
      const replay = await (capture.source === 'http' ? http : mcp)('capture', capture.id);
      assert.equal(replay.body['status'], 'replayed', JSON.stringify(replay));
      assert.equal(replay.body['result'], capture.id);
    }
    assert.equal(await storage.state.readRevision(), beforeReplay);
    assert.equal((await storage.state.query({ model: MODEL, authority: 'owner' })).length, 2);
  } finally {
    await miniflare?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
