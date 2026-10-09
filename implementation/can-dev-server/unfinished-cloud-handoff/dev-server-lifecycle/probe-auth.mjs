import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = '/workspace/canlang/packages/cloudflare/dist/dev/control-cli.js';

async function control(which, command, flags = []) {
  const root = `/workspace/.canlang-env/dev-server-life-${which}`;
  const binary = `${root}/compiler/target/debug/can`;
  const { stdout } = await run(binary, ['dev', command, '--root', root, ...flags], {
    env: { ...process.env, CAN_DEV_BIN: cli }, maxBuffer: 1024 * 1024,
  });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) throw new Error(`${which} ${command}: ${envelope.code}`);
  return envelope.result;
}

function cookie(response, name) {
  const item = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  if (!item) throw new Error(`cookie ${name} unavailable`);
  return item.split(';', 1)[0];
}

function operationId() {
  const time = Date.now().toString(16).padStart(12, '0');
  const bytes = randomBytes(10).toString('hex');
  const variant = ((parseInt(bytes[3], 16) & 3) | 8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${bytes.slice(0, 3)}-${variant}${bytes.slice(4, 7)}-${bytes.slice(7, 19)}`;
}

async function openAndLogin(which) {
  const opened = await control(which, 'preview.open');
  const origin = new URL(opened.url).origin;
  const actor = opened.actors.find(item => item.label === 'Ava');
  if (!actor) throw new Error(`${which}: seeded member unavailable`);
  const bootstrap = await fetch(opened.url, { redirect: 'manual' });
  if (bootstrap.status !== 303) throw new Error(`${which}: bootstrap HTTP ${bootstrap.status}`);
  const bridgeCookie = cookie(bootstrap, 'can_dev_preview');
  const descriptorResponse = await fetch(`${origin}/auth/login`, { headers: { cookie: bridgeCookie } });
  if (descriptorResponse.status !== 200) throw new Error(`${which}: login descriptor HTTP ${descriptorResponse.status}`);
  const descriptor = await descriptorResponse.json();
  const login = await fetch(`${origin}/auth/login`, {
    method: 'POST', headers: { cookie: bridgeCookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password: actor.password, _presession: descriptor.preSessionToken }),
  });
  if (login.status !== 200) throw new Error(`${which}: login HTTP ${login.status}`);
  const appCookie = cookie(login, 'can_session');
  const sessionToken = decodeURIComponent(appCookie.slice('can_session='.length));
  const csrf = createHmac('sha256', sessionToken).update('can-csrf-v1').digest('base64url');
  const headers = { cookie: `${bridgeCookie}; ${appCookie}` };
  const teamsResponse = await fetch(`${origin}/auth/teams`, { headers });
  if (teamsResponse.status !== 200) throw new Error(`${which}: teams HTTP ${teamsResponse.status}`);
  const teams = await teamsResponse.json();
  const selected = teams.teams[0]?.team_id;
  if (!selected) throw new Error(`${which}: no member team`);
  const select = await fetch(`${origin}/auth/select-team`, {
    method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ team: selected }),
  });
  if (select.status !== 200) throw new Error(`${which}: select team HTTP ${select.status}`);
  const page = await fetch(`${origin}/`, { headers });
  return { which, origin, headers, csrf, pageStatus: page.status, page: await page.text(),
    teamsCount: teams.teams.length, teamSelected: selected, servingBuild: opened.serving_build };
}

const a = await openAndLogin('a');
const b = await openAndLogin('b');
const marker = 'Cross-worktree probe';
const create = process.env.SKIP_CREATE === '1' ? null : await fetch(`${a.origin}/api/operations/OfficeSupplies.Supply.create`, {
  method: 'POST',
  headers: { ...a.headers, origin: a.origin, 'content-type': 'application/json', 'x-csrf-token': a.csrf },
  body: JSON.stringify({ operation_id: operationId(), inputs: { name: marker, quantity: '3' } }),
});
let createBody;
try { createBody = await create?.json(); } catch { createBody = null; }
const afterA = await fetch(`${a.origin}/`, { headers: a.headers });
const afterB = await fetch(`${b.origin}/`, { headers: b.headers });
const pageA = await afterA.text();
const pageB = await afterB.text();
let mcp = null;
if (process.env.PROBE_MCP === '1') {
  const inspect = async selected => {
    const grantResponse = await fetch(`${selected.origin}/mcp/grants`, {
      method: 'POST', headers: { ...selected.headers, origin: selected.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'lifecycle-probe' }),
    });
    const grantBody = await grantResponse.json();
    if (grantResponse.status !== 200 || typeof grantBody.token !== 'string') {
      return { grantStatus: grantResponse.status };
    }
    const send = async (id, method, params) => {
      const response = await fetch(`${selected.origin}/mcp`, {
        method: 'POST', headers: { ...selected.headers, origin: selected.origin, authorization: `Bearer ${grantBody.token}`,
          'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      return { status: response.status, body: await response.json() };
    };
    const listed = await send(2, 'tools/list', {});
    const read = await send(3, 'tools/call', { name: 'OfficeSupplies.Supply.read', arguments: {} });
    const readText = JSON.stringify(read.body);
    return { grantStatus: grantResponse.status, listStatus: listed.status,
      tools: listed.body.result?.tools?.map(item => item.name) ?? [],
      readStatus: read.status, readIsError: read.body.result?.isError ?? null,
      readHasMarker: readText.includes(marker), readChars: readText.length,
      readCode: read.body.error?.code ?? null };
  };
  mcp = { a: await inspect(a), b: await inspect(b) };
}
console.log(JSON.stringify({
  distinctOrigins: a.origin !== b.origin,
  a: { pageStatus: a.pageStatus, teamsCount: a.teamsCount, initialHasMarker: a.page.includes(marker),
    createStatus: create?.status ?? null, createCode: createBody?.code ?? null,
    createMessage: typeof createBody?.message === 'string' ? createBody.message.replaceAll(marker, '[redacted]') : null,
    createFields: Array.isArray(createBody?.fields) ? createBody.fields.map(item => ({ path: item.path, code: item.code })) : [],
    finalPageStatus: afterA.status,
    finalHasMarker: pageA.includes(marker),
    pageError: afterA.status === 200 ? null : pageA.slice(0, 500).replaceAll(marker, '[redacted]') },
  b: { pageStatus: b.pageStatus, teamsCount: b.teamsCount, initialHasMarker: b.page.includes(marker),
    finalPageStatus: afterB.status, finalHasMarker: pageB.includes(marker) },
  mcp,
}));
