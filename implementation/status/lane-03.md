# Lane 03: Authoritative data, policies and canonical execution

Status: active coordinator. Worktree/branch/goal recorded below; slice 1 in progress.

Owner prompt: [lane 03](../prompts/03-state.md).
Workspace: `/Users/vince/Projects/canlang-worktrees/lane-03-state` (owned worktree from
origin/main `b06d873`; cleanup owned by this coordinator after all writers/viewers release).
Branch prefix: `muse/lane-03-state/`. Current branch: `muse/lane-03-state/plan`
(first slice branch; later slices branch from refreshed origin/main in the same worktree).
Primary checkout `/Users/vince/Projects/canlang` is untouched (has its own writers).
Native goal: `goal-01a10712-7c85-7360-80d4-958e2bc46f86` (no token budget).
Session: Muse Spark 1.3 Contributor MAX coordinator; subagents share this one worktree
with disjoint exact files and run no git/worktree commands.

## Lower-level plan

### 1. Current implementation evidence (origin/main b06d873, inspected 2026-10-04)

- Normative sources: REQUIREMENTS.md (222 lines), DESIGN.md §§1–13, GRAMMAR.md,
  DECISIONS.md (incl. CRUD candidate visibility, invariant spelling, fixture journeys,
  delivery association/leaf grants, CRUD exposure). State-critical semantics:
  DESIGN §2 versions/metadata/defaults, §3 queries/authority inheritance, §4
  policies/field-leaf grants/invariants/locks, §5 CRUD/expose/when candidates/effects,
  §6 hooks/events, §7 revision fence/receipts/outbox/retention, §8.1 delivery
  observation, §11 migrations, §13 desired JS lowering (`records`, `create`, `set`,
  `deleteRecord`, `check`, `hasRole`, `delivery`, `appDefinition` metadata shapes).
- Code: `compiler/` is a Rust scaffold (`main.rs` only); `tools/can_parser.py` is a
  syntax-only prototype; 21 handwritten `.mjs` witnesses propose unimplemented
  `@canlang/stdlib` imports. No `packages/` tree, no root Node workspace, no
  `.github/workflows/` exist yet. Lanes 01–07 status files all read "awaiting human
  launch" except lane-01's worktree existing (untouched; not my source).
- Consequence: no producer contracts exist to consume. Lane 03 starts from normative
  text only, keeps every cross-lane seam behind the producer-owned contract files in
  PLAN, and ships minimal additive contracts early.

### 2. Exact desired tree within this ownership

```text
packages/contracts/src/state.ts          # L3-owned: invocation/commit/query ports,
                                         # error codes, envelope + receipt types (types only)
packages/state/                          # L3-owned: the one authoritative commit engine
  package.json                           # own manifest (name @canlang/state, internal)
  tsconfig.json                          # strict, nodenext, builds to dist/
  README.md                              # engine contract + D1/DO backend notes
  src/catalog.ts                         # versioned machine-readable entry manifest
  src/errors.ts                          # stable business error codes + safe details
  src/invocation/
    context.ts                           # principal/team/owner/operation identity, clock
    admission.ts                         # canonical admit(): by/rules/versions/receipts
    replay.ts                            # receipt lookup, input-hash compare, projection
  src/query/
    engine.ts                            # records(): grants->filter->order->project
    policy.ts                            # read-grant union incl. value-leaf paths
    aggregates.ts                        # exact count/sum/min/max/any/all/first/group
  src/policy/
    roles.ts                             # hasRole incl. declared-role subject predicates
    checks.ts                            # check() guard helper, scope=authority reports
  src/mutation/
    create.ts  update.ts  remove.ts      # CRUD paths: defaults/server/when/hooks
    effects.ts                           # set/delete/call/emit/send/schedule/cancel
    invariants.ts  locks.ts              # final-state + pre-state evaluation
    history.ts                           # automatic audit entries (accepted behavior only;
                                         # pending typed-history proposal NOT adopted)
  src/storage/
    port.ts                              # StoragePort: reads + fenced commit batch
    schema.sql                           # D1/DO-SQLite tables: revision/records/
                                         # receipts/history/outbox/schedule/work
    d1.ts                                # D1 adapter: optimistic revision-fenced batch
    durable-object.ts                    # DO-local SQLite owner transactions
  src/history/                           # (folded into src/mutation/history.ts unless
                                         #  a second module is justified by real use)
  src/migration/
    plan.ts                              # compiled-plan types consumed from L1 artifacts
    apply.ts                             # owner-local transforms under fencing + staging
  src/ports.ts                           # constrained transaction/read/system-command
                                         # ports exposed to L4/L6/L7 (registry, no raw SQL)
  test/ ...                              # colocated suites per module + miniflare D1/DO
                                         # integration suites (see §6)
packages/stdlib/                         # L3-owned thin @canlang/stdlib assembly
  package.json  src/index.ts             # re-export producer surfaces only; no wrappers,
                                         # no back-imports; version manifest of producers
.github/workflows/lane-03.yml            # L3-owned CI: typecheck, build, unit + D1/DO
                                         # integration tests for owned packages
implementation/status/lane-03.md         # this file
```

