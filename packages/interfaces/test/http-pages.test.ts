/**
 * S4 HTTP routes/pages/fragment tests (agent E): dispatch, page rendering
 * over the REAL @canlang/ui shell, discovery admission, and error mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken, IdentityError } from '@canlang/identity';
import type {
  AdmittedBindings,
  PageDescriptor,
  PresentationContext,
  ResolvedIdentity,
} from '@canlang/contracts';
import { createTestDeps, testRequest } from '../src/testing.js';
import {
  OPERATIONS_PREFIX,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  SWITCH_TEAM_PATH,
  createHttpHandler,
} from '../src/http/routes.js';
import type { HttpSubHandlers } from '../src/http/routes.js';
import { handlePageRequest } from '../src/http/pages.js';
import { fragmentErrorResponse, isPartialRequest } from '../src/http/fragments.js';
import { buildBusinessError } from '../src/errors/envelope.js';

function helloPage(overrides: Partial<PageDescriptor> = {}): PageDescriptor {
  return {
    owner: 'TestApp',
    path: '/hello',
    title: 'Hello',
    admit: async (_context: unknown) => ({}),
    render: async (_context: PresentationContext, _bindings: AdmittedBindings) => '<p>hi</p>',
    ...overrides,
  };
}

function teamPage(): PageDescriptor {
  return {
    owner: 'TestApp',
    path: '/team',
    title: 'Team',
    admit: async (context: unknown) => {
      const identity = context as ResolvedIdentity;
      if (identity.actor === null || identity.membership === null) {
        throw new IdentityError('forbidden', 'Members only.');
      }
      return {};
    },
    render: async () => '<p>team</p>',
  };
}

function itemPage(): PageDescriptor {
  return {
    owner: 'TestApp',
    path: '/items/{Item.id}',
    title: 'Item',
    admit: async (_context: unknown, routeBindings?: Record<string, unknown>) => ({ ...(routeBindings ?? {}) }),
    render: async (_context: PresentationContext, bindings: AdmittedBindings) =>
      `<p>item:${String(bindings['Item.id'] ?? '')}</p>`,
  };
}

function secretPage(): PageDescriptor {
  return {
    owner: 'TestApp',
    path: '/secret',
    title: 'Secret',
    admit: async (_context: unknown) => {
      throw new IdentityError('forbidden', 'No entry.');
    },
    render: async () => '<p>secret</p>',
  };
}

function boomPage(): PageDescriptor {
  return {
    owner: 'TestApp',
    path: '/boom',
    title: 'Boom',
    admit: async (_context: unknown) => {
      throw new Error('kaput');
    },
    render: async () => '<p>boom</p>',
  };
}

function spySub(overrides: Partial<HttpSubHandlers> = {}): HttpSubHandlers & {
  operationsCalls: Array<{ op: string }>;
  authCalls: number;
  uploadsCalls: number;
  ingressCalls: number;
  oauthCalls: number;
} {
  const operationsCalls: Array<{ op: string }> = [];
  const spy = {
    operationsCalls,
    authCalls: 0,
    uploadsCalls: 0,
    ingressCalls: 0,
    oauthCalls: 0,
    operations: async (_req: Request, op: string) => {
      operationsCalls.push({ op });
      return new Response('op!', { status: 200 });
    },
    auth: async (_req: Request) => {
      spy.authCalls += 1;
      return new Response('auth!', { status: 200 });
    },
    uploads: async (_req: Request) => {
      spy.uploadsCalls += 1;
      return new Response('up!', { status: 200 });
    },
    ingress: async (_req: Request) => {
      spy.ingressCalls += 1;
      return new Response('in!', { status: 200 });
    },
    oauth: async (_req: Request) => {
      spy.oauthCalls += 1;
      return new Response('oa!', { status: 200 });
    },
    ...overrides,
  };
  return spy;
}

async function jsonBody(res: Response): Promise<{ code?: unknown; message?: unknown }> {
  return (await res.json()) as { code?: unknown; message?: unknown };
}

test('route constants are the lane-06 canonical endpoints', () => {
  assert.equal(SIGN_IN_PATH, '/auth/login');
  assert.equal(SIGN_OUT_PATH, '/auth/logout');
  assert.equal(SWITCH_TEAM_PATH, '/auth/select-team');
  assert.equal(OPERATIONS_PREFIX, '/api/operations/');
});

test('operations POST dispatches with the decoded op name', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const sub = spySub();
  const handler = createHttpHandler(deps, sub);
  const res = await handler(testRequest('/api/operations/TeamTasks.Todo.create', { method: 'POST' }));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'op!');
  assert.deepEqual(sub.operationsCalls, [{ op: 'TeamTasks.Todo.create' }]);
});

test('operations op remainder is URI-decoded; slashes pass through', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const sub = spySub();
  const handler = createHttpHandler(deps, sub);
  const res = await handler(testRequest('/api/operations/a%20b', { method: 'POST' }));
  assert.equal(res.status, 200);
  assert.deepEqual(sub.operationsCalls, [{ op: 'a b' }]);
});

test('operations: empty op, bad encoding, and non-POST are 404', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const sub = spySub();
  const handler = createHttpHandler(deps, sub);
  for (const path of ['/api/operations/', '/api/operations/%E0%A4%A']) {
    const res = await handler(testRequest(path, { method: 'POST' }));
    assert.equal(res.status, 404);
    assert.equal((await jsonBody(res)).code, 'not_found');
  }
  const get = await handler(testRequest('/api/operations/TeamTasks.x', { method: 'GET' }));
  assert.equal(get.status, 404);
  assert.equal(sub.operationsCalls.length, 0);
});

test('/auth/* delegates to the injected auth handler', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const sub = spySub();
  const handler = createHttpHandler(deps, sub);
  const get = await handler(testRequest('/auth/login'));
  assert.equal(await get.text(), 'auth!');
  const post = await handler(testRequest('/auth/logout', { method: 'POST' }));
  assert.equal(post.status, 200);
  assert.equal(sub.authCalls, 2);
});

test('wrong method or unknown path answers not_found, never 405', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const post = await handler(testRequest('/hello', { method: 'POST' }));
  assert.equal(post.status, 404);
  assert.deepEqual(await jsonBody(post), { code: 'not_found', message: 'Not found.', retryable: false });
  const del = await handler(testRequest('/nope', { method: 'DELETE' }));
  assert.equal(del.status, 404);
  assert.equal((await jsonBody(del)).code, 'not_found');
});

test('top-level catch: business throws keep meaning, others go generic', async () => {
  const first = await createTestDeps({ descriptors: [helloPage()] });
  const denied = createHttpHandler(
    first.deps,
    spySub({ auth: async () => { throw new IdentityError('forbidden', 'Nope.'); } }),
  );
  const forbidden = await denied(testRequest('/auth/login'));
  assert.equal(forbidden.status, 403);
  assert.equal((await jsonBody(forbidden)).code, 'forbidden');
  assert.equal(first.logger.calls.filter((call) => call.level === 'error').length, 0);

  const second = await createTestDeps({ descriptors: [helloPage()] });
  const broken = createHttpHandler(
    second.deps,
    spySub({ operations: async () => { throw new Error('kaput'); } }),
  );
  const res = await broken(testRequest('/api/operations/x.y', { method: 'POST' }));
  assert.equal(res.status, 422);
  assert.equal((await jsonBody(res)).code, 'rule_failed');
  assert.equal(second.logger.calls.filter((call) => call.level === 'error').length, 1);
});

test('public GET full page renders the shell with brand and sign-in', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/hello'));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/html'));
  const html = await res.text();
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('<main id="can-main">'));
  assert.ok(html.includes('<p>hi</p>'));
  assert.ok(html.includes('Test App'));
  assert.ok(html.includes(`href="${SIGN_IN_PATH}"`));
  assert.ok(html.includes('href="/hello"'));
});

test('authed GET embeds the derived CSRF token and account teams', async () => {
  const { deps, identity } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/hello', { cookie: identity.cookie }));
  assert.equal(res.status, 200);
  const html = await res.text();
  const expected = await deriveCsrfToken(identity.sessionToken);
  assert.ok(html.includes(expected));
  assert.ok(html.includes(identity.email));
  assert.ok(html.includes(identity.teamId.slice(0, 8)));
  assert.ok(html.includes(identity.teamId));
  assert.ok(html.includes(SWITCH_TEAM_PATH));
  assert.ok(html.includes(SIGN_OUT_PATH));
});

test('?team= scoping honors the explicit team; unknown team is 404', async () => {
  const { deps, identity } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const scoped = await handler(
    testRequest(`/hello?team=${identity.teamId}`, { cookie: identity.cookie }),
  );
  assert.equal(scoped.status, 200);
  const html = await scoped.text();
  assert.ok(html.includes('aria-current="true"'));
  assert.ok(html.includes(identity.teamId.slice(0, 8)));

  const unknown = await handler(
    testRequest('/hello?team=team-missing', { cookie: identity.cookie }),
  );
  assert.equal(unknown.status, 404);
  assert.equal((await jsonBody(unknown)).code, 'not_found');
});

test('partial GET returns the fragment without the document shell', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/hello', { headers: { 'HX-Request': 'true' } }));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/html'));
  const html = await res.text();
  assert.ok(html.includes('<main id="can-main">'));
  assert.ok(html.includes('<p>hi</p>'));
  assert.ok(!html.includes('<html'));
});

test('denied page answers 403 JSON; team scope admits it', async () => {
  const publicDeps = await createTestDeps({ descriptors: [teamPage()] });
  const publicHandler = createHttpHandler(publicDeps.deps, spySub());
  const publicRes = await publicHandler(testRequest('/team'));
  assert.equal(publicRes.status, 403);
  assert.equal((await jsonBody(publicRes)).code, 'forbidden');

  const { deps, identity } = await createTestDeps({ descriptors: [teamPage()] });
  const handler = createHttpHandler(deps, spySub());
  const unscoped = await handler(testRequest('/team', { cookie: identity.cookie }));
  assert.equal(unscoped.status, 403);
  const scoped = await handler(
    testRequest(`/team?team=${identity.teamId}`, { cookie: identity.cookie }),
  );
  assert.equal(scoped.status, 200);
  assert.ok((await scoped.text()).includes('<p>team</p>'));
});

test('unknown path answers 404 JSON', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/nope'));
  assert.equal(res.status, 404);
  assert.deepEqual(await jsonBody(res), { code: 'not_found', message: 'Not found.', retryable: false });
});

test('present-but-bad cookie is forbidden, never a public downgrade', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/hello', { cookie: 'can_session=not-an-issued-token' }));
  assert.equal(res.status, 403);
  assert.equal((await jsonBody(res)).code, 'forbidden');
});

test('trailing slash redirects with a 308, preserving the query', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const plain = await handler(testRequest('/hello/'));
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.get('location'), '/hello');
  const query = await handler(testRequest('/hello/?a=b'));
  assert.equal(query.status, 308);
  assert.equal(query.headers.get('location'), '/hello?a=b');
});

test('HEAD mirrors GET headers with an empty body', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const get = await handler(testRequest('/hello'));
  const head = await handler(testRequest('/hello', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
  assert.equal(await head.text(), '');
  assert.ok((await get.text()).length > 0);
});

test('dynamic route binds the FULL token and stays out of discovery', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage(), itemPage()] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/items/inv_1'));
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('item:inv_1'));
  const encoded = await handler(testRequest('/items/a%20b'));
  assert.equal(encoded.status, 200);
  assert.ok((await encoded.text()).includes('item:a b'));

  const hello = await handler(testRequest('/hello'));
  assert.ok(!(await hello.text()).includes('/items/'));
});

test('discovery: denied hides the link, throwing marks incomplete, page stays 200', async () => {
  const { deps, logger } = await createTestDeps({
    descriptors: [helloPage(), secretPage(), boomPage()],
  });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/hello'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('/secret'));
  assert.ok(!html.includes('/boom'));
  assert.ok(html.includes('Navigation is temporarily incomplete.'));
  assert.ok(html.includes('href="/hello"'));
  assert.equal(logger.calls.filter((call) => call.level === 'error').length, 1);
});

test('unexpected admit/render throws answer the generic envelope', async () => {
  const admitDeps = await createTestDeps({ descriptors: [boomPage()] });
  const admitHandler = createHttpHandler(admitDeps.deps, spySub());
  const admitRes = await admitHandler(testRequest('/boom'));
  assert.equal(admitRes.status, 422);
  assert.equal((await jsonBody(admitRes)).code, 'rule_failed');

  const renderDeps = await createTestDeps({
    descriptors: [
      helloPage({
        render: async () => { throw new Error('render kaput'); },
      }),
    ],
  });
  const renderHandler = createHttpHandler(renderDeps.deps, spySub());
  const renderRes = await renderHandler(testRequest('/hello'));
  assert.equal(renderRes.status, 422);
  assert.equal((await jsonBody(renderRes)).code, 'rule_failed');
  const logged = JSON.stringify(renderDeps.logger.calls);
  assert.ok(logged.includes('incident'));
});

test('render overflow answers generic JSON with an error-level log', async () => {
  const { deps, logger } = await createTestDeps({
    descriptors: [
      helloPage({ render: async () => 'x'.repeat(2 * 1024 * 1024) }),
    ],
  });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/hello'));
  assert.equal(res.status, 422);
  const body = await jsonBody(res);
  assert.equal(body.code, 'rule_failed');
  assert.equal(body.message, 'The operation was rejected. Review the details and try again.');
  const errors = logger.calls.filter((call) => call.level === 'error');
  assert.equal(errors.length, 1);
});

test('error logs never carry session or CSRF secrets', async () => {
  const { deps, logger, identity } = await createTestDeps({
    descriptors: [
      helloPage({ render: async () => 'x'.repeat(2 * 1024 * 1024) }),
    ],
  });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/hello', { cookie: identity.cookie }));
  assert.equal(res.status, 422);
  const csrf = await deriveCsrfToken(identity.sessionToken);
  const logged = JSON.stringify(logger.calls);
  assert.ok(!logged.includes(identity.sessionToken));
  assert.ok(!logged.includes(identity.cookie));
  assert.ok(!logged.includes(csrf));
});

test('Accept-Language selects the page locale', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/hello', { headers: { 'Accept-Language': 'nl' } }));
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('lang="nl"'));
});

test('handlePageRequest rejects non-GET/HEAD directly', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const res = await handlePageRequest(deps, testRequest('/hello', { method: 'POST' }));
  assert.equal(res.status, 404);
  assert.equal((await jsonBody(res)).code, 'not_found');
});

test('isPartialRequest detects the HX-Request header', () => {
  assert.equal(isPartialRequest(testRequest('/hello')), false);
  assert.equal(isPartialRequest(testRequest('/hello', { headers: { 'HX-Request': 'true' } })), true);
});

test('fragmentErrorResponse keeps JSON with the canonical status', async () => {
  const res = fragmentErrorResponse(buildBusinessError('forbidden', 'No entry.'));
  assert.equal(res.status, 403);
  assert.ok(res.headers.get('content-type')?.includes('application/json'));
  assert.deepEqual(await res.json(), { code: 'forbidden', message: 'No entry.', retryable: false });
});

test('operations op remainder decodes %2F slashes too', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const sub = spySub();
  const handler = createHttpHandler(deps, sub);
  const res = await handler(testRequest('/api/operations/a%2Fb', { method: 'POST' }));
  assert.equal(res.status, 200);
  assert.deepEqual(sub.operationsCalls, [{ op: 'a/b' }]);
});

test('anonymous ?team= is ignored (no team-existence oracle)', async () => {
  const seen: Array<{ team: unknown }> = [];
  const probe = helloPage({
    admit: async (context: unknown) => {
      seen.push({ team: (context as { team: unknown }).team });
      return {};
    },
  });
  const { deps, identity } = await createTestDeps({ descriptors: [probe] });
  const handler = createHttpHandler(deps, spySub());
  // Cookie-less: known and unknown team ids both render public.
  for (const team of [identity.teamId, 'team-that-never-existed']) {
    const res = await handler(testRequest(`/hello?team=${team}`, { method: 'GET' }));
    assert.equal(res.status, 200, team);
  }
  // Page + discovery admissions all saw the public (teamless) identity.
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((entry) => entry.team === null));
});

test('undecodable cookie values resolve public (least privilege)', async () => {
  const { deps } = await createTestDeps({ descriptors: [helloPage()] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(
    testRequest('/hello', { method: 'GET', headers: { cookie: 'can_session=%E0%A4%A' } }),
  );
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('<p>hi</p>'));
});

function queryingPage(): PageDescriptor {
  return helloPage({
    path: '/todos',
    title: 'Todos',
    render: async (context: PresentationContext) => {
      const result = await context.query(context.invocation, 'TestApp.Todo', { limit: 10 });
      return `<ul>${result.rows.map((row) => `<li>${row.fields['title'] ?? ''}</li>`).join('')}</ul>`;
    },
  });
}

const TODO_LIST_RESULT = {
  rows: [{ id: 't1', fields: { title: 'Write tests' } }],
  columns: [{ field: 'title', label: 'Title', type: 'text' }],
};

test('in-render row queries use the resolved identity and defining runner', async () => {
  const seen: Array<{ identity: unknown; model: string; args: unknown }> = [];
  const { deps } = await createTestDeps({ descriptors: [queryingPage()] });
  const res = await handlePageRequest({ ...deps, query: async (identity, model, args) => {
    seen.push({ identity, model, args });
    return TODO_LIST_RESULT;
  } }, testRequest('/todos'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Write tests'));
  assert.ok(html.includes('href="/assets/browser/can-style.css"'));
  assert.ok(html.includes('src="/assets/browser/bootstrap.js"'));
  assert.equal(seen.length, 1);
  assert.equal((seen[0]?.identity as ResolvedIdentity).actor, null);
  assert.equal(seen[0]?.model, 'TestApp.Todo');
  assert.deepEqual(seen[0]?.args, { limit: 10 });
});

test('in-render read denials keep their safe meaning (not generic)', async () => {
  const { deps } = await createTestDeps({ descriptors: [queryingPage()] });
  const res = await handlePageRequest({ ...deps, query: async () => {
    throw buildBusinessError('forbidden', 'No entry.');
  } }, testRequest('/todos'));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { code: 'forbidden', message: 'No entry.', retryable: false });
});

test('in-render queries enforce collection bounds', async () => {
  const overflowing = helloPage({
    path: '/overflow',
    title: 'Overflow',
    render: async (context: PresentationContext) => {
      await context.query(context.invocation, 'TestApp.Todo', { limit: 500 });
      return '<p>unreachable</p>';
    },
  });
  const { deps } = await createTestDeps({ descriptors: [overflowing] });
  const handler = createHttpHandler(deps, spySub());
  const res = await handler(testRequest('/overflow', { method: 'GET' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { code: string }).code, 'validation');
});
