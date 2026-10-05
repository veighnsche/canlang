// B3-I5 demo proof: bad-amount POST re-renders inline with the submitted
// values kept; JSON stays the default; /policy serves compiler output
// with zero hand-written policy strings in the route file.
//
// Run: node examples/expenseflow-demo/prove.mjs
// (build @canlang/ui + @canlang/interfaces first; see README.md)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createDemo } from './demo.mjs';
import { testRequest } from '../../packages/interfaces/dist/interfaces/src/testing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OP_PATH = '/api/operations/expenses.Expense.create';

function freshOperationId() {
  const timeHex = Date.now().toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

function post(cookie, csrf, inputs, headers = {}) {
  return testRequest(OP_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, ...headers },
    cookie,
    body: JSON.stringify({ operation_id: freshOperationId(), inputs }),
  });
}

const demo = await createDemo();
const { cookie, sessionToken } = demo.identity;
void sessionToken;

// 1. Bad amount over HTML: 422 page, inline error, submitted values kept.
{
  const res = await demo.handle(
    post(cookie, demo.csrf, { purpose: 'Team dinner', amount: '-500' }, { accept: 'text/html' }),
  );
  assert.equal(res.status, 422);
  assert.ok(res.headers.get('content-type').startsWith('text/html'));
  const html = await res.text();
  assert.ok(html.includes('Amount must be greater than zero.'), 'inline error');
  assert.ok(html.includes('aria-invalid="true"'), 'amount flagged');
  assert.ok(html.includes('value="-500"'), 'bad amount kept verbatim');
  assert.ok(html.includes('value="Team dinner"'), 'purpose kept verbatim');
  console.log('PASS bad-amount POST re-renders inline with submitted values kept');
  console.log('--- re-render tail ---');
  console.log(html.slice(html.indexOf('<main>'), html.indexOf('</main>') + 7).slice(0, 1200));
}

// 2. Same failure over JSON: bare envelope (default unchanged).
{
  const res = await demo.handle(
    post(cookie, demo.csrf, { purpose: 'Team dinner', amount: '-500' }, { accept: 'application/json' }),
  );
  assert.equal(res.status, 422);
  assert.ok(res.headers.get('content-type').startsWith('application/json'));
  const body = await res.json();
  assert.equal(body.code, 'rule_failed');
  assert.deepEqual(body.fields, [
    { path: '/amount', code: 'rule_failed', message: 'Amount must be greater than zero.' },
  ]);
  console.log('PASS same failure over JSON stays a bare envelope');
}

// 3. Good amount commits (the form is submittable after the error).
{
  const res = await demo.handle(
    post(cookie, demo.csrf, { purpose: 'Team dinner', amount: '2500' }),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'committed');
  console.log('PASS good-amount POST commits');
}

// 4. /policy renders compiler output: every marker present.
{
  const res = await demo.handle(testRequest('/policy', { method: 'GET' }));
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const marker of [
    'expenses.reviewer',
    'policy Expense read=members where=row.submitted_by==actor',
    'policy Expense read=reviewer',
    'invariant Expense: row.amount.minor&gt;0',
    'expenses.submit',
    'expenses.approve',
    'expenses.reject',
    'reporting.summarize',
    'expenses.Expense.create',
  ]) {
    assert.ok(html.includes(marker), `missing policy marker: ${marker}`);
  }
  console.log('PASS /policy renders compiler output markers');
  console.log('--- policy tail ---');
  console.log(html.slice(0, 900));
}

// 5. Zero hand-written policy strings: the route file carries none of the
// .can policy vocabulary, while the generated JSON carries all of it.
{
  const route = readFileSync(join(HERE, 'demo.mjs'), 'utf8');
  const data = readFileSync(join(HERE, 'expenses.policy.json'), 'utf8');
  const vocab = [
    'members',
    'reviewer',
    'submitted_by',
    'minor',
    'read=',
    'where=',
    'by=',
    'invariant',
    'submitted',
    'approved',
    'rejected',
    'draft',
  ];
  for (const word of vocab) {
    assert.ok(!route.includes(word), `route file leaks policy word: ${word}`);
    assert.ok(data.includes(word), `generated JSON lacks policy word: ${word}`);
  }
  console.log('PASS route file holds zero policy words; generated JSON holds all');
}

console.log('ALL DEMO PROOFS PASS');