Not owned / not absorbed: auth UI, provider transports, job scheduling policy,
deployment orchestration, L7 root manifests/lock, `contracts` index assembly.

### 3. Interfaces and dependencies

Producer contracts (each type/function defined once by its owner; consumers use
test-only fixtures until merged):
- L1 `contracts/src/{artifact,diagnostic}.ts`: appDefinition/registry/page/callable
  shapes the engine consumes (models, policies, invariants, locks, CRUD, scenarios,
  hooks, migrations). NEED: minimal model/operation descriptor types by B1.
  Until then: engine-local descriptor types marked interim, replaced at the L1 join.
- L2 `contracts/src/values.ts` + `values/`: exact scalar equality, money/decimal/
  temporal semantics, wire codecs (BigInt-safe JSON), pure builtin signatures.
  NEED: value equality + canonical JSON codec by B1. Until then: minimal local
  structural equality/codec marked interim; must not become a second catalog.
- L3 -> L4/L6/L7: `StoragePort`, transaction/read/system-command ports, receipt and
  outbox/schedule staging shapes (owned here, slice 6).
- L7: root Node workspace/lock, `contracts` index assembly, workerd/D1/DO local
  runner, BDD runner invoking production admission. L3 requests: adopt
  `packages/state` + `packages/stdlib` manifests into the workspace; assemble
  `packages/contracts/{package.json,src/index.ts}` including owned `src/state.ts`.
  L3 will NOT author the contracts manifest or root lock itself.

Dependency direction (binding): contracts = types only; state uses values + ports;
work/files/identity submit registered system commands through the state fence;
UI/interfaces use canonical admission; no back-import through the public facade.

### 4. Subtasks and worker reservations (sequential slices; disjoint files per agent)

- S1 scaffold+contracts: coordinator. Files: status file, `packages/state/*`
  skeleton, `packages/contracts/src/state.ts` v0, `.github/workflows/lane-03.yml`.
- S2 fence/storage: worker A `src/storage/{port,schema.sql,d1,durable-object}.ts`;
  worker B `test/storage/*` (miniflare D1 real-batch proof). Coordinator: review+merge.
- S3 admission: worker A `src/invocation/*` + `src/errors.ts`; worker B
  `test/invocation/*`. Fixed `InvocationContext`/`ReceiptStore` ports shared by S4/S5.
- S4 query/policy: worker A `src/query/*` + `src/policy/*`; worker B `test/query/*`.
- S5 mutation: worker A `src/mutation/{create,update,remove,effects}`; worker B
  `src/mutation/{invariants,locks,history}` + `test/mutation/*`.
- S6 ports/staging: coordinator or one worker: `src/ports.ts`, outbox/schedule commit
  paths, L4/L6 registration tests.
- S7 migration: one worker: `src/migration/*` + tests (staging/validate/activate,
  `invalidate` skips, resume); join review with L7 activation contract.
- S8 stdlib: coordinator: `packages/stdlib/*` assembly + manifest; B1–B4 evidence runs.
- Review: one bounded independent read-only subagent per meaningful-semantics PR.

