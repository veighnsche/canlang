/** Actual native app-root artifact, installed preview, Identity and canonical HTTP/MCP. */
import { createHash, randomBytes } from 'node:crypto';
import { compileFunction, constants } from 'node:vm';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { deriveCsrfToken } from '@canlang/identity';
import { distribution as valuesDistribution } from '@canlang/values/distribution';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
// Use the actual installed Node closure. Transformed Vitest namespace accessors
// cannot establish the browser producer's required original own-data exports.
const nativeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as (url: string) => Promise<unknown>;

type RecordView = { id: string; version: string; data: { name: string; enabled: boolean } };
type Mutation = { status: string; records: RecordView[] };
function operationId(): string {
  const time = Date.now().toString(16).padStart(12, '0');
  const bytes = randomBytes(10).toString('hex');
  const variant = ((parseInt(bytes[3]!, 16) & 3) | 8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${bytes.slice(0, 3)}-${variant}${bytes.slice(4, 7)}-${bytes.slice(7, 19)}`;
}

it('serves one app-owned CRUD model with shared app reads and saved-outcome replay', async () => {
  const { prepareLocalPreviewCapture } = await nativeImport(new URL('../dist/runtime/native-dev.test-support.js', import.meta.url).href) as
    typeof import('../src/runtime/native-dev.test-support.js');
  const { captureIsCurrent, captureSingleFileSource } = await nativeImport(new URL('../dist/runtime/native-dev.test-support.js', import.meta.url).href) as
    typeof import('../src/runtime/native-dev.test-support.js');
  const { compileCapturedSingleFile } = await nativeImport(new URL('../dist/runtime/native-dev.test-support.js', import.meta.url).href) as
    typeof import('../src/runtime/native-dev.test-support.js');
  const { openNativePreview } = await nativeImport(new URL('../dist/runtime/native-preview.test-support.js', import.meta.url).href) as
    typeof import('../src/runtime/native-preview.test-support.js');
  const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: repo,
    appPath: join(repo, 'tests/integration/can-dev-server/AppOwnedPreview.can'),
    compilerPath: join(repo, 'compiler/target/debug/can'), catalogPath: fileURLToPath(valuesDistribution.catalog),
    helpIndexPath: join(repo, 'docs/specification/CONSTRUCT-HELP.md') }));
  expect(await captureIsCurrent(capture)).toBe(true);
  const compiled = await compileCapturedSingleFile(capture);
  expect(compiled.kind, JSON.stringify(compiled.kind === 'artifact' ? {} : compiled)).toBe('artifact');
  if (compiled.kind !== 'artifact') throw new Error(`native compilation failed: ${compiled.kind}`);
  expect(compiled.artifact.models).toHaveLength(1);
  expect(compiled.artifact.models![0]).toMatchObject({ name: 'AppOwnedPreview.Setting', scope: 'app' });
  expect(compiled.artifact.models![0]).not.toHaveProperty('parent');
  expect(compiled.artifact.sources).toEqual([{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
  const preview = await openNativePreview(compiled.artifact, capture, compiled.artifactBytes);
  try {
    const login = async (label: string) => {
      const issueOpenUrl = preview.issueOpenUrl;
      if (typeof issueOpenUrl !== 'function') throw new Error('installed preview has no protected-open producer');
      const opened = await issueOpenUrl();
      const origin = new URL(opened).origin;
      const cookies = new Map<string, string>();
      const request = async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (cookies.size) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
        if (init.method === 'POST') headers.set('origin', origin);
        const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual' });
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';', 1)[0]!; const index = pair.indexOf('=');
          cookies.set(pair.slice(0, index), pair.slice(index + 1));
        }
        return response;
      };
      expect((await fetch(origin, { redirect: 'manual' })).status).toBe(401);
      expect((await request(opened)).status).toBe(303);
      const actor = preview.issueLocalActors().find(candidate => candidate.label === label);
      expect(actor).toBeDefined();
      const descriptor = await request('/auth/login');
      expect(descriptor.status).toBe(200);
      const pre = await descriptor.json() as { preSessionToken: string };
      const authenticated = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: actor!.email, password: actor!.password, _presession: pre.preSessionToken }) });
      expect(authenticated.status).toBe(200);
      const session = cookies.get('can_session'); expect(session).toBeDefined();
      const csrf = await deriveCsrfToken(decodeURIComponent(session!));
      const discovered = await request('/auth/teams'); expect(discovered.status).toBe(200);
      const teams = await discovered.json() as { teams: Array<{ team_id: string }> };
      expect(teams.teams).toHaveLength(1);
      const team = teams.teams[0]!.team_id;
      const selected = await request('/auth/select-team', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ team, _csrf: csrf }) });
      expect(selected.status).toBe(200);
      const page = await request('/'); expect(page.status).toBe(200);
      expect(await page.text()).toContain('App-owned preview');
      const missingCsrf = await request('/mcp/grants', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'app-owned-preview-missing-csrf' }) });
      expect(missingCsrf.status).toBe(403);
      const refusedGrant = await missingCsrf.json() as { error: string; token?: unknown };
      expect(refusedGrant.error).toBe('Invalid or missing CSRF token.');
      expect(Object.hasOwn(refusedGrant, 'token')).toBe(false);
      const granted = await request('/mcp/grants', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ client_id: 'app-owned-preview-consumer' }) });
      expect(granted.status).toBe(200);
      const directGrant = await granted.json() as { token: string }; expect(typeof directGrant.token).toBe('string');
      // Actual generated Worker delivery: discovery -> consent -> public PKCE -> MCP.
      const metadata = await request('/.well-known/oauth-authorization-server');
      expect(metadata.status).toBe(200);
      const discoveredOAuth = await metadata.json() as { issuer: string; authorization_endpoint: string; token_endpoint: string };
      expect(discoveredOAuth.issuer).toBe(origin);
      expect(discoveredOAuth.authorization_endpoint).toBe(origin + '/oauth/authorize');
      expect(discoveredOAuth.token_endpoint).toBe(origin + '/oauth/token');
      const redirectUri = 'http://127.0.0.1:47183/callback';
      const registered = await request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Generated transport consumer' }) });
      expect(registered.status).toBe(201);
      const client = await registered.json() as { client_id: string };
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const consentFields = { client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge,
        code_challenge_method: 'S256', response_type: 'code', team, state: 'generated-consent-state' };
      const consentPath = '/oauth/authorize?' + new URLSearchParams(consentFields);
      const consent = await request(consentPath, { headers: { accept: 'text/html' } });
      expect(consent.status).toBe(200);
      const consentHtml = await consent.text();
      expect(consentHtml).toContain('Generated transport consumer');
      expect(consentHtml).toContain('AppOwnedPreview');
      expect(consentHtml).toContain('name="_csrf"');
      expect(consentHtml).toContain('value="' + team + '"');
      const submitConsent = (fields: Record<string, string>) => request('/oauth/authorize', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
      expect((await submitConsent(consentFields)).status).toBe(403);
      const cancelled = await submitConsent({ ...consentFields, _csrf: csrf, decision: 'deny' });
      expect(cancelled.status).toBe(302);
      const cancellation = new URL(cancelled.headers.get('location')!);
      expect(cancellation.searchParams.get('error')).toBe('access_denied');
      expect(cancellation.searchParams.has('code')).toBe(false);
      const authorized = await submitConsent({ ...consentFields, _csrf: csrf, decision: 'approve' });
      expect(authorized.status).toBe(302);
      const callback = new URL(authorized.headers.get('location')!);
      expect(callback.origin + callback.pathname).toBe(redirectUri);
      expect(callback.searchParams.get('state')).toBe(consentFields.state);
      const tokenFields = { grant_type: 'authorization_code', code: callback.searchParams.get('code')!,
        client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier };
      const exchange = () => request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(tokenFields) });
      const exchanged = await exchange(); expect(exchanged.status).toBe(200);
      const oauth = await exchanged.json() as { access_token: string; token_type: string };
      expect(oauth.token_type).toBe('Bearer'); expect(typeof oauth.access_token).toBe('string');
      expect((await exchange()).status).toBe(400);
      const invitation = await request('/auth/invite?invitation_id=00000000-0000-4000-8000-000000000000', { headers: { accept: 'text/html' } });
      expect(invitation.status).toBe(200); expect(await invitation.text()).toContain('Accept invitation');
      const grant = { token: oauth.access_token };
      const mcp = async (operation: string, args: Record<string, unknown>) => {
        const response = await request('/mcp', { method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${grant.token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: operationId(), method: 'tools/call',
            params: { name: `AppOwnedPreview.Setting.${operation}`, arguments: args } }) });
        expect(response.status).toBe(200);
        const body = await response.json() as { result: { isError?: boolean; structuredContent?: unknown }; error?: unknown };
        expect(body.error).toBeUndefined(); expect(body.result.isError).not.toBe(true);
        expect(body.result.structuredContent).toBeDefined();
        return body.result.structuredContent;
      };
      const read = async () => {
        const result = await mcp('read', {}) as { records: RecordView[] };
        expect(Array.isArray(result.records)).toBe(true); return result.records;
      };
      const http = async (operation: string, inputs: Record<string, unknown>, id = operationId()) => {
        const response = await request(`/api/operations/AppOwnedPreview.Setting.${operation}`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ operation_id: id, inputs }) });
        expect(response.status).toBe(200); return await response.json() as Mutation;
      };
      return { team, request, read, http, mcp };
    };
    const ava = await login('Ava'); const cal = await login('Cal');
    expect(ava.team).not.toBe(cal.team);
    expect(await ava.read()).toEqual([]); expect(await cal.read()).toEqual([]);
    const createId = operationId();
    const created = await ava.http('create', { name: 'Shared app setting' }, createId);
    expect(created.status).toBe('committed'); expect(created.records).toHaveLength(1);
    const first = created.records[0]!;
    expect(first.data).toEqual({ name: 'Shared app setting', enabled: true });
    const replay = await ava.http('create', { name: 'Shared app setting' }, createId);
    expect(replay.status).toBe('replayed'); expect(replay.records).toEqual(created.records);
    expect(await ava.read()).toEqual(created.records); expect(await cal.read()).toEqual(created.records);
    const edited = await cal.mcp('update', { operation_id: operationId(), record: { id: first.id, version: String(first.version) },
      name: 'Changed app setting', enabled: false }) as Mutation;
    expect(edited.status).toBe('committed'); expect(edited.records).toHaveLength(1);
    expect(edited.records[0]!.data).toEqual({ name: 'Changed app setting', enabled: false });
    expect(await ava.read()).toEqual(edited.records); expect(await cal.read()).toEqual(edited.records);
    const reloaded = await ava.request('/'); expect(reloaded.status).toBe(200);
    expect(await reloaded.text()).toContain('Changed app setting');
    const changed = edited.records[0]!;
    const removed = await ava.http('delete', { record: { id: changed.id, version: String(changed.version) } });
    expect(removed.status).toBe('committed');
    expect(await ava.read()).toEqual([]); expect(await cal.read()).toEqual([]);
    const empty = await cal.request('/'); expect(empty.status).toBe(200);
    expect(await empty.text()).toContain('No app settings');
    expect(await captureIsCurrent(capture)).toBe(true);
  } finally { await preview.dispose(); }
  expect(() => preview.issueLocalActors()).toThrow(/disposal/);
}, 120000);
