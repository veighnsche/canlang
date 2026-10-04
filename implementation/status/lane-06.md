# Lane 06: Identity, HTTP and MCP interfaces

Status: active. Coordinator: Muse Spark 1.3 Contributor MAX session
01a10712-85a8-7e21-90c6-0241c81dd79a.
Worktree: /Users/vince/Projects/canlang-worktrees/lane-06-identity-interfaces
(branch muse/lane-06-identity-interfaces/plan, from origin/main b06d873).
Native goal: goal-01a10712-dbc4-7652-bec1-0d9ef6c27cc5. Cleanup: coordinator
removes this worktree only after all writers/viewers release it; primary
checkout /Users/vince/Projects/canlang is never reset or edited.

Owner prompt: [lane 06](../prompts/06-identity-interfaces.md).

## Current implementation evidence (from origin/main b06d873)

- No packages/ tree, no root package.json/tsconfig, no .github/workflows.
  Rust CLI scaffold (compiler/src/main.rs), Python syntax prototype, 39 draft
  sources, 2 reference examples (TeamTasks, ExpenseFlow). No producer
  contract has merged; all other lane status files read "awaiting human
  launch" and no PRs exist. Main branch is NOT protected (checked 2026-10-04).
- Normative inputs read: PLAN/WORKFLOW/CONTRACTS/DIAGNOSTICS, AGENTS.md,
  REQUIREMENTS §§Runtime/MCP/shell, DESIGN §§4,5,5.1,6,7,8(v1 upload
  bridge),9(admission),10(MCP),11.3(action handles), GRAMMAR upload/route
  notes, DECISIONS current-status + auth audit entries 65-73 (historical;
  DESIGN §4 is the adopted rule).
- Settled lane-06 rules distilled from those sources:
  - Default `auth email password` (verified-email registration, sign-in/out,
    expiring email-token recovery, sessions, MCP authorization) and default
    `teams` (owner-managed membership, expiring verified-email invitations,
    roles, team selection, team timezone UTC default) need no source lines.
    Deployment provisions the first owner. No app-authored login/role tables.
  - Actor predicates: members/owner/declared-role/authenticated/public;
    last-owner removal/demotion rejected; invitation acceptance verifies the
    addressed email and cannot exceed the stored role; completed removal
    prevents new admissions while an admitted op may finish.
  - actor.email / actor.email_verified are read-only admission facts for the
    authenticated caller only; nothing else exposes them.
  - Mutation envelope: stable UUIDv7 operation_id + expected versions;
    receipt identity = app, owner/team, principal, FQ operation, id; receipt
    check precedes version/default/business evaluation; replay returns the
    saved outcome projected against current access. Identities >24h old
    rejected, 5min future tolerance; receipts kept >=7 days.
  - Business error codes: validation, forbidden, not_found, conflict,
    rule_failed, busy, limit, delivery_unknown. Existence-hiding lookups
    return not_found. Guard failures are generic; no confidential disclosure.
  - MCP: one Streamable HTTP /mcp server per selected app; registry-owned
    tools package.Model.read/list/create/update/delete + package.scenario;
    owner-authorized system.team.invite/.remove/.role tools; login/recovery/
    session/OAuth/trusted handlers never tools. OAuth consent binds one app
    user + one team; permissions rechecked per discovery and call. Closed
    typed JSON schemas; int/decimal as canonical decimal strings (incl.
    money.minor, record.version); datetimes RFC3339 UTC; files are completed
    opaque IDs; mutations carry operation_id; unknown args fail. Mutations
    return {status,operation_id,records,deliveries,result}.
  - Upload bridge v1 (§8): POST /files/intents
    {upload_id,operation,field,arguments,name,type,size} ->
    {intent_id,content,finalize,expires_at}; PUT bytes to content; POST
    finalize -> {file}. fileTransfer _meta {version:1,intents}; schema
    format:"can-file". Unsupported hosts offer browser handoff or report
    cannot-supply; never silent omit or false success.
  - HTTP: one page per normalized route shape; page GET side-effect-free;
    team routes need selected team; public record routes resolve team from
    record. Canonical POST uses current CSRF. Collections default 25/max 100
    with opaque cursors; page max 500 records + 1MiB. HTMX error statuses
    must explicitly swap validation/error fragments.
  - Provider-event ingress authentication delegates typed verification to
    lane 4; no raw request manufactures trusted handler context.

## Exact desired tree within ownership