Consequential choices already resolved: TS source built to JS (no Can-to-TS stage);
miniflare D1/DO-SQLite as the real-API local backend (same `D1Database`/DO storage
API as production; no in-memory engine shipped as completion); memory adapter is
explicitly test-only; no cross-owner/cross-service transactions promised; provider
acceptance is never business settlement; immutable invocation clock/identity for
replay; pending typed-history proposal not adopted. Open JEV candidates (three-rewrite
process when reached): D1 schema/index shape under fence contention; cleanup-batch
resumability representation.

### 5. Reused packages and qualification

- `typescript` (pinned dev) + `node:test`/`node:assert` (no test framework to qualify).
- `miniflare` (pinned dev): local D1 (`D1Database`, incl. transactional `batch`) and
  Durable Object SQLite storage — the same API surface as production bindings.
  Qualify by asserting real rollback on batch failure and fence-conflict behavior in
  S2; record versions in evidence. No ORM, no second SQLite driver in production code.
- `wrangler` present on host (`/Users/vince/.vite-plus/bin/wrangler`) for later
  L7-coordinated workerd joins; not used to fake D1 semantics.
- Reuse rule: verify used functions under the actual (workerd-compatible) environment;
  Node-only helpers stay in build/test code, never in Worker bundles.

### 6. Test cases (each slice; real engine, no mock completion)

- S2: concurrent double-commit -> exactly one wins, loser sees fence conflict then
  retry-or-`busy`; constraint violation (unique/reference) rolls back domain +
  history + receipt + outbox + schedule staging together; DO-local multi-row
  transaction atomicity; revision never resets.
- S3: create/update/read happy flow; stale version -> `conflict`; replay same
  operation id -> identical saved outcome (projected to current access), no second
  effect; input-hash mismatch on reused id -> conflict; forged record id / wrong
  owner / expired receipt -> `not_found`/`forbidden`; revoked role mid-flight ->
  `forbidden` at fence; `operation_id` older than 24h rejected; frozen `now` stable
  across retries; `actor=null` trusted-handler attribution path.
- S4: matching policy grants union fields; non-matching rows hidden; leaf grants
  (`notification.status`) project partial objects, denied leaves withheld (never null);
  secrets never leak; default excludes archived/expired; explicit `archived=include`;
  stable `created,id` ordering; limit overflow fails (never truncates); aggregates over
  full authorized set incl. empty-domain rules (money sum needs currency); authority
  queries for policy/invariant evaluation without recursive policy filtering.
- S5: required/default/server-only fields; parent-bound defaults; CRUD `when` sees
  normalized candidate, scans see pre-write provisional state; hooks adjust-or-reject
  pre-commit; invariants on final state; locks on pre-state incl. lock-establishing
  transition; archive default vs `remove` vs `none`; references to archived blocked
  for new links, kept for history; evaluation order = written order; audit entries
  automatic with actor/time; expiry disposal blocks on any incoming reference.
  Post-admission business rejections commit fenced rejected receipts here
  (S3 landed the replay-read path only; admission rejections throw receiptless).
- S6: outbox intent + schedule replace/cancel commit atomically with domain writes;
  system-command registry rejects unregistered/raw writes; every writer (membership,
  receipt, cleanup) enters the fence.
- S7: rename/backfill/drop plan application with resume-after-failure; incompatible
  predecessor blocks; `invalidate` disposes only inventoried undispatched old work.
- B1–B4 joins: TeamTasks two-user browser+MCP denied-read/stale-update/replay;
  ExpenseFlow attachment/approval/notice journey; schema evolution with retained work;
  39-source corpus correspondence where state semantics apply.

### 7. Integration joins and PR order

PR1 (S1): scaffold + `contracts/state.ts` v0 + CI + this plan. No behavior advertised.
PR2 (S2): storage fence proof. PR3 (S3): admission. PR4 (S4): query/policy.
PR5 (S5): mutation/history. PR6 (S6): ports/staging. PR7 (S7): migrations.
PR8 (S8): stdlib assembly. Each: small commits, rebase on origin/main, focused checks,
real-diff self-review + bounded independent subagent review for semantics, squash-merge
only the reviewed head when green. B1 join with L7 runner when L7 lands; until then
all evidence is local miniflare + node suites recorded below with commands/versions.

## Progress and file reservations

