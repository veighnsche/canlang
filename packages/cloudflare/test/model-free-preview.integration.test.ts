/** Model-free only: actual native artifact, installed producer, D1 and HTTP consumer. */
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { deriveCsrfToken } from '@canlang/identity';
import { distribution as valuesDistribution } from '@canlang/values/distribution';
import { prepareLocalPreviewCapture } from '../src/dev/preview-inputs.js';
import { captureIsCurrent, captureSingleFileSource } from '../src/dev/source-capture.js';
import { compileCapturedSingleFile } from '../src/dev/compiler-check.js';
import { createInstalledLocalPreviewBuilder } from '../src/dev/preview-host.js';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

it('starts a source-current native model-free preview through actual global D1 activation', async () => {
  const capture = await captureSingleFileSource(prepareLocalPreviewCapture({
    checkoutRoot: repo,
    appPath: join(repo, 'tests/integration/can-dev-server/ModelFreePreview.can'),
    compilerPath: join(repo, 'compiler/target/debug/can'),
    catalogPath: fileURLToPath(valuesDistribution.catalog),
    helpIndexPath: join(repo, 'docs/specification/CONSTRUCT-HELP.md'),
  }));
  expect(await captureIsCurrent(capture)).toBe(true);
  const compiled = await compileCapturedSingleFile(capture);
  expect(compiled.kind, JSON.stringify(compiled.kind === 'artifact' ? {} : compiled)).toBe('artifact');
  if (compiled.kind !== 'artifact') throw new Error(`native compilation failed: ${compiled.kind}`);
  expect(compiled.artifact.models ?? []).toEqual([]);
  expect(compiled.artifact.operations).toHaveLength(1);
  expect(compiled.artifact.pages).toHaveLength(1);
  expect(compiled.artifact.sources).toEqual([{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);

  // This public installed producer runs real preflight and serving DB gates;
  // readiness cannot be manufactured with a supplied activation verdict.
  const preview = await createInstalledLocalPreviewBuilder()(compiled.artifact, capture, compiled.artifactBytes);
  try {
    expect(await captureIsCurrent(capture)).toBe(true);
    const opened = preview.issueOpenUrl();
    const origin = new URL(opened).origin;
    expect(new URL(origin).hostname).toBe('127.0.0.1');
    const cookies = new Map<string, string>();
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookies.size > 0) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
      if (init.method === 'POST') headers.set('origin', origin);
      const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!;
        const index = pair.indexOf('=');
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
    expect((await fetch(origin, { redirect: 'manual' })).status).toBe(401);
    const bootstrap = await request(opened);
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get('location')).toBe('/');
    expect((await request(opened)).status).toBe(403);
    const actors = preview.issueLocalActors();
    const actor = actors.find(candidate => candidate.label === 'Ava');
    expect(actor).toBeDefined();
    const descriptor = await request('/auth/login');
    expect(descriptor.status).toBe(200);
    const loginDescriptor = await descriptor.json() as { preSessionToken: string };
    const login = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: actor!.email, password: actor!.password, _presession: loginDescriptor.preSessionToken }) });
    expect(login.status).toBe(200);
    const session = cookies.get('can_session');
    expect(session).toBeDefined();
    const teamsResponse = await request('/auth/teams');
    expect(teamsResponse.status).toBe(200);
    const teams = await teamsResponse.json() as { teams: Array<{ team_id: string }> };
    expect(teams.teams.length).toBeGreaterThan(0);
    const csrf = await deriveCsrfToken(decodeURIComponent(session!));
    const selected = await request('/auth/select-team', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ team: teams.teams[0]!.team_id, _csrf: csrf }) });
    expect(selected.status).toBe(200);
    const page = await request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Model-free preview');
    expect(html).toContain('Model-free generated page');
    expect(html).toContain('/assets/browser/bootstrap.js');
    for (const path of ['/assets/browser/bootstrap.js', '/assets/browser/can-style.css', '/assets/browser/polling.js']) {
      const asset = await request(path);
      expect(asset.status, path).toBe(200);
      expect(asset.headers.get('content-type')).toContain(path.endsWith('.css') ? 'text/css' : 'application/javascript');
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    expect(await captureIsCurrent(capture)).toBe(true);
  } finally { await preview.dispose(); }
  expect(() => preview.issueLocalActors()).toThrow(/disposal/);
}, 120000);