```text
packages/contracts/src/identity.ts      # L6: principal/session/team/membership/auth facts
packages/contracts/src/wire.ts          # L6: operation envelope, errors, uploads, MCP/action transport
packages/identity/
  package.json, tsconfig.json
  src/index.ts                          # public assembly (accounts/sessions/teams/authentication)
  src/accounts/{passwords,recovery,registration}.ts
  src/sessions/{tokens,cookies,csrf}.ts
  src/teams/{membership,invitations,roles,selection}.ts
  src/authentication/{context,revocation,audience}.ts
  src/ports.ts                          # storage/system-command ports (L3 binds D1; test double here)
  src/testing.ts                        # test-only in-memory fenced store + fixtures (never production)
  test/*.test.ts + fixtures/*.json      # two-user/team + revoked-session examples
packages/interfaces/
  package.json, tsconfig.json
  src/index.ts
  src/http/{routes,pages,operations,fragments,limits}.ts
  src/mcp/{server,tools,schemas,discovery,authorization}.ts
  src/uploads/{intents,content,finalize,bridge}.ts
  src/errors/{envelope,safe,redact,logging}.ts
  src/ports.ts                          # registry/invoker/renderer/finalizer/verifier ports
  src/testing.ts                        # test-only doubles
  test/*.test.ts + fixtures/*.json
.github/workflows/lane-06.yml           # install/build/test owned packages only
implementation/status/lane-06.md        # this file
```

Not owned, never written here: packages/contracts/{package.json,src/index.ts,
other src} (L7 assembly + other producers), root manifests/locks/tsconfig
(L7), compiler/, editors/, draft/, examples/, other lanes' packages/status.

## Interfaces and dependencies

Consumes (ports defined by producers; until merged, lane-06 defines minimal
consumer-side port types in its own ports.ts and marks them for replacement):
- L3 invocation/commit: operation admission + canonical invocation callable;
  D1-fenced membership/session tables (identity store port). Needed by B1.
- L2 values/wire: canonical decimal/RFC3339/opaque-id codecs + schema
  catalog entries. Needed for wire codecs; minimal local closed-JSON copy
  only as explicitly test-marked fixture until L2 lands.
- L1 artifact/registry: appDefinition, callable operation registry, page
  descriptors + admission callables, source revision. Needed by B1.
- L5 presentation: fragment/page render callables, form schemas. Needed by B1.
- L4 files/services: upload finalization/provenance, provider-event typed
  verification, delivery observation. Needed by B1/B2.
- L7 platform: root workspace/lock/tsconfig.base, @canlang/contracts
  manifest+index, workerd/D1 local runner, BDD testkit. Root/contract
  assembly needed as soon as any slice is ready to integrate; runner by B1.

Provides: identity.ts/wire.ts contracts (slice 1); @canlang/identity
(authenticated context constructor — the single verified identity entry both
transports use); @canlang/interfaces (HTTP/MCP/upload dispatch). L3 admission,
L5 forms, L7 host consume these.

## Reuse and qualification decisions

- Cryptography: WebCrypto SubtleCrypto only (digest SHA-256, HMAC, PBKDF2 for
  password hashing with OWASP-2023 iteration count, getRandomValues for
  tokens). Rationale: identical API in Node 24 and workerd; no Node-only
  scrypt/argon2 dependency. Password hashes: PBKDF2-HMAC-SHA-256, per-user
  16-byte salt, 600k iterations, modular text encoding with version tag.
  Sessions: opaque 256-bit tokens, SHA-256 hash at rest, constant-time
  compare; bearer only over Secure/HttpOnly/SameSite cookies (browser) or
  app-audience MCP authorization (MCP bridge). No custom primitives.
- MCP: official @modelcontextprotocol/sdk, Streamable HTTP transport only.
  Qualification spike in slice 5 must prove the used transport path runs
  under workerd (no Node http/net); if the SDK server transport needs Node,
  implement the narrow Streamable HTTP endpoint against the MCP spec using
  the SDK's protocol/types only, and record the exact gap. Importability
  alone is not qualification.
- Email delivery for verification/recovery/invitation: capability call
  through the L4-bound mail adapter port (std.EmailV1 shape); tests use a
  test-only outbox double. No direct SMTP/fetch in identity code.
- Test stack B0: typescript (tsc) + node:test + node:assert, package-local
  tsconfig (strict, nodenext, es2022), no test framework dependency.
  workerd/vitest qualification arrives with the L7 runner at B1.
- No JEV consultation opened yet: session/CSRF/hash choices above are
  standard vetted practice with cited rationale, not difficult language
  decisions. JEV (three-rewrite rule) will be used if MCP transport
  qualification or delegated-identity mapping hits a genuine fork.

## Subtasks, worker reservations, PR order

At most two active implementation subagents; disjoint exact files each; no
git/worktree commands in children; command cadence yield_time_ms:120000.

- [x] P0 plan: this file (coordinator).
- [x] S1 contracts-1: contracts identity.ts+wire.ts; identity/interfaces
      package.json+tsconfig; fixtures (two-user/team, revoked session);
      lane-06.yml; PR #6. Coordinator-authored (core design surface);
      implementer delegation starts at S2.
- [ ] S2 identity-core: accounts/sessions/teams/authentication + ports +
      testing double; password/recovery/session/CSRF/team lifecycle tests.
- [ ] S3 wire-errors: error envelope/safe/redact/logging + operation envelope
      codecs + version/operation_id validation; projection-before-disclosure
      enforcement point used by both transports.