- 2026-10-04: worktree created from origin/main b06d873; goal active; plan written.
  S1 merged (fb8cf1f). S2 branch `muse/lane-03-state/storage-fence` from fb8cf1f.
  S2 merged (5a271a6). S3 branch `muse/lane-03-state/admission` from 5a271a6.
  S3 implemented (delegated impl+tests, disjoint files) + independent review
  NEEDS-CHANGES (14 findings incl. receipt-before-age + revision-first
  normative orderings) + coordinator fixes, verified 125/125 locally.
  Post-review rebase onto origin/main 6980555; L6 `testing.ts`/`ports.ts`
  imports replaced by an engine-local `TestMembershipStore` double
  (`test/invocation/fixtures.ts`) so the standalone state build stays green
  until the L7 `@canlang/*` join; re-verified typecheck clean + 125/125.
  S3 merged (21dd47f, PR #23). S4 branch `muse/lane-03-state/query-policy`
  from 21dd47f. S4 implemented (delegated impl+tests, disjoint files):
  `src/policy/grants.ts` (interim grant tables, fail-fast build, pure row
  predicate eval), `src/query/engine.ts` (`queryRecords` viewer/owner
  overloads + `queryAggregate`; revision-first, unbounded scan, in-memory
  visibility/filter/sort, overflow-fails-`validation`, union projection,
  exact aggregates), contracts S4 types; 46 query tests, full suite 171/171
  locally. Coordinator self-review fixed one bug (overlapping grants across
  grants shadowed wider siblings; widest-first projection + either-order
  regression test) and reconciled one spec point (empty sum -> 0, domain
  unknowable without schema; `no currency` only for money missing currency).
  A2 seedMember hardening landed (explicit-id miss throws; no existing test
  hit it). Open: money min/max rejected (fail-closed; extension needs value
  semantics join); bigint-minor money cannot round-trip storage JSON until
  the L2 codec join; owner authority unverified at engine (gating is
  admission's); `when`-on-secret oracle question for review.
  Independent review NEEDS-CHANGES (4 major + 3 minor) all fixed +
  regressed, suite 180/180: F1 array-transparent secret carve-out; F2
  viewers project BEFORE where/sort/aggregate (cross-grant value leak
  closed); F3 unknown predicate op -> StateError validation; F4
  `when`-on-secret rejected at build; F5 same-currency money min/max
  implemented; F6 owner-aggregate test added; F7 `by` validated +
  policy AST cloned/frozen at build. Owner-authority trust boundary
  documented on queryRecords. Re-review APPROVE; its 2 non-blocking minors
  also closed + regressed (suite 182/182): empty and/or rejected (fail-open
  vacuous-true gone), predicate field paths validated to non-empty strings
  in both shape-check and per-row eval, policy clone wrapped to plain
  Error. Minors fixed per reviewer's own suggestion + coordinator
  self-review of the small diff; no third review round.
  S4 merged (471f1ed, PR #33). S5 branch `muse/lane-03-state/mutation-history`
  from 471f1ed.
  Reserved (coordinator): implementation/status/lane-03.md, PR/review/merge.
  Tree deviation: `src/storage/schema.sql` folded into `src/storage/schema.ts`
  (single SQL source embedded for workerd; avoids dual-source drift).

## Interface requests and handoffs

- To L7 (partially landed): root workspace (`packages/*`, #4) and
  `contracts/{package.json,src/index.ts}` assembly exist; `packages/state` is a
  member by glob. Still needed: root-lock adoption of state's devDeps
  (miniflare/@cloudflare/workers-types exact pins are in the nested manifest;
  nested lock follows current lane convention); state package joins the root
  `tsconfig.check.json` when L7 invites (needs extends-compatible tsconfig —
  current interim ESNext/Bundler + relative contracts import predates the
  assembly; migrate to `@canlang/contracts` import at that join).
  KNOWN CONFLICT (from contracts/index.ts, L7 handoff): `OperationId` state
  branded vs wire plain — interim pick is state's; L3 proposes keeping the
  branded state definition (narrows to string, wire-compatible) and will
  confirm with L6.
- To L1: minimal appDefinition model/operation descriptor types (B1 need;
  artifact/diagnostic contracts landed in #2 — evaluate for S3+ use).
- To L2: exact value equality + canonical JSON codec (B1 need; scaffold #8 has
  kinds/errors/catalog only — still interim in S3).
- From L3 (when S6 lands): transaction/read/system-command ports + outbox/schedule
  staging shapes for L4/L6/L7.
- From L6 (landed #6/#12, evaluated in S3): consumed identity/wire/value
  contracts as types only + structural `MembershipReader` subset. Runtime
  `testing.ts` import dropped in favor of a local double (standalone build);
  production `MembershipReader` rebind at the B1 join.

## PR and verification evidence

- PR1 S1 scaffold: branch `muse/lane-03-state/plan`, reviewed head
  `76e7b569ef58dab44eebd686d567f74ad802ea8e`, merged as `fb8cf1f`
  (https://github.com/veighnsche/canlang/pull/3, squash, --match-head-commit).
  Checks: local `npm run typecheck` + `npm test` (2/2 pass; node v24.21.0,
  typescript 5.9.3, @types/node 26.6.4); CI `state` job pass x2. Self-reviewed
  full diff; no independent subagent review (scaffold + types only, no behavior).
  Residual: engine modules in S2–S8; interim ESNext/Bundler tsconfig to L7 join.
- PR2 S2 storage: branch `muse/lane-03-state/storage-fence`, reviewed head
  `ce0f98294072534ab5d338c4965a894e8d4cbed0`, merged as `5a271a6`
  (https://github.com/veighnsche/canlang/pull/15, squash, --match-head-commit).
  Checks: local typecheck + `npm test` 60/60 x3 (miniflare 4.20260730.0,
  workers-types 5.20261004.1); contracts assembly check clean; CI `state` x2
  pass. Independent review NEEDS-CHANGES (F1–F9/N1–N4) all fixed + regressed.
  Residual: no parent linkage/expiry yet; interim contracts import/tsconfig.
- PR3 S3 admission: branch `muse/lane-03-state/admission`, reviewed head
  `14b236c27c7aeff8440712904efe3916d631efc9`, merged as `21dd47f`
  (https://github.com/veighnsche/canlang/pull/23, squash, --match-head-commit).
  Checks: local typecheck + `npm test` 125/125; CI `state`/`tools`/`workspace`
  pass. Two independent reviews: pre-rebase NEEDS-CHANGES (14 findings) all
  fixed + regressed; final-head APPROVE with 2 low advisories + 3 notes.
  Advisory disposition: A1 (receipt from CommitResult.revision) declined —
  receipt is a commit input, exact by fence construction; A2 (seedMember
  silent mint on id miss) accepted as S4 test-hardening; notes confirmed
  (dup-seed divergence moot under UNIQUE; version-on-unversioned enforced
  fail-closed by intent; trustedSource-on-user-kinds is transport-caller
  contract, one-line note due at L6 join).
  Residual: interim registry/codec; OperationId branding + age/archived
  `validation` mappings await L6 confirm; rejected-receipt writers are S5.
- PR4 S4 query/policy: branch `muse/lane-03-state/query-policy`, reviewed
  head `68a4a7be57e16ec84a2c635b3fb7baa2a004f9a9`, merged as `471f1ed`
  (https://github.com/veighnsche/canlang/pull/33, squash, --match-head-commit).
  Checks: local typecheck + `npm test` 182/182; CI `state` x2 / `tools` /
  `workspace` pass. Independent review NEEDS-CHANGES (4 major incl.
  cross-grant where/aggregate value leak + array secret carve, 3 minor) all
  fixed + regressed; re-review APPROVE; its 2 non-blocking minors also
  closed + regressed without a third round (reviewer's own suggestion +
  coordinator diff self-review).
  Residual: interim policy tables -> L1 join; interim scalar codec (bigint
  money minors, rich comparisons) -> L2 join; owner authority unverified at
  engine (trust boundary documented; gating is admission's).

## Remaining work and cleanup

Full lane scope per slices S1–S8 above. Worktree/build resources retained while this
coordinator is active; cleanup after writers/viewers release. Risks: L1/L2/L7 not yet
launched (proceeding on interim engine-local descriptors/codecs, replaced at joins);
D1 fence contention under representative load unmeasured (prototype evidence in S2,
no production-readiness claim); miniflare-vs-production D1 parity must be stated
separately from any live-provider evidence.
