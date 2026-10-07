/**
 * S7 OAuth: registration gates, code issuance, and collapsed exchange
 * failures — all against the memory store with a frozen clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../src/ports.js';
import type { IdentityStore } from '../src/ports.js';
import {
  createFrozenClock,
  createMemoryIdentityStore,
} from '../src/testing.js';
import { hashPassword } from '../src/accounts/passwords.js';
import { resolveIdentity } from '../src/authentication/context.js';
import {
  AUTH_CODE_TTL_MS,
  exchangeCode,
  issueAuthCode,
  registerClient,
} from '../src/authentication/oauth.js';
import { sha256HexText } from '../src/sessions/tokens.js';

const NOW = Date.parse('2026-10-04T15:00:00.000Z');
const REDIRECT = 'https://app.example/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

async function setup() {
  const clock = createFrozenClock(NOW);
  const store = createMemoryIdentityStore({ clock });
  const user = await store.createUser({
    email: 'oauth@test.example',
    password_hash: await hashPassword('s3cure-password'),
    email_verified: true,
  });
  const team = await store.createTeam({});
  await store.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
  return { clock, store, user, team };
}

function isValidation(error: unknown): boolean {
  return error instanceof IdentityError && error.code === 'validation';
}

test('register ok: defaults the name, keeps query-bearing redirect URIs', async () => {
  const { clock, store } = await setup();
  const withQuery = 'https://app.example/callback?source=mcp';
  const client = await registerClient(
    store,
    { redirect_uris: [REDIRECT, withQuery] },
    { clock },
  );
  assert.match(client.client_id, /^client_[0-9a-f]{16}$/);
  assert.equal(client.client_name, 'MCP client');
  assert.deepEqual([...client.redirect_uris], [REDIRECT, withQuery]);
  assert.equal(client.registered_at, new Date(NOW).toISOString());
  const found = await store.findOAuthClient(client.client_id);
  assert.equal(found?.client_name, 'MCP client');
});

test('register accepts loopback http and trims the client name', async () => {
  const { clock, store } = await setup();
  const client = await registerClient(
    store,
    { redirect_uris: ['http://localhost:8080/cb', 'http://127.0.0.1:3000/'], client_name: '  Desk  ' },
    { clock },
  );
  assert.equal(client.client_name, 'Desk');
});

test('register rejects non-loopback http, non-URLs, and too many URIs', async () => {
  const { clock, store } = await setup();
  await assert.rejects(
    () => registerClient(store, { redirect_uris: ['http://evil.example/cb'] }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () => registerClient(store, { redirect_uris: ['not-a-url'] }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () => registerClient(store, { redirect_uris: [] }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () =>
      registerClient(
        store,
        { redirect_uris: ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4', 'https://a.example/5', 'https://a.example/6'] },
        { clock },
      ),
    isValidation,
  );
});

test('register rejects credentialed/fragment redirect URIs and bad names', async () => {
  const { clock, store } = await setup();
  await assert.rejects(
    () => registerClient(store, { redirect_uris: ['https://user@app.example/cb'] }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () => registerClient(store, { redirect_uris: ['https://app.example/cb#frag'] }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () => registerClient(store, { redirect_uris: [REDIRECT], client_name: '   ' }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () => registerClient(store, { redirect_uris: [REDIRECT], client_name: 'n'.repeat(101) }, { clock }),
    isValidation,
  );
});

test('issue ok: 10-minute row, raw code never stored', async () => {
  const { clock, store, user, team } = await setup();
  const client = await registerClient(store, { redirect_uris: [REDIRECT] }, { clock });
  const { code, codeRecord } = await issueAuthCode(
    store,
    {
      user_id: user.user_id,
      team_id: team.team_id,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
    },
    { clock },
  );
  assert.ok(code.length > 0);
  assert.equal(codeRecord.expires_at, new Date(NOW + AUTH_CODE_TTL_MS).toISOString());
  assert.equal(codeRecord.consumed_at, null);
  // The store holds the hash, never the raw code.
  assert.notEqual(codeRecord.code_sha256, code);
  assert.equal(await store.findAuthCodeByHash(code), null);
  const row = await store.findAuthCodeByHash(await sha256HexText(code));
  assert.equal(row?.code_sha256, codeRecord.code_sha256);
});

test('issue rejects unknown client, redirect mismatch, bad challenge', async () => {
  const { clock, store, user, team } = await setup();
  const client = await registerClient(store, { redirect_uris: [REDIRECT] }, { clock });
  const base = {
    user_id: user.user_id,
    team_id: team.team_id,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
  };
  await assert.rejects(
    () => issueAuthCode(store, { ...base, client_id: 'client_missing' }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () => issueAuthCode(store, { ...base, client_id: client.client_id, redirect_uri: 'https://app.example/other' }, { clock }),
    isValidation,
  );
  // Exact match: a trailing slash is a different URI.
  await assert.rejects(
    () => issueAuthCode(store, { ...base, client_id: client.client_id, redirect_uri: `${REDIRECT}/` }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () => issueAuthCode(store, { ...base, client_id: client.client_id, code_challenge: 'short' }, { clock }),
    isValidation,
  );
  await assert.rejects(
    () => issueAuthCode(store, { ...base, client_id: client.client_id, code_challenge: `${CHALLENGE}!` }, { clock }),
    isValidation,
  );
});

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

test('exchange ok: grant resolves as an mcp_grant binding', async () => {
  const { clock, store, user, team } = await setup();
  const client = await registerClient(store, { redirect_uris: [REDIRECT] }, { clock });
  const { code } = await issueAuthCode(
    store,
    {
      user_id: user.user_id,
      team_id: team.team_id,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
    },
    { clock },
  );
  const { token, grant } = await exchangeCode(
    store,
    { code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER },
    { clock },
  );
  assert.equal(grant.client_id, client.client_id);
  const identity = await resolveIdentity(store, { mcp_grant_token: token }, { clock });
  assert.equal(identity.binding.kind, 'mcp_grant');
  assert.equal(identity.actor?.user_id, user.user_id);
  assert.equal(identity.team?.team_id, team.team_id);
});

test('exchange replay fails: codes are single-use', async () => {
  const { clock, store, user, team } = await setup();
  const client = await registerClient(store, { redirect_uris: [REDIRECT] }, { clock });
  const { code } = await issueAuthCode(
    store,
    {
      user_id: user.user_id,
      team_id: team.team_id,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
    },
    { clock },
  );
  const input = { code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER };
  await exchangeCode(store, input, { clock });
  await assert.rejects(() => exchangeCode(store, input, { clock }), (error: unknown) => {
    assert.ok(error instanceof IdentityError && error.code === 'validation');
    assert.equal(error.message, 'Invalid or expired code.');
    return true;
  });
});

test('exchange collapses expired/unknown/wrong-client/wrong-redirect/wrong-verifier', async () => {
  const { clock, store, user, team } = await setup();
  const client = await registerClient(store, { redirect_uris: [REDIRECT] }, { clock });
  const other = await registerClient(store, { redirect_uris: ['https://other.example/cb'] }, { clock });
  const issue = () =>
    issueAuthCode(
      store,
      {
        user_id: user.user_id,
        team_id: team.team_id,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
      },
      { clock },
    );
  const collapsed = (error: unknown): boolean => {
    assert.ok(error instanceof IdentityError && error.code === 'validation');
    assert.equal(error.message, 'Invalid or expired code.');
    return true;
  };

  // Unknown code.
  await assert.rejects(
    () => exchangeCode(store, { code: 'nope', client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }, { clock }),
    collapsed,
  );
  // Wrong client.
  const a = await issue();
  await assert.rejects(
    () => exchangeCode(store, { code: a.code, client_id: other.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }, { clock }),
    collapsed,
  );
  // Wrong redirect.
  const b = await issue();
  await assert.rejects(
    () => exchangeCode(store, { code: b.code, client_id: client.client_id, redirect_uri: 'https://other.example/cb', code_verifier: VERIFIER }, { clock }),
    collapsed,
  );
  // Wrong verifier.
  const c = await issue();
  await assert.rejects(
    () => exchangeCode(store, { code: c.code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: `${VERIFIER.slice(0, -1)}X` }, { clock }),
    collapsed,
  );
  // Expired.
  const d = await issue();
  clock.advance(AUTH_CODE_TTL_MS + 1);
  await assert.rejects(
    () => exchangeCode(store, { code: d.code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }, { clock }),
    collapsed,
  );
});

async function readyExchange() {
  const { clock, store, user, team } = await setup();
  const client = await registerClient(store, { redirect_uris: [REDIRECT] }, { clock });
  const { code } = await issueAuthCode(store, {
    user_id: user.user_id, team_id: team.team_id, client_id: client.client_id,
    redirect_uri: REDIRECT, code_challenge: CHALLENGE,
  }, { clock });
  return { clock, store, input: { code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER } };
}

function codeFailure(error: unknown): boolean {
  assert.ok(error instanceof IdentityError && error.code === 'validation');
  assert.equal(error.message, 'Invalid or expired code.');
  return true;
}

test('two validated memory pre-reads yield exactly one grant and one generic loser', async () => {
  const { clock, store, input } = await readyExchange();
  let preReads = 0;
  let minted = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const outcomes: string[] = [];
  const racing: IdentityStore = {
    ...store,
    async findAuthCodeByHash(hash) {
      const row = await store.findAuthCodeByHash(hash);
      assert.equal(row?.consumed_at, null);
      if (++preReads === 2) release();
      await barrier;
      return row;
    },
    async consumeAuthCode(hash) {
      const outcome = await store.consumeAuthCode(hash);
      outcomes.push(outcome);
      return outcome;
    },
    async createMcpGrant(row) { minted++; return store.createMcpGrant(row); },
  };
  const results = await Promise.allSettled([exchangeCode(racing, input, { clock }), exchangeCode(racing, input, { clock })]);
  assert.equal(preReads, 2);
  assert.equal(minted, 1);
  assert.deepEqual(outcomes.sort(), ['consumed', 'unavailable']);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = results.find((result) => result.status === 'rejected');
  assert.ok(loser?.status === 'rejected');
  codeFailure(loser.reason);
  assert.equal(await store.consumeAuthCode('missing'), 'unavailable');
  assert.equal(await store.consumeAuthCode(await sha256HexText(input.code)), 'unavailable');
});

test('legacy void and malformed consumption acknowledgments never mint', async () => {
  for (const result of [undefined, null, false, true, 0, 1, {}, ['consumed'], 'unknown', 'unavailable']) {
    const { clock, store, input } = await readyExchange();
    let minted = 0;
    const invalid = {
      ...store,
      async consumeAuthCode() { return result; },
      async createMcpGrant(row: Parameters<IdentityStore['createMcpGrant']>[0]) { minted++; return store.createMcpGrant(row); },
    } as unknown as IdentityStore;
    await assert.rejects(() => exchangeCode(invalid, input, { clock }), codeFailure);
    assert.equal(minted, 0);
  }
});

test('a stale memory pre-read cannot mint after another consumer spent the code', async () => {
  const { clock, store, input } = await readyExchange();
  let minted = 0;
  const stale: IdentityStore = {
    ...store,
    async findAuthCodeByHash(hash) {
      const row = await store.findAuthCodeByHash(hash);
      assert.equal(await store.consumeAuthCode(hash), 'consumed');
      return row;
    },
    async createMcpGrant(row) { minted++; return store.createMcpGrant(row); },
  };
  await assert.rejects(() => exchangeCode(stale, input, { clock }), codeFailure);
  assert.equal(minted, 0);
});

test('ambiguous or thrown consume and failed winner mint preserve spent code and original errors', async () => {
  for (const stage of ['ambiguous', 'consume-throw', 'mint-throw'] as const) {
    const { clock, store, input } = await readyExchange();
    const original = new Error(stage);
    let minted = 0;
    const failing = {
      ...store,
      async consumeAuthCode(hash: string) {
        assert.equal(await store.consumeAuthCode(hash), 'consumed');
        if (stage === 'consume-throw') throw original;
        return stage === 'ambiguous' ? undefined : 'consumed';
      },
      async createMcpGrant() { minted++; throw original; },
    } as unknown as IdentityStore;
    await assert.rejects(() => exchangeCode(failing, input, { clock }),
      stage === 'ambiguous' ? codeFailure : (error: unknown) => error === original);
    assert.equal(minted, stage === 'mint-throw' ? 1 : 0);
    assert.notEqual((await store.findAuthCodeByHash(await sha256HexText(input.code)))?.consumed_at, null);
    await assert.rejects(() => exchangeCode(store, input, { clock }), codeFailure);
  }
});
