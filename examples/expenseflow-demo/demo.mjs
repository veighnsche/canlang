// B3-I5 ExpenseFlow demo: a failing create POST re-renders inline, and
// /policy renders compiler output. Verification harness, not production:
// deps come from the interfaces test doubles; L7 binds the real catalog,
// invoker and registry at integration.
//
// NOTE on provenance: this file holds no .can policy wording. Operation
// and field names are dispatch/schema facts; every policy string the
// /policy route serves arrives via expenses.policy.json (compiler output,
// byte-identical to the policy.rs golden pin). prove.mjs enforces this.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createTestDeps } from '../../packages/interfaces/dist/interfaces/src/testing.js';
import { handleOperationRequest } from '../../packages/interfaces/dist/interfaces/src/http/operations.js';
import { registerFormBinding } from '../../packages/interfaces/dist/interfaces/src/http/formErrors.js';
import { buildPresentationContext } from '../../packages/interfaces/dist/interfaces/src/http/presentation.js';
import { isPartialRequest } from '../../packages/interfaces/dist/interfaces/src/http/fragments.js';
import { buildBusinessError } from '../../packages/interfaces/dist/interfaces/src/errors/envelope.js';
import { form } from '../../packages/ui/dist/ui/src/forms.js';
import { policyPage } from '../../packages/ui/dist/ui/src/policyPage.js';
import { deriveCsrfToken } from '../../packages/identity/dist/identity/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OP = 'expenses.Expense.create';
const OP_PATH = '/api/operations/expenses.Expense.create';

function loadDump() {
  return JSON.parse(readFileSync(join(HERE, 'expenses.policy.json'), 'utf8'));
}

/** Fresh canonical UUIDv7 operation id with the time field at now. */
function freshOperationId() {
  const timeHex = Date.now().toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

/**
 * Stand-in for the L3 canonical invocation: amounts travel as integer
 * strings on the wire; non-positive values fail the row rule with a
 * field-level failure, anything else commits.
 */
function demoInvoke(envelope) {
  const amount = envelope.inputs.amount;
  if (typeof amount !== 'string' || !/^[+-]?\d+$/.test(amount)) {
    return {
      error: buildBusinessError('validation', 'Amount must be a whole-number value.', {
        fields: [{ path: '/amount', code: 'type', message: 'Amount must be a whole-number value.' }],
      }),
    };
  }
  if (BigInt(amount) <= 0n) {
    return {
      error: buildBusinessError('rule_failed', 'Amount must be greater than zero.', {
        fields: [{ path: '/amount', code: 'rule_failed', message: 'Amount must be greater than zero.' }],
      }),
    };
  }
  return {
    result: {
      status: 'committed',
      operation_id: envelope.operation_id,
      result: { created: envelope.inputs },
    },
  };
}

/** Boot the demo: deps, invoker double, and the re-render binding. */
export async function createDemo() {
  const t = await createTestDeps({
    shapes: { [OP]: { allowed: ['purpose', 'amount'], required: ['purpose', 'amount'] } },
    mutations: { [OP]: (envelope) => demoInvoke(envelope) },
  });
  registerFormBinding({
    operation: OP,
    action: OP_PATH,
    mode: 'create',
    fields: [
      { path: 'purpose', label: 'Purpose', type: 'text', required: true },
      { path: 'amount', label: 'Amount', type: 'money', required: true },
    ],
    submit: 'Save expense',
    idPrefix: 'expense-create',
    timeZone: 'UTC',
  });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const dump = loadDump();

  function contextFor(request) {
    return buildPresentationContext({
      request,
      pathname: new URL(request.url).pathname,
      isPartial: isPartialRequest(request),
      appDefaultLocale: t.deps.app.appDefaultLocale,
      csrfToken: csrf,
      principal: null,
      query: () =>
        Promise.reject(buildBusinessError('not_found', 'Row reads are out of demo scope.')),
    });
  }

  async function freshForm(request) {
    const html = await form({
      context: contextFor(request),
      action: OP_PATH,
      operation: OP,
      operationId: freshOperationId(),
      mode: 'create',
      timeZone: 'UTC',
      fields: [
        { path: 'purpose', label: 'Purpose', type: 'text', required: true },
        { path: 'amount', label: 'Amount', type: 'money', required: true },
      ],
      submit: 'Save expense',
      idPrefix: 'expense-create',
    });
    return new Response(
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>New expense</title></head>` +
        `<body><main><h1>New expense</h1>${html}</main></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }

  async function policyRoute(request) {
    const section = await policyPage({ context: contextFor(request), dump });
    return new Response(
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Policy</title></head>` +
        `<body><main>${section}</main></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }

  async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname === OP_PATH) {
      return handleOperationRequest(t.deps, request, OP);
    }
    if (url.pathname === '/policy' && request.method === 'GET') {
      return policyRoute(request);
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return freshForm(request);
    }
    return new Response('Not found.', { status: 404 });
  }

  return { handle, deps: t.deps, identity: t.identity, csrf, dump };
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const demo = await createDemo();
  const port = 4571;
  createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = `http://127.0.0.1:${port}${req.url ?? '/'}`;
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      const init = { method: req.method ?? 'GET', headers };
      if (!['GET', 'HEAD'].includes(init.method)) {
        init.body = Buffer.concat(chunks);
      }
      demo
        .handle(new Request(url, init))
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((err) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(`demo failure: ${err instanceof Error ? err.message : String(err)}`);
        });
    });
  }).listen(port, () => {
    console.log(`expense demo at http://127.0.0.1:${port}/ (policy at /policy)`);
    console.log(`POST ${OP_PATH} needs the session cookie + csrf printed below:`);
    console.log(`cookie: ${demo.identity.cookie}`);
    console.log(`x-csrf-token: ${demo.csrf}`);
  });
}
