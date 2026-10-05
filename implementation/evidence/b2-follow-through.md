# B2 follow-through evidence (sole-implementer sprint)

Branch: `muse/closeout/lane6-e2e`. Base: `origin/main` 8249342 (#123).
Context: Vince dissolved lane boundaries — all ex-lane-6/7 + B2 work
done here. Six workstreams, four subagents + coordinator fixes.

## F2: PresentationContext constructor (ex-lane-6)

- NEW `packages/interfaces/src/http/presentation.ts`:
  `buildPresentationContext` (request/pathname/isPartial/
  appDefaultLocale/csrfToken/principal/query); `parseAcceptLanguage`
  moved verbatim; theme DEFAULT_THEME; currencyScales absent (loud
  money-render until L2 table); CSRF option 1 (L6 mint,
  ''-when-anonymous, deny-by-default).
- `pages.ts` partial + full callsites rewired; inline literals deleted.
- Preferences preamble decision (coordinator): admit() returns
  preferences in AdmittedBindings. Emission: `const preferences=
  bindings.preferences.<App>` + admit returns
  `{preferences:{<App>:{key:default}}}` from authoring literals
  (computed defaults omitted, documented). Coordinator caught and
  fixed F2's half-landing (read side without write side would have
  crashed every prefs page).
- Proven on fresh demo.can output: admit returns
  `{preferences:{TeamTasks:{view:"all"}}}`; preamble reads it.
- Open, NOT F2: pre-session login-CSRF story (lane-6 backlog).

## e2e loader alignment (ex-lane-7)

- `tests/e2e/fixtures/artifact-loader.ts`: min_version `>= 0` (real
  canlang.builtins@0 producer cited) + member-shape validation
  mirroring the runtime loader. Handbuilt fixtures unaffected
  (`callables: []`).

## B2c: occurrence executors

- NEW `packages/cloudflare/src/runtime/executors.ts`: interim
  dispatch-row producer (`buildDispatchWrites`,
  `commitWithDispatchRows`, `withDispatchProducer`,
  `withOriginOccurrence`, `executeOccurrence`, `executeDirect`);
  originOccurrence validated (null direct, else non-empty) and
  stamped on sibling `work.dispatch` rows in the same fenced batch.
- `invoke.ts`: body moved verbatim to `invokeWith`; `invokeCallable`
  delegates unchanged; NEW `invokeCallableInOccurrence` validates
  the stamp. Signatures + error strings preserved.

## B2e: journey specs + CI

- NEW `tests/integration/b2-{delivery,d1-fence,do-local,revocation}
  .test.ts` (playback-backed: failed/unknown/skipped + retry +
  changed versions; D1 rollback/fence; DO-local; revocation) +
  `packages/testkit/src/fixtures/b2-{delivery,revocation,storage}.ts`
  + `.github/workflows/b2-join.yml` (catalog build + B2 specs,
  modeled on b1-join.yml).

## B2d: finalized-file journey

- `packages/files/src/{bridge,catalog,finalize}/`: journey seams
  incl. NEW `readFinalizedFile` (fail-closed, existence-hiding,
  ownership-checked — previously required raw-store bypass).
- NEW `packages/interfaces/src/uploads/kernel.ts` + tests.
- Interim dispatcher extended; mutations/auth stay 501.

## B2a: ExpenseFlow zero gaps

- E6006 1→0, E6008 14→0 (breadcrumbs/input/badge/alert/divider/
  join/pagination/stat/modal/query-over-value/approve-sequence).
- NEW strict `b2_expenseflow_artifact` join test (2/2 in b1_join.rs).
- Proven: exit 0, zero stderr bytes, 3 modules / 6 callables /
  2 pages / 3 suites, member paths valid, node --check clean.

## CI + review fixes (post-review commit)

- b1-gate failed on stale `"1 passed"` grep (2 join tests now) → `"2 passed"`.
- workspace/b2-gate failed: B2d's journey tests relatively imported
  interfaces SOURCE, dragging pre-existing producer strictness gaps
  into the lane-07 check. Fixed by architecture: interfaces imports
  → DIST, identity via new test-only devDependency, root `build`
  extended (identity+ui → interfaces). Verified hermetically
  (dists wiped, full CI sequence green).
- Review findings all addressed: B2 specs throw on absent producers
  (gate can't green on unsupported rows); admit write-side pinned;
  dispatch pin labeled spelling-only; mirror comment corrected.

## Gates (all observed on-branch)

- cargo: 331/331 (strict TeamTasks + ExpenseFlow joins), fmt + clippy clean.
- root vitest: 29 files / 243 tests green.
- interfaces node:test: 275/275; files node:test: 56/56.
- `tsc -p tsconfig.check.json` + `tsc -p tests/e2e/tsconfig.json`: 0 errors.
- `can compile` exit 0 on demo.can + ExpenseFlow; emitted JS node --check clean.