- [ ] S4 http-routes: page/fragment/operation dispatch, source-derived
      admission via L1 descriptor port, CSRF enforcement, request limits,
      HTMX error-swap statuses; B1 route/admission cases.
- [ ] S5 mcp-server: SDK qualification spike, registry->tool generation,
      closed-schema derivation, OAuth audience binding, discovery/call
      permission rechecks; same-invocation proof with S4.
- [ ] S6 uploads: intent/content/finalize routing vs L4 finalizer port,
      fileTransfer _meta, browser handoff + truthful unsupported-host errors.
- [ ] S7 ingress-trust: provider-event ingress auth framework delegating to
      L4 verifier port; delegated-operation identity mapping; forbidden
      manufacture cases.
- [ ] B1/B2 join: real-registry two-user browser+MCP flows, denied/stale/
      replay, revocation, finalized files, error-meaning preservation.

## Test cases (acceptance spine; producers' doubles marked T)

- Forged/missing/expired identity, wrong team/owner, stale version, revoked
  role, unauthorized result field: rejected equally over HTTP and MCP.
- Two-user/team fixture: owner invites member, member accepts via addressed
  expiring token; owner-only tool hidden/denied for member; last-owner
  removal rejected; removed member loses admission; prior admitted op may
  finish (documented boundary).
- Sessions: revocation ends browser + MCP grants immediately; recovery token
  single-use + expiring; wrong-audience token rejected; CSRF missing/stale
  rejected on POST; GET stays side-effect-free.
- Wire: unknown args/undeclared writable fields fail; int/decimal strings
  exact (no Number collapse); action_handle mode omits protected inputs;
  mixed/ordinary+handle envelopes fail.
- Uploads: JSON-declared file without intent/bytes/finalize never yields an
  attachment; partial/oversize/malformed bytes yield no file; cross-team
  reference fails admission; unsupported host gets handoff-or-cannot-supply.
- Errors: every code maps to documented HTTP status + HTMX-swappable
  fragment + MCP isError shape with identical safe meaning; logs carry no
  credentials/tokens/bodies.
- B1: TeamTasks-style compile+run, two authenticated users, browser+MCP
  same-op invocation, denied read, stale update, mutation replay.
- B2: ExpenseFlow + attachment/approval/notice, role revocation, finalized
  files, failed/unknown/skipped delivery, retry, changed versions.

## Integration joins

- J1 (needs L7): swap test-relative contract imports for @canlang/contracts
  workspace imports; adopt root tsconfig.base. Request: contracts manifest +
  index.ts assembly + root workspace accepting packages/identity,
  packages/interfaces (exact package.json changes will be attached to the
  S1 PR description).
- J2 (needs L3): bind identity store port to fenced D1 tables; use canonical
  invocation callable in HTTP/MCP dispatch. Request: membership/session
  table contract + invocation port signature with a two-user witness.
- J3 (needs L1): real operation registry + page descriptors/admission
  callables. Request: registry + descriptor shape with TeamTasks witness.
- J4 (needs L2): canonical value codecs + schema catalog entries.
- J5 (needs L5): fragment/page render callables + form schemas.
- J6 (needs L4): file finalization/provenance + provider-event verifier.
- J7 (needs L7): workerd/D1 local run + BDD testkit for B1/B2 evidence.

## Progress and file reservations

- 2026-10-04: worktree+goal+inventory+plan done. Reservations: coordinator
  holds implementation/status/lane-06.md; S1 workers (to spawn): A holds
  packages/contracts/src/identity.ts + packages/identity/test/fixtures/;
  B holds packages/contracts/src/wire.ts + .github/workflows/lane-06.yml.
  Shared S1 scaffolds (package.json/tsconfig/index/ports) stay with the
  coordinator to avoid merge skew.

## Interface requests and handoffs

- None merged yet. Standing requests J1-J7 above; each will be filed as a
  committed status entry + PR description naming producer, exact
  type/function/behavior, consuming example and earliest milestone, per
  WORKFLOW. First: J1 to L7 on the S1 PR.

## PR and verification evidence

- S1 (in progress): branch muse/lane-06-identity-interfaces/plan. Local
  checks 2026-10-04: `npm test` in packages/identity 4/4 pass, in
  packages/interfaces 7/7 pass (tsc strict + node:test, Node v24.21.0).
  Temp decisions pending L7 J1: relative contract imports in test-only
  code; package-local tsconfig esnext/bundler (no contracts package.json
  yet); package-local lockfiles (L7 deletes at workspace assembly).
  PR URL + review + merge sha: to be recorded.

## Remaining work and cleanup

Full lane scope (S1-S7 + B1/B2) remains. Owned resources: one worktree
(lane-06-identity-interfaces), no build caches beyond package-local
node_modules. Cleanup after writer release: remove worktree via primary
checkout `git worktree remove`, prune branch.
