import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError, selectTeam, revokeSessionByToken } from '@canlang/identity';
import type { PageDescriptor } from '@canlang/contracts';
import { handlePageRequest } from '../src/http/pages.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const privatePage: PageDescriptor = {
  owner: 'TestApp', path: '/', title: 'Private page',
  admit: async () => { throw new IdentityError('forbidden', 'Members only.'); },
  render: async () => { throw new Error('Denied page must never render.'); },
};
function handler(t: Awaited<ReturnType<typeof createTestDeps>>) {
  return (request: Request) => handlePageRequest(t.deps, request);
}

test('direct native page handler: full browser private page leads anonymous and invalid credentials to sign in', async () => {
  const t = await createTestDeps({ descriptors: [privatePage] });
  const http = handler(t);
  for (const cookie of [undefined, 'can_session=unknown-session']) {
    const response = await http(testRequest('/', { ...(cookie === undefined ? {} : { cookie }), headers: { accept: 'text/html' } }));
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/auth/login');
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('vary'), 'Accept');
  }
  await revokeSessionByToken(t.identity.store, { token: t.identity.sessionToken });
  const revoked = await http(testRequest('/', { cookie: t.identity.cookie, headers: { accept: 'text/html' } }));
  assert.equal(revoked.status, 303); assert.equal(revoked.headers.get('location'), '/auth/login');
});

test('direct native page handler: authenticated unselected browser goes to picker; selected denied member retains denial', async () => {
  const t = await createTestDeps({ descriptors: [privatePage] });
  const http = handler(t);
  const request = () => testRequest('/', { cookie: t.identity.cookie, headers: { accept: 'text/html' } });
  const unselected = await http(request());
  assert.equal(unselected.status, 303); assert.equal(unselected.headers.get('location'), '/auth/select-team');
  await selectTeam(t.identity.store, { session_token: t.identity.sessionToken, team_id: t.identity.teamId });
  const selected = await http(request());
  assert.equal(selected.status, 403); assert.equal(selected.headers.get('location'), null);
});

test('direct native page handler: default/JSON/q=0, HEAD and HX partial keep private-page 403', async () => {
  const t = await createTestDeps({ descriptors: [privatePage] });
  const http = handler(t);
  for (const init of [
    {}, { headers: { accept: 'application/json' } }, { headers: { accept: '*/*' } },
    { headers: { accept: 'text/html;q=0' } },
    { method: 'HEAD', headers: { accept: 'text/html' } },
    { headers: { accept: 'text/html', 'HX-Request': 'true' } },
  ]) {
    const response = await http(testRequest('/', init));
    assert.equal(response.status, 403); assert.equal(response.headers.get('location'), null);
  }
});

test('direct handler finishes active read-scope cleanup before recovery identity resolution', async () => {
  const t = await createTestDeps({ descriptors: [{ ...privatePage,
    admit: async () => ({}),
    render: async () => { throw new IdentityError('forbidden', 'Members only.'); },
  }] });
  const events: string[] = [];
  const findSession = t.identity.store.findSessionByTokenHash.bind(t.identity.store);
  t.identity.store.findSessionByTokenHash = async hash => { events.push('identity'); return findSession(hash); };
  const deps = { ...t.deps, createReadScope: async () => ({ query: async () => ({ rows: [], columns: [] }), close: () => { events.push('closed'); } }) };
  const response = await handlePageRequest(deps, testRequest('/', { cookie: t.identity.cookie, headers: { accept: 'text/html' } }));
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/auth/select-team');
  const closed = events.indexOf('closed'); assert.ok(closed >= 0);
  assert.ok(events.slice(closed + 1).includes('identity'));
});
