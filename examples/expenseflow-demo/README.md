# ExpenseFlow demo (B3-I5)

Proves the I5 packet end to end against `examples/ExpenseFlow.can`:

- `POST /api/operations/expenses.Expense.create` with a non-positive
  `amount` and `Accept: text/html` re-renders the form with an inline
  error and the submitted values kept (422 HTML). The same POST over
  JSON stays a bare envelope.
- `GET /policy` renders `expenses.policy.json` through `policyPage()`
  (every entry a `review()` call). The route file holds zero
  hand-written policy strings; `prove.mjs` enforces this by scanning
  the route for the `.can` policy vocabulary.

## Files

- `expenses.policy.json` — generated compiler output, byte-identical to
  the `policy::tests::golden_expenseflow_policy_dump` pin (captured
  from a test run; see `implementation/evidence/b3-i5.md`). Never edit
  by hand; refresh from `can policy` once dispatch is wired.
- `demo.mjs` — verification harness (test doubles for deps/invoker;
  L7 binds production deps at integration). Run directly to serve:
  `node examples/expenseflow-demo/demo.mjs` (port 4571; prints the
  session cookie + CSRF token the POSTs need).
- `prove.mjs` — in-process proof, no network: boots the handler and
  asserts the five behaviors above. Run:
  `node examples/expenseflow-demo/prove.mjs`

## Build first

The demo imports the built packages relatively:

```
(cd packages/ui && bun run build)
(cd packages/interfaces && bun run build)
```
